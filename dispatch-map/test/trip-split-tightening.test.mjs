// Regression tests for trip-split behavior. History: engine 2.1.1 tightened the
// per-driver WEIGHT ceiling because p85 × hard_cap_factor chopped the top-15%
// tail of trips dispatch REALLY ran, manufacturing phantom splits. Engine 2.8.0
// removed the weight ceiling entirely — the freight study showed loads bind on
// per-CLASS skid positions (dispatch cubes out, it doesn't weigh out).
//
// 2.11 REFINES that guarantee rather than reversing it. The rule is no longer
// "weight never splits" but the sharper thing 2.1.1 was actually reaching for:
// NO LEARNED STATISTIC MAY SPLIT A TRIP. A percentile of a driver's own history
// sits below their own heaviest real trips by construction — that is what made
// phantom splits — so nothing derived from the envelope is allowed to split
// anything, and these tests still pin exactly that. What may split a trip is a
// truck's PAYLOAD RATING (box 10,000 / tractor 44,000 lb, from truck-profiles
// .mts), because a load over the rating was never legal to build in the first
// place. See routing-weight-cap.test.mjs. The envelope's weight_p85 / weight_max
// remain data and constrain nothing.
//
// Every driver below is a TRACTOR, and the heaviest bag here is 14,000 lb —
// under the 44,000 lb tractor rating — so these cases are untouched by 2.11 and
// still prove the learned ceiling is gone.
import test from 'node:test';
import assert from 'node:assert/strict';

import { driverEnvelope } from '../netlify/functions/lib/routing-envelope.mts';
import { solveAssignment } from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { zoneId, superOfZone } from '../netlify/functions/lib/zones.mts';

const CFG = engineConfigDefaults();
const PREC = CFG.zone_precision;

function driverDay(date, weight, trips = 1) {
  const t = [];
  for (let i = 0; i < trips; i++) t.push({ load_key: `L${i}`, seq_index: i + 1, stops: 10, pallets: 8, weight, avg_mi: 30 - i * 10, max_mi: 40, first_touch: `${date}T0${4 + i * 5}:00:00`, last_touch: `${date}T0${5 + i * 5}:00:00` });
  return { tenant: 'davis', date, driver_key: 'GPITTS', driver_user_name: 'GPITTS', driver_name: 'Garry', truck_class: 'tractor', trips: t, day_totals: { stops: 10 * trips, pallets: 8 * trips, weight: weight * trips }, trips_count: trips, start_time: `${date}T04:00:00`, end_time: `${date}T15:00:00` };
}

function aStop(id, weight) {
  const lat = 34.1, lng = -84.0;
  const z = zoneId(lat, lng, PREC);
  return { id, lat, lng, zone: z, gh5: superOfZone(z, PREC), pallets: 2, weight, matchKey: id, strict: false, miles: 20, blocksTractor: false };
}

const ENV = (p85, max) => ({
  driver_key: 'GPITTS', source: 'driver', truck_class: 'tractor', observed_days: 20,
  per_trip: { stops_median: 12, stops_p85: 16, pallets_median: 8, pallets_p85: 12, weight_median: 4000, weight_p85: p85, weight_max: max },
  trips_per_day_propensity: 0, start_minute_typical: 240, shift_hours_typical: 10, day_weight_p85: (max ?? p85) * 1.2,
});

const driver = (env) => ({ driver_key: 'GPITTS', driver_user_name: 'GPITTS', driver_name: 'Garry', truck_class: 'tractor', start_minute: 240, envelope: env, affinity: new Map() });

const solve = (stops, env) => solveAssignment({
  date: '2026-07-14', stops, drivers: [driver(env)],
  fleetChain: fleetTripChain([], '2026-07-14', CFG), cfg: CFG,
  depot: { lat: 34.148, lng: -83.959 }, serviceMedianFor: () => 15,
});

test('envelope mines the observed per-trip weight_max (as-of filter still applies)', () => {
  const cfg = { ...CFG, min_observation_days: 3 };
  const days = [driverDay('2026-07-01', 5000), driverDay('2026-07-02', 6000), driverDay('2026-07-03', 9000), driverDay('2026-07-10', 99000)];
  const env = driverEnvelope('GPITTS', days, '2026-07-08', cfg);
  assert.equal(env.per_trip.weight_max, 9000, 'max of the < D trips');
  assert.ok(env.per_trip.weight_max < 99000, 'a future day never leaks into the max');
});

test('weight NEVER splits a trip: a heavy bag under the class skid cap stays ONE trip', () => {
  // 8500 lbs on a p85=5000 envelope — the 2.1.1 weight ceiling split this. The
  // bag is 6 skid-equiv (pallets fallback), far under the tractor cap of 37, so
  // it must ride as one load no matter what the scale says.
  const stops = [aStop('A', 3000), aStop('B', 3000), aStop('C', 2500)];
  const res = solve(stops, ENV(5000, 9000));
  const shift = res.shifts.find((s) => s.driver.driver_key === 'GPITTS');
  const trips = shift.trips.filter((t) => t.stops.length);
  assert.equal(trips.length, 1, `6 skid-eq under the tractor cap must be ONE trip, got ${trips.length}`);
});

test('even a bag past every observed weight stays whole — only the skid cap splits', () => {
  // 14000 lbs vs weight_max 9000: the old ceiling split this; skids (6 eq) say one load.
  const stops = [aStop('A', 5000), aStop('B', 5000), aStop('C', 4000)];
  const res = solve(stops, ENV(5000, 9000));
  const shift = res.shifts.find((s) => s.driver.driver_key === 'GPITTS');
  const trips = shift.trips.filter((t) => t.stops.length);
  assert.equal(trips.length, 1, 'weight is not a split dimension anymore');
});

test('the class hard skid cap still splits a genuinely over-cap bag', () => {
  // 20 stops × 2 pallets = 40 skid-eq > tractor hard 37 → must split.
  const stops = Array.from({ length: 20 }, (_, i) => aStop(`S${i}`, 400));
  const res = solve(stops, ENV(5000, 9000));
  const shift = res.shifts.find((s) => s.driver.driver_key === 'GPITTS');
  const trips = shift.trips.filter((t) => t.stops.length);
  assert.ok(trips.length >= 2, `40 skid-eq over the tractor cap of 37 must split, got ${trips.length}`);
  for (const t of trips) {
    const eq = t.stops.reduce((a, s) => a + s.pallets, 0);
    assert.ok(eq <= 37 + 1e-9, `each trip within the tractor cap (got ${eq})`);
  }
});

test('w_trips default is a real vote now', () => {
  assert.ok(CFG.w_trips >= 12, `w_trips must be >= 12, got ${CFG.w_trips}`);
});
