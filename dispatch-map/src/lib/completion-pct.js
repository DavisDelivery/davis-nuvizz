// completion-pct.js — a percentage that cannot lie about a finished day.
//
// Chad reads "N open, X% complete" on a phone at the end of a day, and the two halves of
// that sentence have to agree. Plain rounding broke it on the size of board this operation
// actually runs: 815 of 816 delivered is 99.88%, which rounds to "100% complete" — printed
// beside "1 open", in the same subject line. On a 1,631-stop two-day view four open stops
// still read as a perfect day.
//
// A rate is a summary; "100%" is a CLAIM THAT NOTHING IS LEFT, and it is the one number
// somebody stops reading after. So 100% is reserved for actually finished, and 0% for
// actually nothing — every partial value is pulled back to the nearest number that is still
// honest. The 1-in-816 case is not a corner: it is a good day, and a good day quietly
// reporting itself as a perfect one is how the last stop gets forgotten.
export function completionPct(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1) return 100;
  if (v <= 0) return 0;
  const r = Math.round(v * 100);
  if (r >= 100) return 99;   // short of done — say so
  if (r <= 0) return 1;      // something happened — say so
  return r;
}

/** The rendered string, or an em dash when there is no rate to show. */
export function formatCompletionPct(v) {
  const p = completionPct(v);
  return p == null ? '—' : `${p}%`;
}
