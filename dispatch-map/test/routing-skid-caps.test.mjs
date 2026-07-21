// test/routing-skid-caps.test.mjs
//
// Phase 2.8 — per-class skid caps. The freight study's capacity fact: a load
// binds on SKID POSITIONS by truck class (box p95=22, tractor p95=37 across 912
// real dispatch trips), not weight. These tests pin the skid-equivalent
// accounting (loose pieces share positions; pallets fallback for pre-capture
// rows), the class-capped splitter, and the seed's cap economics: a zone's
// overflow lands on the candidate cast's #2 driver (the corridor split dispatch
// actually runs) — while a FULL candidate still beats a non-candidate, because
// territory outranks capacity.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveAssignment, splitFarFirst, stopSkidEquiv, classCapsFor,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.148, lng: -83.959 };

const ENV = (cls, propensity = 0) => ({
  driver_key: '', source: 'driver', truck_class: cls, observed_days: 20,
  per_trip: { stops_median: 14, stops_p85: 18, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: 12000, weight_max: 12000 },
  trips_per_day_propensity: propensity, start_minute_typical: 240, shift_hours_typical: 12, day_weight_p85: 40000, day_skids_p85: null, day_loose_p85: null,
});
const driver = (key, { aff = 0, cls = 'box_truck', propensity = 0 } = {}) => ({
  driver_key: key, driver_user_name: key, driver_name: key, truck_class: cls, start_minute: 240,
  envelope: { ...ENV(cls, propensity), driver_key: key }, affinity: new Map(aff ? [['G', aff]] : []),
});
const stop = (id, over = {}) => ({ id, lat: 34.16, lng: -83.98, zone: 'Z', gh5: 'G', pallets: 1, skids: 1, loose: 0, weight: 300, matchKey: id, strict: false, miles: 8, blocksTractor: false, habit: null, ...over });
const solve = (stops, drivers) => solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 10 });
const tripsOf = (res, key) => { const sh = res.shifts.find((x) => x.driver.driver_key === key); return sh ? sh.trips.filter((t) => t.stops.length) : []; };
const eqOf = (t) => t.stops.reduce((a, s) => a + stopSkidEquiv(s, CFG), 0);

test('stopSkidEquiv: skids + loose/loose_per_skid; pallets fallback when the breakdown is missing', () => {
  assert.equal(stopSkidEquiv(stop('a', { skids: 5, loose: 20 }), CFG), 7, '5 skids + 20 loose @10/skid = 7 positions');
  assert.equal(stopSkidEquiv(stop('b', { skids: 0, loose: 100 }), CFG), 10, 'an all-loose Uline day still occupies floor');
  assert.equal(stopSkidEquiv(stop('c', { skids: 0, loose: 0, pallets: 7 }), CFG), 7, 'pre-capture rows count total pieces as positions');
});

test('classCapsFor: per-class caps; unknown class reads as box; hard can never invert below soft', () => {
  assert.deepEqual(classCapsFor('box_truck', CFG), { soft: 20, hard: 22 });
  assert.deepEqual(classCapsFor('tractor', CFG), { soft: 31, hard: 37 });
  assert.deepEqual(classCapsFor(null, CFG), { soft: 20, hard: 22 });
  assert.equal(classCapsFor('box_truck', { ...CFG, skid_cap_box_hard: 10 }).hard, 20, 'inverted config floors hard at soft');
});

test('splitFarFirst: splits at the skid cap, far-first, every trip within cap', () => {
  const s = (id, miles, skids) => stop(id, { miles, skids });
  const stops = [s('near', 5, 10), s('far', 50, 10), s('mid', 25, 10)]; // 30 eq > box hard 22
  const trips = splitFarFirst(stops, 22, CFG);
  assert.equal(trips.length, 2);
  assert.ok(trips[0].stops.some((x) => x.id === 'far'), 'farthest stop rides trip 1');
  for (const t of trips) assert.ok(eqOf(t) <= 22 + 1e-9);
  assert.equal(splitFarFirst(stops, 100, CFG).length, 1, 'single trip when under cap');
  // loose pieces count toward the cap: 100 loose (10 eq) + 15 skids = 25 > 22 → split
  assert.equal(splitFarFirst([stop('l', { skids: 0, loose: 100 }), stop('k', { skids: 15 })], 22, CFG).length, 2);
});

test('a full truck RELOADS its owner (2 trips) — overflow does NOT jump to the cast #2 (2.8.1)', () => {
  // D1 owns the zone; 15 two-skid stops = 30 eq — over one box load but under
  // two. Dispatch's answer to a full truck is a same-driver reload (85% of real
  // over-cap days: 73/86 box, 32/38 tractor), so ALL 30 eq stay on D1 as two
  // capped trips; D2 gets nothing. (2.8.0 demoted the owner at ~1.2 loads and
  // handed freight to D2 — right split count, wrong truck: agreement 27.9→24.6.)
  const drivers = [driver('D1', { aff: 1.0 }), driver('D2')];
  const stops = Array.from({ length: 15 }, (_, i) => stop(`s${i}`, { skids: 2, candidates: ['D1', 'D2'] }));
  const res = solve(stops, drivers);
  assert.equal(res.unassigned.length, 0);
  assert.equal(tripsOf(res, 'D2').length, 0, 'the owner reloads; the cast #2 stays empty');
  const d1 = tripsOf(res, 'D1');
  assert.equal(d1.length, 2, `30 eq = one reload on the owner, got ${d1.length} trips`);
  for (const t of d1) assert.ok(eqOf(t) <= 22 + 1e-9, 'both trips within the box cap');
});

test('past TWO full loads the zone finally overflows to the cast\'s #2 candidate', () => {
  // 25 two-skid stops = 50 eq > the 44-eq two-load budget: the owner runs their
  // two full trips and the tail lands on D2 — the p99 day where dispatch really
  // does hand a corridor's overflow to the cast.
  const drivers = [driver('D1', { aff: 1.0 }), driver('D2')];
  const stops = Array.from({ length: 25 }, (_, i) => stop(`s${i}`, { skids: 2, candidates: ['D1', 'D2'] }));
  const res = solve(stops, drivers);
  assert.equal(res.unassigned.length, 0);
  const used = new Set(res.shifts.filter((sh) => sh.trips.some((t) => t.stops.length)).map((sh) => sh.driver.driver_key));
  assert.ok(used.has('D2'), `past two loads the overflow must reach D2, got ${[...used]}`);
  let totalTrips = 0;
  for (const sh of res.shifts) for (const t of sh.trips) if (t.stops.length) {
    totalTrips++;
    assert.ok(eqOf(t) <= classCapsFor(sh.driver.truck_class, CFG).hard + 1e-9, 'no trip over its class hard cap');
  }
  assert.ok(totalTrips >= 3, `50 eq needs ≥3 box trips, got ${totalTrips}`);
});

test('territory outranks capacity: a FULL candidate still beats a roomy non-candidate', () => {
  // Same 30-eq zone, but the candidate set names ONLY D1. D2 has room and even
  // affinity — and must get nothing: dispatch double-trips the zone's own driver
  // before pulling an outsider.
  const drivers = [driver('D1', { aff: 1.0 }), driver('D2', { aff: 1.0 })];
  const stops = Array.from({ length: 15 }, (_, i) => stop(`s${i}`, { skids: 2, candidates: ['D1'] }));
  const res = solve(stops, drivers);
  assert.equal(res.unassigned.length, 0);
  assert.equal(tripsOf(res, 'D2').length, 0, 'the non-candidate must stay empty');
  const d1 = tripsOf(res, 'D1');
  assert.ok(d1.length >= 2, `30 eq on one box truck must split into ≥2 trips, got ${d1.length}`);
  for (const t of d1) assert.ok(eqOf(t) <= 22 + 1e-9);
});

test('class matters: the same 30-eq bag is ONE tractor trip but TWO box trips', () => {
  const bag = () => Array.from({ length: 15 }, (_, i) => stop(`s${i}`, { skids: 2 }));
  const boxRes = solve(bag(), [driver('B')]);
  const tracRes = solve(bag(), [driver('T', { cls: 'tractor' })]);
  assert.equal(tripsOf(boxRes, 'B').length, 2, '30 eq > box hard 22 → split');
  assert.equal(tripsOf(tracRes, 'T').length, 1, '30 eq ≤ tractor hard 37 → one load');
});

test('a single over-cap stop still rides (alone) — the cap never strands freight', () => {
  const res = solve([stop('big', { skids: 40 })], [driver('D1')]);
  assert.equal(res.unassigned.length, 0);
  assert.equal(tripsOf(res, 'D1').length, 1);
});

test('overflow sheds the WEAKEST-claim stops — the habitual core stays on the owner (2.8.2)', () => {
  // 22 core stops (strong D1 habit) + 3 fringe stops (thin D1 habit) = 50 eq,
  // over D1's two-load budget by exactly the fringe. Dispatch keeps the core on
  // the owner and flexes the fringe to the cast — so D2 must receive precisely
  // the 3 weak-claim stops, never a core customer. (2.8.1 shed by seeding
  // order — arbitrary — and paid for it in the replay: agreement 25.3 vs 27.9.)
  const drivers = [driver('D1', { aff: 1.0 }), driver('D2')];
  const core = Array.from({ length: 22 }, (_, i) => stop(`core${i}`, {
    skids: 2, candidates: ['D1', 'D2'], habit: { topDriver: 'D1', topShare: 0.9, n: 30 },
  }));
  const fringe = Array.from({ length: 3 }, (_, i) => stop(`fringe${i}`, {
    skids: 2, candidates: ['D1', 'D2'], habit: { topDriver: 'D1', topShare: 0.3, n: 4 },
  }));
  const res = solve([...core, ...fringe], drivers);
  assert.equal(res.unassigned.length, 0);
  const d2Ids = tripsOf(res, 'D2').flatMap((t) => t.stops.map((s) => s.id)).sort();
  assert.deepEqual(d2Ids, ['fringe0', 'fringe1', 'fringe2'], `the cast #2 takes only the fringe, got ${d2Ids}`);
  const d1 = tripsOf(res, 'D1');
  assert.equal(d1.length, 2, 'the owner runs the core as a two-load reload day');
  for (const t of d1) assert.ok(eqOf(t) <= 22 + 1e-9);
});
