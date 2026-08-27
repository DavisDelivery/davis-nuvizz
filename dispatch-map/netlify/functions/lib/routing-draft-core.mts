// lib/routing-draft-core.mts
//
// DRIVER-SCOPED ROUTE DRAFTS — the first slice of Assist. Chad names 2-3
// drivers; the learned engine drafts THEIR routes for the day being built from
// the live board's unplanned pool; the draft lands on the Compare workbench
// where he edits it, and the EXISTING Save is the only path to NuVizz.
//
// This module produces a PROPOSAL OBJECT and nothing else: it reads Firestore
// (live board + the same as-of learning inputs the shadow uses), writes
// nothing, and makes ZERO NuVizz calls. The push stays a separate, explicit
// dispatcher action on the battle-tested nuvizz-write path.
//
// SCOPING RULE (why the solver is reused unchanged): solveAssignment is a
// FULL-DAY solver that deliberately never strands a serviceable stop — its
// anyBest fallback would assign off-cast freight to whoever was named. So a
// driver-scoped draft PRE-FILTERS the pool instead: candidates are computed
// against the FULL recent roster, and only stops whose candidate cast
// intersects the chosen drivers enter the solve. Everything else comes back as
// an explicit left-unplanned list with the reason (owned by other drivers /
// unfamiliar geography / equipment), because a draft that quietly claims
// another driver's freight is a draft dispatch cannot trust.
//
// Leakage note: "as-of < D" here is the same guard the shadow replay uses, and
// D may be TOMORROW — every miner filters strictly `date < D`, so drafting
// forward is the exact call pattern the nightly already makes.

import { readStops } from './firestore.mts';
import { DEPOT } from './history-derive.mts';
import { ENGINE_VERSION, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';
import { type ZonePrecisions } from './zones.mts';
import { normalizeMatchKey } from './match-key.mts';
import {
  loadPlanInputs, employeeClassMap, toAssignStop, SUPERVISOR_KEYS, CLASS_OVERRIDE, type PlanInputs,
} from './routing-plan-core.mts';
import {
  driverEnvelope, driverZoneAffinity, fleetTripChain, zoneOwnersAsOf,
  territoryMapsAsOf, candidateDriversFor,
} from './routing-envelope.mts';
import {
  solveAssignment, capsFor, habitStrength,
  type AssignStop, type AssignDriver,
} from './routing-assignment-solver.mts';
import { solveRoute, type EngineStop } from './routing-engine-solver.mts';
import { pickReferences } from './routing-reference.mts';
import { serviceTimeAsOf } from './routing-service-times.mts';

const fold = (s: any) => String(s || '').trim().toUpperCase().replace(/\s+/g, '_');

// normalizeMatchKey never returns a falsy string — an all-blank row would yield
// the junk key "____" and every such row would collapse onto it. Guard on the
// inputs instead: no name and no street means no usable customer identity.
export function liveMatchKey(s: any): string | null {
  if (s?.customerMatchKey) return String(s.customerMatchKey);
  if (!String(s?.businessName || '').trim() && !String(s?.addr1 || '').trim()) return null;
  return normalizeMatchKey(s?.businessName, s?.addr1, s?.city, s?.zip);
}

// The cast a candidate list is computed against: drivers who actually ran
// routes in the trailing window before D. The full employees roster would
// include office staff; all-history keys would include drivers who left.
export const ROSTER_WINDOW_DAYS = 30;
export function recentRosterKeys(driverDaysBefore: any[], asOfDate: string, windowDays = ROSTER_WINDOW_DAYS): Set<string> {
  const cutoff = new Date(asOfDate + 'T12:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  const from = cutoff.toISOString().slice(0, 10);
  const out = new Set<string>();
  for (const d of driverDaysBefore || []) {
    const dt = String(d?.date || '');
    if (dt >= from && dt < asOfDate && d?.driver_key && !SUPERVISOR_KEYS.has(d.driver_key)) out.add(d.driver_key);
  }
  return out;
}

export interface ResolvedDraftDriver {
  input: string;             // what Chad typed
  driver_key: string;
  driver_user_name: string | null;
  driver_name: string | null;
  truck_class: string;
  observed_days: number;     // driver-days < D under this key
  warnings: string[];
}

// Resolve a typed name ("victor", "Scott", "BRENT") to a driver_key. Matching is
// deliberately conservative: an ambiguous name is an ERROR listing the matches,
// never a guess — assigning a day's freight to the wrong Victor is not a typo,
// it is a morning on the phone.
export function resolveDraftDriver(
  name: string, employees: any[], driverDaysBefore: any[], asOfDate: string,
): { ok: true; driver: ResolvedDraftDriver } | { ok: false; error: string } {
  const q = fold(name);
  if (!q) return { ok: false, error: 'empty driver name' };

  const matches = new Map<string, { emp: any | null; via: string }>();
  for (const e of employees || []) {
    const keys = [e?.externalIds?.nuvizz, e?.fullName, e?.firstName, e?.lastName,
      ...(Array.isArray(e?.aliases) ? e.aliases : [])];
    for (const k of keys) {
      if (fold(k) === q) {
        // driver_key follows driverKeyFor's convention: the NuVizz userName
        // (externalIds.nuvizz) uppercased/underscored; fullName only as fallback.
        const dk = fold(e?.externalIds?.nuvizz || e?.fullName);
        if (dk) matches.set(dk, { emp: e, via: String(k) });
        break;
      }
    }
  }

  // No employee match — try the recent history keys directly (Chad may type the
  // NuVizz short code, e.g. "VINCENT"). Exact fold match only.
  const recent = recentRosterKeys(driverDaysBefore, asOfDate);
  if (!matches.size && recent.has(q)) matches.set(q, { emp: null, via: name });
  // Prefix over recent keys ("vic" → VICTOR, "victor" → VICTOR_M) — but ONLY
  // when unique. Two prefix matches is a human question, not a coin flip.
  if (!matches.size) {
    const pref = [...recent].filter((k) => k.startsWith(q));
    if (pref.length === 1) matches.set(pref[0], { emp: null, via: name });
    else if (pref.length > 1) return { ok: false, error: `"${name}" matches ${pref.length} recent drivers (${pref.slice(0, 4).join(', ')}) — use the full name` };
  }

  if (!matches.size) {
    const hint = [...recent].filter((k) => k.includes(q)).slice(0, 4);
    return { ok: false, error: `no driver found for "${name}"${hint.length ? ` — did you mean ${hint.join(', ')}?` : ''}` };
  }
  if (matches.size > 1) {
    return { ok: false, error: `"${name}" is ambiguous: ${[...matches.keys()].join(', ')} — use the full name` };
  }

  const [driver_key, m] = [...matches.entries()][0];
  if (SUPERVISOR_KEYS.has(driver_key)) {
    return { ok: false, error: `${driver_key} is a supervisor — the engine never drafts routes for supervisors` };
  }

  const warnings: string[] = [];
  const mine = (driverDaysBefore || []).filter((d) => d?.driver_key === driver_key && String(d.date) < asOfDate);
  if (m.emp && !m.emp?.externalIds?.nuvizz) {
    warnings.push(`${driver_key}: employee record has no NuVizz alias — history may be filed under a different key`);
  }
  if (!mine.length) warnings.push(`${driver_key}: no observed route history — the engine is guessing from class-level data`);
  else if (!recent.has(driver_key)) warnings.push(`${driver_key}: no routes in the last ${ROSTER_WINDOW_DAYS} days — territory data may be stale`);

  const empClass = employeeClassMap(m.emp ? [m.emp] : []);
  const rawClass = mine.length ? mine[mine.length - 1]?.truck_class ?? null : null;
  const truck_class = empClass.get(driver_key) || CLASS_OVERRIDE.get(driver_key)
    || (rawClass === 'tractor' ? 'tractor' : 'box_truck');
  const userName = m.emp?.externalIds?.nuvizz
    ? String(m.emp.externalIds.nuvizz).trim()
    : (mine.length ? mine[mine.length - 1]?.driver_user_name ?? null : driver_key.replace(/_/g, ' '));

  return {
    ok: true,
    driver: {
      input: name, driver_key,
      driver_user_name: userName,
      driver_name: m.emp?.fullName || (mine.length ? mine[mine.length - 1]?.driver_name ?? null : null),
      truck_class, observed_days: mine.length, warnings,
    },
  };
}

// Live board row → AssignStop, via the ONE shared mapping (routing-plan-core's
// toAssignStop, which the nightly shadow uses on warehouse rows). The only
// live-only substitution is matchKey: warehouse rows carry customerMatchKey,
// board rows do not and must have it computed. Everything else — the NuVizz
// column mislabels, depot-miles, the coordinate guard, STRICT, blocksTractor —
// is defined once, so the live paths and the scored path can never disagree
// about what a stop IS.
export function liveStopToAssignStop(
  s: any, cfg: EngineConfig, precisions: ZonePrecisions, inputs: PlanInputs, date: string,
): AssignStop | null {
  return toAssignStop(s, {
    id: String(s?.stopNbr), matchKey: liveMatchKey(s), cfg, precisions,
    habitDocByKey: inputs.habitDocByKey, notesRestrictions: inputs.notesRestrictions, date,
    freightFloorSkids: 1,
  });
}

// pickReferences requires the candidate route's warehouse to EQUAL the target's,
// and live board rows carry no Whse column — so the live paths stand in the
// warehouse the reference library is actually made of. Davis runs one warehouse;
// if that ever changes, this returns the dominant one rather than silently
// matching nothing (which would make every live trip unguided).
export function modalWarehouseOf(references: any[]): string {
  const counts = new Map<string, number>();
  for (const r of references || []) {
    const w = String(r?.warehouse ?? '');
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

export interface LeftUnplanned {
  stopNbr: string;
  businessName: string | null;
  city: string | null;
  skids: number;
  reason: 'other_drivers' | 'unfamiliar' | 'equipment' | 'over_capacity' | 'no_coords';
  detail: string;
}

export interface DraftTrip {
  seq: number;
  mode: 'guided' | 'unguided';
  references_used: number;
  travel_min_est: number;
  skid_equiv: number;
  stops: Array<{
    stopNbr: string; businessName: string | null; addr1: string | null; city: string | null;
    lat: number; lng: number; skids: number; loose: number; weight: number;
    cast_rank: number | null;  // 1-based position of this driver in the stop's candidate list
    habit_driver: string | null;
  }>;
}

export interface DriverDraft {
  driver_key: string;
  driver_user_name: string | null;
  driver_name: string | null;
  truck_class: string;
  envelope_source: string;       // 'driver' | 'class' | 'none' — is the engine informed or guessing?
  observed_days: number;
  skid_cap: number;
  skid_cap_learned: boolean;
  start_minute: number | null;
  trips: DraftTrip[];
  total_stops: number;
  warnings: string[];
}

export interface DraftResult {
  ok: boolean;
  tenant: string;
  date: string;
  engine_version: string;
  generated_at: string;
  pool: { board_stops: number; unplanned: number; no_coords: number; drafted: number };
  staleness: { last_scanned_at: string | null; last_load_scan_at: string | null; last_unplanned_scan_at: string | null };
  drivers: DriverDraft[];
  left_unplanned: LeftUnplanned[];
  notes: string[];
  ms: number;
}

// Trips a drafted driver may carry. Dispatch's real day is 1-2 trips through the
// Buford reload; the splitter would happily build 4 if the filtered pool demands
// it, and a draft that quietly shows a named driver a 4-trip day is not a draft
// dispatch would sign. Overflow is returned as left-unplanned instead.
export const DRAFT_MAX_TRIPS = 2;

// A dispatcher is WAITING while this runs, and Netlify kills a sync function at
// its configured timeout with an HTML 502 the browser cannot even parse. The
// full-day cap (90s, sized for the nightly replay) is far too long to sit behind
// a request, so both live-board paths bound the local search instead. Measured:
// capping costs a few percent of objective and turns a timeout into an answer.
export const LIVE_SOLVER_MS = 12_000;

export interface BuildDraftOpts {
  cfg: EngineConfig;
  inputs: PlanInputs;
  liveStops: any[];
  meta: any | null;
  resolved: ResolvedDraftDriver[];
  nowIso?: string;
}

// The pure-ish core (all I/O already done by the caller): pool filter → solve →
// two-trip cap → per-trip guided sequencing → proposal object.
export function buildDriverDraft(tenant: string, date: string, opts: BuildDraftOpts): DraftResult {
  const t0 = Date.now();
  const { inputs, liveStops, meta, resolved } = opts;
  const cfg: EngineConfig = { ...opts.cfg, assignment_ms_cap: Math.min(opts.cfg.assignment_ms_cap, LIVE_SOLVER_MS) };
  const nowIso = opts.nowIso || new Date().toISOString();
  const precisions: ZonePrecisions = { zone_precision: cfg.zone_precision, super_precision: cfg.super_precision, top_precision: cfg.top_precision };
  const notes: string[] = [];

  // ── the pool: live unplanned rows with coordinates ──
  const unplanned = (liveStops || []).filter((s) => s?.isUnplanned === true);
  const left: LeftUnplanned[] = [];
  const byId = new Map<string, any>();
  const mapped: AssignStop[] = [];
  let noCoords = 0;
  for (const s of unplanned) {
    const as = liveStopToAssignStop(s, cfg, precisions, inputs, date);
    if (!as) {
      noCoords++;
      left.push({ stopNbr: String(s?.stopNbr ?? '?'), businessName: s?.businessName ?? null, city: s?.city ?? null, skids: Number(s?.cartons) || 0, reason: 'no_coords', detail: 'no coordinates yet (not enriched/geocoded) — the engine cannot place it' });
      continue;
    }
    byId.set(as.id, s);
    mapped.push(as);
  }

  // ── candidates against the FULL recent roster, then the cast intersection ──
  const roster = recentRosterKeys(inputs.driverDaysBefore, date);
  for (const r of resolved) roster.add(r.driver_key); // a named driver is always in their own cast
  const territory = territoryMapsAsOf(inputs.referencesBefore, date, cfg.territory_half_life_days);
  const castKeys = new Set(resolved.map((r) => r.driver_key));
  const inPool: AssignStop[] = [];
  for (const as of mapped) {
    const habitKey = as.habit?.topDriver ? fold(as.habit.topDriver) : null;
    as.candidates = candidateDriversFor(as.lat, as.lng, habitKey, territory, roster,
      { zoneK: cfg.candidate_zone_k, areaK: cfg.candidate_area_k });
    const src = byId.get(as.id);
    if (!as.candidates.length) {
      left.push({ stopNbr: as.id, businessName: src?.businessName ?? null, city: src?.city ?? null, skids: as.skids, reason: 'unfamiliar', detail: 'no delivery history near this stop — the engine has nothing to go on; place it by hand' });
      continue;
    }
    if (!as.candidates.some((k) => castKeys.has(k))) {
      left.push({ stopNbr: as.id, businessName: src?.businessName ?? null, city: src?.city ?? null, skids: as.skids, reason: 'other_drivers', detail: `usually runs with ${as.candidates.slice(0, 3).join(', ')}` });
      continue;
    }
    inPool.push(as);
  }

  // ── the cast as AssignDrivers (as-of < D, same construction as the shadow) ──
  const drivers: AssignDriver[] = resolved.map((r) => {
    const envelope = driverEnvelope(r.driver_key, inputs.driverDaysBefore, date, cfg);
    return {
      driver_key: r.driver_key,
      driver_user_name: r.driver_user_name,
      driver_name: r.driver_name,
      truck_class: r.truck_class,
      start_minute: envelope.start_minute_typical,
      envelope,
      affinity: driverZoneAffinity(r.driver_user_name, inputs.referencesBefore, date, precisions),
    };
  });

  const fleet = fleetTripChain(inputs.driverDaysBefore, date, cfg);
  const svcCache = new Map<string, number>();
  const serviceMedianFor = (s: AssignStop): number => {
    const key = `${s.matchKey}__${s.pallets}`;
    let v = svcCache.get(key);
    if (v == null) {
      const doc = s.matchKey ? inputs.serviceDocByKey.get(s.matchKey) : null;
      v = serviceTimeAsOf(doc, inputs.fleetServiceDoc, s.pallets, date, cfg).median_min;
      svcCache.set(key, v);
    }
    return v;
  };

  const result = inPool.length
    ? solveAssignment({
      date, stops: inPool, drivers, fleetChain: fleet, cfg,
      depot: { lat: DEPOT.lat, lng: DEPOT.lng }, serviceMedianFor,
      zoneOwners: zoneOwnersAsOf(inputs.referencesBefore, date, precisions, cfg),
    })
    : { date, shifts: drivers.map((d) => ({ driver: d, trips: [] })), unassigned: [] as AssignStop[], cost: 0, drivers_used: 0 };

  for (const s of result.unassigned) {
    const src = byId.get(s.id);
    left.push({ stopNbr: s.id, businessName: src?.businessName ?? null, city: src?.city ?? null, skids: s.skids, reason: 'equipment', detail: 'no named driver\'s truck can take it (tractor-blocked)' });
  }

  // ── guided sequencing per trip; two-trip cap with explicit overflow ──
  // Live rows carry no Whse field, so the reference filter's warehouse equality
  // uses the modal warehouse of the reference library (a single-warehouse fleet).
  const modalWarehouse = modalWarehouseOf(inputs.referencesBefore);

  const skidEq = (s: AssignStop) => (s.skids > 0 || s.loose > 0)
    ? s.skids + s.loose / Math.max(1, cfg.loose_per_skid) : s.pallets;

  const draftDrivers: DriverDraft[] = [];
  for (const sh of result.shifts) {
    const r = resolved.find((x) => x.driver_key === sh.driver.driver_key);
    const kept = sh.trips.slice(0, DRAFT_MAX_TRIPS);
    for (const trip of sh.trips.slice(DRAFT_MAX_TRIPS)) {
      for (const s of trip.stops) {
        const src = byId.get(s.id);
        left.push({ stopNbr: s.id, businessName: src?.businessName ?? null, city: src?.city ?? null, skids: s.skids, reason: 'over_capacity', detail: `${sh.driver.driver_key} is full at ${DRAFT_MAX_TRIPS} trips — needs another truck` });
      }
    }
    const trips: DraftTrip[] = kept.map((trip, ti) => {
      const engineStops: EngineStop[] = trip.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, zone: s.zone }));
      const zones = new Set(engineStops.map((s) => s.zone));
      const picked = pickReferences(
        inputs.referencesBefore,
        { date, zones, driverUserName: sh.driver.driver_user_name, truckClass: sh.driver.truck_class, warehouse: modalWarehouse || null, minOverlap: cfg.min_reference_zone_overlap },
        { topK: cfg.reference_top_k, halfLifeDays: cfg.reference_half_life_days, sameDriverMultiplier: cfg.same_driver_multiplier },
      );
      const solved = solveRoute({
        loadKey: `draft__${date}__${sh.driver.driver_key}__${ti + 1}`,
        stops: engineStops, depot: { lat: DEPOT.lat, lng: DEPOT.lng },
        referenceZoneSeq: null,
        references: picked.length ? picked.map((p) => ({ zone_seq: p.ref.zone_seq, weight: p.weight })) : null,
        cfg,
      });
      const orderedAssign = solved.order.map((o) => trip.stops.find((s) => s.id === o.id)!).filter(Boolean);
      return {
        seq: ti + 1,
        mode: picked.length ? 'guided' as const : 'unguided' as const,
        references_used: picked.length,
        travel_min_est: Math.round(solved.travelMin * 10) / 10,
        skid_equiv: Math.round(orderedAssign.reduce((a, s) => a + skidEq(s), 0) * 10) / 10,
        stops: orderedAssign.map((s) => {
          const src = byId.get(s.id);
          return {
            stopNbr: s.id, businessName: src?.businessName ?? null, addr1: src?.addr1 ?? null, city: src?.city ?? null,
            lat: s.lat, lng: s.lng, skids: s.skids, loose: s.loose, weight: s.weight,
            cast_rank: s.candidates && s.candidates.length ? (s.candidates.indexOf(sh.driver.driver_key) + 1 || null) : null,
            habit_driver: s.habit?.topDriver ?? null,
          };
        }),
      };
    });
    const caps = capsFor(sh.driver, cfg);
    draftDrivers.push({
      driver_key: sh.driver.driver_key,
      driver_user_name: sh.driver.driver_user_name,
      driver_name: sh.driver.driver_name,
      truck_class: sh.driver.truck_class || 'box_truck',
      envelope_source: sh.driver.envelope?.source || 'none',
      observed_days: r?.observed_days ?? 0,
      skid_cap: Math.round(caps.hard * 10) / 10,
      skid_cap_learned: caps.learned,
      start_minute: sh.driver.start_minute,
      trips,
      total_stops: trips.reduce((a, t) => a + t.stops.length, 0),
      warnings: r?.warnings || [],
    });
  }

  for (const r of resolved) for (const w of r.warnings) notes.push(w);
  if (!inPool.length) notes.push('nothing in the unplanned pool belongs to the named drivers — see the left-unplanned list');

  return {
    ok: true, tenant, date, engine_version: ENGINE_VERSION, generated_at: nowIso,
    pool: { board_stops: (liveStops || []).length, unplanned: unplanned.length, no_coords: noCoords, drafted: draftDrivers.reduce((a, d) => a + d.total_stops, 0) },
    staleness: {
      last_scanned_at: meta?.last_scanned_at ?? null,
      last_load_scan_at: meta?.lastLoadScanAt ?? null,
      last_unplanned_scan_at: meta?.lastUnplannedScanAt ?? null,
    },
    drivers: draftDrivers,
    left_unplanned: left,
    notes,
    ms: Date.now() - t0,
  };
}

// I/O wrapper the endpoint calls: live board read + as-of inputs + name
// resolution, then the core above. ZERO NuVizz calls — readStops and
// loadPlanInputs are Firestore-only.
export async function runDraft(
  tenant: string, date: string, driverNames: string[],
): Promise<{ ok: true; draft: DraftResult } | { ok: false; status: number; error: string; details?: string[] }> {
  if (!Array.isArray(driverNames) || driverNames.length < 1 || driverNames.length > 4) {
    return { ok: false, status: 400, error: 'name 1-4 drivers' };
  }
  const cfg = await loadEngineConfig(tenant);
  const { meta, stops } = await readStops(tenant, date);
  if (!stops.length) {
    return { ok: false, status: 404, error: `no board data for ${date} — the scheduled scan has not written that day yet` };
  }
  // Stamp computed matchKeys on the row copies so loadPlanInputs's bounded
  // habit/service reads (keyed on customerMatchKey) cover the live pool.
  const stamped = stops.map((s: any) => ({ ...s, customerMatchKey: liveMatchKey(s) }));
  const inputs = await loadPlanInputs(tenant, date, stamped.filter((s: any) => s?.isUnplanned === true));

  const resolved: ResolvedDraftDriver[] = [];
  const errors: string[] = [];
  for (const name of driverNames) {
    const r = resolveDraftDriver(name, inputs.employees || [], inputs.driverDaysBefore, date);
    if (r.ok) resolved.push(r.driver);
    else errors.push(r.error);
  }
  if (errors.length) return { ok: false, status: 400, error: 'driver resolution failed', details: errors };
  const dupe = resolved.map((r) => r.driver_key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupe.length) return { ok: false, status: 400, error: `duplicate driver: ${[...new Set(dupe)].join(', ')}` };

  return { ok: true, draft: buildDriverDraft(tenant, date, { cfg, inputs, liveStops: stamped, meta, resolved }) };
}
