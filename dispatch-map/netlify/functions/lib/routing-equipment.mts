// lib/routing-equipment.mts
//
// WHICH TRUCK MAY TAKE THIS STOP — the Build button's rule, in one place.
//
// It lived inside routing-build-background.mts, so the only builder that could read it was
// the Build button. Step 4's "Fill my loads" had grown its own, narrower rule: one
// "blocks a tractor" bit off equipment_restrictions, no green (Tractor OK) or red (Box only)
// mark, no "only green on a 53'" toggle, and liftgate read off the array but never off the
// note's liftgate_required boolean. The same stop could come back on a tractor from one
// button and on a box from the other. Chad, 2026-09-26, picking which way to fix it: the
// engine should fill the loads he ticks "fixed to follow the Build rules". So the rule moved
// here and both builders import it — they cannot drift apart again without a diff that says so.
//
// Pure. No I/O. Its truck-side twin is equipmentOk in routing-constraints.mts.

import type { EquipmentReq } from './routing-types.mts';

export const KNOWN_REQS = new Set<EquipmentReq>([
  'no_tractor_trailer', 'uline_straight_truck', 'straight_truck_only', 'box_truck_only',
  '26ft_max', 'no_53', 'no_overhead_clearance', 'liftgate_required',
]);

// Equipment requirements a 53' tractor-trailer can't satisfy. A dispatcher's explicit
// "tractor OK" (green) mark suppresses these — green wins over an auto-detected
// restriction. Liftgate is orthogonal and is never suppressed.
export const TRAILER_BLOCKERS = new Set<EquipmentReq>([
  'no_tractor_trailer', 'uline_straight_truck', 'straight_truck_only', 'box_truck_only',
  '26ft_max', 'no_53', 'no_overhead_clearance',
]);

export function equipmentReqsFrom(note: any, opts?: { tractorOnlyGreen?: boolean }): EquipmentReq[] {
  try {
    let reqs: EquipmentReq[] = [];
    const arr = note?.equipment_restrictions;
    if (Array.isArray(arr)) for (const r of arr) if (KNOWN_REQS.has(r)) reqs.push(r);
    if (note?.liftgate_required === true && !reqs.includes('liftgate_required')) reqs.push('liftgate_required');
    // Dispatcher-set vehicle eligibility (the Routing green/red marking — a property
    // of the LOCATION). Green ('tractor') = a 53' fits → drop any trailer-blocking
    // restriction (green wins over an auto-detected one). Red ('box_only') → force a
    // straight/box truck. And when the build opts into "trailer = green only", any
    // stop NOT marked green is held to a box truck too, so only green rides a 53'.
    const elig = note?.vehicle_eligibility;
    if (elig === 'tractor') {
      reqs = reqs.filter((r) => !TRAILER_BLOCKERS.has(r));
    } else if (elig === 'box_only' || opts?.tractorOnlyGreen === true) {
      if (!reqs.includes('box_truck_only')) reqs.push('box_truck_only');
    }
    return reqs;
  } catch { return []; }
}
