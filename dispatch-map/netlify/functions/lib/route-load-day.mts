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
// HOW SURE BEFORE ANYTHING MOVES (the adversarial review of 2026-09-28, 21 findings). 'held' is the
// direction that costs a second truck when it is wrong — planned freight shown as unplanned — so it
// needs a known answer from EVERY live load under the name from today on and from the order's own
// past load. A later day's roster count is NOT an answer: it is captured once a day, so the count
// is the morning's and the order planned onto that load since is exactly the one being looked for.
// A stored read answers for an order only while NuVizz has not touched that order since the read
// (memoValidFor); anything touched is read again.
//
// PURE. No I/O, no clock, no env reads outside the two switch helpers: every decision here is
// testable on plain data. refresh-stops-core reads the rosters (Firestore, free) and the load
// memberships (a budgeted /load/info each, NUVIZZ_ROUTE_LOAD_DAY_READS per run, stored) and hands
// them in.
//
// ROUTE_LOAD_DAY=off — see routeLoadDayEnabled — puts every side back at once: no reads, no
// stamps, boardDayFor ignores any stamp a previous run left, the demotion verify stops skipping.

import { isCancelledStatus, resolveNameOwner } from '../../../src/lib/route-status.js';
import { etParts } from '../../../src/lib/uline-forecast-score.js';

/** NUVIZZ_ROUTE_LOAD_DAY — house shape: default ON, an explicit off-word turns it off, and
 *  anything malformed leaves it ON (a typo must never silently disable a rule). */
export function routeLoadDayEnabled(env: any = process.env): boolean {
  const v = String(env?.NUVIZZ_ROUTE_LOAD_DAY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** How many /load/info reads one RUN may spend deciding which load holds an order (each read is
 *  one NuVizz call, two if it retries). The rest come from the memo; a spent budget leaves the
 *  order exactly where it was filed before. */
export function routeLoadDayReadMax(env: any = process.env): number {
  const raw = String(env?.NUVIZZ_ROUTE_LOAD_DAY_READS ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

/** THE MEMO — a stored /load/info read answers for an order only while NuVizz has not touched that
 *  order since the read (memoValidFor). The ages below are a backstop to that rule, not the rule:
 *   • past REFRESH → the load is re-read when this run has a read to spare;
 *   • past MAX     → the stored read answers for nothing. */
export const MEMO_REFRESH_CURRENT_MS = 6 * 60 * 60 * 1000;
export const MEMO_REFRESH_PAST_MS = 24 * 60 * 60 * 1000;
export const MEMO_MAX_CURRENT_MS = 24 * 60 * 60 * 1000;
export const MEMO_MAX_PAST_MS = 48 * 60 * 60 * 1000;
/** A change NuVizz stamps within this long before a read may not be in that read (minute-grained
 *  stamps, two clocks) — such an order is read again rather than answered from the memo. */
export const READ_SETTLE_MS = 5 * 60 * 1000;

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

/** Where a membership used in a verdict came from: this run's /load/info, or the memo (inside its
 *  refresh age, or past it but inside its max age). */
export type MembershipSource = 'read' | 'memo' | 'stale-memo';

export type Resolution =
  | { kind: 'load'; day: string; load: DayLoad; sources: MembershipSource[] }
  | { kind: 'held'; load: DayLoad; sources: MembershipSource[] }
  | { kind: 'unresolved'; reason: string };

export interface MemoEntry {
  /** when the load was read (our clock, ISO) */
  at: string;
  /** the roster's stop count when it was read — kept for the ledger; never a validity test (a
   *  future day's roster is captured once a day and a past day's never again, so the count is
   *  frozen exactly when it would matter) */
  trips: number | null;
  /** the load's stop numbers as read (raw + normalised, as lookupLoadStopNbrs returns them) */
  members: string[];
  /** NuVizz's clock ('YYYY-MM-DDTHH:MM', ET, the list's own "Stop Updated" form): every change
   *  NuVizz stamped EARLIER than this is in the read. See coverStamp / memoValidFor. */
  cover: string | null;
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
 * name on that day is the free trigger" — for TODAY's load (re-pulled hourly). A later day's count
 * is the morning's capture: it orders the reads (hasRoom), never skips one.
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

/** PURE. A load on a LATER day counts more orders than that day's board shows under its name, so
 *  it has room for a carried one. A HINT for which load to read first — never proof that a load
 *  cannot hold an order: a later day's roster is captured once a day (rosterFreezeApplies), so its
 *  count is the morning's, and an order planned onto it since is exactly the one we look for. */
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


// ── THE MEMO: A STORED READ ANSWERS ONLY FOR ORDERS NUVIZZ HAS NOT TOUCHED SINCE ─────────────────
//
// A /load/info read says which orders a load held at that moment. Reusing it later is safe for
// ONE order exactly as long as that order has not changed since: an order moved off Friday's
// TERRANCE onto Monday's MARCUS is a change to that ORDER, and the list stamps every row with
// NuVizz's own record-update clock (`listUpdatedDTTM`, "Stop Updated" — v1.27.0 measured it as the
// live record clock, zone-less ET). So a stored read answers for a row only when the row's stamp
// is EARLIER than the read's cover; anything touched since is read again. The roster's stop count
// is NOT used to decide that: a future day's roster is captured once a day and a past day's never
// again, so the count is frozen exactly when an order moves (the review of 2026-09-28 found five
// ways that let a stale read file planned freight as unplanned). The max ages bound the one case
// this rule cannot see — a move that left the stamp alone.

const STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/;

/** NuVizz's "Stop Updated" on a list row as 'YYYY-MM-DDTHH:MM' (zone-less ET, minute-grained — the
 *  form toBoardStop keeps it in); null when absent or malformed. */
export function listStamp(v: any): string | null {
  const m = STAMP.exec(String(v ?? '').trim());
  return m ? `${m[1]}T${m[2]}:${m[3]}` : null;
}

/** The newest "Stop Updated" in a pull — NuVizz's own clock. */
export function pullStamp(rows: any[]): string | null {
  let max: string | null = null;
  for (const r of rows || []) { const t = listStamp(r?.listUpdatedDTTM); if (t && (!max || t > max)) max = t; }
  return max;
}

/** An instant as NuVizz's zone-less ET minute ('YYYY-MM-DDTHH:MM'). */
export function etMinuteOf(ms: number): string | null {
  const p = etParts(ms);
  if (!p) return null;
  return `${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * PURE. The NuVizz-clock minute a read made at `readMs` is known to cover: every change NuVizz
 * stamped EARLIER than it is in the read. Two independent ways to know it; the later wins:
 *   • the pull's newest stamp — a change stamped before one the pull already saw happened before
 *     the pull, and the read came after the pull (NuVizz's clock alone: no zone, no skew);
 *   • our clock READ_SETTLE_MS back, as an ET minute — so on a quiet night, when the pull's newest
 *     stamp stops moving, the order a dispatcher touched last is not re-read every scan.
 * A pull stamp later than our own clock is a mis-set record, and is not trusted.
 */
export function coverStamp(pullMax: string | null, readMs: number): string | null {
  const settled = etMinuteOf(readMs - READ_SETTLE_MS);
  const now = etMinuteOf(readMs);
  const pm = pullMax && (!now || pullMax <= now) ? pullMax : null;
  if (!settled) return pm;
  return pm && pm > settled ? pm : settled;
}

/**
 * PURE. May this stored read answer for THIS row? Only when the row's "Stop Updated" is earlier
 * than the read's cover (NuVizz has not touched the order since) and the read is younger than
 * `maxAgeMs`. A row with no stamp, or a read with no cover, gets nothing from the memo.
 */
export function memoValidFor(entry: MemoEntry | null | undefined, row: any, maxAgeMs: number, nowMs: number): boolean {
  if (!entry || !Array.isArray(entry.members)) return false;
  const cover = typeof entry.cover === 'string' ? listStamp(entry.cover) : null;
  const rowStamp = listStamp(row?.listUpdatedDTTM);
  if (!cover || !rowStamp || !(rowStamp < cover)) return false;
  const at = Date.parse(String(entry.at || ''));
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - at;
  return age >= -READ_SETTLE_MS && age < maxAgeMs;
}

const maxAgeFor = (l: DayLoad, today: string) => (l.day < today ? MEMO_MAX_PAST_MS : MEMO_MAX_CURRENT_MS);
const refreshAgeFor = (l: DayLoad, today: string) => (l.day < today ? MEMO_REFRESH_PAST_MS : MEMO_REFRESH_CURRENT_MS);
const memoEntryOf = (memo: Record<string, MemoEntry> | null | undefined, loadNbr: string): MemoEntry | null =>
  memo && Object.prototype.hasOwnProperty.call(memo, loadNbr) ? memo[loadNbr] : null;

export interface ResolveCtx {
  today: string;
  horizon: string[];
  rosters: Map<string, RosterLoadRow[] | null>;
  /** THIS run's /load/info reads, by load number: the set read, or null for a read that failed */
  members: Map<string, Set<string> | null>;
  /** the stored reads (never mutated here) */
  memo?: Record<string, MemoEntry> | null;
  nowMs?: number;
  /** shownCounts — which load to read first, never whether one can hold an order */
  shown?: Map<string, number> | null;
  hasActiveOverride?: (row: any) => boolean;
}

/**
 * PURE. What one load is known to hold, AS FAR AS THIS ROW IS CONCERNED: this run's read when it
 * came back usable; else a stored read that still answers for this row (memoValidFor) — a failed
 * read this run falls back to it rather than to nothing; else null (not known).
 */
export function membershipFor(l: DayLoad, row: any, ctx: ResolveCtx): { set: Set<string>; source: MembershipSource } | null {
  if (ctx.members.has(l.loadNbr)) {
    const m = ctx.members.get(l.loadNbr);
    if (m && readUsable(m, l.trips)) return { set: m, source: 'read' };
  }
  const e = memoEntryOf(ctx.memo, l.loadNbr);
  const now = Number(ctx.nowMs);
  if (e && memoValidFor(e, row, maxAgeFor(l, ctx.today), now)) {
    const fresh = memoValidFor(e, row, refreshAgeFor(l, ctx.today), now);
    return { set: new Set(e.members), source: fresh ? 'memo' : 'stale-memo' };
  }
  return null;
}

/**
 * PURE. The one decision for one row.
 *
 *   • exactly one load from today on holds it                      → 'load' (that load's day)
 *   • EVERY live load under its name from today on is known for
 *     this row and none holds it, every horizon day's roster was
 *     captured, AND its own past day's load is known and holds it  → 'held' (unplanned, heldOn)
 *   • anything short of that                                        → 'unresolved' (filing unchanged)
 *
 * 'held' is the direction that costs a second truck when it is wrong (planned freight shown as
 * unplanned), so it takes a known answer from EVERY load that could hold the order — a later
 * day's load whose frozen morning count looks full is not an answer. 'load' takes one: an order is
 * on one load at a time.
 */
export function resolveRow(row: any, ctx: ResolveCtx): Resolution {
  if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride)) return { kind: 'unresolved', reason: 'not-a-carry-candidate' };
  const name = routeNameOf(row)!;
  const nbr = row.stopNbr;
  const current = liveLoadsNamed(name, ctx.horizon, ctx.rosters);
  const unread: string[] = [];
  const holders: Array<{ l: DayLoad; source: MembershipSource }> = [];
  const known: MembershipSource[] = [];
  for (const l of current) {
    const m = membershipFor(l, row, ctx);
    if (!m) { unread.push(l.loadNbr); continue; }
    if (holds(m.set, nbr)) holders.push({ l, source: m.source });
    else known.push(m.source);
  }
  if (holders.length === 1) return { kind: 'load', day: holders[0].l.day, load: holders[0].l, sources: [holders[0].source] };
  if (holders.length > 1) return { kind: 'unresolved', reason: `held by ${holders.length} loads (${holders.map((h) => h.l.loadNbr).join(', ')})` };
  if (unread.length) return { kind: 'unresolved', reason: `load(s) from today on not read for this order yet: ${unread.join(', ')}` };
  const missing = ctx.horizon.filter((d) => ctx.rosters.get(d) == null);
  if (missing.length) return { kind: 'unresolved', reason: `no roster captured for ${missing.join(', ')}` };
  const own = ownDayLoad(name, ownDayOf(row), ctx.rosters);
  if (!own || own.day >= ctx.today) return { kind: 'unresolved', reason: 'no single live load under this name on its own day\'s roster' };
  const om = membershipFor(own, row, ctx);
  if (!om) return { kind: 'unresolved', reason: `its own day's load ${own.loadNbr} not read for this order yet` };
  if (!holds(om.set, nbr)) return { kind: 'unresolved', reason: `not on any load from today on, nor on ${own.loadNbr}` };
  return { kind: 'held', load: own, sources: [...known, om.source] };
}

/**
 * PURE. Which loads this run should read, most useful first, deduplicated, never one already read
 * this run. A load whose stored read still answers (inside its refresh age) for every order that
 * needs it is not read at all; one answering only past its refresh age is read after every load
 * nobody knows yet.
 *   'current' — the loads from today on. A later day's load that the board says has room first,
 *               then today's, then a later day's whose frozen count looks full (it is read all the
 *               same: an order planned onto it after the morning capture is the one we look for).
 *               TODAY's load is read only when a past load could hold the order and today's count
 *               disagrees with the board — otherwise its answer files the order where the old rule
 *               already does.
 *   'past'    — the order's own past day's load, and only for an order 'held' is within reach of:
 *               every load from today on already answers for it and none holds it. A past read
 *               spent on an order whose Monday load is unknown buys nothing this run.
 */
export function readsWanted(rows: any[], ctx: ResolveCtx & { phase?: 'current' | 'past' }): DayLoad[] {
  const phase = ctx.phase || 'current';
  const want = new Map<string, { l: DayLoad; rank: number; order: number }>();
  let order = 0;
  const add = (l: DayLoad, rank: number) => {
    const w = want.get(l.loadNbr);
    if (!w) want.set(l.loadNbr, { l, rank, order: order++ });
    else if (rank < w.rank) w.rank = rank;
  };
  for (const row of rows || []) {
    if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride)) continue;
    const name = routeNameOf(row)!;
    const own = ownDayLoad(name, ownDayOf(row), ctx.rosters);
    const ownPast = own && own.day < ctx.today ? own : null;
    const loads = liveLoadsNamed(name, ctx.horizon, ctx.rosters);
    const known = new Map(loads.map((l) => [l.loadNbr, membershipFor(l, row, ctx)] as const));
    // Already on a load by an answer that still stands → nothing to read; on one only by a stored
    // read past its refresh age → re-read that load, after everything nobody knows yet.
    const holder = loads.find((l) => { const m = known.get(l.loadNbr); return !!m && holds(m.set, row.stopNbr); });
    if (holder) {
      if (phase === 'current' && known.get(holder.loadNbr)!.source === 'stale-memo' && !ctx.members.has(holder.loadNbr)) add(holder, 3 + (holder.day > ctx.today ? 0 : 1));
      continue;
    }
    if (phase === 'current') {
      for (const l of loads) {
        if (ctx.members.has(l.loadNbr)) continue;
        if (l.day === ctx.today && !(ownPast && !countAgrees(l, ctx.shown))) continue;
        const m = known.get(l.loadNbr);
        if (m && m.source !== 'stale-memo') continue;
        const tier = l.day > ctx.today ? (hasRoom(l, ctx.shown) ? 0 : 2) : 1;
        add(l, (m ? 3 : 0) + tier);
      }
      continue;
    }
    if (!ownPast || ctx.members.has(ownPast.loadNbr)) continue;
    if (ctx.horizon.some((d) => ctx.rosters.get(d) == null)) continue;
    if (loads.some((l) => !known.get(l.loadNbr))) continue;
    const m = membershipFor(ownPast, row, ctx);
    if (m && m.source !== 'stale-memo') continue;
    add(ownPast, m ? 1 : 0);
  }
  return [...want.values()].sort((a, b) => a.rank - b.rank || a.order - b.order).map((w) => w.l);
}

/** The fields this module owns on a board row. LIVE (nuvizz-list LIVE_LIST_FIELDS): a stamp is
 *  this scan's answer or nothing, never a previous scan's. Read them through
 *  src/lib/route-load-stamp.js (stampedLoadOf / heldLoadOf), which honours a stamp only while the
 *  row still says what it said when stamped. */
export const ROUTE_LOAD_FIELDS = ['loadDay', 'rosterLoadNbr', 'rosterLoadId', 'rosterLoadVia', 'rosterLoadRoute', 'heldOn'] as const;

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
    row.rosterLoadRoute = routeNameOf(row);
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
    row.rosterLoadRoute = null;
  }
}

/**
 * PURE (mutates rows). For routed rows the resolver did not move, name the load they are on
 * from the roster of the day they are FILED on — when that day's roster has exactly one live
 * load under the name and it counts at least as many orders as the board holds under it. That
 * is the same join the Routes panel does by name, done once, on the right day, and written
 * down, so every reader has the number. Anything short of that stamps nothing — and a carried
 * order the resolver could NOT place (`skip`) is never named from the day it was merely filed
 * on: the resolver has just said it cannot tell which load holds it.
 */
export function stampRosterNames(rows: any[], dayOf: (row: any) => string | null, rosters: Map<string, RosterLoadRow[] | null>, skip?: Set<any> | null): number {
  const groups = new Map<string, any[]>();
  for (const r of rows || []) {
    if (!r || isFinished(r) || r.isPlanned !== true || r.rosterLoadNbr) continue;
    if (skip && skip.has(r)) continue;
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
      r.rosterLoadNbr = dl.loadNbr; r.rosterLoadId = dl.loadId; r.rosterLoadVia = 'roster-name'; r.rosterLoadRoute = routeNameOf(r);
      stamped++;
    }
  }
  return stamped;
}

export interface RouteLoadDaySummary {
  candidates: number;
  load: number;
  held: number;
  unresolved: number;
  /** /load/info reads spent this run (each may cost up to two NuVizz calls: one retry) */
  reads: number;
  phase1Reads: number;
  phase2Reads: number;
  /** reads that failed, or came back empty against a load the roster counts stops on */
  unusableReads: number;
  readMax: number;
  /** verdicts that leaned on a stored read (memo); of those, past its refresh age */
  memoHits: number;
  staleMemo: number;
  rosterNamed: number;
  /** the memo document could not be read this run: no reads were spent and nothing moved */
  memoUnreadable?: boolean;
  /** a few lines a person can read in the run ledger */
  sample: string[];
  /** why carried orders were left as filed — "which load was not read", for free */
  unresolvedSample: string[];
}

/**
 * The I/O shell, with every read injected so a test can drive it end to end. Reads the rosters,
 * spends at most `readMax` membership reads, resolves and stamps every row, and returns what it
 * did. Never throws: a failure anywhere leaves rows unstamped (old filing).
 *
 * `memo` is the stored reads; null means the memo document could not be read — then nothing is
 * read or resolved this run (a run that re-reads everything the memo already knew spends the
 * budget and still moves every order back). New reads come back in `memoUpdates` for the caller
 * to MERGE into the stored document; `memo` itself is never mutated.
 * `readThisRun` is exactly the /load/info answers this run received — never a stored read — so a
 * caller that shares it (name-collision, the demotion verify) never mistakes a memo for a read.
 */
export async function applyRouteLoadDay(rows: any[], deps: {
  today: string;
  horizon: string[];
  readRoster: (day: string) => Promise<RosterLoadRow[] | null>;
  readMembers: (loadNbr: string) => Promise<Set<string> | null>;
  memo: Record<string, MemoEntry> | null;
  readMax: number;
  nowMs: number;
  hasActiveOverride?: (row: any) => boolean;
  /** the filing day a row gets once stamped (boardDayFor) — for naming the load of rows the
   *  resolver did not move; omitted → no roster-name stamps */
  dayOf?: (row: any) => string | null;
  log?: (m: string) => void;
}): Promise<{ summary: RouteLoadDaySummary; memoDirty: boolean; memoUpdates: Record<string, MemoEntry>; dayByNbr: Map<string, string>; rosters: Map<string, RosterLoadRow[] | null>; readThisRun: Map<string, Set<string> | null> }> {
  const readMax = Math.max(0, Math.floor(Number(deps.readMax) || 0));
  const summary: RouteLoadDaySummary = { candidates: 0, load: 0, held: 0, unresolved: 0, reads: 0, phase1Reads: 0, phase2Reads: 0, unusableReads: 0, readMax, memoHits: 0, staleMemo: 0, rosterNamed: 0, sample: [], unresolvedSample: [] };
  const dayByNbr = new Map<string, string>();
  const memoUpdates: Record<string, MemoEntry> = {};
  const readThisRun = new Map<string, Set<string> | null>();
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

  const unresolvedRows = new Set<any>();
  if (cands.length && deps.memo == null) {
    summary.memoUnreadable = true;
    summary.unresolved = cands.length;
    for (const r of cands) unresolvedRows.add(r);
  } else if (cands.length) {
    const shown = deps.dayOf ? shownCounts(rows, deps.dayOf) : null;
    const cover = coverStamp(pullStamp(rows), deps.nowMs);
    const ctx: ResolveCtx = {
      today: deps.today, horizon: deps.horizon, rosters, members: readThisRun,
      memo: deps.memo, nowMs: deps.nowMs, shown, hasActiveOverride: deps.hasActiveOverride,
    };
    // One read at a time, re-asking what is still wanted after each: a read of Monday's MARCUS that
    // places both carried MARCUS orders means Tuesday's MARCUS is never read for them.
    const fetchUpTo = async (phase: 1 | 2, cap: number) => {
      while (summary.reads < cap) {
        const l = readsWanted(cands, { ...ctx, phase: phase === 1 ? 'current' : 'past' })[0];
        if (!l) break;
        summary.reads++;
        if (phase === 1) summary.phase1Reads++; else summary.phase2Reads++;
        let set: Set<string> | null = null;
        try { set = await deps.readMembers(l.loadNbr); } catch { set = null; }
        readThisRun.set(l.loadNbr, set);
        if (!set || !readUsable(set, l.trips)) { summary.unusableReads++; continue; }
        if (cover) memoUpdates[l.loadNbr] = { at: new Date(deps.nowMs).toISOString(), trips: l.trips, members: [...set], cover };
      }
    };
    // Phase 1 — the loads from today on. Phase 2 — the past loads, only for orders 'held' is
    // within reach of. One read is kept back for phase 2 whenever a past load is waiting on one,
    // so a morning of planning (today's loads changing every scan) cannot starve it for good.
    const pastWaiting = cands.some((row) => {
      const own = ownDayLoad(routeNameOf(row)!, ownDayOf(row), rosters);
      if (!own || own.day >= deps.today) return false;
      const m = membershipFor(own, row, ctx);
      return !m || m.source === 'stale-memo';
    });
    await fetchUpTo(1, readMax >= 2 && pastWaiting ? readMax - 1 : readMax);
    await fetchUpTo(2, readMax);
    for (const r of cands) {
      const res = resolveRow(r, ctx);
      if (res.kind === 'unresolved') {
        summary.unresolved++; unresolvedRows.add(r);
        if (summary.unresolvedSample.length < 8) summary.unresolvedSample.push(`${r.stopNbr} (${routeNameOf(r)}): ${res.reason}`);
        continue;
      }
      if (res.sources.some((s) => s !== 'read')) summary.memoHits++;
      if (res.sources.includes('stale-memo')) summary.staleMemo++;
      stampResolution(r, res);
      if (res.kind === 'load') {
        summary.load++; dayByNbr.set(String(r.stopNbr), res.day);
        if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr}→${res.load.loadNbr}@${res.day}`);
      } else {
        summary.held++; dayByNbr.set(String(r.stopNbr), deps.today);
        if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr} held on ${res.load.loadNbr}@${res.load.day}`);
      }
    }
  }
  // Every other routed row: name its load from the roster of the day it is filed on (horizon
  // days only — the rosters this scan captures). Free: no read, and nothing moves.
  if (deps.dayOf) {
    const horizonRosters = new Map<string, RosterLoadRow[] | null>();
    for (const d of deps.horizon) horizonRosters.set(d, rosters.get(d) ?? null);
    try { summary.rosterNamed = stampRosterNames(rows, deps.dayOf, horizonRosters, unresolvedRows); } catch { /* a label, never a scan */ }
  }
  if (summary.candidates) log(`[scan] route-load-day: ${summary.candidates} carried order(s) — ${summary.load} filed on their load's day, ${summary.held} shown unplanned (still on a past load), ${summary.unresolved} left as filed; ${summary.reads}/${readMax} read(s) (${summary.phase1Reads} today-on, ${summary.phase2Reads} past${summary.unusableReads ? `, ${summary.unusableReads} unusable` : ''}), ${summary.memoHits} verdict(s) from the memo${summary.staleMemo ? ` (${summary.staleMemo} past refresh age)` : ''}${summary.memoUnreadable ? ' — MEMO UNREADABLE: nothing read, nothing moved' : ''}`);
  return { summary, memoDirty: Object.keys(memoUpdates).length > 0, memoUpdates, dayByNbr, rosters, readThisRun };
}
