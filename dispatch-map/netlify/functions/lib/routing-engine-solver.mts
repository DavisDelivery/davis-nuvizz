// lib/routing-engine-solver.mts
//
// THE SOLVER for the learned routing engine (Phase 1 — shadow). Adapts the
// winning recipe from the Amazon/MIT Last Mile Routing Research Challenge
// (heldstephan/jpt-amz, MIT license) to Davis-scale routes:
//
//   (a) stops cluster into zones (geohash prefixes) — same-zone stops are
//       consecutive as a HARD constraint;
//   (b) the ZONE ORDER is learned from the most similar historical route (the
//       reference) and encoded as precedence constraints: build the reference's
//       zone graph (edge a→b when a immediately precedes b), contract strongly
//       connected components (Tarjan), and require visit(a) < visit(b) along
//       the contracted component path — 1 penalty per violated pair;
//   (c) zones group into a hierarchy (super/top geohash prefixes); orderings
//       that re-enter a super/top they already left are penalized
//       (entries − distinct) × hierarchy_penalty at each level;
//   (d) a penalty-aware local search minimizes
//       travel_min + penalty_multiplier × penalty.
//
// Davis routes are 15–45 stops / 4–12 zones, so instead of porting LKH
// internals the search is two-level: (outer) zone-order moves — relocate a
// zone, swap adjacent zones, relocate a short zone block with no segment
// reversal; (inner) within-zone Or-opt + 2-opt over the asymmetric estimated
// costs. Iterate to a local optimum, keep the best of `restarts` randomized
// restarts, seeded deterministically from the loadKey so reruns reproduce.
// Hard wall-clock cap per route (config solver_ms_cap, ~1s).
//
// Travel times are ESTIMATES ONLY: haversine miles × road_factor and a tiered
// speed model from routing_engine_config. ZERO Google Route Matrix calls, ZERO
// NuVizz calls — sequence similarity is driven by constraint structure, not
// travel-time precision. Same-zone stops are consecutive BY CONSTRUCTION in
// the two-level representation; the classic big-M cross-zone edge charge is
// still exposed in tourObjective() so tests (and any generic search) can prove
// a split tour always loses.
//
// Everything here is PURE (no I/O). The nightly job feeds it warehouse data.

import type { EngineConfig } from './routing-engine-config.mts';
import type { CostMatrix } from './score.mts';
import { collapseConsecutive, superOfZone, topOfZone, type ZonePrecisions } from './zones.mts';

export const DEPOT_ID = '__depot__';

export interface EnginePoint { id: string; lat: number; lng: number }
export interface EngineStop extends EnginePoint { zone: string }

// ── Travel-time estimator ────────────────────────────────────────────────────

const EARTH_RADIUS_MI = 3958.7613;

export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Speed tier is picked from the straight-line leg length; the road factor then
// stretches the distance actually driven at that speed.
export function travelMinutesForMiles(miles: number, cfg: EngineConfig): number {
  const mph = miles < cfg.short_break_mi ? cfg.speed_short_mph
    : miles <= cfg.long_break_mi ? cfg.speed_mid_mph
    : cfg.speed_long_mph;
  return ((miles * cfg.road_factor) / mph) * 60;
}

// Full (asymmetric-capable) minutes matrix over the given points. Haversine is
// symmetric, but every consumer treats the matrix as directional so a smarter
// estimator can drop in without touching the search or the scoring.
export function buildTravelMatrix(points: EnginePoint[], cfg: EngineConfig): CostMatrix {
  const mat: CostMatrix = {};
  for (const a of points) {
    mat[a.id] = {};
    for (const b of points) {
      mat[a.id][b.id] = a.id === b.id ? 0
        : travelMinutesForMiles(haversineMiles(a.lat, a.lng, b.lat, b.lng), cfg);
    }
  }
  return mat;
}

// ── Reference precedence (zone graph → Tarjan SCC → component path) ─────────

export interface PrecedencePair { a: number; b: number; w: number } // visit(a)<visit(b), weight 0..1

export interface ReferencePrecedence {
  compOf: Map<string, number>;      // reference zone → component index
  compSeq: number[];                // components in visit order (single-ref path; empty for aggregates)
  pairs: PrecedencePair[];          // weighted precedence pairs (single-ref pairs carry w=1)
}

// Tarjan strongly connected components over a small digraph.
function tarjanScc(nodes: string[], edges: Map<string, Set<string>>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const compOf = new Map<string, number>();
  let counter = 0;
  let compCount = 0;

  const strongConnect = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) || []) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = compCount++;
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        compOf.set(w, comp);
        if (w === v) break;
      }
    }
  };

  for (const v of nodes) if (!index.has(v)) strongConnect(v);
  return compOf;
}

// Build precedence from a reference zone visit sequence (consecutive dupes
// already collapsed or not — collapsed again here). Zones that ping-pong in
// the reference end up in one SCC and impose no order among themselves; the
// contracted components form a path (re-entering a left component would merge
// it), and each consecutive pair of that path becomes a visit(a)<visit(b)
// constraint.
export function referencePrecedence(refZoneSeq: string[]): ReferencePrecedence {
  const seq = collapseConsecutive(refZoneSeq || []);
  const nodes = [...new Set(seq)];
  const edges = new Map<string, Set<string>>();
  for (const n of nodes) edges.set(n, new Set());
  for (let i = 1; i < seq.length; i++) {
    if (seq[i - 1] !== seq[i]) edges.get(seq[i - 1])!.add(seq[i]);
  }
  const compOf = tarjanScc(nodes, edges);
  const compSeq: number[] = [];
  for (const z of seq) {
    const c = compOf.get(z)!;
    if (compSeq.length === 0 || compSeq[compSeq.length - 1] !== c) compSeq.push(c);
  }
  const pairs: PrecedencePair[] = [];
  for (let i = 1; i < compSeq.length; i++) pairs.push({ a: compSeq[i - 1], b: compSeq[i], w: 1 });
  return { compOf, compSeq, pairs };
}

// ── Phase 2.1: TOP-K WEIGHTED AGGREGATE PRECEDENCE (audit finding 2) ─────────
// The winners learned zone order from a weighted transition graph over MANY
// historical routes; the single-reference path above is the k=1 special case.
// Here the top-k references (weights from pickReferences: overlap × recency
// decay × same-driver boost) pour their zone walks into ONE weighted digraph;
// edges supported by less than edge_floor × total-reference-weight are dropped
// (a lone atypical route can't inject order the consensus doesn't back — the
// "outvoting" property); Tarjan contracts what remains, and each surviving
// inter-component edge becomes a precedence pair whose violation cost scales
// with min(1, edgeWeight / totalWeight) — unanimous order costs full
// precedence_penalty, weakly-supported order proportionally less.
//
// k=1 REGRESSION GUARANTEE (tested): with a single reference every edge weight
// equals the total weight, so no edge is floored, the graph and Tarjan input
// are identical to referencePrecedence's, and every pair normalizes to w=1 —
// bit-identical penalties to the legacy single-reference path.

export interface WeightedReference { zone_seq: string[]; weight: number }

export function aggregateReferencePrecedence(
  refs: WeightedReference[],
  edgeFloorFrac: number,
): ReferencePrecedence {
  const usable = (refs || []).filter((r) => r && Number(r.weight) > 0 && Array.isArray(r.zone_seq));
  const nodeOrder: string[] = [];
  const seen = new Set<string>();
  const edgeW = new Map<string, { a: string; b: string; w: number }>();
  let totalW = 0;
  for (const r of usable) {
    totalW += r.weight;
    const seq = collapseConsecutive(r.zone_seq);
    for (const z of seq) if (!seen.has(z)) { seen.add(z); nodeOrder.push(z); }
    for (let i = 1; i < seq.length; i++) {
      if (seq[i - 1] === seq[i]) continue;
      const key = `${seq[i - 1]} ${seq[i]}`;
      const e = edgeW.get(key);
      if (e) e.w += r.weight;
      else edgeW.set(key, { a: seq[i - 1], b: seq[i], w: r.weight });
    }
  }
  if (!totalW) return { compOf: new Map(), compSeq: [], pairs: [] };

  // Weight floor: consensus must back an edge for it to constrain.
  const floor = edgeFloorFrac * totalW;
  const kept = [...edgeW.values()].filter((e) => e.w >= floor || floor === 0);

  const edges = new Map<string, Set<string>>();
  for (const n of nodeOrder) edges.set(n, new Set());
  for (const e of kept) edges.get(e.a)!.add(e.b);
  const compOf = tarjanScc(nodeOrder, edges);

  // Inter-component pairs, weight-accumulated then normalized (capped at 1).
  const pairW = new Map<string, PrecedencePair>();
  for (const e of kept) {
    const ca = compOf.get(e.a)!, cb = compOf.get(e.b)!;
    if (ca === cb) continue;
    const key = `${ca} ${cb}`;
    const p = pairW.get(key);
    if (p) p.w += e.w;
    else pairW.set(key, { a: ca, b: cb, w: e.w });
  }
  const pairs = [...pairW.values()]
    .map((p) => ({ a: p.a, b: p.b, w: Math.min(1, p.w / totalW) }))
    .sort((x, y) => (x.a - y.a) || (x.b - y.b));
  return { compOf, compSeq: [], pairs };
}

// ── Penalty model ────────────────────────────────────────────────────────────

// Hierarchy + precedence penalty for a tour's collapsed zone visit sequence.
// (entries − distinct) at zone/super/top levels — i.e. don't re-enter a zone,
// super, or top you already left — plus 1 precedence unit per reference pair
// visited out of order.
export function sequencePenalty(
  zoneVisitSeq: string[],
  prec: ReferencePrecedence | null,
  cfg: EngineConfig,
): number {
  const precisions: ZonePrecisions = {
    zone_precision: cfg.zone_precision,
    super_precision: cfg.super_precision,
    top_precision: cfg.top_precision,
  };
  const zoneSeq = collapseConsecutive(zoneVisitSeq);
  let penalty = 0;
  const levelSeqs = [
    zoneSeq,
    collapseConsecutive(zoneSeq.map((z) => superOfZone(z, precisions))),
    collapseConsecutive(zoneSeq.map((z) => topOfZone(z, precisions))),
  ];
  for (const seq of levelSeqs) {
    const entries = seq.length;
    const distinct = new Set(seq).size;
    penalty += (entries - distinct) * cfg.hierarchy_penalty;
  }
  if (prec && prec.pairs.length) {
    const firstVisitOfComp = new Map<number, number>();
    for (let i = 0; i < zoneSeq.length; i++) {
      const c = prec.compOf.get(zoneSeq[i]);
      if (c !== undefined && !firstVisitOfComp.has(c)) firstVisitOfComp.set(c, i);
    }
    for (const { a, b, w } of prec.pairs) {
      const pa = firstVisitOfComp.get(a);
      const pb = firstVisitOfComp.get(b);
      if (pa === undefined || pb === undefined) continue; // pair not fully present in this route
      // Violation cost scales with the pair's normalized consensus weight
      // (single-reference pairs carry w=1 → identical to legacy behavior).
      if (pb < pa) penalty += cfg.precedence_penalty * w;
    }
  }
  return penalty;
}

// Open-tour travel minutes: depot → first stop → … → last stop (no return leg —
// Davis routes end in the field).
export function travelMinutesForOrder(order: EngineStop[], matrix: CostMatrix): number {
  let total = 0;
  let prev = DEPOT_ID;
  for (const s of order) {
    total += matrix[prev][s.id];
    prev = s.id;
  }
  return total;
}

// Generic tour objective, including the classic big-M charge on zone splits
// (any cross-zone edge beyond the minimum needed to connect the distinct
// zones). The two-level search below can never produce a split — this exists
// so tests can PROVE any tour that splits a zone is strictly worse.
export function tourObjective(
  order: EngineStop[], matrix: CostMatrix, prec: ReferencePrecedence | null, cfg: EngineConfig,
): { travelMin: number; penalty: number; splits: number; objective: number } {
  const zoneSeq = collapseConsecutive(order.map((s) => s.zone));
  const splits = zoneSeq.length - new Set(zoneSeq).size;
  const travelMin = travelMinutesForOrder(order, matrix);
  const penalty = sequencePenalty(zoneSeq, prec, cfg);
  return { travelMin, penalty, splits, objective: travelMin + splits * cfg.big_m_min + cfg.penalty_multiplier * penalty };
}

// ── Deterministic RNG (mulberry32 over an FNV-1a hash of the loadKey) ────────

export function seedFromKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The solve ────────────────────────────────────────────────────────────────

export interface SolveInput {
  loadKey: string;
  stops: EngineStop[];              // zone already computed per stop
  depot: { lat: number; lng: number };
  referenceZoneSeq: string[] | null; // legacy single reference (k=1); null → UNGUIDED
  // Phase 2.1: top-k weighted references (from pickReferences). When present
  // (non-empty) this supersedes referenceZoneSeq: precedence comes from the
  // weighted aggregate graph, the SEED zone order from the top-weighted
  // reference. A single entry reproduces the legacy path exactly (tested).
  references?: WeightedReference[] | null;
  cfg: EngineConfig;
  now?: () => number;               // injectable clock for tests
}

export interface SolveResult {
  order: EngineStop[];
  zoneOrder: string[];
  unguided: boolean;
  travelMin: number;
  penalty: number;
  objective: number;
  restartsRun: number;
}

interface ZoneGroup { zone: string; stops: EngineStop[]; centLat: number; centLng: number }

function groupZones(stops: EngineStop[]): Map<string, ZoneGroup> {
  const groups = new Map<string, ZoneGroup>();
  for (const s of stops) {
    let g = groups.get(s.zone);
    if (!g) { g = { zone: s.zone, stops: [], centLat: 0, centLng: 0 }; groups.set(s.zone, g); }
    g.stops.push(s);
  }
  for (const g of groups.values()) {
    g.centLat = g.stops.reduce((a, s) => a + s.lat, 0) / g.stops.length;
    g.centLng = g.stops.reduce((a, s) => a + s.lng, 0) / g.stops.length;
  }
  return groups;
}

function centroidMiles(a: { centLat: number; centLng: number }, b: { centLat: number; centLng: number }): number {
  return haversineMiles(a.centLat, a.centLng, b.centLat, b.centLng);
}

// Reference-implied seed: zones in reference order, unseen zones inserted at
// the nearest position (cheapest centroid insertion along the open path from
// the depot).
function guidedSeedZoneOrder(
  groups: Map<string, ZoneGroup>, refZoneSeq: string[], depot: { lat: number; lng: number },
): string[] {
  const present = new Set(groups.keys());
  const seed: string[] = [];
  for (const z of collapseConsecutive(refZoneSeq)) {
    if (present.has(z) && !seed.includes(z)) seed.push(z);
  }
  const unseen = [...present].filter((z) => !seed.includes(z)).sort();
  const depotPt = { centLat: depot.lat, centLng: depot.lng };
  for (const z of unseen) {
    const g = groups.get(z)!;
    let bestPos = seed.length, bestCost = Infinity;
    for (let pos = 0; pos <= seed.length; pos++) {
      const prev = pos === 0 ? depotPt : groups.get(seed[pos - 1])!;
      const next = pos === seed.length ? null : groups.get(seed[pos])!;
      const cost = next
        ? centroidMiles(prev, g) + centroidMiles(g, next) - centroidMiles(prev, next)
        : centroidMiles(prev, g);
      if (cost < bestCost) { bestCost = cost; bestPos = pos; }
    }
    seed.splice(bestPos, 0, z);
  }
  return seed;
}

// Nearest-neighbor seed over zone centroids from the depot.
function nnSeedZoneOrder(groups: Map<string, ZoneGroup>, depot: { lat: number; lng: number }): string[] {
  const remaining = new Set(groups.keys());
  const order: string[] = [];
  let cur = { centLat: depot.lat, centLng: depot.lng };
  while (remaining.size) {
    let best: string | null = null, bestD = Infinity;
    for (const z of [...remaining].sort()) {
      const d = centroidMiles(cur, groups.get(z)!);
      if (d < bestD) { bestD = d; best = z; }
    }
    order.push(best!);
    remaining.delete(best!);
    cur = groups.get(best!)!;
  }
  return order;
}

// Nearest-neighbor stop order within a zone from an entry point.
function nnWithinZone(stops: EngineStop[], entry: { lat: number; lng: number }): EngineStop[] {
  const remaining = [...stops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order: EngineStop[] = [];
  let cur = entry;
  while (remaining.length) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMiles(cur.lat, cur.lng, remaining[i].lat, remaining[i].lng);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const s = remaining.splice(bestI, 1)[0];
    order.push(s);
    cur = s;
  }
  return order;
}

export function solveRoute(input: SolveInput): SolveResult {
  const { loadKey, stops, depot, referenceZoneSeq, cfg } = input;
  const now = input.now || Date.now;
  const deadline = now() + cfg.solver_ms_cap;
  // Phase 2.1: prefer the top-k weighted reference set; fall back to the legacy
  // single reference. Seed zone order always comes from the strongest teacher.
  const weightedRefs: WeightedReference[] | null =
    input.references && input.references.length
      ? input.references
      : (referenceZoneSeq && referenceZoneSeq.length ? [{ zone_seq: referenceZoneSeq, weight: 1 }] : null);
  const unguided = !weightedRefs;
  const prec = unguided ? null : aggregateReferencePrecedence(weightedRefs!, cfg.reference_edge_floor);
  const seedZoneSeq = weightedRefs ? weightedRefs[0].zone_seq : null;

  const groups = groupZones(stops);
  const points: EnginePoint[] = [{ id: DEPOT_ID, lat: depot.lat, lng: depot.lng }, ...stops];
  const matrix = buildTravelMatrix(points, cfg);

  const flatten = (zoneOrder: string[], within: Map<string, EngineStop[]>): EngineStop[] => {
    const out: EngineStop[] = [];
    for (const z of zoneOrder) out.push(...(within.get(z) || []));
    return out;
  };

  const evaluate = (zoneOrder: string[], within: Map<string, EngineStop[]>) => {
    const order = flatten(zoneOrder, within);
    const travelMin = travelMinutesForOrder(order, matrix);
    const penalty = sequencePenalty(zoneOrder, prec, cfg);
    return { order, travelMin, penalty, objective: travelMin + cfg.penalty_multiplier * penalty };
  };

  // Rebuild every zone's internal order by nearest-neighbor from its entry
  // stop, walking the zone order left to right.
  const nnAllZones = (zoneOrder: string[]): Map<string, EngineStop[]> => {
    const within = new Map<string, EngineStop[]>();
    let entry: { lat: number; lng: number } = depot;
    for (const z of zoneOrder) {
      const ordered = nnWithinZone(groups.get(z)!.stops, entry);
      within.set(z, ordered);
      entry = ordered[ordered.length - 1];
    }
    return within;
  };

  // Inner improvement: within-zone 2-opt (segment reversal) + Or-opt (relocate
  // 1–2 consecutive stops) over the asymmetric costs. Whole-tour objective is
  // re-evaluated per candidate — routes are small, correctness beats delta
  // bookkeeping here. Accepted candidates replace the zone's order in `within`;
  // rejected ones restore it before the next candidate.
  const improveWithin = (zoneOrder: string[], within: Map<string, EngineStop[]>): boolean => {
    let improvedAny = false;
    for (const z of zoneOrder) {
      let improved = true;
      while (improved && now() < deadline) {
        improved = false;
        const zs = within.get(z)!;
        if (zs.length < 2) break;
        const bestObj = evaluate(zoneOrder, within).objective;
        const candidates: EngineStop[][] = [];
        // 2-opt: reverse [i..j]
        for (let i = 0; i < zs.length - 1; i++) {
          for (let j = i + 1; j < zs.length; j++) {
            candidates.push([...zs.slice(0, i), ...zs.slice(i, j + 1).reverse(), ...zs.slice(j + 1)]);
          }
        }
        // Or-opt: move a block of 1–2 stops to another position
        for (let len = 1; len <= 2; len++) {
          for (let i = 0; i + len <= zs.length; i++) {
            const block = zs.slice(i, i + len);
            const rest = [...zs.slice(0, i), ...zs.slice(i + len)];
            for (let pos = 0; pos <= rest.length; pos++) {
              if (pos === i) continue;
              candidates.push([...rest.slice(0, pos), ...block, ...rest.slice(pos)]);
            }
          }
        }
        for (const cand of candidates) {
          within.set(z, cand);
          if (evaluate(zoneOrder, within).objective + 1e-9 < bestObj) { improved = true; improvedAny = true; break; }
          within.set(z, zs);
        }
      }
    }
    return improvedAny;
  };

  // Outer improvement: zone relocate, adjacent swap, and short block relocate
  // (2-opt on the zone sequence WITHOUT segment reversal — reversing a zone
  // run rarely matches how dispatch drives and wrecks precedence).
  const improveOuter = (zoneOrder: string[], within: Map<string, EngineStop[]>): { zoneOrder: string[]; improved: boolean } => {
    let cur = [...zoneOrder];
    let best = evaluate(cur, within);
    let improvedAny = false;
    let improved = true;
    while (improved && now() < deadline) {
      improved = false;
      // relocate one zone (covers adjacent swap as relocate distance 1)
      for (let i = 0; i < cur.length && !improved; i++) {
        for (let pos = 0; pos <= cur.length && !improved; pos++) {
          if (pos === i || pos === i + 1) continue;
          const cand = [...cur];
          const [z] = cand.splice(i, 1);
          cand.splice(pos > i ? pos - 1 : pos, 0, z);
          const w = nnAllZones(cand);
          const e = evaluate(cand, w);
          if (e.objective + 1e-9 < best.objective) {
            cur = cand; best = e; improved = true; improvedAny = true;
            within.clear(); for (const [k, v] of w) within.set(k, v);
          }
        }
      }
      if (improved) continue;
      // block relocate, blocks of 2–3 zones, order preserved (no reversal)
      for (let len = 2; len <= 3 && !improved; len++) {
        for (let i = 0; i + len <= cur.length && !improved; i++) {
          for (let pos = 0; pos <= cur.length - len && !improved; pos++) {
            if (pos === i) continue;
            const cand = [...cur];
            const block = cand.splice(i, len);
            cand.splice(pos, 0, ...block);
            const w = nnAllZones(cand);
            const e = evaluate(cand, w);
            if (e.objective + 1e-9 < best.objective) {
              cur = cand; best = e; improved = true; improvedAny = true;
              within.clear(); for (const [k, v] of w) within.set(k, v);
            }
          }
        }
      }
    }
    return { zoneOrder: cur, improved: improvedAny };
  };

  const rand = mulberry32(seedFromKey(loadKey));
  const shuffled = (arr: string[]): string[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const baseSeed = unguided
    ? nnSeedZoneOrder(groups, depot)
    : guidedSeedZoneOrder(groups, seedZoneSeq!, depot);

  let best: { order: EngineStop[]; zoneOrder: string[]; travelMin: number; penalty: number; objective: number } | null = null;
  let restartsRun = 0;

  for (let r = 0; r < cfg.restarts; r++) {
    if (r > 0 && now() >= deadline) break;
    restartsRun++;
    let zoneOrder = r === 0 ? [...baseSeed] : shuffled(baseSeed);
    let within = nnAllZones(zoneOrder);
    // alternate outer / inner passes to a local optimum
    for (let round = 0; round < 20 && now() < deadline; round++) {
      const outer = improveOuter(zoneOrder, within);
      zoneOrder = outer.zoneOrder;
      const inner = improveWithin(zoneOrder, within);
      if (!outer.improved && !inner) break;
    }
    const e = evaluate(zoneOrder, within);
    if (!best || e.objective < best.objective - 1e-9) {
      best = { order: e.order, zoneOrder: [...zoneOrder], travelMin: e.travelMin, penalty: e.penalty, objective: e.objective };
    }
  }

  return {
    order: best!.order,
    zoneOrder: best!.zoneOrder,
    unguided,
    travelMin: best!.travelMin,
    penalty: best!.penalty,
    objective: best!.objective,
    restartsRun,
  };
}
