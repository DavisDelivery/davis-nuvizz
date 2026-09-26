// A write Firestore pushed back is retried with backoff, not dropped — the way Sep 10, Sep 11 and
// Sep 24, 2026 were lost (429 "exceeded maximum bandwidth for writes" at 02:01 ET, first throw ends the night).
import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertAll, transientWriteError, backoffMs, WRITE_RETRIES, WRITE_BACKOFF_MS } from '../netlify/functions/lib/history-store.mts';

const err = (code, path = 'history_days/davis__2026-09-24/stops/1') => new Error(`setDoc ${path} failed: ${code} {"error":{"code":${code}}}`);
function fakeStore(failuresFor) {
  const docs = new Map(); const attempts = []; const slept = [];
  const setDoc = async (path, data) => {
    attempts.push(path);
    const left = failuresFor.get(path) || 0;
    if (left > 0) { failuresFor.set(path, left - 1); throw err(429, path); }
    docs.set(path, data);
  };
  return { docs, attempts, slept, deps: { setDoc, sleep: async (ms) => { slept.push(ms); } } };
}
const items = (n) => Array.from({ length: n }, (_, k) => ({ stopNbr: String(k + 1) }));
const pathOf = (r) => `history_days/davis__2026-09-24/stops/${r.stopNbr}`;

test('a 429 is retried with backoff and every stop lands; the writers drop to four after the first push-back', async () => {
  const fails = new Map([[pathOf({ stopNbr: '3' }), 2], [pathOf({ stopNbr: '40' }), 1]]);
  const st = fakeStore(fails);
  const out = await upsertAll(items(60), pathOf, 12, st.deps);
  assert.equal(st.docs.size, 60, 'every stop written');
  assert.deepEqual(out, { written: 60, retries: 3, pushedBack: true });
  assert.equal(st.slept.length, 3);
  assert.ok(st.slept[0] >= 375 && st.slept[0] <= 625, `first wait ~0.5 s ±25% (${st.slept[0]})`);
  assert.equal(st.attempts.length, 63, '60 writes + 3 retries');
});

test('the same 429 six times in a row is thrown, naming the document — not swallowed, not retried forever', async () => {
  const st = fakeStore(new Map([[pathOf({ stopNbr: '2' }), 99]]));
  await assert.rejects(() => upsertAll(items(3), pathOf, 12, st.deps), /stops\/2 failed: 429/);
  assert.equal(st.slept.length, WRITE_RETRIES, `${WRITE_RETRIES} waits before giving up`);
  assert.deepEqual(WRITE_BACKOFF_MS, [500, 1000, 2000, 4000, 8000]);
});

test('a refusal is not a push-back: 400 / 403 / 404 are thrown at once with no wait', async () => {
  for (const code of [400, 403, 404]) {
    const deps = { setDoc: async (p) => { throw err(code, p); }, sleep: async () => { throw new Error('must not sleep'); } };
    await assert.rejects(() => upsertAll(items(2), pathOf, 12, deps), new RegExp(`failed: ${code}`));
  }
  assert.equal(transientWriteError(err(429)), true);
  assert.equal(transientWriteError(err(503)), true);
  assert.equal(transientWriteError(err(500)), true);
  assert.equal(transientWriteError(err(400)), false);
  assert.equal(transientWriteError(new Error('fetch failed')), true);
  assert.equal(transientWriteError(new Error('ECONNRESET')), true);
  assert.equal(transientWriteError(new Error('bad path')), false);
});

test('backoff is the ladder ±25% and never runs off its end', () => {
  assert.equal(backoffMs(0, 0), 375); assert.equal(backoffMs(0, 1), 625);
  assert.equal(backoffMs(4, 0.5), 8000); assert.equal(backoffMs(9, 0.5), 8000);
});

test('nothing to write is nothing done', async () => {
  const st = fakeStore(new Map());
  assert.deepEqual(await upsertAll([], pathOf, 12, st.deps), { written: 0, retries: 0, pushedBack: false });
  assert.equal(st.attempts.length, 0);
});
