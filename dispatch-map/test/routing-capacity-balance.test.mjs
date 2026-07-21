// test/routing-capacity-balance.test.mjs
//
// Phase 2.5 — daily-capacity balance. The seed used to let one broad-territory
// driver vacuum a whole day's stops (live: 90 stops on a driver who ran 13),
// because its only balancing term (headroom) floored at 0 and could never REPEL a
// full driver, and the cost function never charged for a driver-day past capacity.
// Now the seed repels past learned daily skid/loose capacity AND shiftCost charges
// the overflow, so the SEARCH keeps the spread instead of re-piling. These tests
// pin: the mechanism spreads a pileup, the kill-switch restores prior behavior,
// and unlearned capacity imposes no pressure.
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveAssignment } from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.148, lng: -83.959 };

// Envelope with a LEARNED daily skid capacity of 20 skids/day; everything else
// ample so only the skid dimension can bind.
const ENV = (key, daySkids) => ({
  driver_key: key, source: 'driver', truck_class: 'box_truck', observed_days: 20,
  per_trip: { stops_median: 30, stops_p85: 40, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: 12000, weight_max: 99999 },
  trips_per_day_propensity: 0.2, start_minute_typical: 240, shift_hours_typical: 16,
  day_weight_p85: 999999, day_skids_p85: daySkids, day_loose_p85: null,
});
// Only D1 has affinity for the NEAR zone — a realistic (bounded) territory pull,
// unlike an every-stop-habitual-to-one-driver fixture where w_habit is unbeatable.
const driver = (key, { daySkids = 20, nearAffinity = 0 } = {}) => ({
  driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck',
  start_minute: 240, envelope: ENV(key, daySkids),
  affinity: new Map(nearAffinity ? [['NEAR', nearAffinity]] : []),
});

const stop = (id, skids = 2) => ({
  id, lat: 34.16, lng: -83.98, zone: `Z${id}`, gh5: 'NEAR',
  pallets: skids, skids, loose: 0, weight: 300, matchKey: id, strict: false, miles: 8, blocksTractor: false, habit: null,
});

// 40 stops × 2 skids = 80 skids; D1 owns the whole NEAR zone by affinity but can
// only carry ~20 skids/day. A sane plan cannot pile all 80 on D1.
function scenario() {
  const drivers = [driver('D1', { nearAffinity: 1.0 }), driver('D2'), driver('D3'), driver('D4')];
  const stops = Array.from({ length: 40 }, (_, i) => stop(`s${i}`, 2));
  return { drivers, stops };
}
const solveWith = (cfg) => {
  const { drivers, stops } = scenario();
  return solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 10 });
};
const skidsOnDriver = (res, key) => {
  let n = 0;
  for (const sh of res.shifts) if (sh.driver.driver_key === key) for (const t of sh.trips) for (const s of t.stops) n += s.skids;
  return n;
};

test('daily-capacity balance spreads a territory pileup off the over-capacity owner', () => {
  const capOn = skidsOnDriver(solveWith(CFG), 'D1');
  const capOff = skidsOnDriver(solveWith({ ...CFG, w_day_capacity: 0 }), 'D1');
  // Without the mechanism, D1's affinity vacuums most of the 80 skids.
  assert.ok(capOff >= 60, `with the mechanism OFF, D1 should hoard the day; got ${capOff} of 80`);
  // With it on, D1 is held near their ~20-skid capacity — strictly less, and nowhere near all 80.
  assert.ok(capOn < capOff, `capacity balance must reduce D1's load (${capOn} vs ${capOff})`);
  assert.ok(capOn <= 44, `D1 should be held near capacity, not vacuum the day; got ${capOn}`);
});

test('the spread work actually lands on the other drivers', () => {
  const res = solveWith(CFG);
  const others = ['D2', 'D3', 'D4'].reduce((a, k) => a + skidsOnDriver(res, k), 0);
  assert.ok(others >= 36, `most of the 80 skids should move to other drivers; got ${others}`);
});

test('w_day_capacity=0 is pure back-compat (no repel, no overflow charge)', () => {
  const res = solveWith({ ...CFG, w_day_capacity: 0 });
  assert.ok(skidsOnDriver(res, 'D1') >= 60, 'with the switch off the pileup returns');
});

test('unlearned capacity imposes no pressure and never throws', () => {
  const { stops } = scenario();
  const drivers = [driver('D1', { nearAffinity: 1.0 }), driver('D2'), driver('D3'), driver('D4')].map((d) => ({
    ...d, envelope: { ...d.envelope, day_skids_p85: null, day_loose_p85: null, day_weight_p85: null },
  }));
  const res = solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 10 });
  const assigned = res.shifts.reduce((a, sh) => a + sh.trips.reduce((b, t) => b + t.stops.length, 0), 0);
  assert.equal(assigned + res.unassigned.length, 40);
});
