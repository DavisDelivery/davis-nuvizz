// offline.js — IndexedDB manifest cache and the local-first scan queue.
//
// The dock has no signal. That is the design assumption, not an edge case:
//
//   - every scan is written HERE first, always, before any network attempt
//   - the UI reads local state and never waits on a request
//   - the queue flushes when signal returns, idempotent on (loadNbr, og)
//
// A scan that only exists in a pending HTTP request is a scan that a dropped
// connection deletes. So nothing is ever "sent instead of stored".

const DB_NAME = 'loadscan';
const DB_VERSION = 1;
const STORE_QUEUE = 'scanQueue';
const STORE_CACHE = 'cache';

let __db = null;

function open() {
  if (__db) return Promise.resolve(__db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        // Key is `${loadNbr}::${og}` — the same idempotency key the server uses,
        // so a piece cannot be double-queued even across app restarts.
        db.createObjectStore(STORE_QUEUE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      __db = req.result;
      resolve(__db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        // Unwrap the IDBRequest. This used to read:
        //
        //   resolve(result && result.result !== undefined ? result.result : result)
        //
        // which returned the REQUEST OBJECT whenever a get found nothing —
        // because `request.result` is `undefined` for a miss, so the ternary
        // fell through to the request itself, which is truthy.
        //
        // That made `enqueueScan`'s "have I already queued this piece?" check
        // ALWAYS true, so it returned false and NEVER WROTE A SCAN. Every piece
        // flashed green, the counter never moved, and nothing was ever uploaded.
        // Same fault silently disabled stampLoadedSequence.
        //
        // Unwrap on shape, not on value: a miss must be undefined.
        t.oncomplete = () =>
          resolve(result && typeof result === 'object' && 'result' in result ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const queueKey = (loadNbr, og) => `${loadNbr}::${String(og).toUpperCase()}`;

/**
 * Hand-confirms share the queue — same flush, same retry, same prune — but sit
 * in their own key namespace so they can never collide with a scanned piece
 * and are idempotent per stop: confirming twice is still one confirmation.
 */
export const handKey = (loadNbr, stopNbr) => `${loadNbr}::HAND::${String(stopNbr)}`;

/** Record a stop confirmed by hand. Returns false when it was already confirmed. */
export async function enqueueHandConfirm(loadNbr, date, confirm) {
  const key = handKey(loadNbr, confirm.stopNbr);
  const existing = await tx(STORE_QUEUE, 'readonly', (s) => s.get(key));
  if (existing) return false;
  await tx(STORE_QUEUE, 'readwrite', (s) =>
    s.put({ key, kind: 'hand', loadNbr, date, ...confirm, queuedAt: new Date().toISOString() }),
  );
  return true;
}

/** Enqueue one scan. Returns false when this piece was already queued. */
export async function enqueueScan(loadNbr, date, scan) {
  const key = queueKey(loadNbr, scan.og);
  const existing = await tx(STORE_QUEUE, 'readonly', (s) => s.get(key));
  // A voided row still occupies the key. Scanning that piece again is the loader
  // undoing the void — putting the freight back on the truck — so it must revive
  // the row rather than be swallowed as a duplicate. Anything already marked on
  // it (damage, most of all) survives: the piece did not stop being damaged.
  if (existing?.voidedAt) {
    await tx(STORE_QUEUE, 'readwrite', (s) =>
      s.put({ ...existing, voidedAt: null, voidReason: '', syncedAt: null }),
    );
    return true;
  }
  if (existing) return false;
  await tx(STORE_QUEUE, 'readwrite', (s) =>
    s.put({ key, loadNbr, date, ...scan, queuedAt: new Date().toISOString() }),
  );
  return true;
}

/**
 * Take a scan back.
 *
 * TOMBSTONE, never delete. The queue is the sync source: a scan that already
 * reached the server and is then dropped from the phone leaves the server still
 * counting it, and the dock and the office disagree forever. Clearing `syncedAt`
 * is the point — the row goes back in the flush and carries the void up.
 *
 * The tombstone also keeps the OG key occupied, so re-scanning a voided piece is
 * a deliberate un-void rather than a silent second booking.
 */
export async function voidScan(loadNbr, og, reason = '') {
  const key = queueKey(loadNbr, og);
  const row = await tx(STORE_QUEUE, 'readonly', (s) => s.get(key));
  if (!row || row.voidedAt) return false;
  await tx(STORE_QUEUE, 'readwrite', (s) =>
    s.put({ ...row, voidedAt: new Date().toISOString(), voidReason: String(reason || ''), syncedAt: null }),
  );
  return true;
}

/** Put a voided scan back on the load. */
export async function unvoidScan(loadNbr, og) {
  const key = queueKey(loadNbr, og);
  const row = await tx(STORE_QUEUE, 'readonly', (s) => s.get(key));
  if (!row || !row.voidedAt) return false;
  await tx(STORE_QUEUE, 'readwrite', (s) =>
    s.put({ ...row, voidedAt: null, voidReason: '', syncedAt: null }),
  );
  return true;
}

/**
 * Flag a piece as damaged. It STAYS on the load — see stopProgress — because it
 * is physically on the truck; this is what tells the office to raise a claim.
 * Clearing `syncedAt` re-pushes the row so the flag actually leaves the phone.
 */
export async function markDamaged(loadNbr, og, damaged = true, note = '') {
  const key = queueKey(loadNbr, og);
  const row = await tx(STORE_QUEUE, 'readonly', (s) => s.get(key));
  if (!row) return false;
  if (!!row.damaged === !!damaged && String(row.damageNote || '') === String(note || '')) return false;
  await tx(STORE_QUEUE, 'readwrite', (s) =>
    s.put({
      ...row,
      damaged: !!damaged,
      damageNote: damaged ? String(note || '') : '',
      damagedAt: damaged ? new Date().toISOString() : null,
      syncedAt: null,
    }),
  );
  return true;
}

export function allQueued() {
  return tx(STORE_QUEUE, 'readonly', (s) => s.getAll());
}

export async function queuedFor(loadNbr) {
  const all = await allQueued();
  return all.filter((r) => r.loadNbr === loadNbr);
}

/** Count still awaiting upload — this is the number the driver sees. */
export async function pendingCount(loadNbr) {
  const rows = loadNbr ? await queuedFor(loadNbr) : await allQueued();
  return rows.filter((r) => !r.syncedAt).length;
}

export async function markSynced(keys) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_QUEUE, 'readwrite');
    const s = t.objectStore(STORE_QUEUE);
    const at = new Date().toISOString();
    for (const key of keys) {
      const g = s.get(key);
      g.onsuccess = () => {
        if (g.result) s.put({ ...g.result, syncedAt: at });
      };
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/** Drop synced rows older than `days` so the store cannot grow without bound. */
export async function pruneSynced(days = 14) {
  const cutoff = Date.now() - days * 86400_000;
  const all = await allQueued();
  const stale = all.filter((r) => r.syncedAt && Date.parse(r.syncedAt) < cutoff).map((r) => r.key);
  if (!stale.length) return 0;
  await tx(STORE_QUEUE, 'readwrite', (s) => stale.forEach((k) => s.delete(k)));
  return stale.length;
}

// ── Manifest cache ───────────────────────────────────────────────────────────

export const cacheKey = (date, driverNumber) => `manifest::${date}::${driverNumber}`;

// ── Loaded-against sequence ──────────────────────────────────────────────────
//
// The trailer is a physical record of one particular route order. If dispatch
// resequences after loading starts, the freight is already in the wrong place
// and re-drawing the screen with new numbers would hide that. So the sequence
// in force when the FIRST piece was recorded is written down and never
// overwritten — it is what the truck actually reflects.

export const seqKey = (loadNbr) => `loadedseq::${loadNbr}`;

/** Write the loaded-against sequence once. Later calls are no-ops by design. */
export async function stampLoadedSequence(loadNbr, fingerprint, loadSeqByStop) {
  const key = seqKey(loadNbr);
  const existing = await getCache(key);
  if (existing) return false;
  await putCache(key, { fingerprint, loadSeqByStop, at: new Date().toISOString() });
  return true;
}

export async function getLoadedSequence(loadNbr) {
  const row = await getCache(seqKey(loadNbr));
  return row ? row.value : null;
}

export function putCache(key, value) {
  return tx(STORE_CACHE, 'readwrite', (s) => s.put({ key, value, at: new Date().toISOString() }));
}

export async function getCache(key) {
  const row = await tx(STORE_CACHE, 'readonly', (s) => s.get(key));
  return row ? { value: row.value, at: row.at } : null;
}
