// test/claude-shadow-backtest.test.mjs — A PAST DAY RE-PLANNED BY CLAUDE: THE RULES THE SCORE STANDS ON.
//
// Every test names the freight event it protects: skids read from pallets, a 53' sent to a dock it
// cannot enter, a stop delivered twice or not at all, a truck loaded past what it holds, a cap built
// from the future, and a comparison that flatters one side by measuring it differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBacktestProblem, evaluateAssignment, makeSequencer, measurePlan, compareBacktest, coLoad, capFor,
  blocksTractor, usableCoords, btBriefing, btLoopProblem, TRAILER_BLOCKER_KEYS, PROFILE_MAX_SKIDS, BT_SYSTEM, BT_TOOLS, mayLeaveUnplanned,
} from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { TRAILER_BLOCKER_KEYS as ENGINE_BLOCKERS } from '../netlify/functions/lib/routing-assignment-solver.mts';
import { DEFAULT_TRUCK_PROFILES } from '../netlify/functions/lib/truck-profiles.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';

const D = '2026-09-23';
const CFG = { ...effectiveEngineConfig(null, {}), solver_ms_cap: 200 };
const DEPOT = { lat: 34.14838, lng: -83.95948 };

// Stops a mile or two apart north (GAINESVILLE) and south (DULUTH) of the terminal.
const north = (i) => ({ lat: 34.29 + i * 0.01, lng: -83.82 - i * 0.004 });
const south = (i) => ({ lat: 34.00 - i * 0.01, lng: -84.14 + i * 0.004 });
let seq = 0;
const row = (route, driver, pt, o = {}) => ({
  stopNbr: `S${String(++seq).padStart(3, '0')}`, stopType: 'DO', status: '90', normalizedStatus: 'DELIVERED', isPlanned: true,
  routeName: route, loadNbr: route, driverName: driver, driverUserName: driver,
  cartons: 2, volume: 5, weight: 800, routeSeq: seq, deliveredDTTM: `${D}T1${seq % 10}:00:00`, listUpdatedDTTM: `${D}T18:00:00`,
  zip: '30501', city: 'GAINESVILLE', customerMatchKey: `CUST${seq}`, businessName: `CUSTOMER ${seq}`, lat: pt.lat, lng: pt.lng, ...o,
});

function day() {
  seq = 0;
  // Dispatch sent one truck NORTH and one SOUTH but CROSSED them: each carries two stops from the other area.
  const rows = [
    row('GAINESVILLE', 'Ben  Paintsil', north(0)), row('GAINESVILLE', 'Ben  Paintsil', north(1)),
    row('GAINESVILLE', 'Ben  Paintsil', south(0)), row('GAINESVILLE', 'Ben  Paintsil', south(1)),
    row('DULUTH', 'Aaron Mitchell', south(2)), row('DULUTH', 'Aaron Mitchell', south(3)),
    row('DULUTH', 'Aaron Mitchell', north(2)), row('DULUTH', 'Aaron Mitchell', north(3)),
    // A pickup, a never-left order and one delivered two days later — none rode on D.
    row('DULUTH', 'Aaron Mitchell', north(4), { stopType: 'PU' }),
    row('DULUTH', 'Aaron Mitchell', north(5), { status: '10', normalizedStatus: 'UNPLANNED' }),
    row('DULUTH', 'Aaron Mitchell', north(6), { deliveredDTTM: '2026-09-25T10:00:00' }),
    // Delivered on D but never geocoded: out of BOTH columns, and reported.
    row('DULUTH', 'Aaron Mitchell', { lat: null, lng: null }),
  ];
  return rows;
}

function input(o = {}) {
  return {
    date: D, rows: day(), roster: null, stamp: 'x', learnDaysBefore: [], caps: null, loosePerSkid: 10, capRule: 'tighter',
    employees: [{ vehicleType: 'tractor', fullName: 'Ben Paintsil' }],
    notes: new Map(), depot: DEPOT, at: '2026-09-25T00:00:00Z', ...o,
  };
}

test('the day is exactly what rode out on D: pickups, never-left and other-day orders are out; an ungeocoded stop is out of BOTH sides and reported', () => {
  const p = buildBacktestProblem(input());
  assert.equal(p.stops.length, 8);
  assert.equal(p.loads.length, 2);
  assert.equal(p.excluded.noCoords.length, 1);
  assert.equal(p.loads.reduce((a, l) => a + l.dispatch.length, 0), 8);
});

test('skids come from cartons and loose pieces from volume — never pallets — and spots = skids + loose ÷ the ratio', () => {
  const p = buildBacktestProblem(input({ rows: day().map((r) => ({ ...r, pallets: 99 })) }));
  const s = p.stops[0];
  assert.equal(s.skids, 2);
  assert.equal(s.loose, 5);
  assert.equal(s.spots, 2.5);
});

test('truck class comes from the DRIVER’s MarginIQ vehicle type, not the load name; an unknown driver is a box truck and says so', () => {
  const p = buildBacktestProblem(input());
  const ben = p.loads.find((l) => l.driver.startsWith('Ben'));
  const aaron = p.loads.find((l) => l.driver.startsWith('Aaron'));
  assert.equal(ben.cls, 'tractor');
  assert.equal(ben.clsSource, 'roster');
  assert.equal(aaron.cls, 'box_truck');
  assert.equal(aaron.clsSource, 'default');
});

test('a no-tractor stop on a tractor load is a HARD violation; green clears an auto-detected blocker; red blocks', () => {
  assert.equal(blocksTractor({ equipment_restrictions: ['no_53'] }), true);
  assert.equal(blocksTractor({ equipment_restrictions: ['no_53'], vehicle_eligibility: 'tractor' }), false, 'green wins');
  assert.equal(blocksTractor({ vehicle_eligibility: 'box_only' }), true, 'red forces a box truck');
  assert.equal(blocksTractor(null), false);
  const rows = day();
  const notes = new Map([[rows[0].customerMatchKey, { equipment_restrictions: ['box_truck_only'] }]]);
  const p = buildBacktestProblem(input({ rows, notes }));
  const ben = p.loads.find((l) => l.cls === 'tractor');
  const other = p.loads.find((l) => l.cls !== 'tractor');
  const res = evaluateAssignment(p, { loads: [{ load: ben.id, stops: p.stops.map((s) => s.id) }, { load: other.id, stops: [] }], unplanned: [] }, { ...CFG }, makeSequencer(p, CFG));
  assert.equal(res.ok, false);
  assert.ok(res.summary.hardViolations.some((v) => /no-tractor/.test(v)));
});

test('every stop rides exactly once or is listed unplanned: a missing stop, a stop on two loads and an unknown stop are each rejected', () => {
  const p = buildBacktestProblem(input());
  const [a, b] = p.loads;
  const seqr = makeSequencer(p, CFG);
  const ids = p.stops.map((s) => s.id);
  const missing = evaluateAssignment(p, { loads: [{ load: a.id, stops: ids.slice(1) }], unplanned: [] }, CFG, seqr);
  assert.equal(missing.ok, false);
  assert.match(missing.summary.hardViolations.join(' '), /on no load/);
  const twice = evaluateAssignment(p, { loads: [{ load: a.id, stops: ids }, { load: b.id, stops: [ids[0]] }], unplanned: [] }, CFG, seqr);
  assert.match(twice.summary.hardViolations.join(' '), /is on L\d and L\d/);
  const unknown = evaluateAssignment(p, { loads: [{ load: a.id, stops: [...ids, 999] }], unplanned: [] }, CFG, seqr);
  assert.match(unknown.summary.hardViolations.join(' '), /unknown stop 999/);
  const both = evaluateAssignment(p, { loads: [{ load: a.id, stops: ids }], unplanned: [{ stop: ids[0], reason: 'x' }] }, CFG, seqr);
  assert.match(both.summary.hardViolations.join(' '), /also listed unplanned/);
});

test('dropping freight is never a saving: a delivered stop a load can carry may not be left unplanned; only a no-tractor stop that rode a tractor may, and only with a reason', () => {
  const rows = day();
  const notes = new Map([[rows[0].customerMatchKey, { equipment_restrictions: ['box_truck_only'] }]]);
  const p = buildBacktestProblem(input({ rows, notes }));
  const seqr = makeSequencer(p, CFG);
  const blocked = p.stops.find((s) => s.n === rows[0].stopNbr).id;       // box-only, and dispatch sent it on Ben's tractor
  const plain = p.stops.find((s) => s.n === rows[4].stopNbr).id;         // an ordinary stop on the box truck
  assert.deepEqual([...mayLeaveUnplanned(p)], [blocked]);
  const dispatchMinus = (drop) => p.loads.map((l) => ({ load: l.id, stops: l.dispatch.filter((id) => !drop.includes(id)) }));
  // Leaving an ordinary delivered stop off would shorten Claude's miles by dropping freight — refused.
  const dropped = evaluateAssignment(p, { loads: dispatchMinus([blocked, plain]), unplanned: [{ stop: blocked, reason: 'box only, no box room' }, { stop: plain, reason: 'far' }] }, CFG, seqr);
  assert.equal(dropped.ok, false);
  assert.match(dropped.summary.hardViolations.join(' '), new RegExp(`stop ${plain} must be on a load`));
  assert.ok(!dropped.summary.hardViolations.some((v) => v.includes(`stop ${blocked} `)), 'the no-tractor stop that rode a tractor may be left');
  // The permitted one still needs a reason.
  const silent = evaluateAssignment(p, { loads: dispatchMinus([blocked]), unplanned: [{ stop: blocked, reason: '   ' }] }, CFG, seqr);
  assert.match(silent.summary.hardViolations.join(' '), /no reason/);
  const ok = evaluateAssignment(p, { loads: dispatchMinus([blocked]), unplanned: [{ stop: blocked, reason: 'box only; no box truck has room' }] }, CFG, seqr);
  assert.equal(ok.ok, true, JSON.stringify(ok.summary.hardViolations));
});

test('a load past its cap is rejected; putting every stop on one truck is over cap when the cap is the tighter learned number', () => {
  const caps = { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 10 }, DULUTH: { name: 'DULUTH', cap: 10 } } };
  const p = buildBacktestProblem(input({ caps }));
  const a = p.loads[0];
  assert.equal(a.cap, 10, 'your route cap binds (10 spots; the day put 4 × 2.5 = 10 on it)');
  const res = evaluateAssignment(p, { loads: [{ load: a.id, stops: p.stops.map((s) => s.id) }], unplanned: [] }, CFG, makeSequencer(p, CFG));
  assert.equal(res.ok, false);
  assert.ok(res.summary.hardViolations.some((v) => /over its cap: 20 of 10/.test(v)));
});

test('the cap rule: the tighter of driver and route binds by default; either can be chosen; no number at all falls back to the class profile', () => {
  const d = { capUsed: 18, capSource: 'yours' }, r = { capUsed: 21.3, capSource: 'learned' };
  assert.equal(capFor(d, r, 'tighter', 'box_truck').cap, 18);
  assert.equal(capFor(d, r, 'route', 'box_truck').cap, 21.3);
  assert.equal(capFor(d, r, 'driver', 'box_truck').cap, 18);
  assert.equal(capFor(null, null, 'tighter', 'tractor').cap, 28);
  assert.equal(capFor(null, null, 'tighter', 'box_truck').cap, 14);
  assert.match(capFor(null, null, 'tighter', 'box_truck').source, /profile/);
});

test('a cap below what dispatch actually loaded that day is raised to what ran, and the load says so', () => {
  const caps = { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 6 } } };
  const p = buildBacktestProblem(input({ caps }));
  const g = p.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(g.cap, 10);
  assert.match(g.capNote, /raised from 6 to 10/);
});

test('capacity is learned only from days BEFORE the backtest day — the future never sets a cap', () => {
  const trip = (n) => ({ route: 'GAINESVILLE', driver: 'Ben  Paintsil', stops: 4, skids: n, loose: 0, weight: 0, freightStops: 4, uncountedStops: 0, shared: false });
  const learned = (date, n) => ({ date, learnVersion: 2, roster: 'read', stampGate: 'applied', counts: {}, trips: [trip(n)] });
  const before = Array.from({ length: 25 }, (_, i) => learned(`2026-08-${String(i + 1).padStart(2, '0')}`, 12));
  const future = Array.from({ length: 25 }, (_, i) => learned(`2026-09-${String(24 + (i % 5)).padStart(2, '0')}`, 30));
  const p = buildBacktestProblem(input({ learnDaysBefore: [...before, ...future] }));
  const g = p.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(g.cap, 12, 'the 30-spot trips after D are not seen');
  assert.match(g.capSource, /learned/);
  assert.equal(p.capModel.days, 25);
});

test('the same loads under swapped names score co-load 100% — agreement is about which stops ride together, not what the truck is called', () => {
  const a = new Map([['L1', [1, 2, 3]], ['L2', [4, 5]]]);
  const b = new Map([['L2', [3, 2, 1]], ['L1', [5, 4]]]);
  assert.deepEqual(coLoad(a, b), { recall: 100, precision: 100, shared: 4 });
});

test('three columns on ONE yardstick: straightening the crossed loads saves miles; the same assignment re-sequenced is its own column', () => {
  const p = buildBacktestProblem(input());
  const northIds = p.stops.filter((s) => s.lat > 34.2).map((s) => s.id);
  const southIds = p.stops.filter((s) => s.lat < 34.1).map((s) => s.id);
  const ben = p.loads.find((l) => l.route === 'GAINESVILLE');
  const aaron = p.loads.find((l) => l.route === 'DULUTH');
  const plan = { loads: [{ load: ben.id, stops: northIds, why: 'north' }, { load: aaron.id, stops: southIds, why: 'south' }], unplanned: [] };
  const cmp = compareBacktest(p, plan, CFG, { perMile: null, perDriveHour: null });
  assert.ok(cmp.columns.claude.miles < cmp.columns.driven.miles, `claude ${cmp.columns.claude.miles} vs driven ${cmp.columns.driven.miles}`);
  assert.ok(cmp.vsDriven.miles.pct < 0);
  assert.equal(cmp.columns.claude.trucks, 2);
  assert.equal(cmp.agreement.stopsMoved, 4);
  assert.equal(cmp.costs.claude, null, 'no cost rate in the code → no dollar figure');
  const priced = compareBacktest(p, plan, CFG, { perMile: 2, perDriveHour: null });
  assert.equal(priced.costs.claude, Math.round(cmp.columns.claude.miles * 2 * 100) / 100);
});

test('the dispatch "as driven" column keeps the driven order; the re-sequenced column only re-orders — neither moves a stop between trucks', () => {
  const p = buildBacktestProblem(input());
  const assign = new Map(p.loads.map((l) => [l.id, l.dispatch]));
  const driven = measurePlan(p, assign, CFG, null);
  const reseq = measurePlan(p, assign, CFG, makeSequencer(p, CFG));
  assert.deepEqual(driven.loads.map((l) => l.order), p.loads.map((l) => l.dispatch));
  assert.deepEqual(reseq.loads.map((l) => l.order.slice().sort()), p.loads.map((l) => l.dispatch.slice().sort()));
  assert.ok(reseq.totals.miles <= driven.totals.miles + 0.1);
});

test('the briefing never carries the answer: no stop is tied to the load dispatch put it on', () => {
  const p = buildBacktestProblem(input());
  const text = btBriefing(p);
  for (const s of p.stops) assert.ok(!text.includes(s.n), `stop number ${s.n} is not shown (ids are 1..N)`);
  assert.ok(!/dispatch/i.test(text.split('STOPS:')[1]), 'the stop table has no dispatch column');
  const loop = btLoopProblem(p, CFG);
  assert.equal(loop.tools.length, 2);
  assert.ok(BT_TOOLS.every((t) => t.strict === true && t.input_schema.additionalProperties === false));
  assert.ok(BT_SYSTEM.length > 500);
});

test('the shadow’s trailer-blocker list and profile skid counts are the engine’s — a copy that drifts fails here', () => {
  assert.deepEqual([...TRAILER_BLOCKER_KEYS].sort(), [...ENGINE_BLOCKERS].sort());
  const byClass = Object.fromEntries(DEFAULT_TRUCK_PROFILES.map((t) => [/TRACTOR/.test(t.truckClass) ? 'tractor' : 'box_truck', t.maxSkids]));
  assert.deepEqual(PROFILE_MAX_SKIDS, byClass);
});

test('coordinates: null, blank, 0,0 and out-of-range are not a place', () => {
  assert.equal(usableCoords(34.1, -83.9), true);
  assert.equal(usableCoords(null, -83.9), false);
  assert.equal(usableCoords('', ''), false);
  assert.equal(usableCoords(0, 0), false);
  assert.equal(usableCoords(91, 0), false);
  assert.equal(usableCoords('34.1', '-83.9'), true);
});
