// lib/refile-core.mts — what the scan does about stops that live on FROZEN days.
//
// THE PROBLEM, IN ONE LINE. The scan writes today plus two business days and never rewrites a
// past day's board, so anything NuVizz does to an order after its arrival day has passed —
// deliver it, refuse it, cancel it, un-plan it, re-open it as an ATT re-attempt — lands in a
// bucket the write loop drops on the floor, and the frozen copy keeps telling the old story.
//
// WHAT WAS MEASURED (Sep 7). Zach planned RA52300615 and 007170166-1 onto BEN 1 in the same
// minute (03:04 on 09/02); both dispatched at 05:05 and delivered mid-morning. RA52300615 is on
// the 09/02 board as delivered; 007170166-1 was on no board at all and its 09/01 copy still
// read "unplanned", one of 30 such orders in that window. PRIMARY LOGISTICS (10,000 lb) was
// un-planned in NuVizz on Friday afternoon after the 09/02 snapshot froze and still read
// "planned on MARCUS 2" there, hidden from the pool of work to plan. HIGHLAND FORGE 007171197
// was refused on TAYLOR on 09/02, re-opened by customer service as ATT007171197, and rendered
// as refused (window) or not at all (Map) because a finished frozen copy outranked the pull's
// open row. And every refiled late delivery left an OPEN twin behind on the day it had been
// planned from (125 such ghosts across four days), because the carry-forward files the finish
// onto today's board and heals nothing.
//
// THE RULES, applied on today's pass of every planned scan (zero extra NuVizz calls — the two
// pulls already carry every row this module reads):
//   FINISHED stray — a finished row whose arrival day is a frozen past day inside the search's
//     reach. Every OPEN copy of it on any frozen day from its arrival day to yesterday is HEALED
//     in place (field-masked: status/plan fields only, never a day, never a pin). It is FILED onto
//     today's board, pinned to today, unless a copy on one of those days already records it
//     finished (a POD re-touch of a delivery properly recorded where it ran is history, not
//     today's work) or the carry-forward already has it on today's board.
//   OPEN stray — an open row (unplanned, or planned) whose bucket is a frozen past day. Every
//     frozen copy that disagrees about the plan is healed ('plan'); a frozen TERMINAL copy of a
//     stop the pull now reports OPEN is healed too ('reopen' — the ATT re-attempt). If no frozen
//     day holds an OPEN copy of it at all, it is filed onto today's board as a carry-over, so the
//     Map can show it and enrichment gives it a pin; a stop with an open frozen copy is already
//     served by the carry-over fold and the pool and is left where it is.
//   A copy stamped by a confirmed Save inside the write grace is never patched over. Copies the
//   caller could not read this scan are left for the next one, never guessed at.
//
// PURE: the caller reads the copies (bounded, memoised, rotated) and applies the patches.

import { isTerminalStatus } from './nuvizz-list.mts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (x: any) => String(x ?? '').trim();
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export interface StrayRow { nbr: string; ownDay: string; row: any }

/** PURE: finished rows in buckets for days before today that this scan will not write. */
export function strayFinishedRows(
  buckets: Map<string, any[]> | Iterable<[string, any[]]>,
  opts: { today: string; targets: Set<string> | string[]; floor?: string | null },
): StrayRow[] {
  const targets = opts.targets instanceof Set ? opts.targets : new Set(opts.targets || []);
  const out: StrayRow[] = [];
  const seen = new Set<string>();
  for (const [day, rows] of buckets as Iterable<[string, any[]]>) {
    if (!DAY_RE.test(String(day)) || day >= opts.today || targets.has(day)) continue;
    if (opts.floor && day < opts.floor) continue;
    for (const row of rows || []) {
      const nbr = norm(row?.stopNbr);
      if (!nbr || seen.has(nbr) || !isTerminalStatus(row?.normalizedStatus)) continue;
      seen.add(nbr);
      out.push({ nbr, ownDay: String(day), row });
    }
  }
  return out;
}

/** PURE: OPEN rows in buckets for days before today that this scan will not write. With
 *  `sinceNaive` (an ET-naive 'YYYY-MM-DDTHH:mm' string) only rows NuVizz updated at or after it
 *  are returned — the list's Stop Updated Dttm is ET-naive too, so the comparison is string
 *  against string in one clock, never a naive stamp parsed as UTC. */
export function openPastRows(
  buckets: Map<string, any[]> | Iterable<[string, any[]]>,
  opts: { today: string; targets: Set<string> | string[]; floor?: string | null; sinceNaive?: string | null },
): StrayRow[] {
  const targets = opts.targets instanceof Set ? opts.targets : new Set(opts.targets || []);
  const out: StrayRow[] = [];
  const seen = new Set<string>();
  for (const [day, rows] of buckets as Iterable<[string, any[]]>) {
    if (!DAY_RE.test(String(day)) || day >= opts.today || targets.has(day)) continue;
    if (opts.floor && day < opts.floor) continue;
    for (const row of rows || []) {
      const nbr = norm(row?.stopNbr);
      if (!nbr || seen.has(nbr) || isTerminalStatus(row?.normalizedStatus)) continue;
      if (opts.sinceNaive) {
        const upd = String(row?.listUpdatedDTTM || '');
        if (!upd || upd.slice(0, 16) < opts.sinceNaive.slice(0, 16)) continue;
      }
      seen.add(nbr);
      out.push({ nbr, ownDay: String(day), row });
    }
  }
  return out;
}

/** PURE: the frozen days that can hold a copy of a stray — its own day through yesterday, no
 *  older than the reach — NEWEST FIRST, because a routed stop is clamped forward each day it
 *  stays open and its last open copy sits on the day before it finished. */
export function frozenCopyDays(ownDay: string, today: string, reachDays: number): string[] {
  if (!DAY_RE.test(ownDay) || !DAY_RE.test(today) || ownDay >= today) return [];
  const floor = addDays(today, -Math.max(1, reachDays));
  const start = ownDay > floor ? ownDay : floor;
  const out: string[] = [];
  for (let d = addDays(today, -1); d >= start; d = addDays(d, -1)) out.push(d);
  return out;
}

/** Fields a heal may touch. Live status + plan + the attempt marker + the stamps; never a day,
 *  never a pin, never `isTerminal` (which in this schema means "delivers to our own terminal"). */
export const HEAL_FIELDS = [
  'status', 'normalizedStatus', 'isPlanned', 'isUnplanned',
  'loadNbr', 'routeName', 'routeSeq', 'driverName', 'driverUserName', 'driverId',
  'listUpdatedDTTM', 'deliveredDTTM', 'shipmentNbr', 'isAttempt',
] as const;

export type HealReason = 'finished' | 'plan' | 'reopen';

/** PURE: the masked patch that makes a frozen copy tell the truth about `row`. */
export function healFields(row: any, opts: { today: string; at: string; reason: HealReason }): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of HEAL_FIELDS) {
    if (opts.reason !== 'finished' && k === 'deliveredDTTM') continue;
    const v = row?.[k];
    if (v === undefined) continue;
    out[k] = v === '' ? null : v;
  }
  out.frozen_heal_at = opts.at;
  out.frozen_heal_reason = opts.reason;
  if (opts.reason === 'finished') out.closedOnBoard = opts.today;
  return out;
}

const WRITE_GRACE_MS = 60 * 60 * 1000;
function insideWriteGrace(copy: any, nowMs: number): boolean {
  const t = Date.parse(String(copy?.board_write_at || ''));
  return Number.isFinite(t) && nowMs - t < WRITE_GRACE_MS;
}
export const copyIsTerminal = (copy: any) => isTerminalStatus(copy?.normalizedStatus) || ['90', '91', '80', '99'].includes(norm(copy?.status));

export interface FrozenCopy { day: string; copy: any | null }
export interface Heal { day: string; nbr: string; fields: Record<string, any> }
export interface RefilePlan { file: any[]; heal: Heal[]; skippedTerminal: number; skippedOnBoard: number; unread: number; healedStops: string[] }

/**
 * PURE: for each finished stray decide what to file and what to heal. `copies` holds, per
 * stop, every frozen day the caller read (null = that day has no copy); a stop absent from
 * `copies` was not read this scan and is left alone.
 */
export function planRefile(
  strays: StrayRow[],
  opts: { today: string; at: string; onBoard: Set<string>; copies: Map<string, FrozenCopy[]>; nowMs?: number },
): RefilePlan {
  const now = opts.nowMs ?? Date.now();
  const plan: RefilePlan = { file: [], heal: [], skippedTerminal: 0, skippedOnBoard: 0, unread: 0, healedStops: [] };
  for (const s of strays) {
    if (!opts.copies.has(s.nbr)) { plan.unread++; continue; }
    const days = opts.copies.get(s.nbr) || [];
    const terminalRecorded = days.some((c) => c.copy && copyIsTerminal(c.copy));
    let healed = false;
    for (const c of days) {
      if (!c.copy || copyIsTerminal(c.copy) || insideWriteGrace(c.copy, now)) continue;
      plan.heal.push({ day: c.day, nbr: s.nbr, fields: healFields(s.row, { today: opts.today, at: opts.at, reason: 'finished' }) });
      healed = true;
    }
    if (healed) plan.healedStops.push(s.nbr);
    if (terminalRecorded) { plan.skippedTerminal++; continue; }       // recorded where it ran; a re-touch, not today's work
    if (opts.onBoard.has(s.nbr)) { plan.skippedOnBoard++; continue; }  // the carry-forward already filed it here
    plan.file.push({ ...s.row, boardDate: opts.today, scheduledDate: opts.today, refiledFrom: s.ownDay });
  }
  return plan;
}

export interface OpenPlan { file: any[]; heal: Heal[]; reopened: number; unread: number; checkedStops: string[] }

/**
 * PURE: for each OPEN stray decide what to heal and whether it needs a board at all.
 *   · a frozen copy that disagrees about the plan → 'plan' heal (PRIMARY LOGISTICS);
 *   · a frozen TERMINAL copy of a stop the pull reports open → 'reopen' heal (007171197);
 *   · no open copy on any frozen day → FILE onto today's board as a carry-over so the Map
 *     can show it and it gets enriched (007171664-1, or the re-opened attempt above).
 */
export function planOpenStrays(
  rows: StrayRow[],
  opts: { today: string; at: string; onBoard: Set<string>; copies: Map<string, FrozenCopy[]>; nowMs?: number },
): OpenPlan {
  const now = opts.nowMs ?? Date.now();
  const plan: OpenPlan = { file: [], heal: [], reopened: 0, unread: 0, checkedStops: [] };
  for (const s of rows) {
    if (!opts.copies.has(s.nbr)) { plan.unread++; continue; }
    plan.checkedStops.push(s.nbr);
    const days = opts.copies.get(s.nbr) || [];
    const livePlanned = s.row?.isPlanned === true;
    let hasOpenCopy = false;
    let reopened = false;
    for (const c of days) {
      if (!c.copy || insideWriteGrace(c.copy, now)) continue;
      if (copyIsTerminal(c.copy)) {
        plan.heal.push({ day: c.day, nbr: s.nbr, fields: healFields(s.row, { today: opts.today, at: opts.at, reason: 'reopen' }) });
        reopened = true;
        continue;
      }
      hasOpenCopy = true;
      const differs = (c.copy.isPlanned === true) !== livePlanned
        || norm(c.copy.routeName) !== norm(s.row?.routeName)
        || norm(c.copy.status) !== norm(s.row?.status);
      if (differs) plan.heal.push({ day: c.day, nbr: s.nbr, fields: healFields(s.row, { today: opts.today, at: opts.at, reason: 'plan' }) });
    }
    if (reopened) plan.reopened++;
    if (!hasOpenCopy && !opts.onBoard.has(s.nbr)) {
      plan.file.push({ ...s.row, boardDate: opts.today, scheduledDate: opts.today, refiledFrom: s.ownDay, refiledOpen: true, carryover: true });
    }
  }
  return plan;
}

/** PURE: deterministic rotation of a candidate list so a capped read budget reaches its tail
 *  across successive scans instead of re-reading the same head every time (the demote-verify
 *  starvation, seen again here). `seed` is any per-scan number (minute of day works). */
export function rotate<T>(list: T[], seed: number): T[] {
  if (list.length < 2) return list.slice();
  const k = Math.abs(Math.floor(seed)) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}
