// lib/routing-repair.mts
//
// Feasibility / repair loop (Section 12). Takes the solver's candidate output and
// GUARANTEES every route it returns is provably valid against all hard constraints
// (capacity + equipment + STRICT windows). Violators are re-sequenced, moved to
// another feasible truck, or spilled with a human-readable reason.
//
// Termination is by construction:
//   Phase A (shrink): for each truck, window-aware re-order, then repeatedly REMOVE
//     the worst remaining violator (spill). Removal strictly shrinks the route, so
//     this halts and leaves every route valid.
//   Phase B (recover): try to RE-INSERT each spilled stop into a truck where it is
//     fully valid (capacity + equipment + windows). Insertion only happens when the
//     target stays valid, so it can never re-introduce a violation; each spilled
//     stop is tried once, so this halts too.

import type {
  SolverInput, SolverOutput, SolverStop, SolverTruck, BuiltRoute, UnassignedStop,
} from './routing-types.mts';
import { assembleRoute, sequence } from './routing-solver.mts';
import {
  computeLoad, capacityFits, capacityBreaches, equipmentOk, windowOk, emptyLoad, REASON, serviceStartSec,
} from './routing-constraints.mts';
import { DEFAULT_SERVICE_MIN } from './routing-types.mts';
import { onTheWayM, outOfWayReason } from './routing-assign-ends.mts';

function serviceSec(s: SolverStop): number {
  return Math.max(0, Number.isFinite(s.serviceMin) ? s.serviceMin : DEFAULT_SERVICE_MIN) * 60;
}

const hasWindow = (s: SolverStop) => s.timeConstraint === 'STRICT' && !!s.timeWindow;

// The clock down an ordered route: service-start ETAs (after any wait for a dock to open)
// and the wait itself per stop. ONE walk, shared with assembleRoute's arithmetic, so what
// the repair loop validates against is what the card shows.
function timeline(ordered: SolverStop[], indexById: Map<string, number>, matrix: SolverInput['matrix'], depart: number): { etas: number[]; waits: number[] } {
  const etas: number[] = [], waits: number[] = [];
  let prev = 0, clock = depart;
  for (const s of ordered) {
    const idx = indexById.get(s.id)!;
    clock += matrix.durationSec[prev][idx];
    const start = serviceStartSec(s, clock);
    waits.push(start - clock);
    clock = start;
    etas.push(clock);
    clock += serviceSec(s);
    prev = idx;
  }
  return { etas, waits };
}

// WINDOW-AWARE ORDER — cheapest feasible insertion over the dispatcher's own strategy order.
//
// The rule this replaces was EDF: every windowed stop FIRST, sorted by deadline, then the
// rest by nearest neighbour. It was harmless while no window ever reached the solver (the
// board's stamps never parsed — see routing-time-windows.mts) and it would be a disaster
// now that they do: a 1:00p appointment sorted to the front is a truck idling at that dock
// from 7:02a with every other stop pushed past 1:30p. A restriction has TWO edges. A close
// is a deadline to beat; an open is a reason to come back later. Both have to be honoured.
//
// So the un-windowed stops keep the strategy order exactly as before (min distance, closest
// first, …), and each windowed stop — earliest deadline first — is INSERTED at the position
// that (1) leaves every windowed stop on time, then (2) idles the least waiting for docks to
// open, then (3) adds the least distance. When no position is on time it takes the least-late
// one and the repair loop decides whether that stop stays and is flagged (advisory) or comes
// off the truck (strict). Deterministic. O(W·N²) for W windowed stops — trivial under the
// 150-stop selection cap.
//
// REACH (ROUTING_BUILD_WINDOW_REACH, `reach`). Two things the rule above got wrong, both found by
// running a truck leaving at noon through it:
//   1. A dock that closes before the truck can get there — even driving to it first — still went
//      in first (it is the least late there), dragged the run to it and pushed stops that COULD
//      be made past their close. Strict then took a deliverable order off with "appointment window
//      cannot be met". Now such a stop sets nothing: it rides where the strategy order puts it,
//      its lateness is not scored, and strict takes it off first, saying why (unreachableIn).
//   2. Placing windows one at a time could leave a dock the truck COULD make late (below).
function windowAwareOrder(stops: SolverStop[], indexById: Map<string, number>, matrix: SolverInput['matrix'], depart: number, strategy: SolverInput['strategy'], reach = false): SolverStop[] {
  const node = (s: SolverStop) => indexById.get(s.id)!;
  const canReach = (s: SolverStop) => !reach || windowReachable(s, node(s), matrix, depart);
  const windowed = stops.filter((s) => hasWindow(s) && canReach(s))
    .sort((a, b) => (a.timeWindow!.endSec - b.timeWindow!.endSec) || (a.timeWindow!.startSec - b.timeWindow!.startSec));
  const rest = stops.filter((s) => !hasWindow(s) || !canReach(s));
  const byNode = new Map(stops.map((s) => [indexById.get(s.id)!, s]));
  const base: SolverStop[] = sequence(rest.map(node), strategy, matrix).map((n) => byNode.get(n)!);
  const dist = matrix.distanceMeters;
  const fns = {
    timeline: (cand: SolverStop[]) => timeline(cand, indexById, matrix, depart),
    closeOf: (s: SolverStop) => (hasWindow(s) && canReach(s) ? s.timeWindow!.endSec : null),
    added: (prev: SolverStop | null, w: SolverStop, next: SolverStop | null) => {
      const p = prev ? node(prev) : 0;
      return dist[p][node(w)] + (next ? dist[node(w)][node(next)] - dist[p][node(next)] : 0);
    },
  };
  const greedy = insertByWindow(base, windowed, fns);
  if (!reach || !windowed.length) return greedy;
  // 2. ONE WINDOW AT A TIME CAN PAINT ITSELF INTO A CORNER. Three 2:00p docks in one town, a
  //    truck leaving at noon: the first two went in after an unwindowed stop, used up the slack
  //    the third needed, and strict took a deliverable order off. So when the one-at-a-time order
  //    leaves a dock it COULD make late, the appointments-first order is built too — the windows
  //    in deadline order, then every other stop slotted where it adds the least driving without
  //    making an appointment later — and it ships only when it is LESS late. Nothing that is on
  //    time today is touched.
  // How late an order runs, as a dispatcher counts it: how many docks it misses, then by how much.
  // A miss is a miss — two stops five minutes late are not better than one an hour late.
  const lateOf = (order: SolverStop[]) => {
    const { etas } = timeline(order, indexById, matrix, depart);
    let n = 0, sec = 0;
    order.forEach((x, i) => { if (hasWindow(x) && canReach(x) && etas[i] > x.timeWindow!.endSec) { n++; sec += etas[i] - x.timeWindow!.endSec; } });
    return n * 1e7 + sec;
  };
  const greedyLate = lateOf(greedy);
  if (!greedyLate) return greedy;
  let firsts = insertByWindow([], windowed, fns);
  for (const r of base) {
    let best: { pos: number; late: number; added: number } | null = null;
    for (let pos = 0; pos <= firsts.length; pos++) {
      const cand = [...firsts.slice(0, pos), r, ...firsts.slice(pos)];
      const late = lateOf(cand);
      const added = fns.added(pos === 0 ? null : firsts[pos - 1], r, pos < firsts.length ? firsts[pos] : null);
      if (!best || late < best.late || (late === best.late && added < best.added)) best = { pos, late, added };
    }
    firsts = [...firsts.slice(0, best!.pos), r, ...firsts.slice(best!.pos)];
  }
  return lateOf(firsts) < greedyLate ? firsts : greedy;
}

// Can a truck leaving the dock at `depart` reach this stop before its window closes, even if it
// drives there first? If not, no order makes it.
function windowReachable(s: SolverStop, idx: number, matrix: SolverInput['matrix'], depart: number): boolean {
  if (!hasWindow(s)) return true;
  return depart + matrix.durationSec[0][idx] <= s.timeWindow!.endSec;
}

// "12:10p" on the Build's UTC-anchored clock (the same clock the windows are on).
function clockLabel(sec: number): string {
  const d = new Date(sec * 1000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
}

// The stops on a truck no order can deliver in their window, each with a reason that names the
// clock — so the dispatcher sees WHY, not just "cannot be met".
function unreachableIn(stops: SolverStop[], truck: SolverTruck, input: SolverInput, indexById: Map<string, number>, depart: number): Array<{ stop: SolverStop; reason: string }> {
  return stops
    .filter((s) => hasWindow(s) && !windowReachable(s, indexById.get(s.id)!, input.matrix, depart))
    .map((s) => ({ stop: s, reason: `${REASON.windowUnsatisfiable} — it closes ${clockLabel(s.timeWindow!.endSec)}, before ${truck.label || truck.id} can get there leaving at ${clockLabel(depart)}` }));
}

/**
 * THE INSERTION RULE, shared. Each windowed stop — in the order given, which callers make
 * earliest-deadline first — goes in at the position that (1) leaves every windowed stop on
 * time, then (2) idles the least waiting for docks to open, then (3) adds the least distance.
 * When no position is on time it takes the least-late one; the caller decides whether that
 * stop stays and is flagged (advisory) or comes off (strict). The un-windowed `base` order is
 * never reshuffled — that is the dispatcher's strategy (Build) or the learned sequence
 * (Fill my loads), and a clock is a reason to move a windowed stop, not everything else.
 *
 * Generic over the stop shape and the clock so the Build button (seconds, on its matrix) and
 * step 4's "Fill my loads" (minutes, on the engine's travel model) run the SAME rule.
 */
export function insertByWindow<S>(
  base: S[], windowed: S[],
  fns: {
    timeline: (order: S[]) => { etas: number[]; waits: number[] };
    closeOf: (s: S) => number | null;
    added: (prev: S | null, w: S, next: S | null) => number;
  },
): S[] {
  let order = base.slice();
  for (const w of windowed) {
    let best: { pos: number; late: number; wait: number; added: number } | null = null;
    for (let pos = 0; pos <= order.length; pos++) {
      const cand = [...order.slice(0, pos), w, ...order.slice(pos)];
      const { etas, waits } = fns.timeline(cand);
      let late = 0, wait = 0;
      cand.forEach((s, i) => {
        const close = fns.closeOf(s);
        if (close != null && etas[i] > close) late += etas[i] - close;
        wait += waits[i];
      });
      const added = fns.added(pos === 0 ? null : order[pos - 1], w, pos < order.length ? order[pos] : null);
      const better = best == null
        || late < best.late
        || (late === best.late && (wait < best.wait || (wait === best.wait && added < best.added)));
      if (better) best = { pos, late, wait, added };
    }
    order = [...order.slice(0, best!.pos), w, ...order.slice(best!.pos)];
  }
  return order;
}

// The order repair both VALIDATES and ASSEMBLES with, so the two never diverge: with any
// real window on the truck, the window-aware insertion above; otherwise the dispatcher's
// chosen strategy order untouched (windows are then irrelevant to validity, capacity is
// order-free).
// ONE TRUCK, ONE SET OF STOPS, ONE RUN (with ROUTING_BUILD_WINDOW_REACH). The window order can
// answer differently for the same stops handed in a different order (equal deadlines keep the
// order they are given). Repair checks a run, then assembles the route from the checked order — so
// an order-sensitive answer could ship a run other than the one it checked (measured: a strict
// Build shipping a stop a minute late). So the first answer for a set of stops on a clock is kept,
// per Build, and every later ask for that set gets the same run. The first answer is computed
// exactly as before, from the order the stops were handed in.
const windowOrders = new WeakMap<SolverInput, Map<string, SolverStop[]>>();

function orderForTruck(stops: SolverStop[], input: SolverInput, indexById: Map<string, number>): SolverStop[] {
  if (stops.some(hasWindow) && input.windowReach === true) {
    const depart = input.departEpochSec ?? 0;
    let memo = windowOrders.get(input);
    if (!memo) { memo = new Map(); windowOrders.set(input, memo); }
    const key = `${depart}|${stops.map((s) => s.id).sort().join('\u0001')}`;
    const seen = memo.get(key);
    if (seen) return seen;
    const run = windowAwareOrder(stops, indexById, input.matrix, depart, input.strategy, true);
    memo.set(key, run);
    return run;
  }
  if (stops.some(hasWindow)) return windowAwareOrder(stops, indexById, input.matrix, input.departEpochSec ?? 0, input.strategy);
  const byNode = new Map(stops.map((s) => [indexById.get(s.id)!, s]));
  const nodes = stops.map((s) => indexById.get(s.id)!);
  return sequence(nodes, input.strategy, input.matrix).map((n) => byNode.get(n)!);
}

function etasFor(ordered: SolverStop[], indexById: Map<string, number>, matrix: SolverInput['matrix'], depart: number): number[] {
  return timeline(ordered, indexById, matrix, depart).etas;
}

/** What the clock says about one truck's run as the Build will ship it. */
export interface RunClock {
  /** stops that run reaches after their window closes, and (strict) customers shut today — the
   *  stops repair would take off a strict Build; on an advisory one, the missed closes */
  late: SolverStop[];
}

// THE CLOCK FOR STEP 6 OF THE ENDS RULE (routing-assign-ends: a truck with room takes a whole group
// of left-off orders). That step weighs a group on a truck's run; the run the Build SHIPS is
// orderForTruck's, which bends round every window on the truck. So before it takes a group it asks
// what THIS file would make of the run with it: which stops would miss their window. Same matrix,
// same clock, same order as the flags on the card — one place decides. Null for an empty run, or a
// stop this Build does not know.
export function runClockFor(input: SolverInput): (stops: SolverStop[]) => RunClock | null {
  const indexById = new Map<string, number>();
  input.stops.forEach((s, k) => indexById.set(s.id, k + 1));
  const depart = input.departEpochSec ?? 0;
  const strict = input.windowMode === 'strict';
  return (stops) => {
    if (!stops.length || stops.some((s) => !indexById.has(s.id))) return null;
    if (!stops.some((s) => hasWindow(s) || (strict && s.closedToday))) return { late: [] };
    // In the order repair will be handed them and will ship them: the solver's sequence, then Phase
    // A's window order, then the order the route is assembled in (windowAwareOrder keeps equal
    // deadlines in the order it is given, so asking in any other order can give another answer).
    const byNode = new Map(stops.map((s) => [indexById.get(s.id)!, s]));
    const handed = sequence([...byNode.keys()], input.strategy, input.matrix).map((n) => byNode.get(n)!);
    const ordered = orderForTruck(orderForTruck(handed, input, indexById), input, indexById);
    const etas = etasFor(ordered, indexById, input.matrix, depart);
    // Strict: every stop repair would take off. Advisory: only a missed close — a customer shut
    // today is flagged wherever it rides, so it is no truck's doing.
    return { late: ordered.filter((s, i) => (strict ? !windowOk(s, etas[i]) : hasWindow(s) && !s.closedToday && !windowOk(s, etas[i]))) };
  };
}

// Pick the worst violator in an ordered route, with its spill reason. Capacity /
// equipment first (structural), then — ONLY when windows are enforced (strict) —
// the STRICT-window stop with the most lateness. In advisory mode windows never
// cause a spill (they're flagged on the route instead).
function worstViolator(
  ordered: SolverStop[], etas: number[], truck: SolverTruck, enforceWindows: boolean,
): { stop: SolverStop; reasons: string[] } | null {
  // Capacity: if over, drop the largest-skid stop.
  const load = computeLoad(ordered);
  // THE SHARED RULE, not a second copy. This used to test all three dimensions raw — no
  // CAPACITY_GATES, no positive-cap guard — so it spilled on DECK LENGTH, which the gates
  // switch off because the per-stop estimate is inflated, and reported a reason the solver
  // says can never happen. It also meant a truck with a missing or zero cap had every stop
  // taken off it. See capacityBreaches in routing-constraints.
  const capReasons = capacityBreaches(load, truck);
  if (capReasons.length) {
    const biggest = ordered.reduce((p, c) => (c.skids > p.skids ? c : p));
    return { stop: biggest, reasons: capReasons };
  }
  // Equipment (defensive — assignment should prevent this).
  for (const s of ordered) {
    const eq = equipmentOk(s, truck);
    if (!eq.ok) return { stop: s, reasons: eq.reasons };
  }
  // STRICT window: the stop with the greatest lateness past its window end.
  // Skipped entirely in advisory mode (windows flag, never spill).
  if (!enforceWindows) return null;
  // A customer shut on the day has no window to be late for — there is no delivery to make.
  const shut = ordered.find((s) => s.closedToday);
  if (shut) return { stop: shut, reasons: [REASON.closedToday] };
  let worst: SolverStop | null = null, worstLate = 0;
  ordered.forEach((s, i) => {
    if (!windowOk(s, etas[i])) {
      const late = etas[i] - (s.timeWindow!.endSec);
      if (late > worstLate || worst === null) { worstLate = late; worst = s; }
    }
  });
  if (worst) return { stop: worst, reasons: [REASON.windowUnsatisfiable] };
  return null;
}

// Can `stop` be inserted into this truck's stop set with the result fully valid?
// In advisory mode windows are ignored for the validity test (capacity + equipment
// only), so a window-only mismatch never blocks recovery.
function canInsert(stop: SolverStop, truckStops: SolverStop[], truck: SolverTruck, input: SolverInput, indexById: Map<string, number>, enforceWindows: boolean): boolean {
  const eq = equipmentOk(stop, truck);
  if (!eq.ok) return false;
  const cap = capacityFits(computeLoad(truckStops), stop, truck);
  if (!cap.ok) return false;
  if (!enforceWindows) return true;
  const ordered = orderForTruck([...truckStops, stop], input, indexById);
  const etas = etasFor(ordered, indexById, input.matrix, input.departEpochSec ?? 0);
  return ordered.every((s, i) => windowOk(s, etas[i]));
}

// Stops kept on an ordered route whose STRICT-window ETA is missed (advisory flag).
function windowViolations(ordered: SolverStop[], etas: number[]): string[] {
  return ordered.filter((s, i) => !windowOk(s, etas[i])).map((s) => s.id);
}

// PHASE B TRIES A STOP'S OWN TRUCK FIRST. Recovery used to be first-fit over the trucks in the
// order they were picked, with no memory of where a spilled stop came from. On a strict build
// repair can take a stop off for a missed window and then take a second stop off the same
// truck — after which the first fits again. First-fit handed it to whichever truck was listed
// first, so an east-side truck drove across town for one west-side stop while the west truck
// the solver chose for it, which could still take it, ran light.
// PUT IT BACK: ROUTING_REPAIR_ORIGIN_FIRST=off. House shape: default ON, an explicit
// off/0/false/no turns it off, anything malformed leaves it ON. meta.recoverOriginFirst says
// which ran.
export function repairOriginFirstEnabled(env: Record<string, any> = process.env): boolean {
  const v = String(env?.ROUTING_REPAIR_ORIGIN_FIRST ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export function repair(input: SolverInput, output: SolverOutput, opts?: { originFirst?: boolean }): SolverOutput {
  const originFirst = typeof opts?.originFirst === 'boolean' ? opts.originFirst : repairOriginFirstEnabled();
  const indexById = new Map<string, number>();
  input.stops.forEach((s, k) => indexById.set(s.id, k + 1));
  const idByIndex = new Map<number, string>();
  indexById.forEach((idx, id) => idByIndex.set(idx, id));
  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  const depart = input.departEpochSec ?? 0;
  // Default ADVISORY: windows flag, never spill. STRICT keeps the old drop behavior.
  const enforceWindows = input.windowMode === 'strict';

  // Working stop sets per truck (from the solver's assignment).
  const sets = new Map<string, SolverStop[]>();
  for (const r of output.routes) sets.set(r.truckId, r.orderedStopIds.map((id) => stopById.get(id)!).filter(Boolean));
  const unassigned: UnassignedStop[] = output.unassigned.map((u) => ({ stopId: u.stopId, reasons: [...u.reasons] }));

  // ── Phase A: shrink each truck until valid ───────────────────────────────────
  const spilledFrom = new Map<string, string>();   // stopId → the truck Phase A took it off
  for (const truck of input.trucks) {
    let stops = sets.get(truck.id) ?? [];
    // Budget fixed BEFORE the loop: each pass removes one stop, so a cap that re-read
    // stops.length halved as it went and quit with violators still on the truck (the same
    // trap routing-solver's Phase 3 documents). n passes suffice; +2 is slack.
    const maxIters = stops.length + 2;
    let guard = 0;
    // A STRICT stop no order can make in time comes off FIRST, saying why — before it can steer
    // the window order and push a stop that could be made past its close (ROUTING_BUILD_WINDOW_REACH).
    if (enforceWindows && input.windowReach === true) {
      for (const { stop, reason } of unreachableIn(stops, truck, input, indexById, depart)) {
        stops = stops.filter((s) => s.id !== stop.id);
        unassigned.push({ stopId: stop.id, reasons: [reason] });
        spilledFrom.set(stop.id, truck.id);
      }
    }
    while (stops.length && guard++ < maxIters) {
      const ordered = orderForTruck(stops, input, indexById);
      const etas = etasFor(ordered, indexById, input.matrix, depart);
      const v = worstViolator(ordered, etas, truck, enforceWindows);
      if (!v) { stops = ordered; break; }
      stops = ordered.filter((s) => s.id !== v.stop.id);
      unassigned.push({ stopId: v.stop.id, reasons: v.reasons });
      spilledFrom.set(v.stop.id, truck.id);
    }
    sets.set(truck.id, stops);
  }

  // ── Phase B: try to recover spilled stops into any truck where they're valid ──
  const stillUnassigned: UnassignedStop[] = [];
  const freedTrucks = new Set(spilledFrom.values());   // trucks Phase A took a stop off
  // With the ends rule on, stops Phase A took off are offered first (their own truck first), then
  // the solver's leftovers, so the room a window-drop freed goes back to the stop that left it
  // before anyone else's. With it off, the order is exactly what it always was.
  const phaseB = input.leaveOffEnds
    ? [...unassigned.filter((u) => spilledFrom.has(u.stopId)), ...unassigned.filter((u) => !spilledFrom.has(u.stopId))]
    : unassigned;
  for (const u of phaseB) {
    const stop = stopById.get(u.stopId);
    if (!stop) { stillUnassigned.push(u); continue; }
    // ROUTING_BUILD_LEAVE_OFF_ENDS: the solver already chose which stops come off a full truck
    // (the end of a run, never a stop it drives past — lib/routing-assign-ends.mts) and already
    // gave room to overflow first. Re-inserting those here, into whichever truck in list order
    // has a skid spare, undid that — measured: a box sent 25 km into the other box's town for one
    // skid. So a stop the SOLVER left off is offered only room THIS loop just made — a truck that
    // lost a stop for its window in Phase A — and only when it is on that truck's way (no more
    // driving than its average stop). Without that, a strict-window build left trucks light while
    // stops that fit were listed "over skid capacity" (measured: 7.3% of routed skids).
    if (input.leaveOffEnds && !spilledFrom.has(stop.id)) {
      const freed = input.trucks.filter((t) => freedTrucks.has(t.id));
      let taken = false;
      for (const truck of freed) {
        const mine = sets.get(truck.id)!;
        if (!canInsert(stop, mine, truck, input, indexById, enforceWindows)) continue;
        if (!onTheWayM(stop, orderForTruck(mine, input, indexById), input.depot)) continue;
        sets.set(truck.id, [...mine, stop]);
        taken = true;
        break;
      }
      if (taken) continue;
      // Still off. If a freed truck could carry it by capacity alone, "over skid capacity" is no
      // longer true — say how far out of the way it is instead.
      const roomy = freed.filter((t) => equipmentOk(stop, t).ok && capacityFits(computeLoad(sets.get(t.id)!), stop, t).ok);
      stillUnassigned.push(roomy.length
        ? { stopId: u.stopId, reasons: [outOfWayReason(stop, roomy.map((t) => ({ label: t.label || t.id, run: orderForTruck(sets.get(t.id)!, input, indexById) })), input.depot)] }
        : u);
      continue;
    }
    let placed = false;
    const own = originFirst ? input.trucks.find((t) => t.id === spilledFrom.get(stop.id)) : undefined;
    const tryOrder = own ? [own, ...input.trucks.filter((t) => t !== own)] : input.trucks;
    for (const truck of tryOrder) {
      if (canInsert(stop, sets.get(truck.id)!, truck, input, indexById, enforceWindows)) {
        sets.set(truck.id, [...sets.get(truck.id)!, stop]);
        placed = true;
        break;
      }
    }
    if (!placed) stillUnassigned.push(u);
  }

  // ── assemble final, provably-valid routes ────────────────────────────────────
  const routes: BuiltRoute[] = [];
  for (const truck of input.trucks) {
    const stops = sets.get(truck.id) ?? [];
    if (!stops.length) continue;
    const ordered = orderForTruck(stops, input, indexById);
    const nodes = ordered.map((s) => indexById.get(s.id)!);
    const route = assembleRoute(truck, stops, nodes, idByIndex, input.matrix, depart);
    // Advisory flag: STRICT-window stops kept on the route whose ETA misses the
    // window (always empty in strict mode — those were spilled in Phase A).
    route.windowViolatedIds = windowViolations(ordered, etasFor(ordered, indexById, input.matrix, depart));
    routes.push(route);
  }

  return {
    routes,
    unassigned: dedupeUnassigned(stillUnassigned),
    meta: { ...output.meta, repaired: true, recoverOriginFirst: originFirst, ...(input.windowReach === true ? { windowReach: true } : {}) },
  };
}

function dedupeUnassigned(list: UnassignedStop[]): UnassignedStop[] {
  const m = new Map<string, Set<string>>();
  for (const u of list) {
    if (!m.has(u.stopId)) m.set(u.stopId, new Set());
    for (const r of u.reasons) m.get(u.stopId)!.add(r);
  }
  return [...m.entries()].map(([stopId, reasons]) => ({ stopId, reasons: [...reasons] }));
}
