// lib/routing-solver.mts
//
// The deterministic routing solver (Section 9). PURE: solveRouting(input) -> output,
// the swappable RoutingSolver contract that Google optimizeTours (P2.4) can later
// implement without touching callers.
//
// Pipeline within solve:
//   1. Assignment — best-fit-decreasing bin-packing across the N trucks, honoring
//      equipment + capacity HARD constraints. Hard-to-place stops (oversize / most
//      restricted / largest) are placed first; anything that fits no truck spills.
//   2. Sequencing per strategy — FARTHEST_FIRST pins the far stop first and the depot
//      last and finds the shortest path between them (a homeward sweep); CLOSEST_FIRST
//      is the same sweep outward (near stop first, far stop last). MIN_DISTANCE /
//      MIN_TIME use nearest-neighbor seeding + 2-opt improvement on the injected matrix.
//   3. Legs + ETAs + load/capacity.
// STRICT appointment windows are validated/enforced by the repair loop, not here.

import type {
  SolverInput, SolverOutput, SolverStop, SolverTruck, BuiltRoute, RouteLeg,
  UnassignedStop, Strategy,
} from './routing-types.mts';
import { DEFAULT_SERVICE_MIN } from './routing-types.mts';
import {
  truckCanCarry, capacityFits, loadFraction, emptyLoad, addLoad, computeLoad, REASON,
} from './routing-constraints.mts';

const DEPOT_ID = 'DEPOT';

// matrix index: depot = 0, stop k = k+1 (in input.stops order).
function buildIndex(stops: SolverStop[]): Map<string, number> {
  const m = new Map<string, number>();
  stops.forEach((s, k) => m.set(s.id, k + 1));
  return m;
}

function serviceSec(stop: SolverStop): number {
  const min = Number.isFinite(stop.serviceMin) ? stop.serviceMin : DEFAULT_SERVICE_MIN;
  return Math.max(0, min) * 60;
}

// ── assignment ───────────────────────────────────────────────────────────────
interface Assignment { byTruck: Map<string, SolverStop[]>; unassigned: UnassignedStop[] }

// Pure haversine (meters) on lat/lng — geographic proximity that does NOT depend on
// the matrix mode (haversine vs google).
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Geography-aware capacitated assignment (Chunk B). Operator rule: nearby stops ride
// the SAME truck; two trucks share an area ONLY when (a) an equipment restriction
// forces a stop onto a specific truck, or (b) a cluster exceeds one truck's capacity.
// Equipment + capacity stay the ONLY hard gates (truckCanCarry / capacityFits); spill
// reasons are unchanged. Deterministic: equipment/oversize anchors first, then
// farthest-point seeds per empty truck, then global nearest-pair region growth.
function assign(stops: SolverStop[], trucks: SolverTruck[], depot: { lat: number; lng: number }): Assignment {
  const byTruck = new Map<string, SolverStop[]>();
  const loadByTruck = new Map<string, ReturnType<typeof emptyLoad>>();
  for (const t of trucks) { byTruck.set(t.id, []); loadByTruck.set(t.id, emptyLoad()); }
  const unassigned: UnassignedStop[] = [];

  const place = (stop: SolverStop, t: SolverTruck) => {
    byTruck.get(t.id)!.push(stop);
    loadByTruck.set(t.id, addLoad(loadByTruck.get(t.id)!, stop));
  };
  const fits = (stop: SolverStop, t: SolverTruck) =>
    truckCanCarry(stop, t).ok && capacityFits(loadByTruck.get(t.id)!, stop, t).ok;
  // Distance from a stop to a truck's current territory (nearest assigned stop), or to
  // the depot when the territory is still empty.
  const distToTruck = (stop: SolverStop, t: SolverTruck): number => {
    const terr = byTruck.get(t.id)!;
    if (!terr.length) return haversineM(stop, depot);
    let best = Infinity;
    for (const s of terr) { const d = haversineM(stop, s); if (d < best) best = d; }
    return best;
  };
  // ── THE BALANCE TERM — why a 53' trailer used to sit nearly empty ──────────
  //
  // Chad: "if i give it 2 boxes and 1 tractor and 30 stops it puts what it knows is tractor
  // friendly on the tractor and rest on the boxes." Measured on the real modules before this
  // existed, with the shipped default profiles and a normal day's restrictions: BOX-1 took 14,
  // BOX-2 took 14 — both at their 14-skid ceiling — and the 28-skid TRACTOR took 2 of 30, for
  // 269 fleet miles against 143 on a clean board. Two trucks did the day and the big one
  // followed them around.
  //
  // The cause was that growth was PURELY nearest-pair: whichever truck's territory happened to
  // be closest won every stop until it physically could not take another. Nothing in the loop
  // knew a truck was nearly full while another was nearly empty, and the objectiveWeights
  // `balance` term the request has always carried was plumbed the whole way in and never read.
  //
  // So placement now costs a stop as its distance PLUS a penalty for how full that truck
  // already is. The penalty is expressed in METRES — one full truck is worth BALANCE_M of
  // detour — which keeps it comparable with the distance it is traded against and keeps the
  // whole thing deterministic. At 12 km a stop goes to a nearer truck over an emptier one for
  // any realistic in-town gap, and the term only decides between trucks that are already a
  // long way apart or badly out of balance. It CANNOT place a stop on a truck that does not
  // fit it: `fits` is still the gate and equipment is still absolute.
  //
  // This is a preference, not a rule about tractors. Chad's ask reads as "use the big truck",
  // and the honest way to get that is to stop the small ones being filled first — a tractor
  // with twice the capacity then attracts roughly twice the freight on its own, without the
  // solver having to hold an opinion about what a 53' is for.
  const BALANCE_M = Number(process.env.ROUTING_BALANCE_METRES) || 12000;
  const cost = (stop: SolverStop, t: SolverTruck): number =>
    distToTruck(stop, t) + BALANCE_M * loadFraction(loadByTruck.get(t.id)!, t);

  const spillNoTruck = (stop: SolverStop) => {
    const reasons = new Set<string>();
    for (const t of trucks) for (const r of truckCanCarry(stop, t).reasons) reasons.add(r);
    unassigned.push({ stopId: stop.id, reasons: [REASON.noTruckFits, ...reasons] });
  };
  const spillCapacity = (stop: SolverStop, capable: SolverTruck[]) => {
    const roomiest = capable.reduce((p, c) =>
      (c.maxSkids - loadByTruck.get(c.id)!.skids) > (p.maxSkids - loadByTruck.get(p.id)!.skids) ? c : p);
    unassigned.push({ stopId: stop.id, reasons: capacityFits(loadByTruck.get(roomiest.id)!, stop, roomiest).reasons });
  };

  // ── Phase 1: anchor restricted + oversize stops on a capable truck (equipment
  //    decides; geography is secondary for these). Hardest-first, deterministic. ──
  const isRestricted = (s: SolverStop) => s.oversize || (s.equipmentReqs?.length || 0) > 0;
  const restricted = stops.filter(isRestricted).sort((a, b) =>
    (Number(b.oversize) - Number(a.oversize)) ||
    ((b.equipmentReqs?.length || 0) - (a.equipmentReqs?.length || 0)) ||
    (b.skids - a.skids) || (b.weightLbs - a.weightLbs) || (a.id < b.id ? -1 : 1));
  for (const stop of restricted) {
    const capable = trucks.filter((t) => truckCanCarry(stop, t).ok);
    if (!capable.length) { spillNoTruck(stop); continue; }
    const fitting = capable.filter((t) => capacityFits(loadByTruck.get(t.id)!, stop, t).ok);
    if (!fitting.length) { spillCapacity(stop, capable); continue; }
    const best = fitting.reduce((p, c) =>
      (c.maxSkids - loadByTruck.get(c.id)!.skids) > (p.maxSkids - loadByTruck.get(p.id)!.skids) ? c : p);
    place(stop, best);
  }

  // ── Phase 2: seed each EMPTY truck with a geographically spread plain stop
  //    (farthest-point sampling) so separated clusters land on different trucks. ──
  const assignedIds = new Set<string>();
  for (const terr of byTruck.values()) for (const s of terr) assignedIds.add(s.id);
  const remaining = stops.filter((s) => !isRestricted(s) && !assignedIds.has(s.id));
  const chosenSeeds: SolverStop[] = [];
  const farthestPoint = (): SolverStop | null => {
    let best: SolverStop | null = null, bestScore = -1;
    for (const s of remaining) {
      if (chosenSeeds.includes(s)) continue;
      let score = haversineM(s, depot);
      for (const seed of chosenSeeds) score = Math.min(score, haversineM(s, seed));
      if (score > bestScore || (score === bestScore && best && s.id < best.id)) { bestScore = score; best = s; }
    }
    return best;
  };
  for (const t of trucks) {
    if (byTruck.get(t.id)!.length) continue; // already anchored in phase 1
    let seed = farthestPoint();
    while (seed && !fits(seed, t)) { chosenSeeds.push(seed); seed = farthestPoint(); } // skip seeds this truck can't take
    if (!seed) break;
    chosenSeeds.push(seed);
    place(seed, t);
    remaining.splice(remaining.indexOf(seed), 1);
  }

  // ── Phase 3: global nearest-pair region growth for the rest. ──
  // Cap the iterations up front: remaining.length shrinks by one each pass, so a cap
  // that re-reads remaining.length would halve the budget and bail with routable stops
  // still in hand (they'd then phantom-spill below). Each pass places exactly one stop,
  // so remaining.length passes suffice; +5 is slack.
  const maxIters = remaining.length + 5;
  let guard = 0;
  while (remaining.length && guard++ < maxIters) {
    let bestStop: SolverStop | null = null, bestTruck: SolverTruck | null = null, bestD = Infinity;
    for (const stop of remaining) {
      for (const t of trucks) {
        if (!fits(stop, t)) continue;
        const d = cost(stop, t);
        if (d < bestD || (d === bestD && bestStop && stop.id < bestStop.id)) { bestD = d; bestStop = stop; bestTruck = t; }
      }
    }
    if (!bestStop) break; // nothing fits any truck with room
    place(bestStop, bestTruck!);
    remaining.splice(remaining.indexOf(bestStop), 1);
  }
  // Anything still remaining fits no truck with room → capacity (or no-truck) spill.
  for (const stop of remaining) {
    const capable = trucks.filter((t) => truckCanCarry(stop, t).ok);
    if (!capable.length) spillNoTruck(stop); else spillCapacity(stop, capable);
  }

  return { byTruck, unassigned };
}

// ── sequencing ───────────────────────────────────────────────────────────────
export function pathCost(order: number[], cost: number[][]): number {
  if (!order.length) return 0;
  let total = cost[0][order[0]];
  for (let i = 0; i < order.length - 1; i++) total += cost[order[i]][order[i + 1]];
  return total;
}

export function nearestNeighbor(nodes: number[], cost: number[][]): number[] {
  const remaining = new Set(nodes);
  const out: number[] = [];
  let cur = 0; // depot
  while (remaining.size) {
    let next = -1, bestC = Infinity;
    for (const n of remaining) { const c = cost[cur][n]; if (c < bestC) { bestC = c; next = n; } }
    out.push(next); remaining.delete(next); cur = next;
  }
  return out;
}

// 2-opt improvement on the depot-anchored path (no return leg).
export function twoOpt(order: number[], cost: number[][]): number[] {
  let best = order.slice();
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        if (pathCost(candidate, cost) + 1e-9 < pathCost(best, cost)) { best = candidate; improved = true; }
      }
    }
  }
  return best;
}

// ── the pinned-ends sweep (FARTHEST_FIRST / CLOSEST_FIRST) ───────────────────
// Until 2026-09-10 both were a SORT by distance from the depot. A radius says nothing about
// direction, so towns at one radius in three directions interleaved and the route crossed
// itself — Chad, on a 14-stop route: "it should be pretty linear from furthest point out to
// the last but this is jumping all around." What "farthest first" means on a dock is: run out
// to the far end, then deliver on the way home. Both ends of that path are known (the far
// stop, then the depot); only the order in between is open, and it is found the same way
// MIN_DISTANCE finds its order — nearest-neighbour seeds, 2-opt reversals, or-opt relocations
// — with the ends held fixed. CLOSEST_FIRST is the sweep run outward: near stop first, far
// stop last. The client's re-sequence picker (lib/routing-select.js) runs the identical sweep
// on straight-line distance, so a card and an engine build agree on what the words mean.

// Length of start → order… → end on a cost matrix (asymmetric-safe: every edge read forward).
export function pinnedPathCost(order: number[], start: number, end: number, cost: number[][]): number {
  let prev = start, total = 0;
  for (const k of order) { total += cost[prev][k]; prev = k; }
  return total + cost[prev][end];
}

function nearestNeighborFrom(from: number, pool: number[], cost: number[][]): number[] {
  const remaining = new Set(pool);
  const out: number[] = [];
  let cur = from;
  while (remaining.size) {
    let next = -1, bestC = Infinity;
    for (const n of remaining) { const c = cost[cur][n]; if (c < bestC) { bestC = c; next = n; } }
    out.push(next); remaining.delete(next); cur = next;
  }
  return out;
}

// 2-opt + or-opt on the interior of a path whose two ends never move. Every candidate is
// scored by the delta of the edges it changes (two for a reversal, three for a relocation),
// never by re-summing the path; on an asymmetric (Google) matrix the edges inside a reversed
// run change direction too, and those are re-read only then. Every kept move strictly
// shortens the path, so the search always ends; maxPasses cuts a badly seeded pass short
// and the multi-start keeps whichever seed finished shortest.
export function improvePinnedPath(order: number[], start: number, end: number, cost: number[][], maxPasses = 40): number[] {
  const path = order.slice();
  const n = path.length;
  if (n < 2) return path;
  const EPS = 1e-9;
  const at = (i: number): number => (i < 0 ? start : i >= n ? end : path[i]);
  const asym = isAsymmetric(cost, [start, end, ...path]);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const p = at(i - 1), a = path[i], b = path[k], q = at(k + 1);
        let delta = cost[p][b] + cost[a][q] - cost[p][a] - cost[b][q];
        if (asym) for (let t = i; t < k; t++) delta += cost[path[t + 1]][path[t]] - cost[path[t]][path[t + 1]];
        if (delta < -EPS) {
          for (let lo = i, hi = k; lo < hi; lo++, hi--) { const tmp = path[lo]; path[lo] = path[hi]; path[hi] = tmp; }
          improved = true;
        }
      }
    }
    for (let len = 1; len <= 3 && len < n; len++) {
      for (let i = 0; i + len <= n; i++) {
        const a = path[i], b = path[i + len - 1], p = at(i - 1), q = at(i + len);
        let inner = 0, innerRev = 0;
        for (let t = i; t < i + len - 1; t++) { inner += cost[path[t]][path[t + 1]]; innerRev += cost[path[t + 1]][path[t]]; }
        const lifted = cost[p][a] + cost[b][q] - cost[p][q];
        let bestDelta = -EPS, bestJ = -1, bestRev = false;
        for (let j = 0; j <= n; j++) {
          if (j >= i && j <= i + len) continue;
          const u = at(j - 1), v = at(j);
          const dF = cost[u][a] + cost[b][v] - cost[u][v] - lifted;
          if (dF < bestDelta) { bestDelta = dF; bestJ = j; bestRev = false; }
          if (len > 1) {
            const dR = cost[u][b] + cost[a][v] - cost[u][v] - lifted + (innerRev - inner);
            if (dR < bestDelta) { bestDelta = dR; bestJ = j; bestRev = true; }
          }
        }
        if (bestJ >= 0) {
          const seg = path.splice(i, len);
          if (bestRev) seg.reverse();
          path.splice(bestJ > i ? bestJ - len : bestJ, 0, ...seg);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return path;
}

function isAsymmetric(cost: number[][], nodes: number[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (cost[nodes[i]][nodes[j]] !== cost[nodes[j]][nodes[i]]) return true;
    }
  }
  return false;
}

// The sweep over matrix node indices (0 = depot). 'homeward' = FARTHEST_FIRST, 'outward' =
// CLOSEST_FIRST. Multi-start: four cheap seeds, each improved, the shortest path wins.
export function pinnedSweep(nodes: number[], cost: number[][], dir: 'homeward' | 'outward'): number[] {
  if (nodes.length <= 1) return nodes.slice();
  // Canonical order first: ties for farthest/nearest and the seeds below read the order they
  // are handed, and the answer must be a function of the node SET, not of assignment order.
  nodes = nodes.slice().sort((a, b) => a - b);
  let far = nodes[0], near = nodes[0];
  for (const n of nodes) {
    if (cost[0][n] > cost[0][far]) far = n;
    if (cost[0][n] < cost[0][near]) near = n;
  }
  let start: number, end: number;
  if (dir === 'homeward') { start = far; end = 0; }
  else { start = near; end = far === near ? 0 : far; }
  const pool = nodes.filter((n) => n !== start && n !== end);
  const byRadius = pool.slice().sort((a, b) => cost[0][a] - cost[0][b]);
  const seeds = [
    nearestNeighborFrom(start, pool, cost),
    nearestNeighborFrom(end, pool, cost).reverse(),
    dir === 'homeward' ? byRadius.slice().reverse() : byRadius,
    pool,
  ];
  let interior: number[] = pool, best = Infinity;
  for (const seed of seeds) {
    const cand = improvePinnedPath(seed, start, end, cost);
    const len = pinnedPathCost(cand, start, end, cost);
    if (len + 1e-9 < best) { best = len; interior = cand; }
  }
  return [start, ...interior, ...(end === 0 ? [] : [end])];
}

export function sequence(nodes: number[], strategy: Strategy, matrix: SolverInput['matrix']): number[] {
  if (nodes.length <= 1) return nodes.slice();
  const { distanceMeters, durationSec } = matrix;
  switch (strategy) {
    case 'CLOSEST_FIRST':
      return pinnedSweep(nodes, distanceMeters, 'outward');
    case 'FARTHEST_FIRST':
      return pinnedSweep(nodes, distanceMeters, 'homeward');
    case 'MIN_TIME':
      return twoOpt(nearestNeighbor(nodes, durationSec), durationSec);
    case 'MIN_DISTANCE':
    default:
      return twoOpt(nearestNeighbor(nodes, distanceMeters), distanceMeters);
  }
}

// ── route assembly (legs, ETAs, load) ────────────────────────────────────────
export function assembleRoute(
  truck: SolverTruck,
  stops: SolverStop[],
  orderedNodes: number[],
  idByIndex: Map<number, string>,
  matrix: SolverInput['matrix'],
  departEpochSec: number,
): BuiltRoute {
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const orderedStopIds = orderedNodes.map((n) => idByIndex.get(n)!);
  const legs: RouteLeg[] = [];
  const etas: number[] = [];
  let prev = 0; // depot
  let clock = departEpochSec;
  for (const node of orderedNodes) {
    const id = idByIndex.get(node)!;
    const stop = stopById.get(id)!;
    legs.push({
      fromId: prev === 0 ? DEPOT_ID : idByIndex.get(prev)!,
      toId: id,
      distanceMeters: matrix.distanceMeters[prev][node],
      durationSec: matrix.durationSec[prev][node],
    });
    clock += matrix.durationSec[prev][node];
    etas.push(clock);          // arrival at this stop
    clock += serviceSec(stop); // dwell before departing
    prev = node;
  }
  const load = computeLoad(stops);
  return {
    truckId: truck.id,
    orderedStopIds,
    legs,
    etas,
    load,
    capacity: { skids: truck.maxSkids, weightLbs: truck.maxWeightLbs, linearFeetIn: truck.deckLengthIn },
    feasible: true,
  };
}

export function solveRouting(input: SolverInput): SolverOutput {
  const { stops, trucks, matrix, strategy } = input;
  const idByIndex = new Map<number, string>();
  buildIndex(stops).forEach((idx, id) => idByIndex.set(idx, id));
  const indexById = buildIndex(stops);
  const departEpochSec = input.departEpochSec ?? 0;

  const { byTruck, unassigned } = assign(stops, trucks, input.depot);

  const routes: BuiltRoute[] = [];
  // A TRUCK THAT GOT NOTHING IS AN ANSWER, NOT AN ABSENCE. It used to be dropped here and the
  // screen renders one card per returned route, so a picked truck that ended up with zero
  // stops simply was not on screen — the dispatcher picked three and got two cards, with
  // nothing anywhere saying which one went unused or why. That is the exact shape of the
  // "only green on a trailer" trap: on a board where nothing is marked green, every stop is
  // held to a box truck and the 53' silently leaves the plan.
  const idleTrucks: Array<{ truckId: string; label: string; reason: string }> = [];
  for (const truck of trucks) {
    const assigned = byTruck.get(truck.id) ?? [];
    if (!assigned.length) {
      // Say WHY, from the freight itself rather than a guess: if no selected stop could ever
      // ride this truck, that is an equipment story and the dispatcher can act on it.
      const anyCapable = stops.some((s) => truckCanCarry(s, truck).ok);
      idleTrucks.push({
        truckId: truck.id,
        label: truck.label || truck.id,
        reason: anyCapable
          ? 'the other trucks covered every stop before this one was needed'
          : 'no selected stop is allowed on this truck',
      });
      continue;
    }
    const nodes = assigned.map((s) => indexById.get(s.id)!);
    const ordered = sequence(nodes, strategy, matrix);
    routes.push(assembleRoute(truck, assigned, ordered, idByIndex, matrix, departEpochSec));
  }

  return {
    routes,
    unassigned,
    idleTrucks,
    meta: { engine: 'deterministic', strategy, truckCount: trucks.length, stopCount: stops.length },
  };
}
