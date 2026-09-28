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
//                                    → shown UNPLANNED, in the pool, with `heldOn` naming the load
//                                      that still holds it — ONLY while NUVIZZ_ROUTE_LOAD_HELD is
//                                      on (default OFF, see routeLoadHeldEnabled);
//   • anything the reads cannot settle → exactly the filing it had before this module (the
//                                      live-route clamp). Nothing moves on a guess.
//
// HOW SURE BEFORE ANYTHING MOVES (two adversarial reviews, 2026-09-28: 21 findings, then 18).
//   • A later day's roster is captured once a day, so its stop COUNT is the morning's: it decides
//     which load to read first and never rules one out.
//   • A /load/info answer is reused — from the memo, or as the verdict the last scan reached
//     (stickyFor) — only for an order NuVizz has not touched since ("Stop Updated", the list's
//     listUpdatedDTTM) and that no Save has touched since (board_write_at). Anything touched is
//     read again. So nothing is re-read while nothing changes, and nothing flips back and forth
//     when a run has no read to spare.
//   • What the code cannot prove: that NuVizz moves "Stop Updated" whenever an order changes
//     load. The ages (MEMO_MAX_*, STICKY_MAX_MS) bound how long an answer can outlive a move that
//     did not, and `movedWithoutStamp` in the run summary counts every time a re-read finds one.
//     That is why the direction that costs a second truck when it is wrong — shown unplanned — is
//     OFF until Chad turns it on.
//   • Where the order's plan or Save lives on a LATER day's board, this run's row is filed there
//     too (pinsFor), so the demotion verify and the write grace decide it on that board — one
//     board per order, never a planned copy on Monday and an un-planned one on today.
//
// PURE. No I/O, no clock, no env reads outside the switch helpers: every decision here is
// testable on plain data. refresh-stops-core reads the rosters (Firestore, free), where the last
// scan filed each order (the open-order pool, free), and the load memberships (a budgeted
// /load/info each, NUVIZZ_ROUTE_LOAD_DAY_READS per run), and hands them in.
//
// NUVIZZ_ROUTE_LOAD_DAY=off puts every side back at once: no reads, no stamps, no pins,
// boardDayFor ignores any stamp a previous run left, the demotion verify stops skipping.

import { isCancelledStatus, resolveNameOwner } from '../../../src/lib/route-status.js';
import { etParts } from '../../../src/lib/uline-forecast-score.js';
import { etLocalToInstant } from '../../../src/lib/order-arrivals.js';
import { stampedLoadOf, heldLoadOf } from '../../../src/lib/route-load-stamp.js';

/** NUVIZZ_ROUTE_LOAD_DAY — house shape: default ON, an explicit off-word turns it off, and
 *  anything malformed leaves it ON (a typo must never silently disable a rule). */
export function routeLoadDayEnabled(env: any = process.env): boolean {
  const v = String(env?.NUVIZZ_ROUTE_LOAD_DAY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * NUVIZZ_ROUTE_LOAD_HELD — "shown unplanned while still on a past day's load". DEFAULT OFF, and
 * only an explicit on-word turns it on; anything else (unset, a typo) leaves it OFF. The reverse
 * of the house shape on purpose: this is the one verdict that shows PLANNED freight as unplanned
 * when it is wrong, and it rests on a NuVizz behaviour the code cannot confirm (see the header).
 */
export function routeLoadHeldEnabled(env: any = process.env): boolean {
  const v = String(env?.NUVIZZ_ROUTE_LOAD_HELD ?? '').trim().toLowerCase();
  return ['on', '1', 'true', 'yes'].includes(v);
}

/** How many /load/info reads one RUN may spend deciding which load holds an order (each read is
 *  one NuVizz call, two if it retries). A spent budget leaves an order exactly where it was
 *  filed before — or where the last scan's verdict put it, while nothing has touched it. */
export function routeLoadDayReadMax(env: any = process.env): number {
  const raw = String(env?.NUVIZZ_ROUTE_LOAD_DAY_READS ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

/** A stored read answers for nothing past these ages, whatever the order's stamp says. */
export const MEMO_MAX_CURRENT_MS = 24 * 60 * 60 * 1000;
export const MEMO_MAX_PAST_MS = 48 * 60 * 60 * 1000;
/** The last scan's verdict is kept, unread, for at most this long (a weekend's blackout, Friday
 *  night to Sunday evening, plus the Monday morning after it). */
export const STICKY_MAX_MS = 72 * 60 * 60 * 1000;
/** A read that failed, or came back empty against a load the roster counts stops on, is not
 *  tried again for this long — it is not re-paid on every scan. */
export const UNUSABLE_BACKOFF_MS = 60 * 60 * 1000;
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

/** Where the evidence for a verdict came from: this run's /load/info, a stored read that still
 *  answers for the order, or the last scan's verdict kept because nothing has touched the order. */
export type MembershipSource = 'read' | 'memo' | 'sticky';

export type Resolution =
  | { kind: 'load'; day: string; load: DayLoad; sources: MembershipSource[]; at?: string | null }
  | { kind: 'held'; load: DayLoad; sources: MembershipSource[]; at?: string | null }
  | { kind: 'unresolved'; reason: string };

export interface MemoEntry {
  /** when the load was read (our clock, ISO) */
  at: string;
  /** the roster's stop count when it was read — for the ledger; never a validity test */
  trips: number | null;
  /** the load's stop numbers as read (raw + normalised, as lookupLoadStopNbrs returns them) */
  members: string[];
  /** NuVizz's clock ('YYYY-MM-DDTHH:MM', ET, the list's own "Stop Updated" form): every change
   *  NuVizz stamped EARLIER than this is in the read. See coverStamp / memoValidFor. */
  cover: string | null;
  /** the last time a read of this load failed or came back unusable (backs the load off) */
  unusableAt?: string | null;
}

/** Where the LAST scan filed an order (the open-order pool row it wrote, and its day), and — for
 *  an order filed on a later day's board or held — when a Save last touched that board's copy. */
export interface PriorFiling {
  day: string;
  row: any;
  /** board_write_at of the stored copy on `day`; null = no Save; undefined = not known this run */
  savedAt?: string | null;
  /** the stored board copy on `day`, when it was read — the board's own truth AFTER that scan's
   *  verify and write grace, which the pool (written before them) cannot carry */
  stored?: any;
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
 * filing rule as it stands BEFORE this pass (`dayOf` is boardDayFor on unstamped rows). CLAUDE.md:
 * "the roster's trips against the rows we hold under that name on that day is the free trigger"
 * — for TODAY's load (re-pulled hourly). A later day's count is the morning's capture: it orders
 * the reads (hasRoom), never skips one.
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

// ── NUVIZZ'S CLOCK: WHAT A READ COVERS, AND WHETHER AN ORDER CHANGED SINCE ────────────────────────

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

/** The fall-back hour (01:xx ET on the first Sunday of November happens twice): a zone-less
 *  minute inside it cannot say which of the two it was. */
export function inRepeatedHour(ms: number): boolean {
  const m = etMinuteOf(ms);
  return !!m && (m === etMinuteOf(ms + 3_600_000) || m === etMinuteOf(ms - 3_600_000));
}

/**
 * PURE. The NuVizz-clock minute a read made at `readMs` is known to cover: every change NuVizz
 * stamped EARLIER than it is in the read. Two independent ways to know it; the later wins:
 *   • the pull's newest stamp — a change stamped before one the pull already saw happened before
 *     the pull, and the read came after the pull (NuVizz's clock alone: no zone, no skew);
 *   • our clock READ_SETTLE_MS back, as an ET minute — so on a quiet night, when the pull's newest
 *     stamp stops moving, the order a dispatcher touched last is not re-read every scan.
 * A pull stamp later than our own clock is a mis-set record, and is not trusted. Inside the
 * repeated fall-back hour no cover is given at all (the read is used this run, never stored).
 */
export function coverStamp(pullMax: string | null, readMs: number): string | null {
  if (inRepeatedHour(readMs) || inRepeatedHour(readMs - READ_SETTLE_MS)) return null;
  const settled = etMinuteOf(readMs - READ_SETTLE_MS);
  const now = etMinuteOf(readMs);
  const pm = pullMax && (!now || pullMax <= now) ? pullMax : null;
  if (!settled) return pm;
  return pm && pm > settled ? pm : settled;
}

const msOf = (iso: any): number | null => {
  if (iso == null || iso === '') return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
};

/**
 * PURE. May this stored read answer for THIS row? Only when the row's "Stop Updated" is earlier
 * than the read's cover (NuVizz has not touched the order since), no Save has touched the order's
 * board copy since the read (`savedAt`, the stored copy's board_write_at), and the read is younger
 * than `maxAgeMs`. A row with no stamp, or a read with no cover, gets nothing from the memo.
 */
export function memoValidFor(entry: MemoEntry | null | undefined, row: any, maxAgeMs: number, nowMs: number, savedAt?: string | null): boolean {
  if (!entry || !Array.isArray(entry.members)) return false;
  const cover = typeof entry.cover === 'string' ? listStamp(entry.cover) : null;
  const rowStamp = listStamp(row?.listUpdatedDTTM);
  if (!cover || !rowStamp || !(rowStamp < cover)) return false;
  const at = msOf(entry.at);
  if (at == null || !Number.isFinite(nowMs)) return false;
  const saved = msOf(savedAt);
  if (saved != null && saved > at) return false;
  const age = nowMs - at;
  return age >= -READ_SETTLE_MS && age < maxAgeMs;
}

const maxAgeFor = (l: DayLoad, today: string) => (l.day < today ? MEMO_MAX_PAST_MS : MEMO_MAX_CURRENT_MS);
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
  /** NUVIZZ_ROUTE_LOAD_HELD */
  heldEnabled?: boolean;
  /** when each day's roster document was captured (ms) — "held" needs every horizon roster to
   *  be newer than the order's last change, or a load made since would be missing from it */
  rosterAt?: Map<string, number | null> | null;
  /** the Save stamp on the order's stored board copy, when known */
  savedAtOf?: (row: any) => string | null | undefined;
  /** stop numbers the last scan had filed by a load (their loads are read first) */
  priorStamped?: Set<string> | null;
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
  if (e && memoValidFor(e, row, maxAgeFor(l, ctx.today), Number(ctx.nowMs), ctx.savedAtOf ? ctx.savedAtOf(row) : null)) {
    return { set: new Set(e.members), source: 'memo' };
  }
  return null;
}

/** True when a roster captured at `rosterAtMs` was taken after the order's last change. */
function rosterNewerThanRow(rosterAtMs: number | null | undefined, row: any): boolean {
  const rowMs = etLocalToInstant(row?.listUpdatedDTTM);
  return rosterAtMs != null && Number.isFinite(rosterAtMs) && rowMs != null && Number.isFinite(rowMs) && rosterAtMs > rowMs + READ_SETTLE_MS;
}

/**
 * PURE. The one decision for one row, from reads.
 *
 *   • exactly one load from today on holds it                      → 'load' (that load's day)
 *   • NUVIZZ_ROUTE_LOAD_HELD on, EVERY live load under its name
 *     from today on is known for this row and none holds it, every
 *     horizon roster was captured AFTER the order last changed, and
 *     its own past day's load is known and holds it                → 'held' (unplanned, heldOn)
 *   • anything short of that                                        → 'unresolved' (filing unchanged)
 *
 * An order two NuVizz records share (dupNbr) is never decided by number: the dead twin on one
 * load and the live one on another answer the same stop number.
 */
export function resolveRow(row: any, ctx: ResolveCtx): Resolution {
  if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride)) return { kind: 'unresolved', reason: 'not-a-carry-candidate' };
  if (row.dupNbr === true) return { kind: 'unresolved', reason: 'two NuVizz records share this stop number — a load read by number cannot tell which one it holds' };
  const name = routeNameOf(row)!;
  const nbr = row.stopNbr;
  const current = liveLoadsNamed(name, ctx.horizon, ctx.rosters);
  const unread: string[] = [];
  const failed: string[] = [];
  const holders: Array<{ l: DayLoad; source: MembershipSource }> = [];
  const known: MembershipSource[] = [];
  for (const l of current) {
    const m = membershipFor(l, row, ctx);
    if (!m) { (ctx.members.has(l.loadNbr) ? failed : unread).push(l.loadNbr); continue; }
    if (holds(m.set, nbr)) holders.push({ l, source: m.source });
    else known.push(m.source);
  }
  if (holders.length === 1) return { kind: 'load', day: holders[0].l.day, load: holders[0].l, sources: [holders[0].source] };
  if (holders.length > 1) return { kind: 'unresolved', reason: `held by ${holders.length} loads (${holders.map((h) => h.l.loadNbr).join(', ')})` };
  if (failed.length) return { kind: 'unresolved', reason: `load(s) from today on read this run but the read failed or came back empty: ${failed.join(', ')}` };
  if (unread.length) return { kind: 'unresolved', reason: `load(s) from today on not read for this order yet: ${unread.join(', ')}` };
  if (!ctx.heldEnabled) return { kind: 'unresolved', reason: 'no load from today on holds it; showing it unplanned is switched off (NUVIZZ_ROUTE_LOAD_HELD)' };
  const missing = ctx.horizon.filter((d) => ctx.rosters.get(d) == null);
  if (missing.length) return { kind: 'unresolved', reason: `no roster captured for ${missing.join(', ')}` };
  const older = ctx.horizon.filter((d) => !rosterNewerThanRow(ctx.rosterAt?.get(d), row));
  if (older.length) return { kind: 'unresolved', reason: `the roster for ${older.join(', ')} was captured before this order last changed — a load made since would not be on it` };
  const own = ownDayLoad(name, ownDayOf(row), ctx.rosters);
  if (!own || own.day >= ctx.today) return { kind: 'unresolved', reason: 'no single live load under this name on its own day\'s roster' };
  const om = membershipFor(own, row, ctx);
  if (!om) return { kind: 'unresolved', reason: `its own day's load ${own.loadNbr} ${ctx.members.has(own.loadNbr) ? 'read this run but the read failed or came back empty' : 'not read for this order yet'}` };
  if (!holds(om.set, nbr)) return { kind: 'unresolved', reason: `not on any load from today on, nor on ${own.loadNbr}` };
  return { kind: 'held', load: own, sources: [...known, om.source] };
}

/**
 * PURE. The verdict the LAST scan reached for this order, kept without a read — when nothing it
 * rested on has moved: NuVizz has not touched the order ("Stop Updated" unchanged), no Save has
 * touched its board copy since the verdict, the list still names the same route, the load is still
 * live under that route on its day's roster, and the verdict is younger than STICKY_MAX_MS. The
 * evidence is the same as when the verdict was reached, so reaching it again would cost a read to
 * learn nothing; and a run with no read to spare no longer flips a settled order back.
 */
export function stickyFor(row: any, prior: PriorFiling | null | undefined, ctx: ResolveCtx): Resolution | null {
  if (!prior || !prior.row || prior.savedAt === undefined) return null;   // a Save we could not rule out
  if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride) || row.dupNbr === true) return null;
  const stamp = listStamp(row.listUpdatedDTTM);
  if (!stamp || stamp !== listStamp(prior.row.listUpdatedDTTM)) return null;
  const at = msOf(prior.row.rosterLoadAt);
  const now = Number(ctx.nowMs);
  if (at == null || !Number.isFinite(now) || now - at >= STICKY_MAX_MS || now - at < -READ_SETTLE_MS) return null;
  const saved = msOf(prior.savedAt);
  if (saved != null && saved > at) return null;
  const route = routeNameOf(row);
  if (!route) return null;
  const onLoad = stampedLoadOf(prior.row);
  if (onLoad && onLoad.via === 'membership' && onLoad.day && prior.day === onLoad.day && onLoad.day >= ctx.today && ctx.horizon.includes(onLoad.day)) {
    if (nameKey(onLoad.route) !== nameKey(route)) return null;
    const load = liveLoadsNamed(route, [onLoad.day], ctx.rosters).find((l) => l.loadNbr === onLoad.loadNbr);
    if (!load) return null;
    return { kind: 'load', day: onLoad.day, load, sources: ['sticky'], at: String(prior.row.rosterLoadAt) };
  }
  const held = ctx.heldEnabled ? heldLoadOf(prior.row) : null;
  if (held && held.day && held.day < ctx.today && held.route && nameKey(held.route) === nameKey(route)) {
    const load = ownDayLoad(route, held.day, ctx.rosters);
    if (!load || load.loadNbr !== held.loadNbr) return null;
    return { kind: 'held', load, sources: ['sticky'], at: String(prior.row.rosterLoadAt) };
  }
  return null;
}

/**
 * PURE. Which loads this run should read, most useful first, deduplicated, never one already read
 * this run, never one backing off after an unusable read. A load whose stored read still answers
 * for every order that needs it is not read at all.
 *   'current' — the loads from today on: a later day's load the board says has room first, then
 *               today's, then a later day's whose frozen count looks full (read all the same). Loads
 *               an order the last scan had placed by a load needs go ahead of all of them — that
 *               order is the one that moves back if its load is not read. TODAY's load is read only
 *               when "held" is on, a past load could hold the order, and today's count disagrees
 *               with the board: otherwise its answer files the order where the old rule already does.
 *   'past'    — (NUVIZZ_ROUTE_LOAD_HELD only) the order's own past day's load, and only for an
 *               order 'held' is within reach of: every load from today on already answers for it
 *               and none holds it.
 * `settled` — orders already decided this run (a kept verdict): nothing is read for them.
 */
export function readsWanted(rows: any[], ctx: ResolveCtx & { phase?: 'current' | 'past'; settled?: Set<any> | null }): DayLoad[] {
  const phase = ctx.phase || 'current';
  if (phase === 'past' && !ctx.heldEnabled) return [];
  const want = new Map<string, { l: DayLoad; rank: number; order: number }>();
  let order = 0;
  const add = (l: DayLoad, rank: number) => {
    const w = want.get(l.loadNbr);
    if (!w) want.set(l.loadNbr, { l, rank, order: order++ });
    else if (rank < w.rank) w.rank = rank;
  };
  const now = Number(ctx.nowMs);
  const backingOff = (loadNbr: string) => {
    const t = msOf(memoEntryOf(ctx.memo, loadNbr)?.unusableAt);
    return t != null && Number.isFinite(now) && now - t >= 0 && now - t < UNUSABLE_BACKOFF_MS;
  };
  const skip = (l: DayLoad) => ctx.members.has(l.loadNbr) || backingOff(l.loadNbr);
  for (const row of rows || []) {
    if (ctx.settled && ctx.settled.has(row)) continue;
    if (!isCarryCandidate(row, ctx.today, ctx.hasActiveOverride) || row.dupNbr === true) continue;
    const name = routeNameOf(row)!;
    const own = ownDayLoad(name, ownDayOf(row), ctx.rosters);
    const ownPast = own && own.day < ctx.today ? own : null;
    const loads = liveLoadsNamed(name, ctx.horizon, ctx.rosters);
    const known = new Map(loads.map((l) => [l.loadNbr, membershipFor(l, row, ctx)] as const));
    // Already on a load by an answer that still stands → nothing to read.
    if (loads.some((l) => { const m = known.get(l.loadNbr); return !!m && holds(m.set, row.stopNbr); })) continue;
    const first = ctx.priorStamped && ctx.priorStamped.has(String(row.stopNbr)) ? -10 : 0;
    if (phase === 'current') {
      for (const l of loads) {
        if (skip(l) || known.get(l.loadNbr)) continue;
        if (l.day === ctx.today && !(ownPast && ctx.heldEnabled && !countAgrees(l, ctx.shown))) continue;
        add(l, first + (l.day > ctx.today ? (hasRoom(l, ctx.shown) ? 0 : 2) : 1));
      }
      continue;
    }
    if (!ownPast || skip(ownPast)) continue;
    if (ctx.horizon.some((d) => ctx.rosters.get(d) == null)) continue;
    if (loads.some((l) => !known.get(l.loadNbr))) continue;
    if (membershipFor(ownPast, row, ctx)) continue;
    add(ownPast, first);
  }
  return [...want.values()].sort((a, b) => a.rank - b.rank || a.order - b.order).map((w) => w.l);
}

/**
 * PURE. Rows this run must file on a LATER day's board because that is where the order's plan or
 * Save lives — so the board that holds it decides it, and it is never on two boards:
 *   • a Save touched its copy there inside the write grace → the grace decides, there (a lagging
 *     list row must not re-file it onto today with the route the Save just changed);
 *   • the last scan filed it there by its load, and the list now calls it un-planned → the
 *     demotion verify decides, there (the list's word alone never takes it off that card — and the
 *     un-planned row never lands in today's pool while the card still holds it planned).
 * A dispatcher-set board date governs its stop, and finished work is history: neither is pinned.
 */
export function pinsFor(rows: any[], ctx: { today: string; horizon: string[]; nowMs: number; graceMs: number; priorOf: (nbr: string) => PriorFiling | null | undefined; hasActiveOverride?: (row: any) => boolean }): { pins: Map<string, string>; grace: number; verify: number } {
  const pins = new Map<string, string>();
  let grace = 0, verify = 0;
  for (const r of rows || []) {
    if (!r || isFinished(r) || r.stopNbr == null) continue;
    if (ctx.hasActiveOverride && ctx.hasActiveOverride(r)) continue;
    const nbr = String(r.stopNbr);
    const prior = ctx.priorOf(nbr);
    if (!prior || !prior.day || !(prior.day > ctx.today) || !ctx.horizon.includes(prior.day)) continue;
    const saved = msOf(prior.savedAt);
    if (saved != null && ctx.nowMs - saved >= -READ_SETTLE_MS && ctx.nowMs - saved < ctx.graceMs) { pins.set(nbr, prior.day); grace++; continue; }
    // The board copy when it was read (the verify may have kept a plan the pool, written before it,
    // never saw), else the pool's row.
    const st = stampedLoadOf(prior.stored ?? prior.row);
    if (st && st.day === prior.day && r.isPlanned !== true && !heldLoadOf(r)) { pins.set(nbr, prior.day); verify++; }
  }
  return { pins, grace, verify };
}

/** The fields this module owns on a board row. LIVE (nuvizz-list LIVE_LIST_FIELDS): a stamp is
 *  this scan's answer or nothing, never a previous scan's. Read them through
 *  src/lib/route-load-stamp.js (stampedLoadOf / heldLoadOf), which honours a stamp only while the
 *  row still says what it said when stamped. `rosterLoadAt` is when the verdict was reached. */
export const ROUTE_LOAD_FIELDS = ['loadDay', 'rosterLoadNbr', 'rosterLoadId', 'rosterLoadVia', 'rosterLoadRoute', 'rosterLoadAt', 'heldOn', 'pinnedFrom'] as const;

/**
 * PURE (mutates `row`). Write a resolution onto a row BEFORE it is bucketed, so every consumer
 * of the buckets — the boards, the open-order pool, the carry-over fold, CS notify — inherits
 * one answer. `nowIso` stamps a fresh verdict; a kept one keeps the time it was first reached.
 */
export function stampResolution(row: any, res: Resolution, nowIso: string | null = null): void {
  if (res.kind === 'load') {
    row.loadDay = res.day;
    row.rosterLoadNbr = res.load.loadNbr;
    row.rosterLoadId = res.load.loadId;
    row.rosterLoadVia = 'membership';
    row.rosterLoadRoute = routeNameOf(row);
    row.rosterLoadAt = res.at || nowIso;
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
    row.rosterLoadAt = res.at || nowIso;
  }
}

/**
 * PURE (mutates rows). For routed rows the resolver did not move, name the load they are on
 * from the roster of the day they are FILED on — when that day's roster has exactly one live
 * load under the name, it counts at least as many orders as the board holds under that name on
 * that day (EVERY open routed row there, the ones not being named included), and the roster was
 * captured AFTER the last change to every one of those orders (so an order moved off since the
 * capture cannot borrow the count). Anything short of that stamps nothing — and a carried order
 * the resolver could NOT place (`skip`) is never named from the day it was merely filed on.
 */
export function stampRosterNames(rows: any[], dayOf: (row: any) => string | null, rosters: Map<string, RosterLoadRow[] | null>, skip?: Set<any> | null, opts: { rosterAt?: Map<string, number | null> | null; nowIso?: string | null } = {}): number {
  const groups = new Map<string, any[]>();
  for (const r of rows || []) {
    if (!r || isFinished(r) || r.isPlanned !== true) continue;
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
    const at = opts.rosterAt ? opts.rosterAt.get(day) : null;
    if (!grp.every((r) => rosterNewerThanRow(at, r))) continue;   // an order changed after the count was taken
    for (const r of grp) {
      if ((skip && skip.has(r)) || r.rosterLoadNbr) continue;
      r.rosterLoadNbr = dl.loadNbr; r.rosterLoadId = dl.loadId; r.rosterLoadVia = 'roster-name';
      r.rosterLoadRoute = routeNameOf(r); r.rosterLoadAt = opts.nowIso ?? null;
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
  /** verdicts kept from the last scan without a read (nothing they rested on moved) */
  kept: number;
  /** /load/info reads spent this run (each may cost up to two NuVizz calls: one retry) */
  reads: number;
  phase1Reads: number;
  phase2Reads: number;
  /** reads that failed, or came back empty against a load the roster counts stops on */
  unusableReads: number;
  readMax: number;
  heldEnabled: boolean;
  /** verdicts that leaned on a stored read (memo) */
  memoHits: number;
  rosterNamed: number;
  /** rows filed on a later day's board so its grace / demotion verify decides them there */
  pinnedGrace: number;
  pinnedVerify: number;
  /** a re-read found an order on a different load than the last scan's verdict while NuVizz's
   *  "Stop Updated" on it had NOT moved — the case the memo cannot see. Should stay 0. */
  movedWithoutStamp: number;
  /** the memo document could not be read this run: no reads were spent */
  memoUnreadable?: boolean;
  /** a few lines a person can read in the run ledger */
  sample: string[];
  /** why carried orders were left as filed — "which load was not read", for free */
  unresolvedSample: string[];
}

/**
 * The I/O shell, with every read injected so a test can drive it end to end. Reads the rosters,
 * keeps the last scan's verdicts that still stand, spends at most `readMax` membership reads,
 * resolves and stamps every row, names the rest from their day's roster, and says which rows must
 * be filed on a later board (`pins`). Never throws: a failure anywhere leaves rows unstamped.
 *
 * `memo` is the stored reads; null means the memo document could not be read — then no reads are
 * spent this run (the kept verdicts still stand). New reads come back in `memoUpdates` for the
 * caller to MERGE into the stored document; `memo` itself is never mutated. `readThisRun` is
 * exactly the /load/info answers this run received — never a stored read — so a caller that
 * shares it (name-collision, the demotion verify) never mistakes a memo for a read.
 */
export async function applyRouteLoadDay(rows: any[], deps: {
  today: string;
  horizon: string[];
  readRoster: (day: string) => Promise<RosterLoadRow[] | null>;
  /** when each day's roster document was captured (ms), after readRoster(day) */
  rosterAt?: (day: string) => number | null;
  readMembers: (loadNbr: string) => Promise<Set<string> | null>;
  memo: Record<string, MemoEntry> | null;
  readMax: number;
  nowMs: number;
  heldEnabled?: boolean;
  hasActiveOverride?: (row: any) => boolean;
  /** where the last scan filed each order (the open-order pool) and the Save stamp of its copy */
  priorOf?: (nbr: string) => PriorFiling | null | undefined;
  /** the confirmed-Save write grace (BOARD_WRITE_GRACE_MIN) in ms, for pins */
  graceMs?: number;
  /** the filing day a row gets once stamped (boardDayFor) — for naming the load of rows the
   *  resolver did not move; omitted → no roster-name stamps */
  dayOf?: (row: any) => string | null;
  log?: (m: string) => void;
}): Promise<{ summary: RouteLoadDaySummary; memoDirty: boolean; memoUpdates: Record<string, MemoEntry>; dayByNbr: Map<string, string>; rosters: Map<string, RosterLoadRow[] | null>; readThisRun: Map<string, Set<string> | null>; pins: Map<string, string> }> {
  const readMax = Math.max(0, Math.floor(Number(deps.readMax) || 0));
  const heldEnabled = deps.heldEnabled === true;
  const nowIso = new Date(deps.nowMs).toISOString();
  const summary: RouteLoadDaySummary = {
    candidates: 0, load: 0, held: 0, unresolved: 0, kept: 0, reads: 0, phase1Reads: 0, phase2Reads: 0, unusableReads: 0,
    readMax, heldEnabled, memoHits: 0, rosterNamed: 0, pinnedGrace: 0, pinnedVerify: 0, movedWithoutStamp: 0, sample: [], unresolvedSample: [],
  };
  const dayByNbr = new Map<string, string>();
  const memoUpdates: Record<string, MemoEntry> = {};
  const readThisRun = new Map<string, Set<string> | null>();
  let pins = new Map<string, string>();
  const log = deps.log || (() => {});
  const priorOf = deps.priorOf || (() => null);
  const cands = (rows || []).filter((r) => isCarryCandidate(r, deps.today, deps.hasActiveOverride));
  summary.candidates = cands.length;

  // Rosters: the horizon (every day this scan writes) and the candidates' own past days.
  const rosters = new Map<string, RosterLoadRow[] | null>();
  const rosterAt = new Map<string, number | null>();
  const wantDays = new Set<string>(deps.horizon);
  for (const r of cands) { const d = ownDayOf(r); if (d && d < deps.today) wantDays.add(d); }
  for (const d of wantDays) {
    try { rosters.set(d, await deps.readRoster(d)); } catch { rosters.set(d, null); }
    try { rosterAt.set(d, deps.rosterAt ? deps.rosterAt(d) : null); } catch { rosterAt.set(d, null); }
  }

  const unresolvedRows = new Set<any>();
  const priorStamped = new Set<string>();
  for (const r of cands) {
    const p = priorOf(String(r.stopNbr));
    if (p && p.row && (p.row.rosterLoadVia === 'membership' || p.row.heldOn)) priorStamped.add(String(r.stopNbr));
  }
  const ctx: ResolveCtx = {
    today: deps.today, horizon: deps.horizon, rosters, members: readThisRun,
    memo: deps.memo || {}, nowMs: deps.nowMs, shown: deps.dayOf ? shownCounts(rows, deps.dayOf) : null,
    hasActiveOverride: deps.hasActiveOverride, heldEnabled, rosterAt,
    savedAtOf: (row: any) => { const p = priorOf(String(row?.stopNbr)); return p ? p.savedAt : null; },
    priorStamped,
  };
  if (cands.length) {
    // Kept verdicts first: an order nothing has touched needs no read.
    const settled = new Map<any, Resolution>();
    for (const r of cands) { const s = stickyFor(r, priorOf(String(r.stopNbr)), ctx); if (s) settled.set(r, s); }
    const settledRows = new Set(settled.keys());
    if (deps.memo == null) {
      summary.memoUnreadable = true;
    } else {
      const cover = coverStamp(pullStamp(rows), deps.nowMs);
      // One read at a time, re-asking what is still wanted after each: a read of Monday's MARCUS
      // that places both carried MARCUS orders means Tuesday's MARCUS is never read for them.
      const fetchUpTo = async (phase: 1 | 2, cap: number) => {
        while (summary.reads < cap) {
          const l = readsWanted(cands, { ...ctx, phase: phase === 1 ? 'current' : 'past', settled: settledRows })[0];
          if (!l) break;
          summary.reads++;
          if (phase === 1) summary.phase1Reads++; else summary.phase2Reads++;
          let set: Set<string> | null = null;
          try { set = await deps.readMembers(l.loadNbr); } catch { set = null; }
          readThisRun.set(l.loadNbr, set);
          if (!set || !readUsable(set, l.trips)) {
            summary.unusableReads++;
            // Backed off, not re-paid every scan; a stored read that still answers is kept as it was.
            const prev = memoEntryOf(deps.memo, l.loadNbr);
            memoUpdates[l.loadNbr] = prev ? { ...prev, unusableAt: nowIso } : { at: nowIso, trips: l.trips, members: [], cover: null, unusableAt: nowIso };
            continue;
          }
          if (cover) memoUpdates[l.loadNbr] = { at: nowIso, trips: l.trips, members: [...set], cover };
        }
      };
      // Phase 1 — the loads from today on. Phase 2 — the past loads (held only). One read is kept
      // back for phase 2 while a past load is waiting on one, and handed back to phase 1 when
      // phase 2 had nothing it could read.
      const pastWaiting = heldEnabled && cands.some((row) => {
        if (settledRows.has(row)) return false;
        const own = ownDayLoad(routeNameOf(row)!, ownDayOf(row), rosters);
        return !!own && own.day < deps.today && !membershipFor(own, row, ctx);
      });
      await fetchUpTo(1, readMax >= 2 && pastWaiting ? readMax - 1 : readMax);
      if (heldEnabled) await fetchUpTo(2, readMax);
      await fetchUpTo(1, readMax);
    }
    for (const r of cands) {
      const res = settled.get(r) || resolveRow(r, ctx);
      if (res.kind === 'unresolved') {
        summary.unresolved++; unresolvedRows.add(r);
        if (summary.unresolvedSample.length < 8) summary.unresolvedSample.push(`${r.stopNbr} (${routeNameOf(r)}): ${res.reason}`);
        continue;
      }
      if (res.sources.includes('sticky')) summary.kept++;
      else if (res.sources.includes('memo')) summary.memoHits++;
      // The case the memo cannot see: a fresh answer disagrees with the last scan's verdict while
      // NuVizz's stamp on the order has not moved.
      const p = priorOf(String(r.stopNbr));
      const priorStamp = p && p.row ? listStamp(p.row.listUpdatedDTTM) : null;
      if (priorStamp && !res.sources.includes('sticky') && priorStamp === listStamp(r.listUpdatedDTTM)) {
        const was = stampedLoadOf(p!.row)?.loadNbr || heldLoadOf(p!.row)?.loadNbr || null;
        if (was && was !== res.load.loadNbr) {
          summary.movedWithoutStamp++;
          if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr} MOVED ${was}→${res.load.loadNbr} with "Stop Updated" unchanged`);
        }
      }
      stampResolution(r, res, nowIso);
      if (res.kind === 'load') {
        summary.load++; dayByNbr.set(String(r.stopNbr), res.day);
        if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr}→${res.load.loadNbr}@${res.day}${res.sources.includes('sticky') ? ' (kept)' : ''}`);
      } else {
        summary.held++; dayByNbr.set(String(r.stopNbr), deps.today);
        if (summary.sample.length < 12) summary.sample.push(`${r.stopNbr} held on ${res.load.loadNbr}@${res.load.day}${res.sources.includes('sticky') ? ' (kept)' : ''}`);
      }
    }
  }
  // The rows whose plan or Save lives on a later board are filed there this run.
  try {
    const p = pinsFor(rows, { today: deps.today, horizon: deps.horizon, nowMs: deps.nowMs, graceMs: Number(deps.graceMs) || 0, priorOf, hasActiveOverride: deps.hasActiveOverride });
    pins = p.pins; summary.pinnedGrace = p.grace; summary.pinnedVerify = p.verify;
    for (const [nbr, day] of pins) dayByNbr.set(nbr, day);
    // Marked, so the NEXT scan knows to read that board's copy for the verify's answer (the pool it
    // reads was written before the verify ran).
    for (const r of rows || []) if (r && pins.has(String(r.stopNbr))) r.pinnedFrom = { day: pins.get(String(r.stopNbr)), at: nowIso };
  } catch { /* a pin, never a scan */ }
  // Every other routed row: name its load from the roster of the day it is filed on (horizon
  // days only — the rosters this scan captures). Free: no read, and nothing moves. A pinned row is
  // counted on the board it is pinned to, and named by nobody (its Save or its verify decides it).
  if (deps.dayOf) {
    const horizonRosters = new Map<string, RosterLoadRow[] | null>();
    for (const d of deps.horizon) horizonRosters.set(d, rosters.get(d) ?? null);
    const dayOf = deps.dayOf;
    const filedOn = (r: any) => pins.get(String(r?.stopNbr)) ?? dayOf(r);
    const skip = new Set<any>(unresolvedRows);
    for (const r of rows || []) if (r && pins.has(String(r.stopNbr))) skip.add(r);
    try { summary.rosterNamed = stampRosterNames(rows, filedOn, horizonRosters, skip, { rosterAt, nowIso }); } catch { /* a label, never a scan */ }
  }
  if (summary.candidates || pins.size) log(`[scan] route-load-day: ${summary.candidates} carried order(s) — ${summary.load} filed on their load's day, ${summary.held} shown unplanned${heldEnabled ? '' : ' (off)'}, ${summary.unresolved} left as filed, ${summary.kept} kept from the last scan; ${summary.reads}/${readMax} read(s) (${summary.phase1Reads} today-on, ${summary.phase2Reads} past${summary.unusableReads ? `, ${summary.unusableReads} unusable` : ''}), ${summary.memoHits} from the memo; ${pins.size} pinned to a later board (${summary.pinnedGrace} Save grace, ${summary.pinnedVerify} verify)${summary.movedWithoutStamp ? `; ${summary.movedWithoutStamp} MOVED WITHOUT A STAMP` : ''}${summary.memoUnreadable ? ' — MEMO UNREADABLE: nothing read' : ''}`);
  return { summary, memoDirty: Object.keys(memoUpdates).length > 0, memoUpdates, dayByNbr, rosters, readThisRun, pins };
}
