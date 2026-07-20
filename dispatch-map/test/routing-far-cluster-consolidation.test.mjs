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
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

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
function solve(cfg) {
  const { drivers, stops } = scenario();
  return solveAssignment({
    date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', cfg),
    cfg, depot: DEPOT, serviceMedianFor: () => 12,
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

test('far-zone cohesion charges each extra driver in the same far zone', () => {
  // isolate cohesion by holding the PLAN fixed (a far zone split across 2 drivers)
  // and toggling only w_zone_cohesion — so nothing but the cohesion term moves.
  const cache = new Map();
  const mkInput = (cfg) => ({ date: '2026-07-16', stops: [], drivers: [], fleetChain: fleetTripChain([], '2026-07-16', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 12 });
  const a = farStop('a', null, 0), b = farStop('b', null, 1);
  const d1 = driver('D1'), d2 = driver('D2');
  const split = [{ driver: d1, trips: [{ stops: [a] }] }, { driver: d2, trips: [{ stops: [b] }] }];
  const withCohesion = planCost(split, mkInput({ ...CFG, w_zone_cohesion: 4 }), cache);
  const noCohesion = planCost(split, mkInput({ ...CFG, w_zone_cohesion: 0 }), cache);
  assert.ok(Math.abs((withCohesion - noCohesion) - 4) < 1e-9, `2 drivers in one far zone should cost +4 of cohesion (got ${withCohesion - noCohesion})`);
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
