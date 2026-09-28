// test/uat-reseed-other-day-moves-board-row.test.mjs
//
// RE-SEEDING AN ORDER FROM A SECOND DAY LEFT A PHANTOM ON THE FIRST (audit 2026-09-27,
// shiplify-lookup-uat-8).
//
// The bench's ledger is one document per UAT number, keyed by tenant rather than date, and the
// UAT number is derived from production's (UT-<nbr>), so a re-seed UPSERTS the same UAT order.
// A carried-over order sits on production's Monday AND Tuesday catalogues: seed it for a Monday
// scenario, then for a Tuesday one, and the ledger row was simply repointed to Tuesday. Monday's
// UAT board row stayed in Firestore with nothing recording it, and Clear — which deletes only the
// ledger's day — could never remove it: a permanent UNPLANNED UT- order on Monday's UAT board.
//
// What happens now: a re-seed from another day removes the order's row from the day it was on
// (and recounts that day) before repointing the ledger — it is one order in the tenant, so it
// stands on one UAT day — and the seed says so in its warnings. Clear then leaves nothing behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { supersededBoardDate } from '../netlify/functions/lib/uat-seed.mts';

const D1 = '2026-09-28';
const D2 = '2026-09-29';
const NBR = 'UT-007174397';
const prodRow = { stopNbr: '007174397', businessName: 'LED ENERGY PLUS', addr1: '1 MAIN ST', city: 'NORCROSS', state: 'GA', zip: '30071', isUnplanned: true, isPlanned: false };
const board = (d) => `nuvizz_stop_index/davis__${d}/stops/${NBR}`;

test('supersededBoardDate names the day a re-seed must strike, and nothing else', () => {
  assert.equal(supersededBoardDate({ boardDate: D1 }, D2), D1, 'seeded before for another day');
  assert.equal(supersededBoardDate({ boardDate: D2 }, D2), null, 'the same day is an update in place');
  assert.equal(supersededBoardDate(undefined, D2), null, 'never seeded');
  for (const junk of [{}, { boardDate: '' }, { boardDate: 'yesterday' }, { boardDate: null }, null]) {
    assert.equal(supersededBoardDate(junk, D2), null, JSON.stringify(junk));
  }
});

test('an order seeded for Monday and then for Tuesday is on Tuesday\'s UAT board only, and Clear leaves no phantom behind', async () => {
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/davis__${D1}/stops/007174397`]: prodRow,
    [`nuvizz_stop_index/davis__${D2}/stops/007174397`]: prodRow,
  }, async (url, init) => {
    const m = init?.method || 'GET';
    if (/stop\/sync\/update/.test(url)) return new Response(JSON.stringify({ status: 'SUCCESS', entityInfoList: [{ entityId: '555', entityNbr: NBR }] }), { status: 200 });
    if (/stop\/info/.test(url) && m === 'GET') return new Response(JSON.stringify({ Stop: { stop: { stopId: '555', stopNbr: NBR }, stopExecutionInfo: { stopStatus: '10' } } }), { status: 200 });
    if (/stop\/cancel/.test(url)) return new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 });
    throw new Error(`unexpected vendor call ${m} ${url}`);
  });
  const env = {
    FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7',
    NUVIZZ_DAVIS_COMPANY_CODE: 'DAVISV5', NUVIZZ_DAVIS_USER: 'u', NUVIZZ_DAVIS_PASS: 'p',
    NUVIZZ_WRITE_ENABLED: 'true', MIRROR_ALLOW_OUTBOUND: 'nuvizz-write',
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const handler = (await import('../netlify/functions/uat-seed.mts')).default;
    const post = async (b) => (await handler(new Request('https://x/.netlify/functions/uat-seed', { method: 'POST', body: JSON.stringify(b) }))).json();

    const s1 = await post({ op: 'seed', date: D1, stopNbrs: ['007174397'] });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.equal(fake.store.has(board(D1)), true, 'Monday\'s UAT board carries it');
    assert.equal(fake.store.get(`nuvizz_stop_index/davis__${D1}`)?.count, 2, 'production\'s row plus the UAT copy');

    const s2 = await post({ op: 'seed', date: D2, stopNbrs: ['007174397'] });
    assert.equal(s2.ok, true, JSON.stringify(s2));
    assert.equal(fake.store.get(`uat_seed/davis/orders/${NBR}`)?.boardDate, D2, 'the ledger follows the order');
    assert.equal(fake.store.has(board(D2)), true, 'Tuesday\'s UAT board carries it');
    assert.equal(fake.store.has(board(D1)), false, 'and Monday\'s no longer does — one order, one day');
    assert.equal(fake.store.get(`nuvizz_stop_index/davis__${D1}`)?.count, 1, 'Monday is recounted without it');
    assert.ok(s2.warnings.some((w) => w.includes(NBR) && w.includes(D1)), 'the seed says it moved the order off Monday');

    const c = await post({ op: 'clear' });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.cancelled, 1);
    assert.equal(fake.store.has(board(D1)), false, 'no phantom on Monday');
    assert.equal(fake.store.has(board(D2)), false, 'nor on Tuesday');
    assert.equal([...fake.store.keys()].filter((k) => k.startsWith('uat_seed/')).length, 0, 'the ledger is empty');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.restore();
  }
});
