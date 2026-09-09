// lib/routing-constraints.mts
//
// PURE hard-constraint checks shared by the solver and the repair loop. Keeping
// them in one place means "what makes a route valid" is defined exactly once, so
// the solver's assignment and the repair loop's validation can never drift apart.
//
// Equipment mapping (customer_notes restriction → required truck capability):
//   no_tractor_trailer / box_truck_only / straight_truck_only / uline_straight_truck
//                          → truck must NOT be a tractor (capabilities.tractor === false)
//   26ft_max               → truck lengthClassFt <= 26
//   no_53                  → truck lengthClassFt !== 53 (i.e. < 53)
//   no_overhead_clearance  → truck must NOT be a tractor AND not flagged
//                            overheadClearance:false (a trailer / tall box can't
//                            clear a low dock)
//   liftgate_required      → truck.capabilities.liftgate === true

import type { SolverStop, SolverTruck, RouteLoad, EquipmentReq } from './routing-types.mts';

// Human-readable reason strings (surfaced to the dispatcher in the spill list).
export const REASON = {
  overSkids: 'over skid capacity',
  overWeight: 'over weight capacity',
  overDeck: 'over deck length',
  needsStraightTruck: 'needs straight/box truck (no tractor-trailer)',
  needs26: 'needs 26ft (or smaller) truck',
  needsNo53: 'cannot use a 53ft trailer',
  needsLiftgate: 'needs a liftgate',
  needsLowClearance: 'needs a low-overhead-clearance truck',
  windowUnsatisfiable: 'appointment window cannot be met',
  noTruckFits: 'no selected truck can carry this stop',
} as const;

// Does `truck` satisfy a single equipment requirement? Returns a reason when not.
export function equipmentReqOk(req: EquipmentReq, truck: SolverTruck): { ok: boolean; reason?: string } {
  const cap = truck.capabilities;
  switch (req) {
    case 'no_tractor_trailer':
    case 'box_truck_only':
    case 'straight_truck_only':
    case 'uline_straight_truck':
      return cap.tractor ? { ok: false, reason: REASON.needsStraightTruck } : { ok: true };
    case '26ft_max':
      return cap.lengthClassFt <= 26 ? { ok: true } : { ok: false, reason: REASON.needs26 };
    case 'no_53':
      return cap.lengthClassFt !== 53 ? { ok: true } : { ok: false, reason: REASON.needsNo53 };
    case 'liftgate_required':
      return cap.liftgate ? { ok: true } : { ok: false, reason: REASON.needsLiftgate };
    case 'no_overhead_clearance':
      return (!cap.tractor && cap.overheadClearance !== false) ? { ok: true } : { ok: false, reason: REASON.needsLowClearance };
    default:
      return { ok: true }; // unknown restriction → don't block (logged upstream)
  }
}

// All equipment requirements satisfiable by this truck?
export function equipmentOk(stop: SolverStop, truck: SolverTruck): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const req of stop.equipmentReqs || []) {
    const r = equipmentReqOk(req, truck);
    if (!r.ok && r.reason) reasons.push(r.reason);
  }
  return { ok: reasons.length === 0, reasons };
}

export function emptyLoad(): RouteLoad {
  return { skids: 0, weightLbs: 0, linearFeetIn: 0 };
}

export function addLoad(load: RouteLoad, stop: SolverStop): RouteLoad {
  return {
    skids: load.skids + (stop.skids || 0),
    weightLbs: load.weightLbs + (stop.weightLbs || 0),
    linearFeetIn: load.linearFeetIn + (stop.linearFeetIn || 0),
  };
}

export function computeLoad(stops: SolverStop[]): RouteLoad {
  return stops.reduce(addLoad, emptyLoad());
}

// Which capacity dimensions BLOCK placement. SKID COUNT is the limit the
// dispatcher plans by, so it gates. DECK/FLOOR LENGTH does NOT block: the per-stop
// linearFeetIn estimate is currently inflated for oversize freight (each oversize
// piece is counted as a full ~pallet-length × quantity), which spilled entire
// selections with "over deck length". Deck stays COMPUTED + shown as info; flip
// `deckLengthIn` to true to re-enable it after the deferred floor-length-in-FEET
// rework fixes that estimate. WEIGHT gates, but only when the truck has a real
// positive weight cap (see capLimited).
export const CAPACITY_GATES = { skids: true, weightLbs: true, deckLengthIn: false } as const;

// Root-cause hardening: a capacity only constrains when it's a real positive
// number. Non-positive / null / undefined / NaN means "NO LIMIT for that
// dimension" — never zero. A missing or zero cap must never spill a stop.
function capLimited(cap: number | null | undefined): cap is number {
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0;
}

/**
 * WHICH CAPACITIES THIS LOAD BREACHES ON THIS TRUCK. The ONE definition — the header of this
 * file promises that "what makes a route valid is defined exactly once, so the solver's
 * assignment and the repair loop's validation can never drift apart", and they had drifted:
 * routing-repair's worstViolator carried its own copy that honoured NEITHER the gates NOR the
 * positive-cap rule. It therefore spilled on DECK LENGTH, which CAPACITY_GATES switches off
 * precisely because the per-stop linearFeetIn estimate is inflated, and printed "over deck
 * length" as the reason — a reason the comment above says can never spill. Measured on the
 * real modules: a 30-stop board came back with 2 stops spilled for a limit that is not
 * enforced, after the geographic assignment had already been shredded to satisfy it.
 *
 * A dimension blocks only when its gate is ON and the truck's cap is a real positive number,
 * so a missing or zero cap can never cause a spill.
 */
export function capacityBreaches(load: RouteLoad, truck: SolverTruck): string[] {
  const reasons: string[] = [];
  if (CAPACITY_GATES.skids && capLimited(truck.maxSkids) && load.skids > truck.maxSkids) reasons.push(REASON.overSkids);
  if (CAPACITY_GATES.weightLbs && capLimited(truck.maxWeightLbs) && load.weightLbs > truck.maxWeightLbs) reasons.push(REASON.overWeight);
  if (CAPACITY_GATES.deckLengthIn && capLimited(truck.deckLengthIn) && load.linearFeetIn > truck.deckLengthIn) reasons.push(REASON.overDeck);
  return reasons;
}

// Would adding `stop` to `current` load keep the truck within capacity? Reasons
// for any breach. (Single-stop fit = check against an empty load.)
export function capacityFits(current: RouteLoad, stop: SolverStop, truck: SolverTruck): { ok: boolean; reasons: string[] } {
  const reasons = capacityBreaches(addLoad(current, stop), truck);
  return { ok: reasons.length === 0, reasons };
}

/**
 * PURE. How full this truck is, 0..1, on the dimensions that actually GATE placement. Used to
 * spread work across a fleet instead of filling whichever truck happens to be nearest — see
 * the balance term in routing-solver's Phase 3. A truck with no real cap on any gated
 * dimension returns 0: unknown is not full.
 */
export function loadFraction(load: RouteLoad, truck: SolverTruck): number {
  const fracs: number[] = [];
  if (CAPACITY_GATES.skids && capLimited(truck.maxSkids)) fracs.push(load.skids / truck.maxSkids);
  if (CAPACITY_GATES.weightLbs && capLimited(truck.maxWeightLbs)) fracs.push(load.weightLbs / truck.maxWeightLbs);
  if (CAPACITY_GATES.deckLengthIn && capLimited(truck.deckLengthIn)) fracs.push(load.linearFeetIn / truck.deckLengthIn);
  return fracs.length ? Math.max(...fracs) : 0;
}

// Can this truck EVER carry this stop on its own (capability + single-stop capacity)?
// Used to decide spill-with-reason vs. "try another truck".
export function truckCanCarry(stop: SolverStop, truck: SolverTruck): { ok: boolean; reasons: string[] } {
  const eq = equipmentOk(stop, truck);
  const cap = capacityFits(emptyLoad(), stop, truck);
  const reasons = [...eq.reasons, ...cap.reasons];
  return { ok: reasons.length === 0, reasons };
}

// Window check for a STRICT stop given an arrival time (epoch sec). SOFT windows
// never fail (they're advisory and surface as risk flags instead).
export function windowOk(stop: SolverStop, arrivalSec: number): boolean {
  if (stop.timeConstraint !== 'STRICT' || !stop.timeWindow) return true;
  return arrivalSec >= stop.timeWindow.startSec && arrivalSec <= stop.timeWindow.endSec;
}
