// lib/truck-capacity.mts
//
// A TRUCK WITH NO SKID LIMIT IS NOT A FACT ABOUT FREIGHT — it is a missing number.
//
// Chad, 2026-09-15: "I gave it two box truckloads to put 25 orders on that was about 25
// skids. And box trucks can hold, let's call it 14 pallets. It gave four pallets to one box
// truck and 20 to the other."
//
// RUN, NOT REASONED. The same 25 orders over his own four towns, through the real pipeline:
//   maxSkids 14 (the shipped 26ft Box default) → 11 / 14. Balanced, and inside the truck.
//   maxSkids 0  (a blank box)                  →  6 / 19.
//   maxSkids 26 (a number typed too big)       →  6 / 19.
// So the 4/20 split is not the assignment being careless — it is the CAP not binding. And the
// zero case is the dangerous one, because routing-constraints.capLimited reads a non-positive
// cap as NO LIMIT: the skid gate switches off AND loadFraction returns 0, which silently kills
// the balance term the assignment uses to spread work. One blank field and the solver will
// cheerfully plan nineteen skids onto a truck that holds fourteen, with nothing on screen
// saying why.
//
// "No limit" is the right reading for a cap nobody has ever set on an ABSTRACT profile. It is
// the wrong reading for a truck: every truck has a floor. So a missing or non-positive cap
// takes its CLASS default here, and the substitution is REPORTED — a defaulted cap the
// dispatcher cannot see is the same invisible failure wearing a better number.
//
// Where the zero came from is worth writing down: until v1.31.0 the Trucks-mode capacity
// fields wrote the fleet profile on blur, and Number('') is 0 — so tabbing out of a cleared
// Skids box stored a 0-skid profile that every later build in both modes then read. The
// editor refuses that now; this is the other half, because a 0 already in Firestore keeps
// poisoning builds until somebody retypes it.

import type { SolverTruck } from './routing-types.mts';

// The floors, by truck class. Same numbers as DEFAULT_TRUCK_PROFILES (26ft box ≈ 14 skids /
// 10k lb; 53ft trailer ≈ 28 / 44k) — kept here rather than imported so this module stays pure
// and testable without Firestore.
export const CLASS_CAPS = {
  tractor: { maxSkids: 28, maxWeightLbs: 44000 },
  box: { maxSkids: 14, maxWeightLbs: 10000 },
} as const;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Which floor applies: a 53' tractor, or a straight/box truck. */
export function capsForTruck(truck: Pick<SolverTruck, 'capabilities'>) {
  const cap = truck?.capabilities;
  const isTractor = cap?.tractor === true || Number(cap?.lengthClassFt) >= 40;
  return isTractor ? CLASS_CAPS.tractor : CLASS_CAPS.box;
}

export interface TruckCapNote {
  truckId: string;
  label: string;
  field: 'maxSkids' | 'maxWeightLbs';
  was: unknown;
  used: number;
  text: string;
}

/**
 * Give every truck a real skid and weight ceiling, and say where one had to be supplied.
 * Never LOWERS a cap the dispatcher set — a profile saying 20 skids is their call, and this
 * only fills in what is missing.
 */
export function resolveTruckCaps(trucks: SolverTruck[] = []): { trucks: SolverTruck[]; notes: TruckCapNote[] } {
  const notes: TruckCapNote[] = [];
  const out = (trucks || []).map((t) => {
    if (!t) return t;
    const floor = capsForTruck(t);
    const next = { ...t };
    const label = t.label || String(t.id ?? 'truck');
    if (!positive(t.maxSkids)) {
      next.maxSkids = floor.maxSkids;
      notes.push({
        truckId: String(t.id ?? ''), label, field: 'maxSkids', was: t.maxSkids, used: floor.maxSkids,
        text: `${label} has no skid limit on its truck profile — planned at ${floor.maxSkids} skids. Set it in 2 · Plan onto → Trucks.`,
      });
    }
    if (!positive(t.maxWeightLbs)) {
      next.maxWeightLbs = floor.maxWeightLbs;
      notes.push({
        truckId: String(t.id ?? ''), label, field: 'maxWeightLbs', was: t.maxWeightLbs, used: floor.maxWeightLbs,
        text: `${label} has no weight limit on its truck profile — planned at ${floor.maxWeightLbs.toLocaleString()} lb. Set it in 2 · Plan onto → Trucks.`,
      });
    }
    return next;
  });
  return { trucks: out, notes };
}
