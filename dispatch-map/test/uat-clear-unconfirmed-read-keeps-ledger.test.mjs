// test/uat-clear-unconfirmed-read-keeps-ledger.test.mjs
//
// A UAT BENCH CLEAR THAT COULD NOT READ THE TENANT FORGOT THE ORDERS IT NEVER CHECKED
// (audit 2026-09-27, shiplify-lookup-uat-2).
//
// `clear` reads each seeded order back with getStop. It treated EVERY failed read as "not in
// the tenant" — the breaker open, UAT answering 401 after a credential rotation, a 5xx after
// retries — and deleted the ledger row and the board row, then answered ok:true with
// alreadyGone:N. The order was still live in the UAT tenant and nothing recorded it any more,
// which the endpoint's own header says must never happen: "An order that exists in the tenant
// and in no ledger cannot be cleared by anything, ever."
//
// What happens now: only NuVizz's own "no such stop" (a 404 — the same proof of absence the
// inline-create gate in nuvizz-write.mts relies on) lets a clear forget an order. Any read it
// could not complete leaves the ledger and board rows standing, lists the order as stuck with
// the reason, and the reply is not ok — so the next clear can finish it. (The breaker-open case
// is in uat-clear-breaker-open-keeps-ledger.test.mjs: the requester caches the breaker's
// position per process, so it needs a process of its own.)
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

/** A bench with one seeded order on today's UAT board, and a vendor that answers `answer`. */
async function clearWith(answer, extraSeed = {}) {
  const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
  const today = etDayString();
  const boardRow = `nuvizz_stop_index/davis__${today}/stops/${NBR}`;
  const vendor = [];
  const fake = installFirestoreFake({
    [LEDGER_ROW]: { uatStopNbr: NBR, prodStopNbr: '007174397', boardDate: today, status: 'created', stopId: '555', at: 'x', label: null },
    [boardRow]: { stopNbr: NBR, stopId: '555' },
    ...extraSeed(today),
  }, async (url, init) => { vendor.push(`${init?.method || 'GET'} ${url}`); return answer(url, init); });
  const saved = {};
  for (const [k, v] of Object.entries(UAT_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const handler = (await import('../netlify/functions/uat-seed.mts')).default;
    const res = await handler(new Request('https://x/.netlify/functions/uat-seed', { method: 'POST', body: JSON.stringify({ op: 'clear' }) }));
    return {
      status: res.status, body: await res.json(), vendor,
      ledgerKept: fake.store.has(LEDGER_ROW), boardKept: fake.store.has(boardRow),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.restore();
  }
}
const none = () => ({});

test('a clear pressed while UAT NuVizz rejects the credentials (401) keeps the order in the ledger and says it is stuck', async () => {
  const r = await clearWith(() => new Response('{"message":"Unauthorized"}', { status: 401 }), none);
  assert.equal(r.vendor.length, 1, 'one read was attempted');
  assert.equal(r.ledgerKept, true, 'the ledger row must survive — the order was never shown to be gone');
  assert.equal(r.boardKept, true, 'and so must its board row');
  assert.equal(r.body.ok, false, 'a clear that checked nothing is not a successful clear');
  assert.equal(r.body.alreadyGone, 0, 'nothing was confirmed gone');
  assert.equal(r.body.stuck.length, 1);
  assert.equal(r.body.stuck[0].stopNbr, NBR);
  assert.match(r.body.stuck[0].error, /401/, 'the reason is on the reply');
});

test('a read that answers 200 but names no stop is not proof the order is gone — it stays in the ledger', async () => {
  const r = await clearWith(() => new Response('{}', { status: 200 }), none);
  assert.equal(r.ledgerKept, true);
  assert.equal(r.boardKept, true);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.stuck.length, 1);
});

test('an order NuVizz answers 404 for really is gone — the clear forgets it and says so', async () => {
  const r = await clearWith((url, init) => {
    if (/\/stop\/info\//.test(url) && (init?.method || 'GET') === 'GET') return new Response('{"message":"not found"}', { status: 404 });
    throw new Error(`unexpected vendor call ${url}`);
  }, none);
  assert.equal(r.vendor.length, 1, 'one read, and no cancel for an order that is not there');
  assert.equal(r.ledgerKept, false, 'the ledger row goes');
  assert.equal(r.boardKept, false, 'and so does the board row');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.alreadyGone, 1);
  assert.deepEqual(r.body.stuck, []);
});
