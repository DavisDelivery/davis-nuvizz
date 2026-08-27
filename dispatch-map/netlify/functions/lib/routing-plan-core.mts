// lib/routing-plan-core.mts
//
// PHASE 2 — PLAN SCORING. For one board date, build the engine's DAY PLAN with
// the assignment solver, sequence each trip with the Phase 1 solver, and score
// the plan against what dispatch actually built with the SAME crew. Shadow only:
// writes plan_proposals / plan_proposals_daily; never touches live plan data.
//
//   plan_proposals/{tenant}__{date}
//     engine_version, computed_at, drivers, trips_engine, trips_actual,
//     stop_agreement_pct, coload_agreement_pct (+ coload_precision_pct),
//     est_travel_engine_min, est_travel_actual_min,
//     per_driver: [{driver, class, trips_engine, trips_actual, stops_engine,
//                   stops_actual, lbs_engine, lbs_actual, agreement_pct}...],
//     matched_load_sequence_score, unassigned_count, planned_stops
//   plan_proposals_daily/{tenant}__{date}  (mirrors Phase 1's daily doc shape)
//
// Leakage guard: the ENGINE's inputs (envelopes, affinity, service times, fleet
// chain) derive ONLY from dates strictly < D. The ANSWER KEY (what dispatch did
// on D) is date D itself — that is the target, not an input. ZERO NuVizz calls.

import { getDoc, setDoc, listDocs, runQuery } from './firestore.mts';
import { listStops } from './history-store.mts';
import { DEPOT, driverKeyFor } from './history-derive.mts';
import { ENGINE_VERSION, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';
import { zoneId, superOfZone, type ZonePrecisions } from './zones.mts';
import { loadVehicleRoster, vehicleTypeForStop, type VehicleRoster } from './tractor-flags.mts';
import { loadKeyForStop, dropUnexecuted, REFERENCE_ROUTES_COLLECTION, type ReferenceRouteDoc } from './routing-reference.mts';
import {
  DRIVER_DAYS_COLLECTION, extractDriverDays, type DriverDayDoc,
} from './routing-driver-days.mts';
import {
  SERVICE_TIMES_COLLECTION, serviceTimePath, fleetServicePath, serviceTimeAsOf,
} from './routing-service-times.mts';
import { customerDriversPath, habitAsOf } from './routing-customer-drivers.mts';
import {
  driverEnvelope, driverZoneAffinity, fleetTripChain, zoneOwnersAsOf,
  territoryMapsAsOf, candidateDriversFor,
} from './routing-envelope.mts';
import {
  solveAssignment, restrictionsBlockTractor, capsFor, type AssignStop, type AssignDriver, type AssignedShift,
} from './routing-assignment-solver.mts';
import {
  DEPOT_ID, buildTravelMatrix, solveRoute, travelMinutesForOrder, haversineMiles, type EngineStop,
} from './routing-engine-solver.mts';
import { scoreRoute, toScoreList } from './score.mts';

export const PLAN_PROPOSALS_COLLECTION = 'plan_proposals';
export const PLAN_PROPOSALS_DAILY_COLLECTION = 'plan_proposals_daily';
const TRACTOR_LOCATIONS_COLLECTION = 'tractor_locations';
const CUSTOMER_NOTES_COLLECTION = 'customer_notes';

// Labeled offline experiments (Phase 2.13) — collection + path shared by the
// writer (routing-engine-experiment-background) and the reader
// (routing-engine-data), one definition so a rename can't silently 404 the reader.
export const EXPERIMENTS_COLLECTION = 'engine_experiments';
export function experimentPath(tenant: string, label: string): string {
  return `${EXPERIMENTS_COLLECTION}/${tenant}__${label}`;
}

// Shared crew constants — used by the shadow (runPlanForDate) and the driver-scoped
// draft builder (routing-draft-core.mts); one definition so the two can never drift.
// Supervisors run occasional 1-3 stop days and are never a real route-driver pool.
export const SUPERVISOR_KEYS = new Set(['CHAD_DAVIS']);
// Fallback truck-class pin for drivers without an employees-roster record.
export const CLASS_OVERRIDE = new Map<string, string>([['JUNIOR_THOMAS', 'tractor']]);

export function planProposalPath(tenant: string, date: string): string {
  return `${PLAN_PROPOSALS_COLLECTION}/${tenant}__${date}`;
}
export function planDailyPath(tenant: string, date: string): string {
  return `${PLAN_PROPOSALS_DAILY_COLLECTION}/${tenant}__${date}`;
}

// ── replay resume cursor ─────────────────────────────────────────────────────
// Where the last history replay ran out of its time budget. A *-background
// function answers 202 with no body, so the caller cannot read stopped_at and
// cannot feed it back as ?from — without this the replay restarted at the oldest
// date on every tap and never reached the tail of the window.
export const PLAN_REPLAY_CURSOR_COLLECTION = 'plan_replay_cursor';
export function replayCursorPath(tenant: string): string {
  return `${PLAN_REPLAY_CURSOR_COLLECTION}/${tenant}`;
}

// ── per-ENGINE-VERSION progress rollup ───────────────────────────────────────
// A replay / nightly overwrites each plan_proposals_daily doc IN PLACE, so the
// prior engine version's day scores are lost the moment a newer version rescores
// them — which is why "is the engine getting better across versions?" was
// unmeasurable (the whole trend is always one version). This snapshots the
// window aggregate for ONE engine version into its OWN doc, keyed by version, so
// it is never clobbered by the next version — turning the flat single-version
// trend into a real cross-version series. Also carries the trips-delta and
// travel-delta (engine vs dispatch), so the over-split gap is tracked directly.
export const PLAN_VERSION_ROLLUPS_COLLECTION = 'plan_version_rollups';
export function planVersionRollupPath(tenant: string, version: string): string {
  return `${PLAN_VERSION_ROLLUPS_COLLECTION}/${tenant}__${version}`;
}

export interface PlanVersionRollup {
  tenant: string; engine_version: string;
  days_scored: number; planned_stops_total: number;
  window_from: string | null; window_to: string | null;
  stop_agreement_wmean: number | null;        // stop-weighted mean, %
  stop_agreement_known_wmean: number | null;   // known-envelope segment only
  coload_agreement_wmean: number | null;
  trips_engine_total: number; trips_actual_total: number; trips_delta_pct: number | null; // (eng−act)/act ×100 — the over-split signal
  travel_engine_total: number; travel_actual_total: number; travel_delta_pct: number | null;
  computed_at: string;
}

// Pure: fold every plan_proposals_daily doc for `version` into one rollup.
// STOP-WEIGHTED — a 2-stop skeleton day (e.g. a holiday's lone route scoring a
// trivial 100%) can't swing the mean the way a plain average would. Days with no
// score or zero planned stops are dropped.
export function summarizePlanVersion(dayDocs: any[], version: string, tenant = 'davis', nowIso?: string): PlanVersionRollup {
  const days = (dayDocs || []).filter((d) =>
    d && d.engine_version === version && d.stop_agreement_pct != null && Number(d.planned_stops) > 0);
  let wStop = 0, wCoload = 0, wColoadDen = 0, sw = 0, wKnown = 0, wKnownDen = 0;
  let te = 0, ta = 0, tre = 0, tra = 0, pst = 0;
  let from: string | null = null, to: string | null = null;
  for (const d of days) {
    const w = Number(d.planned_stops) || 0;
    sw += w; pst += w;
    wStop += (Number(d.stop_agreement_pct) || 0) * w;
    // Own denominator, like the known segment below — dividing by the full stop
    // weight would let a day with NO coload score drag the mean toward zero.
    if (d.coload_agreement_pct != null) { wCoload += (Number(d.coload_agreement_pct) || 0) * w; wColoadDen += w; }
    if (d.stop_agreement_known_pct != null) { wKnown += (Number(d.stop_agreement_known_pct) || 0) * w; wKnownDen += w; }
    te += Number(d.trips_engine) || 0; ta += Number(d.trips_actual) || 0;
    tre += Number(d.est_travel_engine_min) || 0; tra += Number(d.est_travel_actual_min) || 0;
    const dt = String(d.date || '');
    if (dt) { if (!from || dt < from) from = dt; if (!to || dt > to) to = dt; }
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const wmean = (num: number, den: number) => (den > 0 ? round1(num / den) : null);
  return {
    tenant, engine_version: version,
    days_scored: days.length, planned_stops_total: pst,
    window_from: from, window_to: to,
    stop_agreement_wmean: wmean(wStop, sw),
    stop_agreement_known_wmean: wmean(wKnown, wKnownDen),
    coload_agreement_wmean: wmean(wCoload, wColoadDen),
    trips_engine_total: te, trips_actual_total: ta,
    trips_delta_pct: ta > 0 ? round1(((te - ta) / ta) * 100) : null,
    travel_engine_total: Math.round(tre), travel_actual_total: Math.round(tra),
    travel_delta_pct: tra > 0 ? round1(((tre - tra) / tra) * 100) : null,
    computed_at: nowIso || new Date().toISOString(),
  };
}

function finiteNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
function routeEligible(s: any): boolean {
  return !!s && s.isPlanned === true && s.isTerminal !== true && s.isUnplanned !== true && s.isAttempt !== true;
}
function pct(n: number, d: number): number | null { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

// unordered pair key
function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// PURE: the set of stop pairs that share a container (load or trip). Exported so
// the agreement math is unit-testable, including the label-swap case.
export function coloadPairs(groups: Map<string, string[]>): Set<string> {
  const pairs = new Set<string>();
  for (const ids of groups.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.add(pairKey(ids[i], ids[j]));
  }
  return pairs;
}

// PURE: the two agreement families. stop_agreement is driver-CHOICE (did the
// engine give this stop to the same driver dispatch did?); coload_agreement is
// load-SHAPE and label-SYMMETRIC (of the stop pairs dispatch co-loaded, how many
// did the engine also co-load — independent of which driver). Reporting both
// decomposes a miss into "wrong shape" vs "wrong driver": a pure driver swap
// scores coload 100% but stop_agreement < 100%.
export function computePlanAgreement(
  stopToActualDriver: Map<string, string>, stopToEngineDriver: Map<string, string>,
  actualGroups: Map<string, string[]>, engineGroups: Map<string, string[]>,
): { stop_agreement_pct: number | null; coload_agreement_pct: number | null; coload_precision_pct: number | null } {
  let stopAgree = 0;
  for (const [id, drv] of stopToActualDriver) if (stopToEngineDriver.get(id) === drv) stopAgree++;
  const actualPairs = coloadPairs(actualGroups);
  const enginePairs = coloadPairs(engineGroups);
  let both = 0;
  for (const p of actualPairs) if (enginePairs.has(p)) both++;
  return {
    stop_agreement_pct: pct(stopAgree, stopToActualDriver.size),
    coload_agreement_pct: pct(both, actualPairs.size),   // recall over dispatch's co-loads
    coload_precision_pct: pct(both, enginePairs.size),   // precision over engine's co-loads
  };
}

// travel minutes for an ordered stop list (depot-anchored), Phase 1 estimator.
function travelForOrder(orderedStops: EngineStop[], depot: { lat: number; lng: number }, cfg: EngineConfig): number {
  if (!orderedStops.length) return 0;
  const matrix = buildTravelMatrix([{ id: DEPOT_ID, lat: depot.lat, lng: depot.lng }, ...orderedStops], cfg);
  return travelMinutesForOrder(orderedStops, matrix);
}

export interface PlanInputs {
  driverDaysBefore: DriverDayDoc[];    // < D
  referencesBefore: ReferenceRouteDoc[]; // < D
  serviceDocByKey: Map<string, any>;   // customer service-time docs (obs dated)
  fleetServiceDoc: any | null;
  habitDocByKey: Map<string, any>;     // customer driver-habit docs (obs dated; habitAsOf applies < D)
  notesRestrictions: Map<string, any[]>; // matchKey → equipment_restrictions
  // matchKey → the WHOLE customer note doc. Optional so the many fixtures that
  // build a PlanInputs by hand keep compiling; a caller that needs receiving
  // hours or closed days must handle its absence rather than assume them open.
  noteByKey?: Map<string, any>;
  tractorCapable: Set<string>;         // matchKey → served by a tractor before (positive; carried, not a restriction)
  employees?: any[];                   // MarginIQ employees roster (vehicleType source); absent → class fallbacks
}

// Phase 2.9 — PURE: employees roster → driver_key → truck class. Joined on the
// same fold the engine keys everything by (NuVizz alias, else fullName,
// else first+last; explicit aliases too), so Chad's MarginIQ Vehicle Type edits
// flow straight into class gating and the per-class skid caps.
export function employeeClassMap(employees: any[]): Map<string, string> {
  const fold = (s: any) => String(s || '').trim().toUpperCase().replace(/\s+/g, '_');
  const out = new Map<string, string>();
  for (const e of employees || []) {
    const vt = String(e?.vehicleType || '').toLowerCase();
    if (vt !== 'tractor' && vt !== 'box_truck') continue;
    const names = new Set<string>([
      (e?.externalIds || {})?.nuvizz, e?.fullName,
      `${e?.firstName || ''} ${e?.lastName || ''}`.trim(),
      ...(Array.isArray(e?.aliases) ? e.aliases : []),
    ].filter(Boolean).map(fold));
    for (const k of names) if (k && !out.has(k)) out.set(k, vt);
  }
  return out;
}

// ── the ONE live/warehouse stop → AssignStop mapping ─────────────────────────
//
// Four rules live here and ONLY here, because each was learned the hard way and
// a second copy would drift silently:
//   • NuVizz MISLABELS its freight columns — "pallets" is TOTAL pieces, "cartons"
//     is the real skid count, "volume" is loose pieces. The solver's caps are in
//     skid positions, so reading the wrong column mis-sizes every truck.
//   • MILES IS DISTANCE FROM THE DEPOT, computed here — never the vendor's
//     stopDistance, which is the LEG distance from the previous stop. That field
//     silently disarmed every far/territory rule (a Dalton stop reads 3 mi from
//     the last Dalton stop, not 60 from Buford).
//   • Number(null) is 0 and 0 is FINITE, so a coordinate-less stop must be
//     rejected on the raw value, not on the coerced one, or it becomes a real
//     place in the Gulf of Guinea.
//   • blocksTractor comes from customer_notes equipment restrictions, keyed by
//     matchKey — a stop with no usable customer identity blocks nothing.
//
// The CALLER resolves matchKey, because that is the one thing that genuinely
// differs by source: warehouse rows carry customerMatchKey, live board rows do
// not and must have it computed.
// The coordinate test toAssignStop applies, exposed so a caller can filter with
// the SAME rule it maps with. Without this the two drift: `finiteNum(0)` is 0 and
// `0 != null`, so a null-island row passed the nightly's finite-coord filter,
// reached the mapper, came back null, and the next line dereferenced it. That
// crash took out the whole date, and on the replay path it escaped before the
// cursor-park block, so every retry restarted on the same row forever.
export function hasUsableCoords(raw: any): boolean {
  const rawLat = raw?.lat, rawLng = raw?.lng;
  if (rawLat == null || rawLat === '' || rawLng == null || rawLng === '') return false;
  const lat = Number(rawLat), lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function toAssignStop(
  raw: any,
  opts: {
    id: string; matchKey: string | null; cfg: EngineConfig; precisions: ZonePrecisions;
    habitDocByKey: Map<string, any>; notesRestrictions: Map<string, any[]>; date: string;
    // LIVE-BOARD paths pass 1. A board row whose freight columns are all zero —
    // an order the once-per-PRO enrichment has not reached yet — otherwise costs
    // NOTHING against the skid cap (stopSkidEquiv falls through to pallets, which
    // is also 0), so an unbounded number of them ride one truck and every
    // capacity number on screen is a lie. Counting each as one position is the
    // conservative read; the warehouse rows the nightly scores are already
    // populated, so it stays off there and the shadow is unchanged.
    freightFloorSkids?: number;
  },
): AssignStop | null {
  // (0,0) is NULL ISLAND in the Gulf of Guinea, not a delivery — it is what a
  // failed geocode leaves behind, and Number(null)/Number('') already coerce to
  // it. A stop that reads 0,0 is 5,800 miles from the depot: it would dominate
  // every far/deadhead term and get sequenced onto a real truck. Out-of-range
  // pairs are the same class of bad data. One predicate, so a caller that
  // filters and this function that maps can never disagree about what is usable.
  if (!hasUsableCoords(raw)) return null;
  const lat = Number(raw.lat), lng = Number(raw.lng);
  const mk = opts.matchKey;
  const zone = zoneId(lat, lng, opts.precisions);
  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return {
    id: opts.id, lat, lng,
    zone, gh5: superOfZone(zone, opts.precisions),
    ...(() => {
      const pallets = num(raw?.pallets), skids = num(raw?.cartons), loose = num(raw?.volume);
      const floor = Number(opts.freightFloorSkids) || 0;
      const unknown = pallets <= 0 && skids <= 0 && loose <= 0;
      return {
        pallets: unknown && floor > 0 ? floor : pallets,  // TOTAL pieces (NuVizz mislabel)
        skids,                                            // real skid positions (NuVizz "cartons")
        loose,                                            // real loose pieces (NuVizz "volume")
        freight_unknown: unknown,
      };
    })(),
    weight: num(raw?.weight),
    matchKey: mk,
    strict: String(raw?.timeConstraint || '').toUpperCase() === 'STRICT',
    miles: haversineMiles(DEPOT.lat, DEPOT.lng, lat, lng),
    blocksTractor: mk ? restrictionsBlockTractor(opts.notesRestrictions.get(mk) || []) : false,
    habit: mk ? habitAsOf(opts.habitDocByKey.get(mk) ?? null, opts.date) : null,
    candidates: undefined,   // stamped by the caller that knows the roster
  };
}

export interface PlanDaySummary {
  ok: boolean; tenant: string; date: string; skipped_existing?: boolean;
  drivers: number; trips_engine: number; trips_actual: number;
  planned_stops: number; unassigned_count: number;
  stop_agreement_pct: number | null; coload_agreement_pct: number | null; coload_precision_pct: number | null;
  stop_agreement_known_pct: number | null; stop_agreement_fallback_pct: number | null;
  candidate_containment_pct: number | null;
  est_travel_engine_min: number | null; est_travel_actual_min: number | null;
  matched_load_sequence_score: number | null;
  tie_margin: any | null;   // Phase 2.13 diagnostic (see TieMarginSummary)
  ms: number;
}

// PURE-ish core (I/O only for the loaders it calls when inputs aren't preloaded).
// opts.writeResults: false = DRY RUN — solve and score but write NOTHING (the
// experiment harness's mode; the stored trend never learns a sweep happened).
export async function runPlanForDate(
  tenant: string, date: string,
  opts: { cfg?: EngineConfig; force?: boolean; inputs?: PlanInputs; writeResults?: boolean } = {},
): Promise<PlanDaySummary> {
  const t0 = Date.now();
  const cfg = opts.cfg || await loadEngineConfig(tenant);
  const precisions: ZonePrecisions = { zone_precision: cfg.zone_precision, super_precision: cfg.super_precision, top_precision: cfg.top_precision };

  if (!opts.force) {
    const existing = await getDoc(planDailyPath(tenant, date));
    if (existing && existing.engine_version === ENGINE_VERSION) {
      return {
        ok: true, tenant, date, skipped_existing: true,
        drivers: existing.drivers ?? 0, trips_engine: existing.trips_engine ?? 0, trips_actual: existing.trips_actual ?? 0,
        planned_stops: existing.planned_stops ?? 0, unassigned_count: existing.unassigned_count ?? 0,
        stop_agreement_pct: existing.stop_agreement_pct ?? null, coload_agreement_pct: existing.coload_agreement_pct ?? null,
        coload_precision_pct: existing.coload_precision_pct ?? null,
        stop_agreement_known_pct: existing.stop_agreement_known_pct ?? null,
        stop_agreement_fallback_pct: existing.stop_agreement_fallback_pct ?? null,
        candidate_containment_pct: existing.candidate_containment_pct ?? null,
        est_travel_engine_min: existing.est_travel_engine_min ?? null, est_travel_actual_min: existing.est_travel_actual_min ?? null,
        matched_load_sequence_score: existing.matched_load_sequence_score ?? null,
        tie_margin: existing.tie_margin ?? null, ms: Date.now() - t0,
      };
    }
  }

  const rawDateStops = await listStops(tenant, date);
  // Execution-evidence gate: the warehouse day is a board snapshot, and a board can hold
  // freight that never ran that day — most plainly the NEXT day's routes, pre-built in the
  // evening from Estes imports that carry no Estimated Arrival and so file on TODAY. On
  // 2026-07-28 that charged Leroy Smith/Marcus Crumpton with 19-21 stops when their loads
  // closed at 14/13 in NuVizz (delivered rows matched NuVizz to the pound; every extra row
  // was an un-stamped SCHEDULED order that delivered the NEXT day). Both the answer key AND
  // the engine's input pool are gated, so the replay assigns the freight the day really ran.
  const { stops: dateStops, excluded: unexecuted_excluded, applied: executedGateApplied } =
    dropUnexecuted(rawDateStops || [], date);
  if (unexecuted_excluded) console.log(`[plan] ${date}: execution gate excluded ${unexecuted_excluded} planned-but-unstamped row(s) (pre-built next-day freight / stale plans)`);
  if (!executedGateApplied) console.warn(`[plan] ${date}: execution gate NOT applied — under half the eligible rows carry a same-day delivery stamp; replaying the board as stored`);
  let roster: VehicleRoster | null = null;
  try { roster = await loadVehicleRoster(); } catch (e: any) { console.error('[plan] roster load failed:', e?.message); }
  const truckClassOf = (s: any) => (roster ? vehicleTypeForStop(s, roster) : null);

  // ── the ANSWER KEY: what dispatch did on D (all eligible planned stops) ──
  // hasUsableCoords, not a finite check: finiteNum(0) is 0 and 0 != null, so a
  // null-island row used to pass here and then come back null from the mapper.
  // These rows were never a real place — the old inline mapping handed the solver
  // a "delivery" 5,800 miles out — so they leave the answer key too, and the
  // count is reported rather than silently changing the agreement denominator.
  const planned = (dateStops || []).filter((s) => routeEligible(s) && loadKeyForStop(s) && hasUsableCoords(s));
  const droppedNoCoords = (dateStops || []).filter((s) => routeEligible(s) && loadKeyForStop(s) && !hasUsableCoords(s)).length;
  if (droppedNoCoords) console.warn(`[plan] ${date}: ${droppedNoCoords} planned row(s) have no usable coordinates — excluded from the answer key`);
  const stopId = (s: any) => String(s.stopNbr);
  const rawById = new Map(planned.map((s) => [stopId(s), s] as const));

  const stopToActualDriver = new Map<string, string>();
  const actualLoadGroups = new Map<string, string[]>();       // loadKey → stopIds (co-load)
  const actualLoadOrdered = new Map<string, { driverKey: string; ids: string[] }>();
  for (const s of planned) {
    const id = stopId(s);
    stopToActualDriver.set(id, driverKeyFor(s));
    const lk = loadKeyForStop(s)!;
    (actualLoadGroups.get(lk) ?? actualLoadGroups.set(lk, []).get(lk)!).push(id);
  }
  // Actual delivery position per stop (1-based within its load, in true driven
  // order) — lets the map draw the dispatch route in real sequence and number the
  // pins, instead of the warehouse-document order the diff view used to zig-zag by.
  const stopToActualPos = new Map<string, number>();
  for (const [lk, ids] of actualLoadGroups) {
    const ordered = [...ids].sort((a, b) => {
      const ra = finiteNum(rawById.get(a)?.routeSeq), rb = finiteNum(rawById.get(b)?.routeSeq);
      if (ra != null && rb != null && ra !== rb) return ra - rb;
      const ea = String(rawById.get(a)?.deliveredDTTM ?? rawById.get(a)?.plannedEtaDTTM ?? '');
      const eb = String(rawById.get(b)?.deliveredDTTM ?? rawById.get(b)?.plannedEtaDTTM ?? '');
      return ea < eb ? -1 : ea > eb ? 1 : a.localeCompare(b);
    });
    ordered.forEach((id, i) => stopToActualPos.set(id, i + 1));
    actualLoadOrdered.set(lk, { driverKey: driverKeyFor(rawById.get(ids[0])), ids: ordered });
  }

  // ── the crew (staffing = dispatch's INPUT): active drivers + start times ──
  const actualDriverDays = extractDriverDays(dateStops, { tenant, date, truckClassOf });
  // DriverTrip.stops is a COUNT (a number), not an array — `.length` on it is
  // undefined, which silently filtered out EVERY trip and reported trips_actual=0
  // on all scored days. Filter on the count itself.
  const trips_actual = actualDriverDays.reduce((a, d) => a + d.trips.filter((t) => t.stops > 0).length, 0);

  // ── as-of inputs (< D only) ──
  const inputs = opts.inputs || await loadPlanInputs(tenant, date, planned);

  // Phase 2.7 hygiene: supervisors run occasional 1-3 stop days — they are not a
  // real route-driver pool, so exclude them (they never become a zone candidate or
  // a dumping ground; their own stops still route to real candidate drivers).
  // Phase 2.9: truck class comes from the MarginIQ employees roster
  // (vehicleType) — the source Chad actually maintains — joined through the
  // NuVizz alias/fullName fold. The hardcoded pin stays only as a fallback for
  // drivers without an employees record; unknown/blank still reads box_truck
  // (the fleet majority). Class gates tractor-blocked stops + per-class skid caps.
  const empClass = employeeClassMap(inputs.employees || []);
  const resolveClass = (key: string, raw: string | null) =>
    empClass.get(key) || CLASS_OVERRIDE.get(key) || (raw === 'tractor' ? 'tractor' : 'box_truck');

  const activeDrivers: AssignDriver[] = actualDriverDays
    .filter((dd) => !SUPERVISOR_KEYS.has(dd.driver_key))
    .map((dd) => {
    const envelope = driverEnvelope(dd.driver_key, inputs.driverDaysBefore, date, cfg);
    return {
      driver_key: dd.driver_key,
      driver_user_name: dd.driver_user_name,
      driver_name: dd.driver_name,
      truck_class: resolveClass(dd.driver_key, dd.truck_class),
      // AS-OF START (Phase 2.1, audit finding 3): the shadow must only use what
      // Assist would know at PLANNING time. The driver's executed first touch
      // on day D is settlement data — a driver who happened to clock in early
      // would leak that knowledge into the STRICT-window cost. Use the as-of
      // TYPICAL start mined from days < D instead; a driver below
      // min_observation_days inherits the class-level typical via the envelope
      // fallback, and the solver's own default covers a fully unknown driver.
      // (WHO worked D is still the declared staffing input; WHEN they actually
      // clocked in is not.)
      start_minute: envelope.start_minute_typical,
      envelope,
      affinity: driverZoneAffinity(dd.driver_user_name, inputs.referencesBefore, date, precisions),
    };
  });

  // Phase 2.7: today's roster + the trailing zone/area ownership maps → per-stop
  // candidate driver sets. Territory is built ONCE from references < D.
  const rosterKeys = new Set(activeDrivers.map((d) => d.driver_key));
  const territory = territoryMapsAsOf(inputs.referencesBefore, date, cfg.territory_half_life_days);

  // ── the engine's planned stop set ──
  const assignStops: AssignStop[] = planned.map((s) => {
    // ONE mapping, shared with the live-board paths (see toAssignStop above) —
    // warehouse rows already carry customerMatchKey. `planned` is filtered by
    // hasUsableCoords, the SAME predicate toAssignStop rejects on, so the null
    // branch really is unreachable here and the assertion keeps the type honest.
    const mapped = toAssignStop(s, {
      id: stopId(s), matchKey: s.customerMatchKey ?? null, cfg, precisions,
      habitDocByKey: inputs.habitDocByKey, notesRestrictions: inputs.notesRestrictions, date,
    })!;
    // Habit driver → the same driver_key form the roster + territory maps use.
    const habitKey = mapped.habit?.topDriver ? String(mapped.habit.topDriver).toUpperCase().replace(/\s+/g, '_') : null;
    return {
      ...mapped,
      // Phase 2.7: allowed drivers — this stop's zone trailing top-5 ∪ habit ∪ the
      // coarser 0.2° area (cold-zone fallback), roster-filtered. Empty ⇒ unseen
      // geography, and the solver falls back to any feasible driver.
      candidates: candidateDriversFor(mapped.lat, mapped.lng, habitKey, territory, rosterKeys,
        { zoneK: cfg.candidate_zone_k, areaK: cfg.candidate_area_k }),
    };
  });

  const fleet = fleetTripChain(inputs.driverDaysBefore, date, cfg);
  const svcMedianCache = new Map<string, number>();
  const serviceMedianFor = (s: AssignStop): number => {
    const key = `${s.matchKey}__${s.pallets}`;
    let v = svcMedianCache.get(key);
    if (v == null) {
      const doc = s.matchKey ? inputs.serviceDocByKey.get(s.matchKey) : null;
      v = serviceTimeAsOf(doc, inputs.fleetServiceDoc, s.pallets, date, cfg).median_min;
      svcMedianCache.set(key, v);
    }
    return v;
  };

  const result = solveAssignment({
    date, stops: assignStops, drivers: activeDrivers, fleetChain: fleet, cfg,
    depot: { lat: DEPOT.lat, lng: DEPOT.lng }, serviceMedianFor,
    // Phase 2.3: learned territory owners per top zone, strictly < D.
    zoneOwners: zoneOwnersAsOf(inputs.referencesBefore, date, precisions, cfg),
  });

  // ── sequence engine trips + build engine co-load / driver maps ──
  const stopToEngineDriver = new Map<string, string>();
  const engineTripGroups = new Map<string, string[]>();   // tripKey → stopIds (co-load)
  const engineTrips: Array<{ driverKey: string; seq: number; orderedIds: string[]; travelMin: number }> = [];
  let est_travel_engine = 0;
  const assignById = new Map(assignStops.map((s) => [s.id, s] as const));
  for (const sh of result.shifts) {
    sh.trips.forEach((trip, ti) => {
      const tripKey = `${sh.driver.driver_key}__${ti + 1}`;
      const ids = trip.stops.map((s) => s.id);
      engineTripGroups.set(tripKey, ids);
      for (const id of ids) stopToEngineDriver.set(id, sh.driver.driver_key);
      const engineStops: EngineStop[] = trip.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, zone: s.zone }));
      const solved = solveRoute({ loadKey: tripKey, stops: engineStops, depot: { lat: DEPOT.lat, lng: DEPOT.lng }, referenceZoneSeq: null, cfg });
      est_travel_engine += solved.travelMin;
      engineTrips.push({ driverKey: sh.driver.driver_key, seq: ti + 1, orderedIds: solved.order.map((o) => o.id), travelMin: solved.travelMin });
    });
  }

  // ── actual travel estimate (actual load order) ──
  let est_travel_actual = 0;
  for (const { ids } of actualLoadOrdered.values()) {
    const ordered: EngineStop[] = ids.map((id) => { const s = assignById.get(id)!; return { id, lat: s.lat, lng: s.lng, zone: s.zone }; }).filter((s) => s);
    est_travel_actual += travelForOrder(ordered, { lat: DEPOT.lat, lng: DEPOT.lng }, cfg);
  }

  // ── agreement metrics (pure, tested incl. the label-swap case) ──
  const agreement = computePlanAgreement(stopToActualDriver, stopToEngineDriver, actualLoadGroups, engineTripGroups);

  // Phase 2.7 diagnostic — candidate CONTAINMENT: share of stops whose ACTUAL driver
  // is reachable (in the stop's candidate set, or the set is open). It is the CEILING
  // on agreement: high containment + low agreement ⇒ the search is failing within
  // candidates; low containment ⇒ the candidate sets are too tight.
  const candById = new Map(assignStops.map((s) => [s.id, s.candidates] as const));
  let reachable = 0, containDenom = 0;
  for (const [id, actual] of stopToActualDriver) {
    if (!actual) continue;
    containDenom++;
    const c = candById.get(id);
    if (!c || c.length === 0 || c.includes(actual)) reachable++;
  }
  const candidate_containment_pct = containDenom ? Math.round((reachable / containDenom) * 1000) / 10 : null;

  // ── per-driver breakdown ──
  const perDriver: any[] = [];
  const engineByDriver = new Map<string, { trips: number; stops: number; lbs: number }>();
  for (const sh of result.shifts) {
    let stopsN = 0, lbs = 0;
    for (const t of sh.trips) for (const s of t.stops) { stopsN++; lbs += s.weight; }
    engineByDriver.set(sh.driver.driver_key, { trips: sh.trips.length, stops: stopsN, lbs: Math.round(lbs) });
  }
  // Segmentation (audit finding 4, plan-view analog of guided/unguided): a
  // driver whose envelope came from their OWN history ('driver') is one the
  // engine actually knows; a 'class'/'none' fallback driver is being guessed
  // at. Report agreement per segment so guesses never dilute the headline.
  const envSourceByKey = new Map(activeDrivers.map((d) => [d.driver_key, d.envelope.source] as const));
  // Phase 2.12 — the skid cap the solver actually used for each driver, reported
  // so a dispatcher can SEE which trucks the engine thinks take 17-18 and which
  // are 12-15 instead of inferring it from the plan. `learned` false means this
  // driver had no per-trip skid history and fell back to the class number.
  const capsByKey = new Map(activeDrivers.map((d) => [d.driver_key, capsFor(d, cfg)] as const));
  let knownAgree = 0, knownTotal = 0, fallbackAgree = 0, fallbackTotal = 0;
  for (const dd of actualDriverDays) {
    const actualStops = [...stopToActualDriver.entries()].filter(([, drv]) => drv === dd.driver_key).map(([id]) => id);
    const agree = actualStops.filter((id) => stopToEngineDriver.get(id) === dd.driver_key).length;
    const eng = engineByDriver.get(dd.driver_key) || { trips: 0, stops: 0, lbs: 0 };
    const envelopeSource = envSourceByKey.get(dd.driver_key) ?? 'none';
    if (envelopeSource === 'driver') { knownAgree += agree; knownTotal += actualStops.length; }
    else { fallbackAgree += agree; fallbackTotal += actualStops.length; }
    perDriver.push({
      driver: dd.driver_name || dd.driver_user_name || dd.driver_key,
      driver_key: dd.driver_key,
      class: dd.truck_class,
      envelope_source: envelopeSource,
      skid_cap: Math.round((capsByKey.get(dd.driver_key)?.hard ?? 0) * 10) / 10 || null,
      skid_cap_learned: capsByKey.get(dd.driver_key)?.learned ?? false,
      trips_engine: eng.trips, trips_actual: dd.trips.filter((t) => t.stops > 0).length,
      stops_engine: eng.stops, stops_actual: actualStops.length,
      // lbs over the SAME stop set the stop count uses (coord-filtered, deduped by stopNbr).
      // day_totals.weight was summed over a different, wider set — no coord filter, no dedup —
      // so the two columns never described the same freight (a coordless or duplicate row
      // added pounds but no stop). One row set, both numbers.
      lbs_engine: eng.lbs, lbs_actual: Math.round(actualStops.reduce((a, id) => a + (finiteNum(rawById.get(id)?.weight) || 0), 0)),
      agreement_pct: pct(agree, actualStops.length),
    });
  }

  // ── matched-load sequence score (engine trips overlapping an actual load ≥60%) ──
  const seqScores: number[] = [];
  for (const et of engineTrips) {
    const etSet = new Set(et.orderedIds);
    let bestLk: string | null = null, bestOv = 0;
    for (const [lk, g] of actualLoadOrdered) {
      const ov = g.ids.filter((id) => etSet.has(id)).length;
      if (ov > bestOv) { bestOv = ov; bestLk = lk; }
    }
    if (!bestLk || bestOv / et.orderedIds.length < 0.6) continue;
    const shared = new Set(actualLoadOrdered.get(bestLk)!.ids.filter((id) => etSet.has(id)));
    if (shared.size < 2) continue;
    const actualSeq = actualLoadOrdered.get(bestLk)!.ids.filter((id) => shared.has(id));
    const engineSeq = et.orderedIds.filter((id) => shared.has(id));
    const pts: EngineStop[] = [...shared].map((id) => { const s = assignById.get(id)!; return { id, lat: s.lat, lng: s.lng, zone: s.zone }; });
    const matrix = buildTravelMatrix([{ id: DEPOT_ID, lat: DEPOT.lat, lng: DEPOT.lng }, ...pts], cfg);
    seqScores.push(scoreRoute(toScoreList(DEPOT_ID, actualSeq), toScoreList(DEPOT_ID, engineSeq), matrix));
  }
  const matchedSeqScore = seqScores.length ? Math.round((seqScores.reduce((a, b) => a + b, 0) / seqScores.length) * 10000) / 10000 : null;

  const trips_engine = engineTrips.length;
  const nowIso = new Date().toISOString();
  const proposal = {
    tenant, date, engine_version: ENGINE_VERSION, computed_at: nowIso,
    drivers: activeDrivers.length,
    trips_engine, trips_actual,
    planned_stops: planned.length,
    // Observability for the execution gate: how many board rows this replay refused to count
    // as day-D work (0 with the gate un-applied — see the log line at listStops).
    unexecuted_excluded,
    unassigned_count: result.unassigned.length,
    stop_agreement_pct: agreement.stop_agreement_pct,
    coload_agreement_pct: agreement.coload_agreement_pct,
    coload_precision_pct: agreement.coload_precision_pct,
    stop_agreement_known_pct: pct(knownAgree, knownTotal),      // drivers w/ own-history envelopes
    stop_agreement_fallback_pct: pct(fallbackAgree, fallbackTotal), // class/none fallback drivers
    candidate_containment_pct,                                  // Phase 2.7: ceiling on agreement (actual driver reachable)
    est_travel_engine_min: Math.round(est_travel_engine * 10) / 10,
    est_travel_actual_min: Math.round(est_travel_actual * 10) / 10,
    matched_load_sequence_score: matchedSeqScore,
    per_driver: perDriver.sort((a, b) => (b.stops_actual - a.stops_actual)),
    stops: assignStops.map((s) => ({
      id: s.id, businessName: rawById.get(s.id)?.businessName ?? null, lat: s.lat, lng: s.lng,
      actual_driver: stopToActualDriver.get(s.id) ?? null,
      engine_driver: stopToEngineDriver.get(s.id) ?? null,
      actual_pos: stopToActualPos.get(s.id) ?? null,   // dispatch delivery order (for map sequencing + pin numbers)
      // WHICH actual trip the stop was on. actual_pos restarts at 1 per LOAD, so a driver
      // running two trips has two stops at position 1, two at position 2, and so on. The diff
      // map grouped a driver's stops into ONE line and sorted them by that position, which
      // interleaved the two trips and drew a line shuttling between them across the metro —
      // the grey bands Chad asked about. The engine side already draws one line per trip
      // (engine_trips); dispatch needs the same key to do it. Old stored plans have no
      // actual_trip and the map falls back to per-driver, so this heals as plans recompute.
      actual_trip: loadKeyForStop(rawById.get(s.id)) ?? null,
    })),
    engine_trips: engineTrips.map((t) => ({ driver_key: t.driverKey, seq: t.seq, stop_ids: t.orderedIds, travel_min: Math.round(t.travelMin * 10) / 10 })),
    fleet_chain: { far_first_rate: fleet.far_first_rate, reload_gap_median_min: fleet.reload_gap_median_min, source: fleet.source },
    // Phase 2.13 — seed-score gap between the best and runner-up candidate per
    // stop. share_lt_05 is the share of stops where dispatch's choice was a
    // genuine coin flip — the part of the containment-vs-agreement gap NO
    // solver can close, which is the honest denominator for the Assist gate.
    tie_margin: result.tie_margin,
  };
  // DRY RUN (the experiment harness): solve + score, write nothing — a sweep
  // must never overwrite the nightly trend or the version rollups.
  if (opts.writeResults !== false) {
    await setDoc(planProposalPath(tenant, date), proposal);
    await setDoc(planDailyPath(tenant, date), {
      tenant, date, engine_version: ENGINE_VERSION, computed_at: nowIso,
      drivers: activeDrivers.length, trips_engine, trips_actual, planned_stops: planned.length,
      unassigned_count: result.unassigned.length,
      stop_agreement_pct: proposal.stop_agreement_pct, coload_agreement_pct: proposal.coload_agreement_pct,
      coload_precision_pct: proposal.coload_precision_pct,
      stop_agreement_known_pct: proposal.stop_agreement_known_pct,
      stop_agreement_fallback_pct: proposal.stop_agreement_fallback_pct,
      candidate_containment_pct: proposal.candidate_containment_pct,
      est_travel_engine_min: proposal.est_travel_engine_min, est_travel_actual_min: proposal.est_travel_actual_min,
      matched_load_sequence_score: matchedSeqScore,
      tie_margin: result.tie_margin,
    });
  }

  return {
    ok: true, tenant, date,
    drivers: activeDrivers.length, trips_engine, trips_actual,
    planned_stops: planned.length, unassigned_count: result.unassigned.length,
    stop_agreement_pct: proposal.stop_agreement_pct, coload_agreement_pct: proposal.coload_agreement_pct,
    coload_precision_pct: proposal.coload_precision_pct,
    stop_agreement_known_pct: proposal.stop_agreement_known_pct,
    stop_agreement_fallback_pct: proposal.stop_agreement_fallback_pct,
    candidate_containment_pct: proposal.candidate_containment_pct,
    est_travel_engine_min: proposal.est_travel_engine_min, est_travel_actual_min: proposal.est_travel_actual_min,
    matched_load_sequence_score: matchedSeqScore,
    tie_margin: result.tie_margin, ms: Date.now() - t0,
  };
}

// Load the as-of inputs for one date (< D where the guard applies). The replay
// preloads these once and passes them in.
export async function loadPlanInputs(tenant: string, date: string, plannedStops: any[]): Promise<PlanInputs> {
  const [ddRows, refRows, fleetDoc, notesRows, tractorRows, employees] = await Promise.all([
    runQuery({ from: [{ collectionId: DRIVER_DAYS_COLLECTION }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN', value: { stringValue: date } } } }),
    runQuery({ from: [{ collectionId: REFERENCE_ROUTES_COLLECTION }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN', value: { stringValue: date } } } }),
    getDoc(fleetServicePath(tenant)),
    listDocs(CUSTOMER_NOTES_COLLECTION),
    listDocs(TRACTOR_LOCATIONS_COLLECTION),
    listDocs('employees').catch(() => [] as any[]),  // roster absent → class fallbacks
  ]);
  const driverDaysBefore = (ddRows as any[]).filter((r) => r?.tenant === tenant) as DriverDayDoc[];
  const referencesBefore = (refRows as any[]).filter((r) => r?.tenant === tenant) as ReferenceRouteDoc[];

  const notesRestrictions = new Map<string, any[]>();
  // The WHOLE note doc, kept alongside the equipment slice. notesRows is already
  // in memory — this is zero extra reads — and it is what lets a caller ask the
  // two questions equipment_restrictions cannot answer: is this dock closed
  // today, and when does it shut.
  const noteByKey = new Map<string, any>();
  for (const n of notesRows) {
    const mk = n?.match_key || n?._id;
    if (mk) {
      notesRestrictions.set(String(mk), n?.equipment_restrictions || []);
      noteByKey.set(String(mk), n);
    }
  }
  const tractorCapable = new Set<string>();
  for (const t of tractorRows) { const mk = t?.match_key || t?._id; if (mk) tractorCapable.add(String(mk)); }

  // customer service-time + driver-habit docs only for the matchKeys present
  // that day (bounded reads)
  const wantKeys = [...new Set(plannedStops.map((s) => s?.customerMatchKey).filter(Boolean))] as string[];
  const serviceDocByKey = new Map<string, any>();
  const habitDocByKey = new Map<string, any>();
  let i = 0;
  const worker = async () => {
    while (i < wantKeys.length) {
      const mk = wantKeys[i++];
      const [svc, habit] = await Promise.all([
        getDoc(serviceTimePath(tenant, mk)),
        getDoc(customerDriversPath(tenant, mk)),
      ]);
      if (svc) serviceDocByKey.set(mk, svc);
      if (habit) habitDocByKey.set(mk, habit);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, wantKeys.length || 1) }, worker));

  return { driverDaysBefore, referencesBefore, serviceDocByKey, fleetServiceDoc: fleetDoc, habitDocByKey, notesRestrictions, noteByKey, tractorCapable, employees };
}
