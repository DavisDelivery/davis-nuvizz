// test/claude-shadow-backtest.test.mjs — A PAST DAY RE-PLANNED BY CLAUDE: THE RULES THE SCORE STANDS ON.
//
// Every test names the freight event it protects: skids read from pallets, a 53' sent to a dock it
// cannot enter, a stop delivered twice or not at all, a truck loaded past what it holds, a cap built
// from the future, and a comparison that flatters one side by measuring it differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBacktestProblem, evaluateAssignment, makeSequencer, measurePlan, compareBacktest, coLoad, capFor,
  blocksTractor, usableCoords, btBriefing, btLoopProblem, TRAILER_BLOCKER_KEYS, PROFILE_MAX_SKIDS, BT_SYSTEM, BT_TOOLS, mayLeaveUnplanned, PROFILE_MAX_LBS,
} from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { TRAILER_BLOCKER_KEYS as ENGINE_BLOCKERS } from '../netlify/functions/lib/routing-assignment-solver.mts';
import { DEFAULT_TRUCK_PROFILES } from '../netlify/functions/lib/truck-profiles.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';
import { DEFAULT_CEILINGS } from '../netlify/functions/lib/claude-shadow/settings-core.mts';

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
    notes: new Map(), depot: DEPOT, at: '2026-09-25T00:00:00Z', cfg: CFG, ...o,
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
  // HARD (the default, v1.75.0): your route cap of 10 holds. DULUTH ran 12.5 spots (2.5 of them on
  // a stop with no location, held back from the cap), so its cap reads 7.5 and dispatch's own load
  // reads as over on dispatch's side — the cap does not rise to meet it.
  const p = buildBacktestProblem(input({ caps }));
  const a = p.loads[0];
  assert.equal(a.route, 'DULUTH');
  assert.equal(a.cap, 7.5, 'your route cap (10), less the 2.5 held back for the unlocated stop');
  assert.match(a.capNote, /2\.5 of 10 held back/);
  assert.match(a.capNote, /dispatch delivered 12\.5 on a cap of 10 on 2026-09-23 .* over on dispatch's side; the cap holds/);
  assert.deepEqual(p.dispatchOver, { cap: 1, lbs: 0, capLearned: 0 });
  assert.equal(p.capMode, 'hard');
  const res = evaluateAssignment(p, { loads: [{ load: a.id, stops: p.stops.map((s) => s.id) }], unplanned: [] }, CFG, makeSequencer(p, CFG));
  assert.equal(res.ok, false);
  assert.ok(res.summary.hardViolations.some((v) => /over its cap: 20 of 7\.5/.test(v)));
  // Dispatch's own assignment is over that cap too — and the evaluator says so rather than hiding it.
  const own = evaluateAssignment(p, { loads: p.loads.map((l) => ({ load: l.id, stops: l.dispatch })), unplanned: [] }, CFG, makeSequencer(p, CFG));
  assert.ok(own.summary.hardViolations.some((v) => /over its cap: 10 of 7\.5/.test(v)), own.summary.hardViolations.join('; '));
  // RAISED (SHADOW_HARD_CAPS=off): the old rule — the cap rises to what dispatch delivered.
  const q = buildBacktestProblem(input({ caps, hardCaps: false }));
  assert.equal(q.loads[0].cap, 10, 'raised from 7.5 to 10');
  assert.equal(q.capMode, 'raised');
  assert.equal(q.ceilings, null, 'no ceilings under the old rule');
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

test('a cap below what dispatch actually loaded that day: HELD by default (dispatch reads over), RAISED to what ran only with hard caps off', () => {
  const caps = { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 6 } } };
  const p = buildBacktestProblem(input({ caps }));
  const g = p.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(g.cap, 6, 'your cap of 6 holds');
  assert.match(g.capNote, /dispatch delivered 10 on a cap of 6 on 2026-09-23 .* over on dispatch's side; the cap holds/);
  assert.equal(p.dispatchOver.cap, 1, 'past a cap you typed: an over that matters');
  assert.equal(p.dispatchOver.capLearned, 0);
  assert.match(p.approximations.find((a) => /Skid caps HOLD/.test(a)), /reads as over on dispatch's side: 1 past a ceiling, a cap you typed or a truck's rating\./);
  const q = buildBacktestProblem(input({ caps, hardCaps: false }));
  const h = q.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(h.cap, 10);
  assert.match(h.capNote, /raised from 6 to 10/);
  assert.ok(!q.approximations.some((a) => /HOLD/.test(a)));
});

// v1.75.0 — THE CEILINGS. Chad: "there are times where we can get 46 pallets on a truck but its when
// its certain very stackable freight like corregated boxes. So i like hard caps on even the learned
// behavior and a ui to adjust them all against their learned behaviors."
test('a LEARNED cap above the class ceiling is held to it; a cap a person set is that person\u2019s number and stands; off, no ceilings', () => {
  const trip = (n) => ({ route: 'GAINESVILLE', driver: 'Ben  Paintsil', stops: 4, skids: n, loose: 0, weight: 0, freightStops: 4, uncountedStops: 0, shared: false });
  const learned = (date, n) => ({ date, learnVersion: 2, roster: 'read', stampGate: 'applied', counts: {}, trips: [trip(n)] });
  const before = Array.from({ length: 25 }, (_, i) => learned(`2026-08-${String(i + 1).padStart(2, '0')}`, 41));
  // Ben drives a tractor (employees); the learned cap from history is 41 spots.
  const p = buildBacktestProblem(input({ learnDaysBefore: before }));
  const g = p.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(g.cls, 'tractor');
  assert.equal(g.cap, 37, 'learned 41, held to the default tractor ceiling 37');
  assert.match(g.capSource, /learned .* 41, held to the tractor ceiling 37/);
  assert.match(g.capNote, /^learned 41 held to the tractor ceiling 37/);
  assert.deepEqual(p.ceilings, { box_truck: 22, tractor: 37 });
  assert.deepEqual(p.capsHeld, { box_truck: { held: 0, of: 0 }, tractor: { held: 1, of: 1 } });
  assert.match(p.approximations.find((a) => /Skid caps HOLD/.test(a)), /box 22 spots, tractor 37.*on 1 of the 1 loads with a learned cap it was held/);
  // A ceiling of Chad's own replaces the default.
  const c = buildBacktestProblem(input({ learnDaysBefore: before, ceilings: { box_truck: 22, tractor: 46 } }));
  assert.equal(c.loads.find((l) => l.route === 'GAINESVILLE').cap, 41, 'ceiling 46: the learned 41 stands');
  // A cap Chad set for the DRIVER is his number for that driver's truck and is never held down — that
  // is how the 46-pallet corrugated day is allowed — and under the "tighter" rule it beats the learned
  // cap on the other side: typing a cap is how a learned one is corrected.
  const yours = buildBacktestProblem(input({ learnDaysBefore: before, caps: { drivers: { 'BEN PAINTSIL': { name: 'Ben Paintsil', cap: 46 } }, routes: {} } }));
  const y = yours.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(y.cap, 46);
  assert.match(y.capSource, /^your driver cap/);
  assert.ok(!/held to/.test(y.capSource));
  // A cap typed on a ROUTE pools every truck that runs it: it is held to the ceiling of the truck
  // that ran it that day (review, v1.75.0) — 46 typed for the corrugated trailer is 37 on this tractor.
  const onRoute = buildBacktestProblem(input({ learnDaysBefore: before, caps: { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 46 } } } }));
  const rt = onRoute.loads.find((l) => l.route === 'GAINESVILLE');
  assert.equal(rt.cap, 37);
  assert.match(rt.capSource, /your route cap \(your number, over the learned driver cap 41\) 46, held to the tractor ceiling 37 \(a route cap is held to the truck that runs it; type it on the driver to go past the ceiling\)/);
  assert.match(rt.capNote, /^your route cap 46 held to the tractor ceiling 37 — a route cap is held to the truck that runs it/);
  assert.deepEqual(onRoute.capsHeld.tractor, { held: 0, of: 0 }, 'a typed cap is not a learned one: "learned caps held" does not count it');
  // Hard caps off: no ceilings at all.
  const off = buildBacktestProblem(input({ learnDaysBefore: before, hardCaps: false }));
  assert.equal(off.loads.find((l) => l.route === 'GAINESVILLE').cap, 41);
  assert.equal(off.ceilings, null);
  // The defaults are the learned engine's own hard caps, pinned.
  const eng = effectiveEngineConfig(null, {});
  assert.deepEqual(DEFAULT_CEILINGS, { box_truck: eng.skid_cap_box_hard, tractor: eng.skid_cap_tractor_hard });
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

test('folding two trucks into one is refused when no driver could finish that day: drive + 15 min a stop against the shift, raised to what dispatch’s own truck took', () => {
  const cfg = { ...CFG, typical_shift_hours: 2 };
  // Room typed on the DRIVERS (a driver cap is that driver's truck and stands above the ceiling; a
  // route cap would be held to the box truck's 22), so the day is the only limit in play.
  const caps = { drivers: { 'BEN PAINTSIL': { name: 'Ben Paintsil', cap: 40 }, 'AARON MITCHELL': { name: 'Aaron Mitchell', cap: 40 } }, routes: {} };
  const p = buildBacktestProblem(input({ cfg, caps }));
  const seqr = makeSequencer(p, cfg);
  assert.equal(p.serviceMin, 15);
  assert.equal(p.shiftMin, 120);
  // Dispatch's own trucks never break their own day.
  const own = evaluateAssignment(p, { loads: p.loads.map((l) => ({ load: l.id, stops: l.dispatch })), unplanned: [] }, cfg, seqr);
  assert.ok(!own.summary.hardViolations.some((v) => /past its/.test(v)), own.summary.hardViolations.join('; '));
  for (const l of p.loads) if (l.maxMin > 120) assert.match(l.maxMinNote, /raised from 120 to \d+ min/);
  // Every stop on the box truck fits its skid cap but not its day.
  const box = p.loads.find((l) => l.cls !== 'tractor');
  const one = evaluateAssignment(p, { loads: [{ load: box.id, stops: p.stops.map((s) => s.id) }], unplanned: [] }, cfg, seqr);
  assert.ok(!one.summary.hardViolations.some((v) => /over its cap/.test(v)), 'room on the truck is not the problem');
  assert.match(one.summary.hardViolations.join(' '), new RegExp(`${box.driver} would work \\d+ min on ${box.id} .* past their \\d+-minute day`));
  assert.match(btBriefing(p), /day limit \(min\)/);
});

test('a driver on two loads has ONE day between them — the 2026-09-23 plan gave one driver 49 stops and 17.7 h across two', () => {
  const cfg = { ...CFG, typical_shift_hours: 4 };
  const caps = { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 60 }, DULUTH: { name: 'DULUTH', cap: 60 }, TRAILER: { name: 'TRAILER', cap: 60 } } };
  const rows = day();
  // Ben also ran a second load under another name that day.
  const extra = [row('TRAILER', 'Ben  Paintsil', north(7)), row('TRAILER', 'Ben  Paintsil', north(8))];
  const p = buildBacktestProblem(input({ rows: [...rows, ...extra], cfg, caps }));
  const bens = p.loads.filter((l) => l.driver.replace(/\s+/g, ' ') === 'Ben Paintsil');
  assert.equal(bens.length, 2);
  assert.equal(bens[0].maxMin, bens[1].maxMin, 'both loads carry the same driver limit');
  assert.match(btBriefing(p), /Drivers on more than one load \(ONE day between them\): Ben +Paintsil = L\d\+L\d/);
  const seqr = makeSequencer(p, cfg);
  // Dispatch's own day is never refused.
  const own = evaluateAssignment(p, { loads: p.loads.map((l) => ({ load: l.id, stops: l.dispatch })), unplanned: [] }, cfg, seqr);
  assert.ok(!own.summary.hardViolations.some((v) => /past their/.test(v)), own.summary.hardViolations.join('; '));
  // Put every stop on Ben's two loads: each load alone is under the limit, together they are not.
  const all = p.stops.map((s) => s.id);
  const half = Math.ceil(all.length / 2);
  const plan = { loads: [{ load: bens[0].id, stops: all.slice(0, half) }, { load: bens[1].id, stops: all.slice(half) }], unplanned: [] };
  const m = measurePlan(p, new Map(plan.loads.map((x) => [x.load, x.stops])), cfg, seqr);
  const perLoad = m.loads.map((l) => l.routeMin);
  assert.ok(perLoad.every((x) => x <= bens[0].maxMin), `each load alone fits: ${perLoad} vs ${bens[0].maxMin}`);
  const res = evaluateAssignment(p, plan, cfg, seqr);
  const hits = res.summary.hardViolations.filter((v) => /Ben +Paintsil would work \d+ min on L\d \+ L\d/.test(v));
  assert.equal(hits.length, 1, `one violation per driver, not per load: ${res.summary.hardViolations.join('; ')}`);
});

test('stop numbers say nothing about dispatch: the same stops carried on different trucks get the same numbers', () => {
  const a = buildBacktestProblem(input());
  const rows = day();
  // Move two stops between trucks: dispatch's grouping changes, the places do not.
  const as = (r, route, driver) => ({ ...r, routeName: route, loadNbr: route, driverName: driver, driverUserName: driver });
  const swapped = rows.map((r, i) => (i === 2 ? as(r, 'DULUTH', 'Aaron Mitchell') : i === 6 ? as(r, 'GAINESVILLE', 'Ben  Paintsil') : r));
  const b = buildBacktestProblem(input({ rows: swapped }));
  const numbering = (p) => Object.fromEntries(p.stops.map((s) => [s.n, s.id]));
  assert.notDeepEqual(a.loads.map((l) => l.dispatch.slice().sort()), b.loads.map((l) => l.dispatch.slice().sort()), 'the loads really differ');
  assert.deepEqual(numbering(b), numbering(a));
  assert.deepEqual(p1n(a), [...Array(a.stops.length)].map((_, i) => i + 1), 'ids are 1..N in table order');
});
const p1n = (p) => p.stops.map((s) => s.id);

test('a stop with no location still rode on its truck: its room is held back from the cap, and the load says so', () => {
  const p = buildBacktestProblem(input());
  const d = p.loads.find((l) => l.route === 'DULUTH');
  assert.equal(d.cap, 11.5, 'box truck 14 less the 2.5 spots of the unlocated stop');
  assert.match(d.capNote, /2\.5 of 14 held back for 1 stop on it with no location/);
});

test('the shadow’s trailer-blocker list and profile skid counts are the engine’s — a copy that drifts fails here', () => {
  assert.deepEqual([...TRAILER_BLOCKER_KEYS].sort(), [...ENGINE_BLOCKERS].sort());
  const byClass = Object.fromEntries(DEFAULT_TRUCK_PROFILES.map((t) => [/TRACTOR/.test(t.truckClass) ? 'tractor' : 'box_truck', t.maxSkids]));
  assert.deepEqual(PROFILE_MAX_SKIDS, byClass);
  const lbsByClass = Object.fromEntries(DEFAULT_TRUCK_PROFILES.map((t) => [/TRACTOR/.test(t.truckClass) ? 'tractor' : 'box_truck', t.maxWeightLbs]));
  assert.deepEqual(PROFILE_MAX_LBS, lbsByClass);
});

test('weight is a hard limit — the first production plan put 10,084 lb on a 10,000 lb box truck — but dispatch’s own load is never refused', () => {
  const caps = { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 40 }, DULUTH: { name: 'DULUTH', cap: 40 } } };
  const p = buildBacktestProblem(input({ caps }));
  const box = p.loads.find((l) => l.cls !== 'tractor');
  assert.equal(box.maxLbs, 9200, 'the 10,000 lb rating less the 800 lb of the unlocated stop that rode on it');
  // The limit is a number Chad typed, so a route reading 9,200 under a typed 10,000 says where the 800 went.
  assert.equal(box.lbsNote, '800 of 10000 lb held back for 1 stop on it with no location');
  assert.equal(p.loads.find((l) => l.cls === 'tractor').lbsNote, null, 'nothing held back, nothing raised: no note');
  const seqr = makeSequencer(p, CFG);
  const own = evaluateAssignment(p, { loads: p.loads.map((l) => ({ load: l.id, stops: l.dispatch })), unplanned: [] }, CFG, seqr);
  assert.ok(!own.summary.hardViolations.some((v) => /lb limit/.test(v)), own.summary.hardViolations.join('; '));
  // 8 stops of 800 lb = 6,400 lb fits a box; make them heavy and it does not.
  const heavyRows = day().map((r) => ({ ...r, weight: 1600 }));
  const hp = buildBacktestProblem(input({ caps, rows: heavyRows }));
  const hbox = hp.loads.find((l) => l.cls !== 'tractor');
  const res = evaluateAssignment(hp, { loads: [{ load: hbox.id, stops: hp.stops.map((s) => s.id) }], unplanned: [] }, CFG, makeSequencer(hp, CFG));
  assert.match(res.summary.hardViolations.join(' '), new RegExp(`${hbox.id} carries 12800 lb — over its 8400 lb limit`), 'rating less the 1,600 lb unlocated stop');
  // A truck dispatch loaded past its limit: HELD by default — the limit stays, dispatch reads over
  // on dispatch's side; RAISED to what it carried only with hard caps off.
  const over = day().map((r, i) => (i < 4 ? { ...r, weight: 3000 } : r));      // GAINESVILLE (Ben, tractor) 12,000; fine
  const overRows = over.map((r, i) => (i >= 4 && i < 8 ? { ...r, weight: 2600 } : r));
  const hp2 = buildBacktestProblem(input({ caps, rows: overRows }));
  const hbox2 = hp2.loads.find((l) => l.cls !== 'tractor');
  assert.equal(hbox2.maxLbs, 9200, 'the limit holds');
  assert.equal(hbox2.lbsNote, '800 of 10000 lb held back for 1 stop on it with no location; dispatch loaded 11200 lb against the 10000 lb limit on 2026-09-23 — over on dispatch\'s side; the limit holds');
  assert.deepEqual(hp2.dispatchOver, { cap: 0, lbs: 1, capLearned: 0 });
  assert.match(hp2.approximations.find((a) => /Weight limits/.test(a)), /HOLD.*\(1 on this day\)/);
  const op = buildBacktestProblem(input({ caps, rows: overRows, hardCaps: false }));
  const obox = op.loads.find((l) => l.cls !== 'tractor');
  assert.equal(obox.maxLbs, 10400);
  assert.equal(obox.lbsNote, `800 of 10000 lb held back for 1 stop on it with no location; raised from 9200 to 10400 lb — dispatch loaded that much on ${obox.route} / ${obox.driver} on 2026-09-23`);
});

test('coordinates: null, blank, 0,0 and out-of-range are not a place', () => {
  assert.equal(usableCoords(34.1, -83.9), true);
  assert.equal(usableCoords(null, -83.9), false);
  assert.equal(usableCoords('', ''), false);
  assert.equal(usableCoords(0, 0), false);
  assert.equal(usableCoords(91, 0), false);
  assert.equal(usableCoords('34.1', '-83.9'), true);
});

test('the sequencer does not depend on the machine: the same stops come back in the same order, however slow the clock', () => {
  seq = 0;
  // 30 stops scattered over the north metro on one truck: enough that the search has work to do.
  let x = 7;
  const rnd = () => ((x = (x * 48271) % 2147483647) / 2147483647);
  const rows = Array.from({ length: 30 }, () => row('HALL', 'Ann Lee', { lat: 34.0 + rnd() * 0.5, lng: -84.3 + rnd() * 0.6 }));
  const p = buildBacktestProblem({ ...input(), rows });
  const ids = p.stops.map((s) => s.id);
  const a = makeSequencer(p, CFG).order('L1', ids);
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + (skew += 5000);         // a machine so slow every clock read is 5 s later
  try {
    const b = makeSequencer(p, CFG).order('L1', ids);
    assert.deepEqual(b, a);
  } finally { Date.now = realNow; }
});

test('what the day could not tell is written on the result: no roster captured, and whether delivery stamps decided the day', () => {
  const p = buildBacktestProblem(input());
  assert.equal(p.roster, 'none');
  assert.ok(['applied', 'off'].includes(p.stampGate));
  assert.ok(p.approximations.some((a) => /load roster was not captured/.test(a)));
  assert.ok(p.approximations.some((a) => /15 min on site/.test(a)));
});

test('weight limits from Router settings: the problem is held to the typed limits, records them, and falls back to the profiles when they are missing or malformed', () => {
  const caps = { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 40 }, DULUTH: { name: 'DULUTH', cap: 40 } } };
  const dflt = buildBacktestProblem(input({ caps }));
  assert.deepEqual(dflt.lbsLimits, { box_truck: 10000, tractor: 30000 }, 'no settings: the engine\u2019s profiles');
  assert.match(dflt.approximations.find((a) => /Weight limits/.test(a)), /box 10,000 lb, tractor 30,000 lb/);
  const typed = buildBacktestProblem(input({ caps, lbsLimits: { box_truck: 12000, tractor: 26000 } }));
  assert.deepEqual(typed.lbsLimits, { box_truck: 12000, tractor: 26000 });
  const box = typed.loads.find((l) => l.cls !== 'tractor');
  assert.equal(box.maxLbs, 12000 - 800, 'the typed box limit, less the 800 lb of the unlocated stop that rode on it');
  assert.match(typed.approximations.find((a) => /Weight limits/.test(a)), /box 12,000 lb, tractor 26,000 lb/);
  const bad = buildBacktestProblem(input({ caps, lbsLimits: { box_truck: 0, tractor: 'x' } }));
  assert.deepEqual(bad.lbsLimits, { box_truck: 10000, tractor: 30000 }, 'a malformed limit is the default, never 0');
});

// v1.74.1. A limit typed under what dispatch loaded is raised to dispatch's own load on that truck,
// so on those loads it binds nothing — the result counts them, per class, and says so.
test('weight limits: a limit raised to dispatch\u2019s own load is counted per class and said in the approximations', () => {
  const caps = { drivers: {}, routes: {}, days: { count: 0, first: null, last: null } };
  const none = buildBacktestProblem(input({ caps, hardCaps: false }));
  assert.deepEqual(none.lbsRaised, { box_truck: { raised: 0, of: 1, heaviest: 0 }, tractor: { raised: 0, of: 1, heaviest: 0 } });
  assert.ok(!none.approximations.some((a) => /was raised on/.test(a)), 'nothing raised, nothing said');
  assert.ok(none.loads.every((l) => l.lbsRaisedFrom === null));
  // Box limit typed at 1,000 lb: the box load carried 3,200 lb located + 800 lb unlocated, so its
  // limit reads 200 after the hold-back and is raised to 3,200.
  const low = buildBacktestProblem(input({ caps, lbsLimits: { box_truck: 1000, tractor: 26000 }, hardCaps: false }));
  const box = low.loads.find((l) => l.cls !== 'tractor');
  assert.equal(box.lbsRaisedFrom, 200);
  assert.equal(box.maxLbs, 3200);
  assert.deepEqual(low.lbsRaised, { box_truck: { raised: 1, of: 1, heaviest: 3200 }, tractor: { raised: 0, of: 1, heaviest: 0 } });
  const said = low.approximations.find((a) => /was raised on/.test(a));
  assert.match(said, /^The box-truck limit of 1,000 lb was raised on 1 of 1 box-truck load to what dispatch loaded \(the heaviest to 3,200 lb\)/);
  assert.ok(!low.approximations.some((a) => /tractor limit of/.test(a)), 'the tractor limit was not raised, so no tractor sentence');
  // Hard (the default): nothing is raised; the limit of 1,000 holds and dispatch reads over.
  const hard = buildBacktestProblem(input({ caps, lbsLimits: { box_truck: 1000, tractor: 26000 } }));
  const hb = hard.loads.find((l) => l.cls !== 'tractor');
  assert.equal(hb.maxLbs, 200, '1,000 less the 800 held back');
  assert.equal(hb.lbsRaisedFrom, null);
  assert.deepEqual(hard.lbsRaised, { box_truck: { raised: 0, of: 1, heaviest: 0 }, tractor: { raised: 0, of: 1, heaviest: 0 } });
  assert.equal(hard.dispatchOver.lbs, 1);
  assert.ok(!hard.approximations.some((a) => /was raised on/.test(a)));
});

// v1.75.0 REVIEW — the fixes, each named for the day it protects.
test('a route cap typed for the corrugated trailer never briefs a 26′ box truck covering that route at 46 spots; a driver cap stands', () => {
  // Aaron Mitchell drives a BOX truck (no employees record → default) and runs DULUTH today.
  const typedRoute = buildBacktestProblem(input({ caps: { drivers: {}, routes: { DULUTH: { name: 'DULUTH', cap: 46 } } } }));
  const d = typedRoute.loads.find((l) => l.route === 'DULUTH');
  assert.equal(d.cls, 'box_truck');
  assert.equal(d.cap, 22 - 2.5, 'held to the box ceiling 22, less the ungeocoded stop’s room');
  assert.match(d.capNote, /your route cap 46 held to the box-truck ceiling 22/);
  const typedDriver = buildBacktestProblem(input({ caps: { drivers: { 'AARON MITCHELL': { name: 'Aaron Mitchell', cap: 30 } }, routes: {} } }));
  assert.equal(typedDriver.loads.find((l) => l.route === 'DULUTH').cap, 30 - 2.5, 'a cap typed on the driver is his truck: it stands above the ceiling');
});

test('dispatch past only its own learned cap (the 95th percentile — one load in twenty by design) is counted apart from a real over', () => {
  const trip = (n) => ({ route: 'DULUTH', driver: 'Aaron Mitchell', stops: 4, skids: n, loose: 0, weight: 0, freightStops: 4, uncountedStops: 0, shared: false });
  const learned = (date, n) => ({ date, learnVersion: 2, roster: 'read', stampGate: 'applied', counts: {}, trips: [trip(n)] });
  // Aaron's learned cap: 9 spots. On D he ran 10 + the held-back ungeocoded stop — past his own p95, under the box ceiling.
  const p = buildBacktestProblem(input({ learnDaysBefore: Array.from({ length: 25 }, (_, i) => learned(`2026-08-${String(i + 1).padStart(2, '0')}`, 9)) }));
  assert.equal(p.dispatchOver.capLearned, 1);
  assert.equal(p.dispatchOver.cap, 0, 'not past a ceiling, a typed cap or a rating — not an over that matters');
  assert.match(p.loads.find((l) => l.route === 'DULUTH').capNote, /over on dispatch's side \(past only that driver’s own learned cap\); the cap holds/);
  assert.match(p.approximations.find((a) => /Skid caps HOLD/.test(a)), /and 1 past only that driver's own learned cap \(the 95th percentile of their loads, so about one load in twenty sits above it\)/);
});

test('A DAY NO PLAN CAN SATISFY IS FOUND BEFORE ANY SPEND: the caps that hold carry fewer spots than must ride, or one stop fits no truck', async () => {
  const { feasibilityOf } = await import('../netlify/functions/lib/claude-shadow/backtest-core.mts');
  const tight = buildBacktestProblem(input({ caps: { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 5 }, DULUTH: { name: 'DULUTH', cap: 5 } } } }));
  assert.match(tight.infeasible, /the caps that hold carry 7\.5 skid spots and the stops that must ride need 20: no plan can put them all on a truck/);
  assert.equal(buildBacktestProblem(input()).infeasible, null, 'an ordinary day plans');
  assert.equal(buildBacktestProblem(input({ hardCaps: false, caps: { drivers: {}, routes: { GAINESVILLE: { name: 'GAINESVILLE', cap: 5 }, DULUTH: { name: 'DULUTH', cap: 5 } } } })).infeasible, null, 'hard caps off: caps are raised to what ran, so every day plans');
  // One stop bigger than the biggest truck.
  const stops = [{ id: 1, n: 'BIG', spots: 30, weight: 100, blocksTractor: false }];
  assert.match(feasibilityOf(stops, [{ cap: 22, maxLbs: 10000 }, { cap: 26, maxLbs: 30000 }]), /stop BIG \(30 skid spots, 100 lb\) fits on no truck/);
  // A no-tractor stop may be left off when no box truck has room, so it never makes a day infeasible.
  assert.equal(feasibilityOf([{ id: 1, n: 'NT', spots: 30, weight: 100, blocksTractor: true }], [{ cap: 22, maxLbs: 10000 }]), null);
  // Weight too.
  assert.match(feasibilityOf([{ id: 1, n: 'A', spots: 1, weight: 12000, blocksTractor: false }, { id: 2, n: 'B', spots: 1, weight: 12000, blocksTractor: false }], [{ cap: 22, maxLbs: 10000 }, { cap: 22, maxLbs: 10000 }]), /weight limits that hold carry 20,000 lb and the stops that must ride weigh 24,000 lb/);
});

test('SHADOW_HARD_CAPS=off puts the whole old cap rule back: with no ceilings, a typed cap no longer out-votes a smaller learned one', () => {
  const learned = { capUsed: 20, capSource: 'learned' }, typed = { capUsed: 46, capSource: 'yours' };
  assert.equal(capFor(learned, typed, 'tighter', 'box_truck', { box_truck: 22, tractor: 37 }).cap, 22, 'hard: typed route 46 wins, held to the box ceiling');
  const off = capFor(learned, typed, 'tighter', 'box_truck', null);
  assert.equal(off.cap, 20, 'off: the smaller binds, as before v1.75.0');
  assert.match(off.source, /tighter than the route's 46/);
});
