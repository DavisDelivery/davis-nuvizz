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
export function resolveRange(sel, today) {
  const t = isDateStr(today) ? today : null;
  if (!t) return { from: null, to: null, days: 0, kind: 'none', clamped: 'no-today' };

  const fallback = () => ({ from: addDays(t, -(DEFAULT_DAYS - 1)), to: t, days: DEFAULT_DAYS, kind: 'days' });
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
    to = t; from = addDays(t, -(n - 1));
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
  if (to > t) { to = t; clamped = 'future'; }
  if (from > t) { from = t; clamped = 'future'; }

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
  if (r.to === today && r.days > 1) return `Last ${r.days} days`;
  return `${shortDay(r.from, today)} – ${shortDay(r.to, today)} · ${r.days} days`;
}
