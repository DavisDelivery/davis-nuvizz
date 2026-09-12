// test/routing-time-in-build.test.mjs — the build PAYS ATTENTION to time restrictions.
//
// Chad: "we need them to be able to pay attention to time restrictions, whether or not it's
// a tractor friendly stop." Before this, no window ever reached the solver (the board's
// stamps never parsed), so every case below is a dispatch situation the build used to be
// blind to. Minutes are on the board day; the mock matrix makes each map unit ~16.7 minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';

// depot first; distance in "meters" = hypot × 1000, and 1 meter = 1 second of driving.
const mockMatrix = () => async (depot, pts) => {
  const nodes = [depot, ...pts];
  const d = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000);
  const distanceMeters = nodes.map((a) => nodes.map((b) => d(a, b)));
  return { distanceMeters, durationSec: distanceMeters };
};
const truck = () => ({ id: 'BOX', maxSkids: 99, maxWeightLbs: 1e6, deckLengthIn: 1e6, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } });
const stop = (id, lng, extra = {}) => ({ stopNbr: id, lat: 0, lng, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [], ...extra });
const tr = (openMin, closeMin, label) => ({ openMin, closeMin, closedToday: false, sources: ['test'], label });
const DATE = '2026-09-11';
const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const run = (stops, extra = {}) => runPipeline(
  { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: DATE, departHHMM: '07:00', serviceMin: 15, ...extra },
  { buildMatrix: mockMatrix() },
);

test('WITHOUT the resolved clock the build is still blind to a stamped appointment (the env-off path)', async () => {
  const plan = await run([stop('A', 1), stop('B', 2, { scheduledFrom: `${DATE}T13:00:00`, scheduledTo: `${DATE}T13:30:00`, timeConstraint: 'STRICT' })]);
  assert.deepEqual(plan.routes[0].orderedStopIds, ['A', 'B']);
  assert.deepEqual(plan.routes[0].windowViolatedIds, [], 'no window was ever seen — exactly the old behaviour ROUTING_TIME_RESTRICTIONS=off restores');
});

test('A 7:45–8:15 WINDOW THAT THE NATURAL ORDER ALREADY MEETS changes nothing and is reported honoured', async () => {
  // A at 07:16, then 15 min service, B at 07:48 — inside the window without moving anything.
  const plan = await run([stop('A', 1), stop('B', 2, { timeRestriction: tr(7 * 60 + 45, 8 * 60 + 15, '7:45a–8:15a') }), stop('C', 3)]);
  const r = plan.routes[0];
  assert.deepEqual(r.orderedStopIds, ['A', 'B', 'C']);
  assert.deepEqual(r.windowViolatedIds, []);
  assert.equal(hhmm(r.etas[1]), '07:48');
  assert.deepEqual(r.waitSec, [0, 0, 0]);
  assert.equal(plan.timeRestrictions.B.label, '7:45a–8:15a', 'the card gets the clock in words');
});

test('A DOCK THAT SHUTS AT 8:00 GOES FIRST, even though it is the farthest stop', async () => {
  // Min distance would run A, B, C and reach C at 08:24 — after the close. C by 8:00: go now.
  const plan = await run([stop('A', 1), stop('B', 2), stop('C', 3, { timeRestriction: tr(null, 8 * 60, 'by 8:00a') })]);
  const r = plan.routes[0];
  assert.equal(r.orderedStopIds[0], 'C');
  assert.equal(hhmm(r.etas[0]), '07:50');
  assert.deepEqual(r.windowViolatedIds, [], 'made in time, nothing to flag');
});

test('A DOCK THAT OPENS AT 9:00 IS PUSHED LATER, NOT IDLED AT — and the wait that remains is reported', async () => {
  // A first would idle 07:16 → 09:00. Last, the truck reaches it at 08:53 and waits 7 min.
  const plan = await run([stop('A', 1, { timeRestriction: tr(9 * 60, 17 * 60, '9:00a–5:00p') }), stop('B', 2), stop('C', 3)]);
  const r = plan.routes[0];
  assert.equal(r.orderedStopIds[r.orderedStopIds.length - 1], 'A', 'the late opener goes last');
  assert.equal(hhmm(r.etas[2]), '09:00', 'service starts when the dock opens');
  assert.ok(r.waitSec[2] > 0 && r.waitSec[2] <= 10 * 60, `a short wait, not an hour and a half: ${r.waitSec[2]}s`);
  assert.deepEqual(r.windowViolatedIds, []);
});

test('ADVISORY (default): a window nothing can meet keeps the stop and FLAGS it, in the build\'s own words', async () => {
  const plan = await run([stop('A', 1), stop('B', 2, { timeRestriction: tr(null, 7 * 60 + 5, 'by 7:05a') })]);
  const r = plan.routes[0];
  assert.ok(r.orderedStopIds.includes('B'), 'kept on the truck');
  assert.deepEqual(r.windowViolatedIds, ['B']);
  assert.ok(plan.riskFlags.some((f) => /Stop B is outside its time window \(by 7:05a\)/.test(f)), plan.riskFlags.join(' | '));
  assert.equal(plan.unassigned.length, 0);
});

test('STRICT: the same stop comes off the truck with the window reason', async () => {
  const plan = await run([stop('A', 1), stop('B', 2, { timeRestriction: tr(null, 7 * 60 + 5, 'by 7:05a') })], { windowMode: 'strict' });
  assert.ok(plan.unassigned.some((u) => u.stopId === 'B' && u.reasons.some((x) => /window/.test(x))));
  assert.ok(plan.routes.every((r) => !r.orderedStopIds.includes('B')));
});

test('CLOSED ON THE DELIVERY DAY: advisory flags it as closed, strict leaves it off with its own reason', async () => {
  const closed = { openMin: null, closeMin: null, closedToday: true, sources: ['closed Friday'], label: 'closed Friday' };
  const adv = await run([stop('A', 1), stop('B', 2, { timeRestriction: closed })]);
  assert.deepEqual(adv.routes[0].windowViolatedIds, ['B']);
  assert.ok(adv.riskFlags.some((f) => /Stop B: customer is closed Friday/.test(f)), adv.riskFlags.join(' | '));
  const strict = await run([stop('A', 1), stop('B', 2, { timeRestriction: closed })], { windowMode: 'strict' });
  const u = strict.unassigned.find((x) => x.stopId === 'B');
  assert.ok(u && u.reasons.some((x) => /closed on the delivery day/.test(x)), JSON.stringify(strict.unassigned));
});

test('WHETHER OR NOT IT IS A TRACTOR-FRIENDLY STOP: a box-only stop gets the same clock as a green one', async () => {
  const win = tr(null, 8 * 60, 'by 8:00a');
  const green = await run([stop('A', 1), stop('B', 2), stop('C', 3, { timeRestriction: win, equipmentReqs: [] })]);
  const red = await run([stop('A', 1), stop('B', 2), stop('C', 3, { timeRestriction: win, equipmentReqs: ['box_truck_only'] })]);
  assert.deepEqual(red.routes[0].orderedStopIds, green.routes[0].orderedStopIds);
  assert.deepEqual(red.routes[0].etas, green.routes[0].etas);
  assert.deepEqual(red.routes[0].windowViolatedIds, green.routes[0].windowViolatedIds);
});

test('the strategy still owns the un-windowed stops: only the windowed one moves', async () => {
  // CLOSEST_FIRST on A(1) B(2) C(3) D(4) is A,B,C,D; a "by 8:00" on D pulls D forward (07:50 → fits before A? no: D at 08:07 from depot is 1:07 = 67min → 08:07 > 08:00; least-late position is first, 08:07 is 7 min late) — so D goes first and A,B,C keep their order behind it.
  const plan = await run([stop('A', 1), stop('B', 2), stop('C', 3), stop('D', 4, { timeRestriction: tr(null, 8 * 60, 'by 8:00a') })], { strategy: 'CLOSEST_FIRST' });
  const r = plan.routes[0];
  assert.equal(r.orderedStopIds[0], 'D');
  assert.deepEqual(r.orderedStopIds.slice(1), ['A', 'B', 'C'], 'closest-first order survives for the rest');
});
