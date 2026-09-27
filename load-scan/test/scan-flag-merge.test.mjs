// scan-flag-merge.test.mjs — routing-backend-loadscan-config-2.
//
// Two loaders on one truck, and a driver who scans it later, are the normal
// case (scan-session.mts says so). None of those phones ever reads the session
// back, so a second phone that scans a piece the first already booked sends it
// fresh: damaged:false, voidedAt:null — not because anyone cleared anything, but
// because that phone never knew. The server took those defaults as a deliberate
// clear (last writer wins), so:
//   (a) loader A marks a skid damaged, loader B scans the same skid, and the
//       office never raises the claim;
//   (b) A takes a piece back off the truck, B's retry of an older unsynced scan
//       lands, and the piece counts on the truck again — a short truck reads
//       complete.
// The phone now stamps WHEN it changed a flag, and the server keeps the newest
// real change per flag. LOADSCAN_FLAG_MERGE=off puts last-writer-wins back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installFakeFirestore } from './helpers/fake-firestore.mjs';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';
const fake = installFakeFirestore();

// ── A minimal in-memory IndexedDB, enough for offline.js's get/put/getAll. ──
const idbStores = new Map();
globalThis.indexedDB = {
  open() {
    const req = {};
    const db = {
      objectStoreNames: { contains: (n) => idbStores.has(n) },
      createObjectStore: (n) => idbStores.set(n, new Map()),
      transaction(name) {
        const m = idbStores.get(name);
        const t = {};
        const request = (fn) => {
          const r = {};
          queueMicrotask(() => { r.result = fn(); });
          return r;
        };
        t.objectStore = () => ({
          get: (k) => request(() => (m.has(k) ? structuredClone(m.get(k)) : undefined)),
          put: (v) => request(() => { m.set(v.key, structuredClone(v)); return v.key; }),
          getAll: () => request(() => [...m.values()].map((v) => structuredClone(v))),
          delete: (k) => request(() => m.delete(k)),
        });
        setTimeout(() => t.oncomplete?.(), 0);
        return t;
      },
    };
    queueMicrotask(() => { req.result = db; req.onupgradeneeded?.(); req.onsuccess?.(); });
    return req;
  },
};

const fs = await import('../netlify/functions/lib/firestore.mts');
const auth = await import('../netlify/functions/lib/auth.mts');
const session = await import('../netlify/functions/scan-session.mts');
const store = await import('../src/lib/offline.js');

const OG = 'OG0000000001';
const base = { og: OG, pro: '7157687', stopNbr: '007157687', engine: 'wedge' };
const T = (m) => `2026-08-07T09:${String(m).padStart(2, '0')}:00.000Z`;

/** What a phone on this build pushes: the flush projection, change times included. */
const pushed = (row) => ({
  ...base,
  scannedAt: row.scannedAt,
  voidedAt: row.voidedAt || null,
  voidReason: row.voidReason || '',
  damaged: !!row.damaged,
  damageNote: row.damageNote || '',
  voidChangedAt: row.voidChangedAt || null,
  damageChangedAt: row.damageChangedAt || null,
});
const norm = (raw) => session.normalizeScan(raw).row;
const merge = (stored, raw, on = true) => session.mergeScans(stored, [norm(raw)], on);

// ── The two failures, pure ───────────────────────────────────────────────────

test('a second loader scanning a skid the first marked damaged does not erase the damage claim', () => {
  const a = merge([], pushed({ scannedAt: T(0), damaged: true, damageNote: 'forks through carton', damageChangedAt: T(1) }));
  const b = merge(a.scans, pushed({ scannedAt: T(5) })); // B's phone never knew
  assert.equal(b.scans[0].damaged, true, 'the office still sees the claim');
  assert.equal(b.scans[0].damageNote, 'forks through carton');
  assert.equal(b.updated, 0);
});

test('a stale retry of a scan the dock has since taken back does not put the piece back on the truck', () => {
  const bScan = pushed({ scannedAt: T(0) });
  let s = merge([], bScan).scans; // B's scan lands; B never hears the 200
  s = merge(s, pushed({ scannedAt: T(0), voidedAt: T(3), voidReason: 'wrong truck', voidChangedAt: T(3) })).scans; // A takes it off
  s = merge(s, bScan).scans; // B's retry of the same, older row
  assert.equal(session.liveScanRows(s).length, 0, 'the piece is off the truck');
  assert.equal(s[0].voidedAt, T(3));
});

// ── What a person deliberately does still lands ──────────────────────────────

test('the loader who marked damage can still take it back', () => {
  const a = merge([], pushed({ scannedAt: T(0), damaged: true, damageNote: 'crushed', damageChangedAt: T(1) }));
  const cleared = merge(a.scans, pushed({ scannedAt: T(0), damaged: false, damageChangedAt: T(2) }));
  assert.equal(cleared.scans[0].damaged, false, 'it was the shrink wrap, not the freight');
  assert.equal(cleared.updated, 1);
});

test('the loader who took a piece back can still put it back', () => {
  let s = merge([], pushed({ scannedAt: T(0), voidedAt: T(3), voidChangedAt: T(3) })).scans;
  s = merge(s, pushed({ scannedAt: T(0), voidChangedAt: T(4) })).scans;
  assert.equal(session.liveScanRows(s).length, 1);
});

test('a piece scanned onto the truck AFTER someone took it off counts again', () => {
  let s = merge([], pushed({ scannedAt: T(0), voidedAt: T(3), voidChangedAt: T(3) })).scans;
  s = merge(s, pushed({ scannedAt: T(6) })).scans; // B loads it back and scans it
  assert.equal(session.liveScanRows(s).length, 1, 'a scan means the piece is on the truck');
  assert.equal(s[0].scannedAt, T(0), 'the first scan time is still the record');
});

test('a second loader who also marks damage updates the note', () => {
  const a = merge([], pushed({ scannedAt: T(0), damaged: true, damageNote: 'corner', damageChangedAt: T(1) }));
  const b = merge(a.scans, pushed({ scannedAt: T(5), damaged: true, damageNote: 'corner and top', damageChangedAt: T(6) }));
  assert.equal(b.scans[0].damageNote, 'corner and top');
});

// ── Older app builds, and the way back ───────────────────────────────────────

test('a phone still on an older build (no change times) keeps last-writer-wins, as before', () => {
  const legacy = { ...base, scannedAt: T(0) };
  const a = session.mergeScans([], [norm({ ...legacy, damaged: true, damageNote: 'x' })]);
  const cleared = session.mergeScans(a.scans, [norm(legacy)]);
  assert.equal(cleared.scans[0].damaged, false, 'unchanged behaviour until the phone updates');
});

test('LOADSCAN_FLAG_MERGE=off puts last-writer-wins back for every phone', () => {
  const a = merge([], pushed({ scannedAt: T(0), damaged: true, damageNote: 'x', damageChangedAt: T(1) }), false);
  const b = merge(a.scans, pushed({ scannedAt: T(5) }), false);
  assert.equal(b.scans[0].damaged, false);
});

test('the switch is the house shape: on unless explicitly off, malformed stays on', () => {
  for (const v of [undefined, '', 'on', '1', 'true', 'yes', 'garbage', 'offf']) {
    assert.equal(session.flagMergeByTimeEnabled({ LOADSCAN_FLAG_MERGE: v }), true, String(v));
  }
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) {
    assert.equal(session.flagMergeByTimeEnabled({ LOADSCAN_FLAG_MERGE: v }), false, v);
  }
});

test('/health shows the switch position without a token', async () => {
  const health = await import('../netlify/functions/health.mts');
  process.env.LOADSCAN_FLAG_MERGE = 'off';
  try {
    const body = await (await health.default(new Request('http://localhost/.netlify/functions/health'))).json();
    assert.equal(body.flag_merge_env, 'off');
  } finally {
    delete process.env.LOADSCAN_FLAG_MERGE;
  }
});

// ── The phone stamps, and sends, the change times ────────────────────────────

test('the phone stamps when a piece was taken back, put back, or marked damaged', async () => {
  await store.enqueueScan('STEVEN', '2026-08-07', { ...base, scannedAt: T(0) });
  const key = store.queueKey('STEVEN', OG);
  const row = async () => (await store.allQueued()).find((r) => r.key === key);

  await store.markDamaged('STEVEN', OG, true, 'crushed');
  const d1 = (await row()).damageChangedAt;
  assert.ok(d1 && !Number.isNaN(Date.parse(d1)), 'marking damage is stamped');
  await new Promise((r) => setTimeout(r, 5));
  await store.markDamaged('STEVEN', OG, false);
  const d2 = (await row()).damageChangedAt;
  assert.ok(d2 > d1, 'and so is un-marking it — a clear must be able to win');

  await store.voidScan('STEVEN', OG, 'wrong truck');
  const v1 = (await row()).voidChangedAt;
  assert.equal(v1, (await row()).voidedAt, 'a take-back is stamped at its own time');
  await new Promise((r) => setTimeout(r, 5));
  await store.unvoidScan('STEVEN', OG);
  const v2 = (await row()).voidChangedAt;
  assert.ok(v2 > v1, 'a put-back is stamped');

  await store.voidScan('STEVEN', OG);
  await new Promise((r) => setTimeout(r, 5));
  await store.enqueueScan('STEVEN', '2026-08-07', { ...base, scannedAt: T(9) }); // re-scan revives it
  const r3 = await row();
  assert.equal(r3.voidedAt, null);
  assert.ok(r3.voidChangedAt > v2, 're-scanning a taken-back piece is a stamped put-back too');
});

test('the flush projection sends both change times, or the server can never tell a clear from a default', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const flush = app.slice(app.indexOf('const rows = (await store.queuedFor(activeLoad, manifest?.date)).filter'));
  const projection = flush.slice(flush.indexOf('scans: slice.filter'), flush.indexOf('handConfirms: slice.filter'));
  for (const field of ['voidChangedAt', 'damageChangedAt']) {
    assert.ok(projection.includes(field), `flushQueue must send ${field}`);
  }
});

// ── End to end: two loaders, two tokens, one session doc ─────────────────────

test('end to end: loader B scanning loader A\'s damaged skid leaves the claim in the session record', async () => {
  fake.docs.clear();
  for (const n of ['4471', '4472']) {
    await fs.setDoc(`driver_auth/${n}`, { driverNumber: n, displayName: `Loader ${n}`, role: 'loader', active: true, pinHash: '' });
  }
  const push = (who, row) =>
    session.default(
      new Request('http://localhost/.netlify/functions/scan-session', {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.issueToken(who, `Loader ${who}`, 'loader')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ loadNbr: 'STEVEN', date: '2026-08-07', expectedPieces: 1, scans: [row] }),
      }),
    );
  assert.equal((await push('4471', pushed({ scannedAt: T(0), damaged: true, damageNote: 'forks through carton', damageChangedAt: T(1) }))).status, 200);
  assert.equal((await push('4472', pushed({ scannedAt: T(5) }))).status, 200);
  const doc = await fs.getDoc('nuvizz_load_scans/davis__2026-08-07__STEVEN');
  assert.equal(doc.scans.length, 1);
  assert.equal(doc.scans[0].damaged, true);
  assert.equal(doc.scans[0].damageNote, 'forks through carton');
});
