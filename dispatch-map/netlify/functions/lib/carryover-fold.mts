// lib/carryover-fold.mts — THE CARRY-OVER RULE, PURE (v1.77.0).
//
// Which of a prior day's orders are still open work for `date`: the board's own rule, lifted out of
// nuvizz-pull-today-stops.mts (mergeCarryover) unchanged so that two readers apply ONE rule — the
// Map / Routing board, and the Claude shadow's planning area (Chad, 2026-09-26: "let me set the
// parameters for tomorrows board such as the date and how many days it looks back for unplanned
// orders"). The board reads its inputs and calls this; the shadow reads the same documents from
// Firestore and calls this. No I/O here, no clock, no logger of its own: every input is passed in,
// so a plan and the Map cannot disagree about which orders are still open.
//
// The rules themselves (the open-order pool as judge, the unplanned snapshot as fallback, the
// retired list, confirmed-planned stamps, re-opened and re-planned orders, the write grace) are
// documented where they were written; the comments below travel with them verbatim.
import { poolUsable, POOL_LIVE_FIELDS, WINDOW_WRITE_GRACE_MS, type ActivePool } from './active-pool.mts';
import { unplanStampOvertaken } from './unplan-stamp.mts';

export interface CarryoverStats {
  /** what judged the prior-day rows: the scan's open-order pool, the older unplanned snapshot, or nothing */
  basis: 'pool' | 'snapshot' | 'none';
  poolAt: string | null; poolWhy: string | null; snapshotAt: string | null;
  added: number; pruned: number; replaced: number;
  closed: number; moved: number; retired: number; reopened: number; unverified: number; held: number; replanned: number;
  /** the judge was thin — nothing was dropped on its word */
  thin: boolean;
}

export function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The prior calendar days a look-back of `carryDays` reads: date−1 … date−carryDays. */
export function carryPriorDates(date: string, carryDays: number): string[] {
  return Array.from({ length: Math.max(0, carryDays) }, (_, i) => addDaysUTC(date, -(i + 1)));
}

export interface FoldInputs {
  date: string;
  /** each prior day's index rows (carryPriorDates order); a day that could not be read is [] */
  reads: { d: string; stops: any[] }[];
  live: { at: string | null; windowStart: string | null; stopNbrs: Set<string>; thin?: boolean } | null;
  retired: Record<string, string>;
  pool: ActivePool | null;
  nowMs: () => number;
  /**
   * THE JUDGES' CLOCK: the moment the pool's and the snapshot's 7-day backstops are measured at.
   * The Map reads it ONCE, after its three judge documents are in and BEFORE its prior-day reads —
   * exactly where it read the clock for these two checks before v1.77.0 moved this fold out of the
   * feed (audit feed-refactor F2: read after the reads, a week-old judge crossed its backstop a
   * read-duration early and the fold fell back to judging nothing). The planner reads it at the
   * same point. The per-row checks — the 48h confirmed-plan stamp and the 60-minute write grace —
   * still read nowMs() while the fold runs, after the reads, as they always have. Absent, or not a
   * finite number: nowMs(), read here, as before.
   */
  judgedAtMs?: number;
  lastUnplannedScanAt: string | null;
  log?: (msg: string) => void;
}

/**
 * Fold still-open prior-day orders into `stops` (mutated, exactly as the board always has: pushed,
 * or a stale unplanned today row replaced by its confirmed plan) and return what was decided.
 */
export function foldCarryover(stops: any[], f: FoldInputs): CarryoverStats {
  const { date, reads, live, retired, pool, nowMs, lastUnplannedScanAt } = f;
  const log = f.log ?? (() => {});
  const seen = new Set(stops.map((s) => String(s.stopNbr)));
  const judgedAt = typeof f.judgedAtMs === 'number' && Number.isFinite(f.judgedAtMs) ? f.judgedAtMs : null;
  const poolCheck = poolUsable(pool, { nowMs: judgedAt ?? nowMs(), newestDocScanAt: lastUnplannedScanAt });
  const poolOk = !!(pool && poolCheck.ok);
  const poolThin = !!(pool && pool.thin === true);
  const poolByNbr = new Map<string, any>();
  if (poolOk) for (const p of pool!.rows) { const k = String(p?.stopNbr ?? '').trim(); if (k && !poolByNbr.has(k)) poolByNbr.set(k, p); }
  // SNAPSHOT TRUST — scan-relative, not wall-clock (the weekend phantom fix, Aug 2). The old
  // guard aged the snapshot against the clock (18h — "survives an overnight gap, not a
  // weekend"), so every weekend scan blackout switched pruning OFF and the board folded EVERY
  // frozen prior-day unplanned row: Aug 2 it showed 127 carry-overs of which 105 were already
  // closed (Chad: "we do not have 127 orders carrying over from last week"). But time alone
  // cannot stale this snapshot — the prior-day boards it judges are frozen by the SAME blackout,
  // so nothing served here is ever newer than the snapshot unless a scan ran after it. So: trust
  // the snapshot until an orders scan SUPERSEDES it without refreshing it (list scans write the
  // board stamp and the snapshot from one shared scannedAt, so a board stamp measurably newer
  // than the snapshot means the snapshot writer is off — the TWO_SCAN-disabled case the old
  // guard actually existed for). A 7-day ceiling stays as an absolute backstop; past it (or when
  // trust fails) we fall back to legacy behaviour: fold everything in, prune nothing —
  // over-counting, never hiding work. A THIN snapshot (the scan's own verdict that the pull
  // that built it came back short) is never trusted to prune either.
  const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // absolute backstop, not the working rule
  const SUPERSEDE_SLACK_MS = 15 * 60 * 1000;   // same scan ⇒ identical stamps; slack absorbs legacy paths
  const snapAtMs = live?.at ? new Date(live.at).getTime() : NaN;
  const snapshotAgeMs = Number.isFinite(snapAtMs) ? ((judgedAt ?? nowMs()) - snapAtMs) : Infinity;
  const boardScanMs = lastUnplannedScanAt ? new Date(lastUnplannedScanAt).getTime() : NaN;
  const superseded = Number.isFinite(snapAtMs) && Number.isFinite(boardScanMs)
    && (boardScanMs - snapAtMs) > SUPERSEDE_SLACK_MS;
  const fresh = Number.isFinite(snapshotAgeMs) && snapshotAgeMs >= 0 && snapshotAgeMs <= SNAPSHOT_MAX_AGE_MS && !superseded;
  const snapThin = !!(live && (live as any).thin === true);
  const liveOk = !!(live && live.stopNbrs.size && live.windowStart && fresh && !snapThin);
  if (!poolOk && live && live.stopNbrs.size && live.windowStart && !liveOk) {
    const why = snapThin ? `thin — the scan that wrote it judged its own pull short`
      : superseded ? `superseded — an orders scan at ${lastUnplannedScanAt} never refreshed the ${live.at} snapshot`
      : `age ${Number.isFinite(snapshotAgeMs) ? Math.round(snapshotAgeMs / 3.6e6) + 'h' : 'n/a'} is past the ${Math.round(SNAPSHOT_MAX_AGE_MS / 3.6e6)}h backstop`;
    log(`[carryover] ${date}: live unplanned snapshot not trusted (${why}) — skipping prune, folding all carry-over`);
  }
  if (pool && !poolOk) log(`[carryover] ${date}: open-order pool not used (${poolCheck.why}) — falling back to the unplanned snapshot`);
  const stats: CarryoverStats = {
    basis: poolOk ? 'pool' : (liveOk ? 'snapshot' : 'none'),
    poolAt: pool?.at ?? null, poolWhy: poolCheck.why, snapshotAt: live?.at ?? null,
    added: 0, pruned: 0, replaced: 0, closed: 0, moved: 0, retired: 0, reopened: 0, unverified: 0, held: 0, replanned: 0,
    thin: poolOk ? poolThin : snapThin,
  };
  // A confirmed-planned stamp folds only while FRESH (48h): the home-day stamp is frozen
  // forever (prior days are never rescanned), so without the cap a long-DELIVERED old-dated
  // order kept folding back as live SCHEDULED for the full carry window (audit F6).
  const STAMP_FRESH_MS = 48 * 3600 * 1000;
  // The pool's live fields laid over the frozen copy: status and plan are this scan's, the pin
  // and the customer detail stay the copy's. Same overlay the Routing window applies.
  const overlay = (s: any, p: any) => {
    const m: any = { ...s };
    for (const k of POOL_LIVE_FIELDS) if (p[k] !== undefined) m[k] = p[k];
    m.poolSynced = true;
    return m;
  };
  const fold = (s: any, d: string, extra: Record<string, any> = {}) => {
    seen.add(String(s.stopNbr));
    // boardDate pinned to the served day (consistency with the replace path): downstream
    // day-bucketing must file this row under the board it is being served on.
    stops.push({ ...s, carryover: true, scheduledDate: d, boardDate: date, ...extra });
    stats.added++;
  };
  for (const { d, stops: prior } of reads) {
    for (const s of prior) {
      if (!s) continue;
      const key = String(s.stopNbr ?? '').trim();
      if (!key) continue;
      // `isTerminal` on these rows means "delivers to Davis's own terminal" (detectTerminal in
      // nuvizz-scan.mts), not a terminal status — it used to end this loop for such rows, so a
      // terminal-bound order carried nowhere. Status is the truth (audit P4/P7a): a cancelled
      // order (status 99, no route) read as plain UNPLANNED and folded back as workable whenever
      // the live snapshot was stale, and a DELIVERED row that kept its write stamp would qualify
      // for the confirmed-planned fold.
      const stTerm = String(s.normalizedStatus ?? '').toUpperCase();
      const terminal = stTerm === 'DELIVERED' || stTerm === 'EXCEPTION' || stTerm === 'CANCELLED';
      const p = poolOk ? poolByNbr.get(key) : undefined;
      if (terminal) {
        // RE-OPENED (v0.95.0): the pool lists this number OPEN again on a past day — an ATT
        // re-attempt under the same stop number (HIGHLAND FORGE, refused on TAYLOR 09/02 and
        // re-opened by CS). Before this the frozen finished copy outranked the live open row and
        // the Map never showed freight NuVizz was asking to have planned. The scan heals the copy
        // on its next pass; this fold does not wait for it.
        if (p && p.day < date && !seen.has(key)) { fold(overlay(s, p), d, { reopened: true }); stats.reopened++; }
        continue;                                          // history: never folded
      }
      // UNPLANNED prior-day rows fold as always. ONE planned exception (NOLAN, OWUSU 1,
      // Jul 10): a prior-day order a CONFIRMED live Save routed onto a load that runs
      // today (board_write_planned — the write-through/rescue stamp) must keep folding,
      // or the order vanishes from the board entirely the moment its Compare card closes
      // — while NuVizz's load holds it. Other planned prior-day rows still never fold
      // (they're that day's own live routes, not today's work) — UNLESS the pool now lists
      // the order UNPLANNED on a past day (v0.95.0: un-planned in NuVizz after its day froze,
      // PRIMARY LOGISTICS' 10,000 lb hidden from the pool of work to plan for a weekend).
      const confirmedPlanned = s.isPlanned && s.board_write_planned === true
        && s.board_write_at && (nowMs() - Date.parse(s.board_write_at)) <= STAMP_FRESH_MS;
      if (s.isPlanned && !confirmedPlanned) {
        if (p && p.day < date && p.isPlanned !== true && !seen.has(key)) { fold(overlay(s, p), d); stats.replanned++; }
        continue;
      }
      if (seen.has(key)) {
        // SHADOW FIX (audit F2): a stale-UNPLANNED today row (pre-fix revert residue) must not
        // hide the confirmed plan — replace it in place. A today row that is planned, or that
        // carries its own write stamp, always wins.
        if (confirmedPlanned) {
          const idx = stops.findIndex((t: any) => String(t?.stopNbr) === key);
          const cur = idx >= 0 ? stops[idx] : null;
          if (cur && cur.isPlanned !== true && !cur.board_write_at) {
            stops[idx] = { ...s, carryover: true, scheduledDate: d, boardDate: date };
            stats.replaced++;
          }
        }
        continue;
      }
      if (poolOk) {
        // A confirmed Save outranks the pool while the pool is older than the stamp, or while the
        // stamp is inside the board's write grace and the pool still disagrees — the same hold the
        // Routing window applies, so the two screens cannot disagree about a plan somebody just made.
        const stampAt = Date.parse(String(s.board_write_at || ''));
        const stampNewer = Number.isFinite(stampAt) && stampAt > Date.parse(pool!.at);
        const inGrace = Number.isFinite(stampAt) && nowMs() - stampAt < WINDOW_WRITE_GRACE_MS;
        const agrees = !!p && (s.isPlanned === true) === (p.isPlanned === true);
        // Same discriminator as the scan and the window (v1.8.0): a pool row naming a route this
        // order was not taken off has seen the world after our Save, so the stamp is stale.
        if ((stampNewer || inGrace) && !agrees && !(p && unplanStampOvertaken(s, p))) { fold(s, d); stats.held++; continue; }
        if (p) {
          if (p.day >= date) {
            // NuVizz files it on today or later now: today's own row (already served) or a
            // future day's work. A confirmed plan without a today row keeps folding until the
            // board write that carries it lands.
            if (confirmedPlanned) { fold(s, d); continue; }
            stats.moved++; stats.pruned++; continue;
          }
          fold(overlay(s, p), d); continue;                 // still open on a past day: live state, frozen pin
        }
        const inReach = d >= pool!.windowStart;
        if (!confirmedPlanned) {
          if (inReach && !poolThin) { stats.closed++; stats.pruned++; continue; }   // NuVizz no longer lists it
          if (retired[key]) { stats.retired++; stats.pruned++; continue; }
          if (!inReach) { fold(s, d, { unverified: true }); stats.unverified++; continue; }   // older than any scan can see: served, and SAID so
        }
        fold(s, d); continue;                               // thin pool inside reach, or a confirmed plan: no verdict, folds
      }
      // Within the live window but no longer unplanned in the latest scan → delivered/planned
      // since. Applies to the UNPLANNED fold only — a confirmed-planned row is EXPECTED to be
      // absent from the unplanned snapshot (it just got planned; that's not "closed since").
      if (!confirmedPlanned && liveOk && d >= live!.windowStart! && !live!.stopNbrs.has(key)) { stats.closed++; stats.pruned++; continue; }
      // OUTSIDE that window the snapshot is not entitled to judge, and prior-day board docs are
      // frozen — which is how rows from a fortnight ago kept folding as UNPLANNED with nothing
      // able to retire them (Chad: "it's showing more than that"). The scan proves those against
      // the IMMUTABLE history warehouse and records the finished ones here, so a row sealed
      // DELIVERED/EXCEPTION/CANCELLED on ANY day retires at any age. Unproven rows are absent
      // from the map and still fold — this can only ever remove a stop history says is done.
      if (!confirmedPlanned && retired[key]) { stats.retired++; stats.pruned++; continue; }
      const vouched = confirmedPlanned || (liveOk && d >= live!.windowStart!);
      if (vouched) { fold(s, d); continue; }
      fold(s, d, { unverified: true }); stats.unverified++;
    }
  }
  if (stats.replaced) log(`[carryover] ${date}: replaced ${stats.replaced} stale-unplanned row(s) with their confirmed plans`);
  if (stats.pruned || stats.reopened || stats.replanned || stats.held) log(`[carryover] ${date}: basis=${stats.basis}${stats.thin ? ' (thin)' : ''} folded ${stats.added}, pruned ${stats.pruned} (closed ${stats.closed}, moved ${stats.moved}, retired ${stats.retired}), reopened ${stats.reopened}, re-planned ${stats.replanned}, held ${stats.held}, unverified ${stats.unverified}`);
  return stats;
}
