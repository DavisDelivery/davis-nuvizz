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
//   2. Sequencing per strategy — CLOSEST/FARTHEST order by depot distance;
//      MIN_DISTANCE / MIN_TIME use nearest-neighbor seeding + 2-opt improvement on
//      the injected Google matrix.
//   3. Legs + ETAs + load/capacity.
// STRICT appointment windows are validated/enforced by the repair loop, not here.

import type {
  SolverInput, SolverOutput, SolverStop, SolverTruck, BuiltRoute, RouteLeg,
  UnassignedStop, Strategy,
} from './routing-types.mts';
import { DEFAULT_SERVICE_MIN } from './routing-types.mts';
import {
  truckCanCarry, capacityFits, emptyLoad, addLoad, computeLoad, REASON,
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

function assign(stops: SolverStop[], trucks: SolverTruck[]): Assignment {
  const byTruck = new Map<string, SolverStop[]>();
  const loadByTruck = new Map<string, ReturnType<typeof emptyLoad>>();
  for (const t of trucks) { byTruck.set(t.id, []); loadByTruck.set(t.id, emptyLoad()); }
  const unassigned: UnassignedStop[] = [];

  // Hardest to place first: oversize, then most equipment reqs, then largest skids.
  const order = [...stops].sort((a, b) =>
    (Number(b.oversize) - Number(a.oversize)) ||
    ((b.equipmentReqs?.length || 0) - (a.equipmentReqs?.length || 0)) ||
    (b.skids - a.skids) || (b.weightLbs - a.weightLbs));

  for (const stop of order) {
    const capable = trucks.filter((t) => truckCanCarry(stop, t).ok);
    if (capable.length === 0) {
      // Cannot ride on ANY selected truck — report the distinct binding reasons.
      const reasons = new Set<string>();
      for (const t of trucks) for (const r of truckCanCarry(stop, t).reasons) reasons.add(r);
      unassigned.push({ stopId: stop.id, reasons: [REASON.noTruckFits, ...reasons] });
      continue;
    }
    // Among capable trucks with remaining room, pick the TIGHTEST fit (least leftover
    // skids, then weight) to pack efficiently and leave one partial truck for spillover.
    let best: SolverTruck | null = null;
    let bestLeftover = Infinity;
    for (const t of capable) {
      const load = loadByTruck.get(t.id)!;
      if (!capacityFits(load, stop, t).ok) continue;
      const leftover = (t.maxSkids - (load.skids + stop.skids)) * 1e6 + (t.maxWeightLbs - (load.weightLbs + stop.weightLbs));
      if (leftover < bestLeftover) { bestLeftover = leftover; best = t; }
    }
    if (!best) {
      // Capable in principle but every such truck is full → capacity spill. Report
      // the breach against the capable truck with the most remaining skid room.
      const roomiest = capable.reduce((p, c) =>
        (c.maxSkids - loadByTruck.get(c.id)!.skids) > (p.maxSkids - loadByTruck.get(p.id)!.skids) ? c : p);
      unassigned.push({ stopId: stop.id, reasons: capacityFits(loadByTruck.get(roomiest.id)!, stop, roomiest).reasons });
      continue;
    }
    byTruck.get(best.id)!.push(stop);
    loadByTruck.set(best.id, addLoad(loadByTruck.get(best.id)!, stop));
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

export function sequence(nodes: number[], strategy: Strategy, matrix: SolverInput['matrix']): number[] {
  if (nodes.length <= 1) return nodes.slice();
  const { distanceMeters, durationSec } = matrix;
  switch (strategy) {
    case 'CLOSEST_FIRST':
      return nodes.slice().sort((a, b) => distanceMeters[0][a] - distanceMeters[0][b]);
    case 'FARTHEST_FIRST':
      return nodes.slice().sort((a, b) => distanceMeters[0][b] - distanceMeters[0][a]);
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

  const { byTruck, unassigned } = assign(stops, trucks);

  const routes: BuiltRoute[] = [];
  for (const truck of trucks) {
    const assigned = byTruck.get(truck.id) ?? [];
    if (!assigned.length) continue;
    const nodes = assigned.map((s) => indexById.get(s.id)!);
    const ordered = sequence(nodes, strategy, matrix);
    routes.push(assembleRoute(truck, assigned, ordered, idByIndex, matrix, departEpochSec));
  }

  return {
    routes,
    unassigned,
    meta: { engine: 'deterministic', strategy, truckCount: trucks.length, stopCount: stops.length },
  };
}
