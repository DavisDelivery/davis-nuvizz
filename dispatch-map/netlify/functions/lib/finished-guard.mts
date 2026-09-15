// lib/finished-guard.mts — FINISHED FREIGHT NEVER TAKES A PLAN STAMP. (pure)
//
// Chad, 2026-09-11 06:27 ET, order 007174583 (TAJ MA HOUND) grey on his board while NuVizz's own
// Stop screen read Completed: "why is this showing unplanned on my board when scan is showing it
// completed?" Read back from the board's own documents — zero NuVizz calls:
//
//   09:59:18Z  commitBoard REFUSED the add. NuVizz held the stop on a SECOND load also named AB
//              (yesterday's instance, DAVIS000203402; the Save was to today's, DAVIS000203506).
//              The stop had delivered on it at 04:37 ET. The refusal read the stop record — status
//              and all — and threw that knowledge away.
//   09:59:32Z  the dispatcher struck it off the card; the un-plan write-through stamped the board
//              row status 10 / UNPLANNED, route null, driver null, board_write_planned false — and
//              the scan's write grace then DEFENDED that stamp for sixty minutes over anything the
//              list said.
//
// Every other door in this system already refuses to call finished freight "still to plan":
// toBoardStop (isUnplanned: !planned && !isTerminalStatus), the completions overlay ("a finished
// stop is not still to plan"), the carry-over fold, the retirement pass. The write-through and the
// write grace were the two doors without the rule. This module IS the rule, stated once, so the
// three places that need it cannot drift from each other:
//   • patchBoardPlan (firestore.mts): a finished board row is skipped by BOTH masks — the
//     un-planned one (the incident) and the planned one (re-saving a load that has delivered stops
//     on it must not flip them back to SCHEDULED). Skips are counted and reported, never silent.
//   • applyBoardWriteGrace (nuvizz-list.mts): a FRESH terminal list row is the truth; no stamp of
//     ours outranks a delivery NuVizz has recorded.
//   • the RWB refusal path (nuvizz-write.mts): when NuVizz refuses an add because another load
//     holds the stop, and the record it just read is terminal, that status is written to the board
//     row right then — so the strike-off fourteen seconds later meets a row that already knows.
//
// The operational point, for a dispatcher: "unplanned" on the board is an instruction — go put it
// on a truck. For freight already off the truck, that instruction is how the same order gets
// routed twice.
//
// BOARD_WRITE_FINISHED_GUARD=off puts every side back at once. House shape: default ON, only an
// explicit off-word turns it off, and anything malformed leaves it ON — a typo in an env var must
// never silently disable a rule, because a quiet rule looks exactly like a working one.

const TERMINAL_NORMALIZED = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);
/** The NuVizz stop-status codes the Completed saved search bundles as finished — 90/91 delivered,
 *  80 unable to deliver, 99 cancelled. The same set scan-completions and stop-explain read. */
const TERMINAL_CODES = new Set(['90', '91', '80', '99']);

export function finishedGuardEnabled(env: any = process.env): boolean {
  const v = String(env?.BOARD_WRITE_FINISHED_GUARD ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * PURE: is this board row, as stored, already a finished outcome? Reads BOTH the normalized status
 * and the raw code, so a row whose normalizedStatus an older write blanked but whose code still
 * says 90 is still recognised as done. Nothing, null and an empty row are not finished.
 */
export function isFinishedBoardRow(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  const norm = String(row.normalizedStatus ?? '').trim().toUpperCase();
  if (TERMINAL_NORMALIZED.has(norm)) return true;
  return TERMINAL_CODES.has(String(row.status ?? '').trim());
}
