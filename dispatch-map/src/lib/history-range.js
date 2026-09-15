// WHICH DAYS IS FLAG HISTORY LOOKING AT? — the one definition, read by the screen and the
// endpoint both.
//
// Chad: "I want to be able to select today and calendar to select a specific day and or
// range." The screen had a four-option dropdown — last 7, 14, 30 or 60 days — every one of
// them anchored to today and none of them able to say TODAY, or A DAY, or LAST MONTH.
//
// WHY THOSE THREE ARE DIFFERENT QUESTIONS. A rolling lookback answers "how are we trending".
// It cannot answer the two questions that actually get asked out loud: "what happened on the
// nineteenth" — the day a customer called about — and "was August better than July". The
// first needs one day, the second needs two arbitrary ends, and neither is a distance back
// from this morning.
//
// WHY IT IS A MODULE. The screen resolves a selection to decide what to fetch and what to
// print at the top; the endpoint resolves the same selection to decide which documents to
// read. If those two clamp differently — on the 60-day cap, on a future date, on a reversed
// pair — the header says one range and the numbers underneath are another, which is the
// worst kind of wrong because both halves look fine. So neither one owns the rule.

export const MAX_RANGE_DAYS = 60;   // the endpoint reads one document per day; this is the cap.
export const DEFAULT_DAYS = 14;

/**
 * HOW FAR FORWARD A LOG MAY REACH, and why a history has a future at all.
 *
 * It sounds like a contradiction, and for the flag history it is one — an outcome cannot be
 * recorded before it happens, so that screen still clamps at today and should.
 *
 * The ADDRESS log is a different animal, because an address change is filed against the BOARD
 * DAY the stop sits on, not the day somebody typed it. The problem-address queue works the
 * next business days (address-queue.mts: MAX_DAYS = 3 through scanDatesFrom), so a dispatcher
 * clearing the queue at 8pm on Monday is writing rows dated Tuesday and Wednesday. Those rows
 * are correct and they are where a dispatcher would go looking for them.
 *
 * WHAT THAT COST, 2026-09-14. Six orders were corrected and pushed to NuVizz from the queue
 * and every one of them recorded a row — dated 2026-09-15, the board day they were on. The
 * history screen could not show one of them, and not because of a filter: `to > today` clamps
 * to today (below), so the day document holding them could not be REQUESTED. Four more the
 * night before went the same way. Two full sessions were spent hunting a write that had never
 * failed, because the reader was structurally incapable of asking for the day it wrote to.
 * `nuvizz-stop-explain` reads three days ahead with no clamp and had the rows the whole time.
 *
 * FOUR CALENDAR DAYS, DERIVED NOT GUESSED: the queue walks 3 BUSINESS days, and the widest a
 * 3-business-day span gets is Friday → Tuesday, which is four calendar days. Asking for a
 * weekend document nothing ever wrote costs one Firestore get and returns empty.
 */
export const QUEUE_DAYS_AHEAD = 4;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Reject the 31st of a 30-day month and Feb 30 — a date input cannot produce them, but a
  // hand-edited URL can, and a Date that silently rolls over into next month would make the
  // endpoint read a day nobody asked for.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** N days from a YYYY-MM-DD, staying on calendar days. Noon UTC so DST cannot shift one. */
export function addDays(date, n) {
  const dt = new Date(`${date}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Inclusive day count between two dates, so a single day is 1 rather than 0. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Turn a selection into the concrete window to read.
 *
 * Selections:
 *   { kind: 'today' }                     one day, the ET today the caller passes in
 *   { kind: 'days', days: N }             N days ending today, today included
 *   { kind: 'day', date }                 that one day
 *   { kind: 'range', from, to }           those two ends, inclusive
 *
 * Returns { from, to, days, kind, clamped } where `clamped` names what had to be adjusted,
 * so the screen can SAY so instead of quietly showing a different range than was asked for.
 * Never throws: this backs a control a person is typing into, and a half-typed date must not
 * blank the page.
 */
export function resolveRange(sel, today, daysAhead = 0) {
  const t = isDateStr(today) ? today : null;
  if (!t) return { from: null, to: null, days: 0, kind: 'none', clamped: 'no-today' };

  // THE CEILING, which is `today` for every caller that does not opt in. A malformed or
  // negative `daysAhead` collapses to today rather than throwing or reaching somewhere
  // arbitrary — a history that quietly widened on a bad argument is worse than one that did
  // not widen at all.
  const ahead = Math.floor(Number(daysAhead));
  const h = Number.isFinite(ahead) && ahead > 0 ? addDays(t, ahead) : t;

  const fallback = () => ({ from: addDays(t, -(DEFAULT_DAYS - 1)), to: h, days: daysBetween(addDays(t, -(DEFAULT_DAYS - 1)), h), kind: 'days' });
  const kind = sel?.kind;
  let from; let to; let clamped = null;

  if (kind === 'today') {
    from = t; to = t;
  } else if (kind === 'day') {
    if (!isDateStr(sel.date)) return { ...fallback(), clamped: 'bad-date' };
    from = sel.date; to = sel.date;
  } else if (kind === 'days') {
    const n = Math.floor(Number(sel.days));
    if (!Number.isFinite(n) || n < 1) return { ...fallback(), clamped: 'bad-days' };
    // "The last N days" is anchored on today at the BACK end and runs to the ceiling at the
    // front, so the default view of the address log contains the forward board days a
    // correction is filed against. With no ceiling (`h === t`) this is the old behaviour
    // exactly, which is what keeps the flag history untouched.
    to = h; from = addDays(t, -(n - 1));
  } else if (kind === 'range') {
    if (!isDateStr(sel.from) || !isDateStr(sel.to)) return { ...fallback(), clamped: 'bad-range' };
    from = sel.from; to = sel.to;
    // Two date fields get filled in the wrong order constantly. Somebody who put the later
    // date first means the span between them, not an empty result.
    if (from > to) { const s = from; from = to; to = s; clamped = 'swapped'; }
  } else {
    return fallback();
  }

  // The history cannot hold a day that has not happened. Clamping rather than erroring keeps
  // "1st to the end of the month" working on the 12th, which is how people type a month.
  if (to > h) { to = h; clamped = 'future'; }
  if (from > h) { from = h; clamped = 'future'; }

  // Cap by moving the START forward and keeping the end: when a too-wide range is asked for,
  // the recent end is the half somebody wanted.
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    from = addDays(to, -(MAX_RANGE_DAYS - 1));
    clamped = 'max-days';
  }

  return { from, to, days: daysBetween(from, to), kind: kind === 'today' ? 'today' : kind, clamped };
}

/** Every date in the window, NEWEST FIRST — the order the screen lists them in. */
export function expandRange(from, to) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) return [];
  const n = Math.min(MAX_RANGE_DAYS, daysBetween(from, to));
  return Array.from({ length: n }, (_, i) => addDays(to, -i));
}

/** Read a selection off query params, for the endpoint and for a shared link. */
export function selectionFromParams(get) {
  const from = get('from');
  const to = get('to');
  const date = get('date');
  const days = get('days');
  if (from || to) return { kind: 'range', from: from || to, to: to || from };
  if (date) return { kind: 'day', date };
  if (days) return { kind: 'days', days: Number(days) };
  return { kind: 'days', days: DEFAULT_DAYS };
}

/** The query string for a selection, so the screen has one way to ask. */
export function paramsForRange({ from, to }) {
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 19" / "Aug 19, 2025" — the year only when it is not the year of `today`. */
export function shortDay(date, today) {
  if (!isDateStr(date)) return '';
  const [y, m, d] = date.split('-').map(Number);
  const sameYear = isDateStr(today) && today.slice(0, 4) === date.slice(0, 4);
  return `${MONTH[m - 1]} ${d}${sameYear ? '' : `, ${y}`}`;
}

/**
 * What the header says the screen is showing. It reports the RESOLVED window, never the
 * request — a range that got clamped must not keep describing itself as the one that was
 * typed, which is how a screen ends up lying about its own contents.
 */
export function rangeLabel(r, today) {
  if (!r?.from || !r?.to) return '';
  if (r.from === r.to) return r.to === today ? 'Today' : shortDay(r.to, today);
  // A window that runs past today is the address log reaching over the board days the queue
  // files corrections against. Say so: "Last 14 days" over a range ending Thursday is the
  // header lying about its own contents, which is the one thing this module exists to stop.
  if (isDateStr(today) && r.to > today) {
    const back = daysBetween(r.from, today);
    return back > 1 ? `Last ${back} days + the board ahead` : 'Today + the board ahead';
  }
  if (r.to === today && r.days > 1) return `Last ${r.days} days`;
  return `${shortDay(r.from, today)} – ${shortDay(r.to, today)} · ${r.days} days`;
}
