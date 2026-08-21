// WHICH BOARDS COULD HOLD A MANIFEST ORDER, AND WHETHER THOSE BOARDS EXIST YET.
//
// Chad, on a Friday at 12:49, looking at a red banner reading "18 orders on the manifest are
// NOT in the scan": "I don't think that this is accurate… are these orders that have been
// shipped today that are for delivery on Monday?" He was right, and the check was wrong twice
// over — once about WHICH days it looked at, and once about what it may conclude from an
// empty one.
//
// ── ONE: THE WINDOW COUNTED CALENDAR DAYS ────────────────────────────────────
// The diff took the manifest's ship date and allowed the next 2 CALENDAR days, on the
// reasoning that "Uline ships tonight for tomorrow, and a deferred order lands the day after".
// Monday through Thursday that is true. On a FRIDAY it is not: the next two calendar days are
// Saturday and Sunday, we do not deliver on either, and the day the freight actually moves —
// Monday — sits one day outside the window. That run checked 2026-08-21 (758 stops),
// 2026-08-22 (0) and 2026-08-23 (0): two of its three days could not have held an order at
// all, and the one delivery day it was really looking for was never opened.
//
// Counting DELIVERY days instead of calendar days fixes it for every weekday at once, and it
// keeps the ship date itself in the window — so it stays correct whether Uline's date column
// means "we shipped this today" or "deliver this on this date", which is not a question this
// module has to answer.
//
// ── TWO: AN EMPTY BOARD IS NOT EVIDENCE OF ABSENCE ───────────────────────────
// Tomorrow's routes are built in the ROUTING EVENING, out of the imports that arrive through
// the day. So at midday Friday there is no Monday board yet — not a thin one, none. The old
// check could not tell that apart from a fully-scanned day that genuinely lacks the order, and
// reported both as "NOT in the scan". A dispatcher cannot act on the first one: there is
// nothing to chase, the freight simply has not been routed yet.
//
// manifest-check-view.js already says it: "a flag that lies in either direction is worse than
// no flag: a false one trains you to ignore it, a missed one is the order that never shipped."
// The first kind is what this run produced, on the day of the week it will produce it every
// week.

// Saturday and Sunday. Matches the delivery days the scan plan runs on (scan-plan.mts uses
// weekdays 1-5), so the two never disagree about what a working day is.
const WEEKEND = new Set([0, 6]);

/** Day-of-week for an ISO date, read in UTC so a local timezone cannot shift it. */
export function isoWeekday(iso) {
  const d = new Date(`${String(iso)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

export function isDeliveryDay(iso) {
  const wd = isoWeekday(iso);
  return wd == null ? false : !WEEKEND.has(wd);
}

export function shiftIso(iso, n) {
  const d = new Date(`${String(iso)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The days a manifest order could plausibly land on: the base date itself, then the next
 * `span` DELIVERY days after it.
 *
 * The base is always included even when it is a weekend — a Saturday-dated manifest is odd,
 * but if a board exists for it we would rather look than assume. Bounded so a bad `span`
 * cannot walk the calendar forever.
 */
export function deliveryWindow(baseIso, span = 2) {
  const base = String(baseIso || '');
  if (isoWeekday(base) == null) return [];
  const n = Math.min(7, Math.max(0, Math.floor(Number(span)) || 0));
  const out = [base];
  let cur = base;
  // Bounded walk: n delivery days can never be more than n + 2 calendar days away.
  for (let guard = 0; out.length <= n && guard < n + 7; guard++) {
    cur = shiftIso(cur, 1);
    if (!cur) break;
    if (isDeliveryDay(cur)) out.push(cur);
  }
  return out;
}

/**
 * What the boards we checked can actually support.
 *
 * `boardDays` is [{ date, stops }] as the diff built it. A day with no cached stops is a day
 * that was never scanned — for a future date that is the ordinary state until the routing
 * evening runs — and it can neither confirm nor deny anything.
 */
export function boardCoverage(boardDays) {
  const days = Array.isArray(boardDays) ? boardDays.filter((d) => d && typeof d === 'object') : [];
  const withBoard = days.filter((d) => Number(d.stops) > 0);
  const empty = days.filter((d) => !(Number(d.stops) > 0));
  return {
    days: days.length,
    checked: withBoard.map((d) => String(d.date)),
    empty: empty.map((d) => String(d.date)),
    // Did we learn anything about the boards at all? A run that carries no board-day
    // information — an old stored result, a malformed one — is NOT the same as one that
    // looked and found them empty, and the two must not grade alike.
    known: days.length > 0,
    // EVERY day, not any day. This was "at least one real board was opened", and that is too
    // weak by exactly the amount that matters: on Friday the 08-21 board is real and holds 758
    // stops, so one-real-board called the run conclusive — about freight that is for MONDAY,
    // whose board does not exist. Widening the window to reach Monday did not help while this
    // said "any", and the banner stayed red. A suspect is only chase-able when every day it
    // could plausibly land on has actually been scanned; one unbuilt day in the window is a
    // day the order might be sitting on.
    //
    // The cost of the strong rule, stated plainly: a MIDDAY run is usually inconclusive, since
    // tomorrow's board is not built until the routing evening. That is correct rather than
    // unfortunate — an alert at noon about freight that has not been routed yet is not
    // actionable, there is nothing to chase into a board that does not exist. The NIGHTLY
    // check, which runs after routing with the boards in place, is the one that produces the
    // red alert, and it does so at the moment somebody can still act on it.
    conclusive: days.length > 0 && empty.length === 0,
    totalStops: withBoard.reduce((s, d) => s + (Number(d.stops) || 0), 0),
  };
}

/**
 * Grade a set of off-board suspects against what the boards could prove.
 *
 * Returns one of:
 *   'missing'    — at least one real board was checked and does not contain them. Chase these.
 *   'unrouted'   — every day in the window has no board yet. Nothing to chase; come back after
 *                  the routing evening.
 *   'none'       — no suspects at all.
 *
 * Deliberately conservative in ONE direction only. Downgrading to 'unrouted' cannot hide an
 * order that is genuinely lost — a lost order is still off the board tomorrow, and the check
 * runs again — whereas the alert it replaces fires every Friday whether or not anything is
 * wrong, which is how a check stops being read.
 *
 * AND IT ONLY DOWNGRADES ON POSITIVE KNOWLEDGE. A run that tells us nothing about its boards
 * keeps the alert: not knowing is not the same as knowing they were empty, and for a safety
 * flag the unknown case belongs on the loud side. That is what keeps stored runs written
 * before this field existed grading exactly as they always did.
 */
export function gradeSuspects(suspects, coverage) {
  const n = Array.isArray(suspects) ? suspects.length : 0;
  if (n === 0) return { verdict: 'none', count: 0 };
  const knownEmpty = !!coverage && coverage.known === true && coverage.conclusive === false;
  return { verdict: knownEmpty ? 'unrouted' : 'missing', count: n };
}

/** The sentence the screen shows for a grade. Plain freight language, no jargon. */
export function gradeText(grade, coverage) {
  const n = grade?.count || 0;
  const s = n === 1 ? '' : 's';
  if (grade?.verdict === 'missing') {
    return `${n} order${s} on the manifest ${n === 1 ? 'is' : 'are'} not in the scan`;
  }
  if (grade?.verdict === 'unrouted') {
    // Name only the DELIVERY days that are missing a board. A weekend day in the window has no
    // board because we do not deliver then, which is not news and reads as noise beside the
    // day that actually matters.
    const days = (coverage?.empty || []).filter(isDeliveryDay);
    const named = days.join(', ');
    return `${n} order${s} not routed yet — no board has been built for ${named || 'the delivery days checked'}`;
  }
  return '';
}
