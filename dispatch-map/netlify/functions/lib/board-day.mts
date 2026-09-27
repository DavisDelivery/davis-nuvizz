// lib/board-day.mts — THE BOARD'S READ-TIME DAY FILTER, PURE (v1.76.0).
//
// Moved out of nuvizz-list.mts unchanged: the Map's read (nuvizz-pull-today-stops.mts) and the Claude
// shadow's planning area apply the same filter to a day's rows, and the shadow may not import a module
// that reaches NuVizz. No imports.

// PURE: a stop's OWN board day with NO live-route clamp — Estimated Arrival, then Requested,
// then scheduled. Used to detect a prior-day FINISHED stop that doesn't belong on a board.
export function ownBoardDay(s: any): string | null {
  return s.boardDate || s.requestedDate || s.scheduledDate || null;
}

// PURE: the READ-time safety net. Drop FINISHED (delivered / exception) stops whose own day is
// BEFORE the board date being served — the same rule keepForBoardDate enforces at WRITE time,
// applied again on read so a mis-keyed prior-day bleed (e.g. the ET/UTC drift that filed Friday's
// deliveries onto Saturday's doc) is never SHOWN, even if it already slipped into storage and the
// day is in a scan-blackout that can't re-prune it. Open / undated / same-or-later-day stops are
// kept untouched, so live work and normal same-day boards are unaffected. Exported for tests.
export function filterFinishedPriorDay(stops: any[], date: string): any[] {
  return stops.filter((s) => {
    const finished = s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION';
    const own = ownBoardDay(s);
    return !(finished && own && own < date);
  });
}
