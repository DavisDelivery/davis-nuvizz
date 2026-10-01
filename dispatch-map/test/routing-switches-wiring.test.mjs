// test/routing-switches-wiring.test.mjs — A SWITCH SET ON DIAGNOSTICS REACHES THE SERVER PATHS THAT
// READ IT. Behaviour, not text: each test runs the real handler on an in-memory Firestore and checks
// what came out, so moving a load of the switches below the read it feeds — or dropping it — is a
// red build, not a string that still happens to be in the file.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;
process.env.AUTH_SESSION_SECRET ||= 'test-session-secret-that-is-long-enough-32';

import routingBuild from '../netlify/functions/routing-build-background.mts';
import roadBox, { resolveMatrix } from '../netlify/functions/google-route-matrix.mts';
import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';
import { repairOriginFirstEnabled } from '../netlify/functions/lib/routing-repair.mts';
import { runCleanup } from '../netlify/functions/lib/routing-cleanup-core.mts';
import { _resetRoutingSwitchesStoreForTests } from '../netlify/functions/lib/routing-switches-store.mts';
import { DEPOT } from '../netlify/functions/lib/routing-types.mts';

const DOC = 'routing_switches/davis';
const D = '2026-09-11';
const set = (on) => ({ on, at: '2026-10-01T14:00:00.000Z', by: 'dispatcher-a' });
// The trail a request carries once it has read the document: this request's read ('fresh'), or a
// copy read moments earlier in the same request ('cached' — a later check inside the 30 s window).
function readOk(trail, wantSet) {
  assert.ok(['fresh', 'cached'].includes(trail?.read), `read: ${trail?.read}`);
  assert.equal(typeof trail.copyFrom, 'string', 'says when the copy was read');
  assert.deepEqual(trail.set, wantSet);
}
const row = (id, i, extra = {}) => ({
  stopNbr: id, businessName: `CUSTOMER ${id}`, addr1: `${100 + i} Main St`, city: 'CARTERSVILLE', zip: '30120',
  lat: DEPOT.lat + 0.05 * (i + 1), lng: DEPOT.lng + 0.03 * (i + 1),
  cartons: 1, pallets: 1, weight: 100, weightUOM: 'LB', isUnplanned: true,
  stopDetails: [{ quantity: 6, quantityUOM: 'CTN', weight: 100, weightUOM: 'LB' }],
  ...extra,
});
// B has a booked 1:00–1:30 appointment — a time restriction the build honours unless it is off.
const ROWS = [row('A', 0), row('B', 1, { scheduledFrom: `${D}T13:00:00`, scheduledTo: `${D}T13:30:00`, timeConstraint: 'STRICT' })];
const BOX = { id: 'BOX', label: 'BOX', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } };

async function build(stored) {
  _resetRoutingSwitchesStoreForTests();
  const request = { tenant: 'davis', date: D, selectedStopIds: ROWS.map((r) => r.stopNbr), trucks: [BOX], strategy: 'MIN_DISTANCE', matrixMode: 'haversine', windowMode: 'advisory' };
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D }, 'routing_jobs/job_sw': { id: 'job_sw', status: 'queued', request } };
  for (const r of ROWS) seed[`nuvizz_stop_index/davis__${D}/stops/${r.stopNbr}`] = r;
  if (stored) seed[DOC] = stored;
  const fake = installFirestoreFake(seed);
  try {
    const res = await routingBuild(new Request('https://x.test/.netlify/functions/routing-build-background', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job_sw' }),
    }));
    assert.equal(res.status, 202);
    const job = fake.store.get('routing_jobs/job_sw');
    assert.equal(job.status, 'done', job.error);
    return job.result;
  } finally { fake.restore(); _resetRoutingSwitchesStoreForTests(); }
}

test('THE BUILD: time restrictions set OFF on the page are off for the build — read before the board is turned into stops', async () => {
  delete process.env.ROUTING_TIME_RESTRICTIONS;
  const on = await build(null);
  assert.ok(on.timeRestrictions?.B, 'nothing stored: B carries its appointment, as before');
  readOk(on.meta.routingSwitches, {});

  const off = await build({ ROUTING_TIME_RESTRICTIONS: set(false) });
  assert.deepEqual(off.timeRestrictions, {}, 'set off on the page: no clock reached the build');
  readOk(off.meta.routingSwitches, { ROUTING_TIME_RESTRICTIONS: false });   // the result says which page setting it honoured
});

test('THE BUILD: the page wins over Netlify in both directions, and a handed-back switch is Netlify\'s again', async () => {
  process.env.ROUTING_TIME_RESTRICTIONS = 'off';
  try {
    assert.deepEqual((await build(null)).timeRestrictions, {}, 'Netlify off, nothing stored: off');
    assert.ok((await build({ ROUTING_TIME_RESTRICTIONS: set(true) })).timeRestrictions?.B, 'set ON on the page beats Netlify off');
    assert.deepEqual((await build({ ROUTING_TIME_RESTRICTIONS: { on: null, at: '2026-10-01T14:00:00.000Z', by: 'dispatcher-a' } })).timeRestrictions, {}, 'handed back: Netlify off again');
  } finally { delete process.env.ROUTING_TIME_RESTRICTIONS; }
});

test('THE ROAD BOX: the free straight-line mode never waits on the switches document; Google mode honours the page — read BEFORE the switch is', async () => {
  // Google answers every pair, except depot → first stop, which it cannot route. With the switch on
  // that leg is priced at the road estimate; off, it is the old free 0-second, 0-metre leg.
  const run = async (stored, env) => {
    _resetRoutingSwitchesStoreForTests();
    const fake = installFirestoreFake(stored ? { [DOC]: stored } : {});
    const toFirestore = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url?.url ?? url).startsWith('https://routes.googleapis.com/')) return toFirestore(url, init);
      const body = JSON.parse(init.body);
      const out = [];
      body.origins.forEach((_, i) => body.destinations.forEach((_, j) => {
        out.push(i === 0 && j === 1 ? { originIndex: i, destinationIndex: j, condition: 'ROUTE_NOT_FOUND' }
          : { originIndex: i, destinationIndex: j, condition: 'ROUTE_EXISTS', duration: i === j ? '0s' : '600s', distanceMeters: i === j ? 0 : 9000 });
      }));
      return new Response(JSON.stringify(out), { status: 200 });
    };
    const key = process.env.GOOGLE_ROUTES_API_KEY;
    process.env.GOOGLE_ROUTES_API_KEY = 'test-key';
    if (env === undefined) delete process.env.ROAD_BOX_ESTIMATE_UNROUTABLE; else process.env.ROAD_BOX_ESTIMATE_UNROUTABLE = env;
    const ask = (mode) => roadBox(new Request('https://x.test/.netlify/functions/google-route-matrix', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ depot: { lat: DEPOT.lat, lng: DEPOT.lng }, stops: ROWS.map((r) => ({ lat: r.lat, lng: r.lng })), ...(mode ? { mode } : {}) }),
    })).then((r) => r.json());
    try {
      const hav = await ask();
      const readsAfterHav = fake.log.gets.filter((p) => String(p).includes('routing_switches')).length;
      const g = await ask('google');
      return { hav, readsAfterHav, g, reads: fake.log.gets.filter((p) => String(p).includes('routing_switches')).length };
    } finally {
      fake.restore(); _resetRoutingSwitchesStoreForTests();
      delete process.env.ROAD_BOX_ESTIMATE_UNROUTABLE;
      if (key === undefined) delete process.env.GOOGLE_ROUTES_API_KEY; else process.env.GOOGLE_ROUTES_API_KEY = key;
    }
  };

  const plain = await run(null);
  assert.equal(plain.hav.source, 'haversine');
  assert.equal(plain.readsAfterHav, 0, 'straight-line mode read nothing — as fast as before the page');
  assert.equal('switches' in plain.hav, false);
  assert.equal(plain.g.source, 'google');
  assert.equal(plain.reads, 1, 'Google mode read the switches once');
  assert.ok(plain.g.matrix.distanceMeters[0][1] > 0, 'nothing stored: the road estimate, as before');
  readOk(plain.g.switches, {});

  const off = await run({ ROAD_BOX_ESTIMATE_UNROUTABLE: set(false) });
  assert.equal(off.g.matrix.distanceMeters[0][1], 0, 'set off on the page: the old free leg');
  assert.equal(off.g.matrix.durationSec[0][1], 0);
  readOk(off.g.switches, { ROAD_BOX_ESTIMATE_UNROUTABLE: false });

  const onOverNetlify = await run({ ROAD_BOX_ESTIMATE_UNROUTABLE: set(true) }, 'off');
  assert.ok(onOverNetlify.g.matrix.distanceMeters[0][1] > 0, 'set on on the page beats Netlify off');
});

test('THE PIPELINE on its own (the pre-resolved-stops path skips resolveStops): it reads the switches itself', async () => {
  _resetRoutingSwitchesStoreForTests();
  const fake = installFirestoreFake({ [DOC]: { ROUTING_REPAIR_ORIGIN_FIRST: set(false) } });
  try {
    const plan = await runPipeline(
      { stops: ROWS.map((r) => ({ stopNbr: r.stopNbr, lat: r.lat, lng: r.lng, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [] })), trucks: [BOX], depot: { lat: DEPOT.lat, lng: DEPOT.lng }, strategy: 'MIN_DISTANCE', date: D, matrixMode: 'haversine' },
      { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') },
    );
    assert.equal(plan.meta.routingSwitches.read, 'fresh', 'runPipeline read the document itself');
    assert.deepEqual(plan.meta.routingSwitches.set, { ROUTING_REPAIR_ORIGIN_FIRST: false });
    assert.equal(repairOriginFirstEnabled({}), false, 'and repair() reads the page setting');
  } finally { fake.restore(); _resetRoutingSwitchesStoreForTests(); }
});

test('CLEANUP ("Fill my loads"): a switch set on the page is read before the plan is built, and the plan says which it honoured', async () => {
  delete process.env.ROUTING_TIME_RESTRICTIONS;
  const run = async (stored) => {
    _resetRoutingSwitchesStoreForTests();
    const seed = { [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D } };
    for (const r of ROWS) seed[`nuvizz_stop_index/davis__${D}/stops/${r.stopNbr}`] = r;
    if (stored) seed[DOC] = stored;
    const fake = installFirestoreFake(seed);
    try {
      const out = await runCleanup('davis', D, [{ key: 'BOX', label: 'BOX', maxSkids: 14, maxWeightLbs: 10000 }]);
      assert.equal(out.ok, true, out.error);
      return out.plan;
    } finally { fake.restore(); _resetRoutingSwitchesStoreForTests(); }
  };
  const on = await run(null);
  assert.equal(on.rules_detail?.time_restrictions, true);
  readOk(on.routing_switches, {});
  const off = await run({ ROUTING_TIME_RESTRICTIONS: set(false) });
  assert.equal(off.rules_detail?.time_restrictions, false, 'set off on the page: the plan ran without the clock');
  readOk(off.routing_switches, { ROUTING_TIME_RESTRICTIONS: false });
});
