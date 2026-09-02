// src/lib/flag-detail.js — ONE FLAG, EXPLAINED. (PURE)
//
// Chad, on the Flag history day table: "I want to be able to click on these rows and get
// details."
//
// THE DETAILS WERE ALREADY IN THE BROWSER. The stored flag row carries eighteen fields the
// table never draws — what we PREDICTED at the first sighting and at the last, the worst that
// projection ever looked, how many sweeps saw it, whether the clock rested on a real arrival
// stamp or on an assumed depot departure, and where the receiving close came from. The table
// shows the verdict; this module reconstructs the case behind it.
//
// ── WHAT A DISPATCHER IS ACTUALLY ASKING ─────────────────────────────────────
//
// Measured on the 206 rows on file (11 graded days), the question is almost never "what
// happened" — the Outcome column already says. It is "was that flag worth acting on?", and
// the answer is arithmetic nothing on the screen performs:
//
//   WALKER SCHOOL (TEBARCO), 2026-09-02. Flagged 1:00a, CRITICAL, with an ETA of 2:30p
//   against a 10:00a close — four and a half hours past. It delivered at 8:18a, an hour and
//   forty-two minutes INSIDE the window. The projection was out by more than six hours.
//
// That is the row a dispatcher emailed customer service about. Whether to do that again is
// the decision this panel exists to inform, and it cannot be made from a green "Made it" pill.
//
// ── THE THREE THINGS IT REFUSES TO DO ────────────────────────────────────────
//
// 1. NEVER CLAIM THE FLAG CAUSED THE OUTCOME. The screen's own honesty note says these numbers
//    "show what happened AFTER a flag, not that the flag caused it". A moved route is evidence
//    a person acted; it is not proof the move saved the stop, and nothing here says it was.
//
// 2. NEVER RENDER A PROJECTION AS A WALL-CLOCK TIME. `closeMin + worstLateBy` runs past
//    midnight on 5 of the 206 rows on file, and a bare "4:40a" for freight projected onto the
//    small hours of the NEXT day is wrong by a day. Projections are always a DURATION past the
//    close. Observed times — the close, the delivery, the sightings — are real clock readings
//    and stay clock readings.
//
// 3. NEVER INVENT A DELIVERY OR A DAY. deliveredWhen already owns "which day did it actually
//    deliver", including a roll that has not delivered yet ("still open"); this module calls it
//    rather than re-deriving it, and computes a margin ONLY against a same-day delivery — the
//    distance between a close and a stamp from another day is not a number, it is a mistake.
//
// PURE: no clock, no fetch. `boardDate` and the day's grading state are parameters.

import { deliveredWhen } from './delivered-when.js';

/** The house close used when a customer has no recorded receiving hours: 5:00pm ET.
 *  Mirrors ASSUMED_CLOSE_MIN in board-flags.js — the value a dispatcher sees on 110 of the
 *  206 flags on file, and the reason so many rows in one day share an identical close. */
export const ASSUMED_CLOSE_MIN = 17 * 60;

// Number(null) is 0 and 0 is finite — the trap CLAUDE.md names, and it bit this file's own
// duration formatter first: durText(null) returned "on the close" instead of nothing.
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Only a numeric STRING converts. Number([]) is 0, Number(null) is 0, Number(true) is 1 —
  // every one of them finite, and every one of them a value nobody measured.
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isMin = (v) => num(v) != null;

/** A duration in dispatcher words. 0 is "on the close", not "0m". */
export function durText(min) {
  const v = num(min);
  if (v == null) return null;
  const a = Math.abs(Math.round(v));
  if (a === 0) return 'on the close';
  const h = Math.floor(a / 60); const m = a % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A SIGHTING TIME THAT KNOWS WHICH DAY IT IS ON.
 *
 * firstSeenMin is minutes past midnight of the BOARD day, and the evening sweep records
 * tomorrow's board against tonight's clock as `etMin - 1440` — so a flag first seen at 11pm
 * the night before is stored as -60. fmtMinOfDay(-60) returns "11:00a": a twelve-hour error,
 * in the flattering direction, on the column that says how much warning we had. It is not
 * hypothetical — MCCORMICK ATLANTA PLANT on 2026-08-24 is stored at -60 and the shipped table
 * has been printing 11:00a for it.
 *
 * Returns the minute-of-day to format with the app's own clock (one format, as
 * delivered-when.js insists) plus which day it belongs to, so the view can name it.
 */
export function sighting(min) {
  const v = num(min);
  if (v == null) return null;
  const dayOffset = Math.floor(v / 1440);
  return {
    min: v,
    minOfDay: ((v % 1440) + 1440) % 1440,
    dayOffset,
    suffix: dayOffset === 0 ? null : dayOffset < 0 ? 'the night before' : 'the next day',
  };
}

/**
 * WHERE THE CLOSE CAME FROM — the single most useful thing on the panel, because it explains
 * the tier. severityTier() caps an ASSUMED close at amber however late the truck is: the 5pm
 * default is a house guess for a dock nobody has recorded, and a guess does not get to wake
 * anybody. 110 of 206 flags on file rest on it, which is why seven rows in one screenshot all
 * close at 5:00p.
 */
export function closeSource(row) {
  const tier = row?.hoursTier ?? null;
  if (tier === 'typed') return { key: 'typed', text: 'a dispatcher typed this customer’s receiving hours' };
  if (tier === 'auto') return { key: 'auto', text: 'read automatically from the customer’s note' };
  if (tier === 'assumed') {
    return { key: 'assumed', text: 'our house default — this customer has no recorded receiving hours, so 5:00p is assumed and the flag can never pass amber' };
  }
  return { key: 'unknown', text: 'not recorded on this flag (it predates the field)' };
}

/**
 * WHAT THE CLOCK RESTED ON. anchored=true means the walk started from a real arrival stamp —
 * a truck that has actually been somewhere. false means it started from an assumed depot
 * departure, so the whole projection is a guess about a truck nobody has heard from. Splits
 * 95 true / 111 false across the rows on file, so it genuinely separates flags.
 */
export function anchorNote(row) {
  if (row?.anchored === true) return { anchored: true, text: 'The clock was anchored on a real arrival stamp — the truck had been somewhere we could measure from.' };
  if (row?.anchored === false) return { anchored: false, text: 'No truck movement had been reported yet, so the arrival estimate ran from an assumed departure.' };
  return { anchored: null, text: null };
}

/** How persistent the flag was. A third of the flags on file (68 of 206) were seen in ONE
 *  sweep and never again — worth knowing before treating one as a standing problem. */
export function sweepNote(row) {
  const n = num(row?.sweeps);
  if (n == null || n <= 0) return null;
  if (n === 1) return { n, onceOnly: true, text: 'seen in one sweep and not again' };
  return { n, onceOnly: false, text: `seen in ${n} sweeps` };
}

/**
 * THE PROJECTION, AS DURATIONS PAST THE CLOSE. Each is `eta - close`, so a positive number is
 * freight arriving after the dock shuts. `worstLateBy` is stored; the first and last are
 * derived from the ETAs recorded at those sightings.
 */
export function projection(row) {
  const close = isMin(row?.closeMin) ? Number(row.closeMin) : null;
  const first = isMin(row?.firstEtaMin) ? Number(row.firstEtaMin) : null;
  const last = isMin(row?.lastEtaMin) ? Number(row.lastEtaMin) : null;
  const worst = isMin(row?.worstLateBy) ? Number(row.worstLateBy) : null;
  const lateBy = (eta) => (eta == null || close == null ? null : eta - close);
  const firstLate = lateBy(first); const lastLate = lateBy(last);
  return {
    closeMin: close,
    firstEtaMin: first, lastEtaMin: last,
    firstLateBy: firstLate, lastLateBy: lastLate, worstLateBy: worst,
    firstText: firstLate == null ? null : (firstLate > 0 ? `${durText(firstLate)} past the close` : firstLate === 0 ? 'exactly on the close' : `${durText(firstLate)} inside the close`),
    lastText: lastLate == null ? null : (lastLate > 0 ? `${durText(lastLate)} past the close` : lastLate === 0 ? 'exactly on the close' : `${durText(lastLate)} inside the close`),
    worstText: worst == null ? null : (worst > 0 ? `${durText(worst)} past the close` : 'never past the close'),
    // Did the picture improve or get worse between the first sighting and the last?
    movedBy: firstLate != null && lastLate != null ? lastLate - firstLate : null,
  };
}

/**
 * THE MARGIN — how far inside the receiving window it actually landed, or how far past.
 * ONLY for a delivery on the flag's own board day: a stamp from another day measured against
 * this day's close is arithmetic on two unrelated numbers.
 */
export function margin(row, boardDate) {
  const close = isMin(row?.closeMin) ? Number(row.closeMin) : null;
  const w = deliveredWhen(row, { boardDate });
  if (close == null || !w || w.minutes == null) return null;
  if (w.tone === 'later' || w.tone === 'open') return null;   // delivered on a different day
  const by = close - w.minutes;
  return {
    min: by, sameDay: true,
    inside: by >= 0,
    text: by > 0 ? `${durText(by)} before the close` : by === 0 ? 'right on the close' : `${durText(by)} past the close`,
  };
}

const OUTCOME_TEXT = {
  made: 'Delivered inside the receiving window.',
  missed: 'Delivered after the receiving window had shut.',
  rolled: 'Did not deliver that day — it turned up on a later board.',
  undelivered: 'Never delivered.',
};

/**
 * WHAT HAPPENED. The one place "unknown" has to be handled honestly: on a day still being
 * graded it means the stop has not delivered YET, which is nothing like "we cannot grade
 * this". The table's own pill says "Not gradable" for both, and on the live day that is the
 * wrong sentence — six of thirteen rows in the screenshot Chad sent were in exactly that state
 * at 10:12am.
 */
export function outcomeNote(row, { boardDate = null, dayScored = null } = {}) {
  const key = row?.outcome || 'unknown';
  const w = deliveredWhen(row, { boardDate });
  if (key !== 'unknown') {
    return { key, text: OUTCOME_TEXT[key] || 'Outcome not recorded.', delivered: w };
  }
  if (dayScored === false) {
    return { key, pending: true, text: 'No delivery recorded yet — this day is still being graded.', delivered: w };
  }
  return { key, text: 'No delivery was recorded for this stop, so it could not be graded.', delivered: w };
}

/** A route change after we flagged it is the one recorded sign a person acted. Position was
 *  meant to count too, but firstSeq/lastSeq are null on all 206 rows on file — the sweep has
 *  never written them — so a move is a ROUTE move and the panel does not pretend otherwise. */
export function actionNotes(row) {
  const out = [];
  if (row?.emailed === true) out.push({ key: 'emailed', text: 'An urgent email went to customer service.' });
  const from = String(row?.firstRoute ?? '').trim();
  const to = String(row?.lastRoute ?? '').trim();
  if (from && to && from !== to) out.push({ key: 'moved', text: `Moved from ${from} to ${to} after we flagged it.` });
  else if (row?.actedOn === true) out.push({ key: 'acted', text: 'The stop was changed after we flagged it.' });
  if (!out.length) out.push({ key: 'none', text: 'No email and no route change recorded.', muted: true });
  return out;
}

/**
 * EVERYTHING THE PANEL SHOWS, from one stored row. Returns named parts rather than rendered
 * sections so the phone and the desktop can lay the same facts out differently — which the
 * house rule requires and a single blob of markup would prevent.
 *
 * @param {object} row        a stored FlagRow, exactly as eta-flag-history returns it
 * @param {object} opts
 * @param {string} opts.boardDate   the day the flag belongs to (YYYY-MM-DD)
 * @param {boolean|null} opts.dayScored  whether the overnight join has run for that day
 */
export function flagDetail(row, { boardDate = null, dayScored = null } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const proj = projection(row);
  const m = margin(row, boardDate);
  const out = outcomeNote(row, { boardDate, dayScored });
  const lead = isMin(row.leadMin) ? Number(row.leadMin) : null;
  const first = row.firstTier || null; const worst = row.worstTier || null;
  const cautions = [];
  const src = closeSource(row);
  if (src.key === 'assumed') cautions.push('The close is assumed, so this flag was capped at amber whatever the projection said — recording this customer’s real receiving hours is what would let it escalate.');
  const anchor = anchorNote(row);
  if (anchor.anchored === false) cautions.push('The arrival time was projected from an assumed departure, not measured from a truck.');
  const sw = sweepNote(row);
  if (sw?.onceOnly) cautions.push('One sighting only — by the next sweep it was no longer flagged.');
  if (m && proj.worstLateBy != null && proj.worstLateBy > 0 && m.inside) {
    cautions.push(`It was projected ${proj.worstText} and delivered ${m.text} — the projection was out by ${durText(proj.worstLateBy + m.min)}.`);
  }
  return {
    pro: row.stopNbr ?? null,
    customer: row.customer || row.stopNbr || null,
    boardDate,
    outcome: out,
    margin: m,
    close: { min: proj.closeMin, source: src },
    warning: lead == null ? null : {
      leadMin: lead, tooLate: lead <= 0,
      text: lead > 0 ? `${durText(lead)} of warning before the close`
        : lead === 0 ? 'flagged exactly as the close passed — no warning at all'
          : `flagged ${durText(lead)} after the close had already passed`,
    },
    firstSeen: { ...(sighting(row.firstSeenMin) || { min: null, minOfDay: null, dayOffset: 0, suffix: null }), at: row.firstSeenAt ?? null, tier: first, route: row.firstRoute || null },
    lastSeen: { ...(sighting(row.lastSeenMin) || { min: null, minOfDay: null, dayOffset: 0, suffix: null }), route: row.lastRoute || null },
    projection: proj,
    escalation: first && worst && first !== worst ? { from: first, to: worst, text: `Escalated from ${first} to ${worst}.` } : null,
    anchor,
    sweeps: sw,
    actions: actionNotes(row),
    cautions,
  };
}
