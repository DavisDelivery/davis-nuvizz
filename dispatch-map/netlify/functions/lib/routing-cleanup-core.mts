// lib/routing-cleanup-core.mts
//
// END-OF-NIGHT CLEANUP — Chad's own description of the job: "at end of night
// when I'm just planning the extra box truck loads — give it 5 empties and let
// it route the leftover unplanned stops on them."
//
// This is the OPPOSITE POSTURE from the driver-scoped draft next door. That one
// is conservative on purpose: it claims only the freight a named driver's own
// history supports and hands the rest back. Cleanup mode's whole job is to make
// the leftovers GO SOMEWHERE — and leftovers are, by construction, the freight
// that did NOT fit anybody's pattern, so habit and territory are weak here and
// GEOGRAPHY AND CAPACITY do the work. Concretely that means: no candidate
// pre-filter (every truck may take every stop it can physically carry), and the
// honest output is not "whose is this?" but "did it fit, and if not, what is
// left over?"
//
// WHAT A "TRUCK" IS HERE. The dispatcher picks LOAD SHELLS, not drivers, and an
// empty shell has no driver to learn from — the roster carries no driver column
// and a load with no stops has no board rows to read one off. So a truck is
// bounded by what CHAD says it holds (the vehicle profile he maintains) rather
// than by a learned envelope, and the driver is picked per card after staging.
// The profile is applied as a cap_override, which can only ever TIGHTEN the
// class bound — a box shell rated 14 skids is loaded to 14, not to the fleet's
// p95 of 22, which is the number the per-driver phase exists to stop applying to
// everyone. When a shell DOES already hold board stops, its driver is known and
// their real envelope, affinity and zone ownership come along for free.
//
// ONE LOAD IS ONE TRIP. A NuVizz load is one route; a second truckload on one
// shell while another sits empty is not a reload, it is freight that belongs on
// the truck already provided. So the solve runs with max_loads_per_driver = 1,
// which makes the seed spread across the shells instead of double-loading one,
// and anything past one truckload comes back as explicit over-capacity leftovers
// rather than a quietly invented second trip.
//
// ZERO NuVizz calls, ZERO writes. This produces a proposal; the dispatcher edits
// it on the Compare workbench and the existing Save is the only path to NuVizz.

import { readStops } from './firestore.mts';
import { DEPOT } from './history-derive.mts';
import { ENGINE_VERSION, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';
import { type ZonePrecisions } from './zones.mts';
import { loadPlanInputs, type PlanInputs } from './routing-plan-core.mts';
import {
  driverEnvelope, driverZoneAffinity, fleetTripChain, zoneOwnersAsOf,
} from './routing-envelope.mts';
import {
  solveAssignment, capsFor, stopSkidEquiv, driverCanServe, type AssignStop, type AssignDriver,
} from './routing-assignment-solver.mts';
import { solveRoute, haversineMiles, travelMinutesForMiles, type EngineStop } from './routing-engine-solver.mts';
import { equipmentReqsFrom, TRAILER_BLOCKERS } from './routing-equipment.mts';
import { equipmentOk } from './routing-constraints.mts';
import { insertByWindow } from './routing-repair.mts';
import {
  stopTimeRestriction, boardDefaultSlots, timeRestrictionsEnabled, type StopTimeRestriction,
} from './routing-time-windows.mts';
import type { TruckCapabilities } from './routing-types.mts';
import { pickReferences } from './routing-reference.mts';
import { serviceTimeAsOf } from './routing-service-times.mts';
import { liveStopToAssignStop, liveMatchKey, modalWarehouseOf, LIVE_SOLVER_MS } from './routing-draft-core.mts';
import { dayReceivingWindow, closedDayTier, fmtMin } from '../../../src/lib/board-flags.js';

// The dispatcher's truck classes and the engine's are DIFFERENT VOCABULARIES:
// the browser's vehicle profiles say capabilities.tractor, the learned engine
// says the literal strings 'box_truck' / 'tractor' (from the MarginIQ roster's
// vehicleType). Nothing bridged them before this. One function, so a rename on
// either side breaks in one place instead of silently mis-sizing a truck.
export function engineClassForProfile(profile: any): 'box_truck' | 'tractor' {
  return profile?.capabilities?.tractor === true ? 'tractor' : 'box_truck';
}

// A cleanup solve is a DISPATCHER WAITING AT A SCREEN, not a nightly job: it must
// answer inside the function timeout. The full-day cap (90s) is for the replay.
// Measured on this solver: 5 trucks x 80 stops converges in ~3.5s; the pathological
// 8 x 200 runs 64s uncapped and 12s capped, for a ~5% worse objective. Bounding it
// is the right trade — a dispatcher gets an answer, and the answer is barely different.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_LABEL: Record<string, string> = {
  sun: 'Sundays', mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays',
  thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays',
};
// Noon local, so a DST boundary cannot roll the day. Same construction the
// browser's weekdayKey uses; duplicated rather than imported because that module
// pulls the whole time-restrictions table for one line.
function weekdayKeyOf(date: string): string | null {
  const [y, m, d] = String(date ?? '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : DAY_KEYS[dt.getDay()];
}

// A dock that shuts before this is one a night-planned route has to lead with,
// not bury. 3pm is the same line the map's EARLY CLOSE mark uses, so the panel
// and the pins say the same thing.
export const CLEANUP_EARLY_CLOSE_MIN = 15 * 60;

export const CLEANUP_SOLVER_MS = LIVE_SOLVER_MS;

// Total wall clock for sequencing ALL the picked shells, split between them.
// 12s assignment + 8s sequencing + Firestore leaves real headroom under the 26s
// function timeout instead of the 24s+ a per-truck second would have cost.
export const CLEANUP_SEQUENCE_MS = 8_000;
// Past this the pool is not "leftovers" and the request is almost certainly a
// mistake (wrong date, or the whole day unplanned). Refuse loudly.
export const CLEANUP_MAX_POOL = 400;
export const CLEANUP_MAX_TRUCKS = 12;
// Past this the pool is old enough that dispatch has probably planned against it.
export const CLEANUP_STALE_MIN = 90;

// ── "FILL MY LOADS" FOLLOWS THE BUILD RULES (Chad, 2026-09-26) ───────────────
//
// Asked what he meant by handing step 4's engine routes, he picked: the empty loads he ticks
// in 2 · Plan onto, filled from whatever is still unplanned — "Fill my loads, fixed to follow
// the Build rules." Measured off the code before this, the two buttons disagreed on the
// same stop in five ways, and every one of them was a way to put freight on the wrong truck:
//
//   1. WHICH TRUCK. Build reads the green Tractor OK / red Box only mark and step 3's "only
//      green on a 53'"; the engine read one blocksTractor bit off equipment_restrictions and
//      nothing else — a red stop could ride a trailer, a green one could be kept off it.
//   2. LIFTGATE. Build checks it per truck, from the array AND the note's boolean; the engine
//      read the array only, and only asked whether ANY picked truck had a gate.
//   3. HOW MUCH. Build loads a load to its profile; the engine could only TIGHTEN a learned
//      cap, so an empty tractor shell was cut to the mixed fleet's p85 and freight was called
//      "needs another truck" with a 53' half empty.
//   4. WHAT IS ALREADY ON IT. Step 2 lists loads that already hold stops. The engine offered
//      each one a whole empty truck, so a half-full load could be handed a full one's worth.
//   5. THE CLOCK. Build sequences around appointment windows and receiving hours and, on
//      strict, leaves an unmeetable stop off; the engine's order was geographic and it only
//      named early closers that landed in the back half.
//
// Under the Build rules the ENGINE still decides what the engine is good at — who gets which
// stop by geography, the learned stop order, learned service minutes and drive times, the
// typical start — and the BUILD decides what the Build decides: what a truck may carry, how
// much, and what the clock allows. One rule each, imported, not copied.
//
// PUT IT BACK: FILL_MY_LOADS_BUILD_RULES=off. One switch, every side at once — the server
// ignores the new request fields and runs the engine's own rules exactly as before, and the
// response says which ran (`rules`), so the panel can never claim rules that did not apply.
// House shape: default ON, an explicit off-word turns it off, anything malformed leaves it ON.
export function fillMyLoadsBuildRules(env: Record<string, any> = process.env): boolean {
  const v = String(env?.FILL_MY_LOADS_BUILD_RULES ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

// When the engine has no typical start for a truck, the Build button's own departure.
// Same number as routing-types DEFAULT_DEPART_HHMM ('08:00').
export const CLEANUP_DEFAULT_DEPART_MIN = 8 * 60;

export interface CleanupTruckInput {
  // Does this truck carry a liftgate? A residential / no-dock consignee marked
  // liftgate_required cannot be served without one — the driver cannot get the
  // pallet on the ground and it comes back as a redelivery. Undefined means
  // "not stated", which is read as NO liftgate: assuming one we cannot see is
  // the expensive direction of that guess.
  liftgate?: boolean;
  key: string;                       // the load's display name — the join back to the Compare card
  name?: string | null;
  loadNbr?: string | null;
  loadId?: string | null;
  truck_class?: string | null;       // 'box_truck' | 'tractor'
  max_skids?: number | null;         // the dispatcher's vehicle profile — tightens only
  max_weight_lb?: number | null;
  driver_user_name?: string | null;  // known only when the shell already holds board stops
  // BUILD RULES ONLY. The picked load's vehicle profile capabilities, exactly what the Build
  // button hands its solver — per truck, so a box without a gate and a box with one are two
  // different trucks. Absent → derived from truck_class + liftgate.
  capabilities?: Partial<TruckCapabilities> | null;
  // BUILD RULES ONLY. What this load already carries, in its running order — its open card's
  // order when one is open, else its board stops. Counted against the profile and run through
  // first on the clock, because staging appends the engine's stops after them.
  existing_stop_nbrs?: string[] | null;
  // The same stops as the browser sees them (freight, coordinates, name/address, schedule).
  // The server's board row wins when it has one; this covers what the server cannot see — an
  // order from another day staged on the card (a carry-over) is not on this day's board, and
  // left uncounted it let a 14-skid box be filled to 20.
  existing_stops?: Array<Record<string, any>> | null;
}

export interface CleanupLeftover {
  stopNbr: string;
  businessName: string | null;
  city: string | null;
  skids: number;
  reason: 'no_coords' | 'equipment' | 'over_capacity' | 'too_big' | 'closed_today' | 'time_window';
  detail: string;
}

export interface CleanupTruck {
  key: string;
  name: string | null;
  loadNbr: string | null;
  loadId: string | null;
  truck_class: string;
  driver_user_name: string | null;
  cap: { skids: number; weight_lb: number | null; source: 'profile' | 'driver' | 'fleet' | 'class' };
  stops: Array<{
    stopNbr: string; businessName: string | null; addr1: string | null; city: string | null;
    lat: number; lng: number; skids: number; loose: number; weight: number; miles: number;
    // When this dock shuts today, if anyone has recorded it. A cleanup route is
    // built at night for tomorrow and a dispatcher cannot judge a sequence
    // without it — a 2pm close sitting ninth on the run is a refused delivery.
    // null means nothing is on file, NOT that the dock is open all day.
    close_min: number | null; close_label: string | null; early_close: boolean;
    pickup: boolean;
    // BUILD RULES ONLY — the clock the Build rules read for this stop and what the truck
    // does against it, on the engine's own drive times and service minutes.
    window_label?: string | null;   // "8:00a–2:00p", "by 3:00p", "opens 10:00a" — null: nothing on file
    eta_label?: string | null;      // when service starts (after any wait for the dock)
    late?: boolean;                 // arrives after it shuts — kept only in advisory mode
  }>;
  // BUILD RULES ONLY — freight the load already carried before this fill.
  existing?: { stops: number; skid_equiv: number; weight_lb: number } | null;
  depart_label?: string | null;
  full?: boolean;                   // no room left before this fill — took no part in it
  full_by?: 'skids' | 'weight';
  stop_count: number;
  skid_equiv: number;
  weight_lb: number;
  travel_min_est: number;
  mode: 'guided' | 'unguided';
  references_used: number;
  // NOTE: there is deliberately no per-truck "overflow" count. After the refill
  // pass a stop that spilled off truck A may be sitting on truck B, so a per-truck
  // number would be a fiction. What did not fit ANYWHERE is in left_unplanned with
  // reason 'over_capacity'; how full each truck is reads off skid_equiv vs cap.
}

export interface CleanupResult {
  ok: boolean;
  // Which rule set actually ran — read off the switch at solve time, never assumed.
  rules: 'build' | 'engine';
  rules_detail?: { tractor_only_green: boolean; window_mode: 'strict' | 'advisory'; time_restrictions: boolean };
  tenant: string;
  date: string;
  engine_version: string;
  generated_at: string;
  pool: {
    board_stops: number; unplanned: number; excluded_held: number; no_coords: number; routed: number;
    // Real work, but work that may not belong on a cleanup truck — surfaced so
    // Chad decides rather than discovering it on the road.
    pickups: number; attempts: number;
    // The same stop number appearing twice on the board. First row wins.
    duplicates: number;
    // Rows with no stop number at all — no identity, so never routed.
    no_id: number;
    // Customers whose dock is shut on the served day. Never routed.
    closed_today: number;
    // Rows with no freight numbers yet. Each is counted as one skid position so it
    // is not free against the caps, but the totals on screen are an ESTIMATE while
    // this is non-zero, and the panel says so.
    unknown_freight: number;
  };
  fit: {
    pool_skid_equiv: number; capacity_skid_equiv: number;
    fits: boolean; shortfall_skid_equiv: number; trucks_needed_estimate: number;
  };
  staleness: {
    last_scanned_at: string | null; last_load_scan_at: string | null; last_unplanned_scan_at: string | null;
    // How old the UNPLANNED feed is, and whether that is old enough to matter.
    // A cleanup plan is only as good as the pool it was built from: routes
    // dispatch planned after the last scan are still "unplanned" here, so a stale
    // board can put freight on a truck that already has a truck. The Save refuses
    // per load when that happens, which reads as "the engine is broken" when the
    // real problem is the age of the board. Say it up front instead.
    pool_age_min: number | null;
    stale: boolean;
  };
  trucks: CleanupTruck[];
  left_unplanned: CleanupLeftover[];
  notes: string[];
  ms: number;
}

// ── the geometric seed ───────────────────────────────────────────────────────
//
// WHY THIS EXISTS. The assignment solver seeds pass 1 with an OWNERSHIP score:
// customer habit, zone affinity, learned territory. Every one of those terms is
// about a DRIVER, and cleanup mode's trucks are empty load shells with no driver
// to know anything about — so all three read zero and the seed collapses to its
// own tie-break jitter. Measured, before this: five clean geographic clusters
// onto five empty shells put FOUR of the five trucks across two towns each,
// including one running Gainesville and Conyers, 46 miles apart. The local
// search cannot undo that because first-improvement polishing starts from where
// the seed left it.
//
// So cleanup states the geometry itself, with the classic SWEEP: order every
// stop by its compass bearing from the depot and walk that circle, filling one
// truck to capacity before starting the next. Trucks come out as contiguous
// wedges radiating from Buford — which is how a dispatcher describes territory
// out loud ("everything north", "the Conyers side"). The sweep starts at the
// widest empty gap in the circle so a natural cluster is never split across the
// seam. It is deterministic, and it is only a STARTING POINT: the solver's shed
// pass and local search still move freight for capacity, equipment and travel.
export function sweepSeed(
  stops: AssignStop[], trucks: AssignDriver[], caps: Map<string, { hard: number; weightLb: number }>,
  depot: { lat: number; lng: number }, cfg: EngineConfig,
): Map<string, string> {
  const seed = new Map<string, string>();
  if (!stops.length || !trucks.length) return seed;

  const bearing = (s: AssignStop) => {
    const a = Math.atan2((s.lng - depot.lng) * 57, (s.lat - depot.lat) * 69);
    return a < 0 ? a + Math.PI * 2 : a;
  };
  const ordered = stops
    .map((s) => ({ s, a: bearing(s) }))
    .sort((x, y) => (x.a - y.a) || x.s.id.localeCompare(y.s.id));

  // Start the circle at the WIDEST GAP between neighbouring bearings, so the
  // seam falls in empty sky instead of through the middle of a town.
  let startIdx = 0, widest = -1;
  for (let i = 0; i < ordered.length; i++) {
    const prev = ordered[(i - 1 + ordered.length) % ordered.length].a;
    const gap = (ordered[i].a - prev + Math.PI * 2) % (Math.PI * 2);
    if (gap > widest + 1e-12) { widest = gap; startIdx = i; }
  }
  const walk = ordered.slice(startIdx).concat(ordered.slice(0, startIdx));

  // Deterministic truck order.
  const order = [...trucks].sort((a, b) => a.driver_key.localeCompare(b.driver_key));
  const used = new Map(order.map((d) => [d.driver_key, { eq: 0, lb: 0 }] as const));

  // FILL TO A FAIR SHARE FIRST, THE HARD CAP ONLY AS A FALLBACK.
  //
  // The textbook sweep fills one vehicle to its capacity, then starts the next.
  // That is right when the pool needs the whole fleet, and wrong here, because
  // cleanup is usually the opposite case: a handful of leftovers against trucks
  // with room to spare. Filled greedily the first truck runs to its cap, crosses
  // the seam and keeps going, and the last truck gets one stop — one truck doing
  // a 60-mile straddle while another does a single delivery. Giving each truck a
  // share of the pool in proportion to what it holds keeps every wedge
  // contiguous, and the hard cap is still there as the fallback so nothing goes
  // unseeded just because its share is full.
  const totalEq = stops.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
  const totalCap = order.reduce((a, d) => a + (caps.get(d.driver_key)?.hard || 0), 0);
  const shareOf = (d: AssignDriver) => {
    const c = caps.get(d.driver_key);
    if (!c) return 0;
    if (!(totalCap > 0)) return c.hard;
    return Math.min(c.hard, (totalEq * c.hard) / totalCap);
  };
  const fits = (d: AssignDriver, s: AssignStop, bound: 'share' | 'cap') => {
    // The solver's own gate: blocksTractor, plus the per-truck allowlist the Build rules set.
    if (!driverCanServe(d, s)) return false;
    const c = caps.get(d.driver_key);
    if (!c) return false;
    const u = used.get(d.driver_key)!;
    const eq = stopSkidEquiv(s, cfg), lb = Number(s.weight) || 0;
    // NO "rides alone if it is bigger than the truck" escape here. splitFarFirst
    // has one because a learned cap is a preference and stranding freight is
    // worse; in cleanup the pool has already had everything that fits NO truck
    // pulled out, so every stop left has a truck that can legally hold it and
    // the seed's job is to find it. Letting a 10-skid stop ride alone on a
    // 6-skid truck fills that truck, the capacity repair below takes the stop
    // straight back off, and the truck ends up carrying one stop.
    const limit = bound === 'share' ? shareOf(d) : c.hard;
    return u.eq + eq <= limit + 1e-9 && u.lb + lb <= c.weightLb + 1e-9;
  };

  let ti = 0;
  for (const { s } of walk) {
    let placed = false;
    // Try the truck currently being filled, then the rest in order — so the wedge
    // stays contiguous, and a stop this truck cannot take (equipment, weight)
    // rolls forward instead of stranding. Fair share first, then the hard cap.
    for (const bound of ['share', 'cap'] as const) {
      for (let k = 0; k < order.length; k++) {
        const d = order[(ti + k) % order.length];
        if (!fits(d, s, bound)) continue;
        seed.set(s.id, d.driver_key);
        const u = used.get(d.driver_key)!;
        u.eq += stopSkidEquiv(s, cfg); u.lb += Number(s.weight) || 0;
        ti = (ti + k) % order.length;
        placed = true;
        break;
      }
      if (placed) break;
    }
    // Nothing has room: leave it unseeded and let the solver's own path decide
    // (it lands as over-capacity in the report, which is the honest answer).
    if (!placed) continue;
  }
  return seed;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface BuildCleanupOpts {
  cfg: EngineConfig;
  inputs: PlanInputs;
  liveStops: any[];
  meta: any | null;
  trucks: CleanupTruckInput[];
  excludeStopNbrs?: string[];
  nowIso?: string;
  // Which rules; absent → the FILL_MY_LOADS_BUILD_RULES switch.
  rules?: 'build' | 'engine';
  // Step 3's two toggles, read only under the Build rules.
  tractorOnlyGreen?: boolean;
  windowMode?: 'strict' | 'advisory';
  // ROUTING_TIME_RESTRICTIONS, the Build button's own clock switch. Absent → the env.
  timeRestrictions?: boolean;
}

// The pure core: pool → solve → one trip per shell → proposal. No I/O.
export function buildCleanupPlan(tenant: string, date: string, opts: BuildCleanupOpts): CleanupResult {
  const t0 = Date.now();
  const { cfg: baseCfg, inputs, liveStops, meta, trucks: truckInputs } = opts;
  const cfg: EngineConfig = { ...baseCfg, assignment_ms_cap: Math.min(baseCfg.assignment_ms_cap, CLEANUP_SOLVER_MS) };
  const nowIso = opts.nowIso || new Date().toISOString();
  const precisions: ZonePrecisions = {
    zone_precision: cfg.zone_precision, super_precision: cfg.super_precision, top_precision: cfg.top_precision,
  };
  const notes: string[] = [];
  const left: CleanupLeftover[] = [];

  // How old is the pool? Deliberately a WARNING and not a refusal: the scanner is
  // dark from Friday night to Sunday evening, and planning Monday's leftovers on
  // Sunday night is a real thing Chad does. Refusing then would block the exact
  // job this feature exists for. Naming the age lets him judge it.
  const stampIso = meta?.lastUnplannedScanAt ?? meta?.last_scanned_at ?? null;
  const stampMs = stampIso ? Date.parse(String(stampIso)) : NaN;
  const poolAgeMin = Number.isFinite(stampMs)
    ? Math.max(0, Math.round((Date.parse(nowIso) - stampMs) / 60000)) : null;
  if (poolAgeMin != null && poolAgeMin > CLEANUP_STALE_MIN) {
    const h = Math.floor(poolAgeMin / 60), m = poolAgeMin % 60;
    notes.push(`This board was last scanned ${h ? `${h}h ${m}m` : `${m}m`} ago. Anything dispatch has planned since still looks unplanned here — scan before you save, or check the routes you get.`);
  }

  // ── the pool: everything still to do that nobody has planned ──
  // isUnplanned already means "not planned AND not terminal" (a cancelled or
  // delivered stop is not leftovers), so this is the whole leftover pile.
  const exclude = new Set((opts.excludeStopNbrs || []).map(String));
  // ── WHICH RULES — decided once, reported back, never assumed (see fillMyLoadsBuildRules) ──
  const buildRules = (opts.rules ?? (fillMyLoadsBuildRules() ? 'build' : 'engine')) === 'build';
  const tractorOnlyGreen = buildRules && opts.tractorOnlyGreen === true;
  const windowMode: 'strict' | 'advisory' = opts.windowMode === 'strict' ? 'strict' : 'advisory';
  const timeOn = buildRules && (opts.timeRestrictions ?? timeRestrictionsEnabled());
  // The WHOLE customer note (noteByKey) is what the Build rules read — the eligibility mark
  // and the liftgate boolean live there, not in equipment_restrictions. Production loads both
  // off the same listDocs; a caller holding only the restriction slice still gets that much.
  const noteOf = (mk: string | null): any => {
    if (!mk) return null;
    const n = inputs.noteByKey?.get(mk);
    if (n) return n;
    const r = inputs.notesRestrictions?.get(mk);
    return r && r.length ? { equipment_restrictions: r } : null;
  };
  // Vendor default creation slots, detected over the WHOLE board exactly as the Build does —
  // a five-stop pool could never see the pattern.
  const defaultSlots = timeOn ? boardDefaultSlots(liveStops || []) : null;
  const clockOf = new Map<string, StopTimeRestriction>();   // stopNbr → the Build's clock for it
  // What each picked load already carries is ON a truck — never leftovers, even if a stale
  // row still reads unplanned.
  if (buildRules) for (const t of truckInputs) {
    for (const x of t.existing_stop_nbrs || []) exclude.add(String(x));
    for (const x of t.existing_stops || []) if (x?.stopNbr != null) exclude.add(String(x.stopNbr));
  }
  const unplannedRows = (liveStops || []).filter((s) => s?.isUnplanned === true);
  const byId = new Map<string, any>();
  const pool: AssignStop[] = [];
  let noCoords = 0, excludedHeld = 0, unknownFreight = 0, pickups = 0, attempts = 0, duplicates = 0, noId = 0, closedToday = 0;
  const clockByStop = new Map<string, number>();   // stopNbr → the minute this dock shuts
  const dayKey = weekdayKeyOf(date);
  for (const s of unplannedRows) {
    // ONE id, used for the exclude test, the dedupe and the stored row. Deriving
    // the guard key differently from the id actually stored (String(x ?? '') vs
    // String(x)) meant a row with no stopNbr was keyed '' here and 'undefined'
    // there, so the guard never matched and two such rows both rode a truck.
    const id = String(s?.stopNbr ?? '');
    // No stop number is no identity: it cannot be excluded, cannot be staged onto
    // a card and cannot be saved back to the load. Counted, never routed.
    if (!id || id === 'undefined' || id === 'null') { noId++; continue; }
    if (exclude.has(id)) { excludedHeld++; continue; }
    // The same stop number twice is a vendor anomaly, not two deliveries. Left
    // alone it rides two trucks: the second driver arrives for freight the first
    // already took, and every fill number on both cards is overstated. First row
    // wins, and the collapse is counted so it is visible rather than silent.
    if (byId.has(id)) { duplicates++; continue; }
    const as = liveStopToAssignStop(s, cfg, precisions, inputs, date);
    if (!as) {
      noCoords++;
      left.push({
        stopNbr: id || '?', businessName: s?.businessName ?? null, city: s?.city ?? null,
        skids: Number(s?.cartons) || 0, reason: 'no_coords',
        detail: 'no map position yet — the engine cannot place it; put it on a truck by hand',
      });
      continue;
    }
    // No candidate restriction: cleanup is allowed to put any stop on any truck
    // that can physically carry it. An empty cast also contributes zero rank cost,
    // so a driverless shell is never penalised for not being in a cast.
    as.candidates = undefined;
    // ── A DOCK THAT IS SHUT TOMORROW IS NOT ROUTABLE TOMORROW ──
    // The cheapest real failure this feature can cause: a consignee closed on the
    // served day gets sequenced onto a truck, the driver arrives, there is nobody
    // to take the freight, and it comes back. No amount of good sequencing fixes
    // a closed door. closedDayTier is the same pure function the map draws its
    // closed marks from, so the engine and the screen cannot disagree.
    const note = as.matchKey ? (inputs.noteByKey?.get(as.matchKey) ?? null) : null;
    if (dayKey && note && closedDayTier(note, dayKey)) {
      closedToday++;
      left.push({
        stopNbr: id, businessName: s?.businessName ?? null, city: s?.city ?? null,
        skids: as.skids, reason: 'closed_today',
        detail: `this customer is closed ${DAY_LABEL[dayKey] || dayKey} — the freight cannot be delivered on ${date}`,
      });
      continue;
    }
    if (dayKey && note) {
      const w = dayReceivingWindow(note, dayKey);
      if (w && Number.isFinite(w.closeMin)) clockByStop.set(as.id, w.closeMin);
    }
    // THE BUILD'S CLOCK: order window ∩ receiving hours for the board day, through the same
    // resolver the Build button and the map use (routing-time-windows).
    if (timeOn) {
      const tr = stopTimeRestriction({ stop: s, note: noteOf(as.matchKey), date, defaultSlots });
      if (tr && !tr.closedToday && (tr.openMin != null || tr.closeMin != null)) clockOf.set(as.id, tr);
    }
    if (as.freight_unknown) unknownFreight++;
    if (String(s?.stopType || '').toUpperCase() === 'PU') pickups++;
    if (s?.isAttempt === true) attempts++;
    byId.set(id, s);
    pool.push(as);
  }

  // ── the trucks ──
  const drivers: AssignDriver[] = truckInputs.map((t) => {
    const cls = t.truck_class === 'tractor' ? 'tractor' : 'box_truck';
    const uname = String(t.driver_user_name || '').trim().toUpperCase() || null;
    // A shell with a known driver (it already holds board stops) gets that
    // driver's real learned envelope, zone affinity and ownership standing; an
    // empty shell gets the class-level fallback and is bounded by its profile.
    // THE KEY IS THE SHELL, NOT THE DRIVER. solveAssignment keys bag, capsByKey,
    // shiftByKey and kept by driver_key, so two picked loads with the same driver
    // — a driver's first load plus their reload, which is the ordinary end-of-night
    // shape — collapsed into ONE bag. Measured: pick SUW 2 and SUW 9 both driven by
    // John Smith and the panel showed two cards BOTH labelled SUW 9, holding the
    // same four stops, with SUW 2 gone and half the picked capacity never used.
    // The learned envelope is still looked up by the DRIVER's key, and zone
    // ownership matches on driver_user_name, so nothing learned is lost by this.
    const learnKey = uname ? uname.replace(/\s+/g, '_') : `LOAD__${t.key}`;
    const envelope = driverEnvelope(learnKey, inputs.driverDaysBefore, date, cfg);
    return {
      driver_key: `LOAD__${t.key}`,
      driver_user_name: uname,
      driver_name: t.name || t.key,
      truck_class: cls,
      start_minute: envelope.start_minute_typical,
      envelope,
      affinity: uname ? driverZoneAffinity(uname, inputs.referencesBefore, date, precisions) : new Map(),
      cap_override: { skids: t.max_skids ?? null, weightLb: t.max_weight_lb ?? null },
    };
  });
  const truckByKey = new Map(drivers.map((d, i) => [d.driver_key, truckInputs[i]] as const));

  // ── BUILD RULES: each truck's own equipment, and what it already carries ──
  const boardById = new Map<string, any>();
  for (const r of liveStops || []) { const k = String(r?.stopNbr ?? ''); if (k && !boardById.has(k)) boardById.set(k, r); }
  const capabilitiesOf = new Map<string, TruckCapabilities>();
  const existingOf = new Map<string, { rows: any[]; eq: number; lb: number }>();
  const fullCapByKey = new Map<string, { skids: number; weightLb: number }>();   // the whole truck, for the card
  const fullTrucks: string[] = [];
  const fullBy = new Map<string, 'skids' | 'weight'>();
  if (buildRules) {
    for (const d of drivers) {
      const t = truckByKey.get(d.driver_key)!;
      const c = t.capabilities || {};
      const tractor = typeof c.tractor === 'boolean' ? c.tractor : d.truck_class === 'tractor';
      capabilitiesOf.set(d.driver_key, {
        tractor,
        liftgate: t.liftgate === true || c.liftgate === true,
        lengthClassFt: Number.isFinite(Number(c.lengthClassFt)) && Number(c.lengthClassFt) > 0 ? Number(c.lengthClassFt) : (tractor ? 53 : 26),
        overheadClearance: c.overheadClearance !== false,
      });
      // Freight already on the load, counted the way the pool is (skids + loose share, one
      // position for a row with no freight numbers yet) so the two sides of "room" agree.
      const sent = new Map((t.existing_stops || []).map((x) => [String(x?.stopNbr ?? ''), x] as const));
      const ids = (t.existing_stop_nbrs && t.existing_stop_nbrs.length ? t.existing_stop_nbrs : [...sent.keys()]).map(String).filter(Boolean);
      const rows: any[] = [];
      let unseen = 0;
      for (const id of ids) {
        const r = boardById.get(id) || sent.get(id);
        if (r) rows.push(r); else unseen++;
      }
      if (unseen) notes.push(`${t.key}: ${unseen} stop${unseen === 1 ? '' : 's'} on it could not be read — counted as one skid each, so its room may be understated.`);
      let eq = unseen, lb = 0;
      for (const r of rows) {
        const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        const skids = num(r?.cartons), loose = num(r?.volume), pallets = num(r?.pallets);
        const unknown = skids <= 0 && loose <= 0 && pallets <= 0;
        eq += stopSkidEquiv({ skids, loose, pallets: unknown ? 1 : pallets } as AssignStop, cfg);
        lb += num(r?.weight);
      }
      existingOf.set(d.driver_key, { rows, eq, lb });
      // THE PROFILE IS THE TRUCK (Build rule): stated skids/weight win in both directions; a
      // value not stated falls back to the learned/class bound, as before.
      const learned = capsFor({ ...d, cap_override: undefined }, cfg);
      const skCap = t.max_skids && t.max_skids > 0 ? t.max_skids : learned.hard;
      const lbCap = t.max_weight_lb && t.max_weight_lb > 0 ? t.max_weight_lb
        : (Number.isFinite(learned.weightLb) ? learned.weightLb : Infinity);
      fullCapByKey.set(d.driver_key, { skids: skCap, weightLb: lbCap });
      const roomSk = skCap - eq, roomLb = lbCap - lb;
      if (roomSk <= 1e-9 || roomLb <= 1e-9) { fullTrucks.push(d.driver_key); fullBy.set(d.driver_key, roomSk <= 1e-9 ? 'skids' : 'weight'); }
      d.cap_override = { exact: true, skids: Math.max(roomSk, 1e-6), weightLb: Number.isFinite(roomLb) ? Math.max(roomLb, 1e-6) : null };
    }
  }
  // A load with no room left takes no part in the solve — it is reported, not filled.
  const fullSet = new Set(fullTrucks);
  const active = drivers.filter((d) => !fullSet.has(d.driver_key));

  const capsByKey = new Map(drivers.map((d) => [d.driver_key, capsFor(d, cfg)] as const));

  // Which picked trucks may carry this stop under the Build rules — the Build button's own
  // requirement list (equipmentReqsFrom) checked against each truck's capabilities
  // (equipmentOk). Reasons are the Build's own words.
  type Elig = { reqs: string[]; ok: string[]; reasons: string[]; toggleOnly: boolean };
  const eligibility = (s: AssignStop): Elig => {
    const note = noteOf(s.matchKey);
    const reqs = equipmentReqsFrom(note, { tractorOnlyGreen });
    // The same stop with step 3's toggle off, to tell a truck the TOGGLE excludes from one its
    // own equipment excludes — the first is fixed by a green mark or a checkbox, the second
    // only by a different truck, and the dispatcher needs to know which he is looking at.
    const base = tractorOnlyGreen ? equipmentReqsFrom(note, { tractorOnlyGreen: false }) : reqs;
    const ok: string[] = []; const reasons = new Set<string>();
    let byToggle = 0;
    for (const d of drivers) {
      const caps = { capabilities: capabilitiesOf.get(d.driver_key)! } as any;
      const r = equipmentOk({ equipmentReqs: reqs } as any, caps);
      if (r.ok) { ok.push(d.driver_key); continue; }
      const rb = equipmentOk({ equipmentReqs: base } as any, caps);
      if (rb.ok) byToggle++; else for (const x of rb.reasons) reasons.add(x);
    }
    return { reqs, ok, reasons: [...reasons], toggleOnly: byToggle > 0 };
  };
  const eligOf = new Map<string, Elig>();
  // A stop left for CAPACITY while some picked load had room must say why that load could not
  // take it. "Every truck you picked is full" with two trailers half empty is the confident
  // wrong answer — it sends the dispatcher for another truck he does not need.
  const onlyLoadsDetail = (s: AssignStop, e: Elig | undefined): string => {
    if (!e || e.ok.length >= drivers.length) return 'every truck you picked is full — this needs another truck';
    const names = e.ok.map((k) => truckByKey.get(k)?.key || k);
    const one = names.length === 1;
    const why = [
      e.toggleOnly ? 'it is not marked green, so “only green on a 53′” keeps it off the trailers' : null,
      e.reasons.length ? `the others: ${e.reasons.join('; ')}` : null,
    ].filter(Boolean).join('; ') || 'the others cannot carry it';
    return `${names.join(', ')} ${one ? 'is the only load' : 'are the only loads'} it may ride and ${one ? 'it is' : 'they are'} full — ${why}`;
  };

  // ── freight that does not fit on ANY truck he picked, pulled out FIRST ──
  //
  // A single stop can be bigger than a whole box truck: one consignee with 10
  // skids against a 6-skid straight truck. Left in the pool the solver has
  // nowhere legal to put it, so it lands on a truck anyway — the card then reads
  // "cap 6, loaded 10", which is a load that physically will not go on, and the
  // truck it landed on is now "full", so a 1-skid stop that WOULD have fit gets
  // reported as needing another truck. Both halves of that are wrong, and the
  // second one is the expensive half: it tells Chad to roll a truck he does not
  // need. A stop no provided truck can carry is not a routing problem — it needs
  // a bigger truck or a split across two, and both of those are his call, so it
  // is named and set aside rather than forced on.
  //
  // Measured against the truck that COULD take it (equipment first): a
  // tractor-blocked stop is not judged against the trailer's cap. If no truck can
  // take it on equipment grounds at all, it stays in the pool and comes back
  // through the 'equipment' path below, which says so in those words.
  const canServe = (d: AssignDriver, s: AssignStop) => driverCanServe(d, s);
  const servingCaps = (s: AssignStop) => active
    .filter((d) => canServe(d, s))
    .map((d) => capsByKey.get(d.driver_key)!)
    .filter(Boolean);
  // ── LIFTGATE: a positive capability the truck_class bit cannot express ──
  // blocksTractor is one bit and it only ever says "not a trailer". A consignee
  // marked liftgate_required needs a truck that HAS one, and a 53ft trailer does
  // not. Routed anyway, the driver cannot get the pallet on the ground and it
  // comes back — a wasted round trip and a redelivery charge, discovered at the
  // door. Checked here, before the solve, so the stop is named rather than
  // quietly loaded.
  const liftgateTrucks = drivers.filter((d) => truckByKey.get(d.driver_key)?.liftgate === true);
  const needsLiftgate = (s: AssignStop) => {
    if (!s.matchKey) return false;
    const r = inputs.notesRestrictions.get(s.matchKey) || [];
    return r.some((x: any) => String(x).toLowerCase() === 'liftgate_required');
  };

  const routable: AssignStop[] = [];
  // How many stops reached this point — the "nothing unplanned" note is about THIS, not about
  // what is left after equipment and size refusals (which are listed with their reasons).
  const poolEntered = pool.length;
  let tooBig = 0;
  for (const s of pool) {
    if (buildRules) {
      // THE BUILD'S EQUIPMENT RULE, per truck, and HARD: the solver may only put this stop on
      // a truck listed in servableBy (driverCanServe). blocksTractor is re-read from the same
      // requirement list so the one bit and the list can never disagree — a green mark lifts
      // an auto-detected blocker here exactly as it does on the Build button.
      const e = eligibility(s);
      eligOf.set(s.id, e);
      s.blocksTractor = e.reqs.some((r) => TRAILER_BLOCKERS.has(r));
      const open = e.ok.filter((k) => !fullSet.has(k));
      if (!e.ok.length) {
        const raw = byId.get(s.id);
        left.push({
          stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
          skids: s.skids, reason: 'equipment',
          detail: drivers.length
            ? `${[
              e.toggleOnly ? 'not marked green, and “only green on a 53′” is on' : null,
              ...e.reasons,
            ].filter(Boolean).join('; ') || 'equipment'} — none of the loads you picked can take it`
            : 'no loads were picked to route onto',
        });
        continue;
      }
      if (!open.length) {
        const raw = byId.get(s.id);
        left.push({
          stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
          skids: s.skids, reason: 'over_capacity',
          detail: onlyLoadsDetail(s, e),
        });
        continue;
      }
      s.servableBy = open;
    }
    if (!buildRules && needsLiftgate(s) && !liftgateTrucks.length) {
      const raw = byId.get(s.id);
      left.push({
        stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
        skids: s.skids, reason: 'equipment',
        detail: 'this customer needs a liftgate and none of the loads you picked has one',
      });
      continue;
    }
    // Under the Build rules "too big" is judged on the WHOLE truck: a stop that fits an empty
    // one but not the room a half-full load has left is a capacity question, answered later
    // (make-room, then over_capacity with the load named) — not "it needs a bigger truck".
    const caps = buildRules
      ? active.filter((d) => canServe(d, s)).map((d) => {
        const f = fullCapByKey.get(d.driver_key)!;
        return { hard: f.skids, weightLb: f.weightLb };
      })
      : servingCaps(s);
    if (!caps.length) { routable.push(s); continue; }   // equipment path owns this one
    const need = stopSkidEquiv(s, cfg);
    const needLb = Number(s.weight) || 0;
    const biggestEq = Math.max(...caps.map((c) => c.hard));
    // A non-positive weight rating means NO weight gate for that class — the same
    // rule classCapsFor uses. Only a real positive number can refuse freight.
    const biggestLb = Math.max(...caps.map((c) => (Number.isFinite(c.weightLb) && c.weightLb > 0 ? c.weightLb : Infinity)));
    const overEq = need > biggestEq + 1e-9;
    const overLb = needLb > biggestLb + 1e-9;
    if (!overEq && !overLb) { routable.push(s); continue; }
    const raw = byId.get(s.id);
    tooBig++;
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'too_big',
      detail: overEq
        ? `this stop alone is ${r1(need)} skid-equivalents and the biggest truck you picked holds ${r1(biggestEq)} — it needs a bigger truck or splitting across two`
        : `this stop alone is ${Math.round(needLb)} lb and the biggest truck you picked is rated ${Math.round(biggestLb)} lb — it needs a bigger truck or splitting across two`,
    });
  }
  // Engine rules keep their old count exactly (switch-off parity): every refusal in this loop.
  if (!buildRules) tooBig = pool.length - routable.length;
  pool.length = 0;
  pool.push(...routable);
  if (tooBig) {
    notes.push(`${tooBig} stop${tooBig === 1 ? '' : 's'} will not fit on any truck you picked, even empty — listed below. They are left out of the fit numbers because another truck this size would not take them either.`);
  }

  // ── the fit question, answered BEFORE anything is staged ──
  const poolEq = pool.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
  const capacityEq = drivers.reduce((a, d) => a + (capsByKey.get(d.driver_key)?.hard || 0), 0);
  const perTruckAvg = drivers.length ? capacityEq / drivers.length : 0;
  const fit: {
    pool_skid_equiv: number; capacity_skid_equiv: number; fits: boolean; shortfall_skid_equiv: number;
    trucks_needed_estimate: number; constrained?: { trucks: string[]; skid_equiv: number; room: number } | null;
  } = {
    pool_skid_equiv: r1(poolEq),
    capacity_skid_equiv: r1(capacityEq),
    fits: poolEq <= capacityEq,
    shortfall_skid_equiv: r1(Math.max(0, poolEq - capacityEq)),
    trucks_needed_estimate: perTruckAvg > 0 ? Math.ceil(poolEq / perTruckAvg) : 0,
  };
  if (!fit.fits) {
    notes.push(`The pool is ${fit.pool_skid_equiv} skid-equivalents and these ${drivers.length} truck${drivers.length === 1 ? '' : 's'} hold about ${fit.capacity_skid_equiv} — roughly ${fit.trucks_needed_estimate} trucks would clear it. The overflow is listed, not hidden.`);
  }
  // ── IT FITS IN TOTAL — BUT DOES IT FIT WHERE THE RULES ALLOW? (Build rules) ──
  // Total skids against total room says nothing when some freight may ride only some trucks:
  // 57 skids against 65 of room "fits", and still leaves box-only freight on the dock when the
  // one box is full. For every group of trucks some freight is limited to, the freight limited
  // to that group must fit that group's room (Hall's condition on the sets the board actually
  // has). The worst shortfall is reported instead of a green "it all fits".
  let constrainedFit: { trucks: string[]; skid_equiv: number; room: number } | null = null;
  if (buildRules && fit.fits) {
    const groups = new Map<string, string[]>();
    for (const x of pool) if (x.servableBy) groups.set([...x.servableBy].sort().join('|'), x.servableBy);
    let worst = 0;
    for (const K of groups.values()) {
      const k = new Set(K);
      if (k.size >= active.length) continue;   // freight free to ride any truck is the total check above
      const eq = pool.filter((x) => (x.servableBy || []).every((y) => k.has(y))).reduce((a, x) => a + stopSkidEquiv(x, cfg), 0);
      const room = K.reduce((a, y) => a + (capsByKey.get(y)?.hard || 0), 0);
      if (eq > room + 1e-9 && eq - room > worst) {
        worst = eq - room;
        constrainedFit = { trucks: K.map((y) => truckByKey.get(y)?.key || y), skid_equiv: r1(eq), room: r1(room) };
      }
    }
    if (constrainedFit) {
      fit.fits = false;
      fit.shortfall_skid_equiv = r1(worst);
      const one = constrainedFit.trucks.length === 1;
      notes.push(`It fits in total, but not where the rules allow it: ${constrainedFit.skid_equiv} skid-equivalents may ride only ${constrainedFit.trucks.join(', ')}, which ${one ? 'has' : 'have'} room for ${constrainedFit.room}. The rest is listed with the reason.`);
    }
  }

  const fleet = fleetTripChain(inputs.driverDaysBefore, date, cfg);
  const svcCache = new Map<string, number>();
  const serviceMedianFor = (s: AssignStop): number => {
    const k = `${s.matchKey}__${s.pallets}`;
    let v = svcCache.get(k);
    if (v == null) {
      const doc = s.matchKey ? inputs.serviceDocByKey.get(s.matchKey) : null;
      v = serviceTimeAsOf(doc, inputs.fleetServiceDoc, s.pallets, date, cfg).median_min;
      svcCache.set(k, v);
    }
    return v;
  };

  const capsForSeed = new Map([...capsByKey].map(([k, c]) => [k, { hard: c.hard, weightLb: c.weightLb }] as const));
  const result = pool.length && active.length
    ? solveAssignment({
      date, stops: pool, drivers: active, fleetChain: fleet, cfg,
      depot: { lat: DEPOT.lat, lng: DEPOT.lng }, serviceMedianFor,
      zoneOwners: zoneOwnersAsOf(inputs.referencesBefore, date, precisions, cfg),
      // One shell, one truckload — see the header.
      max_loads_per_driver: 1,
      // GEOMETRY IS THE SIGNAL HERE — see sweepSeed.
      seedAssignment: sweepSeed(pool, active, capsForSeed, { lat: DEPOT.lat, lng: DEPOT.lng }, cfg),
    })
    : { date, shifts: [], unassigned: (active.length ? [] : pool.slice()) as AssignStop[], cost: 0, drivers_used: 0, tie_margin: null };

  for (const s of result.unassigned) {
    const raw = byId.get(s.id);
    // Say WHICH refusal it was. "The customer bars a tractor" sends Chad to find
    // a box truck; "you picked no trucks" sends him to pick one. Printing the
    // first when the second is true is the confident-wrong-answer failure.
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'equipment',
      detail: !drivers.length
        ? 'no loads were picked to route onto'
        : (buildRules && !active.length)
          ? 'every load you picked is already full'
          : (s.blocksTractor
            ? 'this customer bars a tractor/trailer and every load you picked is one'
            : 'none of the loads you picked can take it'),
    });
  }

  // ── one trip per shell, THEN refill before anything is called overflow ──
  //
  // The solver splits a driver's bag into as many trips as the caps demand, and
  // cleanup keeps only the first (a shell is one route). Taking trips[0] and
  // stopping there would strand freight on a truck that is already full while
  // ANOTHER picked shell sits empty — the exact opposite of "give it 5 empties
  // and let it route the leftovers on them". So every stop past a shell's one
  // load is re-offered to every shell that still has room, nearest-first, and
  // only what STILL does not fit is reported as needing another truck.
  // ── the SEQUENCING budget, split across the shells ──
  // LIVE_SOLVER_MS bounds the assignment only. Sequencing runs solveRoute ONCE
  // PER TRUCK against solver_ms_cap (1s by default), so 12 shells could add 12
  // more seconds on top of a 12-second assignment and blow the 26s function
  // timeout — and the failure mode there is the HTML 502 the timeout bump exists
  // to prevent. One budget for the whole loop, divided by the shells actually
  // picked, so the answer arrives whatever Chad hands it.
  const seqCfg: EngineConfig = {
    ...cfg,
    solver_ms_cap: Math.max(50, Math.min(cfg.solver_ms_cap, Math.floor(CLEANUP_SEQUENCE_MS / Math.max(1, drivers.length)))),
  };
  const modalWarehouse = modalWarehouseOf(inputs.referencesBefore);
  const shiftByKey = new Map(result.shifts.map((sh) => [sh.driver.driver_key, sh] as const));

  const kept = new Map<string, AssignStop[]>();     // driver_key → the one truckload
  const spill: AssignStop[] = [];
  for (const d of drivers) {
    const trips = shiftByKey.get(d.driver_key)?.trips.filter((t) => t.stops.length) || [];
    kept.set(d.driver_key, [...(trips[0]?.stops || [])]);
    for (const extra of trips.slice(1)) spill.push(...extra.stops);
  }
  // ── capacity repair: no truck keeps freight it cannot legally carry ──
  //
  // The solver's trip splitter puts a single stop that exceeds a driver's cap in
  // a trip BY ITSELF rather than drop it, and for the nightly plan that is right:
  // there the cap is a LEARNED typical load, not a physical wall, and a driver
  // who usually runs 8 skids can take a 10-skid stop. Cleanup keeps one trip per
  // shell, so that over-cap trip becomes the truck's entire load and the card
  // reads "cap 8, loaded 10". Here the cap IS the wall — Chad picked these
  // trucks and told us what they hold — so anything past it comes back off,
  // biggest first, and is re-offered below to a truck that can actually take it.
  const weightCapOf = (c: { weightLb: number }) => (Number.isFinite(c.weightLb) && c.weightLb > 0 ? c.weightLb : Infinity);
  for (const d of drivers) {
    const caps = capsByKey.get(d.driver_key)!;
    const load = kept.get(d.driver_key)!;
    const lbCap = weightCapOf(caps);
    const over = () => load.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0) > caps.hard + 1e-9
      || load.reduce((a, s) => a + (Number(s.weight) || 0), 0) > lbCap + 1e-9;
    while (load.length && over()) {
      // Biggest first — sheds the overflow in the fewest moves — ties by id so
      // the same board always evicts the same stop.
      let worst = 0;
      for (let i = 1; i < load.length; i++) {
        const a = stopSkidEquiv(load[i], cfg), b = stopSkidEquiv(load[worst], cfg);
        if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && load[i].id.localeCompare(load[worst].id) < 0)) worst = i;
      }
      spill.push(load.splice(worst, 1)[0]);
    }
  }
  // Deterministic: biggest freight first (same discipline as the solver's seed),
  // ties by id — never insertion order.
  spill.sort((a, b) => (stopSkidEquiv(b, cfg) - stopSkidEquiv(a, cfg)) || a.id.localeCompare(b.id));
  const roomFor = (d: AssignDriver) => {
    const caps = capsByKey.get(d.driver_key)!;
    const load = kept.get(d.driver_key)!;
    const eq = load.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
    const lb = load.reduce((a, s) => a + (Number(s.weight) || 0), 0);
    return { eq: caps.hard - eq, lb: weightCapOf(caps) - lb };
  };
  const refilled: AssignStop[] = [];
  for (const s of spill) {
    const need = stopSkidEquiv(s, cfg), needLb = Number(s.weight) || 0;
    let best: AssignDriver | null = null, bestDist = Infinity;
    for (const d of drivers) {
      if (!driverCanServe(d, s)) continue;   // equipment is inviolable — the solver's own gate
      const room = roomFor(d);
      if (room.eq + 1e-9 < need || room.lb + 1e-9 < needLb) continue;
      // Nearest-first keeps the refill compact: distance to what the truck already
      // holds, or to the depot when it is still empty (which is what makes an
      // empty shell win the near-in freight instead of staying empty).
      const load = kept.get(d.driver_key)!;
      const dist = load.length
        ? Math.min(...load.map((x) => Math.hypot((x.lat - s.lat) * 69, (x.lng - s.lng) * 57)))
        : Math.hypot((DEPOT.lat - s.lat) * 69, (DEPOT.lng - s.lng) * 57);
      if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && best && d.driver_key < best.driver_key)) {
        bestDist = dist; best = d;
      }
    }
    if (best) { kept.get(best.driver_key)!.push(s); refilled.push(s); }
  }
  // ── MAKE ROOM (Build rules): freight that may ride only SOME trucks gets them first ──
  //
  // Run on a sample of Chad's own shape — one box, two 53s, "only green on a 53'" on — the
  // solve put GREEN stops (free to ride a trailer) on the box, the box filled, and six stops
  // that may ride only the box came back "every truck you picked is full" with both trailers
  // holding 6–10 skids of room. So before anything is called overflow: for a stop that did
  // not fit, look at the trucks it MAY ride and move off them freight that is free to ride
  // another truck with room — the smallest single move that frees enough, else biggest-first
  // — and only then put it on. Equipment is never bent: every move goes through driverCanServe.
  let madeRoom = 0;
  if (buildRules) {
    const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lat - b.lat) * 69, (a.lng - b.lng) * 57);
    const nearTo = (d: AssignDriver, x: AssignStop) => {
      const load = kept.get(d.driver_key)!;
      return load.length ? Math.min(...load.map((y) => dist(y, x))) : dist(DEPOT, x);
    };
    const pending = spill.filter((x) => !refilled.includes(x));
    for (const s of pending) {
      const need = stopSkidEquiv(s, cfg), needLb = Number(s.weight) || 0;
      const targets = active.filter((d) => driverCanServe(d, s)).sort((a, b) => nearTo(a, s) - nearTo(b, s) || a.driver_key.localeCompare(b.driver_key));
      for (const d of targets) {
        const room = roomFor(d);
        const defEq = need - room.eq, defLb = needLb - room.lb;
        // Room opened up by an earlier move in this pass — it just goes on, nothing else moves.
        if (defEq <= 1e-9 && defLb <= 1e-9) {
          kept.get(d.driver_key)!.push(s); refilled.push(s); madeRoom++;
          break;
        }
        // Freight on d that another truck may carry and has room for, nearest home first.
        const movable = kept.get(d.driver_key)!.map((f) => {
          let best: AssignDriver | null = null, bd = Infinity;
          for (const d2 of active) {
            if (d2 === d || !driverCanServe(d2, f)) continue;
            const r2 = roomFor(d2);
            if (r2.eq + 1e-9 < stopSkidEquiv(f, cfg) || r2.lb + 1e-9 < (Number(f.weight) || 0)) continue;
            const dd = nearTo(d2, f);
            if (dd < bd) { bd = dd; best = d2; }
          }
          return best ? { f, to: best } : null;
        }).filter(Boolean) as Array<{ f: AssignStop; to: AssignDriver }>;
        if (!movable.length) continue;
        const frees = (m: { f: AssignStop }) => ({ eq: stopSkidEquiv(m.f, cfg), lb: Number(m.f.weight) || 0 });
        let plan: Array<{ f: AssignStop; to: AssignDriver }> | null = null;
        const single = movable.filter((m) => frees(m).eq + 1e-9 >= defEq && frees(m).lb + 1e-9 >= defLb)
          .sort((a, b) => frees(a).eq - frees(b).eq || a.f.id.localeCompare(b.f.id));
        if (single.length) plan = [single[0]];
        else {
          // Biggest first, re-checking each destination's room as the moves stack up.
          const used = new Map<string, { eq: number; lb: number }>();
          let gotEq = 0, gotLb = 0;
          const picks: Array<{ f: AssignStop; to: AssignDriver }> = [];
          for (const m of [...movable].sort((a, b) => frees(b).eq - frees(a).eq || a.f.id.localeCompare(b.f.id))) {
            const r2 = roomFor(m.to), u = used.get(m.to.driver_key) || { eq: 0, lb: 0 };
            const fr = frees(m);
            if (r2.eq - u.eq + 1e-9 < fr.eq || r2.lb - u.lb + 1e-9 < fr.lb) continue;
            used.set(m.to.driver_key, { eq: u.eq + fr.eq, lb: u.lb + fr.lb });
            picks.push(m); gotEq += fr.eq; gotLb += fr.lb;
            if (gotEq + 1e-9 >= defEq && gotLb + 1e-9 >= defLb) { plan = picks; break; }
          }
        }
        if (!plan) continue;
        for (const m of plan) {
          const from = kept.get(d.driver_key)!;
          from.splice(from.indexOf(m.f), 1);
          kept.get(m.to.driver_key)!.push(m.f);
        }
        kept.get(d.driver_key)!.push(s);
        refilled.push(s);
        madeRoom++;
        break;
      }
    }
  }
  const stillOver = new Set(spill.filter((s) => !refilled.includes(s)).map((s) => s.id));
  if (madeRoom) {
    notes.push(`${madeRoom} stop${madeRoom === 1 ? '' : 's'} that may ride only some of your loads got on by moving freight that can ride another one.`);
  }
  if (refilled.length - madeRoom > 0) {
    notes.push(`${refilled.length - madeRoom} stop${refilled.length - madeRoom === 1 ? '' : 's'} moved onto trucks that still had room.`);
  }
  // ── sequence every truck on the ENGINE's learned order (both rule sets) ──
  const seq = new Map<string, { order: AssignStop[]; travelMin: number; mode: 'guided' | 'unguided'; refsUsed: number }>();
  for (const d of drivers) {
    const stops = kept.get(d.driver_key) || [];
    if (!stops.length) { seq.set(d.driver_key, { order: [], travelMin: 0, mode: 'unguided', refsUsed: 0 }); continue; }
    const engineStops: EngineStop[] = stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, zone: s.zone }));
    const picked = pickReferences(
      inputs.referencesBefore,
      {
        date, zones: new Set(engineStops.map((s) => s.zone)),
        driverUserName: d.driver_user_name, truckClass: d.truck_class,
        warehouse: modalWarehouse || null, minOverlap: cfg.min_reference_zone_overlap,
      },
      { topK: cfg.reference_top_k, halfLifeDays: cfg.reference_half_life_days, sameDriverMultiplier: cfg.same_driver_multiplier },
    );
    const solved = solveRoute({
      loadKey: `cleanup__${date}__${d.driver_key}`,
      stops: engineStops, depot: { lat: DEPOT.lat, lng: DEPOT.lng },
      referenceZoneSeq: null,
      references: picked.length ? picked.map((p) => ({ zone_seq: p.ref.zone_seq, weight: p.weight })) : null,
      cfg: seqCfg,
    });
    const byStopId = new Map(stops.map((s) => [s.id, s] as const));
    seq.set(d.driver_key, {
      order: solved.order.map((o) => byStopId.get(o.id)!).filter(Boolean),
      travelMin: solved.travelMin,
      mode: picked.length ? 'guided' : 'unguided',
      refsUsed: picked.length,
    });
  }

  // ── BUILD RULES: THE CLOCK ─────────────────────────────────────────────────
  //
  // The Build's rule, on the ENGINE's clock. Windows come from the same resolver the Build
  // button uses (order window ∩ receiving hours for the board day); each windowed stop is
  // inserted into the engine's learned order by the Build's own insertion rule
  // (insertByWindow — on time first, then least idle, then least added distance). The clock
  // it is judged on is the engine's: the truck's learned typical start, the engine's drive
  // times and each customer's learned service minutes. A load that already carries stops
  // runs them FIRST, because staging appends the engine's stops after them.
  // Advisory (default): a stop that still cannot make it stays on and is flagged with its ETA.
  // Strict: it comes off, is offered to any other picked load that can reach it on time and
  // has room, and is listed with the reason when none can.
  const etaOf = new Map<string, { eta: number; late: boolean }>();
  const departOf = new Map<string, number>();
  const timeLeftovers: AssignStop[] = [];
  let timeMoved = 0;
  if (buildRules) {
    const svcRow = (r: any) => serviceMedianFor({ matchKey: liveMatchKey(r), pallets: Number(r?.pallets) || 0 } as AssignStop);
    type Pre = { clock: number; lat: number; lng: number; anchor: number | null; depart: number | null };
    const posOf = (r: any) => {
      const la = Number(r?.lat), ln = Number(r?.lng);
      return Number.isFinite(la) && Number.isFinite(ln) && !(la === 0 && ln === 0) ? { lat: la, lng: ln } : null;
    };
    const legMin = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => travelMinutesForMiles(haversineMiles(a.lat, a.lng, b.lat, b.lng), cfg);
    // THE CLOCK'S START. The engine's learned start (envelope.start_minute_typical) is the
    // median FIRST DELIVERY of the day, not the minute the truck leaves Buford — so it anchors
    // the arrival at the first stop, and the drive to it is not counted a second time. With no
    // learned start, the Build button's own departure: 8:00 from the dock.
    const prefixOf = (d: AssignDriver): Pre => {
      const learned = d.start_minute != null && Number.isFinite(Number(d.start_minute)) ? Number(d.start_minute) : null;
      const rows = existingOf.get(d.driver_key)?.rows || [];
      if (!rows.length) {
        return learned != null
          ? { clock: learned, lat: DEPOT.lat, lng: DEPOT.lng, anchor: learned, depart: null }
          : { clock: CLEANUP_DEFAULT_DEPART_MIN, lat: DEPOT.lat, lng: DEPOT.lng, anchor: null, depart: CLEANUP_DEFAULT_DEPART_MIN };
      }
      // A load that already carries stops runs them FIRST (staging appends after them), and a
      // truck early to one of THEIR docks waits for it too — skipping that wait is what made a
      // stop behind a 10am dock read on time at 8:29.
      const first = rows.map(posOf).find(Boolean);
      let clock = learned != null && first ? learned - legMin(DEPOT, first) : (learned ?? CLEANUP_DEFAULT_DEPART_MIN);
      const depart = clock;
      let at: { lat: number; lng: number } = DEPOT;
      for (const r of rows) {
        const pos = posOf(r);
        if (pos) { clock += legMin(at, pos); at = pos; }
        const tr = timeOn ? stopTimeRestriction({ stop: r, note: noteOf(liveMatchKey(r)), date, defaultSlots }) : null;
        const open = tr && !tr.closedToday ? tr.openMin : null;
        if (open != null && clock < open) clock = open;
        clock += svcRow(r);   // a stop with no map position still takes its service time
      }
      return { clock, lat: at.lat, lng: at.lng, anchor: null, depart };
    };
    const closeOf = (s: AssignStop): number | null => {
      const tr = clockOf.get(s.id);
      return tr ? (tr.closeMin ?? 24 * 60 - 1) : null;
    };
    const tlFor = (pre: Pre) => (order: AssignStop[]) => {
      const etas: number[] = [], waits: number[] = [];
      let clock = pre.clock, lat = pre.lat, lng = pre.lng;
      for (let i = 0; i < order.length; i++) {
        const s = order[i];
        // Anchored: the learned first delivery IS the arrival at the first stop.
        if (i === 0 && pre.anchor != null) clock = pre.anchor;
        else clock += travelMinutesForMiles(haversineMiles(lat, lng, s.lat, s.lng), cfg);
        const open = clockOf.get(s.id)?.openMin ?? null;
        const startAt = open != null && clock < open ? open : clock;   // a truck early to the dock WAITS
        waits.push(startAt - clock); clock = startAt; etas.push(clock);
        clock += serviceMedianFor(s);
        lat = s.lat; lng = s.lng;
      }
      return { etas, waits };
    };
    const miles = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => haversineMiles(a.lat, a.lng, b.lat, b.lng);
    const edf = (a: AssignStop, b: AssignStop) =>
      ((closeOf(a) ?? 1e9) - (closeOf(b) ?? 1e9))
      || ((clockOf.get(a.id)?.openMin ?? 0) - (clockOf.get(b.id)?.openMin ?? 0)) || a.id.localeCompare(b.id);
    // Engine order for the stops with no clock; the windowed ones inserted by the Build's rule.
    // A dock this truck cannot reach before it shuts even going there FIRST is hopeless on
    // this truck. Left in the insertion it trades minutes with the stops that CAN be made —
    // measured on the sample board: a 5–7am bakery nobody could reach pushed a 10am school 4
    // minutes late. So a hopeless stop keeps the engine's place and does not bid for the
    // front; it is still flagged (advisory) or taken off and re-offered (strict).
    const hopeless = (pre: Pre, s: AssignStop) => {
      const c = closeOf(s);
      const earliest = pre.anchor != null ? pre.anchor : pre.clock + travelMinutesForMiles(haversineMiles(pre.lat, pre.lng, s.lat, s.lng), cfg);
      return c != null && earliest > c;
    };
    const orderWithClock = (pre: Pre, engineOrder: AssignStop[]) =>
      insertByWindow(
        engineOrder.filter((s) => !clockOf.has(s.id) || hopeless(pre, s)),
        engineOrder.filter((s) => clockOf.has(s.id) && !hopeless(pre, s)).sort(edf),
        {
          timeline: tlFor(pre),
          // A hopeless stop has no deadline worth trading for: counting its lateness would make
          // a reachable stop late to save minutes on one that is late anyway.
          closeOf: (s) => (hopeless(pre, s) ? null : closeOf(s)),
          added: (prev, w, next) => {
            const from = prev || pre;
            return miles(from, w) + (next ? miles(w, next) - miles(from, next) : 0);
          },
        },
      );
    const lateness = (pre: Pre, order: AssignStop[]) => {
      const { etas } = tlFor(pre)(order);
      return order.map((s, i) => { const c = closeOf(s); return c != null && etas[i] > c ? etas[i] - c : 0; });
    };
    const pres = new Map(drivers.map((d) => [d.driver_key, prefixOf(d)] as const));
    for (const d of drivers) {
      const pre = pres.get(d.driver_key)!;
      const cur = seq.get(d.driver_key)!;
      let order = orderWithClock(pre, cur.order);
      if (windowMode === 'strict') {
        // Worst lateness first, one at a time, re-inserting after each — the Build's Phase A.
        // Bounded by the count at the START: `order` shrinks by one per pass, and a bound read
        // off it each pass stopped after about half the removals — strict then kept late stops
        // on the truck and the note blamed "advisory".
        const n0 = order.length;
        for (let guard = 0; guard <= n0; guard++) {
          const late = lateness(pre, order);
          let worst = -1;
          late.forEach((m, i) => { if (m > 0 && (worst < 0 || m > late[worst])) worst = i; });
          if (worst < 0) break;
          const gone = order[worst];
          timeLeftovers.push(gone);
          const k = kept.get(d.driver_key)!;
          k.splice(k.indexOf(gone), 1);
          order = orderWithClock(pre, order.filter((x) => x !== gone));
        }
      }
      cur.order = order;
    }
    // Strict removals get one more chance: any other picked load that may carry it, has the
    // room, and gets there on time WITHOUT making anything already on it late.
    if (timeLeftovers.length) {
      const pending = timeLeftovers.splice(0).sort(edf);
      for (const s of pending) {
        let placed = false;
        for (const d of active) {
          if (!driverCanServe(d, s)) continue;
          const room = roomFor(d);
          if (room.eq + 1e-9 < stopSkidEquiv(s, cfg) || room.lb + 1e-9 < (Number(s.weight) || 0)) continue;
          const pre = pres.get(d.driver_key)!;
          const cand = orderWithClock(pre, [...seq.get(d.driver_key)!.order, s]);
          if (lateness(pre, cand).some((m) => m > 0)) continue;
          kept.get(d.driver_key)!.push(s);
          seq.get(d.driver_key)!.order = cand;
          timeMoved++; placed = true;
          break;
        }
        if (!placed) timeLeftovers.push(s);
      }
    }
    // ROOM A TIME REMOVAL FREED goes back to freight that was left for capacity — otherwise
    // strict takes a stop off, and the freight behind it is still told "that load is full".
    for (const s of spill) {
      if (!stillOver.has(s.id)) continue;
      const need = stopSkidEquiv(s, cfg), needLb = Number(s.weight) || 0;
      for (const d of active) {
        if (!driverCanServe(d, s)) continue;
        const room = roomFor(d);
        if (room.eq + 1e-9 < need || room.lb + 1e-9 < needLb) continue;
        const pre = pres.get(d.driver_key)!, cur = seq.get(d.driver_key)!;
        const lateBefore = lateness(pre, cur.order).filter((m) => m > 0).length;
        const cand = orderWithClock(pre, [...cur.order, s]);
        const lateAfter = lateness(pre, cand).filter((m) => m > 0).length;
        if (windowMode === 'strict' ? lateAfter > 0 : lateAfter > lateBefore) continue;
        kept.get(d.driver_key)!.push(s);
        cur.order = cand;
        stillOver.delete(s.id);
        timeMoved++;
        break;
      }
    }
    for (const d of drivers) {
      const pre = pres.get(d.driver_key)!;
      const cur = seq.get(d.driver_key)!;
      const { etas } = tlFor(pre)(cur.order);
      const late = lateness(pre, cur.order);
      cur.order.forEach((s, i) => etaOf.set(s.id, { eta: etas[i], late: late[i] > 0 }));
      departOf.set(d.driver_key, pre.anchor != null
        ? (cur.order.length ? pre.anchor - legMin(DEPOT, cur.order[0]) : NaN)
        : (pre.depart ?? CLEANUP_DEFAULT_DEPART_MIN));
      // Drive minutes over the stops this fill adds, from where the truck is when it starts them.
      let t = 0, at: { lat: number; lng: number } = pre;
      for (const s of cur.order) { t += travelMinutesForMiles(miles(at, s), cfg); at = s; }
      void at;
      cur.travelMin = t;
    }
  }

  const out: CleanupTruck[] = drivers.map((d) => {
    const t = truckByKey.get(d.driver_key)!;
    const caps = capsByKey.get(d.driver_key)!;
    // SAY WHICH NUMBER THIS IS, HONESTLY. An empty shell has no driver, so
    // driverEnvelope finds no days, falls through with truck_class null and
    // returns a WHOLE-FLEET envelope — box and tractor days mixed. capsFor sees a
    // p85 and reports learned:true, so calling that 'driver' put the word
    // "driver" on a truck that has none, and the p85 of a mixed fleet clamps to
    // the box class cap of 22. Chad's own comment on capsFor says most of the
    // fleet cannot put 22 skids on a box truck; most run 12-15. Labelling it
    // 'driver' also suppressed the one warning written to catch exactly this.
    const envSource = String((d.envelope as any)?.source || '');
    const full = fullCapByKey.get(d.driver_key);
    const capSource: 'profile' | 'driver' | 'fleet' | 'class' =
      (buildRules ? (t.max_skids && t.max_skids > 0) : (t.max_skids && t.max_skids > 0 && t.max_skids <= caps.hard + 1e-9)) ? 'profile'
        : (caps.learned && d.driver_user_name && envSource === 'driver') ? 'driver'
          : caps.learned ? 'fleet' : 'class';
    const cur = seq.get(d.driver_key)!;
    const ordered = cur.order;
    const ex = existingOf.get(d.driver_key);
    const capSkids = buildRules && full ? full.skids : caps.hard;
    const capLb = buildRules && full ? full.weightLb : caps.weightLb;
    const depart = departOf.get(d.driver_key);
    return {
      key: t.key,
      name: t.name ?? null,
      loadNbr: t.loadNbr ?? null,
      loadId: t.loadId ?? null,
      truck_class: d.truck_class || 'box_truck',
      driver_user_name: d.driver_user_name,
      cap: { skids: r1(capSkids), weight_lb: Number.isFinite(capLb) ? capLb : null, source: capSource },
      stops: ordered.map((s) => {
        const raw = byId.get(s.id);
        const closeMin = clockByStop.has(s.id) ? clockByStop.get(s.id)! : null;
        const base = {
          stopNbr: s.id, businessName: raw?.businessName ?? null, addr1: raw?.addr1 ?? null, city: raw?.city ?? null,
          lat: s.lat, lng: s.lng, skids: s.skids, loose: s.loose, weight: s.weight, miles: r1(s.miles),
          close_min: closeMin,
          close_label: closeMin == null ? null : fmtMin(closeMin),
          early_close: closeMin != null && closeMin < CLEANUP_EARLY_CLOSE_MIN,
          pickup: String(raw?.stopType || '').toUpperCase() === 'PU',
        };
        if (!buildRules) return base;
        const e = etaOf.get(s.id);
        return {
          ...base,
          window_label: clockOf.get(s.id)?.label || null,
          eta_label: e ? fmtMin(Math.round(e.eta)) : null,
          late: !!e?.late,
        };
      }),
      stop_count: ordered.length,
      skid_equiv: r1(ordered.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0)),
      weight_lb: Math.round(ordered.reduce((a, s) => a + (Number(s.weight) || 0), 0)),
      travel_min_est: r1(cur.travelMin),
      mode: cur.mode,
      references_used: cur.refsUsed,
      ...(buildRules ? {
        existing: ex && ex.rows.length ? { stops: ex.rows.length, skid_equiv: r1(ex.eq), weight_lb: Math.round(ex.lb) } : null,
        depart_label: depart != null && Number.isFinite(depart) ? fmtMin(Math.round(((depart % 1440) + 1440) % 1440)) : null,
        full: fullSet.has(d.driver_key),
        ...(fullSet.has(d.driver_key) ? { full_by: fullBy.get(d.driver_key) } : {}),
      } : {}),
    };
  });

  for (const s of timeLeftovers) {
    const raw = byId.get(s.id);
    const tr = clockOf.get(s.id);
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'time_window',
      detail: `no load you picked reaches it inside its time restriction${tr?.label ? ` (${tr.label})` : ''} — strict leaves it off`,
    });
  }

  for (const s of spill) {
    if (!stillOver.has(s.id)) continue;
    const raw = byId.get(s.id);
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'over_capacity',
      detail: buildRules ? onlyLoadsDetail(s, eligOf.get(s.id)) : 'every truck you picked is full — this needs another truck',
    });
  }

  if (closedToday) {
    notes.push(`${closedToday} stop${closedToday === 1 ? '' : 's'} are at customers closed on ${DAY_LABEL[dayKey || ''] || 'that day'} — listed below, not routed. Nobody is there to take the freight.`);
  }
  // An early-closing dock buried in the back half of a route is the refusal this
  // feature would otherwise cause. The sequencer is geographic and does not know
  // about clocks, so rather than pretend otherwise, name the ones at risk and let
  // the dispatcher drag them up — which is a thing he can actually do on the card.
  // Under the Build rules the clock is COMPUTED, not guessed from a position in the list, so
  // this heuristic stands down and the ETA-based lines below speak instead — a "move it up"
  // note on a stop the clock says arrives on time would be a warning about nothing.
  const lateEarlyClosers: string[] = [];
  if (!buildRules) for (const t of out) {
    t.stops.forEach((st, i) => {
      if (st.early_close && i >= Math.floor(t.stops.length / 2)) {
        lateEarlyClosers.push(`${st.businessName || st.stopNbr} (shuts ${st.close_label}, ${i + 1} of ${t.stops.length} on ${t.key})`);
      }
    });
  }
  if (lateEarlyClosers.length) {
    notes.push(`Sequenced late but shuts early — move ${lateEarlyClosers.length === 1 ? 'it' : 'them'} up or the truck arrives to a closed dock: ${lateEarlyClosers.join('; ')}.`);
  }
  const routed = out.reduce((a, t) => a + t.stop_count, 0);
  if (buildRules ? !poolEntered : !pool.length) notes.push('nothing is sitting unplanned on this board — there is nothing to clean up');
  if (pickups || attempts) {
    const bits = [pickups ? `${pickups} pickup${pickups === 1 ? '' : 's'}` : null,
      attempts ? `${attempts} re-delivery attempt${attempts === 1 ? '' : 's'}` : null].filter(Boolean);
    notes.push(`The pool includes ${bits.join(' and ')} — real work, but check they belong on these trucks.`);
  }
  if (unknownFreight) {
    notes.push(`${unknownFreight} stop${unknownFreight === 1 ? '' : 's'} have no freight numbers yet — each is counted as one skid, so the fills below are an estimate.`);
  }
  const fullNames = fullTrucks.map((k) => truckByKey.get(k)?.key || k);
  const emptyTrucks = out.filter((t) => !t.stop_count && !fullNames.includes(t.key)).map((t) => t.key);
  if (emptyTrucks.length && pool.length && (!buildRules || routed > 0)) {
    notes.push(`${emptyTrucks.join(', ')} got nothing — the pool fit on the others.`);
  }
  if (buildRules) {
    if (fullNames.length) {
      notes.push(`${fullNames.join(', ')} ${fullNames.length === 1 ? 'is' : 'are'} already full with what ${fullNames.length === 1 ? 'is' : 'are'} on ${fullNames.length === 1 ? 'it' : 'them'} — nothing added.`);
    }
    const lateAdvisory: string[] = [];
    for (const t of out) for (const st of t.stops) {
      if (st.late) lateAdvisory.push(`${st.businessName || st.stopNbr} (arrives ${st.eta_label}, ${st.window_label}, on ${t.key})`);
    }
    if (lateAdvisory.length && windowMode === 'advisory') {
      notes.push(`${lateAdvisory.length} stop${lateAdvisory.length === 1 ? '' : 's'} can't make ${lateAdvisory.length === 1 ? 'its' : 'their'} time restriction and ${lateAdvisory.length === 1 ? 'is' : 'are'} kept on, because time restrictions are advisory — tick “Respect time restrictions strictly” in step 3 to leave ${lateAdvisory.length === 1 ? 'it' : 'them'} off: ${lateAdvisory.join('; ')}.`);
    }
    if (timeMoved) {
      notes.push(`${timeMoved} stop${timeMoved === 1 ? '' : 's'} placed after the clock check — moved to a load that reaches ${timeMoved === 1 ? 'it' : 'them'} in time, or into room a late stop left behind.`);
    }
  }

  return {
    ok: true,
    rules: buildRules ? 'build' : 'engine',
    ...(buildRules ? { rules_detail: { tractor_only_green: tractorOnlyGreen, window_mode: windowMode, time_restrictions: !!timeOn } } : {}),
    tenant, date, engine_version: ENGINE_VERSION, generated_at: nowIso,
    pool: {
      board_stops: (liveStops || []).length, unplanned: unplannedRows.length,
      excluded_held: excludedHeld, no_coords: noCoords, routed,
      pickups, attempts, unknown_freight: unknownFreight, duplicates, no_id: noId, closed_today: closedToday,
    },
    fit: buildRules ? { ...fit, constrained: constrainedFit } : fit,
    staleness: {
      last_scanned_at: meta?.last_scanned_at ?? null,
      last_load_scan_at: meta?.lastLoadScanAt ?? null,
      last_unplanned_scan_at: meta?.lastUnplannedScanAt ?? null,
      pool_age_min: poolAgeMin,
      stale: poolAgeMin != null && poolAgeMin > CLEANUP_STALE_MIN,
    },
    trucks: out,
    left_unplanned: left,
    notes,
    ms: Date.now() - t0,
  };
}

// I/O wrapper: live board + the same as-of learning inputs the nightly uses.
// ZERO NuVizz calls — readStops and loadPlanInputs are Firestore-only.
export async function runCleanup(
  tenant: string, date: string, trucks: CleanupTruckInput[], excludeStopNbrs?: string[],
  ruleOpts: { tractorOnlyGreen?: boolean; windowMode?: 'strict' | 'advisory' } = {},
): Promise<{ ok: true; plan: CleanupResult } | { ok: false; status: number; error: string }> {
  if (!Array.isArray(trucks) || !trucks.length) {
    return { ok: false, status: 400, error: 'pick at least one load to route onto' };
  }
  if (trucks.length > CLEANUP_MAX_TRUCKS) {
    return { ok: false, status: 400, error: `too many loads (${trucks.length}) — cleanup handles up to ${CLEANUP_MAX_TRUCKS}` };
  }
  const seen = new Set<string>();
  for (const t of trucks) {
    const k = String(t?.key || '').trim();
    if (!k) return { ok: false, status: 400, error: 'every load needs a name/key' };
    if (seen.has(k)) return { ok: false, status: 400, error: `the same load is picked twice: ${k}` };
    seen.add(k);
  }

  const cfg = await loadEngineConfig(tenant);
  const { meta, stops } = await readStops(tenant, date);
  if (!stops.length) {
    return { ok: false, status: 404, error: `no board data for ${date} — the scheduled scan has not written that day yet` };
  }
  const unplanned = stops.filter((s: any) => s?.isUnplanned === true);
  if (unplanned.length > CLEANUP_MAX_POOL) {
    return {
      ok: false, status: 400,
      error: `${unplanned.length} stops are unplanned on ${date} — that is a whole board, not leftovers. Check the date, or plan the main routes first.`,
    };
  }
  // STAMP THE MATCH KEY FIRST. loadPlanInputs builds its bounded per-customer
  // reads from s.customerMatchKey, and board rows never carry that field — it is
  // the whole reason liveStopToAssignStop computes it on the fly. Handing it raw
  // rows made wantKeys empty, so serviceDocByKey and habitDocByKey came back
  // EMPTY every time: every stop's dwell fell back to the flat 15-minute default
  // (so the shift-length term could not tell a 5-minute dock drop from a 45-minute
  // inside delivery) and customer habit was dead for the whole pool. Nothing
  // errored and the plan looked normal — the confident-wrong-answer class. The
  // draft path stamps these and says why; cleanup had simply omitted the line.
  const stamped = (stops || []).map((s: any) => ({ ...s, customerMatchKey: liveMatchKey(s) }));
  const inputs = await loadPlanInputs(tenant, date, stamped.filter((s: any) => s?.isUnplanned === true));
  return {
    ok: true,
    plan: buildCleanupPlan(tenant, date, {
      cfg, inputs, liveStops: stamped, meta, trucks, excludeStopNbrs,
      rules: fillMyLoadsBuildRules() ? 'build' : 'engine',
      tractorOnlyGreen: ruleOpts.tractorOnlyGreen === true,
      windowMode: ruleOpts.windowMode === 'strict' ? 'strict' : 'advisory',
    }),
  };
}
