// test/uat-seed-board-window-is-what-was-sent.test.mjs
//
// A SEEDED UAT BOARD ROW SHOWED A WINDOW THE UAT ORDER DID NOT HAVE (audit 2026-09-27,
// shiplify-lookup-uat-7).
//
// The seeder refuses a half or inverted production window (both ends, in order, or neither), so
// NuVizz is sent the builder's default 12:00–17:00. But the board row it then wrote for the UAT
// order still copied production's scheduledFrom / scheduledTo / timeConstraint: production said
// 18:30 / (none) / MUST, the UAT tenant held 12:00–17:00 PREFERRED, and the UAT board — and the
// flag engine reading it — tested a window the order does not have. Rule 3 of lib/uat-seed.mts
// ("the scenario IS the window") broken on the board half.
//
// What happens now: the seeded board row carries the window and constraint NuVizz was actually
// sent for that order — production's own window when it crossed, the default when it did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { buildSeedRow, seedIndexRow } from '../netlify/functions/lib/uat-seed.mts';
import { buildStopPayload } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const ORIGIN = { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' };
const prodRow = (over = {}) => ({
  stopNbr: '007174397', businessName: 'LED ENERGY PLUS', addr1: '1 MAIN ST', city: 'NORCROSS', state: 'GA', zip: '30071',
  lat: 33.9, lng: -84.2, isUnplanned: true, isPlanned: false,
  scheduledFrom: '2026-09-27T08:00:00', scheduledTo: '2026-09-27T14:00:00', timeConstraint: 'STRICT',
  ...over,
});
const sentFor = (plan) => buildStopPayload(plan.row, { origin: ORIGIN, serviceDate: '2026-09-27' }).to.schedule;
const boardWindow = (row) => ({ from: row.scheduledFrom, to: row.scheduledTo, constraint: row.timeConstraint });

test('an order with only an opening time on production is on the UAT board with the default window it was created with', () => {
  const prod = prodRow({ scheduledFrom: '2026-09-27T18:30:00', scheduledTo: null, timeConstraint: 'MUST' });
  const plan = buildSeedRow(prod);
  const sent = sentFor(plan);
  const row = seedIndexRow(prod, plan, { stopId: '555', stopNbr: 'UT-007174397' }, sent);
  assert.deepEqual(boardWindow(row), { from: '2026-09-27T12:00:00', to: '2026-09-27T17:00:00', constraint: 'PREFERRED' },
    'not production\'s 18:30 / none / MUST');
});

test('an inverted production window is on the UAT board as the default it was replaced with, not the inverted pair', () => {
  const prod = prodRow({ scheduledFrom: '2026-09-27T18:30:00', scheduledTo: '2026-09-27T17:00:00', timeConstraint: 'STRICT' });
  const plan = buildSeedRow(prod);
  const row = seedIndexRow(prod, plan, { stopId: '555' }, sentFor(plan));
  assert.deepEqual(boardWindow(row), { from: '2026-09-27T12:00:00', to: '2026-09-27T17:00:00', constraint: 'STRICT' });
});

test('a real production window still crosses to the UAT board unchanged', () => {
  const prod = prodRow();
  const plan = buildSeedRow(prod);
  const row = seedIndexRow(prod, plan, { stopId: '555' }, sentFor(plan));
  assert.deepEqual(boardWindow(row), { from: '2026-09-27T08:00:00', to: '2026-09-27T14:00:00', constraint: 'STRICT' });
});

test('with no record of what was sent, a dropped window is shown as no window — never production\'s half one', () => {
  const prod = prodRow({ scheduledFrom: '2026-09-27T18:30:00', scheduledTo: null, timeConstraint: 'MUST' });
  const row = seedIndexRow(prod, buildSeedRow(prod), { stopId: '555' });
  assert.deepEqual(boardWindow(row), { from: null, to: null, constraint: null });
});

test('seeding through the bench writes the board row with the exact window NuVizz was sent', async () => {
  const D = '2026-09-28';
  const sentBodies = [];
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/davis__${D}/stops/007174397`]: prodRow({ scheduledFrom: `${D}T18:30:00`, scheduledTo: null, timeConstraint: 'MUST' }),
  }, async (url, init) => {
    if (/stop\/sync\/update/.test(url)) {
      sentBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ status: 'SUCCESS', entityInfoList: [{ entityId: '555', entityNbr: 'UT-007174397' }] }), { status: 200 });
    }
    throw new Error(`unexpected vendor call ${url}`);
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
    const res = await handler(new Request('https://x/.netlify/functions/uat-seed', { method: 'POST', body: JSON.stringify({ op: 'seed', date: D, stopNbrs: ['007174397'] }) }));
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(sentBodies.length, 1);
    const sent = sentBodies[0].stop.to.schedule;
    const row = fake.store.get(`nuvizz_stop_index/davis__${D}/stops/UT-007174397`);
    assert.ok(row, 'the UAT board row was written');
    assert.deepEqual(boardWindow(row), { from: sent.timeFrom, to: sent.timeTo, constraint: sent.timeConstraint },
      'the board row says what the UAT order was created with');
    assert.equal(row.scheduledFrom, `${D}T12:00:00`);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.restore();
  }
});
