// Phase 2.2 — far-cluster consolidation. The per-stop assignment used to scatter
// a distant loop (e.g. SCOTT_HART's real 13-15 stop NW run, all 48-75 mi out)
// across every driver who "owned" one of those customers by habit — dragging
// mid/near-ring trucks 60+ mi out for a few stops each. These tests pin the new
// objective terms that give the solver the missing concept of the marginal cost
// of an extra truck reaching a far corner: a per-shift far-deadhead reach charge,
// a habit discount for far stops, and a far-zone cohesion penalty.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveAssignment, shiftCost, planCost,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain, zoneOwnersAsOf } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { toAssignStop } from '../netlify/functions/lib/routing-plan-core.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.148, lng: -83.959 };

// ample capacity so nothing is FORCED to split — we test that the engine CHOOSES
// to consolidate, not that a ceiling makes it.
const ENV = () => ({
  driver_key: '', source: 'driver', truck_class: 'box_truck', observed_days: 20,
  per_trip: { stops_median: 14, stops_p85: 18, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: 12000, weight_max: 12000 },
  trips_per_day_propensity: 0.2, start_minute_typical: 240, shift_hours_typical: 12, day_weight_p85: 40000,
});
const driver = (key) => ({ driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck', start_minute: 240, envelope: { ...ENV(), driver_key: key }, affinity: new Map() });

// A far stop clustered around Calhoun (~60mi NW); miles is set explicitly (the
// solver reads s.miles directly). habit points at `habitDrv` so the OLD engine
// would pull that driver out to serve it.
function farStop(id, habitDrv, i = 0) {
  return {
    id, lat: 34.50 + i * 0.002, lng: -84.95 + i * 0.002, zone: `FARZ${i}`, gh5: 'FAR',
    pallets: 2, weight: 500, matchKey: id, strict: false, miles: 60, blocksTractor: false,
    habit: habitDrv ? { topDriver: habitDrv, topShare: 0.9, n: 30 } : null,
  };
}
function nearStop(id, habitDrv, i = 0) {
  return {
    id, lat: 34.16 + i * 0.002, lng: -83.98 + i * 0.002, zone: `NEARZ${i}`, gh5: 'NEAR',
    pallets: 2, weight: 500, matchKey: id, strict: false, miles: 10, blocksTractor: false,
    habit: habitDrv ? { topDriver: habitDrv, topShare: 0.9, n: 30 } : null,
  };
}

const DRIVERS = ['D1', 'D2', 'D3', 'D4'];
function scenario() {
  const drivers = DRIVERS.map(driver);
  const stops = [];
  // each driver gets its own near work…
  for (let i = 0; i < 8; i++) stops.push(nearStop(`n${i}`, DRIVERS[i % 4], i));
  // …and a far NW cluster whose customers are each "owned" by a different driver
  for (let i = 0; i < 10; i++) stops.push(farStop(`f${i}`, DRIVERS[i % 4], i));
  return { drivers, stops };
}
function solve(cfg, zoneOwners) {
  const { drivers, stops } = scenario();
  return solveAssignment({
    date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', cfg),
    cfg, depot: DEPOT, serviceMedianFor: () => 12, zoneOwners,
  });
}
// how many distinct drivers the plan sends into the far cluster
function farDriverCount(res) {
  const set = new Set();
  for (const sh of res.shifts) for (const t of sh.trips) for (const s of t.stops) if (s.miles > 45) set.add(sh.driver.driver_key);
  return set.size;
}

test('the far cluster consolidates onto one (or two) trucks instead of scattering', () => {
  const res = solve(CFG);
  const far = farDriverCount(res);
  assert.ok(far <= 2, `far NW cluster should ride on ≤2 trucks, got ${far}`);
});

test('disabling the Phase 2.2 terms brings the scatter back (the terms are what consolidates)', () => {
  const off = { ...CFG, w_far_deadhead: 0, habit_far_discount: 1, w_zone_cohesion: 0 };
  const scattered = farDriverCount(solve(off));
  const consolidated = farDriverCount(solve(CFG));
  assert.ok(scattered >= 3, `with the terms off, per-customer habit scatters the far loop (got ${scattered})`);
  assert.ok(consolidated < scattered, `Phase 2.2 must reduce far-cluster trucks (${consolidated} vs ${scattered})`);
});

test('far-deadhead reach is charged once, on the driver’s farthest stop', () => {
  const cache = new Map();
  const mkInput = (cfg) => ({ date: '2026-07-16', stops: [], drivers: [], fleetChain: fleetTripChain([], '2026-07-16', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 12 });
  const d = driver('D1');
  // identical stop, no habit, only the `miles` field differs (44 = under the 45
  // threshold, 60 = over) — so the ONLY cost delta is the reach term.
  const near = { id: 'x', lat: 34.50, lng: -84.95, zone: 'Z', gh5: 'G', pallets: 2, weight: 500, matchKey: 'x', strict: false, miles: 44, blocksTractor: false, habit: null };
  const far = { ...near, miles: 60 };
  const cNear = shiftCost({ driver: d, trips: [{ stops: [near] }] }, mkInput(CFG), cache);
  const cFar = shiftCost({ driver: d, trips: [{ stops: [far] }] }, mkInput(CFG), cache);
  const expected = CFG.w_far_deadhead * ((60 - 45) / 10); // 6 × 1.5 = 9
  assert.ok(Math.abs((cFar - cNear) - expected) < 1e-9, `reach delta ${cFar - cNear} should equal ${expected}`);
});

test('far-zone cohesion charges each extra driver, scaled by how far out the zone is', () => {
  // isolate cohesion by holding the PLAN fixed (a far zone split across 2 drivers)
  // and toggling only w_zone_cohesion — so nothing but the cohesion term moves.
  // 2.4.0: the charge scales with maxMiles/threshold (ends of the roads get the
  // fewest trucks): stops at 60 mi with threshold 45 → factor 60/45.
  const cache = new Map();
  const mkInput = (cfg) => ({ date: '2026-07-16', stops: [], drivers: [], fleetChain: fleetTripChain([], '2026-07-16', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 12 });
  const a = farStop('a', null, 0), b = farStop('b', null, 1);
  const d1 = driver('D1'), d2 = driver('D2');
  const split = [{ driver: d1, trips: [{ stops: [a] }] }, { driver: d2, trips: [{ stops: [b] }] }];
  const withCohesion = planCost(split, mkInput({ ...CFG, w_zone_cohesion: 4 }), cache);
  const noCohesion = planCost(split, mkInput({ ...CFG, w_zone_cohesion: 0 }), cache);
  const expected = 4 * (60 / CFG.far_deadhead_mi); // farStop miles=60
  assert.ok(Math.abs((withCohesion - noCohesion) - expected) < 1e-9, `2 drivers in one 60-mi zone should cost +${expected} of cohesion (got ${withCohesion - noCohesion})`);
  // deeper zone → strictly pricier second truck
  const deepA = { ...a, miles: 90 }, deepB = { ...b, miles: 90 };
  const deepSplit = [{ driver: d1, trips: [{ stops: [deepA] }] }, { driver: d2, trips: [{ stops: [deepB] }] }];
  const deepCost = planCost(deepSplit, mkInput({ ...CFG, w_zone_cohesion: 4 }), cache) - planCost(deepSplit, mkInput({ ...CFG, w_zone_cohesion: 0 }), cache);
  assert.ok(deepCost > withCohesion - noCohesion + 1e-9, 'a second truck 90 mi out costs more than one 60 mi out');
});

test('one-stop far stragglers fold onto the zone owner (fewest trucks at the end of the road)', () => {
  // The production pattern: an owner carries the far loop; ONE far stop sits on
  // another truck. Under the 2.1.1 weight ceiling, folding it re-split the
  // owner's trip (+w_trips + overload), which used to tie the trade and leave
  // the straggler alive; distance-scaled cohesion (8 × 62/45 ≈ 11) + ownership
  // (10) decisively win (and the 2.8.0 skid cap doesn't bind at 14 skid-eq).
  const owners = new Map([['FARZ', { owners: new Set(['OWN']), n: 300 }]]);
  const mkEnv = (p85, day) => ({ driver_key: '', source: 'driver', truck_class: 'box_truck', observed_days: 20,
    per_trip: { stops_median: 10, stops_p85: 14, pallets_median: 8, pallets_p85: 12, weight_median: 5000, weight_p85: p85, weight_max: p85 },
    trips_per_day_propensity: 0, start_minute_typical: 240, shift_hours_typical: 10, day_weight_p85: day });
  const mkDriver = (key, p85, day) => ({ driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck', start_minute: 240, envelope: { ...mkEnv(p85, day), driver_key: key }, affinity: new Map() });
  const farS = (id, habitDrv) => ({ id, lat: 34.60, lng: -84.95, zone: 'FARZ1', gh5: 'FAR', pallets: 2, weight: 1200, matchKey: id,
    strict: false, miles: 62, blocksTractor: false, habit: habitDrv ? { topDriver: habitDrv, topShare: 0.9, n: 30 } : null });
  const nearS = (id) => ({ id, lat: 34.16, lng: -83.98, zone: 'NEARZ1', gh5: 'NEAR', pallets: 2, weight: 1000, matchKey: id, strict: false, miles: 9, blocksTractor: false, habit: null });
  const drivers = [mkDriver('OWN', 6000, 12000), mkDriver('OTHER', 9000, 20000), mkDriver('N2', 9000, 20000)];
  const stops = [
    ...Array.from({ length: 5 }, (_, i) => farS(`f${i}`, 'OWN')),  // fills OWN's trip ceiling exactly
    farS('straggler', 'OTHER'),                                     // habit pulls it to the other truck
    ...Array.from({ length: 6 }, (_, i) => nearS(`n${i}`)),
  ];
  const res = solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 12, zoneOwners: owners });
  const farDrv = new Set();
  for (const sh of res.shifts) for (const t of sh.trips) for (const s of t.stops) if (s.miles > 45) farDrv.add(sh.driver.driver_key);
  assert.deepEqual([...farDrv], ['OWN'], `the far zone must ride on ONE truck (the owner), got ${[...farDrv]}`);
});

// ── Phase 2.3: learned territory ownership ───────────────────────────────────
// The real case: Dalton/Chatsworth is 97% SCOTT_HART + VICTOR_FERNANDEZ +
// CHE_ROBERTS in dispatch history, yet the engine handed its stops to drivers
// with ZERO presence there. Ownership is mined from references (< D) and a far
// stop outside its zone's owner set is charged w_zone_owner.

function refRoute(date, driver, zone, stops = 10) {
  return {
    tenant: 'davis', date, load_key: `L_${driver}_${date}`, driver_name: driver, driver_user_name: driver,
    truck_class: 'box_truck', warehouse: 'G6', stop_count: stops, source_seq: 'planned',
    zone_seq: [zone], stops: Array.from({ length: stops }, (_, i) => ({ zone: `${zone}${i % 3}` })), updated_at: '',
  };
}
const PREC = { zone_precision: 6, super_precision: 5, top_precision: 4 };

test('zoneOwnersAsOf: mines owners by share, honors min_obs/min_share, never leaks >= D', () => {
  const cfg = { ...CFG, zone_owner_min_obs: 25, zone_owner_min_share: 0.10 };
  const refs = [
    // FARZ zone: D1 60 stops, D2 30, D3 5 (5%: below the share floor)
    ...['2026-07-01', '2026-07-02', '2026-07-03'].flatMap((d) => [
      refRoute(d, 'D1', 'FARZ', 20), refRoute(d, 'D2', 'FARZ', 10),
    ]),
    refRoute('2026-07-05', 'D3', 'FARZ', 5),
    // THINZ zone: only 10 stops total — below min_obs, no owner set forms
    refRoute('2026-07-05', 'D4', 'THIN', 10),
    // a HUGE future route by D4 into FARZ that must NOT leak into ownership
    refRoute('2026-07-16', 'D4', 'FARZ', 500),
  ];
  const owners = zoneOwnersAsOf(refs, '2026-07-16', PREC, cfg);
  const farz = owners.get('FARZ');
  assert.ok(farz, 'FARZ has an owner set');
  assert.deepEqual([...farz.owners].sort(), ['D1', 'D2'], 'owners are the drivers with >=10% share; D3 (5%) excluded');
  assert.equal(farz.n, 95, 'only < D stops counted (the future 500 never leak)');
  assert.ok(!owners.has('THIN'), 'a thin zone below min_obs stays open');
});

test('territory ownership: far stops land ONLY on the learned owners, even against habit', () => {
  // habit points each far stop at a different driver (D1..D4), but the zone's
  // learned owners are D1+D2 — the engine must keep all far stops on them.
  const owners = new Map([['FARZ', { owners: new Set(['D1', 'D2']), n: 95 }]]);
  const res = solve(CFG, owners);
  const farDrv = new Set();
  for (const sh of res.shifts) for (const t of sh.trips) for (const s of t.stops) if (s.miles > 45) farDrv.add(sh.driver.driver_key);
  assert.ok([...farDrv].every((d) => d === 'D1' || d === 'D2'), `far stops must stay on the owners, got ${[...farDrv]}`);
});

test('open territory (no owner set) behaves exactly as before — Atlanta stays flexible', () => {
  const withEmpty = solve(CFG, new Map());
  const without = solve(CFG, undefined);
  const sig = (r) => r.shifts.map((sh) => `${sh.driver.driver_key}:${sh.trips.map((t) => t.stops.map((s) => s.id).sort().join(',')).join('|')}`).sort().join(';');
  assert.equal(sig(withEmpty), sig(without), 'an empty owner map must not change the plan');
});

test('an ISOLATED far stop (own gh5 cell, same area) still folds — cohesion is area-level', () => {
  // The production NW straggler that survived 2.4.0: its stop sat alone in its
  // own gh5 cell, so gh5-keyed cohesion saw "one driver in this cell" and never
  // charged the extra truck. Cohesion now keys on the TOP zone (area), so a
  // lone stop 3 cells over from the owner's loop still counts as the same far
  // area and the straggler truck pays for entering it.
  const owners = new Map([['FARZ', { owners: new Set(['OWN']), n: 300 }]]);
  const mkEnv = (p85, day) => ({ driver_key: '', source: 'driver', truck_class: 'box_truck', observed_days: 20,
    per_trip: { stops_median: 10, stops_p85: 14, pallets_median: 8, pallets_p85: 12, weight_median: 5000, weight_p85: p85, weight_max: p85 },
    trips_per_day_propensity: 0, start_minute_typical: 240, shift_hours_typical: 10, day_weight_p85: day });
  const mkDriver = (key, p85, day) => ({ driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck', start_minute: 240, envelope: { ...mkEnv(p85, day), driver_key: key }, affinity: new Map() });
  const drivers = [mkDriver('OWN', 6000, 12000), mkDriver('OTHER', 9000, 20000), mkDriver('N2', 9000, 20000)];
  const stops = [
    // the owner's loop: all in gh5 'FARZA'
    ...Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, lat: 34.60, lng: -84.95, zone: 'FARZA', gh5: 'FARZA', pallets: 2, weight: 1200, matchKey: `f${i}`, strict: false, miles: 62, blocksTractor: false, habit: { topDriver: 'OWN', topShare: 0.9, n: 30 } })),
    // the isolated stop: DIFFERENT gh5 ('FARZQ'), same top-4 area ('FARZ'), habit pulls elsewhere
    { id: 'isolated', lat: 34.47, lng: -84.70, zone: 'FARZQ', gh5: 'FARZQ', pallets: 2, weight: 1200, matchKey: 'isolated', strict: false, miles: 55, blocksTractor: false, habit: { topDriver: 'OTHER', topShare: 0.9, n: 30 } },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, lat: 34.16, lng: -83.98, zone: `NEARZ${i}`, gh5: 'NEAR', pallets: 2, weight: 1000, matchKey: `n${i}`, strict: false, miles: 9, blocksTractor: false, habit: null })),
  ];
  const res = solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 12, zoneOwners: owners });
  const farDrv = new Set();
  for (const sh of res.shifts) for (const t of sh.trips) for (const s of t.stops) if (s.miles > 45) farDrv.add(sh.driver.driver_key);
  assert.deepEqual([...farDrv], ['OWN'], `the isolated stop must fold onto the area owner, got ${[...farDrv]}`);
});

// Regression (found in production, engine 2.3.0 no-op): AssignStop.miles was
// seeded from NuVizz stopDistance — the LEG distance from the previous stop, a
// few miles even in Dalton — so `miles > far_deadhead_mi` was false for nearly
// every far-cluster stop and EVERY per-stop far test (territory ownership, the
// far-habit discount, zone cohesion) silently no-opped. The 2.3.0 replay came
// back byte-identical in the NW corner because of this. miles must be the
// computed DEPOT distance, never stopDistance.
test('the stop mapping computes miles as DEPOT distance, never NuVizz stopDistance', () => {
  // Behavioural now, not a source grep: feed the ONE shared mapper a row whose
  // stopDistance (the vendor's LEG distance from the previous stop) disagrees
  // wildly with the truth, and prove the mapping ignores it. A Dalton stop reads
  // ~3 mi from the last Dalton stop and ~63 from Buford; taking the vendor's
  // number is what silently no-opped every far test in engine 2.3.0.
  const dalton = {
    stopNbr: 'D1', lat: 34.77, lng: -84.97, stopDistance: 3.1,
    cartons: 4, volume: 0, pallets: 4, weight: 900, timeConstraint: null,
  };
  const mapped = toAssignStop(dalton, {
    id: 'D1', matchKey: null, cfg: CFG,
    precisions: { zone_precision: CFG.zone_precision, super_precision: CFG.super_precision, top_precision: CFG.top_precision },
    habitDocByKey: new Map(), notesRestrictions: new Map(), date: '2026-07-16',
  });
  assert.ok(mapped.miles > 55, `Dalton must read as far from the depot, got ${mapped.miles}`);
  assert.ok(Math.abs(mapped.miles - 3.1) > 50, 'the vendor leg distance must not leak into miles');
  assert.ok(mapped.miles > CFG.far_deadhead_mi, 'and it must clear the far threshold the per-stop far rules gate on');
});

test('the stop mapping reads the NuVizz freight columns by their REAL meaning', () => {
  // NuVizz mislabels: "cartons" is the skid count, "volume" is loose pieces,
  // "pallets" is the total. Reading the wrong column mis-sizes every truck.
  const mapped = toAssignStop(
    { stopNbr: 'S1', lat: 34.1, lng: -84.0, cartons: 7, volume: 20, pallets: 27, weight: 2100, timeConstraint: 'STRICT' },
    { id: 'S1', matchKey: null, cfg: CFG,
      precisions: { zone_precision: CFG.zone_precision, super_precision: CFG.super_precision, top_precision: CFG.top_precision },
      habitDocByKey: new Map(), notesRestrictions: new Map(), date: '2026-07-16' });
  assert.equal(mapped.skids, 7, 'skids come from cartons');
  assert.equal(mapped.loose, 20, 'loose comes from volume');
  assert.equal(mapped.pallets, 27, 'pallets is the total-pieces column');
  assert.equal(mapped.strict, true);
});

test('the stop mapping rejects a coordinate-less stop instead of placing it at 0,0', () => {
  // Number(null) is 0 and 0 is finite — the guard must read the RAW value.
  const prec = { zone_precision: CFG.zone_precision, super_precision: CFG.super_precision, top_precision: CFG.top_precision };
  const opts = { id: 'X', matchKey: null, cfg: CFG, precisions: prec, habitDocByKey: new Map(), notesRestrictions: new Map(), date: '2026-07-16' };
  for (const bad of [{ lat: null, lng: null }, { lat: '', lng: '' }, { lat: 34.1, lng: undefined }, { lat: 'abc', lng: -84 }]) {
    assert.equal(toAssignStop({ stopNbr: 'X', ...bad }, opts), null, `must reject ${JSON.stringify(bad)}`);
  }
  assert.ok(toAssignStop({ stopNbr: 'X', lat: 34.1, lng: -84.0 }, opts), 'a real pair still maps');
});

test('near-depot assignments are untouched by the far terms (no regression on normal work)', () => {
  const cache = new Map();
  const input = { date: '2026-07-16', stops: [], drivers: [], fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 12 };
  const d = driver('D1');
  const near = { id: 'x', lat: 34.16, lng: -83.98, zone: 'Z', gh5: 'G', pallets: 2, weight: 500, matchKey: 'x', strict: false, miles: 10, blocksTractor: false, habit: { topDriver: 'D2', topShare: 0.9, n: 30 } };
  const withTerms = shiftCost({ driver: d, trips: [{ stops: [near] }] }, input, cache);
  const off = { ...input, cfg: { ...CFG, w_far_deadhead: 0, habit_far_discount: 1, w_zone_cohesion: 0 } };
  const without = shiftCost({ driver: d, trips: [{ stops: [near] }] }, off, cache);
  assert.ok(Math.abs(withTerms - without) < 1e-9, 'a 10-mi stop must cost the same with or without the far terms');
});
