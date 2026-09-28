// lib/claude-shadow/plan-core.mts — A FORWARD PLAN OF ONE BOARD DAY, PURE (v1.76.0).
//
// Chad, 2026-09-26: "there should be a planning area of the shadow mode where I can tell it to build a
// certain number of routes and it take what it's learned from the engine and firestore data and
// propose how it would route the selected routes" — and: "you need to let me set the parameters for
// tomorrows board such as the date and how many days it looks back for unplanned orders."
//
// A backtest measures Claude against a day that has run. A PLAN is a day that has not: the stops still
// to be planned on one board day, and the loads the dispatcher picks for them. Everything a plan is
// built from is what the rest of the app already uses, read the same way:
//
//   the stops     the board day's rows as the Map reads them — the finished-prior-day filter, the
//                 carry-over fold (lib/carryover-fold.mts, the Map's own rule, the SAME function) over
//                 the look-back days picked, and the cancelled drop — then, of those, the deliveries
//                 still to plan: unplanned only, or every open one (a re-plan of what is on loads).
//   the loads     picked by the dispatcher: a load on that day's roster (its name and driver), a
//                 driver, or an unnamed box truck or tractor. Each is held to a cap by the backtest's
//                 own rule (capFor: yours, else learned held to the class ceiling, else the rating),
//                 the weight limits, and the engine's day length.
//   the rules     the backtest's evaluator, in plan mode: every hard rule holds, and a stop may be left
//                 unplanned only when no load has room for it (backtest-core.mts roomFor).
//
//   sections      (v1.78.0, Chad: "instead of letting you do it all at once i would like the choice to
//                 do it in sections where i have a map in a drawer and can select the stops i want you to
//                 put the stops on") — a plan may take only the stops picked on the map, and may BUILD ON
//                 an earlier plan of the same day: that plan's stops on a load picked again are kept on
//                 it (pinned, their room counted, as a load's NuVizz stops are), its stops on a load not
//                 picked again are carried forward untouched, and none of them is offered again.
//
// No I/O here: lib/claude-shadow/plan.mts reads the documents and calls these.
import { type CarryoverStats } from '../carryover-fold.mts';
import { normalizeMatchKey } from '../../../../src/lib/matchKey.js';
import { stampedLoadOf } from '../../../../src/lib/route-load-stamp.js';
import { employeeClassMap, CLASS_OVERRIDE } from '../driver-class.mts';
import { DEFAULT_SERVICE_MIN } from '../routing-types.mts';
import {
  toBtStop, capFor, usableCoords, classKey, driverKey, measurePlan, makeSequencer, planCost, tourLegs,
  PROFILE_MAX_LBS, type BtProblem, type BtLoad, type BtStop, type CapRule, type CostRates,
} from './backtest-core.mts';
import { keyOf, tidy, num, skidSpots } from './learn-core.mts';
import { withOverrides, DEFAULT_CEILINGS } from './settings-core.mts';

export const PLAN_TENANT = 'davis';
/** The look-back the board itself allows (nuvizz-pull-today-stops.mts clamps carryDays to 0–14). */
export const PLAN_LOOKBACK_BOUNDS: [number, number] = [0, 14];
export const PLAN_SCOPES = ['unplanned', 'open'] as const;
export type PlanScope = (typeof PLAN_SCOPES)[number];
export const PLAN_PICK_KINDS = ['roster', 'driver', 'truck'] as const;
export const MAX_PLAN_LOADS = 120;
/** A day larger than this is refused before any spend: the prompt would not fit one round. */
export const MAX_PLAN_STOPS = 1400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface PlanPick { kind: (typeof PLAN_PICK_KINDS)[number]; route: string; driver: string | null; cls: 'box_truck' | 'tractor' | null; loadNbr: string | null }
/**
 * `section` (v1.78.0): the stop numbers picked on the map — only those are placed (with the stops kept
 * on the picked loads). null: every stop the scope allows. `after`: the id of an earlier plan of the
 * same day this one builds on (see the header), or null.
 */
export interface PlanParams { date: string; lookbackDays: number; scope: PlanScope; picks: PlanPick[]; section: string[] | null; after: string | null }
/**
 * A stop number as the board carries it (DAVIS00203731, AVRT-0028093763). Only compared against the
 * board's own numbers, never used as a path, so the check is loose on purpose: trimmed, 1–80 long, no
 * control character and no slash — a number the board holds is never refused for its spelling.
 */
export const STOP_NBR_RE = /^[^\u0000-\u001f/]{1,80}$/;
export const PLAN_ID_RE = /^pl__[\w\-]{1,120}$/;

const realDate = (d: string) => DATE_RE.test(d) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

/** Check a plan request whole; one bad value refuses it and nothing is read or spent. */
export function validatePlanParams(raw: any): { ok: boolean; errors: string[]; params: PlanParams | null } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['no plan sent'], params: null };
  const date = String(raw.date ?? '').trim();
  if (!realDate(date)) errors.push(`the date must be a real day, YYYY-MM-DD (got ${JSON.stringify(raw.date ?? null)})`);
  // A BLANK IS NOT 0. Number('') is 0: a cleared box would read "look back no days" when the person
  // typed nothing. Absent means the board's default (0); a value must be a whole number 0–14.
  let lookbackDays = 0;
  if (raw.lookbackDays !== undefined) {   // JSON cannot send undefined; null is a value and is refused
    const v = raw.lookbackDays;
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < PLAN_LOOKBACK_BOUNDS[0] || n > PLAN_LOOKBACK_BOUNDS[1]) errors.push(`the look-back must be a whole number of days from ${PLAN_LOOKBACK_BOUNDS[0]} to ${PLAN_LOOKBACK_BOUNDS[1]} (got ${JSON.stringify(v)})`);
    else lookbackDays = n;
  }
  const scope = raw.scope == null ? 'unplanned' : raw.scope;
  if (!(PLAN_SCOPES as readonly string[]).includes(scope)) errors.push(`which stops must be ${PLAN_SCOPES.join(' or ')} (got ${JSON.stringify(scope)})`);
  const picks: PlanPick[] = [];
  const list = raw.picks;
  if (!Array.isArray(list) || !list.length) errors.push('pick at least one load to plan onto');
  else if (list.length > MAX_PLAN_LOADS) errors.push(`at most ${MAX_PLAN_LOADS} loads (got ${list.length})`);
  else {
    const seen = new Set<string>();
    list.forEach((p: any, i: number) => {
      const at = `load ${i + 1}`;
      const kind = p?.kind;
      if (!(PLAN_PICK_KINDS as readonly string[]).includes(kind)) { errors.push(`${at}: must come from the roster, a driver or a truck (got ${JSON.stringify(kind)})`); return; }
      const route = typeof p?.route === 'string' ? tidy(p.route) : '';
      if (!route) { errors.push(`${at}: has no route name`); return; }
      if (route.length > 60) { errors.push(`${at}: the route name is too long`); return; }
      const driver = typeof p?.driver === 'string' && tidy(p.driver) ? tidy(p.driver) : null;
      if (driver && driver.length > 80) { errors.push(`${at}: the driver name is too long`); return; }
      const cls = p?.cls == null ? null : p.cls;
      if (cls !== null && cls !== 'box_truck' && cls !== 'tractor') { errors.push(`${at}: the truck must be box_truck or tractor (got ${JSON.stringify(cls)})`); return; }
      if (kind === 'truck' && !cls) { errors.push(`${at}: an unnamed truck needs its class (box truck or tractor)`); return; }
      // A roster load may have no driver yet (a Draft load named for a territory — 1 SATL, 2 M): it is
      // still a load, held to its route's learned cap, its own day. A driver pick is its driver.
      if (kind === 'driver' && !driver) { errors.push(`${at}: a driver pick needs its driver`); return; }
      const loadNbr = typeof p?.loadNbr === 'string' && p.loadNbr.trim() ? p.loadNbr.trim().slice(0, 40) : null;
      const key = loadNbr ? `nbr:${loadNbr}` : `${kind}|${keyOf(route)}|${keyOf(driver || '')}`;
      if (kind !== 'truck' && seen.has(key)) { errors.push(`${at}: ${route}${driver ? ` · ${driver}` : ''} is picked twice`); return; }
      seen.add(key);
      picks.push({ kind, route, driver, cls, loadNbr });
    });
  }
  // THE SECTION (v1.78.0): absent or null is every stop; a list must name at least one stop.
  let section: string[] | null = null;
  if (raw.section != null) {
    if (!Array.isArray(raw.section)) errors.push('the section must be a list of stop numbers');
    else if (!raw.section.length) errors.push('pick at least one stop on the map for this section');
    else if (raw.section.length > MAX_PLAN_STOPS) errors.push(`at most ${MAX_PLAN_STOPS} stops in a section (got ${raw.section.length})`);
    else {
      const list = raw.section.map((x: any) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : ''));
      const bad = list.filter((x: string) => !STOP_NBR_RE.test(x));
      if (bad.length) errors.push(`the section has ${bad.length} value${bad.length === 1 ? '' : 's'} that ${bad.length === 1 ? 'is' : 'are'} not a stop number`);
      else section = [...new Set<string>(list)];
    }
  }
  let after: string | null = null;
  if (raw.after != null) {
    if (typeof raw.after !== 'string' || !PLAN_ID_RE.test(raw.after)) errors.push(`the plan to build on is not a plan id (got ${JSON.stringify(raw.after)})`);
    else after = raw.after;
  }
  return errors.length ? { ok: false, errors, params: null } : { ok: true, errors: [], params: { date, lookbackDays, scope, picks, section, after } };
}

/**
 * The day, look-back, scope and the plan to build on — what the stop map reads (it needs no loads).
 * The same checks as a plan's, so the map shows the stops a plan of those settings would see.
 */
export function validateStopsParams(raw: any): { ok: boolean; errors: string[]; params: Omit<PlanParams, 'picks' | 'section'> | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['no settings sent'], params: null };
  const v = validatePlanParams({ ...raw, picks: [{ kind: 'truck', route: 'MAP', driver: null, cls: 'box_truck' }], section: null });
  if (!v.ok) return { ok: false, errors: v.errors, params: null };
  const { date, lookbackDays, scope, after } = v.params!;
  return { ok: true, errors: [], params: { date, lookbackDays, scope, after } };
}

/**
 * WHICH LOAD IS WHICH, FROM ONE SECTION TO THE NEXT. A roster load by its load number; anything else by
 * what it is, its route name and its driver. Two sections that pick the same load get the same key, so
 * the stops the first put on it are kept on it in the second.
 */
export function pickIdentity(pk: Pick<PlanPick, 'kind' | 'route' | 'driver' | 'loadNbr'>): string {
  if (pk.kind === 'roster' && pk.loadNbr) return `nbr:${pk.loadNbr}`;
  return `${pk.kind}|${keyOf(pk.route)}|${keyOf(pk.driver || '')}`;
}

/** Where an earlier section put a stop: the load's identity and how to name it. */
export interface EarlierPlacement { key: string; route: string; driver: string; cls: 'box_truck' | 'tractor' }

/**
 * THE EARLIER SECTIONS' PLACEMENTS, from a finished plan's result: every stop on one of its loads, plus
 * what it carried forward from the sections before it. null when the result predates sections (it
 * stored no placements) — such a plan cannot be built on.
 */
export function placementsOf(result: any): Map<string, EarlierPlacement> | null {
  if (!result || !Array.isArray(result.placements) || !Array.isArray(result.loadKeys)) return null;
  const out = new Map<string, EarlierPlacement>();
  const keyOfLoad = new Map<string, string>(result.loadKeys.map((x: any) => [String(x?.id), String(x?.key)]));
  const loadById = new Map<string, any>((result.loads || []).map((l: any) => [String(l?.id), l]));
  for (const c of result.section?.carried || []) {
    const n = String(c?.n ?? '').trim();
    if (!STOP_NBR_RE.test(n) || typeof c?.key !== 'string') continue;
    out.set(n, { key: c.key, route: String(c.route ?? ''), driver: String(c.driver ?? ''), cls: c.cls === 'tractor' ? 'tractor' : 'box_truck' });
  }
  for (const pl of result.placements) {
    const n = String(pl?.n ?? '').trim();
    const key = keyOfLoad.get(String(pl?.load));
    const l = loadById.get(String(pl?.load));
    if (!STOP_NBR_RE.test(n) || !key) continue;
    out.set(n, { key, route: String(l?.route ?? ''), driver: String(l?.driver ?? ''), cls: l?.cls === 'tractor' ? 'tractor' : 'box_truck' });
  }
  return out;
}

/**
 * THE STOPS THE SECTIONS LEFT OFF SO FAR, with Claude's reason (review, v1.78.0): a stop no truck had room
 * for is free again for the next section, and the stop map says why it was left off. A result from
 * before the chain kept this list gives its own left-off stops.
 */
export function leftOffOf(result: any): Map<string, string> {
  const out = new Map<string, string>();
  const list = Array.isArray(result?.section?.leftOff) ? result.section.leftOff : (result?.unplanned || []);
  for (const u of list) { const n = String(u?.n ?? '').trim(); if (n && STOP_NBR_RE.test(n)) out.set(n, String(u?.reason ?? '').slice(0, 300)); }
  return out;
}

const FINISHED_STATUS = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);
const FINISHED_CODES = new Set(['90', '91', '80', '99']);
export const isFinishedRow = (s: any) => FINISHED_STATUS.has(String(s?.normalizedStatus ?? '').toUpperCase()) || FINISHED_CODES.has(String(s?.status ?? ''));

export interface PlanStopCounts {
  onBoard: number; carried: number; cancelled: number; pickups: number; finished: number;
  planned: number;                        // on a load in NuVizz that was NOT picked — they stay there, unplanned here
  kept: number;                           // on a PICKED load in NuVizz — kept on it, their room counted
  keptNoLocation: number;                 // …of which have no location: their room is held back on the load
  ambiguous: number;                      // on a picked route NAME the roster gives to more than one load — not tied to either
  corrected: number;                      // placed at the dispatcher's corrected pin, not the feed's geocode
  noLocation: number; toPlan: number;     // toPlan: the stops Claude places (kept and earlier-section ones not included)
  byDay: Record<string, number>;          // the stops to plan, by the board day each is filed on
  // v1.78.0 sections — all 0 (section null) when the plan is not a section and builds on nothing.
  section: number | null;                 // the stops picked on the map, or null for every stop
  leftForLater: number;                   // open stops the scope allows that were not picked for this section
  sectionMissing: number;                 // picked on the map but not plannable now (gone, finished, on a load not picked, no location)
  sectionAlreadyPlaced: number;           // picked on the map but already placed by an earlier section
  earlierKept: number;                    // placed by an earlier section on a load picked again — kept on it
  earlierCarried: number;                 // placed by an earlier section on a load not picked here — carried forward
  earlierDropped: number;                 // placed by an earlier section but no longer open (finished, gone, or — planning unplanned only — now on a load in NuVizz)
  earlierNoLocation: number;              // placed by an earlier section but has lost its map point: carried forward, its room held back on a load picked again
}

/** The section and the earlier sections, for selectPlanStops (v1.78.0). Empty: a plan of every stop. */
export interface SectionInput {
  section?: Set<string> | null;                  // the stop numbers picked on the map
  earlier?: Map<string, EarlierPlacement> | null; // what the earlier sections placed, by stop number
  pickOf?: Map<string, number>;                  // pickIdentity → index of that pick in this plan
}

/** The key a board row's ROUTE goes by: its route name (a list row's loadNbr is the route name too). */
export const rowRouteKey = (r: any) => keyOf(String(r?.routeName || r?.loadNbr || ''));
/** The key a board row's LOAD goes by (v1.82.0): the roster load number the scan wrote onto it, when it
 *  wrote one (lib/route-load-day.mts) and the row still says what it said then — planned, on the same
 *  route (stampedLoadOf) — else null, and the caller falls back to the route name. A Save onto JOE
 *  since the scan never keeps the stop on MARCUS's number. */
export const rowLoadNbrKey = (r: any): string | null => {
  const st = stampedLoadOf(r);
  return st ? `nbr:${st.loadNbr}` : null;
};

/**
 * Of the board rows, the deliveries still to plan — and, counted, every row that is not.
 * `keepOn` is the route keys of the PICKED roster loads: with scope 'unplanned', a stop already on one
 * of them in NuVizz is KEPT — chosen, and pinned to that load — because that truck is carrying it
 * whatever Claude proposes, and a plan that ignored it would promise room the truck does not have.
 *
 * A SECTION (v1.78.0) takes only its picked stops; a stop an EARLIER section placed is kept on its load
 * when that load is picked again (pinTo), carried forward untouched when it is not (carried), and never
 * offered again. NuVizz outranks an earlier section: a stop that is on a load in NuVizz now is where
 * NuVizz has it, and one no longer open on the board is dropped from the chain (earlierDropped).
 */
export function selectPlanStops(
  rows: any[], date: string, scope: PlanScope, cancelled = 0, keepOn: Set<string> = new Set(),
  locate: (r: any) => { lat: number; lng: number; corrected: boolean } | null = (r) => (usableCoords(r?.lat, r?.lng) ? { lat: Number(r.lat), lng: Number(r.lng), corrected: false } : null),
  ambiguousNames: Set<string> = new Set(),
  sec: SectionInput = {},
): {
  chosen: any[]; noLocation: any[]; kept: Map<string, string>; keptNoLocation: any[]; counts: PlanStopCounts;
  pinTo: Map<string, number>; carried: ({ n: string } & EarlierPlacement)[]; earlierDropped: string[]; sectionMissing: string[];
  heldEarlier: { r: any; idx: number }[];
} {
  const section = sec.section ?? null;
  const earlier = sec.earlier ?? null;
  const pickOf = sec.pickOf ?? new Map<string, number>();
  const counts: PlanStopCounts = {
    onBoard: rows.length, carried: 0, cancelled, pickups: 0, finished: 0, planned: 0, kept: 0, keptNoLocation: 0, ambiguous: 0, corrected: 0, noLocation: 0, toPlan: 0, byDay: {},
    section: section ? section.size : null, leftForLater: 0, sectionMissing: 0, sectionAlreadyPlaced: 0, earlierKept: 0, earlierCarried: 0, earlierDropped: 0, earlierNoLocation: 0,
  };
  const chosen: any[] = [], noLocation: any[] = [], keptNoLocation: any[] = [];
  const kept = new Map<string, string>();
  const pinTo = new Map<string, number>();
  const carried: ({ n: string } & EarlierPlacement)[] = [];
  const heldEarlier: { r: any; idx: number }[] = [];
  const free = new Set<string>();           // stops Claude places in this plan
  const seenEarlier = new Set<string>();    // earlier placements still open on the board
  const seen = new Set<string>();
  for (const r of rows) {
    const n = String(r?.stopNbr ?? '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (r.carryover === true) counts.carried++;
    if (String(r.stopType ?? '').toUpperCase() === 'PU') { counts.pickups++; continue; }
    if (isFinishedRow(r)) { counts.finished++; continue; }
    const at = locate(r);
    if (scope === 'unplanned' && r.isPlanned === true) {
      // BY LOAD NUMBER FIRST (v1.82.0). The scan writes onto a routed row the roster load number that
      // holds it; when the picks name loads by number, that decides — a row on an unpicked load of the
      // same name is NOT kept on the picked one, and two same-named loads are no longer a guess.
      const nk = rowLoadNbrKey(r);
      const picksHaveNbrs = [...keepOn].some((k) => k.startsWith('nbr:'));
      let rk: string;
      if (nk && picksHaveNbrs) {
        if (!keepOn.has(nk)) { counts.planned++; continue; }
        rk = nk;
      } else {
        rk = rowRouteKey(r);
        if (!rk || !keepOn.has(rk)) { counts.planned++; continue; }
        // A row that carries no load number, under a name the roster gives two loads: it cannot be
        // tied to either, so it is neither kept on the picked one nor planned (review).
        if (ambiguousNames.has(rk)) { counts.ambiguous++; continue; }
      }
      if (earlier?.has(n)) seenEarlier.add(n);   // NuVizz has it on a picked load: kept there, as NuVizz says
      if (!at) { counts.keptNoLocation++; keptNoLocation.push(r); continue; }
      counts.kept++;
      if (at.corrected) counts.corrected++;
      kept.set(n, rk);
      chosen.push({ ...r, lat: at.lat, lng: at.lng });
      continue;
    }
    if (!at) {
      // An earlier section's stop that has lost its map point cannot ride the map, but it has not left
      // its truck: it is carried forward, and on a truck picked again its room is held back (review).
      const eNo = earlier?.get(n);
      if (eNo) {
        seenEarlier.add(n);
        counts.earlierNoLocation++;
        carried.push({ n, ...eNo });
        const idx = pickOf.get(eNo.key);
        if (idx != null) heldEarlier.push({ r, idx });
        continue;
      }
      counts.noLocation++; noLocation.push(r); continue;
    }
    const e = earlier?.get(n);
    if (e) {
      seenEarlier.add(n);
      const idx = pickOf.get(e.key);
      if (idx == null) { counts.earlierCarried++; carried.push({ n, ...e }); continue; }
      counts.earlierKept++;
      if (at.corrected) counts.corrected++;
      pinTo.set(n, idx);
      chosen.push({ ...r, lat: at.lat, lng: at.lng });
      continue;
    }
    if (section && !section.has(n)) { counts.leftForLater++; continue; }
    if (at.corrected) counts.corrected++;
    chosen.push({ ...r, lat: at.lat, lng: at.lng });
    free.add(n);
    const day = r.carryover === true && typeof r.scheduledDate === 'string' ? r.scheduledDate : date;
    counts.byDay[day] = (counts.byDay[day] || 0) + 1;
  }
  const earlierDropped = earlier ? [...earlier.keys()].filter((n) => !seenEarlier.has(n)) : [];
  counts.earlierDropped = earlierDropped.length;
  const sectionMissing: string[] = [];
  if (section) {
    for (const n of section) {
      if (free.has(n) || kept.has(n)) continue;
      if (earlier?.has(n)) { counts.sectionAlreadyPlaced++; continue; }
      sectionMissing.push(n);
    }
    counts.sectionMissing = sectionMissing.length;
  }
  counts.toPlan = chosen.length - kept.size - pinTo.size;
  return { chosen, noLocation, kept, keptNoLocation, counts, pinTo, carried, earlierDropped, sectionMissing, heldEarlier };
}

export interface PlanInput {
  params: PlanParams;
  chosen: any[]; noLocation: any[]; counts: PlanStopCounts; carry: CarryoverStats | null;
  kept?: Map<string, string>;                   // stopNbr → route key of the picked load it is already on
  keptNoLocation?: any[];                       // kept stops with no location: room held back on their load
  pinTo?: Map<string, number>;                  // v1.78.0: stopNbr → index of the pick an earlier section put it on
  carried?: ({ n: string } & EarlierPlacement)[];  // earlier sections' stops on loads not picked here
  earlierDropped?: string[];                    // earlier sections' stops no longer open and free on the board
  heldEarlier?: { r: any; idx: number }[];      // earlier sections' stops with no map point on a load picked again: room held back
  leftOffBefore?: { n: string; reason: string }[];  // the stops the earlier sections left off, with Claude's reason
  roster: any[] | null;
  employees: any[];
  notes: Map<string, any>;
  model: any;                                   // the learned capacity model (claude_shadow_learned)
  caps: { drivers: Record<string, any>; routes: Record<string, any> } | null;
  ceilings: { box_truck: number; tractor: number };
  hardCaps: boolean;
  loosePerSkid: number; capRule: CapRule;
  lbsLimits: { box_truck: number; tractor: number };
  depot: { lat: number; lng: number };
  cfg: any; at: string;
  boardScannedAt: string | null;
}


/** The customer key a board row's equipment notes are filed under (history-derive.mts stopMatchKey). */
export const rowMatchKey = (r: any) => normalizeMatchKey(r?.businessName || '', r?.addr1 || '', r?.city || '', r?.zip || '');

/**
 * Where a stop IS: the dispatcher's corrected pin (customer_notes.location_override — the Map draws
 * it in place of the feed's geocode) when one is saved, else the feed's own coordinates. Strict
 * numbers: Number(null) is 0 and 0 is finite (CLAUDE.md).
 */
const numOr = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
export function locateRow(r: any, notes: Map<string, any>): { lat: number; lng: number; corrected: boolean } | null {
  const ov = notes.get(rowMatchKey(r))?.location_override;
  const oLat = numOr(ov?.lat), oLng = numOr(ov?.lng);
  if (oLat != null && oLng != null && usableCoords(oLat, oLng)) return { lat: oLat, lng: oLng, corrected: true };
  return usableCoords(r?.lat, r?.lng) ? { lat: Number(r.lat), lng: Number(r.lng), corrected: false } : null;
}

/** A plan day → the problem Claude plans (a BtProblem in plan mode: loads with no dispatch column). */
export function buildPlanProblem(input: PlanInput): BtProblem {
  const { params } = input;
  const hard = input.hardCaps !== false;
  const ceilings = hard ? input.ceilings : null;
  // No learned model yet (a new site): the caps you typed still hold — an empty model carries them as its only rows.
  const model = withOverrides(input.model || { drivers: [], routes: [] }, input.caps || { drivers: {}, routes: {} });
  const dRows = new Map((model?.drivers || []).map((r: any) => [r.key, r]));
  const rRows = new Map((model?.routes || []).map((r: any) => [r.key, r]));
  const empClass = employeeClassMap(input.employees || []);
  const shiftMin = Math.round(Number(input.cfg?.typical_shift_hours) * 60) || 600;
  const serviceMin = DEFAULT_SERVICE_MIN;

  // LOADS, as picked.
  const capsHeld = { box_truck: { held: 0, of: 0 }, tractor: { held: 0, of: 0 } };
  const loads: BtLoad[] = params.picks.map((pk, i) => {
    const driver = pk.driver || '(no driver)';
    const dk = classKey(pk.driver || '');
    const fromRoster = pk.driver ? empClass.get(dk) : undefined;
    const pinned = pk.driver ? CLASS_OVERRIDE.get(dk) : undefined;
    const cls = (pk.cls || fromRoster || pinned || 'box_truck') as BtLoad['cls'];
    // Where the class came from: the dispatcher's pick, else the employees roster, else the one pin, else the default.
    const clsSource: BtLoad['clsSource'] = pk.cls ? 'pin' : fromRoster ? 'roster' : pinned ? 'pin' : 'default';
    const base = pk.kind === 'truck'
      ? capFor(null, null, input.capRule, cls, ceilings)
      : capFor(dRows.get(keyOf(pk.driver || '')), rRows.get(keyOf(pk.route)), input.capRule, cls, ceilings);
    if (base.learned != null) capsHeld[cls].of += 1;
    let capNote: string | null = null;
    if (base.clipped && base.learned != null) { capsHeld[cls].held += 1; capNote = `learned ${base.learned} held to the ${cls === 'tractor' ? 'tractor' : 'box-truck'} ceiling ${base.ceiling}`; }
    else if (base.clipped) capNote = `your route cap ${base.typed} held to the ${cls === 'tractor' ? 'tractor' : 'box-truck'} ceiling ${base.ceiling} — a route cap is held to the truck that runs it`;
    return {
      id: `L${i + 1}`, route: pk.route, driver, cls, clsSource,
      // The NuVizz load number, from the day's roster, for a picked roster load — so the model is told
      // WHICH load, not just a route name that repeats every day.
      ...(pk.kind === 'roster' && pk.loadNbr ? { loadNbr: pk.loadNbr } : {}),
      cap: r1(base.cap), capSource: pk.kind === 'truck' ? `${base.source} — an unnamed truck` : base.source, capNote,
      dispatch: [], orderSource: 'driven',
      maxMin: shiftMin, maxMinNote: null,
      maxLbs: input.lbsLimits[cls] ?? PROFILE_MAX_LBS[cls], lbsNote: null, lbsRaisedFrom: null,
    };
  });

  // THE PICKED ROSTER LOADS: a stop already on one in NuVizz is kept on it. By the roster LOAD NUMBER
  // first — the scan writes the one that holds each routed row (rosterLoadNbr, v1.82.0) — and by route
  // name only for a row that carries none; two picks under one name then fall to the first, and the note
  // says so.
  const loadOfRoute = new Map<string, BtLoad>();
  params.picks.forEach((pk, i) => {
    if (pk.kind !== 'roster') return;
    // By number first: a row the scan tied to this load by its roster number finds it here.
    if (pk.loadNbr && !loadOfRoute.has(`nbr:${pk.loadNbr}`)) loadOfRoute.set(`nbr:${pk.loadNbr}`, loads[i]);
    const k = keyOf(pk.route);
    if (!loadOfRoute.has(k)) loadOfRoute.set(k, loads[i]);
    else { const l = loads[i]; l.capNote = `${l.capNote ? l.capNote + '; ' : ''}stops already on ${pk.route} in NuVizz are kept on ${loadOfRoute.get(k)!.id}, the first load picked under that name`; }
  });
  // Kept stops with no location ride on their load all the same: their room is held back, as a backtest
  // does — and so do an earlier section's stops that have lost their map point, on a load picked again.
  const held: { r: any; l: BtLoad | undefined }[] = [
    ...(input.keptNoLocation || []).map((r) => ({ r, l: (rowLoadNbrKey(r) && loadOfRoute.get(rowLoadNbrKey(r)!)) || loadOfRoute.get(rowRouteKey(r)) })),
    ...(input.heldEarlier || []).map((h) => ({ r: h.r, l: loads[h.idx] })),
  ];
  for (const { r, l } of held) {
    if (!l) continue;
    const spots = skidSpots(num(r.cartons) ?? 0, num(r.volume) ?? 0, input.loosePerSkid), lbs = Math.round(num(r.weight) ?? 0);
    (l as any)._heldSpots = ((l as any)._heldSpots || 0) + spots;
    (l as any)._heldLbs = ((l as any)._heldLbs || 0) + lbs;
    (l as any)._heldStops = ((l as any)._heldStops || 0) + 1;
  }
  for (const l of loads) {
    const hs = (l as any)._heldStops || 0;
    if (!hs) continue;
    const spots = r1((l as any)._heldSpots), lbs = (l as any)._heldLbs;
    l.capNote = `${l.capNote ? l.capNote + '; ' : ''}${spots} of ${l.cap} held back for ${hs} stop${hs === 1 ? '' : 's'} on it with no location`;
    l.cap = r1(Math.max(0, l.cap - spots));
    if (typeof l.maxLbs === 'number' && lbs > 0) { l.lbsNote = `${lbs} of ${l.maxLbs} lb held back for ${hs} stop${hs === 1 ? '' : 's'} on it with no location`; l.maxLbs = Math.max(0, l.maxLbs - lbs); }
    delete (l as any)._heldSpots; delete (l as any)._heldLbs; delete (l as any)._heldStops;
  }

  // STOPS, numbered by place (zone, then position) exactly as a backtest's are.
  const built: BtStop[] = input.chosen.map((r, i) => {
    const s = toBtStop({ ...r, customerMatchKey: rowMatchKey(r) }, i + 1, String(r.stopNbr), input.loosePerSkid, input.notes);
    s.day = r.carryover === true && typeof r.scheduledDate === 'string' ? r.scheduledDate : params.date;
    const rk = input.kept?.get(String(r.stopNbr));
    if (rk) { s.pin = loadOfRoute.get(rk)?.id ?? null; if (s.pin) s.pinFrom = 'nuvizz'; }
    else {
      // v1.78.0: an earlier section put it on a load picked again here — it stays on that load.
      const idx = input.pinTo?.get(String(r.stopNbr));
      if (idx != null && loads[idx]) { s.pin = loads[idx].id; s.pinFrom = 'section'; }
    }
    return s;
  });
  const order = built.slice().sort((a, b) => a.zone.localeCompare(b.zone) || b.lat - a.lat || a.lng - b.lng || a.n.localeCompare(b.n));
  order.forEach((s, i) => { s.id = i + 1; });

  const counts = input.counts;
  const carry = input.carry;
  // SECTIONS (v1.78.0): the loads' identities (so the next section knows which is which), and what the
  // earlier sections placed that this plan does not hold — carried forward with its result.
  const loadKeys = params.picks.map((pk, i) => ({ id: loads[i].id, key: pickIdentity(pk) }));
  const sectionInfo = params.section || params.after ? {
    picked: params.section ? params.section.length : null,
    after: params.after,
    carried: (input.carried || []).map((c) => ({ n: c.n, key: c.key, route: c.route, driver: c.driver, cls: c.cls })),
    dropped: (input.earlierDropped || []).slice(0, 200),
    leftOff: (input.leftOffBefore || []).slice(0, 2000),
  } : null;
  const sectionLines: string[] = [];
  if (params.section) sectionLines.push(`This is a SECTION: only the ${params.section.length} stop${params.section.length === 1 ? '' : 's'} picked on the map are placed${counts.leftForLater ? `; ${counts.leftForLater} other open stop${counts.leftForLater === 1 ? ' is' : 's are'} left for another section` : ''}${counts.sectionMissing ? `; ${counts.sectionMissing} picked ${counts.sectionMissing === 1 ? 'is' : 'are'} not plannable now (no longer open, on a load not picked, or with no map point)` : ''}.`);
  if (params.after) sectionLines.push(`It builds on an earlier section: ${counts.earlierKept} stop${counts.earlierKept === 1 ? '' : 's'} it placed on loads picked again stay on them, their room counted (on such a truck the order of all its stops is worked out afresh with the new ones); ${counts.earlierCarried} on loads not picked here ${counts.earlierCarried === 1 ? 'is' : 'are'} carried forward as placed${counts.earlierNoLocation ? `; ${counts.earlierNoLocation} ${counts.earlierNoLocation === 1 ? 'has' : 'have'} lost ${counts.earlierNoLocation === 1 ? 'its' : 'their'} map point and ${counts.earlierNoLocation === 1 ? 'is' : 'are'} carried forward, room held back on a truck picked again` : ''}${counts.earlierDropped ? `; ${counts.earlierDropped} ${counts.earlierDropped === 1 ? 'is' : 'are'} dropped: no longer open${params.scope === 'unplanned' ? ', or now on a load in NuVizz' : ''}` : ''}. ${params.scope === 'unplanned'
    ? 'NuVizz outranks an earlier section: a stop on a load in NuVizz now is where NuVizz has it.'
    : 'Every open stop is re-planned here, so an earlier section’s placement stands even where NuVizz has the stop on a load now.'}`);
  return {
    mode: 'plan',
    loadKeys,
    section: sectionInfo,
    date: params.date, loosePerSkid: input.loosePerSkid, capRule: input.capRule,
    lbsLimits: input.lbsLimits,
    lbsRaised: { box_truck: { raised: 0, of: 0, heaviest: 0 }, tractor: { raised: 0, of: 0, heaviest: 0 } },
    capMode: hard ? 'hard' : 'raised', ceilings, capsHeld, dispatchOver: { cap: 0, lbs: 0 },
    depot: input.depot, serviceMin, shiftMin,
    loads, stops: order,
    excluded: { noCoords: input.noLocation.map((r) => ({ n: String(r.stopNbr), route: String(r.routeName || '') })), duplicate: [] },
    counts, roster: input.roster ? 'read' : 'none', stampGate: 'applied',
    capModel: { days: input.model?.days?.count ?? 0, first: input.model?.days?.first ?? null, last: input.model?.days?.last ?? null },
    approximations: [
      `The stops are the ${params.date} board as the last scan left it${input.boardScannedAt ? ` (${input.boardScannedAt})` : ''} — read from Firestore, not NuVizz — through the Map's own filters. ${params.scope === 'unplanned'
        ? `Only unplanned deliveries are placed. ${counts.kept + counts.keptNoLocation ? `The ${counts.kept + counts.keptNoLocation} stop${counts.kept + counts.keptNoLocation === 1 ? '' : 's'} already on the picked loads in NuVizz stay on them, their room counted${counts.keptNoLocation ? ` (${counts.keptNoLocation} with no location, held back)` : ''}; ` : ''}${counts.planned ? `the ${counts.planned} on loads not picked stay where they are and are not planned here.` : 'no other stop is on a load.'}`
        : 'Every open delivery is re-planned, including the ones already on loads in NuVizz: stops on loads not picked are moved onto the picked ones.'}`,
      params.lookbackDays
        ? `Unplanned orders from the ${params.lookbackDays} day${params.lookbackDays === 1 ? '' : 's'} before are folded in by the Map's carry-over rule${carry ? ` (judged by ${carry.basis === 'pool' ? 'the open-order pool' : carry.basis === 'snapshot' ? 'the unplanned snapshot' : 'nothing — every prior-day unplanned row folded in, none dropped'}; ${carry.added} added, ${carry.pruned} dropped as closed or moved${carry.unverified ? `, ${carry.unverified} older than any scan can confirm` : ''})` : ''}.`
        : 'No look-back: orders filed on earlier days are not included.',
      ...sectionLines,
      'Truck class is each driver’s CURRENT MarginIQ vehicle type (or the class you picked).',
      ...(counts.corrected ? [`${counts.corrected} stop${counts.corrected === 1 ? ' is' : 's are'} placed at a pin a dispatcher corrected (customer notes), where the Map draws ${counts.corrected === 1 ? 'it' : 'them'}, not at the feed’s geocode.`] : []),
      ...(counts.ambiguous ? [`${counts.ambiguous} stop${counts.ambiguous === 1 ? '' : 's'} on a picked route name that the roster gives to more than one load ${counts.ambiguous === 1 ? 'is' : 'are'} left out: ${counts.ambiguous === 1 ? 'its row carries' : 'their rows carry'} no roster load number yet (the scan writes one once it has read which load holds ${counts.ambiguous === 1 ? 'it' : 'them'}), and the name alone cannot say which of them carries ${counts.ambiguous === 1 ? 'it' : 'them'}.`] : []),
      ...(counts.keptNoLocation ? [`${counts.keptNoLocation} stop${counts.keptNoLocation === 1 ? '' : 's'} already on a picked load ${counts.keptNoLocation === 1 ? 'has' : 'have'} no map point: ${counts.keptNoLocation === 1 ? 'its' : 'their'} skid spots and pounds are held back on that load; the time ${counts.keptNoLocation === 1 ? 'it takes' : 'they take'} on the driver’s day is not.`] : []),
      hard
        ? `Skid caps HOLD: a cap you typed on a driver stands; a cap typed on a route, or a learned cap, is held to the class ceiling of the truck (box ${ceilings!.box_truck} spots, tractor ${ceilings!.tractor}); a driver with no history, or an unnamed truck, is held to the truck’s rating.`
        : 'Hard caps are off (SHADOW_HARD_CAPS=off): learned caps are not held to a ceiling.',
      `Weight limits are Router settings (box ${input.lbsLimits.box_truck.toLocaleString('en-US')} lb, tractor ${input.lbsLimits.tractor.toLocaleString('en-US')} lb) and hold.`,
      `A driver’s day is drive minutes plus a flat ${serviceMin} min on site a stop, against the engine’s typical shift of ${shiftMin / 60} h.`,
      'Equipment limits (no 53′, box only) are the CURRENT customer notes. Delivery windows are not a constraint.',
      'Miles and drive minutes are the learned engine’s estimate (straight line × road factor, tiered speeds), open tour from Buford.',
    ],
  } as BtProblem;
}

/** What the picked loads can carry against what there is to carry — before any spend. */
export function planCapacity(p: BtProblem) {
  const spots = r1(p.stops.reduce((a, s) => a + s.spots, 0));
  const lbs = p.stops.reduce((a, s) => a + s.weight, 0);
  const capSpots = r1(p.loads.reduce((a, l) => a + l.cap, 0));
  const capLbs = p.loads.reduce((a, l) => a + (l.maxLbs ?? 0), 0);
  const noTractor = p.stops.filter((s) => s.blocksTractor);
  const boxCap = r1(p.loads.filter((l) => l.cls !== 'tractor').reduce((a, l) => a + l.cap, 0));
  const noTractorSpots = r1(noTractor.reduce((a, s) => a + s.spots, 0));
  // One day per DRIVER: loads that share a driver share one shift (the evaluator's rule), so the
  // gauge adds each driver's day once, not once per load (review).
  const dayOf = new Map<string, number>();
  for (const l of p.loads) dayOf.set(driverKey(l), Math.max(dayOf.get(driverKey(l)) ?? 0, l.maxMin));
  const dayMin = [...dayOf.values()].reduce((a, v) => a + v, 0);
  const serviceNeed = p.stops.length * (p.serviceMin ?? DEFAULT_SERVICE_MIN);
  return {
    stops: p.stops.length, kept: p.stops.filter((s) => s.pin).length, spots, lbs, capSpots, capLbs, loads: p.loads.length,
    noTractorStops: noTractor.length, noTractorSpots, boxCapSpots: boxCap,
    // On-site time alone against every driver's day added up: a floor, before any driving.
    serviceMin: serviceNeed, dayMin,
    short: {
      spots: spots > capSpots ? r1(spots - capSpots) : 0,
      lbs: lbs > capLbs ? lbs - capLbs : 0,
      noTractor: noTractorSpots > boxCap ? r1(noTractorSpots - boxCap) : 0,
      time: serviceNeed > dayMin ? serviceNeed - dayMin : 0,
    },
  };
}

/**
 * KEPT STOPS THAT BREAK A RULE ON THEIR OWN LOAD (review, v1.76.0). A stop already on a picked load is
 * kept there, so if what is on that load in NuVizz is already past its cap, its weight limit, its
 * equipment rule or its driver's day, NO plan can pass the evaluator. Measured with the evaluator's
 * own measure over the kept stops alone, and said before anything is spent — the plan is refused, as
 * a backtest day that cannot be planned is.
 */
export function keptProblems(p: BtProblem, cfg: any): string[] {
  return keptProblemsDetail(p, cfg).map((x) => x.text);
}

/** keptProblems, each saying whether an earlier section's stops are part of it (review, v1.78.0). */
export function keptProblemsDetail(p: BtProblem, cfg: any): { text: string; section: boolean }[] {
  const assign = new Map<string, number[]>();
  for (const s of p.stops) if (s.pin) assign.set(s.pin, [...(assign.get(s.pin) || []), s.id]);
  if (!assign.size) return [];
  const m = measurePlan(p, assign, cfg, makeSequencer(p, cfg), 0);
  const out: { text: string; section: boolean }[] = [];
  for (const l of m.loads) {
    const L = p.loads.find((x) => x.id === l.id);
    if (!L) continue;
    // Where the stops already on it came from: NuVizz, an earlier section (v1.78.0), or both.
    const from = new Set(p.stops.filter((s) => s.pin === l.id).map((s) => (s.pinFrom === 'section' ? 'section' : 'nuvizz')));
    const where = from.has('section') && from.has('nuvizz') ? 'in NuVizz and from the earlier section' : from.has('section') ? 'from the earlier section' : 'in NuVizz';
    const sec = from.has('section');
    if (l.over) out.push({ section: sec, text: `${L.route} already carries ${r1(l.spots)} skid spots ${where}, past its cap of ${r1(l.cap)}` });
    if (l.overWeight) out.push({ section: sec, text: `${L.route} already carries ${Math.round(l.weight).toLocaleString('en-US')} lb ${where}, past its ${Math.round(l.maxLbs).toLocaleString('en-US')} lb limit` });
    if (l.blocked) out.push({ section: sec, text: `${L.route} is a tractor already carrying ${l.blocked} no-tractor stop${l.blocked === 1 ? '' : 's'} ${where}` });
    if (l.overTime) out.push({ section: sec, text: `${L.driver}'s day with only the stops already on ${L.route} runs ${Math.round(l.driverMin)} of ${Math.round(l.maxMin)} min` });
  }
  return out;
}

/**
 * ONE DRIVER, ONE DAY, ACROSS SECTIONS (review, v1.78.0). A stop an earlier section put on a load that is
 * not picked here leaves this plan — but it is still on its driver's day. If this plan hands that driver
 * another load, the evaluator could not see the first load's stops and would book the driver past his
 * day (or give him a second truck). So it is refused at $0, naming the driver and the load to pick again.
 */
export function sectionDriverConflicts(p: BtProblem): string[] {
  const carried = p.section?.carried || [];
  if (!carried.length) return [];
  const onLoad = new Map<string, { route: string; driver: string; n: number }>();
  for (const c of carried) {
    if (!c.driver || c.driver === '(no driver)') continue;
    const k = `${classKey(c.driver)}|${c.key}`;
    const cur = onLoad.get(k) || { route: c.route, driver: c.driver, n: 0 };
    cur.n += 1;
    onLoad.set(k, cur);
  }
  const out: string[] = [];
  for (const l of p.loads) {
    if (!l.driver || l.driver === '(no driver)') continue;
    const k = classKey(l.driver);
    for (const [kk, v] of onLoad) {
      if (!kk.startsWith(`${k}|`)) continue;
      out.push(`${v.driver} already has ${v.n} stop${v.n === 1 ? '' : 's'} from the earlier section on ${v.route}, which is not picked here — pick ${v.route} again (its stops stay on it and share the same day), or give ${l.route} another driver`);
    }
  }
  return [...new Set(out)];
}

/** Claude's final plan, measured and laid out for the screen — a plan has only Claude's column. */
export function planResultFrom(p: BtProblem, plan: any, cfg: any, rates: CostRates) {
  const seq = makeSequencer(p, cfg);
  const assign = new Map<string, number[]>();
  for (const e of plan?.loads || []) assign.set(String(e.load), (e.stops || []).map(Number));
  const unplannedIn = (plan?.unplanned || []) as any[];
  const m = measurePlan(p, assign, cfg, seq, unplannedIn.length);
  const byId = new Map(p.stops.map((s) => [s.id, s]));
  const why = new Map<string, string>((plan?.loads || []).map((e: any) => [String(e.load), typeof e.why === 'string' ? e.why.slice(0, 300) : '']));
  const kept = p.stops.filter((s) => s.pin).length;
  // WHERE CLAUDE PUT EACH STOP, by stop number (v1.78.0): the next section reads this to keep them on their
  // loads, with loadKeys saying which load is which. Claude's placements only — including the ones an
  // earlier section made — never a stop kept because NuVizz has it on the load: NuVizz says where that
  // one is, section after section (a pin with no pinFrom predates sections and is NuVizz's). The stops
  // left off are free again.
  const placements: { n: string; load: string }[] = [];
  for (const [load, ids] of assign) {
    if (!p.loads.some((l) => l.id === load)) continue;
    for (const id of ids) { const s = byId.get(id); if (s && (!s.pin || s.pinFrom === 'section')) placements.push({ n: String(s.n).trim(), load }); }
  }
  // THE LEFT-OFF RECORD (review): what the earlier sections left off and this one did not place, and
  // what this one left off — so the next section's map can say why a free stop was left off before.
  const placedN = new Set(placements.map((x) => x.n));
  const leftNow = unplannedIn.map((u: any) => { const s = byId.get(Number(u?.stop)); return s ? { n: String(s.n).trim(), reason: String(u?.reason || '').slice(0, 300) } : null; }).filter(Boolean) as { n: string; reason: string }[];
  const leftOff = new Map<string, string>();
  for (const x of ((p as any).section?.leftOff || []) as { n: string; reason: string }[]) if (!placedN.has(x.n)) leftOff.set(x.n, x.reason);
  for (const x of leftNow) leftOff.set(x.n, x.reason);
  const section = (p as any).section ? { ...(p as any).section, leftOff: [...leftOff].slice(0, 2000).map(([n, reason]) => ({ n, reason })) } : null;
  return {
    columns: { claude: m.totals },
    placements,
    loadKeys: (p as any).loadKeys ?? null,
    section,
    kept,                                  // of the stops on Claude's trucks, how many were already there (NuVizz, or an earlier section)
    cost: planCost(m.totals, rates),
    loads: p.loads.map((l) => {
      const c = m.loads.find((x) => x.id === l.id) || null;
      return {
        id: l.id, route: l.route, driver: l.driver, cls: l.cls, clsSource: l.clsSource, cap: l.cap, capSource: l.capSource, capNote: l.capNote,
        maxLbs: l.maxLbs ?? null, maxMin: l.maxMin, orderSource: l.orderSource, lbsNote: l.lbsNote ?? null,
        kept: p.stops.filter((s) => s.pin === l.id).length,
        earlier: p.stops.filter((s) => s.pin === l.id && s.pinFrom === 'section').length,
        driven: null, reseq: null, claude: c, why: why.get(l.id) || null,
      };
    }),
    unused: p.loads.filter((l) => !m.loads.some((x) => x.id === l.id)).map((l) => ({ id: l.id, route: l.route, driver: l.driver })),
    unplanned: unplannedIn.map((u: any) => {
      const s = byId.get(Number(u?.stop));
      return { stop: Number(u?.stop), n: s?.n ?? null, name: s?.name ?? null, city: s?.city ?? null, day: s?.day ?? null, spots: s?.spots ?? null, lbs: s?.weight ?? null, reason: String(u?.reason || '') };
    }),
  };
}

export { tourLegs, driverKey };
