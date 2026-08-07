// test/routing-weight-cap.test.mjs
//
// Phase 2.11 — per-CLASS per-TRIP PAYLOAD caps. A 26ft straight truck at 26,000
// lb GVWR carries ~10,000 lb; a 53ft tractor ~44,000. Those are the same ratings
// truck-profiles.mts already gates the Phase 1 solver on, so the two solvers now
// agree on what a truck may legally haul.
//
// Why this is NOT the 2.1.1 weight ceiling returning (see trip-split-tightening
// .test.mjs for that history): the old ceiling was weight_p85 × hard_cap_factor
// — a PERCENTILE of one driver's own history, which by construction sits below
// the heaviest 15% of trips they had really run. It split loads proven to fit,
// and the weight_max floor was bolted on to undo that. A rating is not a
// percentile and cannot chop a tail. A trip over it was never legal to build.
//
// These tests pin: the cap splits, it splits per CLASS, it never strands a
// single over-weight stop, it is inert on typical freight density, it can be
// switched off, and — the trap that sank 2.8.0 — the objective does not CHARGE
// the reload the payload forces.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveAssignment, splitFarFirst, classCapsFor, shiftCost,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.148, lng: -83.959 };

const ENV = (cls) => ({
  driver_key: '', source: 'driver', truck_class: cls, observed_days: 20,
  per_trip: { stops_median: 14, stops_p85: 18, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: 12000, weight_max: 12000 },
  trips_per_day_propensity: 0, start_minute_typical: 240, shift_hours_typical: 12, day_weight_p85: 40000, day_skids_p85: null, day_loose_p85: null,
});
const driver = (key, cls = 'box_truck') => ({
  driver_key: key, driver_user_name: key, driver_name: key, truck_class: cls, start_minute: 240,
  envelope: { ...ENV(cls), driver_key: key }, affinity: new Map(),
});
// 1 skid / 300 lb by default — the ~300 lb-per-skid density the real fleet runs.
const stop = (id, over = {}) => ({ id, lat: 34.16, lng: -83.98, zone: 'Z', gh5: 'G', pallets: 1, skids: 1, loose: 0, weight: 300, matchKey: id, strict: false, miles: 8, blocksTractor: false, habit: null, ...over });
const solve = (stops, drivers, cfg = CFG) => solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 10 });
const tripsOf = (res, key) => { const sh = res.shifts.find((x) => x.driver.driver_key === key); return sh ? sh.trips.filter((t) => t.stops.length) : []; };
const lbOf = (t) => t.stops.reduce((a, s) => a + s.weight, 0);

test('splitFarFirst: pounds split a bag that skids alone would leave whole', () => {
  // 4 stops × 4,000 lb = 16,000 lb but only 4 skid-equiv — miles under the box
  // skid cap of 22, so ONLY the payload rating can split this.
  const stops = [stop('a', { weight: 4000, miles: 50 }), stop('b', { weight: 4000, miles: 40 }),
    stop('c', { weight: 4000, miles: 30 }), stop('d', { weight: 4000, miles: 20 })];
  const trips = splitFarFirst(stops, { hard: 22, weightLb: 10000 }, CFG);
  assert.equal(trips.length, 2, '16,000 lb over a 10,000 lb rating must split');
  for (const t of trips) assert.ok(lbOf(t) <= 10000, `each trip within the rating (got ${lbOf(t)})`);
  assert.ok(trips[0].stops.some((x) => x.id === 'a'), 'far-first still holds: farthest stop rides trip 1');
});

test('splitFarFirst: a bare number cap keeps the legacy no-payload-gate behavior', () => {
  const stops = [stop('a', { weight: 9000 }), stop('b', { weight: 9000 })];
  assert.equal(splitFarFirst(stops, 22, CFG).length, 1, '18,000 lb rides whole when only a skid cap is passed');
  assert.equal(splitFarFirst(stops, { hard: 22 }, CFG).length, 1, 'an absent weightLb is also no gate');
  assert.equal(splitFarFirst(stops, { hard: 22, weightLb: 0 }, CFG).length, 1, 'a 0 rating is no gate, never a 0-lb cap');
});

test('a single stop heavier than the whole rating still rides — the cap never strands freight', () => {
  const stops = [stop('heavy', { weight: 14000 })];
  const trips = splitFarFirst(stops, { hard: 22, weightLb: 10000 }, CFG);
  assert.equal(trips.length, 1, 'one over-rating stop rides alone rather than being stranded');
  assert.equal(trips[0].stops.length, 1);
  // ...and it does not drag a second stop over the line with it.
  const mixed = splitFarFirst([stop('heavy', { weight: 14000, miles: 50 }), stop('light', { weight: 500, miles: 10 })], { hard: 22, weightLb: 10000 }, CFG);
  assert.equal(mixed.length, 2, 'the over-rating stop rides alone, the light one follows');
});

test('class matters: the same 24,000 lb bag is ONE tractor trip but THREE box trips', () => {
  const bag = () => [stop('a', { weight: 8000, miles: 50 }), stop('b', { weight: 8000, miles: 40 }), stop('c', { weight: 8000, miles: 30 })];
  assert.equal(splitFarFirst(bag(), classCapsFor('tractor', CFG), CFG).length, 1, '24,000 lb is under the 44,000 tractor rating');
  assert.equal(splitFarFirst(bag(), classCapsFor('box_truck', CFG), CFG).length, 3, '24,000 lb needs three 10,000 lb box loads');
});

test('QUIET on real freight density: a full 22-skid box at ~300 lb/skid never trips the rating', () => {
  // The fleet day behind the skid study ran 260,898 lb over 848 skids + 117
  // loose ≈ 300 lb per skid position. A box truck packed to its skid cap on that
  // mix weighs ~6,600 lb — the skid cap still binds first, exactly as intended.
  const stops = Array.from({ length: 22 }, (_, i) => stop(`s${i}`, { weight: 300 }));
  const trips = splitFarFirst(stops, classCapsFor('box_truck', CFG), CFG);
  assert.equal(trips.length, 1, '22 skids at 6,600 lb is one legal load — the payload cap must not fire');
  assert.ok(lbOf(trips[0]) < 10000);
});

test('end to end: the solver never proposes an over-rating box trip', () => {
  // 6 × 3,000 lb = 18,000 lb on one box driver, only 6 skid-equiv.
  const stops = Array.from({ length: 6 }, (_, i) => stop(`s${i}`, { weight: 3000, miles: 40 - i * 5 }));
  const res = solve(stops, [driver('B')]);
  const trips = tripsOf(res, 'B');
  assert.ok(trips.length >= 2, `18,000 lb cannot ride one box truck, got ${trips.length} trip(s)`);
  for (const t of trips) assert.ok(lbOf(t) <= 10000, `trip over the box rating: ${lbOf(t)} lb`);
  assert.equal(res.unassigned.length, 0, 'the cap splits, it never strands');
});

test('the rating can be switched off entirely (bad-weight-feed kill switch)', () => {
  const stops = Array.from({ length: 6 }, (_, i) => stop(`s${i}`, { weight: 3000, miles: 40 - i * 5 }));
  const off = { ...CFG, weight_cap_box_lb: 0 };
  const trips = tripsOf(solve(stops, [driver('B')], off), 'B');
  assert.equal(trips.length, 1, 'with the rating disabled, 18,000 lb rides as one trip again');
});

test('missing vendor weight FAILS OPEN — a gap in the feed never manufactures a split', () => {
  // plan-core reads `finiteNum(s.weight) || 0`, so a blank weight is 0 lb here.
  // That can only ever UNDER-count; it must not invent a trip.
  const stops = Array.from({ length: 6 }, (_, i) => stop(`s${i}`, { weight: 0, miles: 40 - i * 5 }));
  assert.equal(splitFarFirst(stops, classCapsFor('box_truck', CFG), CFG).length, 1, 'unknown weight rides whole');
});

test('the objective does NOT charge the reload the payload forces (the 2.8.0 trap)', () => {
  // w_trips (12) punishes |trips − expected|. If `needed` stayed skid-only, a
  // weight-forced 2nd trip would read as an unforced split and the search would
  // pay to dodge a reload physics requires — the exact 2.8.0 regression.
  const stops = Array.from({ length: 6 }, (_, i) => stop(`s${i}`, { weight: 3000, miles: 40 - i * 5 }));
  const d = driver('B');
  const trips = splitFarFirst(stops, classCapsFor('box_truck', CFG), CFG);
  assert.ok(trips.length >= 2, 'precondition: the payload rating forced a split');

  const input = { date: '2026-07-16', stops, drivers: [d], fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 10 };
  const forced = shiftCost({ driver: d, trips }, input, new Map());
  // Same shift priced against a config with the rating OFF: `needed` then reads
  // 1 (6 skid-equiv is well under 22) and w_trips charges the second trip.
  const naive = shiftCost({ driver: d, trips }, { ...input, cfg: { ...CFG, weight_cap_box_lb: 0 } }, new Map());
  assert.ok(forced < naive, `a payload-forced reload must cost LESS than an unforced one (${forced} vs ${naive})`);
  assert.ok(naive - forced >= CFG.w_trips - 1e-9, `the whole w_trips charge must be forgiven (saved ${naive - forced}, w_trips ${CFG.w_trips})`);
});
