// test/route-load-memo-store.test.mjs — THE LOAD-DAY MEMO IS MERGED, NEVER OVERWRITTEN (v1.82.0, REVIEW #12).
//
// The review's simulation: one failed Firestore read of the memo came back as `{}`, the run re-read
// four loads, and the replace-write saved those four over the eighty the memo held — every settled
// order flipped back to the old filing for the twenty runs it took to rebuild. So a failed read is
// `null` (never an empty memo), a write re-reads what is stored and ADDS to it, and a write whose
// re-read fails writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
const { readRouteLoadMemo, writeRouteLoadMemo } = await import('../netlify/functions/lib/firestore.mts');

const PATH = 'nuvizz_ops/route_load_day__davis';
const entry = (at, members) => ({ at, trips: 3, members, cover: '2026-09-28T09:00' });
const stored = (store) => JSON.parse(store.get(PATH)?.memoJson || '{}');

test('a write ADDS this run\'s reads to what is stored — the loads it did not read are kept', async () => {
  const fake = installFirestoreFake({ [PATH]: { tenant: 'davis', memoJson: JSON.stringify({ OLD1: entry('2026-09-28T12:00:00.000Z', ['a']), OLD2: entry('2026-09-28T12:01:00.000Z', ['b']) }) } });
  try {
    assert.equal(await writeRouteLoadMemo('davis', { NEW1: entry('2026-09-28T14:00:00.000Z', ['c']) }), true);
    assert.deepEqual(Object.keys(stored(fake.store)).sort(), ['NEW1', 'OLD1', 'OLD2']);
    // A newer read of a load replaces that load's entry only.
    await writeRouteLoadMemo('davis', { OLD1: entry('2026-09-28T15:00:00.000Z', ['a', 'z']) });
    assert.deepEqual(stored(fake.store).OLD1.members, ['a', 'z']);
    assert.deepEqual(stored(fake.store).OLD2.members, ['b']);
  } finally { fake.restore(); }
});

test('a memo that cannot be READ is null — never an empty memo — and a write that cannot re-read writes nothing', async () => {
  const fake = installFirestoreFake({ [PATH]: { tenant: 'davis', memoJson: JSON.stringify({ OLD1: entry('2026-09-28T12:00:00.000Z', ['a']) }) } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('route_load_day__davis')) return new Response('{"error":{"code":503}}', { status: 503 });
    return inner(input, init);
  };
  try {
    assert.equal(await readRouteLoadMemo('davis'), null);
    assert.equal(await writeRouteLoadMemo('davis', { NEW1: entry('2026-09-28T14:00:00.000Z', ['c']) }), false);
    assert.deepEqual(Object.keys(stored(fake.store)), ['OLD1'], 'the stored memo is untouched');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('no document yet is an empty memo (not a failure), and the first write creates it', async () => {
  const fake = installFirestoreFake({});
  try {
    assert.deepEqual(await readRouteLoadMemo('davis'), {});
    assert.equal(await writeRouteLoadMemo('davis', {}), false, 'nothing to write, nothing written');
    assert.equal(await writeRouteLoadMemo('davis', { A: entry('2026-09-28T14:00:00.000Z', ['x']) }), true);
    assert.deepEqual(Object.keys(stored(fake.store)), ['A']);
  } finally { fake.restore(); }
});
