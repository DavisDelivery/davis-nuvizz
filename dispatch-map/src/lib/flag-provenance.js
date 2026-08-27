// src/lib/flag-provenance.js — HOW LONG HAS THIS FLAG BEEN UP? (PURE)
//
// Chad, at 1:23pm on a critical card: "What time did Ben's flag first time show up? ... Ben's
// flag should have been there from first thing this morning as it was on his second load so
// should have flagged early."
//
// He was right, and the board could not tell him. The flag on PRIMERICA LIFE INSURANCE was
// first recorded at 4:01am — TEN HOURS of warning — and by the time he saw it the card looked
// exactly like one that had appeared a minute ago. Two things hid it:
//
//   1. NO TIME ON THE CARD. Every flag reads as new, so a ten-hour-old warning nobody acted on
//      is indistinguishable from one that just fired. That is the difference between "we are
//      on it" and "this has been sitting here since before the drivers left".
//   2. THE ROUTE HAD CHANGED. It first appeared on JIM 1 and was on BEN 2 by lunchtime, so
//      looking for it on Ben's board that morning would have found nothing. The card shows
//      only where the stop is NOW, which makes a moved stop look like a new problem.
//
// The sweep has recorded all of this since the history shipped — firstSeenAt, firstRoute,
// firstTier — and the browser already fetches that document every five minutes for the tier
// floor. It was throwing everything except the tier away.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
// It never invents a time. A flag the sweep has not recorded yet — one that appeared in the
// last few minutes, or a board the sweep does not cover — gets NO stamp rather than "just
// now", because "just now" is a claim, and the whole point of this file is that the card
// stopped making claims it could not support.

const ET = 'America/New_York';

/** "4:01am" in Eastern, from an ISO stamp. Null for anything unparseable. */
export function etClock(iso, timeZone = ET) {
  const t = iso ? Date.parse(String(iso)) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(t)).replace(/\s?([AP])M$/i, (_m, p) => p.toLowerCase() + 'm');
}

/** "10h ago" / "35m ago". Null when the stamp is unusable or in the future by more than a minute. */
export function ageLabel(iso, nowMs) {
  const t = iso ? Date.parse(String(iso)) : NaN;
  if (!Number.isFinite(t)) return null;
  const mins = Math.round(((Number(nowMs) || 0) - t) / 60000);
  if (mins < -1) return null;               // a clock skew is not a duration
  if (mins <= 0) return 'just recorded';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

/**
 * flagProvenance(row, { currentRoute, nowMs }) → what to print under a flag, or null.
 *
 * `row` is the history row the sweep wrote (stopNbr, firstSeenAt, firstRoute, firstTier,
 * worstTier, sweeps). Absent row → null → the card prints nothing extra, which is the honest
 * state for a flag nothing has recorded yet.
 */
export function flagProvenance(row, { currentRoute = null, nowMs = 0 } = {}) {
  if (!row || typeof row !== 'object') return null;
  const since = etClock(row.firstSeenAt);
  if (!since) return null;                  // no usable stamp is no stamp, not a guess

  const first = String(row.firstRoute ?? '').trim();
  const now = String(currentRoute ?? '').trim();
  // Only a REAL change is worth printing. Missing either side means we cannot tell, and
  // "moved from (blank)" is worse than silence.
  const movedFrom = first && now && first.toUpperCase() !== now.toUpperCase() ? first : null;

  const firstTier = String(row.firstTier ?? '').trim().toLowerCase();
  const worstTier = String(row.worstTier ?? '').trim().toLowerCase();
  const RANK = { amber: 1, red: 2, critical: 3 };
  const escalatedFrom = firstTier && worstTier && (RANK[worstTier] || 0) > (RANK[firstTier] || 0)
    ? firstTier : null;

  return {
    since,
    ago: ageLabel(row.firstSeenAt, nowMs),
    movedFrom,
    escalatedFrom,
    sweeps: Number(row.sweeps) || 0,
  };
}

/**
 * One line for the card. Leads with the TIME, because that is the question asked — a flag that
 * has been up since four in the morning is a different object from one that fired at lunch,
 * and until now they printed identically.
 */
export function provenanceLine(p) {
  if (!p) return null;
  const bits = [`flagged ${p.since}`];
  if (p.ago) bits.push(p.ago);
  if (p.escalatedFrom) bits.push(`was ${p.escalatedFrom}`);
  if (p.movedFrom) bits.push(`moved from ${p.movedFrom}`);
  return bits.join(' · ');
}
