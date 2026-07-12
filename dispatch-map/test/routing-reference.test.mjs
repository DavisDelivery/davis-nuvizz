// Reference route miner (route DNA) — extraction rules, load identity,
// planned/executed ordering, skip rules, zone_seq collapsing — and the
// reference picker's ranking + STRICT date leakage guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadKeyForStop, sanitizeLoadKey, referenceRouteId,
  extractReferenceRoutes, pickReference,
} from '../netlify/functions/lib/routing-reference.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { shadowScoreRoute, median } from '../netlify/functions/lib/routing-engine-core.mts';
import { zoneId } from '../netlify/functions/lib/zones.mts';
import { buildVehicleRoster, vehicleTypeForStop } from '../netlify/functions/lib/tractor-flags.mts';

const CFG = engineConfigDefaults({});

function mkStop(over = {}) {
  return {
    stopNbr: over.stopNbr || `00${Math.abs(hash(JSON.stringify(over)))}`.slice(0, 9),
    pro: null,
    loadNbr: 'L100',
    routeName: 'DULUTH',
    driverName: 'Brent Boyd',
    driverUserName: 'BBOYD',
    warehouse: 'G6',
    businessName: 'ACME',
    customerMatchKey: 'acme__x',
    lat: 34.10, lng: -84.00,
    routeSeq: 1,
    isPlanned: true, isUnplanned: false, isTerminal: false, isAttempt: false,
    deliveredDTTM: null,
    ...over,
  };
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

function plannedRoute(loadNbr, n, base = { lat: 34.10, lng: -84.00 }) {
  const stops = [];
  for (let i = 1; i <= n; i++) {
    stops.push(mkStop({
      loadNbr, stopNbr: `${loadNbr}-${i}`, pro: `${loadNbr}P${i}`,
      routeSeq: i, lat: base.lat + i * 0.01, lng: base.lng + i * 0.008,
    }));
  }
  return stops;
}

test('loadKey: loadNbr wins; routeName__driverUserName is the fallback; neither → null', () => {
  assert.equal(loadKeyForStop(mkStop({ loadNbr: 'L7' })), 'L7');
  assert.equal(loadKeyForStop(mkStop({ loadNbr: '' })), 'DULUTH__BBOYD');
  assert.equal(loadKeyForStop(mkStop({ loadNbr: '', routeName: '', driverUserName: 'X' })), null);
});

test('doc ids sanitize the loadKey but keep tenant__date__ shape', () => {
  assert.equal(sanitizeLoadKey('DULUTH RT/2__B BOYD'), 'DULUTH_RT_2__B_BOYD');
  assert.equal(referenceRouteId('davis', '2026-07-01', 'L 1/2'), 'davis__2026-07-01__L_1_2');
});

test('planned extraction: routeSeq ascending, zones computed, zone_seq collapsed', () => {
  const stops = plannedRoute('L1', 6);
  // shuffle input order — extraction must re-order by routeSeq
  const shuffledInput = [stops[3], stops[0], stops[5], stops[2], stops[1], stops[4]];
  const { routes, skipped } = extractReferenceRoutes(shuffledInput, { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(skipped.length, 0);
  assert.equal(routes.length, 1);
  const r = routes[0];
  assert.equal(r.source_seq, 'planned');
  assert.deepEqual(r.stops.map((s) => s.pro), ['L1P1', 'L1P2', 'L1P3', 'L1P4', 'L1P5', 'L1P6']);
  assert.deepEqual(r.stops.map((s) => s.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(r.stops[0].zone, zoneId(r.stops[0].lat, r.stops[0].lng));
  // consecutive dupes collapsed
  assert.equal(r.zone_seq.length, new Set(r.zone_seq).size >= 1 ? r.zone_seq.length : -1);
  for (let i = 1; i < r.zone_seq.length; i++) assert.notEqual(r.zone_seq[i], r.zone_seq[i - 1]);
});

test('terminal, unplanned, and attempt rows are excluded', () => {
  const stops = plannedRoute('L2', 5);
  stops.push(mkStop({ loadNbr: 'L2', stopNbr: 'L2-T', routeSeq: 6, isTerminal: true }));
  stops.push(mkStop({ loadNbr: 'L2', stopNbr: 'L2-U', routeSeq: 7, isUnplanned: true, isPlanned: false }));
  stops.push(mkStop({ loadNbr: 'L2', stopNbr: 'L2-A', routeSeq: 8, isAttempt: true }));
  const { routes } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].stop_count, 5);
  assert.ok(!routes[0].stops.some((s) => ['L2-T', 'L2-U', 'L2-A'].includes(s.pro)));
});

test('executed fallback: no usable routeSeq but delivered timestamps on most stops', () => {
  const stops = plannedRoute('L3', 6).map((s, i) => ({
    ...s,
    routeSeq: null,
    deliveredDTTM: `2026-07-01T1${5 - i}:00:00Z`, // delivered in REVERSE build order
  }));
  const { routes } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].source_seq, 'executed');
  assert.deepEqual(routes[0].stops.map((s) => s.pro), ['L3P6', 'L3P5', 'L3P4', 'L3P3', 'L3P2', 'L3P1']);
});

test('skip: fewer than 5 stops', () => {
  const { routes, skipped } = extractReferenceRoutes(plannedRoute('L4', 4), { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(routes.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'too_few_stops');
});

test('skip: missing lat/lng on more than 20% of stops (counts logged)', () => {
  const stops = plannedRoute('L5', 10);
  for (let i = 0; i < 3; i++) stops[i].lat = null; // 30% coordless
  const { routes, skipped } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(routes.length, 0);
  assert.equal(skipped[0].reason, 'missing_coords');
  assert.equal(skipped[0].missing_coords, 3);
});

test('tolerated coordless stops (≤20%) are dropped, not fabricated', () => {
  const stops = plannedRoute('L6', 10);
  stops[4].lng = null; // 10%
  const { routes } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].stop_count, 9);
  assert.ok(!routes[0].stops.some((s) => s.pro === 'L6P5'));
});

test('truck_class joins through the vehicle roster (null when unknown)', () => {
  const roster = buildVehicleRoster([
    { fullName: 'Brent Boyd', vehicleType: 'tractor', externalIds: { nuvizz: 'BBOYD' } },
  ]);
  const stops = plannedRoute('L7', 5);
  const { routes } = extractReferenceRoutes(stops, {
    tenant: 'davis', date: '2026-07-01', cfg: CFG,
    truckClassOf: (s) => vehicleTypeForStop(s, roster),
  });
  assert.equal(routes[0].truck_class, 'tractor');
  const { routes: noJoin } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-01', cfg: CFG });
  assert.equal(noJoin[0].truck_class, null);
});

// ── pickReference ranking + leakage guard ───────────────────────────────────

const zonesOf = (route) => new Set(route.stops.map((s) => s.zone));

function mkRef(over = {}) {
  return {
    date: '2026-06-01', load_key: 'R1', warehouse: 'G6',
    driver_user_name: 'BBOYD', truck_class: 'tractor',
    zone_seq: ['dnh3bx', 'dnh1wq'],
    ...over,
  };
}

test('pickReference: strictly-before dates only (the leakage guard)', () => {
  const target = { date: '2026-07-01', zones: new Set(['dnh3bx', 'dnh1wq']), driverUserName: 'BBOYD', truckClass: 'tractor', warehouse: 'G6', minOverlap: 2 };
  assert.equal(pickReference([mkRef({ date: '2026-07-01' })], target), null); // same day = leakage
  assert.equal(pickReference([mkRef({ date: '2026-07-02' })], target), null); // future = leakage
  assert.ok(pickReference([mkRef({ date: '2026-06-30' })], target));
});

test('pickReference: same warehouse required; overlap below minimum → UNGUIDED', () => {
  const target = { date: '2026-07-01', zones: new Set(['dnh3bx', 'dnh1wq']), driverUserName: 'BBOYD', truckClass: 'tractor', warehouse: 'G6', minOverlap: 2 };
  assert.equal(pickReference([mkRef({ warehouse: 'Z9' })], target), null);
  assert.equal(pickReference([mkRef({ zone_seq: ['dnh3bx', 'xxxxxx'] })], target), null); // only 1 shared
});

test('pickReference: prefers same driver, then same truck class, then shared zones, then recency', () => {
  const target = { date: '2026-07-01', zones: new Set(['z1', 'z2', 'z3', 'z4']), driverUserName: 'BBOYD', truckClass: 'tractor', warehouse: 'G6', minOverlap: 2 };
  const otherDriverMoreZones = mkRef({ load_key: 'A', driver_user_name: 'XX', truck_class: 'box_truck', zone_seq: ['z1', 'z2', 'z3', 'z4'] });
  const sameDriverFewerZones = mkRef({ load_key: 'B', zone_seq: ['z1', 'z2'] });
  assert.equal(pickReference([otherDriverMoreZones, sameDriverFewerZones], target).ref.load_key, 'B');
  // among same-driver candidates: more shared zones wins
  const sameDriverMoreZones = mkRef({ load_key: 'C', zone_seq: ['z1', 'z2', 'z3'] });
  assert.equal(pickReference([sameDriverFewerZones, sameDriverMoreZones], target).ref.load_key, 'C');
  // equal shared zones → most recent wins
  const older = mkRef({ load_key: 'D', date: '2026-05-01', zone_seq: ['z1', 'z2', 'z3'] });
  assert.equal(pickReference([older, sameDriverMoreZones], target).ref.load_key, 'C');
  // no same-driver candidate → same truck class beats other class
  const classOnly = mkRef({ load_key: 'E', driver_user_name: 'YY', zone_seq: ['z1', 'z2'] });
  assert.equal(pickReference([otherDriverMoreZones, classOnly], target).ref.load_key, 'E');
});

// ── replay leakage guard at the core level ───────────────────────────────────

test('shadowScoreRoute never uses a reference dated on/after the target date, even if handed one', () => {
  const stops = plannedRoute('L9', 6);
  const { routes } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-10', cfg: CFG });
  const route = routes[0];
  // A "perfect" reference — same zones, same driver — but dated the SAME day,
  // and another dated in the future. Both must be ignored → UNGUIDED.
  const sameDay = { ...route, date: '2026-07-10' };
  const future = { ...route, date: '2026-08-01' };
  const res = shadowScoreRoute(route, [sameDay, future], CFG);
  assert.equal(res.unguided, true);
  assert.equal(res.proposal.reference_route_id, null);
  // With a genuinely earlier reference it guides.
  const earlier = { ...route, date: '2026-07-01' };
  const guided = shadowScoreRoute(route, [sameDay, future, earlier], CFG);
  assert.equal(guided.unguided, false);
  assert.equal(guided.proposal.reference_date, '2026-07-01');
});

test('shadowScoreRoute: proposal doc shape, exact-match score 0, engine version stamped', () => {
  const stops = plannedRoute('L10', 8);
  const { routes } = extractReferenceRoutes(stops, { tenant: 'davis', date: '2026-07-10', cfg: CFG });
  const route = routes[0];
  const earlier = { ...route, date: '2026-07-01' };
  const res = shadowScoreRoute(route, [earlier], CFG, '2026-07-11T07:30:00Z');
  const p = res.proposal;
  assert.equal(p.tenant, 'davis');
  assert.equal(p.date, '2026-07-10');
  assert.equal(p.load_key, 'L10');
  assert.equal(p.stop_count, 8);
  assert.equal(p.actual_seq.length, 8);
  assert.equal(p.proposed_seq.length, 8);
  assert.deepEqual([...p.proposed_seq].sort(), [...p.actual_seq].sort());
  assert.equal(typeof p.score, 'number');
  assert.ok(p.travel_min_actual_est > 0 && p.travel_min_proposed_est > 0);
  assert.equal(p.engine_version, '2.0.0'); // bumped in Phase 2 (stamped on all proposal docs)
  assert.equal(p.computed_at, '2026-07-11T07:30:00Z');
  assert.equal(p.stops[0].actual_pos, 1);
  assert.ok(p.stops.every((s) => Number.isInteger(s.proposed_pos)));
  // The reference IS this route (older copy) and stops are a straight line, so
  // the engine should reproduce dispatch exactly → official score 0.
  assert.equal(p.score, 0);
  assert.deepEqual(p.proposed_seq, p.actual_seq);
});

test('median helper', () => {
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 2, 4, 8]), 3);
  assert.equal(median([5, 1, 9]), 5);
});
