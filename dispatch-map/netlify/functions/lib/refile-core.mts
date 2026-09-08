// lib/refile-core.mts — a finished stop from a FROZEN day is filed where it ran, and the
// frozen copy stops claiming it is open.
//
// WHAT WAS MEASURED (Sep 7, the 525-vs-550 reconciliation). On the night of 09/01, Zach
// planned RA52300615 and 007170166-1 onto BEN 1 in the same minute (03:04). Both dispatched
// at 05:05 and delivered mid-morning on 09/02. RA52300615 is on the 09/02 board as delivered;
// 007170166-1 is on no board at all, and its 09/01 copy still reads "unplanned" — one of 30
// such orders in that window. Every one of the 44 late deliveries that DID land on 09/02 got
// there through the carry-forward, which files a finished row only when the day's board
// already held a copy of the stop. A stop the pull never surfaced as planned before it
// delivered has no copy, so its delivered row — arrival day 09/01, a day the scan no longer
// writes — was bucketed to 09/01 and dropped on the floor. Why the active pull missed those
// stops as planned is not established (no scan logs survive from that morning); what IS
// established is the code path that loses them once it has, and that is what this fixes.
//
// THE RULE. A finished row (delivered / refused / cancelled) that this scan's pull reports
// with an arrival day that is (a) before today, (b) not one of the days this scan writes and
// (c) inside the active search's reach is a "stray". A stray whose stop is not already on
// today's board is FILED onto today's board, pinned to today — exactly what the carry-forward
// does for a stop that had a prior copy — unless its own day's frozen copy already records it
// finished (an old delivery re-touched today by a POD upload is history, not today's work).
// Where the frozen copy exists and still reads open, it is HEALED with a field-masked patch of
// the live status and plan fields, so no reader of that day — the carry-over fold, the history
// seal, the date window — sees a phantom open order again.
//
// The same heal covers the other direction Chad hit: PRIMARY LOGISTICS, un-planned in NuVizz
// on Friday afternoon after the 09/02 snapshot froze, still read "planned on MARCUS 2" there.
// An OPEN row on a frozen day whose plan the pull now reports differently gets the same masked
// patch of its plan fields — bounded to rows NuVizz updated recently, so this costs a handful
// of reads per scan, not a re-read of a week of boards.
//
// NEVER: no day field is ever patched (boardDate / scheduledDate belong to the doc's day), a
// copy carrying a confirmed-Save stamp inside the write grace is left alone, and nothing is
// deleted. PURE: the caller reads the frozen copies and applies the patches.

import { isTerminalStatus } from './nuvizz-list.mts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (x: any) => String(x ?? '').trim();

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

/** PURE: OPEN rows in buckets for days before today that this scan will not write, limited to
 *  stops NuVizz updated at or after `sinceMs` — the ones whose frozen copy may have gone stale. */
export function openPastRows(
  buckets: Map<string, any[]> | Iterable<[string, any[]]>,
  opts: { today: string; targets: Set<string> | string[]; floor?: string | null; sinceMs: number },
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
      const upd = Date.parse(String(row?.listUpdatedDTTM || ''));
      if (!Number.isFinite(upd) || upd < opts.sinceMs) continue;
      seen.add(nbr);
      out.push({ nbr, ownDay: String(day), row });
    }
  }
  return out;
}

/** Fields a heal may touch. Live status + plan + the two stamps; never a day, never a pin. */
export const HEAL_FIELDS = [
  'status', 'normalizedStatus', 'isPlanned', 'isUnplanned',
  'loadNbr', 'routeName', 'routeSeq', 'driverName', 'driverUserName', 'driverId',
  'listUpdatedDTTM', 'deliveredDTTM',
] as const;

/** PURE: the masked patch that makes a frozen copy tell the truth about `row`. */
export function healFields(row: any, opts: { today: string; at: string; reason: 'finished' | 'plan' }): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of HEAL_FIELDS) {
    if (opts.reason === 'plan' && (k === 'deliveredDTTM')) continue;
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
const copyIsTerminal = (copy: any) => isTerminalStatus(copy?.normalizedStatus) || ['90', '91', '80', '99'].includes(norm(copy?.status));

export interface Heal { day: string; nbr: string; fields: Record<string, any> }
export interface RefilePlan { file: any[]; heal: Heal[]; skippedTerminal: number; skippedOnBoard: number; unread: number }

/**
 * PURE: decide, for each stray, whether to file it onto today's board and whether to heal its
 * frozen copy. `ownCopies` holds what the caller read for each stop: a document, null when
 * the day has no copy, or absent (undefined) when the read did not happen (over the cap or
 * failed) — an unread stop is left for the next scan rather than guessed at.
 */
export function planRefile(
  strays: StrayRow[],
  opts: { today: string; at: string; onBoard: Set<string>; ownCopies: Map<string, any | null>; nowMs?: number },
): RefilePlan {
  const now = opts.nowMs ?? Date.now();
  const plan: RefilePlan = { file: [], heal: [], skippedTerminal: 0, skippedOnBoard: 0, unread: 0 };
  for (const s of strays) {
    if (opts.onBoard.has(s.nbr)) { plan.skippedOnBoard++; continue; }   // the carry-forward already has it
    if (!opts.ownCopies.has(s.nbr)) { plan.unread++; continue; }
    const copy = opts.ownCopies.get(s.nbr);
    if (copy && copyIsTerminal(copy)) { plan.skippedTerminal++; continue; }   // recorded on its day; a re-touch, not today's work
    plan.file.push({ ...s.row, boardDate: opts.today, scheduledDate: opts.today, refiledFrom: s.ownDay });
    if (copy && !insideWriteGrace(copy, now)) plan.heal.push({ day: s.ownDay, nbr: s.nbr, fields: healFields(s.row, { today: opts.today, at: opts.at, reason: 'finished' }) });
  }
  return plan;
}

/** PURE: heals for open rows on frozen days whose plan the pull now reports differently. */
export function planChangeHeals(
  rows: StrayRow[],
  ownCopies: Map<string, any | null>,
  opts: { at: string; nowMs?: number },
): Heal[] {
  const now = opts.nowMs ?? Date.now();
  const out: Heal[] = [];
  for (const s of rows) {
    if (!ownCopies.has(s.nbr)) continue;
    const copy = ownCopies.get(s.nbr);
    if (!copy || copyIsTerminal(copy) || insideWriteGrace(copy, now)) continue;
    const planned = s.row?.isPlanned === true;
    const differs = (copy.isPlanned === true) !== planned || norm(copy.routeName) !== norm(s.row?.routeName) || norm(copy.status) !== norm(s.row?.status);
    if (!differs) continue;
    out.push({ day: s.ownDay, nbr: s.nbr, fields: healFields(s.row, { today: '', at: opts.at, reason: 'plan' }) });
  }
  return out;
}
