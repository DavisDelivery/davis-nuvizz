// The learned routing engine's solver — zone-graph/SCC precedence extraction,
// penalty math, HARD zone clustering (a proposed order never splits a zone),
// and deterministic reruns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPOT_ID, haversineMiles, travelMinutesForMiles, buildTravelMatrix,
  referencePrecedence, sequencePenalty, tourObjective, travelMinutesForOrder,
  seedFromKey, mulberry32, solveRoute,
} from '../netlify/functions/lib/routing-engine-solver.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { collapseConsecutive } from '../netlify/functions/lib/zones.mts';

const CFG = engineConfigDefaults({});
const DEPOT = { lat: 34.14838, lng: -83.95948 };

// Synthetic geometry: three tight clusters (zones) at increasing distance from
// the depot, using REAL geohash-6 zones so hierarchy slicing works.
import { zoneId } from '../netlify/functions/lib/zones.mts';
function cluster(baseLat, baseLng, n, tag) {
  const stops = [];
  for (let i = 0; i < n; i++) {
    const lat = baseLat + i * 0.0001;
    const lng = baseLng + i * 0.00008;
    stops.push({ id: `${tag}${i + 1}`, lat, lng, zone: zoneId(lat, lng) });
  }
  return stops;
}
const ZA = cluster(34.10, -84.00, 4, 'A');
const ZB = cluster(34.05, -84.10, 4, 'B');
const ZC = cluster(33.98, -84.22, 4, 'C');
const STOPS = [...ZA, ...ZB, ...ZC];
const zoneA = ZA[0].zone, zoneB = ZB[0].zone, zoneC = ZC[0].zone;
// Geometry assumption: each synthetic cluster fits inside ONE geohash-6 cell.
for (const [tag, zs] of [['A', ZA], ['B', ZB], ['C', ZC]]) {
  assert.equal(new Set(zs.map((s) => s.zone)).size, 1, `cluster ${tag} straddles a cell`);
}

test('travel model: tiered speeds and road factor', () => {
  // 1 mile straight-line < 3 mi tier → 22 mph over 1.35 road-miles
  assert.ok(Math.abs(travelMinutesForMiles(1, CFG) - (1.35 / 22) * 60) < 1e-9);
  // 5 miles → 35 mph tier; 20 miles → 48 mph tier
  assert.ok(Math.abs(travelMinutesForMiles(5, CFG) - (5 * 1.35 / 35) * 60) < 1e-9);
  assert.ok(Math.abs(travelMinutesForMiles(20, CFG) - (20 * 1.35 / 48) * 60) < 1e-9);
});

test('haversine sanity: ~69 miles per degree of latitude', () => {
  const mi = haversineMiles(34.0, -84.0, 35.0, -84.0);
  assert.ok(mi > 68 && mi < 70, String(mi));
});

test('precedence extraction: simple path → one pair per edge', () => {
  const prec = referencePrecedence(['z1', 'z2', 'z3']);
  assert.equal(prec.compSeq.length, 3);
  assert.equal(prec.pairs.length, 2);
  // all three zones in distinct components, ordered
  const c1 = prec.compOf.get('z1'), c2 = prec.compOf.get('z2'), c3 = prec.compOf.get('z3');
  assert.deepEqual(prec.pairs, [[c1, c2], [c2, c3]]);
});

test('precedence extraction: a zone ping-pong collapses into one SCC (Tarjan contraction)', () => {
  // z1 → z2 → z1 → z3: z1 and z2 form a cycle → same component; z3 follows.
  const prec = referencePrecedence(['z1', 'z2', 'z1', 'z3']);
  assert.equal(prec.compOf.get('z1'), prec.compOf.get('z2'));
  assert.notEqual(prec.compOf.get('z1'), prec.compOf.get('z3'));
  assert.equal(prec.compSeq.length, 2);
  assert.deepEqual(prec.pairs, [[prec.compOf.get('z1'), prec.compOf.get('z3')]]);
});

test('penalty math: precedence violations count 1 per out-of-order pair', () => {
  const prec = referencePrecedence([zoneA, zoneB, zoneC]);
  const cfgFlatHier = { ...CFG, hierarchy_penalty: 0 };
  assert.equal(sequencePenalty([zoneA, zoneB, zoneC], prec, cfgFlatHier), 0);
  // B before A violates A<B only
  assert.equal(sequencePenalty([zoneB, zoneA, zoneC], prec, cfgFlatHier), 1 * CFG.precedence_penalty);
  // C, B, A violates both pairs
  assert.equal(sequencePenalty([zoneC, zoneB, zoneA], prec, cfgFlatHier), 2 * CFG.precedence_penalty);
});

test('penalty math: hierarchy charges (entries − distinct) × 10 per level', () => {
  // Re-entering a zone: seq [a, b, a] at zone level → 3 entries, 2 distinct → +10.
  // Supers/tops of a and b may or may not differ; use zones from the same super
  // so only the zone level ping-pongs.
  const a = zoneA;
  const sibling = a.slice(0, 5) + (a[5] === '0' ? '1' : '0'); // same super, different zone
  const cfg = { ...CFG, precedence_penalty: 0 };
  const clean = sequencePenalty([a, sibling], null, cfg);
  const pingpong = sequencePenalty([a, sibling, a], null, cfg);
  assert.equal(pingpong - clean, CFG.hierarchy_penalty);
});

test('penalty math: super-level ping-pong is charged even when zones are distinct', () => {
  // zones from supers S1, S2, S1 — zone level is clean (3 distinct), super level
  // re-enters S1 → exactly one hierarchy unit (plus top level if it also flips).
  const s1zoneA = zoneA;
  const s1zoneB = zoneA.slice(0, 5) + (zoneA[5] === '0' ? '1' : '0');
  const far = zoneC; // different super AND different top? make sure
  assert.notEqual(far.slice(0, 5), zoneA.slice(0, 5));
  const cfg = { ...CFG, precedence_penalty: 0 };
  const clean = sequencePenalty([s1zoneA, s1zoneB, far], null, cfg);
  const split = sequencePenalty([s1zoneA, far, s1zoneB], null, cfg);
  assert.ok(split > clean, `${split} > ${clean}`);
});

test('HARD clustering: the solver NEVER splits a zone', () => {
  const res = solveRoute({
    loadKey: 'LOAD-HARD-1',
    stops: STOPS,
    depot: DEPOT,
    referenceZoneSeq: [zoneC, zoneA, zoneB],
    cfg: CFG,
  });
  assert.equal(res.order.length, STOPS.length);
  assert.deepEqual([...res.order.map((s) => s.id)].sort(), STOPS.map((s) => s.id).sort());
  const zoneSeq = collapseConsecutive(res.order.map((s) => s.zone));
  assert.equal(zoneSeq.length, new Set(zoneSeq).size, `zone split detected: ${zoneSeq.join(',')}`);
});

test('HARD clustering: big-M objective makes ANY split tour strictly worse', () => {
  const matrix = buildTravelMatrix([{ id: DEPOT_ID, ...DEPOT }, ...STOPS], CFG);
  const contiguous = [...ZA, ...ZB, ...ZC];
  const split = [...ZA.slice(0, 2), ...ZB, ...ZA.slice(2), ...ZC]; // zone A split in two runs
  const okObj = tourObjective(contiguous, matrix, null, CFG);
  const splitObj = tourObjective(split, matrix, null, CFG);
  assert.equal(okObj.splits, 0);
  assert.equal(splitObj.splits, 1);
  assert.ok(splitObj.objective > okObj.objective + CFG.big_m_min / 2);
});

test('guided solve follows the reference zone order when travel allows', () => {
  // Reference says C then B then A — the penalty multiplier (1500/violation)
  // dwarfs the travel differences at this scale, so the solver should comply.
  const res = solveRoute({
    loadKey: 'LOAD-GUIDED-1',
    stops: STOPS,
    depot: DEPOT,
    referenceZoneSeq: [zoneC, zoneB, zoneA],
    cfg: CFG,
  });
  assert.equal(res.unguided, false);
  assert.deepEqual(res.zoneOrder, [zoneC, zoneB, zoneA]);
  assert.equal(res.penalty, 0);
});

test('unguided solve still clusters and visits all stops', () => {
  const res = solveRoute({
    loadKey: 'LOAD-UNGUIDED-1',
    stops: STOPS,
    depot: DEPOT,
    referenceZoneSeq: null,
    cfg: CFG,
  });
  assert.equal(res.unguided, true);
  assert.equal(res.order.length, STOPS.length);
  const zoneSeq = collapseConsecutive(res.order.map((s) => s.zone));
  assert.equal(zoneSeq.length, new Set(zoneSeq).size);
  // Nearest zone from the depot is A (closest cluster) — sane start.
  assert.equal(res.order[0].zone, zoneA);
});

test('deterministic: same loadKey → identical proposal on rerun', () => {
  const run = () => solveRoute({
    loadKey: 'LOAD-DET-1', stops: STOPS, depot: DEPOT,
    referenceZoneSeq: [zoneB, zoneA], cfg: CFG,
  });
  const a = run(), b = run();
  assert.deepEqual(a.order.map((s) => s.id), b.order.map((s) => s.id));
  assert.equal(a.objective, b.objective);
});

test('seeded RNG is stable', () => {
  const r1 = mulberry32(seedFromKey('LOAD-123'));
  const r2 = mulberry32(seedFromKey('LOAD-123'));
  for (let i = 0; i < 5; i++) assert.equal(r1(), r2());
  assert.notEqual(mulberry32(seedFromKey('LOAD-124'))(), mulberry32(seedFromKey('LOAD-123'))());
});

test('travelMinutesForOrder anchors at the depot', () => {
  const matrix = buildTravelMatrix([{ id: DEPOT_ID, ...DEPOT }, ...ZA], CFG);
  const t = travelMinutesForOrder(ZA, matrix);
  assert.ok(t > 0);
  // First leg is depot → A1, present in the matrix
  assert.ok(t >= matrix[DEPOT_ID]['A1']);
});
