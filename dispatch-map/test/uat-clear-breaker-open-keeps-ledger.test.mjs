// test/uat-clear-breaker-open-keeps-ledger.test.mjs
//
// The breaker-open half of shiplify-lookup-uat-2 (audit 2026-09-27); the rest is in
// uat-clear-unconfirmed-read-keeps-ledger.test.mjs. It lives in its own file because the NuVizz
// requester is a per-process singleton that caches the breaker's position for 5 seconds, so a
// breaker test that shares a process with other clears would read their answer, not its own.
//
// A dispatcher presses Clear on the UAT bench while the NuVizz breaker is open. Every read is
// refused before it leaves, so nothing is known about the seeded orders — and the clear used to
// delete their ledger and board rows anyway and answer ok:true, alreadyGone:N. Now it forgets
// nothing, lists each order as stuck, and says the clear did not finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const UAT_ENV = {
  FIRESTORE_DATABASE: 'uat-mirror',
  NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7',
  NUVIZZ_DAVIS_COMPANY_CODE: 'DAVISV5',
  NUVIZZ_DAVIS_USER: 'u', NUVIZZ_DAVIS_PASS: 'p',
  NUVIZZ_WRITE_ENABLED: 'true',
  MIRROR_ALLOW_OUTBOUND: 'nuvizz-write',
};
const NBR = 'UT-007174397';
const LEDGER_ROW = `uat_seed/davis/orders/${NBR}`;

test('a clear pressed while the NuVizz breaker is open sends nothing, forgets nothing, and is not reported as done', async () => {
  const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
  const today = etDayString();
  const boardRow = `nuvizz_stop_index/davis__${today}/stops/${NBR}`;
  const vendor = [];
  const fake = installFirestoreFake({
    [LEDGER_ROW]: { uatStopNbr: NBR, prodStopNbr: '007174397', boardDate: today, status: 'created', stopId: '555', at: 'x', label: null },
    [boardRow]: { stopNbr: NBR, stopId: '555' },
    'nuvizz_ops/circuit': { open: true, day: today, reason: 'daily ceiling reached', at: new Date().toISOString() },
    [`nuvizz_ops/calls__${today}`]: { count: 999999 },
  }, async (url) => { vendor.push(url); return new Response('{}', { status: 500 }); });
  const saved = {};
  for (const [k, v] of Object.entries(UAT_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const handler = (await import('../netlify/functions/uat-seed.mts')).default;
    const res = await handler(new Request('https://x/.netlify/functions/uat-seed', { method: 'POST', body: JSON.stringify({ op: 'clear' }) }));
    const body = await res.json();
    assert.equal(vendor.length, 0, 'the breaker refused the read before it left');
    assert.equal(fake.store.has(LEDGER_ROW), true, 'the ledger row must survive — the order was never checked');
    assert.equal(fake.store.has(boardRow), true, 'and so must its board row');
    assert.equal(body.ok, false, 'a clear that checked nothing is not a successful clear');
    assert.equal(body.alreadyGone, 0);
    assert.equal(body.stuck.length, 1);
    assert.equal(body.stuck[0].stopNbr, NBR);
    assert.match(body.stuck[0].error, /breaker/i, 'the reason is on the reply');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.restore();
  }
});
