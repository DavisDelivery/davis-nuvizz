// src/lib/davis-calendar.js
//
// ── THE DAYS DAVIS DOES NOT RUN ──────────────────────────────────────────────
//
// Chad, Sept 2026, asked which days Davis does not run: "We don't run for memorial labor July
// 4th 2 days at Thanksgiving Christmas Day and Eve and new year day."
//
// That is an operating fact, so it lives on its own rather than inside the feature that first
// needed it. TWO screens read it and they must never disagree: the Uline forecast card (where
// freight whose delivery day is closed rolls forward) and the nightly manifest check (whose
// "expected delivery" decides which board a night is reconciled against). Before this module
// existed the check was holiday-blind, so the Wednesday before Thanksgiving expected a board on
// Thanksgiving Day — a board that will never be built — and every one of that night's orders
// read "not routed yet" for ever, on the heaviest freight week of the year.
//
// SELF-CONTAINED ON PURPOSE: no imports, so manifest-window.js can use it without a cycle.

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A date that exists. "2026-13-99" and "2026-02-30" both match ISO_RE and neither is a day. */
function isRealDate(iso) {
  if (!ISO_RE.test(String(iso || ''))) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Day-of-week for an ISO date, read in UTC so a local timezone cannot shift it. */
export function isoWeekday(iso) {
  const d = new Date(`${String(iso)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

export function shiftIso(iso, n) {
  const d = new Date(`${String(iso)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * THE HOLIDAY CALENDAR. Chad, Sept 2026, asked which days Davis does not run:
 * "We don't run for memorial labor July 4th 2 days at Thanksgiving Christmas Day and Eve and
 * new year day." That is the list — an operating fact, not something to infer from a shipper's
 * spreadsheet.
 *
 * DAVIS observes every entry. ULINE observes all of them EXCEPT the day after Thanksgiving:
 * they SHIP that Friday (the Aug-2026 file carries 234 orders for Fri 11/27) and Davis does not
 * run it. That single day is why the previous rule — "a weekday absent from Uline's file that is
 * also a federal holiday" — could not work: it could only ever close a day Uline had already
 * closed, so it put Wednesday's 348 orders on a Friday with no drivers and told the roster that
 * Monday 11/30 was a 234-order day. It is 582.
 *
 * OBSERVANCE. A fixed-date holiday landing on a weekend moves the way payroll moves it: Saturday
 * to the Friday before, Sunday to the Monday after. Christmas EVE is not shifted — it is an eve,
 * not a holiday with an observance; when the 24th is a weekend there is no working day to take
 * off, and when Christmas itself lands on a Saturday its observed Friday IS the 24th (2027), so
 * the two names land on one day and are printed together.
 */
export function holidayCalendar(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1970 || y > 2200) return new Map();
  if (calendarCache.has(y)) return calendarCache.get(y);
  const out = new Map();
  const at = (yy, m, d) => `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const observed = (s) => { const w = isoWeekday(s); return w === 6 ? shiftIso(s, -1) : w === 0 ? shiftIso(s, 1) : s; };
  const nthWeekday = (m, dow, n) => { let d = at(y, m, 1); while (isoWeekday(d) !== dow) d = shiftIso(d, 1); return shiftIso(d, 7 * (n - 1)); };
  const lastMonday = (m, lastDay) => { let d = at(y, m, lastDay); while (isoWeekday(d) !== 1) d = shiftIso(d, -1); return d; };
  // A holiday whose day is a weekend is not a working day to begin with; two names on one day
  // are printed together rather than one silently overwriting the other.
  const add = (d, name, uline = true) => {
    if (!d || !d.startsWith(`${y}-`)) return;
    const w = isoWeekday(d);
    if (w == null || w === 0 || w === 6) return;
    const had = out.get(d);
    out.set(d, had ? { name: had.name.includes(name) ? had.name : `${had.name} · ${name}`, uline: had.uline && uline } : { name, uline });
  };
  add(observed(at(y, 1, 1)), "New Year's Day");
  add(lastMonday(5, 31), 'Memorial Day');
  add(observed(at(y, 7, 4)), 'July 4th');
  add(nthWeekday(9, 1, 1), 'Labor Day');
  const thanksgiving = nthWeekday(11, 4, 4);
  add(thanksgiving, 'Thanksgiving');
  add(shiftIso(thanksgiving, 1), 'the day after Thanksgiving', false);
  add(at(y, 12, 24), 'Christmas Eve');
  add(observed(at(y, 12, 25)), 'Christmas Day');
  add(observed(at(y + 1, 1, 1)), "New Year's Day");   // kept only when it lands on this year's 12/31
  calendarCache.set(y, out);
  return out;
}
const calendarCache = new Map();

const yearOf = (iso) => (ISO_RE.test(String(iso || '')) ? Number(String(iso).slice(0, 4)) : null);

/** Why Davis runs nothing on this date, or null. `extra` is ULINE_DAVIS_CLOSED — Chad's list of
 *  one-off closures the calendar cannot know (a building day, a storm). */
export function davisClosedDay(iso, extra = null) {
  if (!ISO_RE.test(String(iso || ''))) return null;
  // THE CALENDAR'S NAME WINS. The extra list ADDS days; it does not relabel the ones already
  // named, and "Christmas Eve" tells a dispatcher more than "Davis closed" does.
  const named = holidayCalendar(yearOf(iso)).get(iso)?.name ?? null;
  if (named) return named;
  return Array.isArray(extra) && extra.includes(iso) ? 'Davis closed' : null;
}

/** Days Uline itself does not ship for a holiday reason — used only to tell a genuine closure
 *  from a row whose date could not be read. Uline ships the day after Thanksgiving. */
export function ulineHolidayOn(iso) {
  const h = holidayCalendar(yearOf(iso)).get(iso);
  return h && h.uline ? h.name : null;
}

/** DAVIS'S CALENDAR over a range, iso → reason: what a screen lists so the assumption is
 *  visible and Chad can correct it, rather than buried in a delivery date that silently moved. */
export function davisClosedDays(fromIso, toIso, extra = null) {
  const out = new Map();
  if (!ISO_RE.test(String(fromIso || '')) || !ISO_RE.test(String(toIso || '')) || toIso < fromIso) return out;
  for (let d = fromIso; d && d <= toIso; d = shiftIso(d, 1)) {
    const why = davisClosedDay(d, extra);
    if (why) out.set(d, why);
  }
  return out;
}

/** PURE. Chad's one-off closures as written in ULINE_DAVIS_CLOSED: ISO dates separated by commas
 *  or whitespace, anything else ignored. Exported so the forecast card and the nightly manifest
 *  check read the SAME list — a day off that only half the app knows about is the disagreement
 *  this module exists to prevent. */
export function parseClosedList(raw) {
  // A REAL calendar date, not merely the shape of one: "2026-13-99" matches /\d{4}-\d{2}-\d{2}/
  // and would sit in the list for ever matching nothing, which is how a typo in a config hides.
  return String(raw || '').split(/[,\s]+/).map((x) => x.trim()).filter(isRealDate);
}
