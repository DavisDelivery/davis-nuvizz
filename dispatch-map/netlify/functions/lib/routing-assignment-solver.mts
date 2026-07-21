// lib/routing-assignment-solver.mts
//
// PHASE 2 — ASSIGNMENT SOLVER (pure, unit-testable). Builds the DAY PLAN: given
// the stops dispatch planned and the drivers who actually worked (staffing is
// dispatch's INPUT; loading is the engine's OUTPUT — this boundary is deliberate
// and lets the plan be scored against what dispatch did with the same crew),
// assign every stop to a driver-shift, where a shift is an ordered chain of
// 1..N trips through a Buford reload, split far-first.
//
// HARD constraints (inviolable):
//   • equipment — a stop flagged "can't take a tractor" (customer_notes
//     equipment_restrictions ∩ the trailer-blocker set) may not go to a tractor
//     driver. tractor_locations is POSITIVE capability and never restricts.
//   • per-trip ceiling — a trip's weight may not exceed the driver's per-trip
//     envelope p85 × hard_cap_factor (the LEARNED BEHAVIORAL ceiling — the
//     soft-max of the driver's observed practice, NOT truck GVWR/physics; a
//     driver who never loaded heavy simply hasn't shown us more). Unknown
//     envelope → no ceiling (can't enforce what we haven't observed).
// SOFT costs (config-weighted): envelope over/under-load, zone-affinity misfit,
// trips-count vs propensity, shift-hours overflow, far-first violation,
// STRICT-window risk, plan compactness.
//
// Method: greedy seed (weight-desc → best feasible driver by affinity + headroom;
// split each driver's freight far-first to respect the ceiling) → deterministic
// local search (relocate across drivers, swap, move between a driver's trips,
// re-split/merge repairs) minimizing total soft cost, hard constraints never
// broken. Deterministic seed from the date; wall-clock cap from config.
//
// Travel is the Phase 1 haversine estimator (ZERO Route Matrix calls). Final
// trip sequencing is delegated to the Phase 1 solver by the caller.

import type { EngineConfig } from './routing-engine-config.mts';
import type { DriverEnvelope } from './routing-envelope.mts';
import type { FleetTripChain, ZoneOwners } from './routing-envelope.mts';
import {
  DEPOT_ID, haversineMiles, buildTravelMatrix, travelMinutesForOrder,
  travelMinutesForMiles, seedFromKey, mulberry32, type EngineStop,
} from './routing-engine-solver.mts';
import type { CostMatrix } from './score.mts';

// The customer_notes restriction keys that forbid a tractor/trailer (v1 reduces
// all equipment to the single "tractor-capable?" axis the roster class supports).
export const TRAILER_BLOCKER_KEYS = new Set([
  'no_tractor_trailer', 'box_truck_only', 'straight_truck_only',
  'uline_straight_truck', 'no_53', '26ft_max', 'no_overhead_clearance',
]);
export function restrictionsBlockTractor(restrictions: any[]): boolean {
  for (const r of restrictions || []) if (TRAILER_BLOCKER_KEYS.has(String(r))) return true;
  return false;
}

export interface AssignStop {
  id: string;
  lat: number; lng: number;
  zone: string;         // gh6
  gh5: string;          // gh5 (affinity bucket)
  pallets: number;      // TOTAL pieces (skids + loose) — NuVizz's mislabeled "pallets"
  skids: number;        // real skid/pallet positions (NuVizz "cartons") — a truck-fill dimension
  loose: number;        // loose pieces (NuVizz "volume") — a truck-fill dimension
  weight: number;
  matchKey: string | null;
  strict: boolean;      // STRICT delivery window
  miles: number;        // distance-from-origin estimate
  blocksTractor: boolean;
  // Phase 2.1: the customer's habitual driver as-of the plan date (< D), from
  // routing_customer_drivers. Null when the customer has no delivered history.
  habit?: { topDriver: string; topShare: number; n: number } | null;
}

// Habit signal strength: top_share shrunk toward 0 for thin history —
// n/(n + habit_shrink_n), so 2 deliveries whisper and 20 speak plainly.
export function habitStrength(habit: { topShare: number; n: number } | null | undefined, shrinkN: number): number {
  if (!habit || !(habit.n > 0)) return 0;
  return habit.topShare * (habit.n / (habit.n + Math.max(0, shrinkN)));
}

export interface AssignDriver {
  driver_key: string;
  driver_user_name: string | null;
  driver_name: string | null;
  truck_class: string | null;
  start_minute: number | null;
  envelope: DriverEnvelope;
  affinity: Map<string, number>;
}

export interface AssignInput {
  date: string;
  stops: AssignStop[];
  drivers: AssignDriver[];
  fleetChain: FleetTripChain;
  cfg: EngineConfig;
  depot: { lat: number; lng: number };
  serviceMedianFor: (stop: AssignStop) => number; // as-of median service minutes
  // Phase 2.3: learned territory owners per TOP zone (as-of < D). Consulted for
  // FAR stops only — a Dalton stop outside Dalton's owner set is charged hard.
  zoneOwners?: Map<string, ZoneOwners>;
  now?: () => number;
}

// TOP zone of a stop — the geohash prefix property makes it a plain slice.
function topZoneOf(s: AssignStop, cfg: EngineConfig): string {
  return String(s.zone || '').slice(0, cfg.top_precision);
}
// Is this driver in the stop's learned owner set? Returns null when the zone has
// no learned owners (open territory) — callers treat that as "no signal".
function ownedBy(s: AssignStop, driverUserName: string | null, input: AssignInput): boolean | null {
  if (!input.zoneOwners || s.miles <= input.cfg.far_deadhead_mi) return null;
  const zo = input.zoneOwners.get(topZoneOf(s, input.cfg));
  if (!zo) return null;
  return driverUserName != null && zo.owners.has(String(driverUserName).toUpperCase());
}

export interface AssignedTrip { stops: AssignStop[] }
export interface AssignedShift { driver: AssignDriver; trips: AssignedTrip[] }
export interface AssignResult {
  date: string;
  shifts: AssignedShift[];
  unassigned: AssignStop[];   // stops no active driver could serve (equipment) — reported
  cost: number;
  drivers_used: number;
}

const isTractor = (d: AssignDriver) => String(d.truck_class || '') === 'tractor';

export function driverCanServe(driver: AssignDriver, stop: AssignStop): boolean {
  if (stop.blocksTractor && isTractor(driver)) return false;
  return true;
}
function tripCeiling(driver: AssignDriver, cfg: EngineConfig): number {
  // LEARNED BEHAVIORAL ceiling, tightened to real practice: p85 × factor chops
  // the top-15% tail of trips dispatch ACTUALLY ran (by definition of p85) and
  // manufactures phantom splits the crew can't cover. The observed per-trip MAX
  // is proof the weight fits on one truck, so the ceiling is whichever is
  // higher — never split what a driver has already carried in one trip.
  const pt = driver.envelope?.per_trip;
  const p85 = pt?.weight_p85;
  const seen = pt?.weight_max;
  const capP85 = p85 != null && p85 > 0 ? p85 * cfg.hard_cap_factor : null;
  const capSeen = seen != null && seen > 0 ? seen : null;
  if (capP85 == null && capSeen == null) return Infinity;
  return Math.max(capP85 ?? 0, capSeen ?? 0);
}
function tripWeight(t: AssignedTrip): number { return t.stops.reduce((a, s) => a + (s.weight || 0), 0); }

// Nearest-neighbor tour minutes for a trip (depot → stops), cheap proxy used
// inside the search; the final proposal re-sequences with the Phase 1 solver.
function tripTravelMin(trip: AssignedTrip, depot: { lat: number; lng: number }, cfg: EngineConfig, matrixCache: Map<string, CostMatrix>): number {
  if (!trip.stops.length) return 0;
  const key = trip.stops.map((s) => s.id).sort().join('|');
  let matrix = matrixCache.get(key);
  if (!matrix) {
    const pts: EngineStop[] = trip.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, zone: s.zone }));
    matrix = buildTravelMatrix([{ id: DEPOT_ID, lat: depot.lat, lng: depot.lng }, ...pts], cfg);
    matrixCache.set(key, matrix);
  }
  // nearest-neighbor order from depot
  const remaining = new Set(trip.stops.map((s) => s.id));
  const order: string[] = [];
  let cur = DEPOT_ID;
  while (remaining.size) {
    let best: string | null = null, bd = Infinity;
    for (const id of [...remaining].sort()) { const d = matrix[cur][id]; if (d < bd) { bd = d; best = id; } }
    order.push(best!); remaining.delete(best!); cur = best!;
  }
  const stopById = new Map(trip.stops.map((s) => [s.id, s] as const));
  return travelMinutesForOrder(order.map((id) => ({ id, ...({ lat: stopById.get(id)!.lat, lng: stopById.get(id)!.lng, zone: stopById.get(id)!.zone }) })), matrix);
}

function tripServiceMin(trip: AssignedTrip, serviceMedianFor: (s: AssignStop) => number): number {
  return trip.stops.reduce((a, s) => a + serviceMedianFor(s), 0);
}

// ── soft cost ────────────────────────────────────────────────────────────────

export function shiftCost(
  shift: AssignedShift, input: AssignInput, matrixCache: Map<string, CostMatrix>,
): number {
  const { cfg, fleetChain, depot, serviceMedianFor } = input;
  const env = shift.driver.envelope;
  const trips = shift.trips.filter((t) => t.stops.length);
  if (!trips.length) return 0;
  let cost = 0;

  const wMedian = env.per_trip.weight_median;
  let shiftActiveMin = 0;
  const tripRadii: number[] = [];

  for (let ti = 0; ti < trips.length; ti++) {
    const t = trips[ti];
    const w = tripWeight(t);
    // over/under-load vs the driver's typical trip weight
    if (wMedian != null && wMedian > 0) {
      const dev = (w - wMedian) / wMedian;
      cost += dev > 0 ? cfg.w_overload * dev : cfg.w_underload * -dev;
    }
    // zone-affinity misfit: stops in gh5 zones this driver rarely serves
    let misfit = 0;
    for (const s of t.stops) misfit += 1 - (shift.driver.affinity.get(s.gh5) || 0);
    cost += cfg.w_affinity * (misfit / t.stops.length);

    // Phase 2.1: customer-habit term. A stop whose HABITUAL driver (as-of < D)
    // is someone else charges w_habit × strength per stop — customer-level
    // signal, so it is NOT averaged like the zone-level affinity: one strongly
    // habitual customer on the wrong truck outranks a mild zone misfit
    // (w_habit ≥ w_affinity by default). Assigning to the habitual driver
    // charges nothing (the "bonus" is the absence of this cost — keeps the
    // objective non-negative for the local search).
    for (const s of t.stops) {
      if (!s.habit?.topDriver) continue;
      if (shift.driver.driver_user_name && s.habit.topDriver === String(shift.driver.driver_user_name).toUpperCase()) continue;
      // Phase 2.2: FAR stops discount the habit pull. Out at the edge, geography
      // and consolidation must outweigh "the usual driver" — honoring per-customer
      // habit for a distant loop is exactly what scattered it across every driver
      // who happens to "own" one of those customers.
      const habitScale = s.miles > cfg.far_deadhead_mi ? cfg.habit_far_discount : 1;
      cost += cfg.w_habit * habitStrength(s.habit, cfg.habit_shrink_n) * habitScale;
    }

    const travel = tripTravelMin(t, depot, cfg, matrixCache);
    const service = tripServiceMin(t, serviceMedianFor);
    shiftActiveMin += travel + service;
    if (ti > 0) shiftActiveMin += fleetChain.reload_gap_median_min; // reload turn

    // STRICT-window risk: a STRICT stop whose plausible arrival falls outside the
    // trip's span (start + this trip's travel+service) reads as risky.
    const start = shift.driver.start_minute ?? env.start_minute_typical ?? 240; // ~4:00 AM fallback
    const tripEnd = start + shiftActiveMin;
    for (const s of t.stops) {
      if (s.strict && tripEnd > start + (env.shift_hours_typical ?? cfg.typical_shift_hours) * 60) cost += cfg.w_strict_window;
    }
    tripRadii.push(t.stops.reduce((a, s) => a + s.miles, 0) / t.stops.length);
  }

  // far-first: trip 1 should be farther out than trip 2 (chain shape)
  if (trips.length >= 2 && tripRadii[0] < tripRadii[1]) cost += cfg.w_far_first * fleetChain.far_first_rate;

  // trips-count vs propensity (a driver who rarely double-trips shouldn't be forced to)
  const expectedTrips = 1 + (env.trips_per_day_propensity || 0);
  cost += cfg.w_trips * Math.abs(trips.length - expectedTrips);

  // shift-hours overflow
  const shiftBudgetMin = (env.shift_hours_typical ?? cfg.typical_shift_hours) * 60;
  if (shiftActiveMin > shiftBudgetMin) cost += cfg.w_shift_overflow * ((shiftActiveMin - shiftBudgetMin) / 60);

  // Phase 2.5 — daily-capacity overflow. A driver-day past their LEARNED daily
  // skid/loose capacity (the real truck-fill dimensions) is charged per fractional
  // unit over, so the plan won't pile a whole day onto one broad-territory driver —
  // and, unlike the seed's head-start alone, the SEARCH now respects it too (the
  // seed spread a pileup only for w_habit to pull it back, since the habitual
  // driver pays no habit cost). Whichever dimension fills first binds. Charged only
  // when capacity is learned and w_day_capacity > 0 (else pure back-compat).
  if (cfg.w_day_capacity > 0) {
    const daySkids = trips.reduce((a, t) => a + t.stops.reduce((b, s) => b + (s.skids || 0), 0), 0);
    const dayLoose = trips.reduce((a, t) => a + t.stops.reduce((b, s) => b + (s.loose || 0), 0), 0);
    const overs: number[] = [];
    if (env.day_skids_p85 && env.day_skids_p85 > 0) overs.push((daySkids - env.day_skids_p85) / env.day_skids_p85);
    if (env.day_loose_p85 && env.day_loose_p85 > 0) overs.push((dayLoose - env.day_loose_p85) / env.day_loose_p85);
    const over = overs.length ? Math.max(...overs) : 0;
    if (over > 0) cost += cfg.w_day_capacity * over;
  }

  // Phase 2.2 — far-deadhead reach. A driver reaching past far_deadhead_mi pays a
  // per-shift charge for the deep leg, charged ONCE on their farthest stop. So
  // once a driver is already out at the edge, adding MORE far stops to them is
  // ~free, while sending a fresh near-depot truck out there pays a NEW charge —
  // which is precisely what makes a distant loop coalesce onto one truck instead
  // of dragging several trucks 60 mi out for a few stops each.
  const shiftReach = Math.max(0, ...trips.flatMap((t) => t.stops.map((s) => s.miles)));
  if (shiftReach > cfg.far_deadhead_mi) cost += cfg.w_far_deadhead * ((shiftReach - cfg.far_deadhead_mi) / 10);

  // Phase 2.3 — learned territory ownership: a FAR stop whose top zone has
  // established owners (mined from < D history) charges hard when this shift's
  // driver isn't one of them. This is what keeps a Dalton stop on Dalton's
  // drivers even when some other driver has habit or headroom pull; zones with
  // no concentrated history (Atlanta) carry no owner set and cost nothing.
  for (const t of trips) {
    for (const s of t.stops) {
      if (ownedBy(s, shift.driver.driver_user_name, input) === false) cost += cfg.w_zone_owner;
    }
  }

  return cost;
}

export function planCost(shifts: AssignedShift[], input: AssignInput, matrixCache: Map<string, CostMatrix>): number {
  let cost = 0, totalTravel = 0;
  for (const sh of shifts) {
    cost += shiftCost(sh, input, matrixCache);
    for (const t of sh.trips) totalTravel += tripTravelMin(t, input.depot, input.cfg, matrixCache);
  }
  cost += input.cfg.w_compactness * (totalTravel / 60); // hours of total driving

  // Phase 2.2/2.4 — far-AREA cohesion: reward ONE driver owning a contiguous FAR
  // area. Each EXTRA distinct driver serving the same far area is charged, and
  // the charge GROWS with how far out the area is (Chad's rule: the ends of the
  // roads get the fewest trucks possible — a second truck 60 mi out must cost
  // more than one 46 mi out, or a one-stop straggler ties the trade and
  // survives). Keyed on the TOP zone (gh4, the same "Dalton"-sized grain the
  // ownership rules use) — NOT gh5: at gh5 (~5 km) an isolated far stop sits
  // alone in its own cell, reads as "one driver, perfectly cohesive", and the
  // straggler truck carrying it never gets charged. Cross-shift → planCost.
  const farZones = new Map<string, { drivers: Set<string>; maxMiles: number }>();
  for (const sh of shifts) {
    for (const t of sh.trips) {
      for (const s of t.stops) {
        if (s.miles <= input.cfg.far_deadhead_mi) continue;
        const area = String(s.zone || '').slice(0, input.cfg.top_precision);
        let e = farZones.get(area);
        if (!e) { e = { drivers: new Set(), maxMiles: 0 }; farZones.set(area, e); }
        e.drivers.add(sh.driver.driver_key);
        if (s.miles > e.maxMiles) e.maxMiles = s.miles;
      }
    }
  }
  let cohesion = 0;
  for (const e of farZones.values()) {
    const distanceFactor = Math.max(1, e.maxMiles / input.cfg.far_deadhead_mi);
    cohesion += Math.max(0, e.drivers.size - 1) * distanceFactor;
  }
  cost += input.cfg.w_zone_cohesion * cohesion;

  return cost;
}

// ── far-first splitting ──────────────────────────────────────────────────────

// Split a driver's stop bag into trips each within the ceiling, farther stops in
// earlier trips (far-first). Greedy: stops miles-desc, open a new trip when the
// current would breach the ceiling.
export function splitFarFirst(stops: AssignStop[], ceiling: number): AssignedTrip[] {
  if (!stops.length) return [];
  const sorted = [...stops].sort((a, b) => (b.miles - a.miles) || a.id.localeCompare(b.id));
  const totalW = sorted.reduce((a, s) => a + s.weight, 0);
  if (!(ceiling < Infinity) || totalW <= ceiling) return [{ stops: [...stops] }];
  const trips: AssignedTrip[] = [];
  let cur: AssignStop[] = [], curW = 0;
  for (const s of sorted) {
    if (cur.length && curW + s.weight > ceiling) { trips.push({ stops: cur }); cur = []; curW = 0; }
    cur.push(s); curW += s.weight;
  }
  if (cur.length) trips.push({ stops: cur });
  return trips;
}

// ── solve ────────────────────────────────────────────────────────────────────

export function solveAssignment(input: AssignInput): AssignResult {
  const { stops, drivers, cfg, date } = input;
  const now = input.now || Date.now;
  const deadline = now() + cfg.assignment_ms_cap;
  const matrixCache = new Map<string, CostMatrix>();
  const rand = mulberry32(seedFromKey(`assign__${date}`));

  // bag[driverKey] = stops assigned to that driver (pre-split)
  const bag = new Map<string, AssignStop[]>();
  for (const d of drivers) bag.set(d.driver_key, []);
  const driverByKey = new Map(drivers.map((d) => [d.driver_key, d] as const));
  const unassigned: AssignStop[] = [];

  // Per-driver running bag totals (incremental → O(1) capacity lookups). The real
  // truck-fill dimensions (skids, loose) plus a weight fallback.
  const bagTot = new Map<string, { skids: number; loose: number; weight: number }>();
  for (const d of drivers) bagTot.set(d.driver_key, { skids: 0, loose: 0, weight: 0 });

  // Fraction of a driver's LEARNED daily capacity the current bag would use. Prefer
  // the real freight dimensions (skids + loose); fall back to weight when a driver
  // has no learned skid/loose capacity yet. 0 when nothing is known — an unlearned
  // driver imposes no capacity pressure (behavior as before this phase). Uses the
  // MAX across dimensions, so whichever fills first (floor positions or loose count)
  // binds — exactly how a truck runs out of room.
  const capacityUse = (d: AssignDriver): number => {
    const e = d.envelope; const t = bagTot.get(d.driver_key)!;
    const uses: number[] = [];
    if (e.day_skids_p85 && e.day_skids_p85 > 0) uses.push(t.skids / e.day_skids_p85);
    if (e.day_loose_p85 && e.day_loose_p85 > 0) uses.push(t.loose / e.day_loose_p85);
    if (!uses.length && e.day_weight_p85 && e.day_weight_p85 > 0) uses.push(t.weight / e.day_weight_p85);
    return uses.length ? Math.max(...uses) : 0;
  };

  // greedy seed — weight-desc, best feasible driver by habit + affinity + capacity balance
  const seedStops = [...stops].sort((a, b) => (b.weight - a.weight) || a.id.localeCompare(b.id));
  for (const s of seedStops) {
    let best: AssignDriver | null = null, bestScore = -Infinity;
    for (const d of drivers) {
      if (!driverCanServe(d, s)) continue;
      const affinity = d.affinity.get(s.gh5) || 0;
      const isFar = s.miles > cfg.far_deadhead_mi;
      // Phase 2.1: seed agrees with the search — the customer's habitual driver
      // gets a head start proportional to the habit strength. Phase 2.2: that
      // head start is discounted for FAR stops so the seed doesn't scatter a
      // distant loop across each customer's usual driver before the search runs.
      const habitRaw = s.habit?.topDriver && d.driver_user_name &&
        s.habit.topDriver === String(d.driver_user_name).toUpperCase()
        ? habitStrength(s.habit, cfg.habit_shrink_n) : 0;
      const habit = isFar ? habitRaw * cfg.habit_far_discount : habitRaw;
      // Phase 2.5: daily-capacity balance. Two ASYMMETRIC parts:
      //   • headroom reward — coefficient 1, IDENTICAL to the prior term, so it does
      //     not drown the far-cluster consolidation signal (also weight ~1);
      //   • overfill repel — ×w_day_capacity, biting ONLY once a driver is past their
      //     learned daily skid/loose capacity. This negative is the missing force
      //     that let a broad-territory owner vacuum a whole day's stops (the old
      //     headroom floored at 0 and could never push back).
      const use = capacityUse(d);
      const capBalance = (use <= 1 ? 1 - use : 0) - cfg.w_day_capacity * Math.max(0, use - 1);
      // Phase 2.2: for a FAR stop, favor a driver already committed to the far
      // field (consolidation) over one whose bag is near/empty (a fresh deep leg).
      const consolidation = isFar && (bag.get(d.driver_key) || []).some((x) => x.miles > cfg.far_deadhead_mi) ? 1 : 0;
      // Phase 2.3: learned territory owners dominate the seed for far stops —
      // a Dalton stop starts on a Dalton owner, not on whoever has headroom.
      const owned = ownedBy(s, d.driver_user_name, input);
      const ownerBoost = owned === true ? 4 : owned === false ? -4 : 0;
      const score = habit * 3 + affinity * 2 + capBalance + consolidation + ownerBoost + rand() * 1e-6; // deterministic jitter breaks ties
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (!best) { unassigned.push(s); continue; }
    bag.get(best.driver_key)!.push(s);
    const t = bagTot.get(best.driver_key)!;
    t.skids += s.skids; t.loose += s.loose; t.weight += s.weight;
  }

  const buildShifts = (): AssignedShift[] => drivers.map((d) => ({
    driver: d,
    trips: splitFarFirst(bag.get(d.driver_key) || [], tripCeiling(d, cfg)),
  }));

  let shifts = buildShifts();
  let bestCost = planCost(shifts, input, matrixCache);

  // local search — relocate a stop to a better driver, or swap two stops between
  // drivers. First-improvement, deterministic scan order, hard constraints kept.
  // Re-split is implicit: buildShifts always splits far-first within the ceiling.
  let improved = true;
  let rounds = 0;
  while (improved && now() < deadline && rounds < 40) {
    improved = false;
    rounds++;
    // relocate
    for (const d of drivers) {
      const from = bag.get(d.driver_key)!;
      for (let i = 0; i < from.length && now() < deadline; i++) {
        const s = from[i];
        for (const d2 of drivers) {
          if (d2.driver_key === d.driver_key || !driverCanServe(d2, s)) continue;
          from.splice(i, 1);
          bag.get(d2.driver_key)!.push(s);
          const cand = buildShifts();
          const c = planCost(cand, input, matrixCache);
          if (c + 1e-9 < bestCost) { bestCost = c; shifts = cand; improved = true; i--; break; }
          // revert
          bag.get(d2.driver_key)!.pop();
          from.splice(i, 0, s);
        }
      }
    }
    if (improved) continue;
    // swap two stops across drivers (helps when both are near capacity)
    for (let a = 0; a < drivers.length && now() < deadline; a++) {
      for (let b = a + 1; b < drivers.length && now() < deadline; b++) {
        const A = bag.get(drivers[a].driver_key)!, B = bag.get(drivers[b].driver_key)!;
        for (let i = 0; i < A.length; i++) {
          for (let j = 0; j < B.length; j++) {
            if (!driverCanServe(drivers[b], A[i]) || !driverCanServe(drivers[a], B[j])) continue;
            const sa = A[i], sb = B[j];
            A[i] = sb; B[j] = sa;
            const cand = buildShifts();
            const c = planCost(cand, input, matrixCache);
            if (c + 1e-9 < bestCost) { bestCost = c; shifts = cand; improved = true; }
            else { A[i] = sa; B[j] = sb; }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }

  const finalShifts = shifts.map((sh) => ({ driver: sh.driver, trips: sh.trips.filter((t) => t.stops.length) }))
    .filter((sh) => sh.trips.length);

  return {
    date,
    shifts: finalShifts,
    unassigned,
    cost: bestCost,
    drivers_used: finalShifts.length,
  };
}
