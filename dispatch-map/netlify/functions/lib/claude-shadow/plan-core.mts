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
// No I/O here: lib/claude-shadow/plan.mts reads the documents and calls these.
import { type CarryoverStats } from '../carryover-fold.mts';
import { normalizeMatchKey } from '../../../../src/lib/matchKey.js';
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
export interface PlanParams { date: string; lookbackDays: number; scope: PlanScope; picks: PlanPick[] }

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
  return errors.length ? { ok: false, errors, params: null } : { ok: true, errors: [], params: { date, lookbackDays, scope, picks } };
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
  noLocation: number; toPlan: number;     // toPlan: the stops Claude places (kept ones not included)
  byDay: Record<string, number>;          // the stops to plan, by the board day each is filed on
}

/** The key a board row's load goes by: its route name (a board row's loadNbr is the route name too). */
export const rowRouteKey = (r: any) => keyOf(String(r?.routeName || r?.loadNbr || ''));

/**
 * Of the board rows, the deliveries still to plan — and, counted, every row that is not.
 * `keepOn` is the route keys of the PICKED roster loads: with scope 'unplanned', a stop already on one
 * of them in NuVizz is KEPT — chosen, and pinned to that load — because that truck is carrying it
 * whatever Claude proposes, and a plan that ignored it would promise room the truck does not have.
 */
export function selectPlanStops(
  rows: any[], date: string, scope: PlanScope, cancelled = 0, keepOn: Set<string> = new Set(),
  locate: (r: any) => { lat: number; lng: number; corrected: boolean } | null = (r) => (usableCoords(r?.lat, r?.lng) ? { lat: Number(r.lat), lng: Number(r.lng), corrected: false } : null),
  ambiguousNames: Set<string> = new Set(),
): { chosen: any[]; noLocation: any[]; kept: Map<string, string>; keptNoLocation: any[]; counts: PlanStopCounts } {
  const counts: PlanStopCounts = { onBoard: rows.length, carried: 0, cancelled, pickups: 0, finished: 0, planned: 0, kept: 0, keptNoLocation: 0, ambiguous: 0, corrected: 0, noLocation: 0, toPlan: 0, byDay: {} };
  const chosen: any[] = [], noLocation: any[] = [], keptNoLocation: any[] = [];
  const kept = new Map<string, string>();
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
      const rk = rowRouteKey(r);
      if (!rk || !keepOn.has(rk)) { counts.planned++; continue; }
      // A board row names its load by route only; when the roster has two loads under that name the
      // row cannot be tied to either, so it is neither kept on the picked one nor planned (review).
      if (ambiguousNames.has(rk)) { counts.ambiguous++; continue; }
      if (!at) { counts.keptNoLocation++; keptNoLocation.push(r); continue; }
      counts.kept++;
      if (at.corrected) counts.corrected++;
      kept.set(n, rk);
      chosen.push({ ...r, lat: at.lat, lng: at.lng });
      continue;
    }
    if (!at) { counts.noLocation++; noLocation.push(r); continue; }
    if (at.corrected) counts.corrected++;
    chosen.push({ ...r, lat: at.lat, lng: at.lng });
    const day = r.carryover === true && typeof r.scheduledDate === 'string' ? r.scheduledDate : date;
    counts.byDay[day] = (counts.byDay[day] || 0) + 1;
  }
  counts.toPlan = chosen.length - kept.size;
  return { chosen, noLocation, kept, keptNoLocation, counts };
}

export interface PlanInput {
  params: PlanParams;
  chosen: any[]; noLocation: any[]; counts: PlanStopCounts; carry: CarryoverStats | null;
  kept?: Map<string, string>;                   // stopNbr → route key of the picked load it is already on
  keptNoLocation?: any[];                       // kept stops with no location: room held back on their load
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
      cap: r1(base.cap), capSource: pk.kind === 'truck' ? `${base.source} — an unnamed truck` : base.source, capNote,
      dispatch: [], orderSource: 'driven',
      maxMin: shiftMin, maxMinNote: null,
      maxLbs: input.lbsLimits[cls] ?? PROFILE_MAX_LBS[cls], lbsNote: null, lbsRaisedFrom: null,
    };
  });

  // THE PICKED ROSTER LOADS, by route: a stop already on one in NuVizz is kept on it. Two picks under
  // one route name cannot be told apart on the board (its rows carry the route name, no load id), so
  // the first takes them, and the note says so.
  const loadOfRoute = new Map<string, BtLoad>();
  params.picks.forEach((pk, i) => {
    if (pk.kind !== 'roster') return;
    const k = keyOf(pk.route);
    if (!loadOfRoute.has(k)) loadOfRoute.set(k, loads[i]);
    else { const l = loads[i]; l.capNote = `${l.capNote ? l.capNote + '; ' : ''}stops already on ${pk.route} in NuVizz are kept on ${loadOfRoute.get(k)!.id}, the first load picked under that name`; }
  });
  // Kept stops with no location ride on their load all the same: their room is held back, as a backtest does.
  for (const r of input.keptNoLocation || []) {
    const l = loadOfRoute.get(rowRouteKey(r));
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
    if (rk) s.pin = loadOfRoute.get(rk)?.id ?? null;
    return s;
  });
  const order = built.slice().sort((a, b) => a.zone.localeCompare(b.zone) || b.lat - a.lat || a.lng - b.lng || a.n.localeCompare(b.n));
  order.forEach((s, i) => { s.id = i + 1; });

  const counts = input.counts;
  const carry = input.carry;
  return {
    mode: 'plan',
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
      'Truck class is each driver’s CURRENT MarginIQ vehicle type (or the class you picked).',
      ...(counts.corrected ? [`${counts.corrected} stop${counts.corrected === 1 ? ' is' : 's are'} placed at a pin a dispatcher corrected (customer notes), where the Map draws ${counts.corrected === 1 ? 'it' : 'them'}, not at the feed’s geocode.`] : []),
      ...(counts.ambiguous ? [`${counts.ambiguous} stop${counts.ambiguous === 1 ? '' : 's'} on a picked route name that the roster gives to more than one load ${counts.ambiguous === 1 ? 'is' : 'are'} left out: the board names a load by route only, so it cannot say which of them carries ${counts.ambiguous === 1 ? 'it' : 'them'}.`] : []),
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
  const assign = new Map<string, number[]>();
  for (const s of p.stops) if (s.pin) assign.set(s.pin, [...(assign.get(s.pin) || []), s.id]);
  if (!assign.size) return [];
  const m = measurePlan(p, assign, cfg, makeSequencer(p, cfg), 0);
  const out: string[] = [];
  for (const l of m.loads) {
    const L = p.loads.find((x) => x.id === l.id);
    if (!L) continue;
    if (l.over) out.push(`${L.route} already carries ${r1(l.spots)} skid spots in NuVizz, past its cap of ${r1(l.cap)}`);
    if (l.overWeight) out.push(`${L.route} already carries ${Math.round(l.weight).toLocaleString('en-US')} lb in NuVizz, past its ${Math.round(l.maxLbs).toLocaleString('en-US')} lb limit`);
    if (l.blocked) out.push(`${L.route} is a tractor already carrying ${l.blocked} no-tractor stop${l.blocked === 1 ? '' : 's'} in NuVizz`);
    if (l.overTime) out.push(`${L.driver}'s day with only the stops already on ${L.route} runs ${Math.round(l.driverMin)} of ${Math.round(l.maxMin)} min`);
  }
  return out;
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
  return {
    columns: { claude: m.totals },
    kept,                                  // of the stops on Claude's trucks, how many were already there in NuVizz
    cost: planCost(m.totals, rates),
    loads: p.loads.map((l) => {
      const c = m.loads.find((x) => x.id === l.id) || null;
      return {
        id: l.id, route: l.route, driver: l.driver, cls: l.cls, clsSource: l.clsSource, cap: l.cap, capSource: l.capSource, capNote: l.capNote,
        maxLbs: l.maxLbs ?? null, maxMin: l.maxMin, orderSource: l.orderSource, lbsNote: l.lbsNote ?? null,
        kept: p.stops.filter((s) => s.pin === l.id).length,
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
