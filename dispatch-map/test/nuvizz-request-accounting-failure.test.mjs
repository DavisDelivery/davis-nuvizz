// test/nuvizz-request-accounting-failure.test.mjs — the call counter cannot un-send a NuVizz call.
//
// Review 2026-09-03 (X-nuvizzwrite-2), still open at the 2026-09-27 recheck: doFetchWithRetry
// awaited the Firestore call counter (and the breaker trip) with nothing around it, AFTER NuVizz
// had already answered. A counter write that failed — a Firestore 503 — made request() reject,
// so a Save NuVizz had APPLIED came back to the dispatcher as a failure (and a number probe's
// real answer was thrown away as a failed probe). Accounting records a call; it must never
// decide the outcome of one that has already happened.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNuvizzRequester, __resetDailyCeilingCache } from '../netlify/functions/lib/nuvizz-request.mts';

const META = { route: '/v7/load/assign', tenant: 'DAVIS' };

function harness({ recordCall, tripCircuit, ceiling = 100_000 }) {
  __resetDailyCeilingCache();
  const logs = [];
  let sent = 0;
  let circuitOpen = false;
  const r = createNuvizzRequester({
    fetchImpl: async () => { sent += 1; return new Response('{"status":"OK"}', { status: 200 }); },
    recordCall,
    isCircuitOpen: async () => circuitOpen,
    tripCircuit: tripCircuit || (async () => { circuitOpen = true; }),
    log: (e) => logs.push(e),
    now: () => 1_000_000,
    sleep: async () => {},
  }, { dailyCeiling: ceiling, breakerMode: 'enforce', maxRetries: 0 });
  return { r, logs, get sent() { return sent; } };
}

test('a Save NuVizz applied is reported as applied even when the call counter write fails', async () => {
  const h = harness({ recordCall: async () => { throw new Error('incrementCallCounter failed: 503 UNAVAILABLE'); } });
  const resp = await h.r.request('https://nuvizz.example/v7/load/assign', { method: 'POST', body: '{}' }, META);
  assert.equal(resp.status, 200, 'NuVizz\'s own answer reaches the caller');
  assert.deepEqual(await resp.json(), { status: 'OK' });
  assert.equal(h.sent, 1, 'exactly one call went out — nothing was retried because the counter failed');
  assert.equal(h.r.getStats().totalThisInstance, 1, 'the call is still counted in this process');
  const miss = h.logs.find((e) => e.event === 'call-count-failed');
  assert.ok(miss, 'the lost count is logged, so the gap in the day total can be seen');
  assert.match(String(miss.error), /503/);
});

test('a ceiling trip that cannot be saved does not turn the call that reached the ceiling into a failure, and still halts this process', async () => {
  const h = harness({
    ceiling: 5,
    recordCall: async () => 5,   // this call is the fifth of the day: at the ceiling
    tripCircuit: async () => { throw new Error('setCircuit failed: 503'); },
  });
  const resp = await h.r.request('https://nuvizz.example/v7/load/assign', { method: 'POST', body: '{}' }, META);
  assert.equal(resp.status, 200, 'the call that reached the ceiling had already been answered');
  assert.ok(h.logs.some((e) => e.event === 'circuit-trip-failed'), 'the unsaved trip is logged');
  // The breaker is still shut in THIS process: the next call is refused before it goes out.
  await assert.rejects(
    h.r.request('https://nuvizz.example/v7/load/assign', { method: 'POST', body: '{}' }, META),
    (e) => e.name === 'NuvizzCircuitOpenError',
  );
  assert.equal(h.sent, 1, 'nothing past the ceiling was sent');
});
