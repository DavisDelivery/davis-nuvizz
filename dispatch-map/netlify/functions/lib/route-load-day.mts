// lib/route-load-day.mts — AN ORDER ON A LOAD IS FILED ON THAT LOAD'S DAY (v1.82.0).
//
// Chad, 2026-09-27, with WHITING TURNER 007182304-1 (11 skids) and POREX on Monday's MARCUS and
// both of them missing from Monday's MARCUS card: "It shouldn't move the day at all should just
// show them as unplanned. On any given day we could be planning unplanned orders from previous
// day." And, the same evening: "the roster scan produces the load numbers" — then: "I want
// every part of app to know and use the proper load numbers for the correct day."
//
// WHAT WAS WRONG. The stop list (saved search 77128) names a stop's route by NAME only, and
// NuVizz never moves an order's Estimated Arrival forward when the order is planned onto a later
// load. boardDayFor (nuvizz-list.mts) therefore filed every OPEN, routed order dated before today
// onto TODAY — so Friday's leftovers planned onto Monday's MARCUS sat on Saturday's board as
// Saturday's MARCUS stops, Monday's MARCUS card read 17 sk / 9,074 lb against NuVizz's 29 sk /
// 15,807 lb, and TERRANCE's undelivered Friday freight read as Saturday route work instead of
// orders waiting to be planned.
//
// WHAT THE SYSTEM ALREADY HOLDS (CLAUDE.md, "THE ROSTER SCAN HAS THE LOAD NUMBERS"). Every day's
// load roster (saved search 35833) carries each load's NUMBER, id, route name, driver, status and
// stop count. Which orders a load holds is ONE /load/info read by that number
// (lookupLoadStopNbrs). So the day an order belongs to is never guessed from its name:
//
//   • it is ON a load from today on  → it is filed on THAT load's day, stamped with the load's
//                                      number and id (loadDay / rosterLoadNbr / rosterLoadId);
//   • it is still on its own PAST day's load, undelivered, and no load from today on holds it
//                                    → it is shown UNPLANNED, in the pool, where on any given
//                                      day a dispatcher plans the previous days' leftovers — with
//                                      `heldOn` naming the load that still holds it in NuVizz
//                                      (NuVizz refuses to add it to another load until it comes
//                                      off that one, and the card must be able to say why);
//   • anything the reads cannot settle → exactly the filing it had before this module (the
//                                      live-route clamp). Nothing moves on a guess.
//
// PURE. No I/O, no clock, no env reads outside the two switch helpers: every decision here is
// testable on plain data. refresh-stops-core reads the rosters (Firestore, free) and the load
// memberships (one budgeted, memoised /load/info each) and hands them in.
//
// ROUTE_LOAD_DAY=off — see routeLoadDayEnabled — puts every side back at once: no reads, no
// stamps, boardDayFor ignores any stamp a previous run left, the demotion verify stops skipping.

import { isCancelledStatus, resolveNameOwner } from '../../../src/lib/route-status.js';

/** NUVIZZ_ROUTE_LOAD_DAY — house shape: default ON, an explicit off-word turns it off, and
 *  anything malformed leaves it ON (a typo must never silently disable a rule). */
export function routeLoadDayEnabled(env: any = process.env): boolean {
  const v = String(env?.NUVIZZ_ROUTE_LOAD_DAY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** How many /load/info reads one RUN may spend deciding which load holds an order. The rest
 *  come from the memo; a spent budget leaves the order exactly where it was filed before. */
export function routeLoadDayReadMax(env: any = process.env): number {
  const raw = String(env?.NUVIZZ_ROUTE_LOAD_DAY_READS ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

/** A membership read of a load from today on is re-asked after this long even when the roster's
 *  stop count has not moved; a PAST load (its day is over) is re-asked after the longer one. */
export const MEMO_TTL_CURRENT_MS = 6 * 60 * 60 * 1000;
export const MEMO_TTL_PAST_MS = 24 * 60 * 60 * 1000;

export interface RosterLoadRow {
  loadId?: string | null;
  name?: string | null;
  loadNbr?: string | null;
  status?: string | null;
  driver?: string | null;
  trips?: number | null;
}

/** One load, on one day, as the roster names it. */
export interface DayLoad {
  day: string;
  loadNbr: string;
  loadId: string | null;
  name: string;
  status: string | null;
  driver: string | null;
  trips: number | null;
}

export type Resolution =
  | { kind: 'load'; day: string; load: DayLoad }
  | { kind: 'held'; load: DayLoad }
  | { kind: 'unresolved'; reason: string };

export interface MemoEntry {
  /** when the load was read */
  at: string;
  /** the roster's stop count when it was read — a different count means a different load */
  trips: number | null;
  /** the load's stop numbers as read (raw + normalised, as lookupLoadStopNbrs returns them) */
  members: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nameKey = (v: any) => String(v ?? '').trim().toLowerCase();
/** The same normalisation lookupLoadStopNbrs stores beside each raw number. */
export const normNbr = (v: any) => String(v ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');

/** The day a row belongs to on its own account — Estimated Arrival, then Requested, then
 *  scheduled — before any filing rule moved it. */
export function ownDayOf(row: any): string | null {
  const d = row?.boardDate || row?.requestedDate || row?.scheduledDate || null;
  return typeof d === 'string' && DAY.test(d) ? d : null;
}

const isFinished = (row: any) => {
  const s = String(row?.normalizedStatus ?? '').toUpperCase();
  return s === 'DELIVERED' || s === 'EXCEPTION' || s === 'CANCELLED';
};

/** The route name a list row carries (the list puts it in both loadNbr and routeName). */
export function routeNameOf(row: any): string | null {
  const n = String(row?.routeName ?? row?.loadNbr ?? '').trim();
  return n || null;
}

/**
 * PURE. Is this the kind of row whose day the live-route clamp used to invent — OPEN, on a route
 * by the list's word, and dated before today (or undated)? `hasActiveOverride` is the caller's
 * "a dispatcher-set board date governs this stop" — those keep their filing untouched.
 */
export function isCarryCandidate(row: any, today: string, hasActiveOverride: (row: any) => boolean = () => false): boolean {
  if (!row || isFinished(row)) return false;
  if (!routeNameOf(row)) return false;
  if (row.isPlanned === false && row.isUnplanned === true) return false;   // the list itself says unplanned
  if (hasActiveOverride(row)) return false;
  const d = ownDayOf(row);
  return !d || d < today;
}

/** A roster row as a DayLoad, or null when it carries no load number. */
export function toDayLoad(day: string, l: RosterLoadRow | null | undefined): DayLoad | null {
  const loadNbr = String(l?.loadNbr ?? '').trim();
  if (!loadNbr) return null;
  const tripsN = Number(l?.trips);
  return {
    day, loadNbr,
    loadId: l?.loadId ? String(l.loadId) : null,
    name: String(l?.name ?? '').trim(),
    status: l?.status != null ? String(l.status) : null,
    driver: l?.driver != null ? String(l.driver) : null,
    trips: l?.trips == null || !Number.isFinite(tripsN) ? null : tripsN,
  };
}

/**
 * PURE. The live loads carrying `name` on the given days, from each day's roster. A cancelled
 * load never holds live freight. Two live loads under one name on one day are BOTH returned —
 * the membership read tells them apart; nothing here picks one by name.
 */
export function liveLoadsNamed(name: string, days: string[], rosters: Map<string, RosterLoadRow[] | null>): DayLoad[] {
  const k = nameKey(name);
  const out: DayLoad[] = [];
  const seen = new Set<string>();
  for (const day of days) {
    for (const l of rosters.get(day) || []) {
      if (nameKey(l?.name) !== k || isCancelledStatus(l?.status)) continue;
      const dl = toDayLoad(day, l);
      if (!dl || seen.has(dl.loadNbr)) continue;
      seen.add(dl.loadNbr);
      out.push(dl);
    }
  }
  return out;
}

/**
 * PURE. The load that owned `name` on the order's own (past) day, by the roster's own rule
 * (resolveNameOwner: a cancelled twin loses; two live loads means nobody speaks for the name).
 * null when that day's roster was never captured or the name is contested.
 */
export function ownDayLoad(name: string, ownDay: string | null, rosters: Map<string, RosterLoadRow[] | null>): DayLoad | null {
  if (!ownDay) return null;
  const loads = rosters.get(ownDay);
  if (!loads) return null;
  const { load, ambiguous } = resolveNameOwner(name, loads);
  if (ambiguous || !load || isCancelledStatus((load as any)?.status)) return null;
  return toDayLoad(ownDay, load as RosterLoadRow);
}

/** Does a read of a load hold this stop? Raw OR normalised, the way the read stores both. */
export function holds(members: Set<string> | null | undefined, stopNbr: any): boolean {
  if (!members) return false;
  const raw = String(stopNbr ?? '').trim();
  return !!raw && (members.has(raw) || members.has(normNbr(raw)));
}

/**
 * PURE. May a read stand for this load? An EMPTY read of a load the roster counts stops on is
 * NuVizz answering nothing, not "holds nothing" — the same rule as name-collision's
 * membershipUsable, so the two can never read one load two ways.
 */
export function readUsable(members: Set<string> | null | undefined, trips: number | null): boolean {
  if (!members) return false;
  return members.size > 0 || trips === 0;
}

const dayNameKey = (day: string, name: string) => `${day}\u0000${nameKey(name)}`;

/**
 * PURE. How many OPEN routed orders the board files under each route name on each day, by the
 * filing rule as it stands BEFORE this pass (`dayOf` is boardDayFor on unstamped rows). This is
 * the free half of CLAUDE.md's rule — "the roster's trips against the rows we hold under that
 * name on that day is the free trigger": a load is read only when its count disagrees with this.
 */
export function shownCounts(rows: any[], dayOf: (row: any) => string | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows || []) {
    if (!r || isFinished(r) || r.isPlanned !== true) continue;
    const name = routeNameOf(r);
    const day = dayOf(r);
    if (!name || !day) continue;
    const k = dayNameKey(day, name);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** PURE. A load on a LATER day can only hold our carried orders if it counts more orders than
 *  that day's board shows under its name. Unknown count → it might. */
export function hasRoom(l: DayLoad, shown: Map<string, number> | null | undefined): boolean {
  if (l.trips == null || !shown) return true;
  return l.trips > (shown.get(dayNameKey(l.day, l.name)) || 0);
}
/** PURE. TODAY's load and the board agree on the count — and the board's count already includes
 *  the carried orders filed onto today — so nothing says they are anywhere else. */
export function countAgrees(l: DayLoad, shown: Map<string, number> | null | undefined): boolean {
  if (l.trips == null || !shown) return false;
  return l.trips === (shown.get(dayNameKey(l.day, l.name)) || 0);
}

/**
 * PURE. Which loads this run needs the membership of, most useful first: loads from today on
 * (they decide what Monday's card shows) before the past loads (they only decide whether a
 * leftover reads as unplanned). Deduplicated by load number.
 */
export function readsWanted(rows: any[], ctx: {
  today: string; horizon: string[]; rosters: Map<string, RosterLoadRow[] | null>;
  shown?: Map<string, number> | null; hasActiveOverride?: (row: any) => boolean;
  /** 'current' → loads from today on; 'past' → the carried orders' own past-day loads */
  phase?: 'current' | 'past' | 'all';
}): DayLoad[] {
  const phase = ctx.phase || 'all';
  const current = new Map<string, DayLoad>();
  const past = new Map<string, DayLoad>();
  for (const row of rows || []) {
    if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride)) continue;
    const name = routeNameOf(row)!;
    const own = ownDayLoad(name, ownDayOf(row), ctx.rosters);
    const ownPast = own && own.day < ctx.today ? own : null;
    const loads = liveLoadsNamed(name, ctx.horizon, ctx.rosters);
    for (const l of loads) {
      if (current.has(l.loadNbr)) continue;
      // A later day's load is worth a read only if it counts orders that day's board does not show.
      if (l.day > ctx.today) { if (hasRoom(l, ctx.shown)) current.set(l.loadNbr, l); continue; }
      // Today's load decides only "on today's load" vs "held on a past load" — the first files the
      // order exactly where the old rule did, so the read is worth it only when a past load could
      // hold it AND the count disagrees.
      if (ownPast && !countAgrees(l, ctx.shown)) current.set(l.loadNbr, l);
    }
    const todays = loads.filter((l) => l.day === ctx.today);
    if (ownPast && todays.every((l) => !countAgrees(l, ctx.shown)) && !past.has(ownPast.loadNbr)) past.set(ownPast.loadNbr, ownPast);
  }
  const cur = [...current.values()];
  const pst = [...past.values()].filter((l) => !current.has(l.loadNbr));
  return phase === 'current' ? cur : phase === 'past' ? pst : [...cur, ...pst];
}

/**
 * PURE. The one decision for one row. `members` maps a load number to its read:
 *   a Set    → the read (usable or not is decided here, against the roster's count)
 *   null     → the read failed
 *   absent   → not read this run (budget spent) and no usable memo
 *
 *   • held by exactly one load from today on                 → 'load' (that load's day)
 *   • every load from today on was read and none holds it,
 *     AND its own past day's load was read and holds it      → 'held' (unplanned, heldOn)
 *   • anything short of that                                  → 'unresolved' (filing unchanged)
 *
 * The horizon's rosters must all be present to say "no load from today on holds it": a day whose
 * roster was never captured could hold the very load we are looking for.
 */
export function resolveRow(row: any, ctx: {
  today: string;
  horizon: string[];
  rosters: Map<string, RosterLoadRow[] | null>;
  members: Map<string, Set<string> | null>;
  shown?: Map<string, number> | null;
  hasActiveOverride?: (row: any) => boolean;
}): Resolution {
  if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride)) return { kind: 'unresolved', reason: 'not-a-carry-candidate' };
  const name = routeNameOf(row)!;
  const nbr = row.stopNbr;
  const current = liveLoadsNamed(name, ctx.horizon, ctx.rosters);
  const unread: string[] = [];
  const holders: DayLoad[] = [];
  for (const l of current) {
    const m = ctx.members.get(l.loadNbr);
    if (ctx.members.has(l.loadNbr) && readUsable(m, l.trips)) { if (holds(m, nbr)) holders.push(l); continue; }
    // Not read. A LATER day's load whose count the board already fills cannot hold it; anything
    // else (today's load, a load with room, an unknown count) is a question still open.
    if (l.day > ctx.today && !hasRoom(l, ctx.shown)) continue;
    unread.push(l.loadNbr);
  }
  if (holders.length === 1) return { kind: 'load', day: holders[0].day, load: holders[0] };
  if (holders.length > 1) return { kind: 'unresolved', reason: `held by ${holders.length} loads (${holders.map((h) => h.loadNbr).join(', ')})` };
  if (unread.length) return { kind: 'unresolved', reason: `load(s) from today on not read yet: ${unread.join(', ')}` };
  const missing = ctx.horizon.filter((d) => ctx.rosters.get(d) == null);
  if (missing.length) return { kind: 'unresolved', reason: `no roster captured for ${missing.join(', ')}` };
  const own = ownDayLoad(name, ownDayOf(row), ctx.rosters);
  if (!own || own.day >= ctx.today) return { kind: 'unresolved', reason: 'no single live load under this name on its own day\'s roster' };
  const m = ctx.members.get(own.loadNbr);
  if (!ctx.members.has(own.loadNbr) || !readUsable(m, own.trips)) return { kind: 'unresolved', reason: `its own day's load ${own.loadNbr} not read yet` };
  if (!holds(m, nbr)) return { kind: 'unresolved', reason: `not on any load from today on, nor on ${own.loadNbr}` };
  return { kind: 'held', load: own };
}

/** The fields this module owns on a board row. LIVE (nuvizz-list LIVE_LIST_FIELDS) and PLAN
 *  (PLAN_FIELDS) — a stamp is this scan's answer or nothing, never a previous scan's. */
export const ROUTE_LOAD_FIELDS = ['loadDay', 'rosterLoadNbr', 'rosterLoadId', 'rosterLoadVia', 'heldOn'] as const;

/**
 * PURE (mutates `row`). Write a resolution onto a row BEFORE it is bucketed, so every consumer
 * of the buckets — the boards, the open-order pool, the carry-over fold, CS notify — inherits
 * one answer.
 */
export function stampResolution(row: any, res: Resolution): void {
  if (res.kind === 'load') {
    row.loadDay = res.day;
    row.rosterLoadNbr = res.load.loadNbr;
    row.rosterLoadId = res.load.loadId;
    row.rosterLoadVia = 'membership';
    row.heldOn = null;
    return;
  }
  if (res.kind === 'held') {
    const route = routeNameOf(row);
    row.heldOn = {
      route, loadNbr: res.load.loadNbr, loadId: res.load.loadId, day: res.load.day,
      driver: row.driverName ?? res.load.driver ?? null,
    };
    // Shown UNPLANNED — the same fields an un-planned list row carries (absentPlanDemoteCandidate
    // clears exactly these). NuVizz's own status code stays: the record is still on that load.
    row.normalizedStatus = 'UNPLANNED';
    row.isPlanned = false;
    row.isUnplanned = true;
    row.loadNbr = null;
    row.routeName = null;
    row.routeSeq = null;
    row.driverName = null;
    row.driverUserName = null;
    row.loadDay = null;
    row.rosterLoadNbr = null;
    row.rosterLoadId = null;
    row.rosterLoadVia = null;
  }
}

/**
 * PURE (mutates rows). For routed rows the resolver did not move, name the load they are on
 * from the roster of the day they are FILED on — when that day's roster has exactly one live
 * load under the name and it counts at least as many orders as the board holds under it. That
 * is the same join the Routes panel does by name, done once, on the right day, and written
 * down, so every reader has the number. Anything short of that stamps nothing.
 */
export function stampRosterNames(rows: any[], dayOf: (row: any) => string | null, rosters: Map<string, RosterLoadRow[] | null>): number {
  const groups = new Map<string, any[]>();
  for (const r of rows || []) {
    if (!r || isFinished(r) || r.isPlanned !== true || r.rosterLoadNbr) continue;
    const name = routeNameOf(r);
    const day = dayOf(r);
    if (!name || !day || !rosters.get(day)) continue;
    const k = `${day}\u0000${nameKey(name)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let stamped = 0;
  for (const [k, grp] of groups) {
    const [day] = k.split('\u0000');
    const name = routeNameOf(grp[0])!;
    const { load, ambiguous } = resolveNameOwner(name, rosters.get(day) || []);
    if (ambiguous || !load || isCancelledStatus((load as any).status)) continue;
    const dl = toDayLoad(day, load as RosterLoadRow);
    if (!dl) continue;
    if (dl.trips != null && grp.length > dl.trips) continue;   // the roster disagrees — name-collision's case, not ours
    for (const r of grp) {
      r.rosterLoadNbr = dl.loadNbr; r.rosterLoadId = dl.loadId; r.rosterLoadVia = 'roster-name';
      stamped++;
    }
  }
  return stamped;
}

/** PURE. May a stored read stand in for a fresh one? Same stop count, and younger than the TTL
 *  for its kind (a load whose day is over changes rarely; one from today on changes all day). */
export function memoFresh(entry: MemoEntry | null | undefined, trips: number | null, isPast: boolean, nowMs: number): boolean {
  if (!entry || !Array.isArray(entry.members)) return false;
  if ((entry.trips ?? null) !== (trips ?? null)) return false;
  const at = Date.parse(String(entry.at || ''));
  if (!Number.isFinite(at)) return false;
  return nowMs - at < (isPast ? MEMO_TTL_PAST_MS : MEMO_TTL_CURRENT_MS);
}

/** PURE. A stale read with the SAME stop count — used only when the budget is spent, so an order
 *  resolved last scan does not flip back to the old filing just because this scan ran out of reads. */
export function memoSameCount(entry: MemoEntry | null | undefined, trips: number | null): boolean {
  return !!entry && Array.isArray(entry.members) && (entry.trips ?? null) === (trips ?? null);
}

export interface RouteLoadDaySummary {
  candidates: number;
  load: number;
  held: number;
  unresolved: number;
  reads: number;
  memoHits: number;
  staleMemo: number;
  rosterNamed: number;
  /** a few lines a person can read in the run ledger */
  sample: string[];
}

/**
 * The I/O shell, with every read injected so a test can drive it end to end. Reads the rosters,
 * spends at most `readMax` membership reads (memo first), resolves and stamps every row, and
 * returns what it did. Never throws: a failure anywhere leaves rows unstamped (old filing).
 */
export async function applyRouteLoadDay(rows: any[], deps: {
  today: string;
  horizon: string[];
  readRoster: (day: string) => Promise<RosterLoadRow[] | null>;
  readMembers: (loadNbr: string) => Promise<Set<string> | null>;
  memo: Record<string, MemoEntry>;
  readMax: number;
  nowMs: number;
  hasActiveOverride?: (row: any) => boolean;
  /** the filing day a row gets once stamped (boardDayFor) — for naming the load of rows the
   *  resolver did not move; omitted → no roster-name stamps */
  dayOf?: (row: any) => string | null;
  log?: (m: string) => void;
}): Promise<{ summary: RouteLoadDaySummary; memoDirty: boolean; dayByNbr: Map<string, string>; rosters: Map<string, RosterLoadRow[] | null>; members: Map<string, Set<string> | null> }> {
  const summary: RouteLoadDaySummary = { candidates: 0, load: 0, held: 0, unresolved: 0, reads: 0, memoHits: 0, staleMemo: 0, rosterNamed: 0, sample: [] };
  const dayByNbr = new Map<string, string>();
  let memoDirty = false;
  const log = deps.log || (() => {});
  const cands = (rows || []).filter((r) => isCarryCandidate(r, deps.today, deps.hasActiveOverride));
  summary.candidates = cands.length;

  // Rosters: the horizon (every day this scan writes) and the candidates' own past days.
  const rosters = new Map<string, RosterLoadRow[] | null>();
  const wantDays = new Set<string>(deps.horizon);
  for (const r of cands) { const d = ownDayOf(r); if (d && d < deps.today) wantDays.add(d); }
  for (const d of wantDays) {
    try { rosters.set(d, await deps.readRoster(d)); } catch { rosters.set(d, null); }
  }

  const members = new Map<string, Set<string> | null>();
  if (cands.length) {
    const shown = deps.dayOf ? shownCounts(rows, deps.dayOf) : null;
    const ctx = { today: deps.today, horizon: deps.horizon, rosters, shown, hasActiveOverride: deps.hasActiveOverride };
    const fetchAll = async (wanted: DayLoad[]) => {
      for (const l of wanted) {
        if (members.has(l.loadNbr)) continue;
        const isPast = l.day < deps.today;
        const entry = deps.memo[l.loadNbr];
        if (memoFresh(entry, l.trips, isPast, deps.nowMs)) {
          members.set(l.loadNbr, new Set(entry.members)); summary.memoHits++; continue;
        }
        if (summary.reads < deps.readMax) {
          summary.reads++;
          let set: Set<string> | null = null;
          try { set = await deps.readMembers(l.loadNbr); } catch { set = null; }
          members.set(l.loadNbr, set);
          if (set && readUsable(set, l.trips)) {
            deps.memo[l.loadNbr] = { at: new Date(deps.nowMs).toISOString(), trips: l.trips, members: [...set] };
            memoDirty = true;
          }
          continue;
        }
        if (memoSameCount(entry, l.trips)) { members.set(l.loadNbr, new Set(entry.members)); summary.staleMemo++; }
      }
    };
    // Phase 1 — the loads from today on. Phase 2 — the past loads, only for orders phase 1 did not
    // place on a load (a past read spent on an order Monday's load already holds buys nothing).
    await fetchAll(readsWanted(cands, { ...ctx, phase: 'current' }));
    const stillOpen = cands.filter((r) => resolveRow(r, { ...ctx, members }).kind !== 'load');
    await fetchAll(readsWanted(stillOpen, { ...ctx, phase: 'past' }));
    for (const r of cands) {
      const res = resolveRow(r, { ...ctx, members });
      if (res.kind === 'load') {
        stampResolution(r, res); summary.load++; dayByNbr.set(String(r.stopNbr), res.day);
        if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr}→${res.load.loadNbr}@${res.day}`);
      } else if (res.kind === 'held') {
        stampResolution(r, res); summary.held++; dayByNbr.set(String(r.stopNbr), deps.today);
        if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr} held on ${res.load.loadNbr}@${res.load.day}`);
      } else {
        summary.unresolved++;
      }
    }
  }
  // Every other routed row: name its load from the roster of the day it is filed on (horizon
  // days only — the rosters this scan captures). Free: no read, and nothing moves.
  if (deps.dayOf) {
    const horizonRosters = new Map<string, RosterLoadRow[] | null>();
    for (const d of deps.horizon) horizonRosters.set(d, rosters.get(d) ?? null);
    try { summary.rosterNamed = stampRosterNames(rows, deps.dayOf, horizonRosters); } catch { /* a label, never a scan */ }
  }
  if (summary.candidates) log(`[scan] route-load-day: ${summary.candidates} carried order(s) — ${summary.load} filed on their load's day, ${summary.held} shown unplanned (still on a past load), ${summary.unresolved} left as filed; ${summary.reads} read(s), ${summary.memoHits} memo hit(s)${summary.staleMemo ? `, ${summary.staleMemo} stale same-count` : ''}`);
  return { summary, memoDirty, dayByNbr, rosters, members };
}
