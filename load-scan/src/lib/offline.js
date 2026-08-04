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
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
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
  if (existing) return false;
  await tx(STORE_QUEUE, 'readwrite', (s) =>
    s.put({ key, loadNbr, date, ...scan, queuedAt: new Date().toISOString() }),
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

export function putCache(key, value) {
  return tx(STORE_CACHE, 'readwrite', (s) => s.put({ key, value, at: new Date().toISOString() }));
}

export async function getCache(key) {
  const row = await tx(STORE_CACHE, 'readonly', (s) => s.get(key));
  return row ? { value: row.value, at: row.at } : null;
}
