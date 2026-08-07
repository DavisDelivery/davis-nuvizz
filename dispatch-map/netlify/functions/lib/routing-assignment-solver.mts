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
//   • per-trip skid cap (Phase 2.8) — a trip's SKID-EQUIVALENT load (skids +
//     loose/loose_per_skid) may not exceed the driver's CLASS hard cap (box 22,
//     tractor 37 — p95 of ~900 real dispatch trips). This replaced the 2.1.1
//     per-driver WEIGHT ceiling: dispatch cubes out, it doesn't weigh out, and
//     the weight ceiling manufactured phantom splits on loads drivers really ran.
//   • per-trip PAYLOAD cap (Phase 2.11) — a trip's total pounds may not exceed
//     the truck class's payload RATING (box 10,000, tractor 44,000 — the same
//     numbers truck-profiles.mts already gates the Phase 1 solver on). This is
//     NOT the 2.1.1 ceiling returning. That ceiling was weight_p85 ×
//     hard_cap_factor: a PERCENTILE of the driver's own history, which by
//     construction sits below the heaviest 15% of trips they had really run —
//     it split loads that were proven to fit, and the weight_max floor was
//     bolted on to undo that. A rating is not a percentile of anything and
//     cannot chop a tail; a trip over it was never legal to build, so splitting
//     it corrects an overload rather than manufacturing a phantom.
//     Expect it to be QUIET: observed freight runs ~300 lb per skid position, so
//     a full 22-skid box is ~6,800 lb and the skid cap still binds first. It
//     bites only on dense freight, which is exactly when it should.
// SOFT costs (config-weighted): skid load past the class SOFT cap, zone-affinity
// misfit, trips-count vs propensity, shift-hours overflow, far-first violation,
// STRICT-window risk, plan compactness.
//
// Method: greedy seed (skid-equiv-desc → best candidate driver by ownership,
// room-gated at the class day budget; split each driver's freight far-first
// within the class hard skid cap) → deterministic local search (relocate across
// drivers, swap, move between a driver's trips, re-split/merge repairs)
// minimizing total soft cost, hard constraints never broken. Deterministic seed
// from the date; wall-clock cap from config.
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
  // Phase 2.7: the driver_keys this stop may be assigned to — its zone's trailing
  // top drivers ∪ customer habit ∪ area fallback (see candidateDriversFor). An
  // EMPTY array means unseen geography → any driver is allowed (open fallback).
  candidates?: string[];
}

// Is a driver an allowed candidate for this stop? Empty/absent candidates ⇒ the
// stop's geography is unseen, so every feasible driver is allowed (never strand a stop).
function isCandidate(s: AssignStop, driverKey: string): boolean {
  return !s.candidates || s.candidates.length === 0 || s.candidates.includes(driverKey);
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

// ── Phase 2.8: per-class skid caps ───────────────────────────────────────────

// A stop's skid-equivalent floor footprint. Loose pieces share skid positions at
// loose_per_skid apiece. A stop with NO skid/loose breakdown (pre-capture rows)
// counts its total pieces ("pallets") as positions — the conservative read.
export function stopSkidEquiv(s: AssignStop, cfg: EngineConfig): number {
  const skids = s.skids || 0, loose = s.loose || 0;
  if (skids > 0 || loose > 0) return skids + loose / Math.max(1, cfg.loose_per_skid);
  return s.pallets || 0;
}

// Class caps (unknown class reads as box_truck — same default as plan-core's
// resolveClass, so an unrostered driver gets the STRICTER payload rating). hard
// is floored at soft so a mis-tuned config can't invert them. weightLb is the
// class payload rating; non-positive means NO weight gate for that class — the
// same "a capacity only constrains when it's a real positive number" rule
// routing-constraints.mts capLimited() uses, and the kill switch if the vendor's
// weight feed ever goes bad.
export function classCapsFor(truck_class: string | null | undefined, cfg: EngineConfig): { soft: number; hard: number; weightLb: number } {
  const tractor = String(truck_class || '') === 'tractor';
  const soft = tractor ? cfg.skid_cap_tractor_soft : cfg.skid_cap_box_soft;
  const hard = Math.max(soft, tractor ? cfg.skid_cap_tractor_hard : cfg.skid_cap_box_hard);
  const rated = Number(tractor ? cfg.weight_cap_tractor_lb : cfg.weight_cap_box_lb);
  return { soft, hard, weightLb: Number.isFinite(rated) && rated > 0 ? rated : Infinity };
}

function tripSkidEquiv(t: AssignedTrip, cfg: EngineConfig): number {
  return t.stops.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
}

// A trip's total pounds. A stop whose vendor weight was blank reads 0 (plan-core
// does `finiteNum(s.weight) || 0`), so the payload gate FAILS OPEN on unknown
// freight — it can only ever under-count, never manufacture a split from a gap
// in the feed. Weight is the oldest and most consistently captured freight field
// in the archive (skids/loose came later and need a pallets fallback), so this
// is a narrow exposure, but it is the honest reading of the data.
function tripWeightLb(t: AssignedTrip): number {
  return t.stops.reduce((a, s) => a + (Number(s.weight) || 0), 0);
}

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

  const caps = classCapsFor(shift.driver.truck_class, cfg);
  let shiftActiveMin = 0;
  let shiftEq = 0;
  let shiftLb = 0;
  const tripRadii: number[] = [];

  for (let ti = 0; ti < trips.length; ti++) {
    const t = trips[ti];
    // Phase 2.8 — skid load past the class SOFT cap. The 20-22 (box) band is
    // where dispatch starts handing a zone's overflow to the cast's #2 driver;
    // charging per skid-equiv over soft makes the search do the same. NOT a
    // balancer: below soft, concentration is free (the 2.5.0 lesson).
    const eq = tripSkidEquiv(t, cfg);
    shiftEq += eq;
    shiftLb += tripWeightLb(t);
    if (eq > caps.soft) cost += cfg.w_skid_soft * (eq - caps.soft);
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

  // trips-count vs propensity — but NEVER charge the trips the freight forces.
  // Conditioned on a day over the class cap, 85% of real driver-days reloaded
  // (73/86 box, 32/38 tractor): a forced reload is dispatch's normal answer to
  // a full truck. 2.8.0 charged it (~9.6) while the wrong cast-#2 handoff cost
  // ~2, so the objective actively preferred the mistake. `needed` = trips this
  // shift's skid load physically requires at the class hard cap — CAPPED AT
  // TWO: past two full loads dispatch hands off to the cast (day p99 < 2×hard),
  // so a third trip is never free and the search can't quietly rebuild the
  // mega-days the seed just shed.
  // Phase 2.11 — `needed` reads BOTH hard dimensions. Skid-only accounting here
  // would charge w_trips (12) for a reload the PAYLOAD rating forced, so the
  // search would pay to shave a legitimately-loaded owner onto a lighter truck
  // to dodge a split it cannot avoid — verbatim the 2.8.0 mistake described
  // above, just via the other cap. Whichever dimension forces more trips wins.
  const neededSkid = Math.ceil(shiftEq / caps.hard - 1e-9);
  const neededWeight = caps.weightLb < Infinity ? Math.ceil(shiftLb / caps.weightLb - 1e-9) : 0;
  const needed = Math.max(1, Math.min(2, Math.max(neededSkid, neededWeight)));
  const expectedTrips = Math.max(1 + (env.trips_per_day_propensity || 0), needed);
  cost += cfg.w_trips * Math.abs(trips.length - expectedTrips);

  // shift-hours overflow
  const shiftBudgetMin = (env.shift_hours_typical ?? cfg.typical_shift_hours) * 60;
  if (shiftActiveMin > shiftBudgetMin) cost += cfg.w_shift_overflow * ((shiftActiveMin - shiftBudgetMin) / 60);


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

// Split a driver's stop bag into trips within BOTH class hard bounds — skid
// positions (what fits) and pounds (what the axles are rated for) — farther
// stops in earlier trips (far-first). Greedy: stops miles-desc, open a new trip
// when the current would breach EITHER bound. A single over-cap stop still rides
// (alone) on either dimension — the caps split bags, they never strand freight.
//
// This is the ONLY place a trip is ever constructed. The local search mutates
// each driver's flat stop bag and re-derives trips through buildShifts(), so
// every move inherits both caps here and none of them can violate one.
//
// `cap` accepts a bare skid number (legacy callers → no payload gate) or the
// full {hard, weightLb} shape classCapsFor returns.
export function splitFarFirst(
  stops: AssignStop[], cap: number | { hard: number; weightLb?: number }, cfg: EngineConfig,
): AssignedTrip[] {
  if (!stops.length) return [];
  const capSkidEquiv = typeof cap === 'number' ? cap : cap.hard;
  const capWeightLb = typeof cap === 'number' ? Infinity
    : (Number.isFinite(Number(cap.weightLb)) && Number(cap.weightLb) > 0 ? Number(cap.weightLb) : Infinity);
  const sorted = [...stops].sort((a, b) => (b.miles - a.miles) || a.id.localeCompare(b.id));
  const total = sorted.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
  const totalLb = sorted.reduce((a, s) => a + (Number(s.weight) || 0), 0);
  const skidFits = !(capSkidEquiv < Infinity) || total <= capSkidEquiv;
  const weightFits = !(capWeightLb < Infinity) || totalLb <= capWeightLb;
  if (skidFits && weightFits) return [{ stops: [...stops] }];
  const trips: AssignedTrip[] = [];
  let cur: AssignStop[] = [], curEq = 0, curLb = 0;
  for (const s of sorted) {
    const eq = stopSkidEquiv(s, cfg);
    const lb = Number(s.weight) || 0;
    if (cur.length && (curEq + eq > capSkidEquiv || curLb + lb > capWeightLb)) {
      trips.push({ stops: cur }); cur = []; curEq = 0; curLb = 0;
    }
    cur.push(s); curEq += eq; curLb += lb;
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

  // greedy seed — biggest freight first, best feasible driver by OWNERSHIP: habit
  // + affinity + far-consolidation + learned territory. Phase 2.6 removed load
  // BALANCING entirely (dispatch concentrates on a zone's owner and never levels;
  // the 2.5.0 balancing cost ~5pts agreement and +30pts travel). Phase 2.8 adds
  // the one capacity idea that survives that lesson: a CAP. Ordering among
  // candidates with room is still pure ownership — but a candidate already past
  // their day skid budget (class hard cap × trips propensity) drops a tier, so a
  // zone's overflow lands on the cast's #2/#3 driver exactly the way dispatch
  // splits a corridor's work. Tiers: candidate-with-room > candidate-full >
  // any-feasible (territory still beats capacity; never strand a stop).
  const bagEq = new Map<string, number>();                 // driver_key → seeded skid-equiv
  // Day budget = TWO full loads. Reloading is dispatch's normal answer to a full
  // truck — 85% of real over-cap driver-days ran 2+ trips (73/86 box, 32/38
  // tractor) — so the zone owner keeps their zone through a reload, and the
  // cast's #2 driver only inherits past two full loads (p99 territory, where
  // dispatch really does hand off). 2.8.0 budgeted by the UNCONDITIONAL
  // double-trip rate (propensity ~0.2, i.e. ~1.2 loads): it demoted owners at
  // ~26 box skids and handed their freight to cast #2 — right split count,
  // wrong truck (agreement 27.9→24.6). Double-tripping is a response to load,
  // not a personality trait.
  const dayBudget = (d: AssignDriver): number => classCapsFor(d.truck_class, cfg).hard * 2;
  // Ownership scoring shared by both seed passes (jitter is deterministic).
  const scoreFor = (s: AssignStop, d: AssignDriver): number => {
    const affinity = d.affinity.get(s.gh5) || 0;
    const isFar = s.miles > cfg.far_deadhead_mi;
    // Phase 2.1: the customer's habitual driver gets a head start proportional to
    // the habit strength; Phase 2.2 discounts that for FAR stops so a distant loop
    // isn't scattered across each customer's usual driver.
    const habitRaw = s.habit?.topDriver && d.driver_user_name &&
      s.habit.topDriver === String(d.driver_user_name).toUpperCase()
      ? habitStrength(s.habit, cfg.habit_shrink_n) : 0;
    const habit = isFar ? habitRaw * cfg.habit_far_discount : habitRaw;
    // Phase 2.2: for a FAR stop, favor a driver already committed to the far field.
    const consolidation = isFar && (bag.get(d.driver_key) || []).some((x) => x.miles > cfg.far_deadhead_mi) ? 1 : 0;
    // Phase 2.3: learned territory owners dominate the seed for far stops.
    const owned = ownedBy(s, d.driver_user_name, input);
    const ownerBoost = owned === true ? 4 : owned === false ? -4 : 0;
    return habit * 3 + affinity * 2 + consolidation + ownerBoost + rand() * 1e-6;
  };

  // PASS 1 — pure ownership, exactly the 2.7.0 assignment: every stop to its
  // best TERRITORY candidate (open fallback only when no candidate can serve
  // it). Budgets are deliberately ignored here: WHO owns a stop and WHAT
  // overflows are separate questions — 2.8.0/2.8.1 conflated them, letting
  // seeding order decide the overflow (arbitrary fringe, wrong truck).
  const claim = new Map<string, number>();   // stop.id → its winning territorial score
  const seedStops = [...stops].sort((a, b) =>
    (stopSkidEquiv(b, cfg) - stopSkidEquiv(a, cfg)) || (b.weight - a.weight) || a.id.localeCompare(b.id));
  for (const s of seedStops) {
    let best: AssignDriver | null = null, bestScore = -Infinity;   // best TERRITORY candidate
    let anyBest: AssignDriver | null = null, anyScore = -Infinity; // best feasible driver overall
    for (const d of drivers) {
      if (!driverCanServe(d, s)) continue;
      const score = scoreFor(s, d);
      if (score > anyScore) { anyScore = score; anyBest = d; }
      if (isCandidate(s, d.driver_key) && score > bestScore) { bestScore = score; best = d; }
    }
    const chosen = best || anyBest;
    if (!chosen) { unassigned.push(s); continue; }
    bag.get(chosen.driver_key)!.push(s);
    bagEq.set(chosen.driver_key, (bagEq.get(chosen.driver_key) || 0) + stopSkidEquiv(s, cfg));
    claim.set(s.id, best ? bestScore : -Infinity);  // an open-fallback stop holds no territorial claim
  }

  // PASS 2 — cap the overflow, keep the core. A driver over TWO full loads
  // sheds their WEAKEST-claim stops: dispatch keeps the habitual/affinity core
  // on the owner and flexes the fringe to the cast — the 2.8.1 replay showed
  // shedding by seeding order instead costs real agreement. Each shed stop goes
  // to its next candidate WITH room; a cast with no room still absorbs it
  // (territory beats capacity); a stop only its owner can serve stays put.
  // Single deterministic sweep — the local search polishes the rest.
  for (const d of drivers) {
    const budget = dayBudget(d);
    if ((bagEq.get(d.driver_key) || 0) <= budget) continue;
    const mine = bag.get(d.driver_key)!;
    mine.sort((a, b) => ((claim.get(a.id) ?? -Infinity) - (claim.get(b.id) ?? -Infinity)) || a.id.localeCompare(b.id)); // weakest claim first
    let idx = 0;
    while ((bagEq.get(d.driver_key) || 0) > budget && idx < mine.length) {
      const s = mine[idx];
      const eq = stopSkidEquiv(s, cfg);
      let alt: AssignDriver | null = null, altScore = -Infinity;         // candidate WITH room
      let altFull: AssignDriver | null = null, altFullScore = -Infinity; // candidate past budget
      for (const d2 of drivers) {
        if (d2.driver_key === d.driver_key || !driverCanServe(d2, s) || !isCandidate(s, d2.driver_key)) continue;
        const score = scoreFor(s, d2);
        if ((bagEq.get(d2.driver_key) || 0) + eq <= dayBudget(d2)) {
          if (score > altScore) { altScore = score; alt = d2; }
        } else if (score > altFullScore) { altFullScore = score; altFull = d2; }
      }
      const to = alt || altFull;
      if (!to) { idx++; continue; }
      mine.splice(idx, 1);
      bagEq.set(d.driver_key, (bagEq.get(d.driver_key) || 0) - eq);
      bag.get(to.driver_key)!.push(s);
      bagEq.set(to.driver_key, (bagEq.get(to.driver_key) || 0) + eq);
    }
  }

  const buildShifts = (): AssignedShift[] => drivers.map((d) => ({
    driver: d,
    trips: splitFarFirst(bag.get(d.driver_key) || [], classCapsFor(d.truck_class, cfg), cfg),
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
          if (d2.driver_key === d.driver_key || !driverCanServe(d2, s) || !isCandidate(s, d2.driver_key)) continue;
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
            if (!isCandidate(A[i], drivers[b].driver_key) || !isCandidate(B[j], drivers[a].driver_key)) continue;   // Phase 2.7
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
