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
import { loadKeyForStop, REFERENCE_ROUTES_COLLECTION, type ReferenceRouteDoc } from './routing-reference.mts';
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
  solveAssignment, restrictionsBlockTractor, type AssignStop, type AssignDriver, type AssignedShift,
} from './routing-assignment-solver.mts';
import {
  DEPOT_ID, buildTravelMatrix, solveRoute, travelMinutesForOrder, haversineMiles, type EngineStop,
} from './routing-engine-solver.mts';
import { scoreRoute, toScoreList } from './score.mts';

export const PLAN_PROPOSALS_COLLECTION = 'plan_proposals';
export const PLAN_PROPOSALS_DAILY_COLLECTION = 'plan_proposals_daily';
const TRACTOR_LOCATIONS_COLLECTION = 'tractor_locations';
const CUSTOMER_NOTES_COLLECTION = 'customer_notes';

export function planProposalPath(tenant: string, date: string): string {
  return `${PLAN_PROPOSALS_COLLECTION}/${tenant}__${date}`;
}
export function planDailyPath(tenant: string, date: string): string {
  return `${PLAN_PROPOSALS_DAILY_COLLECTION}/${tenant}__${date}`;
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
  let wStop = 0, wCoload = 0, sw = 0, wKnown = 0, wKnownDen = 0;
  let te = 0, ta = 0, tre = 0, tra = 0, pst = 0;
  let from: string | null = null, to: string | null = null;
  for (const d of days) {
    const w = Number(d.planned_stops) || 0;
    sw += w; pst += w;
    wStop += (Number(d.stop_agreement_pct) || 0) * w;
    if (d.coload_agreement_pct != null) wCoload += (Number(d.coload_agreement_pct) || 0) * w;
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
    coload_agreement_wmean: wmean(wCoload, sw),
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

export interface PlanDaySummary {
  ok: boolean; tenant: string; date: string; skipped_existing?: boolean;
  drivers: number; trips_engine: number; trips_actual: number;
  planned_stops: number; unassigned_count: number;
  stop_agreement_pct: number | null; coload_agreement_pct: number | null; coload_precision_pct: number | null;
  est_travel_engine_min: number | null; est_travel_actual_min: number | null;
  matched_load_sequence_score: number | null;
  ms: number;
}

// PURE-ish core (I/O only for the loaders it calls when inputs aren't preloaded).
export async function runPlanForDate(
  tenant: string, date: string,
  opts: { cfg?: EngineConfig; force?: boolean; inputs?: PlanInputs } = {},
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
        est_travel_engine_min: existing.est_travel_engine_min ?? null, est_travel_actual_min: existing.est_travel_actual_min ?? null,
        matched_load_sequence_score: existing.matched_load_sequence_score ?? null, ms: Date.now() - t0,
      };
    }
  }

  const dateStops = await listStops(tenant, date);
  let roster: VehicleRoster | null = null;
  try { roster = await loadVehicleRoster(); } catch (e: any) { console.error('[plan] roster load failed:', e?.message); }
  const truckClassOf = (s: any) => (roster ? vehicleTypeForStop(s, roster) : null);

  // ── the ANSWER KEY: what dispatch did on D (all eligible planned stops) ──
  const planned = (dateStops || []).filter((s) => routeEligible(s) && loadKeyForStop(s) && finiteNum(s.lat) != null && finiteNum(s.lng) != null);
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
  const SUPERVISOR_KEYS = new Set(['CHAD_DAVIS']);
  // Phase 2.9: truck class comes from the MarginIQ employees roster
  // (vehicleType) — the source Chad actually maintains — joined through the
  // NuVizz alias/fullName fold. The hardcoded pin stays only as a fallback for
  // drivers without an employees record; unknown/blank still reads box_truck
  // (the fleet majority). Class gates tractor-blocked stops + per-class skid caps.
  const empClass = employeeClassMap(inputs.employees || []);
  const CLASS_OVERRIDE = new Map<string, string>([['JUNIOR_THOMAS', 'tractor']]);
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
  const territory = territoryMapsAsOf(inputs.referencesBefore, date);

  // ── the engine's planned stop set ──
  const assignStops: AssignStop[] = planned.map((s) => {
    const id = stopId(s);
    const lat = Number(s.lat), lng = Number(s.lng);
    const mk = s.customerMatchKey ?? null;
    const habit = mk ? habitAsOf(inputs.habitDocByKey.get(mk) ?? null, date) : null;
    // Habit driver → the same driver_key form the roster + territory maps use.
    const habitKey = habit?.topDriver ? String(habit.topDriver).toUpperCase().replace(/\s+/g, '_') : null;
    return {
      id, lat, lng,
      zone: zoneId(lat, lng, precisions),
      gh5: superOfZone(zoneId(lat, lng, precisions), precisions),
      pallets: finiteNum(s.pallets) || 0,   // TOTAL pieces (NuVizz mislabel)
      skids: finiteNum(s.cartons) || 0,     // real skids (NuVizz "cartons")
      loose: finiteNum(s.volume) || 0,      // real loose pieces (NuVizz "volume")
      weight: finiteNum(s.weight) || 0,
      matchKey: mk,
      strict: String(s.timeConstraint || '').toUpperCase() === 'STRICT',
      // DEPOT distance, computed — NEVER NuVizz stopDistance. That field is the
      // LEG distance from the previous stop (a Dalton stop is 3 mi from the
      // previous Dalton stop, not 60 from Buford), which silently disarmed every
      // per-stop far test: territory ownership, the far-habit discount, and
      // zone cohesion all no-opped on exactly the far clusters they were built
      // for. The far/territory terms need distance-from-depot, unambiguously.
      miles: haversineMiles(DEPOT.lat, DEPOT.lng, lat, lng),
      blocksTractor: mk ? restrictionsBlockTractor(inputs.notesRestrictions.get(mk) || []) : false,
      // Phase 2.1: the customer's habitual driver, as-of < D (leakage-safe reader).
      habit,
      // Phase 2.7: allowed drivers — this stop's zone trailing top-5 ∪ habit ∪ the
      // coarser 0.2° area (cold-zone fallback), roster-filtered. Empty ⇒ unseen
      // geography, and the solver falls back to any feasible driver.
      candidates: candidateDriversFor(lat, lng, habitKey, territory, rosterKeys,
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
      trips_engine: eng.trips, trips_actual: dd.trips.filter((t) => t.stops > 0).length,
      stops_engine: eng.stops, stops_actual: actualStops.length,
      lbs_engine: eng.lbs, lbs_actual: Math.round(dd.day_totals?.weight || 0),
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
    })),
    engine_trips: engineTrips.map((t) => ({ driver_key: t.driverKey, seq: t.seq, stop_ids: t.orderedIds, travel_min: Math.round(t.travelMin * 10) / 10 })),
    fleet_chain: { far_first_rate: fleet.far_first_rate, reload_gap_median_min: fleet.reload_gap_median_min, source: fleet.source },
  };
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
  });

  return {
    ok: true, tenant, date,
    drivers: activeDrivers.length, trips_engine, trips_actual,
    planned_stops: planned.length, unassigned_count: result.unassigned.length,
    stop_agreement_pct: proposal.stop_agreement_pct, coload_agreement_pct: proposal.coload_agreement_pct,
    coload_precision_pct: proposal.coload_precision_pct,
    est_travel_engine_min: proposal.est_travel_engine_min, est_travel_actual_min: proposal.est_travel_actual_min,
    matched_load_sequence_score: matchedSeqScore, ms: Date.now() - t0,
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
  for (const n of notesRows) {
    const mk = n?.match_key || n?._id;
    if (mk) notesRestrictions.set(String(mk), n?.equipment_restrictions || []);
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

  return { driverDaysBefore, referencesBefore, serviceDocByKey, fleetServiceDoc: fleetDoc, habitDocByKey, notesRestrictions, tractorCapable, employees };
}
