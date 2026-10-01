// test/build-window-reach.test.mjs — THE WINDOW ORDER READS THE CLOCK THE TRUCK IS ON
// (routing-repair windowAwareOrder, ROUTING_BUILD_WINDOW_REACH).
//
// Found by an adversarial review of the measured-departure change (Chad, 2026-10-01: RASHEED
// "typically leaves" around 12:10). Once a truck really leaves at noon, two old window rules
// misfired, and one of them can bite on an 08:00 Build too:
//   1. A dock that closes before the truck can get there — even going there first — went in FIRST
//      (it is the least late there), dragged the run to it and pushed stops that COULD be made past
//      their close. Strict then took a deliverable order off with "appointment window cannot be met".
//   2. Placing windows one at a time painted itself into a corner: three 2:00p docks in one town,
//      the first two placed after an unwindowed stop, and the third could no longer be made.
// Now a dock no order can make sets nothing (strict takes it off first and names the clock), and
// when the one-at-a-time order leaves a reachable dock late the appointments-first order is tried
// too. And the Build without the fix is made as well: it ships instead if it carries more orders
// (strict) or runs fewer late stops (advisory), so the fix can never cost an order.
//
// Pins are the reviewer's board (Buford-area town centres, small offsets); everything runs the
// real pipeline on straight-line drive times, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';
import { resolveMatrix } from '../netlify/functions/google-route-matrix.mts';
import { buildRules } from '../netlify/functions/lib/routing-build-rules.mts';

const D = '2026-10-01';
const hm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const box = (id) => ({ id, label: id, maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } });
const toMin = (x) => (x == null ? null : Number(x.slice(0, 2)) * 60 + Number(x.slice(3)));
const S = (stopNbr, town, lat, lng, sk, win) => ({
  stopNbr, businessName: `${town.toUpperCase()} ${stopNbr}`, lat, lng, pallets: sk, cartons: sk, weight: 500,
  ...(win ? { timeRestriction: { openMin: toMin(win[0]), closeMin: toMin(win[1]), closedToday: false, label: `${win[0]}–${win[1]}` } } : {}),
});
// One truck leaving at 12:10. Two docks close at noon (no order can make them); four close at 2:00p
// and all four CAN be made; three stops have no hours.
const NOON = [
  S('S16', 'flowery', 34.169, -83.945, 1, ['08:00', '14:00']),
  S('S21', 'auburn', 34.033, -83.828, 2, null),
  S('S10', 'lawrenceville', 33.976, -83.98, 2, ['08:00', '14:00']),
  S('S20', 'lawrenceville', 33.96, -83.992, 2, null),
  S('S30', 'snellville', 33.845, -84.036, 1, ['07:00', '12:00']),
  S('S24', 'loganville', 33.819, -83.888, 2, null),
  S('S25', 'conyers', 33.664, -84.001, 1, ['07:00', '12:00']),
  S('S2', 'lawrenceville', 33.936, -84.012, 2, ['08:00', '14:00']),
  S('S17', 'lawrenceville', 33.956, -84.004, 1, ['08:00', '14:00']),
];
const deps = { buildMatrix: async (depot, pts) => resolveMatrix(depot, pts, 'haversine') };
const build = (stops, extra = {}) => runPipeline({
  stops, trucks: [box('LATE')], date: D, strategy: 'MIN_DISTANCE', matrixMode: 'haversine',
  leaveOffEnds: true, fillTrucks: true, departHHMM: '12:10', ...extra,
}, deps);
const km = (r) => r.routes.reduce((a, x) => a + x.legs.reduce((b, l) => b + l.distanceMeters, 0), 0) / 1000;
const orders = (r) => r.routes.reduce((a, x) => a + x.orderedStopIds.length, 0);
const late = (r) => r.routes.reduce((a, x) => a + (x.windowViolatedIds || []).length, 0);

test('AS IT WAS (switch off): strict at 12:10 takes off two 2:00p orders the truck could have made', async () => {
  const r = await build(NOON, { windowMode: 'strict' });
  const off = r.unassigned.map((u) => u.stopId).sort();
  assert.deepEqual(off, ['S16', 'S2', 'S25', 'S30'], 'S16 and S2 close at 2:00p and are reachable');
});

test('NOW: strict at 12:10 delivers every 2:00p order; only the two noon docks come off, and the reason names the clock', async () => {
  const r = await build(NOON, { windowMode: 'strict', windowReach: true });
  const route = r.routes[0];
  for (const id of ['S16', 'S10', 'S2', 'S17']) assert.ok(route.orderedStopIds.includes(id), `${id} rides`);
  assert.deepEqual(r.unassigned.map((u) => u.stopId).sort(), ['S25', 'S30']);
  for (const u of r.unassigned) {
    assert.equal(u.reasons.length, 1);
    assert.match(u.reasons[0], /^appointment window cannot be met — it closes 12:00p, before LATE can get there leaving at 12:10p$/);
  }
  assert.deepEqual(route.windowViolatedIds, [], 'strict ships nothing late');
  const lawrenceville = route.orderedStopIds.filter((id) => ['S10', 'S20', 'S2', 'S17'].includes(id));
  const at = route.orderedStopIds.indexOf(lawrenceville[0]);
  assert.deepEqual(route.orderedStopIds.slice(at, at + 4).sort(), ['S10', 'S17', 'S2', 'S20'], 'Lawrenceville is driven in one visit');
});

test('NOW, advisory: the noon docks no longer set the run — it is shorter and misses only what nobody could make', async () => {
  const before = await build(NOON, { windowMode: 'advisory' });
  const after = await build(NOON, { windowMode: 'advisory', windowReach: true });
  assert.deepEqual(after.routes[0].windowViolatedIds.sort(), ['S25', 'S30']);
  assert.ok(!['S25', 'S30'].includes(after.routes[0].orderedStopIds[0]), 'a shut dock is not the first stop');
  assert.ok(km(after) < km(before), `${km(after).toFixed(0)} km against ${km(before).toFixed(0)} km before`);
  assert.equal(orders(after), orders(before));
});

// ── Random boards: the guarantees, not one example ──
const TOWNS = [[34.207, -84.140], [34.298, -83.824], [34.185, -83.925], [34.109, -83.762], [34.117, -83.572], [34.204, -83.457], [33.951, -83.357], [33.992, -83.720], [33.795, -83.713], [33.839, -83.900], [33.956, -83.988], [34.003, -84.144], [34.075, -84.294], [34.023, -84.361], [34.237, -84.491], [34.421, -84.119], [34.533, -83.985], [33.597, -83.860], [33.668, -84.017], [33.857, -84.020], [34.013, -83.828]];
const WINS = [null, null, null, null, ['07:00', '12:00'], ['08:00', '14:00'], ['07:00', '15:30'], ['08:00', '17:00'], ['10:00', '11:00'], ['13:00', '15:00'], ['06:00', '08:30'], ['08:00', '10:00']];
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function board(seed) {
  const r = rng(seed); const nT = 1 + Math.floor(r() * 3); const n = 6 + Math.floor(r() * nT * 12);
  const stops = Array.from({ length: n }, (_, i) => { const [la, ln] = TOWNS[Math.floor(r() * TOWNS.length)]; return S(`B${i}`, 'x', la + (r() - 0.5) * 0.06, ln + (r() - 0.5) * 0.06, 1 + Math.floor(r() * 3), WINS[Math.floor(r() * WINS.length)]); });
  return { stops, trucks: Array.from({ length: nT }, (_, i) => box(`T${i}`)) };
}
const randomBuild = (b, extra) => runPipeline({ stops: b.stops, trucks: b.trucks, date: D, strategy: 'MIN_DISTANCE', matrixMode: 'haversine', leaveOffEnds: true, fillTrucks: true, ...extra }, deps);

test('NEVER WORSE, on 60 random boards × 08:00 and 12:10: strict carries at least as many orders, advisory runs no more late stops, and strict never ships a late stop', async () => {
  let more = 0, fewerLate = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const b = board(seed);
    for (const departHHMM of ['08:00', '12:10']) {
      const so = await randomBuild(b, { departHHMM, windowMode: 'strict' });
      const sn = await randomBuild(b, { departHHMM, windowMode: 'strict', windowReach: true });
      assert.ok(orders(sn) >= orders(so), `seed ${seed} ${departHHMM}: ${orders(sn)} orders against ${orders(so)}`);
      assert.equal(late(sn), 0, `seed ${seed} ${departHHMM}: strict shipped a late stop`);
      if (orders(sn) > orders(so)) more++;
      const ao = await randomBuild(b, { departHHMM, windowMode: 'advisory' });
      const an = await randomBuild(b, { departHHMM, windowMode: 'advisory', windowReach: true });
      assert.ok(late(an) <= late(ao), `seed ${seed} ${departHHMM}: ${late(an)} late against ${late(ao)}`);
      assert.equal(orders(an), orders(ao), 'advisory keeps every order either way');
      if (late(an) < late(ao)) fewerLate++;
    }
  }
  assert.ok(more > 0 && fewerLate > 0, `it does something: ${more} strict Builds carried more, ${fewerLate} advisory Builds ran fewer late`);
});

test('A STRICT BUILD NEVER SHIPS A LATE STOP — two boards that used to (or would without the remembered run)', async () => {
  // 265: the old order reaches a 3:00p dock at 3:07p and strict ships it, flagged. 634: without the
  // one-run-per-set memory, repair checks one order and assembles another (a stop a minute late).
  for (const seed of [265, 634]) {
    const b = board(seed);
    const r = await randomBuild(b, { departHHMM: '12:10', windowMode: 'strict', windowReach: true });
    assert.equal(late(r), 0, `seed ${seed}: ${JSON.stringify(r.routes.map((x) => x.windowViolatedIds))}`);
  }
  const old = await randomBuild(board(265), { departHHMM: '12:10', windowMode: 'strict' });
  assert.equal(late(old), 1, 'the old order did ship one');
});

test('a Build where every window is made the old way ships exactly the old Build', async () => {
  // Nothing late and nothing unreachable: the one-at-a-time order stands, untouched.
  const easy = NOON.map((s) => (s.timeRestriction ? { ...s, timeRestriction: { ...s.timeRestriction, openMin: 6 * 60, closeMin: 18 * 60 } } : s));
  for (const windowMode of ['strict', 'advisory']) {
    const a = await build(easy, { windowMode, departHHMM: '08:00' });
    const b = await build(easy, { windowMode, departHHMM: '08:00', windowReach: true });
    assert.deepEqual(b.routes.map((r) => r.orderedStopIds), a.routes.map((r) => r.orderedStopIds), windowMode);
    assert.deepEqual(b.unassigned, a.unassigned);
  }
});

test('when the old Build carries more, it ships, and the job says so', async () => {
  // Find a board the guard catches (measured: about 1 in 100 strict Builds), and check it shipped the old plan.
  for (let seed = 1; seed <= 400; seed++) {
    const b = board(seed);
    for (const departHHMM of ['08:00', '12:10']) {
      const r = await randomBuild(b, { departHHMM, windowMode: 'strict', windowReach: true });
      const u = r.meta.windowReachUndone;
      if (!u) continue;
      assert.ok(u.ordersWithout >= u.ordersWith);
      const plain = await randomBuild(b, { departHHMM, windowMode: 'strict' });
      assert.deepEqual(r.routes.map((x) => x.orderedStopIds), plain.routes.map((x) => x.orderedStopIds), 'the old plan, exactly');
      return;
    }
  }
  assert.fail('no board in 400 tripped the guard — the test no longer exercises it');
});

test('the switch is house shape, the Build records it, and the background hands it to the pipeline', () => {
  assert.equal(buildRules({}).windowReach, true);
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(buildRules({ ROUTING_BUILD_WINDOW_REACH: off }).windowReach, false, off);
  for (const on of ['of', 'yes', 'on', '1', 'maybe']) assert.equal(buildRules({ ROUTING_BUILD_WINDOW_REACH: on }).windowReach, true, on);
  const BG = readFileSync(new URL('../netlify/functions/routing-build-background.mts', import.meta.url), 'utf8');
  assert.ok(BG.includes('      windowReach: rules.windowReach,'), 'the Build does not pass the switch on');
});
