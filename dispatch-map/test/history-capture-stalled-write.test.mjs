// test/history-capture-stalled-write.test.mjs — ONE STALLED FIRESTORE WRITE MUST NOT END THE NIGHT.
//
// firestore-history-address-5. Every Firestore call now runs under a 20s deadline (fsFetch →
// fetchWithDeadline). When a write gets no answer, fetch rejects with the deadline's reason:
// DOMException('no answer within 20000ms', 'TimeoutError'). upsertAll's retry exists so a
// Firestore push-back at 02:01 ET does not abort the nightly capture unsealed — the way Sep 10,
// 11 and 24 were lost — but transientWriteError recognised a 429/5xx or a dropped socket, not
// its own deadline, so the first stalled write threw and took the whole capture with it.
// setDoc is a whole-document replace, so retrying one that may have landed is safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

// Short deadline for this process only (each test file is its own process); read at import.
process.env.FIRESTORE_TIMEOUT_MS = '60';
const { upsertAll, transientWriteError } = await import('../netlify/functions/lib/history-store.mts');
const { fetchWithDeadline } = await import('../netlify/functions/lib/fetch-deadline.mts');

test('the Firestore deadline\'s own TimeoutError is a transient write error', async () => {
  assert.equal(transientWriteError(new DOMException('no answer within 20000ms', 'TimeoutError')), true);
  // …and the real thing, as fetch actually rejects when fetchWithDeadline fires on a silent server.
  const orig = globalThis.fetch;
  globalThis.fetch = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  try {
    const e = await fetchWithDeadline('https://firestore.googleapis.com/v1/x', {}, 20).catch((x) => x);
    assert.equal(e?.name, 'TimeoutError');
    assert.equal(transientWriteError(e), true);
  } finally { globalThis.fetch = orig; }
});

test('a refusal is still not retried (unchanged)', () => {
  assert.equal(transientWriteError(new Error('setDoc x failed: 403 denied')), false);
  assert.equal(transientWriteError(new Error('bad path')), false);
});

test('the nightly capture\'s stop write that stalls past the deadline is retried and lands, instead of aborting the night', async () => {
  const fake = installFirestoreFake({});
  const inner = globalThis.fetch;
  let stalled = 0;
  globalThis.fetch = (input, init = {}) => {
    const url = String(input?.url ?? input);
    if ((init.method || 'GET').toUpperCase() === 'PATCH' && url.includes('/stops/1') && stalled === 0) {
      stalled++;
      // Accepted, never answered — until the deadline aborts it, exactly as undici rejects.
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    return inner(input, init);
  };
  try {
    const out = await upsertAll([{ stopNbr: '1' }, { stopNbr: '2' }], (r) => `history_days/davis__2026-09-26/stops/${r.stopNbr}`);
    assert.equal(stalled, 1, 'the stall happened');
    assert.deepEqual(out, { written: 2, retries: 1, pushedBack: true });
    assert.deepEqual(fake.store.get('history_days/davis__2026-09-26/stops/1'), { stopNbr: '1' });
    assert.deepEqual(fake.log.other, [], 'no call left Firestore');
  } finally { globalThis.fetch = inner; fake.restore(); }
});
