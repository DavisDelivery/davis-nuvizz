// test/routing-driver-skid-caps.test.mjs
//
// Phase 2.12 — PER-DRIVER skid caps. The class caps (box soft 20 / hard 22) are
// a FLEET statistic: 22 is the p95 of all box trips, while the same 912-trip
// study puts the MEDIAN box trip at 14. Applying p95 to everyone loaded every
// box driver like the heaviest box driver. Chad: "Most box truck drivers can't
// put 22 skids on a box truck. You should id the ones who can take 17-18 but
// most are 12-15."
//
// So a driver's hard bound is now THEIR OWN typical full load — the p85 of
// their per-trip skid-equivalents, mined from days < D.
//
// It is deliberately NOT their observed max, which is the tempting choice. A
// driver needs 10 observed DAYS before their own envelope is used at all, so
// their max is drawn from ~12-25 trips and sits at their own p95-p100: one
// 21-skid day in ten weeks would put a 14-skid driver back at the class cap of
// 22 and change nothing for exactly the drivers this targets. p85 is what "most
// are 12-15, some take 17-18" describes. skid_cap_driver_headroom dials toward
// the max for anyone who wants the looser reading.
//
// THE SAFETY PROPERTY THESE TESTS EXIST TO PIN: a per-driver cap is clamped at
// the class cap, so it is always <= what the flat cap allowed. This change can
// only ever split LESS than before, never more.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveAssignment, splitFarFirst, capsFor, classCapsFor,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { driverEnvelope, fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.148, lng: -83.959 };

// An envelope carrying an explicit learned per-trip skid history.
const ENV = (cls, { p85 = null, max = null } = {}) => ({
  driver_key: '', source: 'driver', truck_class: cls, observed_days: 20,
  per_trip: {
    stops_median: 14, stops_p85: 18, pallets_median: 8, pallets_p85: 12,
    weight_median: 3000, weight_p85: 5000, weight_max: 6000,
    skid_equiv_p85: p85, skid_equiv_max: max,
  },
  trips_per_day_propensity: 0, start_minute_typical: 240, shift_hours_typical: 12,
  day_weight_p85: 40000, day_skids_p85: null, day_loose_p85: null,
});
const driver = (key, { cls = 'box_truck', p85 = null, max = null } = {}) => ({
  driver_key: key, driver_user_name: key, driver_name: key, truck_class: cls, start_minute: 240,
  envelope: { ...ENV(cls, { p85, max }), driver_key: key }, affinity: new Map(),
});
// 1 skid, 120 lb per stop — light enough that the 2.11 payload cap never fires.
const stop = (id, over = {}) => ({ id, lat: 34.16, lng: -83.98, zone: 'Z', gh5: 'G', pallets: 1, skids: 1, loose: 0, weight: 120, matchKey: id, strict: false, miles: 8, blocksTractor: false, habit: null, ...over });
const solve = (stops, drivers, cfg = CFG) => solveAssignment({ date: '2026-07-16', stops, drivers, fleetChain: fleetTripChain([], '2026-07-16', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 10 });
const tripsOf = (res, key) => { const sh = res.shifts.find((x) => x.driver.driver_key === key); return sh ? sh.trips.filter((t) => t.stops.length) : []; };
const skidsOf = (t) => t.stops.reduce((a, s) => a + s.skids, 0);

test('a 12-15 skid driver gets a 12-15 skid cap, not the fleet p95 of 22', () => {
  const caps = capsFor(driver('TYPICAL', { p85: 14, max: 15 }), CFG);
  assert.equal(caps.hard, 14, 'a full truck for THIS driver');
  assert.equal(caps.soft, 14);
  assert.equal(caps.learned, true);
});

test('ONE outlier day does not hand a 14-skid driver the class cap back', () => {
  // The whole point of using p85 over the observed max. A driver needs 10
  // observed DAYS before their own envelope is used at all, so their max is
  // drawn from ~12-25 trips and sits at their own p95-p100. If the bound were
  // the raw max, a single 21-skid day in ten weeks would put this driver back
  // at 22 and the phase would change nothing for exactly the drivers it targets.
  const caps = capsFor(driver('ONEBIGDAY', { p85: 14, max: 21 }), CFG);
  assert.equal(caps.hard, 14, 'the outlier does not become the everyday cap');
  assert.ok(caps.hard < classCapsFor('box_truck', CFG).hard);
});

test('skid_cap_driver_headroom dials from typical full load to the observed max', () => {
  const d = driver('ONEBIGDAY', { p85: 14, max: 21 });
  assert.equal(capsFor(d, { ...CFG, skid_cap_driver_headroom: 0 }).hard, 14, '0 = p85');
  assert.equal(capsFor(d, { ...CFG, skid_cap_driver_headroom: 1 }).hard, 21, '1 = observed max');
  assert.equal(capsFor(d, { ...CFG, skid_cap_driver_headroom: 0.5 }).hard, 17.5, 'halfway');
  assert.equal(CFG.skid_cap_driver_headroom, 0, 'default is the typical full load');
});

test('the class clamp reads the SOLVER class, never the envelope class', () => {
  // A driver with no prior days gets a 'class' envelope whose truck_class is
  // null — which makes it a FLEET envelope, box and tractor days mixed. Clamping
  // on envelope.truck_class would let a box driver inherit a tractor's numbers.
  const boxDriverTractorEnvelope = {
    driver_key: 'X', driver_user_name: 'X', driver_name: 'X',
    truck_class: 'box_truck', start_minute: 240, affinity: new Map(),
    envelope: { ...ENV('tractor', { p85: 31, max: 37 }), truck_class: 'tractor' },
  };
  assert.equal(capsFor(boxDriverTractorEnvelope, CFG).hard, 22,
    'clamped at the BOX cap because the solver says box, whatever the envelope says');
});

test('the 17-18 drivers are identified as such — same class, bigger cap', () => {
  const big = capsFor(driver('STRONG', { p85: 18, max: 20 }), CFG);
  const typical = capsFor(driver('TYPICAL', { p85: 14, max: 15 }), CFG);
  assert.equal(big.hard, 18);
  assert.equal(typical.hard, 14);
  assert.ok(big.hard > typical.hard, 'two box drivers, two different caps — that is the point');
});

test('SAFETY: a per-driver cap can never exceed the class cap', () => {
  // An outlier trip (the study saw a box "max" of 38) must not invent a 38-skid
  // box truck — that would split LESS than the flat cap and hide a real overload.
  const caps = capsFor(driver('OUTLIER', { p85: 30, max: 38 }), CFG);
  assert.equal(caps.hard, classCapsFor('box_truck', CFG).hard, 'clamped at the class hard cap of 22');
  assert.ok(caps.hard <= 22);
});

test('SAFETY: a thin small-day history is floored, never a 4-skid truck', () => {
  const caps = capsFor(driver('SMALLDAYS', { p85: 3, max: 4 }), CFG);
  assert.equal(caps.hard, CFG.skid_cap_driver_min, 'floored at skid_cap_driver_min (10)');
  assert.ok(caps.soft <= caps.hard, 'soft can never exceed hard');
});

test('no learned skid history at all ⇒ the class caps, unchanged', () => {
  const caps = capsFor(driver('NEW'), CFG);
  assert.deepEqual(
    { soft: caps.soft, hard: caps.hard, weightLb: caps.weightLb },
    classCapsFor('box_truck', CFG),
    'pre-capture history must not change behavior',
  );
  assert.equal(caps.learned, false);
  // ...and a driver object with no envelope at all must not throw.
  assert.equal(capsFor({ truck_class: 'box_truck' }, CFG).hard, 22);
  assert.equal(capsFor(null, CFG).hard, 22, 'unknown driver reads as box');
});

test('the floor doubles as a kill switch: set it to the class cap and everyone is class-capped', () => {
  const off = { ...CFG, skid_cap_driver_min: 22 };
  assert.equal(capsFor(driver('TYPICAL', { p85: 14, max: 15 }), off).hard, 22);
  assert.equal(capsFor(driver('STRONG', { p85: 17, max: 18 }), off).hard, 22);
});

test('tractors keep their own class bound', () => {
  const caps = capsFor(driver('T', { cls: 'tractor', p85: 28, max: 30 }), CFG);
  assert.equal(caps.hard, 28, 'a tractor driver learns their own number too');
  assert.equal(capsFor(driver('T2', { cls: 'tractor', p85: 40, max: 67 }), CFG).hard, 37, 'clamped at tractor 37');
});

test('end to end: an 18-skid bag rides ONE trip for the 17-18 driver and SPLITS for the 12-15 driver', () => {
  const bag = () => Array.from({ length: 18 }, (_, i) => stop(`s${i}`, { miles: 30 - i }));
  assert.equal(tripsOf(solve(bag(), [driver('STRONG', { p85: 18, max: 20 })]), 'STRONG').length, 1,
    '18 skids is a normal load for a driver whose full truck is 18');
  const weak = tripsOf(solve(bag(), [driver('TYPICAL', { p85: 14, max: 15 })]), 'TYPICAL');
  assert.ok(weak.length >= 2, `18 skids must not ride one truck for a 15-skid driver, got ${weak.length}`);
  for (const t of weak) assert.ok(skidsOf(t) <= 14, `each trip within their real cap (got ${skidsOf(t)})`);
});

test('the driver-day warehouse actually feeds these caps (envelope wiring, not a fixture)', () => {
  // Trips carry per-trip skids/loose already; the envelope must mine them.
  const day = (date, tripSkids) => ({
    tenant: 'davis', date, driver_key: 'D', driver_user_name: 'D', driver_name: 'D', truck_class: 'box_truck',
    trips: tripSkids.map((sk, i) => ({ load_key: `L${i}`, seq_index: i + 1, stops: 10, pallets: sk, skids: sk, loose: 0, weight: 2000, avg_mi: 20, max_mi: 30, first_touch: `${date}T05:00:00`, last_touch: `${date}T12:00:00` })),
    day_totals: { stops: 10 * tripSkids.length, pallets: 0, skids: tripSkids.reduce((a, b) => a + b, 0), loose: 0, weight: 2000 },
    trips_count: tripSkids.length, start_time: `${date}T04:00:00`, end_time: `${date}T15:00:00`,
  });
  const days = Array.from({ length: 12 }, (_, i) => day(`2026-07-${String(i + 1).padStart(2, '0')}`, [12, 14]));
  days.push(day('2026-07-13', [15]));
  days.push(day('2026-07-30', [99]));   // AFTER D — must never leak in
  const env = driverEnvelope('D', days, '2026-07-20', CFG);
  assert.equal(env.source, 'driver', '12+ observed days uses the driver envelope');
  assert.equal(env.per_trip.skid_equiv_max, 15, 'mined from real per-trip skids, future day excluded');
  assert.ok(env.per_trip.skid_equiv_max < 99, 'as-of filter holds');
  assert.equal(env.per_trip.skid_equiv_p85, 14, 'their typical full load across 25 real trips');
  assert.equal(capsFor({ truck_class: 'box_truck', envelope: env }, CFG).hard, 14);
});

test('loose pieces count toward a learned cap, and pre-capture trips do not drag it to zero', () => {
  const mk = (skids, loose) => ({ load_key: 'L', seq_index: 1, stops: 5, pallets: 0, skids, loose, weight: 500, avg_mi: 10, max_mi: 12, first_touch: '2026-07-01T05:00:00', last_touch: '2026-07-01T10:00:00' });
  const days = Array.from({ length: 12 }, (_, i) => ({
    tenant: 'davis', date: `2026-07-${String(i + 1).padStart(2, '0')}`, driver_key: 'D', driver_user_name: 'D', driver_name: 'D', truck_class: 'box_truck',
    // one real trip (10 skids + 100 loose = 20 equiv) and one PRE-CAPTURE trip (0/0)
    trips: [mk(10, 100), mk(0, 0)],
    day_totals: { stops: 10, pallets: 0, skids: 10, loose: 100, weight: 1000 }, trips_count: 2,
    start_time: `2026-07-${String(i + 1).padStart(2, '0')}T04:00:00`, end_time: `2026-07-${String(i + 1).padStart(2, '0')}T15:00:00`,
  }));
  const env = driverEnvelope('D', days, '2026-07-20', CFG);
  assert.equal(env.per_trip.skid_equiv_max, 20, '10 skids + 100 loose at 10/skid = 20 positions');
  assert.equal(env.per_trip.skid_equiv_p85, 20, 'the 0/0 pre-capture trip is excluded, not counted as a 0-skid trip');
});

test('splitFarFirst still honors a learned cap through the caps object', () => {
  const stops = Array.from({ length: 16 }, (_, i) => stop(`s${i}`, { miles: 40 - i }));
  const caps = capsFor(driver('TYPICAL', { p85: 14, max: 15 }), CFG);
  const trips = splitFarFirst(stops, caps, CFG);
  assert.equal(trips.length, 2, '16 skids over a 14 cap splits');
  for (const t of trips) assert.ok(skidsOf(t) <= 14);
});
