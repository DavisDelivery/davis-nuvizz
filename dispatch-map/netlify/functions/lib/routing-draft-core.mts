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

// The day's board as a planning surface reads it: on the UAT site in planning mode every row reads
// unplanned (lib/uat-planning-mode.mts); everywhere else this is readStops, unchanged.
import { readStopsForPlanning } from './uat-planning-mode.mts';
import { runQuery, listDocs, readLoadRoster } from './firestore.mts';
import { DRIVER_DAYS_COLLECTION } from './routing-driver-days.mts';
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
import { isHashLikeId, looksLikeLoadNbr } from './route-identity.mts';

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
  const from = rosterWindowFrom(asOfDate, windowDays);
  const out = new Set<string>();
  for (const d of driverDaysBefore || []) {
    const dt = String(d?.date || '');
    // A key that is not a string can match nothing (a stray document must not take the list down).
    if (dt >= from && dt < asOfDate && typeof d?.driver_key === 'string' && d.driver_key && !SUPERVISOR_KEYS.has(d.driver_key)) out.add(d.driver_key);
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

  return { ok: true, driver: describeDraftDriver(name, driver_key, m.emp, driverDaysBefore, asOfDate, recent) };
}

// WHO A DRIVER IS TO THE ENGINE — name, NuVizz user, truck class, days on record, and what it is
// unsure of. ONE description for every way a driver is chosen (a typed name, a key picked off the
// step-4 list, the list itself), so the list can never show a class or a name the draft would not
// use. `driverDaysBefore` in date order, as loadPlanInputs reads it: the last of a driver's rows
// is the most recent day.
function describeDraftDriver(
  input: string, driver_key: string, emp: any | null, driverDaysBefore: any[], asOfDate: string, recent: Set<string>,
): ResolvedDraftDriver {
  const warnings: string[] = [];
  const mine = (driverDaysBefore || []).filter((d) => d?.driver_key === driver_key && String(d.date) < asOfDate);
  if (emp && !emp?.externalIds?.nuvizz) {
    warnings.push(`${driver_key}: employee record has no NuVizz alias — history may be filed under a different key`);
  }
  if (!mine.length) warnings.push(`${driver_key}: no observed route history — the engine is guessing from class-level data`);
  else if (!recent.has(driver_key)) warnings.push(`${driver_key}: no routes in the last ${ROSTER_WINDOW_DAYS} days — territory data may be stale`);

  const empClass = employeeClassMap(emp ? [emp] : []);
  const rawClass = mine.length ? mine[mine.length - 1]?.truck_class ?? null : null;
  const truck_class = empClass.get(driver_key) || CLASS_OVERRIDE.get(driver_key)
    || (rawClass === 'tractor' ? 'tractor' : 'box_truck');
  const userName = emp?.externalIds?.nuvizz
    ? String(emp.externalIds.nuvizz).trim()
    : (mine.length ? mine[mine.length - 1]?.driver_user_name ?? null : driver_key.replace(/_/g, ' '));

  return {
    input, driver_key,
    driver_user_name: userName,
    driver_name: emp?.fullName || (mine.length ? mine[mine.length - 1]?.driver_name ?? null : null),
    truck_class, observed_days: mine.length, warnings,
  };
}

// The employee record a driver_key belongs to — driverKeyFor's convention, the same one the
// typed-name path uses: the NuVizz userName folded, fullName only as the fallback.
function employeeForKey(employees: any[], driver_key: string): any | null {
  return (employees || []).find((e) => fold(e?.externalIds?.nuvizz || e?.fullName) === driver_key) || null;
}

// A DRIVER PICKED OFF THE LIST IS THAT DRIVER — no name matching at all. Chad, on step 4's By
// driver: "This should be a list that i select from not a type in situation other than type in
// to find the name or route to select." The list sends the exact driver_key it showed, so
// nothing between the tap and the draft can turn "Victor" into the other Victor or read
// "Allen, John" as two people. The key must be on the list's own cast (the drivers who ran a
// route in the ROSTER_WINDOW_DAYS before the date, never a supervisor); anything else is refused
// by name, never re-matched.
export function resolveDraftDriverKey(
  key: string, employees: any[], driverDaysBefore: any[], asOfDate: string,
): { ok: true; driver: ResolvedDraftDriver } | { ok: false; error: string } {
  const driver_key = String(key ?? '').trim();
  if (!driver_key) return { ok: false, error: 'empty driver' };
  if (SUPERVISOR_KEYS.has(driver_key)) {
    return { ok: false, error: `${driver_key} is a supervisor — the engine never drafts routes for supervisors` };
  }
  if (NOT_A_PERSON_KEYS.has(driver_key)) {
    return { ok: false, error: `${driver_key} is a planned load with no driver on it, not a driver — pick a driver from the list` };
  }
  const recent = recentRosterKeys(driverDaysBefore, asOfDate);
  if (!recent.has(driver_key)) {
    return { ok: false, error: `${driver_key} has not run a route in the ${ROSTER_WINDOW_DAYS} days before ${asOfDate} — pick a driver from the list` };
  }
  return { ok: true, driver: describeDraftDriver(driver_key, driver_key, employeeForKey(employees, driver_key), driverDaysBefore, asOfDate, recent) };
}

// driverKeyFor files a planned stop with NO driver on it under the key 'unknown' (history-derive).
// The engine's roster still counts it (unchanged); it is not a person to draft routes for, so the
// list never offers it and a pick of it is refused.
const NOT_A_PERSON_KEYS = new Set(['unknown']);

export interface DraftableDriver {
  key: string;               // the exact driver_key the draft is sent
  name: string;              // what the list shows first
  userName: string | null;   // the NuVizz user, when known
  truckClass: string;        // 'tractor' | 'box_truck' — the class the draft will use
  days: number;              // days with a route in the window
  lastDate: string | null;   // the most recent of them
  routes: string[];          // the route names they ran most, most often first (at most 3)
}

// THE STEP-4 LIST — the drivers who ran a route in the ROSTER_WINDOW_DAYS before the date: the
// roster the engine computes every stop's candidates against (recentRosterKeys — never a
// supervisor, never another tenant), each described by describeDraftDriver so the list and the
// draft agree. NARROWER THAN THE OLD TYPED BOX, and on purpose: typed, a driver whose last route
// was older than the window was still drafted (buildDriverDraft adds a named driver to their own
// cast) with a "territory data may be stale" warning. The list leaves them off, because the same
// rule would list every driver who has left; ROSTER_WINDOW_DAYS is the one number to move. `routeNameFor`
// turns a trip's load_key into the route name the dispatcher knows it by ("SUW 2"), or null when
// nothing recorded one; a driver's routes are the names they ran most, because that is what a
// dispatcher searching "suw" is asking — who runs Suwanee. A→Z by name, so a row never moves
// under the cursor as the box narrows. Pure: the caller does every read.
export function draftableDrivers(
  driverDaysWindow: any[], employees: any[], asOfDate: string,
  routeNameFor: (date: string, loadKey: string) => string | null,
): DraftableDriver[] {
  const rows = [...(driverDaysWindow || [])].sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
  const recent = recentRosterKeys(rows, asOfDate);
  const out: DraftableDriver[] = [];
  for (const key of recent) {
    if (NOT_A_PERSON_KEYS.has(key)) continue;
    const d = describeDraftDriver(key, key, employeeForKey(employees, key), rows, asOfDate, recent);
    const mine = rows.filter((r) => r?.driver_key === key && String(r.date) < asOfDate);
    const seen = new Map<string, { n: number; last: string }>();
    for (const day of mine) {
      for (const t of Array.isArray(day?.trips) ? day.trips : []) {
        const name = String(routeNameFor(String(day.date), String(t?.load_key ?? '')) ?? '').trim();
        if (!name) continue;
        const s = seen.get(name) || { n: 0, last: '' };
        s.n++;
        if (String(day.date) > s.last) s.last = String(day.date);
        seen.set(name, s);
      }
    }
    const routes = [...seen.entries()]
      .sort((a, b) => b[1].n - a[1].n || b[1].last.localeCompare(a[1].last) || a[0].localeCompare(b[0]))
      .slice(0, 3).map(([n]) => n);
    const dates = [...new Set(mine.map((r) => String(r.date)))].sort();
    out.push({
      key, name: String(d.driver_name || '').trim() || key, userName: d.driver_user_name,
      truckClass: d.truck_class, days: dates.length, lastDate: dates.length ? dates[dates.length - 1] : null, routes,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

// A TRIP'S ROUTE NAME. A driver-day trip's load_key is loadKeyForStop's: the stop's `loadNbr`,
// else `routeName__driverUser`. And a board row's `loadNbr` holds the route NAME, not the load
// number (nuvizz-list toBoardStop: `loadNbr: hasRoute ? r.routeName : null`, the number being
// `nuvizzLoadNbr`). So, in order: a key with `__` carries its name; a key that is a load number is
// looked up in that day's roster, exactly, or names nothing; and any other key — one that is
// neither number-shaped nor an opaque id — IS the route name the board stored. (Reading only
// numbers left every driver whose days were filed by name with no routes, so "suw" found no one.)
export function routeNameFromRoster(loadKey: string, rosterLoads: any): string | null {
  const k = String(loadKey ?? '').trim();
  if (!k) return null;
  const cut = k.indexOf('__');
  if (cut > 0) return k.slice(0, cut);
  const loads = Array.isArray(rosterLoads) ? rosterLoads : [];   // a roster that is not a list names nothing
  const hit = loads.find((l) => String(l?.loadNbr ?? '').trim() === k);
  if (hit) return String(hit?.name ?? '').trim() || null;
  if (looksLikeLoadNbr(k) || isHashLikeId(k)) return null;   // a number this day's roster does not have: unknown, never guessed
  return k;
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
// resolution, then the core above. ZERO NuVizz calls — readStopsForPlanning and
// loadPlanInputs are Firestore-only. `opts.keys` — drivers picked off the step-4 list, by
// their exact driver_key (resolveDraftDriverKey); when given, `driverNames` is not read.
export async function runDraft(
  tenant: string, date: string, driverNames: string[], opts: { keys?: string[] | null } = {},
): Promise<{ ok: true; draft: DraftResult } | { ok: false; status: number; error: string; details?: string[] }> {
  const byKey = Array.isArray(opts.keys) && opts.keys.length > 0;
  const asked = byKey ? opts.keys! : driverNames;
  if (!Array.isArray(asked) || asked.length < 1 || asked.length > 4) {
    return { ok: false, status: 400, error: byKey ? 'pick 1-4 drivers' : 'name 1-4 drivers' };
  }
  const cfg = await loadEngineConfig(tenant);
  const { meta, stops } = await readStopsForPlanning(tenant, date);
  if (!stops.length) {
    return { ok: false, status: 404, error: `no board data for ${date} — the scheduled scan has not written that day yet` };
  }
  // Stamp computed matchKeys on the row copies so loadPlanInputs's bounded
  // habit/service reads (keyed on customerMatchKey) cover the live pool.
  const stamped = stops.map((s: any) => ({ ...s, customerMatchKey: liveMatchKey(s) }));
  const inputs = await loadPlanInputs(tenant, date, stamped.filter((s: any) => s?.isUnplanned === true));

  const resolved: ResolvedDraftDriver[] = [];
  const errors: string[] = [];
  for (const asked1 of asked) {
    const r = byKey
      ? resolveDraftDriverKey(asked1, inputs.employees || [], inputs.driverDaysBefore, date)
      : resolveDraftDriver(asked1, inputs.employees || [], inputs.driverDaysBefore, date);
    if (r.ok) resolved.push(r.driver);
    else errors.push(r.error);
  }
  if (errors.length) return { ok: false, status: 400, error: 'driver resolution failed', details: errors };
  const dupe = resolved.map((r) => r.driver_key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupe.length) return { ok: false, status: 400, error: `duplicate driver: ${[...new Set(dupe)].join(', ')}` };

  return { ok: true, draft: buildDriverDraft(tenant, date, { cfg, inputs, liveStops: stamped, meta, resolved }) };
}

// The first day of the roster window — recentRosterKeys' own arithmetic, so the rows read and
// the rows counted are the same rows.
export function rosterWindowFrom(asOfDate: string, windowDays = ROSTER_WINDOW_DAYS): string {
  const cutoff = new Date(asOfDate + 'T12:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  return cutoff.toISOString().slice(0, 10);
}

// I/O wrapper for the step-4 list. ZERO NuVizz calls: one windowed query on the driver days
// (only the window, never the whole history the draft itself reads), the employees roster, and
// the cached load roster of each day in the window for the route names — all Firestore. A day
// whose roster was never cached just contributes no route names; the driver is still listed.
export async function listDraftableDrivers(tenant: string, date: string): Promise<{ from: string; drivers: DraftableDriver[] }> {
  const from = rosterWindowFrom(date);
  const [ddRows, employees] = await Promise.all([
    runQuery({
      from: [{ collectionId: DRIVER_DAYS_COLLECTION }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN', value: { stringValue: date } } },
      ] } },
    }),
    listDocs('employees').catch(() => [] as any[]),
  ]);
  const days = (ddRows as any[]).filter((r) => r?.tenant === tenant);
  const dates = [...new Set(days.map((r) => String(r.date)))];
  const rosters = await Promise.all(dates.map((d) => readLoadRoster(tenant, d).catch(() => null)));
  const loadsByDate = new Map(dates.map((d, i) => [d, rosters[i]?.loads ?? []] as const));
  const drivers = draftableDrivers(days, employees as any[], date, (d, loadKey) => routeNameFromRoster(loadKey, loadsByDate.get(d)));
  return { from, drivers };
}
