// Phase 2 — the assignment layer: driver-day trip grouping + time order, as-of
// leakage (envelope / affinity / service-time inputs strictly < D), hard-
// constraint inviolability (equipment + trip ceiling), far-first splitting, both
// agreement metrics (including the label-swap case), determinism, and the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDriverDays } from '../netlify/functions/lib/routing-driver-days.mts';
import {
  driverEnvelope, driverZoneAffinity, fleetTripChain, wallMinuteOfDay,
} from '../netlify/functions/lib/routing-envelope.mts';
import {
  serviceObservationsForDay, serviceTimeAsOf, palletBucket, dwellMinutes, quantile,
} from '../netlify/functions/lib/routing-service-times.mts';
import {
  solveAssignment, splitFarFirst, driverCanServe, restrictionsBlockTractor,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { computePlanAgreement, coloadPairs } from '../netlify/functions/lib/routing-plan-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { superOfZone, zoneId } from '../netlify/functions/lib/zones.mts';

const CFG = engineConfigDefaults({});
const PREC = { zone_precision: 6, super_precision: 5, top_precision: 4 };

function mkStop(o = {}) {
  return {
    stopNbr: o.stopNbr, pro: o.pro ?? o.stopNbr, loadNbr: o.loadNbr, routeName: o.routeName ?? 'RT',
    driverName: o.driverName ?? 'Garry Pitts', driverUserName: o.driverUserName ?? 'GPITTS',
    warehouse: 'G6', businessName: o.businessName ?? 'ACME', customerMatchKey: o.matchKey ?? 'acme__x',
    lat: o.lat ?? 34.10, lng: o.lng ?? -84.0, pallets: o.pallets ?? 2, weight: o.weight ?? 1000,
    stopDistance: o.miles, arrivalDTTM: o.arr ?? null, deliveredDTTM: o.del ?? null,
    routeSeq: o.routeSeq ?? null, timeConstraint: o.strict ? 'STRICT' : null,
    isPlanned: true, isUnplanned: false, isTerminal: false, isAttempt: false,
    ...o.raw,
  };
}

// ── driver-day trip grouping + time ordering ─────────────────────────────────

test('extractDriverDays: two loads become seq-ordered trips by earliest touch', () => {
  const stops = [
    // trip 2 (later touch) — but appears first in the array
    mkStop({ stopNbr: 'b1', loadNbr: 'L2', arr: '2026-07-08T09:30:00', del: '2026-07-08T09:45:00', miles: 18, weight: 2000 }),
    mkStop({ stopNbr: 'b2', loadNbr: 'L2', arr: '2026-07-08T10:10:00', del: '2026-07-08T10:25:00', miles: 20, weight: 1500 }),
    // trip 1 (earlier touch)
    mkStop({ stopNbr: 'a1', loadNbr: 'L1', arr: '2026-07-08T04:00:00', del: '2026-07-08T04:20:00', miles: 40, weight: 3000 }),
    mkStop({ stopNbr: 'a2', loadNbr: 'L1', arr: '2026-07-08T05:00:00', del: '2026-07-08T05:15:00', miles: 35, weight: 3500 }),
  ];
  const [dd] = extractDriverDays(stops, { tenant: 'davis', date: '2026-07-08' });
  assert.equal(dd.trips_count, 2);
  const t1 = dd.trips.find((t) => t.seq_index === 1);
  const t2 = dd.trips.find((t) => t.seq_index === 2);
  assert.equal(t1.load_key, 'L1', 'earliest-touch load is trip 1');
  assert.equal(t2.load_key, 'L2');
  assert.equal(t1.first_touch, '2026-07-08T04:00:00');
  assert.equal(dd.start_time, '2026-07-08T04:00:00');
  assert.equal(dd.day_totals.weight, 10000);
  assert.equal(dd.day_totals.stops, 4);
  // far-first shape: trip 1 farther than trip 2
  assert.ok(t1.avg_mi > t2.avg_mi);
});

test('extractDriverDays: on a stamped day, a no-stamp load is NOT this day\'s work', () => {
  // This test used to pin the opposite — "ghost freight still counts in day totals" — and that
  // pin was the bug (Jul 29, DAWSONVILLE/CRUMPTON): the un-stamped load on a stamped day is the
  // NEXT day's pre-built freight (or a stale plan), and counting it charged Leroy Smith with
  // ~4,900 lb against a 2,799 lb load. Execution evidence now decides: no same-day delivery
  // stamp on an otherwise-stamped day → the load did not run that day.
  const stops = [
    mkStop({ stopNbr: 'a1', loadNbr: 'L1', arr: '2026-07-08T04:00:00', del: '2026-07-08T04:20:00', weight: 3000 }),
    mkStop({ stopNbr: 'a2', loadNbr: 'L1', arr: '2026-07-08T05:00:00', del: '2026-07-08T05:10:00', weight: 1000 }),
    mkStop({ stopNbr: 'a3', loadNbr: 'L1', arr: '2026-07-08T05:30:00', del: '2026-07-08T05:40:00', weight: 1000 }),
    mkStop({ stopNbr: 'a4', loadNbr: 'L1', arr: '2026-07-08T06:00:00', del: '2026-07-08T06:10:00', weight: 1000 }),
    mkStop({ stopNbr: 'a5', loadNbr: 'L1', arr: '2026-07-08T06:30:00', del: '2026-07-08T06:40:00', weight: 1000 }),
    // ghost load with no stamps — tomorrow's freight sitting planned on today's board
    mkStop({ stopNbr: 'z1', loadNbr: 'L9', weight: 800 }),
  ];
  const [dd] = extractDriverDays(stops, { tenant: 'davis', date: '2026-07-08' });
  assert.equal(dd.trips.find((t) => t.load_key === 'L9'), undefined, 'the phantom load is not a trip');
  assert.equal(dd.day_totals.weight, 7000, 'and its freight is not in the day totals');
  assert.equal(dd.day_totals.stops, 5);
});

test('extractDriverDays: a wholly UN-stamped day keeps the legacy behaviour (null seq, freight counted)', () => {
  // The evidence gate self-disables when under half the day is stamped (a sparse legacy
  // capture is not proof nothing ran) — there the original rule stands: the load cannot be
  // time-ordered (seq_index null) but its freight still counts.
  const stops = [
    mkStop({ stopNbr: 'a1', loadNbr: 'L1', weight: 3000 }),
    mkStop({ stopNbr: 'a2', loadNbr: 'L1', weight: 1000 }),
    mkStop({ stopNbr: 'z1', loadNbr: 'L9', weight: 800 }),
  ];
  const [dd] = extractDriverDays(stops, { tenant: 'davis', date: '2026-07-08' });
  const ghost = dd.trips.find((t) => t.load_key === 'L9');
  assert.equal(ghost.seq_index, null, 'no-timestamp load is not time-ordered');
  assert.equal(ghost.weight, 800);
  assert.equal(dd.day_totals.weight, 4800, 'freight still counts when the day itself carries no evidence');
});

// ── as-of leakage ────────────────────────────────────────────────────────────

function driverDay(date, weight, trips = 1) {
  const t = [];
  for (let i = 0; i < trips; i++) t.push({ load_key: `L${i}`, seq_index: i + 1, stops: 10, pallets: 8, weight, avg_mi: 30 - i * 10, max_mi: 40, first_touch: `${date}T0${4 + i * 5}:00:00`, last_touch: `${date}T0${5 + i * 5}:00:00` });
  return { tenant: 'davis', date, driver_key: 'GPITTS', driver_user_name: 'GPITTS', driver_name: 'Garry', truck_class: 'tractor', trips: t, day_totals: { stops: 10 * trips, pallets: 8 * trips, weight: weight * trips }, trips_count: trips, start_time: `${date}T04:00:00`, end_time: `${date}T15:00:00` };
}

test('driverEnvelope: uses only days strictly before D; a future day never leaks', () => {
  const cfg = { ...CFG, min_observation_days: 3 };
  const days = [driverDay('2026-07-01', 5000), driverDay('2026-07-02', 6000), driverDay('2026-07-03', 7000), driverDay('2026-07-10', 99000)];
  const env = driverEnvelope('GPITTS', days, '2026-07-08', cfg);
  assert.equal(env.source, 'driver');
  assert.equal(env.observed_days, 3, 'only Jul 1-3 count for D=Jul 8');
  // the Jul-10 outlier (99000) must not affect the p85
  assert.ok(env.per_trip.weight_p85 <= 7000, `p85 ${env.per_trip.weight_p85} excludes the future day`);
});

test('driverEnvelope: falls back to a class envelope below min_observation_days', () => {
  const cfg = { ...CFG, min_observation_days: 10 };
  const days = [driverDay('2026-07-01', 5000), driverDay('2026-07-02', 6000)]; // only 2 for this driver
  // add another tractor driver's days so the class fallback has data
  for (let d = 1; d <= 6; d++) days.push({ ...driverDay(`2026-07-0${d}`, 5500), driver_key: 'OTHER', driver_user_name: 'OTHER' });
  const env = driverEnvelope('GPITTS', days, '2026-07-08', cfg);
  assert.equal(env.source, 'class');
  assert.equal(env.truck_class, 'tractor');
});

test('driverZoneAffinity: only references before D, normalized to 1', () => {
  const z = zoneId(34.10, -84.0, PREC);
  const gh5 = superOfZone(z, PREC);
  const refs = [
    { tenant: 'davis', date: '2026-07-01', driver_user_name: 'GPITTS', stops: [{ zone: z }, { zone: z }] },
    { tenant: 'davis', date: '2026-07-09', driver_user_name: 'GPITTS', stops: [{ zone: zoneId(33.9, -84.5, PREC) }] }, // future — excluded
  ];
  const aff = driverZoneAffinity('GPITTS', refs, '2026-07-08', PREC);
  assert.equal(aff.get(gh5), 1, 'all pre-D weight on the one gh5 zone');
  assert.ok(![...aff.values()].some((v) => v > 1));
});

test('serviceTimeAsOf: recomputes from observations strictly before D', () => {
  const doc = { obs: [{ d: '2026-07-01', m: 10 }, { d: '2026-07-02', m: 20 }, { d: '2026-07-03', m: 30 }, { d: '2026-07-09', m: 999 }] };
  const r = serviceTimeAsOf(doc, null, 2, '2026-07-08', CFG);
  assert.equal(r.source, 'customer');
  assert.equal(r.n, 3, 'the Jul-9 obs is excluded');
  assert.equal(r.median_min, 20);
});

test('serviceTimeAsOf: falls back to the fleet bucket, then a default', () => {
  const fleet = { buckets: { '2-4': { obs: [{ d: '2026-07-01', m: 12 }, { d: '2026-07-02', m: 14 }, { d: '2026-07-03', m: 16 }] } } };
  const r = serviceTimeAsOf(null, fleet, 3, '2026-07-08', CFG);
  assert.equal(r.source, 'fleet');
  assert.equal(r.median_min, 14);
  const d = serviceTimeAsOf(null, null, 3, '2026-07-08', CFG);
  assert.equal(d.source, 'default');
});

test('serviceObservationsForDay: needs both stamps; clamps out-of-band dwell', () => {
  const stops = [
    mkStop({ stopNbr: '1', matchKey: 'a', arr: '2026-07-08T04:00:00', del: '2026-07-08T04:15:00', pallets: 3 }), // 15m ok
    mkStop({ stopNbr: '2', matchKey: 'a', arr: '2026-07-08T05:00:00', del: null }),                              // no delivered → drop
    mkStop({ stopNbr: '3', matchKey: 'b', arr: '2026-07-08T06:00:00', del: '2026-07-08T12:00:00', pallets: 6 }), // 360m > 120 clamp → drop
  ];
  const day = serviceObservationsForDay(stops, CFG);
  assert.deepEqual(day.customer.get('a'), [15]);
  assert.ok(!day.customer.has('b'), 'the 6-hour dwell is dropped');
  assert.deepEqual(day.fleet.get('2-4'), [15]);
});

test('dwellMinutes / palletBucket / quantile basics', () => {
  assert.equal(dwellMinutes('2026-07-08T04:00:00', '2026-07-08T04:30:00'), 30);
  assert.equal(dwellMinutes('x', 'y'), null);
  assert.equal(palletBucket(0), '0-1'); assert.equal(palletBucket(3), '2-4'); assert.equal(palletBucket(9), '5+');
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(wallMinuteOfDay('2026-07-08T04:30:00'), 270);
});

// ── far-first splitting ──────────────────────────────────────────────────────

test('splitFarFirst: respects the skid cap and puts farther stops in earlier trips', () => {
  const s = (id, miles, skids) => ({ id, miles, skids, loose: 0, weight: 4000, lat: 0, lng: 0, zone: '', gh5: '', pallets: skids, matchKey: id, strict: false, blocksTractor: false });
  const stops = [s('near', 5, 8), s('far', 50, 8), s('mid', 25, 8)];
  const trips = splitFarFirst(stops, 16, CFG); // 24 skid-eq over a 16 cap forces 2 trips
  assert.equal(trips.length, 2);
  // farthest ('far') must be in trip 1
  assert.ok(trips[0].stops.some((x) => x.id === 'far'));
  for (const t of trips) assert.ok(t.stops.reduce((a, x) => a + x.skids, 0) <= 16);
  // single trip when under the cap
  assert.equal(splitFarFirst(stops, 100, CFG).length, 1);
});

// ── hard-constraint inviolability ────────────────────────────────────────────

const ENV = (weightP85) => ({ driver_key: '', source: 'driver', truck_class: null, observed_days: 20, per_trip: { stops_median: 12, stops_p85: 16, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: weightP85 }, trips_per_day_propensity: 0.3, start_minute_typical: 240, shift_hours_typical: 10, day_weight_p85: weightP85 * 1.6 });

function aStop(id, o = {}) {
  const lat = o.lat ?? 34.1, lng = o.lng ?? -84.0;
  const z = zoneId(lat, lng, PREC);
  return { id, lat, lng, zone: z, gh5: superOfZone(z, PREC), pallets: o.pallets ?? 2, weight: o.weight ?? 1000, matchKey: id, strict: !!o.strict, miles: o.miles ?? 20, blocksTractor: !!o.blocksTractor };
}

test('restrictionsBlockTractor + driverCanServe: equipment is inviolable', () => {
  assert.equal(restrictionsBlockTractor(['liftgate_required']), false);
  assert.equal(restrictionsBlockTractor(['26ft_max']), true);
  assert.equal(restrictionsBlockTractor(['box_truck_only']), true);
  const tractor = { truck_class: 'tractor' }, box = { truck_class: 'box_truck' };
  assert.equal(driverCanServe(tractor, aStop('x', { blocksTractor: true })), false);
  assert.equal(driverCanServe(box, aStop('x', { blocksTractor: true })), true);
});

test('solveAssignment: never puts a no-tractor stop on a tractor, never exceeds the class skid cap', () => {
  const drivers = [
    { driver_key: 'TRAC', driver_user_name: 'TRAC', driver_name: 'T', truck_class: 'tractor', start_minute: 240, envelope: { ...ENV(9000), driver_key: 'TRAC' }, affinity: new Map() },
    { driver_key: 'BOX', driver_user_name: 'BOX', driver_name: 'B', truck_class: 'box_truck', start_minute: 300, envelope: { ...ENV(6000), driver_key: 'BOX' }, affinity: new Map() },
  ];
  const stops = [
    aStop('r1', { blocksTractor: true, weight: 1500 }),
    aStop('r2', { blocksTractor: true, weight: 1500 }),
    ...Array.from({ length: 10 }, (_, i) => aStop(`s${i}`, { weight: 1500, miles: 10 + i })),
  ];
  const res = solveAssignment({ date: '2026-07-08', stops, drivers, fleetChain: fleetTripChain([], '2026-07-08', CFG), cfg: CFG, depot: { lat: 34.148, lng: -83.959 }, serviceMedianFor: () => 15 });
  // equipment: r1/r2 never on the tractor
  for (const sh of res.shifts) {
    const isTractor = sh.driver.truck_class === 'tractor';
    const cap = isTractor ? CFG.skid_cap_tractor_hard : CFG.skid_cap_box_hard;
    for (const t of sh.trips) {
      for (const s of t.stops) if (s.blocksTractor) assert.ok(!isTractor, `${s.id} must not be on a tractor`);
      // Phase 2.8: each trip's skid-equiv (pallets fallback here) ≤ the CLASS hard cap
      assert.ok(t.stops.reduce((a, x) => a + x.pallets, 0) <= cap + 1e-6, `trip skid load within the ${sh.driver.truck_class} cap`);
    }
  }
  // every stop placed (both drivers can carry the generic freight)
  const placed = res.shifts.flatMap((sh) => sh.trips.flatMap((t) => t.stops.map((s) => s.id)));
  assert.equal(new Set(placed).size + res.unassigned.length, stops.length);
});

test('solveAssignment: a stop no active driver can serve is reported unassigned, not forced', () => {
  const drivers = [{ driver_key: 'TRAC', driver_user_name: 'TRAC', driver_name: 'T', truck_class: 'tractor', start_minute: 240, envelope: { ...ENV(9000), driver_key: 'TRAC' }, affinity: new Map() }];
  const stops = [aStop('needsbox', { blocksTractor: true }), aStop('ok1'), aStop('ok2')];
  const res = solveAssignment({ date: '2026-07-08', stops, drivers, fleetChain: fleetTripChain([], '2026-07-08', CFG), cfg: CFG, depot: { lat: 34.148, lng: -83.959 }, serviceMedianFor: () => 15 });
  assert.deepEqual(res.unassigned.map((s) => s.id), ['needsbox']);
});

test('solveAssignment: deterministic — same input, same plan; and the cap is respected', () => {
  const mk = () => ({
    date: '2026-07-08',
    stops: Array.from({ length: 24 }, (_, i) => aStop(`s${i}`, { weight: 1000 + (i % 5) * 300, miles: 5 + (i % 7) * 6 })),
    drivers: [
      { driver_key: 'A', driver_user_name: 'A', driver_name: 'A', truck_class: 'box_truck', start_minute: 260, envelope: { ...ENV(7000), driver_key: 'A' }, affinity: new Map() },
      { driver_key: 'B', driver_user_name: 'B', driver_name: 'B', truck_class: 'box_truck', start_minute: 300, envelope: { ...ENV(7000), driver_key: 'B' }, affinity: new Map() },
      { driver_key: 'C', driver_user_name: 'C', driver_name: 'C', truck_class: 'tractor', start_minute: 240, envelope: { ...ENV(12000), driver_key: 'C' }, affinity: new Map() },
    ],
    fleetChain: fleetTripChain([], '2026-07-08', CFG), cfg: { ...CFG, assignment_ms_cap: 3000 },
    depot: { lat: 34.148, lng: -83.959 }, serviceMedianFor: () => 12,
  });
  const sig = (r) => r.shifts.map((sh) => `${sh.driver.driver_key}:${sh.trips.map((t) => t.stops.map((s) => s.id).sort().join(',')).join('|')}`).sort().join(';');
  const t0 = Date.now();
  const a = solveAssignment(mk());
  const elapsed = Date.now() - t0;
  const b = solveAssignment(mk());
  assert.equal(sig(a), sig(b), 'deterministic');
  assert.ok(elapsed < 3000 + 2000, `respects the cap (took ${elapsed}ms)`);
});

// ── agreement metrics incl. label swap ───────────────────────────────────────

test('computePlanAgreement: perfect plan → 100% both', () => {
  const actualDrv = new Map([['s1', 'A'], ['s2', 'A'], ['s3', 'B']]);
  const engineDrv = new Map([['s1', 'A'], ['s2', 'A'], ['s3', 'B']]);
  const actualG = new Map([['LA', ['s1', 's2']], ['LB', ['s3']]]);
  const engineG = new Map([['A__1', ['s1', 's2']], ['B__1', ['s3']]]);
  const r = computePlanAgreement(actualDrv, engineDrv, actualG, engineG);
  assert.equal(r.stop_agreement_pct, 100);
  assert.equal(r.coload_agreement_pct, 100);
});

test('computePlanAgreement: LABEL SWAP — coload 100% but stop_agreement 0%', () => {
  // dispatch: {s1,s2,s3}=driver A, {s4,s5}=driver B
  const actualDrv = new Map([['s1', 'A'], ['s2', 'A'], ['s3', 'A'], ['s4', 'B'], ['s5', 'B']]);
  // engine: SAME two load shapes, but swapped onto the other drivers
  const engineDrv = new Map([['s1', 'B'], ['s2', 'B'], ['s3', 'B'], ['s4', 'A'], ['s5', 'A']]);
  const actualG = new Map([['L1', ['s1', 's2', 's3']], ['L2', ['s4', 's5']]]);
  const engineG = new Map([['B__1', ['s1', 's2', 's3']], ['A__1', ['s4', 's5']]]);
  const r = computePlanAgreement(actualDrv, engineDrv, actualG, engineG);
  assert.equal(r.coload_agreement_pct, 100, 'load shapes identical → co-load agreement is total');
  assert.equal(r.coload_precision_pct, 100);
  assert.equal(r.stop_agreement_pct, 0, 'but every stop went to the wrong driver');
});

test('computePlanAgreement: decomposition — right drivers, wrong shape', () => {
  // both stops go to driver A either way (stop agreement 100%), but engine splits
  // them across two trips so the co-load pair is broken (coload 0%).
  const actualDrv = new Map([['s1', 'A'], ['s2', 'A']]);
  const engineDrv = new Map([['s1', 'A'], ['s2', 'A']]);
  const actualG = new Map([['L1', ['s1', 's2']]]);
  const engineG = new Map([['A__1', ['s1']], ['A__2', ['s2']]]);
  const r = computePlanAgreement(actualDrv, engineDrv, actualG, engineG);
  assert.equal(r.stop_agreement_pct, 100);
  assert.equal(r.coload_agreement_pct, 0);
});

test('coloadPairs: pairs within a container only', () => {
  const p = coloadPairs(new Map([['L', ['a', 'b', 'c']]]));
  assert.deepEqual([...p].sort(), ['a|b', 'a|c', 'b|c']);
});
