// test/build-window-reach.test.mjs — A DOCK THE TRUCK CANNOT REACH BEFORE IT CLOSES NEVER SETS THE RUN
// (routing-repair windowAwareOrder, ROUTING_BUILD_WINDOW_REACH).
//
// Found by an adversarial review of the measured-departure change (Chad, 2026-10-01: RASHEED
// "typically leaves" around 12:10). A dock that closes before the truck can get there — even driving
// to it first — was inserted like any other window: first, because it is least late there. It
// dragged the run to it and pushed docks that COULD be made past their close, so a strict Build took
// deliverable orders off with "appointment window cannot be met". Now strict takes such a dock off
// first and names the clock; advisory keeps it as early as it can go without costing a reachable
// dock (a near miss stays a near miss). A truck with no such dock gets exactly the order it always
// did, and the Build without the fix is made too: it ships instead whenever it is better on what a
// dispatcher counts. A second review measured the first, wider version of this change making routes
// hundreds of km longer for the same result; every guarantee below is pinned because of that.
//
// Pins are Buford-area town centres with small offsets; the real pipeline on straight-line drive
// times, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';
import { resolveMatrix } from '../netlify/functions/google-route-matrix.mts';
import { buildRules } from '../netlify/functions/lib/routing-build-rules.mts';

const D = '2026-10-01';
const box = (id) => ({ id, label: id, maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } });
const toMin = (x) => (x == null ? null : Number(x.slice(0, 2)) * 60 + Number(x.slice(3)));
const S = (stopNbr, lat, lng, sk, win) => ({
  stopNbr, businessName: stopNbr, lat, lng, pallets: sk, cartons: sk, weight: 500,
  ...(win ? { timeRestriction: { openMin: toMin(win[0]), closeMin: toMin(win[1]), closedToday: false, label: `${win[0]}–${win[1]}` } } : {}),
});
const deps = { buildMatrix: async (depot, pts) => resolveMatrix(depot, pts, 'haversine') };
const run = (stops, trucks, extra) => runPipeline({
  stops, trucks, date: D, strategy: 'MIN_DISTANCE', matrixMode: 'haversine', leaveOffEnds: true, fillTrucks: true, ...extra,
}, deps);
const km = (r) => r.routes.reduce((a, x) => a + x.legs.reduce((b, l) => b + l.distanceMeters, 0), 0) / 1000;
const orders = (r) => r.routes.reduce((a, x) => a + x.orderedStopIds.length, 0);
const late = (r) => r.routes.reduce((a, x) => a + (x.windowViolatedIds || []).length, 0);
const hm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);

// One truck leaving at 12:10: Snellville and Conyers close at noon (no order can make them), four
// docks close at 2:00p, three stops have no hours.
const NOON = [
  S('S16', 34.169, -83.945, 1, ['08:00', '14:00']), S('S21', 34.033, -83.828, 2, null),
  S('S10', 33.976, -83.98, 2, ['08:00', '14:00']), S('S20', 33.96, -83.992, 2, null),
  S('S30', 33.845, -84.036, 1, ['07:00', '12:00']), S('S24', 33.819, -83.888, 2, null),
  S('S25', 33.664, -84.001, 1, ['07:00', '12:00']), S('S2', 33.936, -84.012, 2, ['08:00', '14:00']),
  S('S17', 33.956, -84.004, 1, ['08:00', '14:00']),
];
const LATE = [box('LATE')];

test('AS IT WAS (switch off): strict at 12:10 takes off S16, a 2:00p dock the truck reaches at 12:14 by going there first', async () => {
  const r = await run(NOON, LATE, { departHHMM: '12:10', windowMode: 'strict' });
  assert.deepEqual(r.unassigned.map((u) => u.stopId).sort(), ['S16', 'S2', 'S25', 'S30']);
});

test('NOW: the two noon docks come off first, saying why, and S16 rides', async () => {
  const before = await run(NOON, LATE, { departHHMM: '12:10', windowMode: 'strict' });
  const r = await run(NOON, LATE, { departHHMM: '12:10', windowMode: 'strict', windowReach: true });
  const route = r.routes[0];
  for (const id of ['S16', 'S10', 'S17']) assert.ok(route.orderedStopIds.includes(id), `${id} rides`);
  assert.equal(orders(r), orders(before) + 1);
  for (const id of ['S25', 'S30']) {
    const u = r.unassigned.find((x) => x.stopId === id);
    assert.deepEqual(u.reasons, ['appointment window cannot be met — it closes 12:00p, before LATE leaves at 12:10p']);
  }
  assert.deepEqual(route.windowViolatedIds, []);
});

// Lawrenceville 6:00–8:30, 35 minutes from Buford: from 08:00 it is missed by four minutes whatever
// the order. The old order goes there first (8:34a, a phone call); it must stay that way.
const NEARMISS = [
  S('EARLY', 33.956, -83.988, 1, ['06:00', '08:30']), S('W1', 34.207, -84.140, 1, ['08:00', '12:00']),
  S('W2', 34.298, -83.824, 1, ['08:00', '14:00']), S('W3', 34.109, -83.762, 1, ['12:00', '13:00']),
  S('N1', 33.992, -83.720, 1, null), S('N2', 34.117, -83.572, 1, null),
];

test('a near miss stays a near miss (advisory): the 8:30 dock is still first, four minutes late — not moved to the end', async () => {
  const before = await run(NEARMISS, [box('RASHEED')], { windowMode: 'advisory' });
  const r = await run(NEARMISS, [box('RASHEED')], { windowMode: 'advisory', windowReach: true });
  assert.deepEqual(r.routes[0].orderedStopIds, before.routes[0].orderedStopIds);
  assert.equal(r.routes[0].orderedStopIds[0], 'EARLY');
  assert.equal(hm(r.routes[0].etas[0]), '08:34');
});

test('strict at 08:00 says when the truck could get there, not just that it cannot', async () => {
  const r = await run(NEARMISS, [box('RASHEED')], { windowMode: 'strict', windowReach: true });
  assert.deepEqual(r.unassigned, [{ stopId: 'EARLY', reasons: ['appointment window cannot be met — it closes 8:30a; leaving at 8:00a, RASHEED gets there 8:34a at the earliest'] }]);
});

test('a truck with no dock it cannot reach ships exactly the old order', async () => {
  const easy = NOON.filter((s) => !['S25', 'S30'].includes(s.stopNbr));
  for (const windowMode of ['strict', 'advisory']) for (const departHHMM of ['08:00', '12:10']) {
    const a = await run(easy, LATE, { windowMode, departHHMM });
    const b = await run(easy, LATE, { windowMode, departHHMM, windowReach: true });
    assert.deepEqual(b.routes, a.routes, `${windowMode} ${departHHMM}`);
    assert.deepEqual(b.unassigned, a.unassigned);
  }
});

// ── Random boards: the guarantees, not one example ──
const TOWNS = [[34.207, -84.140], [34.298, -83.824], [34.185, -83.925], [34.109, -83.762], [34.117, -83.572], [34.204, -83.457], [33.951, -83.357], [33.992, -83.720], [33.795, -83.713], [33.839, -83.900], [33.956, -83.988], [34.003, -84.144], [34.075, -84.294], [34.023, -84.361], [34.237, -84.491], [34.421, -84.119], [34.533, -83.985], [33.597, -83.860], [33.668, -84.017], [33.857, -84.020], [34.013, -83.828]];
const WINS = [null, null, null, null, ['07:00', '12:00'], ['08:00', '14:00'], ['07:00', '15:30'], ['08:00', '17:00'], ['10:00', '11:00'], ['13:00', '15:00'], ['06:00', '08:30'], ['08:00', '10:00'], ['07:30', '08:15']];
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function board(seed) {
  const r = rng(seed); const nT = 1 + Math.floor(r() * 3); const n = 6 + Math.floor(r() * nT * 12);
  const stops = Array.from({ length: n }, (_, i) => { const [la, ln] = TOWNS[Math.floor(r() * TOWNS.length)]; return S(`B${i}`, la + (r() - 0.5) * 0.06, ln + (r() - 0.5) * 0.06, 1 + Math.floor(r() * 3), WINS[Math.floor(r() * WINS.length)]); });
  return { stops, trucks: Array.from({ length: nT }, (_, i) => box(`T${i}`)) };
}

test('NEVER WORSE, 40 random boards × 3 strategies × 08:00 and 12:10 × strict and advisory', async () => {
  let better = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const b = board(seed);
    for (const strategy of ['MIN_DISTANCE', 'CLOSEST_FIRST', 'FARTHEST_FIRST']) for (const departHHMM of ['08:00', '12:10']) {
      const tag = `seed ${seed} ${strategy} ${departHHMM}`;
      const so = await run(b.stops, b.trucks, { strategy, departHHMM, windowMode: 'strict' });
      const sn = await run(b.stops, b.trucks, { strategy, departHHMM, windowMode: 'strict', windowReach: true });
      assert.ok(late(sn) <= late(so), `${tag} strict: more late`);
      if (late(sn) === late(so)) {
        assert.ok(orders(sn) >= orders(so), `${tag} strict: ${orders(sn)} orders against ${orders(so)}`);
        if (orders(sn) === orders(so)) assert.ok(km(sn) <= km(so) + 1e-6, `${tag} strict: longer for the same orders`);
      }
      const ao = await run(b.stops, b.trucks, { strategy, departHHMM, windowMode: 'advisory' });
      const an = await run(b.stops, b.trucks, { strategy, departHHMM, windowMode: 'advisory', windowReach: true });
      assert.ok(late(an) <= late(ao), `${tag} advisory: ${late(an)} late against ${late(ao)}`);
      if (late(an) === late(ao)) assert.ok(km(an) <= km(ao) + 1e-6, `${tag} advisory: longer for the same misses`);
      if (orders(sn) > orders(so) || late(an) < late(ao)) better++;
    }
  }
  assert.ok(better > 0, 'it changed nothing for the better — the test no longer exercises it');
});

test('ADVISORY, one truck at 08:00 (board 12): the shut docks stop setting the run — one dock fewer missed and 150 km less', async () => {
  const b = board(12);
  const o = await run(b.stops, b.trucks, { windowMode: 'advisory' });
  const n = await run(b.stops, b.trucks, { windowMode: 'advisory', windowReach: true });
  assert.equal(late(o), 3);
  assert.equal(late(n), 2);
  assert.ok(km(n) < km(o) - 100, `${km(n).toFixed(0)} km against ${km(o).toFixed(0)}`);
  assert.equal(n.meta.windowReachUndone, undefined);
});

test('when the old Build is better, it ships — exactly — and the job says so', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const b = board(seed);
    for (const windowMode of ['strict', 'advisory']) for (const departHHMM of ['08:00', '12:10']) {
      const r = await run(b.stops, b.trucks, { departHHMM, windowMode, windowReach: true });
      if (!r.meta.windowReachUndone) continue;
      const plain = await run(b.stops, b.trucks, { departHHMM, windowMode });
      assert.deepEqual(r.routes, plain.routes, 'the old plan, exactly');
      assert.deepEqual(r.unassigned, plain.unassigned);
      return;
    }
  }
  assert.fail('no board in 300 tripped the guard — the test no longer exercises it');
});

test('the switch is house shape, and the background hands it to the pipeline', () => {
  assert.equal(buildRules({}).windowReach, true);
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(buildRules({ ROUTING_BUILD_WINDOW_REACH: off }).windowReach, false, off);
  for (const on of ['of', 'yes', 'on', '1', 'maybe']) assert.equal(buildRules({ ROUTING_BUILD_WINDOW_REACH: on }).windowReach, true, on);
  const BG = readFileSync(new URL('../netlify/functions/routing-build-background.mts', import.meta.url), 'utf8');
  assert.ok(BG.includes('      windowReach: rules.windowReach,'), 'the Build does not pass the switch on');
});
