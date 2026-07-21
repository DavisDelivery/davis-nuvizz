// test/routing-territory.test.mjs
//
// Phase 2.7 — territory candidate sets. The strongest predictor of dispatch's
// driver choice is a stop's ~0.05° zone (run by a stable 2-3 driver cast). These
// tests pin the trailing zone/area ownership maps (leakage-guarded), the ordered
// candidate set (habit → zone top → area fallback, roster-filtered), and that the
// solver actually RESTRICTS assignment to candidates while never stranding a stop.
import test from 'node:test';
import assert from 'node:assert/strict';

import { territoryMapsAsOf, candidateDriversFor } from '../netlify/functions/lib/routing-envelope.mts';
import { solveAssignment } from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.148, lng: -83.959 };

const ref = (date, drv, pts) => ({ date, driver_user_name: drv, driver_name: drv, stops: pts.map(([lat, lng]) => ({ lat, lng })) });
// zone ≈ 34.15,-83.95 (one 0.05° cell); a far cell at 34.50,-84.95.
const Z = [34.15, -83.95], Z2 = [34.153, -83.948], FAR = [34.50, -84.95];

test('territoryMapsAsOf: tallies drivers per zone/area, strictly < D (no leakage)', () => {
  const refs = [
    ref('2026-07-01', 'ALICE', [Z, Z2]),
    ref('2026-07-02', 'ALICE', [Z]),
    ref('2026-07-02', 'BOB', [Z2]),
    ref('2026-07-03', 'CAROL', [Z]),   // ON the plan date — must be excluded
  ];
  const maps = territoryMapsAsOf(refs, '2026-07-03');
  const cell = [...maps.zone.values()][0];
  // ALICE 3 (2 on 7/01 + 1 on 7/02), BOB 1; CAROL's same-day visit excluded.
  const home = maps.zone.get([...maps.zone.keys()].find((k) => maps.zone.get(k).has('ALICE')));
  assert.equal(home.get('ALICE'), 3);
  assert.equal(home.get('BOB'), 1);
  assert.equal(home.has('CAROL'), false, 'same-day (>= D) reference must not leak');
});

test('candidateDriversFor: habit first, then zone top, then area fallback; roster-filtered + de-duped', () => {
  const maps = territoryMapsAsOf([ref('2026-07-01', 'ALICE', [Z, Z, Z]), ref('2026-07-01', 'BOB', [Z])], '2026-07-02');
  // Full roster, habit = CAROL → [CAROL, ALICE, BOB]
  assert.deepEqual(
    candidateDriversFor(Z[0], Z[1], 'CAROL', maps, new Set(['ALICE', 'BOB', 'CAROL'])),
    ['CAROL', 'ALICE', 'BOB'],
  );
  // Habit is also the zone owner → appears once (de-dup), still first.
  assert.deepEqual(candidateDriversFor(Z[0], Z[1], 'ALICE', maps, new Set(['ALICE', 'BOB'])), ['ALICE', 'BOB']);
  // Roster excludes BOB → BOB drops out.
  assert.deepEqual(candidateDriversFor(Z[0], Z[1], null, maps, new Set(['ALICE'])), ['ALICE']);
  // Unseen geography → empty (solver then allows any driver).
  assert.deepEqual(candidateDriversFor(FAR[0], FAR[1], null, maps, new Set(['ALICE'])), []);
});

// ── solver restriction ──
const ENV = () => ({
  driver_key: '', source: 'driver', truck_class: 'box_truck', observed_days: 20,
  per_trip: { stops_median: 14, stops_p85: 18, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: 12000, weight_max: 12000 },
  trips_per_day_propensity: 0.2, start_minute_typical: 240, shift_hours_typical: 12, day_weight_p85: 40000, day_skids_p85: null, day_loose_p85: null,
});
const driver = (key, nearAff = 0) => ({ driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck', start_minute: 240, envelope: { ...ENV(), driver_key: key }, affinity: new Map(nearAff ? [['G', nearAff]] : []) });
const stop = (id, over = {}) => ({ id, lat: 34.16, lng: -83.98, zone: 'Z', gh5: 'G', pallets: 1, skids: 1, loose: 0, weight: 300, matchKey: id, strict: false, miles: 8, blocksTractor: false, habit: null, ...over });
const solve = (stops, drivers) => solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', CFG), cfg: CFG, depot: DEPOT, serviceMedianFor: () => 10 });
const driverOf = (res, id) => { for (const sh of res.shifts) for (const t of sh.trips) for (const s of t.stops) if (s.id === id) return sh.driver.driver_key; return null; };

test('solver assigns a stop only to a candidate — even when a non-candidate scores higher', () => {
  // D1 has strong zone affinity (would win open), but the stop lists only D2 as a candidate.
  const drivers = [driver('D1', 1.0), driver('D2', 0)];
  const res = solve([stop('s1', { candidates: ['D2'] })], drivers);
  assert.equal(driverOf(res, 's1'), 'D2', 'territory restriction beats affinity');
});

test('empty candidates ⇒ open assignment (never strands the stop)', () => {
  const drivers = [driver('D1', 1.0), driver('D2', 0)];
  const res = solve([stop('s1', { candidates: [] })], drivers);
  assert.equal(driverOf(res, 's1'), 'D1', 'unseen geography falls back to the best feasible driver');
  assert.equal(res.unassigned.length, 0);
});

test('candidate that cannot serve the stop ⇒ falls back, does not strand', () => {
  // Only candidate D2 is a tractor; the stop blocks tractors → must fall back to D1.
  const d1 = driver('D1'), d2 = { ...driver('D2'), truck_class: 'tractor' };
  const res = solve([stop('s1', { candidates: ['D2'], blocksTractor: true })], [d1, d2]);
  assert.equal(driverOf(res, 's1'), 'D1');
  assert.equal(res.unassigned.length, 0);
});
