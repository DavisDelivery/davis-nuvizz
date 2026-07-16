// Regression tests for the trip-split tightening (engine 2.1.1): the engine was
// proposing ~10-15% more trips/day than dispatch actually ran because the hard
// per-trip ceiling was p85 × hard_cap_factor — which by definition chops the
// top-15% tail of trips dispatch REALLY ran, manufacturing phantom splits.
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

test('never split a weight the driver has actually carried in one trip', () => {
  // p85=5000 → old ceiling 5000×1.15=5750 would force this 8500-lb bag into 2 trips.
  // The driver has RUN 9000 in one trip, so it must stay one trip.
  const stops = [aStop('A', 3000), aStop('B', 3000), aStop('C', 2500)];
  const res = solve(stops, ENV(5000, 9000));
  const shift = res.shifts.find((s) => s.driver.driver_key === 'GPITTS');
  const trips = shift.trips.filter((t) => t.stops.length);
  assert.equal(trips.length, 1, `8500 lbs under the observed 9000 max must be ONE trip, got ${trips.length}`);
});

test('the ceiling still splits above everything the driver has ever carried', () => {
  const stops = [aStop('A', 5000), aStop('B', 5000), aStop('C', 4000)]; // 14000 > max 9000
  const res = solve(stops, ENV(5000, 9000));
  const shift = res.shifts.find((s) => s.driver.driver_key === 'GPITTS');
  const trips = shift.trips.filter((t) => t.stops.length);
  assert.ok(trips.length >= 2, 'a bag above the observed max still splits');
});

test('missing weight_max falls back to p85 × hard_cap_factor (old behavior preserved)', () => {
  const stops = [aStop('A', 3000), aStop('B', 3000), aStop('C', 2500)]; // 8500 > 5750
  const res = solve(stops, ENV(5000, null));
  const shift = res.shifts.find((s) => s.driver.driver_key === 'GPITTS');
  const trips = shift.trips.filter((t) => t.stops.length);
  assert.ok(trips.length >= 2, 'without an observed max, the p85 ceiling still governs');
});

test('w_trips default is a real vote now', () => {
  assert.ok(CFG.w_trips >= 12, `w_trips must be >= 12, got ${CFG.w_trips}`);
});
