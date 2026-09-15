// lib/name-collision.mts — TWO LOADS WEARING ONE NAME, told apart by the roster (v1.31.0).
//
// Chad, 2026-09-15, ESTES on the board reading 16 stops against NuVizz's 10, BUFORD reading 8
// against 7, after a fresh scan of each: "our roster scans do carry the load id you just aren't
// using it correctly." He was right. The stop list (saved search 77128) names a stop's route by
// its NAME only — `route.name`, no load number, no load id (nuvizz-list.mts) — so every list
// row on today's board says "ESTES" and nothing on the row says WHICH ESTES. A recurring route
// mints a new load every day, and an undelivered order left on Tuesday's ESTES still reads
// "ESTES" on Friday. boardDayFor clamps an open routed stop with a past arrival forward onto
// today (nuvizz-list.mts), the Routing card groups by name (App.jsx computeRouteGroups), and
// six orders on a week-old Draft load printed on Trevor's dispatched truck.
//
// What the system already HOLDS and was not using: the day's load roster (saved search 35833)
// carries, per load, the load NUMBER, the load id and NuVizz's own stop COUNT ("trips"). That
// count is the free contradiction detector — 16 rows under a name the roster gives one load of
// 10 stops means at least six rows are on some other load of the same name. Which six is a
// question only the load itself can answer, and it answers it in ONE /load/info read — the
// same read the demotion verify already spends (lookupLoadStopNbrs). Rows the load does not
// hold are on another instance of the name, and if their own arrival day is in the past they
// are that day's freight, not today's: they come OFF today's board and stay on their own day's
// document, exactly the rule the load-id anchor (dropForeignLoadStops) was written to apply and
// never could, because list rows carry no id for it to read.
//
// PURE. No I/O, no clock: every decision here is testable on plain data. The scan wires the
// reads (refresh-stops-core) and keeps the memo (firestore); nothing here spends a call.
//
// COST DISCIPLINE. The membership read is spent only when the roster and the board disagree
// (rows > trips, or two rows claiming the same sequence number), at most
// NUVIZZ_NAME_COLLISION_LOAD_MAX loads per run, and it is memoised by SIGNATURE — the load
// number, the roster's count and the exact set of stop numbers under the name. A collision that
// stands all day is asked about once, then again only when that set or that count changes, or
// after NAME_COLLISION_MEMO_TTL_MS as a safety re-check. Nothing is ever dropped on a failed or
// missing read: no membership, no verdict, next scan.
//
// NEVER HIDES TODAY'S FREIGHT. A row the load does not hold but whose own arrival day is today
// (or later) is kept and ledgered as HELD — an order filed onto yesterday's load by mistake is
// still today's delivery, and a board that quietly loses it is worse than a card that over-counts.
// A row a confirmed Save stamped planned inside the write grace is kept for the same reason the
// scan's own merge keeps it: the list (and a load read racing that Save) can lag the portal.

import type { PlanVerdictRow } from './firestore.mts';

/** NUVIZZ_NAME_COLLISION — house shape: default ON, an explicit off-word turns it off, and
 *  anything malformed leaves it ON (a typo must never silently disable a rule). */
export function nameCollisionEnabled(env: any = process.env): boolean {
  const v = String(env?.NUVIZZ_NAME_COLLISION ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** How many /load/info reads one RUN may spend on collisions (shared across its dates). */
export function nameCollisionLoadMax(env: any = process.env): number {
  const raw = String(env?.NUVIZZ_NAME_COLLISION_LOAD_MAX ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

/** A memoised verdict is re-asked after this long even when nothing about it has changed. */
export const NAME_COLLISION_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
export function nameCollisionMemoTtlMs(env: any = process.env): number {
  const raw = String(env?.NUVIZZ_NAME_COLLISION_TTL_MIN ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) * 60_000 : NAME_COLLISION_MEMO_TTL_MS;
}

export interface RosterLoadLite {
  loadId?: string | null;
  name?: string | null;
  loadNbr?: string | null;
  status?: string | null;
  driver?: string | null;
  trips?: number | null;
}

export interface NameCollision {
  /** the route name as the rows spell it (trimmed) */
  name: string;
  /** the ONE load on the day's roster carrying that name — the instance the board is for */
  loadNbr: string;
  loadId: string | null;
  status: string | null;
  /** NuVizz's own stop count for that load, from the roster */
  trips: number;
  /** every board row under the name, whatever its status */
  rows: any[];
  /** two rows claim the same delivery sequence — proof of two loads even when the counts agree */
  dupSeq: boolean;
  /** what a memoised verdict is valid for: this load, this count, exactly these stop numbers */
  signature: string;
}

const norm = (v: any) => String(v ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
const nameKey = (v: any) => String(v ?? '').trim().toLowerCase();

/** The day a row belongs to on its own account — Estimated Arrival, then Requested, then
 *  scheduled — BEFORE boardDayFor's live-route clamp moved it onto today. */
export function ownDayOf(row: any): string | null {
  const d = row?.boardDate || row?.requestedDate || row?.scheduledDate || null;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * PURE. Which route names on this board contradict the day's roster.
 *
 * A name is judged only when the roster carries EXACTLY ONE load by it (two same-named loads on
 * one day is the §S case: neither may speak for the other, and the board's own ambiguity rules
 * already handle it) and that load reports a stop count. The contradiction is either more rows
 * than the load holds, or two rows claiming one sequence number.
 */
export function detectNameCollisions(rows: any[], rosterLoads: RosterLoadLite[] | null | undefined): NameCollision[] {
  const byName = new Map<string, RosterLoadLite[]>();
  for (const l of rosterLoads || []) {
    const k = nameKey(l?.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(l);
  }
  const groups = new Map<string, any[]>();
  for (const r of rows || []) {
    if (!r || r.isPlanned !== true) continue;
    // A row the pull did NOT return this scan (carried forward as a demote candidate) makes no
    // fresh claim about its route — it is the demotion verify's question, not this one's.
    if (r.absentFromPull === true) continue;
    const name = String(r.routeName ?? r.loadNbr ?? '').trim();
    if (!name) continue;
    const k = nameKey(name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: NameCollision[] = [];
  for (const [k, grp] of groups) {
    const loads = byName.get(k);
    if (!loads || loads.length !== 1) continue;                       // unknown or contested name → not ours to judge
    const l = loads[0];
    const loadNbr = String(l.loadNbr ?? '').trim();
    // `trips` is a NUMBER or null (normalizeLoads) — and null is "no count", never zero.
    const trips = typeof l.trips === 'number' && Number.isFinite(l.trips) ? l.trips : null;
    if (!loadNbr || trips == null || trips < 0) continue;              // nothing to read, or no count to contradict
    const seqs = new Map<number, number>();
    for (const r of grp) {
      const s = typeof r.routeSeq === 'number' && Number.isFinite(r.routeSeq) ? r.routeSeq : null;
      if (s == null) continue;
      seqs.set(s, (seqs.get(s) || 0) + 1);
    }
    const dupSeq = [...seqs.values()].some((n) => n > 1);
    if (!(grp.length > trips || dupSeq)) continue;
    const nbrs = [...new Set(grp.map((r) => String(r.stopNbr ?? '').trim()).filter(Boolean))].sort();
    out.push({
      name: String(grp[0].routeName ?? grp[0].loadNbr ?? '').trim(),
      loadNbr, loadId: l.loadId ? String(l.loadId) : null, status: l.status ? String(l.status) : null,
      trips, rows: grp, dupSeq,
      signature: `${loadNbr}|${trips}|${nbrs.join(',')}`,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A load read that came back EMPTY while the roster counts stops on it is a contradiction
 *  inside NuVizz's own feeds, not a verdict — never drop a row on it. */
export function membershipUsable(members: Set<string> | null | undefined, trips: number): boolean {
  if (!members) return false;
  return members.size > 0 || trips === 0;
}

export interface MembershipSplit {
  /** rows the load holds — untouched */
  keep: any[];
  /** rows the load does NOT hold, with a past arrival day of their own → off this board */
  foreign: any[];
  /** rows the load does NOT hold but which are today's (or later) freight → kept, ledgered */
  keptSameDay: any[];
  /** rows the load does NOT hold that a confirmed Save stamped planned inside the grace → kept */
  keptStamped: any[];
}

/**
 * PURE. Rows under the name, sorted by what the load's own membership says about them.
 * `members` carries raw and normalised forms (lookupLoadStopNbrs); the row is matched both ways.
 */
export function splitByMembership(
  c: NameCollision,
  members: Set<string>,
  opts: { date: string; nowMs: number; graceMin?: number; overrides?: Record<string, string> | null },
): MembershipSplit {
  const graceMs = (opts.graceMin ?? 60) * 60_000;
  const out: MembershipSplit = { keep: [], foreign: [], keptSameDay: [], keptStamped: [] };
  for (const r of c.rows) {
    const raw = String(r?.stopNbr ?? '').trim();
    if (!raw) { out.keep.push(r); continue; }
    if (members.has(raw) || members.has(norm(raw))) { out.keep.push(r); continue; }
    const stampAt = r?.board_write_planned === true ? Date.parse(String(r.board_write_at || '')) : NaN;
    if (Number.isFinite(stampAt) && opts.nowMs - stampAt < graceMs) { out.keptStamped.push(r); continue; }
    // A dispatcher-set board date (setStopDate — "the customer doesn't want it until the 30th")
    // is the row's own day: it was filed here on purpose and is never a past-day stray.
    const set = opts.overrides ? opts.overrides[raw] : null;
    const own = (typeof set === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(set)) ? set : ownDayOf(r);
    if (own && own < opts.date) out.foreign.push(r);
    else out.keptSameDay.push(r);
  }
  return out;
}

export interface OtherInstance { date: string; loadNbr: string; status: string | null; trips: number | null }

/** PURE. Same-named loads on OTHER days' rosters — where the foreign rows may actually live.
 *  Newest first; the day being judged is skipped. */
export function otherInstances(
  name: string,
  rosters: Array<{ date: string; loads: RosterLoadLite[] | null | undefined }>,
  opts: { exceptDate: string },
): OtherInstance[] {
  const k = nameKey(name);
  const out: OtherInstance[] = [];
  for (const r of rosters || []) {
    if (!r || r.date === opts.exceptDate) continue;
    for (const l of r.loads || []) {
      if (nameKey(l?.name) !== k) continue;
      const nbr = String(l?.loadNbr ?? '').trim();
      if (!nbr) continue;
      const t = Number(l?.trips);
      out.push({ date: r.date, loadNbr: nbr, status: l?.status ? String(l.status) : null, trips: Number.isFinite(t) ? t : null });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ── The memo ──────────────────────────────────────────────────────────────────────────
export interface CollisionMemoEntry {
  /** the signature the members were read for */
  sig: string;
  /** when the load was read */
  at: string;
  /** the load's stop numbers as read (raw + normalised, as lookupLoadStopNbrs returns them) */
  members: string[];
  rows: number;
  trips: number;
}

/** PURE. May a stored verdict stand in for a read? Same signature and not past the TTL. */
export function memoUsable(entry: CollisionMemoEntry | null | undefined, signature: string, nowMs: number, ttlMs: number): boolean {
  if (!entry || entry.sig !== signature || !Array.isArray(entry.members)) return false;
  const at = Date.parse(String(entry.at || ''));
  if (!Number.isFinite(at)) return false;
  return nowMs - at < ttlMs;
}

// ── The ledger rows ───────────────────────────────────────────────────────────────────
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** PURE. The sentence a dispatcher reads in nuvizz-stop-explain for one foreign row. */
export function collisionDetail(c: NameCollision, opts: { date: string; readAt: string; others: OtherInstance[] }): string {
  const other = opts.others[0];
  const elsewhere = other
    ? `; another load named ${c.name} is on the ${other.date} roster (${other.loadNbr}${other.status ? `, ${other.status}` : ''}${other.trips != null ? `, ${plural(other.trips, 'stop')}` : ''})`
    : '; no other load by that name is on any recent roster';
  return `not on ${c.loadNbr} (${c.name}, ${plural(c.trips, 'stop')} on the ${opts.date} roster) — the load's own membership read at ${opts.readAt} does not list it${elsewhere}`;
}

export function collisionLedgerRows(
  c: NameCollision,
  split: MembershipSplit,
  opts: { date: string; at: string; readAt: string; fromMemo: boolean; others: OtherInstance[] },
): PlanVerdictRow[] {
  const detail = collisionDetail(c, { date: opts.date, readAt: opts.readAt, others: opts.others });
  const path = [
    `roster ${opts.date}: ${c.name} → ${c.loadNbr}, ${plural(c.trips, 'stop')}; the board held ${plural(c.rows.length, 'row')} under the name${c.dupSeq ? ', two of them with one sequence number' : ''}`,
    `${opts.fromMemo ? 'membership (memo)' : 'membership read'}: ${c.loadNbr} holds ${split.keep.length} of them`,
  ];
  const row = (r: any, verdict: PlanVerdictRow['verdict'], tail: string): PlanVerdictRow => ({
    at: opts.at, stopNbr: String(r.stopNbr), route: c.name, verdict, basis: 'name-collision',
    detail: `${detail}${tail}`, path,
    absent: r?.absentFromPull === true, listStatus: r?.status != null ? String(r.status) : null,
  });
  return [
    ...split.foreign.map((r) => row(r, 'dropped', ` — its own day is ${ownDayOf(r)}, so it stays on that day's board and comes off ${opts.date}`)),
    ...split.keptSameDay.map((r) => row(r, 'held', ` — but its own day is ${ownDayOf(r) ?? 'unknown'}, so it stays on this board rather than vanish`)),
    ...split.keptStamped.map((r) => row(r, 'held', ` — but a confirmed Save stamped it planned at ${r.board_write_at}, which outranks a read that may be racing it`)),
  ];
}
