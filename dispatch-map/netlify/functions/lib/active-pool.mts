// lib/active-pool.mts — THE OPEN-ORDER POOL, and how a date window is reconciled against it.
//
// THE PROBLEM THIS SOLVES (Chad, Sep 7, two screenshots side by side): the Route Workbench
// showed 525 unplanned stops for 09/01–09/08 and the Routing screen's date window showed 550,
// "with the same filters". They were not reading the same data. The Workbench asks NuVizz.
// The window is served from the app's own per-day board snapshots, and a snapshot stops being
// rewritten at the end of its own day (the scan writes today plus the next two business days,
// nothing older). So an order that was still unplanned when 09/01 closed read unplanned FOREVER
// in that window — 29 delivered/closed orders and one re-dated one were sitting in the planning
// pool, and three orders NuVizz had un-planned on Friday afternoon were still shown on old loads,
// hidden from "Unplanned" and from the selection. PRIMARY LOGISTICS, 10,000 lb, was one of them.
//
// THE FIX. The scan already holds the whole active list in memory on every run — the ±7d
// planned/unplanned saved search, filed by day — and then writes two or three of those days
// and drops the rest. This module keeps the rest: every OPEN row across every day, projected
// to the fields the grid and the map need, written to one small document set each scan (zero
// extra NuVizz calls — same data, one Firestore write). The date window then reconciles its
// cached rows against that pool:
//   · a pool row inside the window overlays its LIVE fields (status, plan, load, driver, day,
//     freight) onto the cached row, which keeps its coordinates and enrichment;
//   · a pool row the cache never captured (a "-1" duplicate created after its day froze, an ATT
//     re-attempt re-opened by customer service) is ADDED, without coordinates — it lists in the
//     grid under the no-location chip rather than not existing;
//   · a cached OPEN row the pool no longer lists, from a day the pool covers, is DROPPED — it
//     delivered, was cancelled/refused, or was re-dated out of reach; a cached row the pool lists
//     under a day OUTSIDE the window is dropped too (it belongs on that other day now);
//   · a cached row older than the pool's reach is pruned only by the retired list (the history
//     warehouse's proof), exactly as the Map's carry-over fold does;
//   · finished rows (delivered / exception / cancelled) are history and are never touched.
//
// WHAT IS DELIBERATELY NOT DROPPED. A cached row carrying a confirmed-Save write stamp NEWER
// than the pool (board_write_at > pool.at) is held as-is: the dispatcher just planned it and
// the pool has not been rewritten since — overlaying the pool's older "unplanned" would undo
// the write-through this repo already fixed once (the LVILLE lingering).
//
// PURE. No I/O in here; the explorer reads, this decides, the explorer serves. Every rule
// above has a test named for the real order it was written for.

/** Rows the pool carries. Deliberately compact: ~25 fields, no raw NuVizz object, comments
 *  clipped — a heavy day is 1,500 open rows and this must stay well inside Firestore's
 *  1 MiB document limit per chunk (the writer chunks at 400 rows). */
export const POOL_LIVE_FIELDS = [
  'status', 'normalizedStatus', 'isPlanned', 'isUnplanned',
  'loadNbr', 'routeName', 'routeSeq', 'driverName', 'driverUserName', 'driverId',
  'listUpdatedDTTM', 'shipmentNbr', 'isAttempt',
  'weight', 'cartons', 'volume', 'scheduledFrom', 'plannedEtaDTTM',
] as const;
export const POOL_STATIC_FIELDS = [
  'stopId', 'businessName', 'addr1', 'addr2', 'city', 'state', 'zip', 'stopType', 'proNbr',
  'requestedDate', 'dupNbr', 'dupNbrOtherId',
] as const;
const INSTRUCTIONS_MAX = 400;

export interface ActivePool {
  at: string;
  windowStart: string;
  windowEnd: string;
  count: number;
  rows: any[];
}

const TERMINAL = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);
const TERMINAL_CODES = new Set(['90', '91', '80', '99']);

/** A finished outcome — delivered, refused, cancelled. Reads BOTH the normalized status and the
 *  raw code: list-only rows always carry the code, enriched rows may carry only the status. */
export function isTerminalRow(s: any): boolean {
  if (!s) return false;
  if (TERMINAL.has(String(s.normalizedStatus ?? '').toUpperCase())) return true;
  return TERMINAL_CODES.has(String(s.status ?? '').trim());
}

/** The day a cached row is filed under — the doc it came from (boardDate is pinned to the doc
 *  day at write time), then the scheduled day, then the requested day. */
export function rowDayOf(s: any): string | null {
  const d = s?.boardDate || s?.scheduledDate || s?.requestedDate || null;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** PURE: one board-shaped scan row → one pool row for `day` (the bucket it was filed under). */
export function projectPoolRow(s: any, day: string): any {
  const out: any = { stopNbr: String(s.stopNbr), day, boardDate: day, scheduledDate: day };
  for (const k of POOL_LIVE_FIELDS) if (s[k] !== undefined) out[k] = s[k];
  for (const k of POOL_STATIC_FIELDS) if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  const instr = s.orderInstructions;
  if (typeof instr === 'string' && instr.trim()) out.orderInstructions = instr.length > INSTRUCTIONS_MAX ? instr.slice(0, INSTRUCTIONS_MAX) + '…' : instr;
  // The PRO is the stop number (see nuvizz-scan: pros = [stopNbr]); the grid's PRO column reads these.
  out.pro = out.stopNbr; out.pros = [out.stopNbr]; out.primaryPro = out.stopNbr;
  out.source = 'active-pool';
  return out;
}

/**
 * PURE: the pool for one scan — every OPEN row in the two-scan buckets, whatever day it was
 * filed under. Terminal rows are left out (they are history, and the completed search only
 * carries today's anyway). Duplicated stop numbers keep the first filing.
 */
export function buildActivePool(
  buckets: Map<string, any[]> | Iterable<[string, any[]]>,
  meta: { at: string; windowStart: string; windowEnd: string },
): ActivePool {
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const [day, stops] of buckets as Iterable<[string, any[]]>) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) continue;
    for (const s of stops || []) {
      const nbr = String(s?.stopNbr ?? '').trim();
      if (!nbr || seen.has(nbr) || isTerminalRow(s)) continue;
      seen.add(nbr);
      rows.push(projectPoolRow(s, String(day)));
    }
  }
  return { at: meta.at, windowStart: meta.windowStart, windowEnd: meta.windowEnd, count: rows.length, rows };
}

export interface ReconcileStats {
  poolAt: string | null;
  /** cached open rows the pool no longer lists, from a day it covers — delivered / cancelled / re-dated out of reach */
  closed: number;
  /** cached open rows the pool lists under a day outside this window — they belong there now */
  moved: number;
  /** cached open rows older than the pool's reach, proven finished by the history warehouse */
  retired: number;
  /** pool rows the cache never captured — listed without coordinates */
  added: number;
  /** cached rows whose live fields the pool refreshed */
  synced: number;
  /** cached rows held as-is because a confirmed Save stamped them after the pool was written */
  held: number;
}

const emptyStats = (poolAt: string | null): ReconcileStats => ({ poolAt, closed: 0, moved: 0, retired: 0, added: 0, synced: 0, held: 0 });

function stampNewerThan(row: any, at: string | null | undefined): boolean {
  if (!row?.board_write_at || !at) return false;
  const a = Date.parse(String(row.board_write_at)); const b = Date.parse(String(at));
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;

/**
 * PURE: reconcile a window's cached rows (already deduped by stop number) against the pool.
 * Returns the rows to serve plus a count of every decision, so the response can say exactly
 * what it removed and why — a pruning nobody can see is a row that "just vanished".
 */
export function mergeWindowWithPool(
  cached: any[],
  pool: ActivePool | null | undefined,
  opts: { from: string; to: string; retired?: Record<string, string> | null },
): { rows: any[]; stats: ReconcileStats } {
  const retired = opts.retired || {};
  if (!pool || !Array.isArray(pool.rows)) {
    return { rows: cached.slice(), stats: emptyStats(null) };
  }
  const stats = emptyStats(pool.at || null);
  const poolByNbr = new Map<string, any>();
  for (const p of pool.rows) { const k = String(p?.stopNbr ?? '').trim(); if (k && !poolByNbr.has(k)) poolByNbr.set(k, p); }
  const out: any[] = [];
  const served = new Set<string>();
  for (const c of cached) {
    const nbr = String(c?.stopNbr ?? '').trim();
    if (!nbr) continue;
    if (isTerminalRow(c)) { out.push(c); served.add(nbr); continue; }          // history: never touched
    if (stampNewerThan(c, pool.at)) { out.push(c); served.add(nbr); stats.held++; continue; }
    const p = poolByNbr.get(nbr);
    if (p) {
      if (!inRange(p.day, opts.from, opts.to)) { stats.moved++; continue; }   // lives on another day now
      const merged: any = { ...c };
      for (const k of POOL_LIVE_FIELDS) if (p[k] !== undefined) merged[k] = p[k];
      merged.boardDate = p.day; merged.scheduledDate = p.day;
      if (!merged.stopId && p.stopId) merged.stopId = p.stopId;
      if (!merged.businessName && p.businessName) merged.businessName = p.businessName;
      merged.poolSynced = true;
      out.push(merged); served.add(nbr); stats.synced++;
      continue;
    }
    const day = rowDayOf(c);
    if (day && day >= pool.windowStart && day <= pool.windowEnd) { stats.closed++; continue; }
    if (retired[nbr]) { stats.retired++; continue; }
    out.push(c); served.add(nbr);                                              // older than the pool's reach: no verdict
  }
  for (const p of pool.rows) {
    const nbr = String(p?.stopNbr ?? '').trim();
    if (!nbr || served.has(nbr) || !inRange(p.day, opts.from, opts.to)) continue;
    served.add(nbr);
    out.push({ ...p, lat: null, lng: null, poolOnly: true });
    stats.added++;
  }
  return { rows: out, stats };
}

/**
 * PURE: the fallback when no pool has been written yet — the same evidence the Map's
 * carry-over fold uses. The live unplanned snapshot (stop numbers currently unplanned across
 * the ±7d pull) drops a cached UNPLANNED row from a prior day it covers when the row is no
 * longer in it; the retired list drops older rows the history warehouse has sealed finished.
 * Planned rows are left alone (the snapshot carries no evidence about them). Snapshot trust
 * is the same 7-day backstop the fold uses.
 */
export function pruneWithSnapshot(
  cached: any[],
  snapshot: { at: string | null; windowStart: string | null; stopNbrs: Set<string> } | null | undefined,
  retired: Record<string, string> | null | undefined,
  opts: { today: string; nowMs?: number },
): { rows: any[]; stats: ReconcileStats } {
  const stats = emptyStats(snapshot?.at || null);
  const now = opts.nowMs ?? Date.now();
  const snapAt = snapshot?.at ? Date.parse(snapshot.at) : NaN;
  const fresh = Number.isFinite(snapAt) && now - snapAt >= 0 && now - snapAt <= 7 * 86400000;
  const liveOk = !!(snapshot && snapshot.stopNbrs && snapshot.stopNbrs.size && snapshot.windowStart && fresh);
  const ret = retired || {};
  const out: any[] = [];
  for (const c of cached) {
    const nbr = String(c?.stopNbr ?? '').trim();
    if (!nbr) continue;
    const day = rowDayOf(c);
    const open = !isTerminalRow(c);
    const unplanned = open && c.isUnplanned === true;
    if (unplanned && day && day < opts.today && !stampNewerThan(c, snapshot?.at)) {
      if (liveOk && day >= snapshot!.windowStart! && !snapshot!.stopNbrs.has(nbr)) { stats.closed++; continue; }
      if (ret[nbr]) { stats.retired++; continue; }
    }
    out.push(c);
  }
  return { rows: out, stats };
}
