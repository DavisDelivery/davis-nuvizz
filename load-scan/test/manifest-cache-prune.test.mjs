// manifest-cache-prune.test.mjs — saved manifests from past shifts are dropped,
// and nothing else in the cache is.
//
// Each truck a loader opens with signal is now saved in its own slot
// (manifest::<day>::<driver>::load::<loadNbr>) so an offline "Different truck"
// can find the pick list again. Only the current shift day's slots are ever
// read, so without a prune the phone kept every truck it ever opened, full
// board rows and all, for as long as the app was installed.
//
// Driven against the REAL offline.js through a small in-memory IndexedDB.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
      getAllKeys: () => fakeRequest(() => [...rows.keys()]),
      delete: (key) => fakeRequest(() => { rows.delete(key); }),
    });
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

beforeEach(() => {
  for (const rows of stores.values()) rows.clear();
});

async function seed() {
  await store.putCache(store.cacheKey('2026-09-10', '8801'), { summariesOnly: true, loads: [] });
  await store.putCache(store.cacheKey('2026-09-10', '8801', 'TRUCKA'), { loads: [{ loadNbr: 'TRUCKA' }] });
  await store.putCache(store.cacheKey('2026-09-14', '8801', 'TRUCKB'), { loads: [{ loadNbr: 'TRUCKB' }] });
  await store.putCache(store.cacheKey('2026-09-15', '8801'), { summariesOnly: true, loads: [] });
  await store.putCache(store.cacheKey('2026-09-15', '8801', 'TRUCKA'), { loads: [{ loadNbr: 'TRUCKA' }] });
  await store.stampLoadedSequence('TRUCKA', '2026-09-10', 'fp', { 1: 1 });
}
const keys = () => [...stores.get('cache').keys()].sort();

test('trucks and pick lists from shifts before the kept day are dropped; the kept days are untouched', async () => {
  await seed();
  assert.equal(await store.pruneManifestCache('2026-09-12'), 2);
  assert.deepEqual(keys(), [
    'loadedseq::2026-09-10::TRUCKA',
    'manifest::2026-09-14::8801::load::TRUCKB',
    'manifest::2026-09-15::8801',
    'manifest::2026-09-15::8801::load::TRUCKA',
  ]);
  // Tonight's saved copies still serve an offline switch.
  const list = await store.getCache(store.cacheKey('2026-09-15', '8801'));
  assert.deepEqual(store.manifestFromCache(list.value, ''), { manifest: list.value, open: null });
});

test('the loaded-sequence stamp is never pruned, whatever its day', async () => {
  await seed();
  await store.pruneManifestCache('2030-01-01');
  assert.deepEqual(keys(), ['loadedseq::2026-09-10::TRUCKA']);
  assert.ok(await store.getLoadedSequence('TRUCKA', '2026-09-10'));
});

test('a malformed or missing day prunes nothing — a bad input must never empty the cache', async () => {
  await seed();
  const before = keys();
  for (const bad of ['', null, undefined, 'NaN-NaN-NaN', '2026-9-15', 'tomorrow']) {
    assert.equal(await store.pruneManifestCache(bad), 0, `input ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(keys(), before);
});

test('the app prunes on start, keeping the shift day and three before it', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /store\.pruneManifestCache\(addDays\(shiftDayString\(\), -3\)\)\.catch\(\(\) => \{\}\);/);
});
