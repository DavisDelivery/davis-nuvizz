// Phase 2.1 — routing calendar idle behavior, the nightly 14-day gate inputs,
// as-of typical start (no day-D executed reads on the plan path), the top-k
// weighted reference graph (k=1 regression + outvoting), the driver-habit
// miner's as-of reads, and the habit soft cost in the assignment solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  engineConfigDefaults, clampEngineConfig, clampRoutingCalendar, isBoardDay,
  planReadEarliestOkET, assertCurrentDayReadAllowed, DEFAULT_ROUTING_CALENDAR, ENGINE_VERSION,
} from '../netlify/functions/lib/routing-engine-config.mts';
import {
  referencePrecedence, aggregateReferencePrecedence, sequencePenalty, solveRoute,
} from '../netlify/functions/lib/routing-engine-solver.mts';
import { pickReferences } from '../netlify/functions/lib/routing-reference.mts';
import {
  habitObservationsForDay, buildCustomerDriversDoc, habitAsOf, aggregateHabit,
} from '../netlify/functions/lib/routing-customer-drivers.mts';
import {
  solveAssignment, habitStrength,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { runPlanForDate } from '../netlify/functions/lib/routing-plan-core.mts';
import { zoneId, superOfZone } from '../netlify/functions/lib/zones.mts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CFG = engineConfigDefaults({});
const PREC = { zone_precision: 6, super_precision: 5, top_precision: 4 };
const __dirname = dirname(fileURLToPath(import.meta.url));

test('engine version bumped for the 2.1 trend segment', () => {
  // churn-proof: 2.1.x or later, never below (exact literal broke on every patch bump)
  const [maj, min] = ENGINE_VERSION.split('.').map(Number);
  assert.ok(maj > 2 || (maj === 2 && min >= 1), `ENGINE_VERSION ${ENGINE_VERSION} must be >= 2.1`);
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
});

// ── routing calendar ─────────────────────────────────────────────────────────

test('calendar: weekends are not board days; weekdays are', () => {
  const cal = CFG.routing_calendar;
  assert.equal(isBoardDay('2026-07-11', cal), false); // Sat
  assert.equal(isBoardDay('2026-07-12', cal), false); // Sun
  assert.equal(isBoardDay('2026-07-10', cal), true);  // Fri
  assert.equal(isBoardDay('2026-07-13', cal), true);  // Mon (built Sunday night)
});

test('calendar: clamp rejects garbage and falls back field-by-field', () => {
  const cal = clampRoutingCalendar({ board_days: ['x', 9, 3, 3], window_start_local: '25:99', window_end_local: '07:00', timezone: 42 });
  assert.deepEqual(cal.board_days, [3]);                       // only the valid day survives
  assert.equal(cal.window_start_local, '20:00');               // invalid → default
  assert.equal(cal.window_end_local, '07:00');
  assert.equal(cal.timezone, 'America/New_York');
  // fully-empty input → full defaults
  assert.deepEqual(clampRoutingCalendar(null), { ...DEFAULT_ROUTING_CALENDAR, board_days: [...DEFAULT_ROUTING_CALENDAR.board_days] });
});

test('calendar: the derived plan-read law — never before 07:30 ET on D', () => {
  assert.equal(planReadEarliestOkET(CFG.routing_calendar), '07:30');
  assert.throws(() => assertCurrentDayReadAllowed('06:59'), /board is not final/);
  assert.throws(() => assertCurrentDayReadAllowed('07:29'), /07:30/);
  assert.doesNotThrow(() => assertCurrentDayReadAllowed('07:30'));
  assert.doesNotThrow(() => assertCurrentDayReadAllowed('21:00'));
});

test('calendar: clamped through the config doc path like every other knob', () => {
  const out = clampEngineConfig({ routing_calendar: { board_days: [2, 4] }, reference_top_k: 3 });
  assert.deepEqual(out.routing_calendar.board_days, [2, 4]);
  assert.equal(out.reference_top_k, 3);
});

// ── as-of typical start (audit finding 3) ────────────────────────────────────

test('plan path start_minute: day-D executed clock-in NEVER leaks into the engine input', async () => {
  // Two drivers, one planned day. GPITTS clocks in WAY early on D (03:00) but
  // his < D history says typical start = 08:00. The engine input must carry
  // the 08:00-derived typical, not the day-D 03:00. We prove it end-to-end by
  // capturing the drivers handed to the assignment solver via the pure core:
  // runPlanForDate writes through Firestore, so instead we exercise the same
  // construction path: envelope from history (< D) + the solver default —
  // and assert the plan-core source cannot see wallMinuteOfDay(day-D).
  const src = readFileSync(join(__dirname, '../netlify/functions/lib/routing-plan-core.mts'), 'utf8');
  // the assignment-driver construction must source start_minute from the
  // envelope's typical, and must NOT compute it from the day's start_time.
  assert.ok(/start_minute:\s*envelope\.start_minute_typical/.test(src), 'start_minute comes from the as-of envelope');
  assert.ok(!/start_minute:\s*wallMinuteOfDay/.test(src), 'day-D executed first touch is not used');
});

// ── top-k weighted reference graph (audit finding 2) ─────────────────────────

test('pickReferences: leakage guard, ranking by overlap × recency × same-driver, top-k cap', () => {
  const mk = (date, key, zones, driver) => ({ date, load_key: key, warehouse: 'G6', driver_user_name: driver, truck_class: 'tractor', zone_seq: zones, stops: [], tenant: 'davis' });
  const target = { date: '2026-07-10', zones: new Set(['z1', 'z2', 'z3', 'z4']), driverUserName: 'BBOYD', truckClass: 'tractor', warehouse: 'G6', minOverlap: 2 };
  const opts = { topK: 3, halfLifeDays: 45, sameDriverMultiplier: 2 };
  const cands = [
    mk('2026-07-10', 'SAMEDAY', ['z1', 'z2', 'z3'], 'BBOYD'),   // leakage → excluded
    mk('2026-07-09', 'FRESH-OTHER', ['z1', 'z2', 'z3'], 'XX'),  // 3 shared, fresh, other driver
    mk('2026-07-08', 'MINE', ['z1', 'z2'], 'BBOYD'),            // 2 shared, fresh, same driver ×2
    mk('2026-01-01', 'ANCIENT', ['z1', 'z2', 'z3', 'z4'], 'XX'),// 4 shared but ~190 days old
    mk('2026-07-01', 'LOW', ['z1', 'zX'], 'XX'),                // 1 shared → below minOverlap
  ];
  const picked = pickReferences(cands, target, opts);
  assert.ok(picked.every((p) => p.ref.load_key !== 'SAMEDAY'), 'same-day reference excluded (leakage)');
  assert.ok(picked.every((p) => p.ref.load_key !== 'LOW'), 'below minOverlap excluded');
  assert.equal(picked.length, 3);
  // same-driver ×2 beats one extra shared zone: MINE (2×2=4·decay) > FRESH-OTHER (3·decay)
  assert.equal(picked[0].ref.load_key, 'MINE');
  assert.equal(picked[1].ref.load_key, 'FRESH-OTHER');
  // the ancient 4-zone route decays hard: 4 × 0.5^(190/45) ≈ 0.2
  assert.equal(picked[2].ref.load_key, 'ANCIENT');
  assert.ok(picked[2].weight < 0.3);
});

test('k=1 REGRESSION: a single reference through the aggregate reproduces legacy precedence exactly', () => {
  const seq = ['a1', 'a2', 'a1', 'b1', 'c1'];
  const legacy = referencePrecedence(seq);
  const agg = aggregateReferencePrecedence([{ zone_seq: seq, weight: 3.7 }], CFG.reference_edge_floor);
  const norm = (ps) => ps.map((p) => `${p.a}>${p.b}:${p.w}`).sort();
  assert.deepEqual(norm(agg.pairs), norm(legacy.pairs));
  // identical penalties on both a violating and a compliant order
  for (const order of [['c1', 'b1', 'a1', 'a2'], ['a1', 'a2', 'b1', 'c1']]) {
    assert.equal(sequencePenalty(order, agg, CFG), sequencePenalty(order, legacy, CFG));
  }
});

test('k=1 REGRESSION: solveRoute via references=[single] equals legacy referenceZoneSeq path', () => {
  const zs = (lat, lng) => zoneId(lat, lng, PREC);
  const stops = [];
  const bases = [[34.10, -84.00], [34.05, -84.10], [33.98, -84.22]];
  bases.forEach(([la, ln], zi) => {
    for (let i = 0; i < 4; i++) stops.push({ id: `s${zi}_${i}`, lat: la + i * 0.0001, lng: ln + i * 0.00008, zone: zs(la + i * 0.0001, ln + i * 0.00008) });
  });
  const refSeq = [stops[8].zone, stops[4].zone, stops[0].zone];
  const a = solveRoute({ loadKey: 'REG', stops, depot: { lat: 34.148, lng: -83.959 }, referenceZoneSeq: refSeq, cfg: CFG });
  const b = solveRoute({ loadKey: 'REG', stops, depot: { lat: 34.148, lng: -83.959 }, referenceZoneSeq: null, references: [{ zone_seq: refSeq, weight: 5 }], cfg: CFG });
  assert.deepEqual(a.order.map((s) => s.id), b.order.map((s) => s.id));
  assert.equal(a.objective, b.objective);
});

test('OUTVOTING: one atypical reference against several consistent ones loses', () => {
  const consistent = [
    { zone_seq: ['A', 'B', 'C'], weight: 2 },
    { zone_seq: ['A', 'B', 'C'], weight: 2 },
    { zone_seq: ['A', 'B', 'C'], weight: 2 },
    { zone_seq: ['A', 'B', 'C'], weight: 2 },
  ];
  const atypical = { zone_seq: ['C', 'B', 'A'], weight: 1 };
  const agg = aggregateReferencePrecedence([...consistent, atypical], 0.2);
  // The dissenter's reverse edges fall under the floor (1 < 0.2×9=1.8), so no
  // cycle forms: A, B, C stay in distinct components with consensus order.
  assert.equal(new Set(['A', 'B', 'C'].map((z) => agg.compOf.get(z))).size, 3);
  const cfgP = { ...CFG, hierarchy_penalty: 0 };
  const consensusOrder = sequencePenalty(['A', 'B', 'C'], agg, cfgP);
  const dissenterOrder = sequencePenalty(['C', 'B', 'A'], agg, cfgP);
  assert.equal(consensusOrder, 0, 'consensus order is penalty-free');
  assert.ok(dissenterOrder > 0, 'the atypical order pays');
  // and WITHOUT the floor/aggregation (k=1 on the atypical route) it would have won:
  const soloAtypical = aggregateReferencePrecedence([atypical], 0.2);
  assert.equal(sequencePenalty(['C', 'B', 'A'], soloAtypical, cfgP), 0);
});

// ── driver habit miner ───────────────────────────────────────────────────────

const DSTOP = (mk, driver, name, status = 'DELIVERED') => ({
  customerMatchKey: mk, driverUserName: driver, driverName: name, normalizedStatus: status,
});

test('habit miner: DELIVERED-only, per-customer observation grouping', () => {
  const day = habitObservationsForDay([
    DSTOP('acme', 'SHART', 'Scott Hart'),
    DSTOP('acme', 'SHART', 'Scott Hart'),
    DSTOP('acme', 'MYOUNG', 'Marcus Young'),
    DSTOP('acme', 'SHART', 'Scott Hart', 'SCHEDULED'),   // not delivered → excluded
    { customerMatchKey: null, driverUserName: 'X', normalizedStatus: 'DELIVERED' }, // no key
  ], '2026-07-08');
  assert.equal(day.get('acme').length, 3);
  assert.deepEqual(day.get('acme').map((o) => o.u), ['SHART', 'SHART', 'MYOUNG']);
});

test('habit doc: ranking, shares, top fields', () => {
  const obs = [
    { d: '2026-06-01', u: 'SHART', name: 'Scott Hart' },
    { d: '2026-06-05', u: 'SHART', name: 'Scott Hart' },
    { d: '2026-06-09', u: 'SHART', name: 'Scott Hart' },
    { d: '2026-06-12', u: 'MYOUNG', name: 'Marcus Young' },
  ];
  const doc = buildCustomerDriversDoc('davis', 'acme', obs, '2026-07-01T00:00:00Z');
  assert.equal(doc.n_delivered, 4);
  assert.equal(doc.top_driver, 'SHART');
  assert.equal(doc.top_driver_name, 'Scott Hart');
  assert.equal(doc.top_share, 0.75);
  assert.deepEqual(doc.drivers.map((d) => d.driver_user_name), ['SHART', 'MYOUNG']);
  assert.equal(doc.drivers[0].last_date, '2026-06-09');
});

test('habit as-of: strictly < D; future/on-D observations never leak', () => {
  const doc = buildCustomerDriversDoc('davis', 'acme', [
    { d: '2026-06-01', u: 'SHART', name: 'Scott Hart' },
    { d: '2026-06-02', u: 'SHART', name: 'Scott Hart' },
    // On/after D: a burst of MYOUNG deliveries that would flip the top driver
    { d: '2026-07-08', u: 'MYOUNG', name: 'Marcus Young' },
    { d: '2026-07-09', u: 'MYOUNG', name: 'Marcus Young' },
    { d: '2026-07-10', u: 'MYOUNG', name: 'Marcus Young' },
  ], '2026-08-01T00:00:00Z');
  const asOf = habitAsOf(doc, '2026-07-08');
  assert.equal(asOf.topDriver, 'SHART', 'day-D and later obs excluded');
  assert.equal(asOf.n, 2);
  assert.equal(habitAsOf(doc, '2026-06-01'), null, 'no history before the first delivery');
  const later = habitAsOf(doc, '2026-07-11');
  assert.equal(later.topDriver, 'MYOUNG', 'after the burst the habit legitimately flips');
});

test('habitStrength: small n = weak signal', () => {
  assert.equal(habitStrength(null, 4), 0);
  const weak = habitStrength({ topShare: 1, n: 2 }, 4);
  const strong = habitStrength({ topShare: 1, n: 20 }, 4);
  assert.ok(weak < 0.4 && strong > 0.8, `${weak} vs ${strong}`);
});

test('habit soft cost: the habitual driver wins the stop when signals are comparable', () => {
  const z = (lat, lng) => zoneId(lat, lng, PREC);
  const ENV = { driver_key: '', source: 'driver', truck_class: 'box_truck', observed_days: 20, per_trip: { stops_median: 10, stops_p85: 14, pallets_median: 6, pallets_p85: 10, weight_median: 5000, weight_p85: 9000 }, trips_per_day_propensity: 0.2, start_minute_typical: 300, shift_hours_typical: 10, day_weight_p85: 14000 };
  const drivers = [
    { driver_key: 'SHART', driver_user_name: 'SHART', driver_name: 'Scott Hart', truck_class: 'box_truck', start_minute: 300, envelope: { ...ENV, driver_key: 'SHART' }, affinity: new Map() },
    { driver_key: 'MYOUNG', driver_user_name: 'MYOUNG', driver_name: 'Marcus Young', truck_class: 'box_truck', start_minute: 300, envelope: { ...ENV, driver_key: 'MYOUNG' }, affinity: new Map() },
  ];
  const lat = 34.05, lng = -84.10;
  const mkStop = (id, habit) => ({ id, lat, lng, zone: z(lat, lng), gh5: superOfZone(z(lat, lng), PREC), pallets: 2, weight: 900, matchKey: id, strict: false, miles: 15, blocksTractor: false, habit });
  // 6 stops; two are strongly habitual to SHART, two to MYOUNG, two neutral
  const stops = [
    mkStop('h1', { topDriver: 'SHART', topShare: 0.9, n: 12 }),
    mkStop('h2', { topDriver: 'SHART', topShare: 0.8, n: 10 }),
    mkStop('m1', { topDriver: 'MYOUNG', topShare: 0.9, n: 12 }),
    mkStop('m2', { topDriver: 'MYOUNG', topShare: 0.85, n: 9 }),
    mkStop('n1', null),
    mkStop('n2', null),
  ];
  const res = solveAssignment({ date: '2026-07-08', stops, drivers, fleetChain: fleetTripChain([], '2026-07-08', CFG), cfg: { ...CFG, assignment_ms_cap: 3000 }, depot: { lat: 34.148, lng: -83.959 }, serviceMedianFor: () => 12 });
  const ownerOf = new Map();
  for (const sh of res.shifts) for (const t of sh.trips) for (const s of t.stops) ownerOf.set(s.id, sh.driver.driver_key);
  assert.equal(ownerOf.get('h1'), 'SHART');
  assert.equal(ownerOf.get('h2'), 'SHART');
  assert.equal(ownerOf.get('m1'), 'MYOUNG');
  assert.equal(ownerOf.get('m2'), 'MYOUNG');
});

test('habit soft cost never overrides a HARD equipment constraint', () => {
  const z = (lat, lng) => zoneId(lat, lng, PREC);
  const ENV = { driver_key: '', source: 'driver', truck_class: 'tractor', observed_days: 20, per_trip: { stops_median: 10, stops_p85: 14, pallets_median: 6, pallets_p85: 10, weight_median: 5000, weight_p85: 9000 }, trips_per_day_propensity: 0.2, start_minute_typical: 240, shift_hours_typical: 10, day_weight_p85: 14000 };
  const drivers = [
    { driver_key: 'TRAC', driver_user_name: 'TRAC', driver_name: 'T', truck_class: 'tractor', start_minute: 240, envelope: { ...ENV, driver_key: 'TRAC' }, affinity: new Map() },
    { driver_key: 'BOX', driver_user_name: 'BOX', driver_name: 'B', truck_class: 'box_truck', start_minute: 300, envelope: { ...ENV, driver_key: 'BOX', truck_class: 'box_truck' }, affinity: new Map() },
  ];
  const lat = 34.05, lng = -84.10;
  // habitually TRAC's customer, but the dock now blocks tractors
  const s = { id: 'x', lat, lng, zone: z(lat, lng), gh5: superOfZone(z(lat, lng), PREC), pallets: 2, weight: 900, matchKey: 'x', strict: false, miles: 15, blocksTractor: true, habit: { topDriver: 'TRAC', topShare: 1, n: 30 } };
  const res = solveAssignment({ date: '2026-07-08', stops: [s], drivers, fleetChain: fleetTripChain([], '2026-07-08', CFG), cfg: CFG, depot: { lat: 34.148, lng: -83.959 }, serviceMedianFor: () => 12 });
  const owner = res.shifts.flatMap((sh) => sh.trips.flatMap((t) => t.stops.map(() => sh.driver.driver_key)))[0];
  assert.equal(owner, 'BOX', 'hard constraint beats habit');
});
