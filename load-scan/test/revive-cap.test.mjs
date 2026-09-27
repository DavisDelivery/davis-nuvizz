// revive-cap.test.mjs — putting a voided piece back on the truck passes the same
// manifest cap as any new piece.
//
// enqueueScan is "the one place every piece must pass to become real", and it
// enforces the stop's manifest count against the durable queue because the
// render-time check in record() can read a stale snapshot. But a voided piece
// scanned again was revived BEFORE that check ran, so a revive walked past the
// cap: a 2-piece stop with OG1 voided and OG2 + OG3 aboard read 3/2 the moment
// OG1's label was read again inside a render gap.
//
// Driven against the REAL offline.js through a small in-memory IndexedDB — the
// store needs IndexedDB, and a re-typed model of it would only prove the model.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── A minimal IndexedDB: open / objectStore / get / put / getAll / delete ────
const stores = new Map(); // name -> Map(key -> row)
function fakeRequest(compute) {
  const req = { result: undefined, error: null, onsuccess: null };
  req.result = compute();
  queueMicrotask(() => req.onsuccess?.({ target: req }));
  return req;
}
const fakeDb = {
  objectStoreNames: { contains: (n) => stores.has(n) },
  createObjectStore(name, { keyPath }) {
    stores.set(name, Object.assign(new Map(), { keyPath }));
  },
  transaction(name) {
    const rows = stores.get(name);
    const t = { oncomplete: null, onerror: null, onabort: null, error: null };
    t.objectStore = () => ({
      get: (key) => fakeRequest(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
      put: (row) => fakeRequest(() => { rows.set(row[rows.keyPath], structuredClone(row)); return row[rows.keyPath]; }),
      getAll: () => fakeRequest(() => [...rows.values()].map((r) => structuredClone(r))),
      delete: (key) => fakeRequest(() => { rows.delete(key); }),
    });
    // After every request's microtask, like a real transaction auto-committing.
    setTimeout(() => t.oncomplete?.(), 0);
    return t;
  },
};
globalThis.indexedDB = {
  open() {
    const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      req.result = fakeDb;
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  },
};

const store = await import('../src/lib/offline.js');

const LOAD = 'STEVEN';
const DATE = '2026-09-15';
const STOP = { stopNbr: '4', expected: 2 };
const piece = (og) => ({ og, pro: '7173250', scannedAt: '2026-09-15T01:30:00.000Z', stopNbr: STOP.stopNbr, engine: 'quagga' });
const live = async () => (await store.queuedFor(LOAD, DATE)).filter((r) => !r.voidedAt).map((r) => r.og).sort();

beforeEach(() => {
  for (const rows of stores.values()) rows.clear();
});

test('a voided skid read again on a stop that is already full is refused, not revived to 3/2', async () => {
  assert.equal(await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), STOP), true);
  assert.equal(await store.enqueueScan(LOAD, DATE, piece('OG6028250002'), STOP), true);
  assert.equal(await store.voidScan(LOAD, 'OG6028250001', 'taken off'), true);
  assert.equal(await store.enqueueScan(LOAD, DATE, piece('OG6028250003'), STOP), true);
  assert.deepEqual(await live(), ['OG6028250002', 'OG6028250003'], '2/2 before the re-read');

  const again = await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), STOP);
  assert.equal(again, store.ENQUEUE_OVER_CAP, 'the loader is told NOT COUNTED');
  assert.deepEqual(await live(), ['OG6028250002', 'OG6028250003'], 'the stop still reads 2/2');
  const row = (await store.queuedFor(LOAD, DATE)).find((r) => r.og === 'OG6028250001');
  assert.ok(row.voidedAt, 'the tombstone is left exactly as it was');
});

test('a loader who says the paperwork is wrong can still put the voided skid back (override)', async () => {
  await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), STOP);
  await store.enqueueScan(LOAD, DATE, piece('OG6028250002'), STOP);
  await store.voidScan(LOAD, 'OG6028250001', 'taken off');
  await store.enqueueScan(LOAD, DATE, piece('OG6028250003'), STOP);

  assert.equal(await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), { ...STOP, force: true }), true);
  assert.deepEqual(await live(), ['OG6028250001', 'OG6028250002', 'OG6028250003']);
});

test('putting a voided skid back on a stop with room still revives it, damage note and all', async () => {
  await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), STOP);
  await store.markDamaged(LOAD, 'OG6028250001', true, 'corner crushed');
  await store.voidScan(LOAD, 'OG6028250001', 'taken off');
  assert.deepEqual(await live(), [], '0/2 after the void');

  assert.equal(await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), STOP), true);
  const row = (await store.queuedFor(LOAD, DATE)).find((r) => r.og === 'OG6028250001');
  assert.equal(row.voidedAt, null, 'back on the truck');
  assert.equal(row.damaged, true, 'still damaged — the piece did not stop being damaged');
  assert.equal(row.damageNote, 'corner crushed');
  assert.equal(row.syncedAt, null, 'and it goes back up on the next flush');
});

test('a live piece read again is still just a duplicate, full stop or not', async () => {
  await store.enqueueScan(LOAD, DATE, piece('OG6028250001'), STOP);
  await store.enqueueScan(LOAD, DATE, piece('OG6028250002'), STOP);
  assert.equal(await store.enqueueScan(LOAD, DATE, piece('OG6028250002'), STOP), store.ENQUEUE_DUPLICATE);
});
