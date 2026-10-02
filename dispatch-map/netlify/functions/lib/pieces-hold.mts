// lib/pieces-hold.mts — THE PIECE-COUNT EDIT'S SWITCH, AND THE HOLD THAT KEEPS ITS BOARD WRITE.
//
// Chad, 2026-10-02: "make it where in dispatch map i can edit an order and change piece counts
// and then send it to nuvizz to change as well".
//
// The edit has two halves (lib/nuvizz-write.mts runSetStopPieces): NuVizz's record, and our
// board. This file holds the two things BOTH halves — and the scan — must agree on, so it is
// imported by the executor and by the scan and pulls in nothing itself.
//
// ── THE SWITCH ───────────────────────────────────────────────────────────────
// NUVIZZ_PIECES_WRITE=off (or 0/false/no) puts every side back at once: the write op refuses
// before any NuVizz call, and the scan stops holding piece stamps (below). House shape —
// default ON, an explicit off-word turns it off, anything malformed leaves it ON (a typo must
// never silently disable a dispatcher's edit; a quiet feature looks exactly like a working one).
//
// ── THE HOLD ─────────────────────────────────────────────────────────────────
// Freight is not a live list field: the scan carries a row's cartons/pallets/volume forward
// from its STORED copy (nuvizz-list.mts mergeEnrich), so the board only learns a new count
// because the write patches the stored row. But the scan snapshots the stored rows MINUTES
// before it writes them back whole (firestore.mts writeStops — vendor pulls, enrichment and
// geocoding sit in between), so a patch landing inside that window was overwritten by the
// snapshot's old count — silently, and for good, because every later scan carries the reverted
// row forward. The plan write-through had the same race and closed it the same way (writeStops
// graceFn → applyBoardWriteGrace): re-apply the CURRENT doc's confirmed write onto the outgoing
// row, read milliseconds before the write instead of minutes.
//
// Only rows carrying a piece stamp from the last BOARD_WRITE_GRACE_MIN minutes are touched —
// every row that never had a piece edit is byte-identical to before. After the hour the hold is
// inert: by then every scan's snapshot already reads the patched row, and the ordinary
// carry-forward keeps it.

/** Same window as the plan write-through's grace (nuvizz-list.mts BOARD_WRITE_GRACE_MIN), so a
 *  confirmed write on the board means the same thing whichever field it carried. Restated rather
 *  than imported to keep this module free of the scan's dependency graph. */
export const PIECE_HOLD_MIN = 60;

/** The board-row fields a confirmed piece write owns (lib/nuvizz-write-ops.mts boardPiecesFields). */
export const PIECE_HOLD_FIELDS = ['cartons', 'pallets', 'volume', 'itemsSummary', 'pieces_set_at', 'pieces_set_by'] as const;

/** Is the piece-count edit on? Read on every call — never cached at module load. */
export function piecesWriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(String(env.NUVIZZ_PIECES_WRITE ?? '').trim());
}

const idShaped = (v: any): boolean => {
  const s = String(v ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  return /^[0-9a-f]{16,}$/i.test(s) || (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s));
};

/**
 * PURE (given `enabled`): carry a recent confirmed piece write from the stored row onto the row
 * the scan is about to write. Mutates `fresh` in place, like applyBoardWriteGrace, and returns
 * whether it changed anything.
 *
 * Holds only when ALL of these are true:
 *   • the switch is on;
 *   • the stored row carries `pieces_set_at`, at most PIECE_HOLD_MIN minutes old (and not more
 *     than five minutes in the future — a clock that far off is not evidence of anything);
 *   • the two rows are the same NuVizz record: when both carry an id-shaped stopId they must
 *     match, so a stamp on one order is never painted onto another sharing its number.
 */
export function applyPieceWriteHold(fresh: any, existing: any, nowMs: number, enabled: boolean = piecesWriteEnabled()): boolean {
  if (!enabled || !fresh || !existing) return false;
  const at = Date.parse(String(existing.pieces_set_at ?? ''));
  if (!Number.isFinite(at)) return false;
  if (nowMs - at > PIECE_HOLD_MIN * 60000 || at - nowMs > 5 * 60000) return false;
  const a = String(fresh.stopId ?? '').trim();
  const b = String(existing.stopId ?? '').trim();
  if (idShaped(a) && idShaped(b) && a !== b) return false;
  let changed = false;
  for (const k of PIECE_HOLD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(existing, k)) continue;
    if (JSON.stringify(fresh[k] ?? null) === JSON.stringify(existing[k] ?? null)) continue;
    fresh[k] = existing[k];
    changed = true;
  }
  return changed;
}
