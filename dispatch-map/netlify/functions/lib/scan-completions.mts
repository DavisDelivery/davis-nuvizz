// lib/scan-completions.mts
//
// THE COMPLETED-ONLY PULL — "tell me what finished since last time", and nothing else.
//
// Decoupling the two saved searches means some fires want 77131 (completed) WITHOUT 77128
// (planned/unplanned) — through the delivery day, when every delivery stamp re-anchors a
// route clock and the plan itself is barely moving.
//
// The dangerous way to build that is to route a completed-only pull through the normal board
// rebuild. That path reads absence as meaning: a planned stop missing from the pull becomes an
// absent-plan demote candidate, and a completed-only pull is missing EVERY planned stop by
// definition. The existing thin-pull ratio guard would probably catch it — `pullHealthy` goes
// false when the pull is much smaller than the stored board — but "probably, via a heuristic
// meant for a different failure" is not a guarantee, and what it would be guarding against is
// tearing live stops off routes mid-morning.
//
// So this is a separate, deliberately tiny operation instead. It is an OVERLAY:
//   * it only ever touches stops that ALREADY EXIST on the day's board,
//   * it only ever writes the four fields that say a stop finished,
//   * it never creates a stop, never removes one, and never touches a plan field —
//     not the route, not the sequence, not the driver, not isPlanned.
// A stop it has never heard of is counted and reported, not invented.
//
// That makes "what does a completed-only scan do to the board" answerable in one sentence,
// which is the property that matters when this runs unattended every 15 minutes.

/** The only fields a completions overlay is allowed to write. */
export const COMPLETION_FIELDS = ['status', 'normalizedStatus', 'deliveredDTTM', 'listUpdatedDTTM', 'isUnplanned', 'boardDate', 'scheduledDate'] as const;

export interface CompletionPatch {
  status?: string | null;
  normalizedStatus?: string | null;
  deliveredDTTM?: string | null;
  listUpdatedDTTM?: string | null;
  /** cleared when the row finishes — a cancelled unplanned order must leave the unplanned count */
  isUnplanned?: boolean;
  /** pinned to the served day when the finish lands on a rolled-over copy (see completionPatch) */
  boardDate?: string;
  scheduledDate?: string;
}

const TERMINAL = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);

/**
 * PURE. What (if anything) this completed row changes on the stop we already hold.
 * Returns null when there is nothing to write — so an unchanged stop costs no Firestore write,
 * which is what keeps a 15-minute cadence cheap on a day with 800 stops and 40 completions.
 *
 * deliveredDTTM is WRITE-ONCE. The list reports NuVizz's own "Stop Updated Dttm", and that
 * field keeps moving after delivery (a POD upload, a note, a status correction). Freezing it
 * at the first sighting is what makes it the DELIVERY time rather than the last-touched time —
 * the same rule the full scan path applies by keeping it out of LIVE_LIST_FIELDS. Overwriting
 * it here would let a 4pm paperwork edit rewrite a 9:12a delivery, and every ETA anchored on
 * that stop would move with it.
 */
export function completionPatch(existing: any, row: any, opts: { today?: string | null } = {}): CompletionPatch | null {
  if (!existing || !row) return null;
  const out: CompletionPatch = {};
  const status = row.status ?? null;
  const norm = row.normalizedStatus ?? null;
  if (status != null && String(status) !== String(existing.status ?? '')) out.status = status;
  if (norm != null && String(norm) !== String(existing.normalizedStatus ?? '')) out.normalizedStatus = norm;
  if (row.deliveredDTTM && !existing.deliveredDTTM) out.deliveredDTTM = row.deliveredDTTM;
  if (row.listUpdatedDTTM && row.listUpdatedDTTM !== existing.listUpdatedDTTM) out.listUpdatedDTTM = row.listUpdatedDTTM;
  if (TERMINAL.has(String(norm ?? '').toUpperCase())) {
    // A finished stop is not "still to plan" (toBoardStop derives the same; the overlay used to
    // leave isUnplanned=true on a cancellation, so the Map kept counting it for a scan interval).
    if (existing.isUnplanned !== false) out.isUnplanned = false;
    // THE DAY PIN (v0.95.0). A rolled-over stop is clamped onto today's board with its boardDate
    // still at the old arrival day. When THIS overlay finishes it, the board read's own-day filter
    // stripped the delivery at once and the next full scan's day guard pruned the row: the
    // delivery was on no board until the frozen-day pass found it. Pin the finish to the day it
    // is being recorded on, exactly as the carry-forward and the frozen-day pass do.
    const today = opts.today || null;
    if (today && /^\d{4}-\d{2}-\d{2}$/.test(today) && existing.boardDate && String(existing.boardDate) < today) {
      out.boardDate = today;
      if (String(existing.scheduledDate ?? '') !== today) out.scheduledDate = today;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * PURE. Plan the whole overlay against the board we hold: which stops change, which are
 * unchanged, and which the pull mentions that we have never seen.
 *
 * `unknown` is REPORTED rather than written. A completed row for a stop not on this day's
 * board is usually just a different day's freight caught by the ±7d window — but it can also
 * be the first sign that the board and the feed have drifted, and a number nobody can see is
 * how that stays invisible for a week. The next full scan is what legitimately adds it.
 */
export function planCompletions(boardByNbr: Map<string, any>, rows: any[], opts: { today?: string | null } = {}): {
  patches: Array<{ stopNbr: string; fields: CompletionPatch }>;
  unchanged: number;
  unknown: string[];
  /** rows whose stop id is a DIFFERENT record than the board's under the same number — never patched */
  twins: string[];
} {
  const patches: Array<{ stopNbr: string; fields: CompletionPatch }> = [];
  const unknown: string[] = [];
  const twins: string[] = [];
  let unchanged = 0;
  for (const row of rows || []) {
    const nbr = String(row?.stopNbr ?? '');
    if (!nbr) continue;
    const existing = boardByNbr.get(nbr);
    if (!existing) { unknown.push(nbr); continue; }
    // TWO RECORDS, ONE NUMBER (the Estes-0828068215 lesson, now applied here too): a finished twin
    // re-touched today must not mark the LIVE order under the same number delivered.
    const exId = String(existing.stopId ?? '').trim(), rowId = String(row.stopId ?? '').trim();
    if (exId && rowId && exId !== rowId) { twins.push(nbr); continue; }
    const fields = completionPatch(existing, row, opts);
    if (fields) patches.push({ stopNbr: nbr, fields });
    else unchanged += 1;
  }
  return { patches, unchanged, unknown, twins };
}
