// src/lib/uline-forecast-score.js
//
// ── ULINE'S FORECAST, JUDGED AGAINST THE FREIGHT THAT ACTUALLY CAME ──────────
//
// Chad: "compare [the forecasts] to what the manifest actually produce so we can try to
// forecast what is coming."
//
// Everything here is PURE: versions in, manifest nights in, a clock and a couple of Chad's
// numbers in — a whole screen's worth of plain data out. No Firestore, no Gmail, no NuVizz,
// and no Date.now(): `today` and `nowMs` are parameters, so a test can put the calendar
// wherever it needs it and the answer for a given night never changes after the fact.
//
// THE TWO UNITS, kept apart on purpose:
//   • Uline forecasts ORDERS per SHIP date. The manifest archive keys a night on that same
//     ship date (manifestDeliveryDate). SCORING joins on it and nothing else — Uline is judged
//     on the date they forecast.
//   • Davis staffs DRIVERS per DELIVERY day. The OUTLOOK rolls ship dates up into delivery
//     days the way the archive already does (ship Fri → Mon; ship Sun → Tue; see
//     expectedDeliveryDate), so the roster reads "Tue 9/8 · Sun 75 + Mon 665", the heavy day
//     nobody gets from the spreadsheet. That roll-up is presentation only.
//
// TWO CALENDARS, NOT ONE. Uline's file is Uline's calendar: a Monday–Friday ship date inside
// the range with NO row is a day Uline does not ship (Labor Day, Thanksgiving, Christmas Eve
// and Day, New Year's, Memorial Day and the July 4th observance are simply absent from the
// Aug-2026 file). That is NOT the same as a day Davis does not deliver: Uline not shipping on
// Christmas Eve still leaves Wednesday's 318 orders to deliver on Thursday. So a delivery day
// is skipped ONLY when it is a Uline-closed day that is also a US federal holiday (the ones
// both sides observe), plus any date in ULINE_DAVIS_CLOSED. Freight whose delivery day lands
// on such a day rolls forward: Fri 9/4 and Sun 9/6 both deliver Tue 9/8 and Mon 9/7 reads
// "Labor Day"; Christmas Eve keeps its freight. Wrong in the other direction — a working day
// shown as "no deliveries" — is a day nobody staffs, the expensive mistake, so the default is
// "Davis delivers" and the closed list is Chad's to extend, never inferred.
//
// TONIGHT IS NOT A NIGHT YET. Reports keep landing until ~1am and the count only goes up, so
// an 8pm report is a third of the freight, not a verdict on Uline. A ship date is scored once
// the operating day rolls at 5am; until then it is `pending` and only the tonight line reads it.
//
// Every threshold carries the argument for which mistake is cheaper if it is wrong; see the
// constants. The plan figure only ever moves UP from Uline's number: over-staffing costs one
// short route, under-staffing costs late deliveries into closed receiving windows, refusals,
// redeliveries and carryover.

import { expectedDeliveryDate, nextDeliveryDay, isDeliveryDay, isoWeekday, shiftIso } from './manifest-window.js';

// ── CHAD'S NUMBERS AND THE FIXED THRESHOLDS ───────────────────────────────────

/** One driver's day, in orders. Drafted; env ULINE_ROUTE_DAY_ORDERS overrides. A night that
 *  ran this far OVER the estimate is freight nobody staffed for. */
export const ROUTE_DAY_ORDERS_DEFAULT = 35;
/** The only report that arrives before this hour ET on the ship date is the ~10:51am
 *  preliminary; full reports start ~8pm. Safe in EDT and EST, unlike a 20:00 boundary. */
export const PROVISIONAL_CUTOFF_HOUR = 18;
/** Fewer scored nights than this on a weekday and the screen prints "not enough nights yet"
 *  rather than a rate it would not act on; the same gate governs the plan's bias. */
export const MIN_WEEKDAY_N = 4;
/** A bias older than a quarter is a different Uline. */
export const BIAS_WINDOW_DAYS = 90;
/** The pattern sentence: 3 of the last 5 same-weekday nights ≥ 30 the same side of the
 *  estimate. 3/5 is the smallest majority that cannot be two coincidences; 30 is under a
 *  route-day so a drift is named before it becomes route-days. */
export const PATTERN_LAST_N = 5;
export const PATTERN_MIN_HITS = 3;
export const PATTERN_MIN_ORDERS = 30;
/** A week Uline moved: mean per-day delta ≥ 40 orders or ≥ 5%, same sign on ≥ 3 days.
 *  Monthly revisions average ~8 with a max of 56, so 40 is well above the wobble. */
export const CHANGE_MIN_ORDERS = 40;
export const CHANGE_MIN_PCT = 0.05;
export const CHANGE_MIN_DAYS = 3;
export const CHANGE_WEEKS = 6;
/** LIGHT when the plan is under 0.8 × the median for THAT delivery weekday across the version
 *  — "is this light for a Monday". Against all days every Monday chipped LIGHT (33 of 37 in
 *  the Aug-2026 file): a chip that is on every week is one the roster person learns to skip,
 *  and then the Monday after Thanksgiving at 234 (typical 512) carries the same chip as an
 *  ordinary one. Every dispatcher already knows Monday is Friday's freight. */
export const LIGHT_RATIO = 0.8;
export const OUTLOOK_DAYS = 14;
/** The ledger always reaches back this far, whatever the screen asked to LIST: the 90- and
 *  180-night figures and the plan's 90-day bias must not be capped by a ?days=60 request. */
export const STATS_WINDOW_DAYS = 180;
/** From the 11th with no readable version this month, the card goes amber. Uline has sent
 *  by the 7th every month since June 2022; four days of grace, not forty. */
export const VERSION_DUE_DAY = 11;
export const NIGHT_ROLLOVER_HOUR = 5;
/** Horizon buckets in weeks, because that is how a staffing decision is phrased. */
export const HORIZON_BUCKETS = [['≤4w', 0, 28], ['5–8w', 29, 56], ['9–13w', 57, 91], ['14w+', 92, Infinity]];

const ET_TZ = 'America/New_York';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── SMALL PURE HELPERS ────────────────────────────────────────────────────────

/** Calendar date + hour in ET for an epoch-ms instant; null when it is not an instant. */
export function etParts(ms) {
  if (ms == null || ms === '' || typeof ms === 'boolean') return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(n));
  const get = (t) => p.find((x) => x.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (!ISO_RE.test(date)) return null;
  return { date, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** The operating day for an instant: before 5am ET the night still belongs to yesterday. */
export function operatingDayET(ms) {
  const p = etParts(ms);
  if (!p) return null;
  return p.hour < NIGHT_ROLLOVER_HOUR ? shiftIso(p.date, -1) : p.date;
}

export function isoDow(iso) { return isoWeekday(iso); }
export function dowName(iso) { const w = isoWeekday(iso); return w == null ? '' : DOW[w]; }
export function mdLabel(iso) { const m = ISO_RE.exec(String(iso || '')) ? String(iso).split('-') : null; return m ? `${Number(m[1])}/${Number(m[2])}` : String(iso ?? ''); }
export function dayLabel(iso) { return `${dowName(iso)} ${mdLabel(iso)}`; }
const roundUp5 = (n) => Math.ceil(n / 5) * 5;
const round1 = (n) => Math.round(n * 10) / 10;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const percentile = (xs, p) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))]; };
function daysBetween(a, b) { return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000); }

export function horizonDays(sentDate, shipIso) {
  if (!ISO_RE.test(String(sentDate || '')) || !ISO_RE.test(String(shipIso || ''))) return null;
  return daysBetween(sentDate, shipIso);
}
export function horizonBucket(days) {
  if (days == null || !Number.isFinite(days)) return null;
  for (const [name, lo, hi] of HORIZON_BUCKETS) if (days >= lo && days <= hi) return name;
  return days < 0 ? null : HORIZON_BUCKETS[HORIZON_BUCKETS.length - 1][0];
}

// ── VERSIONS ──────────────────────────────────────────────────────────────────

const usable = (v) => !!v && v.ok !== false && v.days && typeof v.days === 'object' && ISO_RE.test(String(v.from || '')) && ISO_RE.test(String(v.to || ''));
const covers = (v, iso) => usable(v) && iso >= v.from && iso <= v.to;
const estOf = (v, iso) => { const r = v?.days?.[iso]; return Array.isArray(r) && Number.isFinite(Number(r[0])) ? Number(r[0]) : null; };
const upperOf = (v, iso) => { const r = v?.days?.[iso]; return Array.isArray(r) && r[1] != null && Number.isFinite(Number(r[1])) ? Number(r[1]) : null; };

/** The newest usable version sent STRICTLY before the ship date — a file received on the ship
 *  date was not in hand when the drivers were set, and scoring it is hindsight. */
export function versionInForce(versions, shipIso) {
  let best = null;
  for (const v of versions || []) {
    if (!usable(v) || !(v.sentDate < shipIso)) continue;
    if (!best || Number(v.sentAt) > Number(best.sentAt)) best = v;
  }
  return best;
}

/** The newest usable version, full stop — what the OUTLOOK reads from (today's best knowledge). */
export function latestUsable(versions) {
  let best = null;
  for (const v of versions || []) { if (usable(v) && (!best || Number(v.sentAt) > Number(best.sentAt))) best = v; }
  return best;
}

/** Every version that carried this date, oldest first, each with how far out it was. */
export function ladderForDate(versions, shipIso) {
  const out = [];
  for (const v of versions || []) {
    if (!usable(v) || estOf(v, shipIso) == null) continue;
    const h = horizonDays(v.sentDate, shipIso);
    out.push({ versionId: v.versionId, sentDate: v.sentDate, sentAt: Number(v.sentAt) || 0, horizonDays: h, bucket: horizonBucket(h), estimate: estOf(v, shipIso), upperEst: upperOf(v, shipIso) });
  }
  return out.sort((a, b) => a.sentAt - b.sentAt);
}

// ── THE TWO CALENDARS ─────────────────────────────────────────────────────────

/** US federal holidays as observed (Saturday → Friday, Sunday → Monday) for one year, iso →
 *  name. New Year's Day observed on 12/31 of the year before is listed under that year. A
 *  holiday here closes Davis ONLY when Uline's file also has no row for it (davisClosedDays). */
export function usFederalHolidays(year) {
  const out = new Map();
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1970 || y > 2200) return out;
  const iso = (yy, m, d) => `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const observed = (s) => { const w = isoWeekday(s); return w === 6 ? shiftIso(s, -1) : w === 0 ? shiftIso(s, 1) : s; };
  const nthWeekday = (m, dow, n) => { let d = iso(y, m, 1); while (isoWeekday(d) !== dow) d = shiftIso(d, 1); return shiftIso(d, 7 * (n - 1)); };
  const lastMonday = (m, lastDay) => { let d = iso(y, m, lastDay); while (isoWeekday(d) !== 1) d = shiftIso(d, -1); return d; };
  const add = (d, name) => { if (d && d.startsWith(`${y}-`)) out.set(d, name); };
  add(observed(iso(y, 1, 1)), "New Year's Day");
  add(nthWeekday(1, 1, 3), 'Martin Luther King Day');
  add(nthWeekday(2, 1, 3), "Presidents' Day");
  add(lastMonday(5, 31), 'Memorial Day');
  add(observed(iso(y, 6, 19)), 'Juneteenth');
  add(observed(iso(y, 7, 4)), 'Independence Day');
  add(nthWeekday(9, 1, 1), 'Labor Day');
  add(nthWeekday(10, 1, 2), 'Columbus Day');
  add(observed(iso(y, 11, 11)), 'Veterans Day');
  add(nthWeekday(11, 4, 4), 'Thanksgiving');
  add(observed(iso(y, 12, 25)), 'Christmas Day');
  add(observed(iso(y + 1, 1, 1)), "New Year's Day");   // kept only when it falls on this year's 12/31
  return out;
}

const federalCache = new Map();
function federalFor(version) {
  const key = `${version?.from}|${version?.to}`;
  if (federalCache.has(key)) return federalCache.get(key);
  const fed = new Map();
  if (usable(version)) {
    const y0 = Number(version.from.slice(0, 4)); const y1 = Number(version.to.slice(0, 4));
    for (let y = y0; y <= y1; y++) for (const [d, name] of usFederalHolidays(y)) fed.set(d, name);
  }
  federalCache.set(key, fed);
  return fed;
}

const unknownCache = new WeakMap();
/** Ship dates Uline sent a row for that could not be read — plus, when the file had rows whose
 *  DATE could not be read, every non-holiday weekday gap: any one of them may be that row, and
 *  a day with no NUMBER must never be rendered as a day with no FREIGHT (Tuesday's 706 staffed
 *  for Thursday, Wednesday staffed for nothing). Uline's export has never had a bad date; one
 *  is a format change, and this is what keeps it from turning into a fake closure. */
export function unknownShipDays(version) {
  const out = new Set(Array.isArray(version?.unreadableDates) ? version.unreadableDates : []);
  if (!usable(version)) return out;
  if (unknownCache.has(version)) return unknownCache.get(version);
  const badDates = Number(version.rowsDropped?.badDate) || 0;
  if (badDates > 0) {
    const fed = federalFor(version);
    for (let d = version.from; d <= version.to; d = shiftIso(d, 1)) {
      const w = isoWeekday(d);
      if (w == null || w === 0 || w === 6 || fed.has(d)) continue;
      if (estOf(version, d) == null) out.add(d);
    }
  }
  unknownCache.set(version, out);
  return out;
}

const closedCache = new WeakMap();
/** ULINE'S CALENDAR: Mon–Fri ship dates inside the version's range that Uline sent NO row for
 *  (or zero) — days Uline does not ship. A date whose row could not be read is not closed, it
 *  is unknown. This set decides where freight comes FROM; it does not decide whether Davis runs. */
export function closedShipDays(version) {
  const closed = new Set();
  if (!usable(version)) return closed;
  if (closedCache.has(version)) return closedCache.get(version);
  const unknown = unknownShipDays(version);
  for (let d = version.from; d <= version.to; d = shiftIso(d, 1)) {
    const w = isoWeekday(d);
    if (w == null || w === 0 || w === 6) continue;
    if (unknown.has(d)) continue;
    const e = estOf(version, d);
    if (e == null || e === 0) closed.add(d);
  }
  closedCache.set(version, closed);
  return closed;
}

/** DAVIS'S CALENDAR: days no route runs, iso → reason. A Uline-closed weekday that is ALSO a
 *  federal holiday (Labor Day, Thanksgiving, Christmas Day, New Year's, Memorial Day, the July
 *  4th observance), plus every date in `extra` (env ULINE_DAVIS_CLOSED — Chad's list, so a
 *  Christmas Eve Davis takes off is one line away). Christmas Eve is Uline-closed and NOT a
 *  federal holiday, so by default Wednesday's freight is delivered on it. */
export function davisClosedDays(version, extra = null) {
  const out = new Map();
  for (const d of Array.isArray(extra) ? extra : []) if (ISO_RE.test(String(d || ''))) out.set(String(d), 'Davis closed');
  if (!usable(version)) return out;
  const closed = closedShipDays(version);
  for (const [d, name] of federalFor(version)) if (closed.has(d) && !out.has(d)) out.set(d, name);
  return out;
}

/** Where freight shipped on `shipIso` delivers, rolling past days DAVIS does not run
 *  (`noDelivery` is davisClosedDays, or any Set/Map of iso dates). */
export function deliveryDayFor(shipIso, noDelivery) {
  let d = expectedDeliveryDate(shipIso);
  for (let guard = 0; d && noDelivery && noDelivery.has(d) && guard < 8; guard++) d = nextDeliveryDay(d);
  return d;
}

// ── ONE NIGHT: WHAT ACTUALLY CAME ─────────────────────────────────────────────

/**
 * Read the manifest archive's answer for a night. The row is a masked manifest_days doc:
 * { latest: { orders, verified, receivedAt, at, reportNo, mailbox }, reportCount, sawOrderCountFall }.
 *
 * PROVISIONAL: the standing report arrived before 18:00 ET on the ship date — the 10:51am
 * preliminary, ~27KB and a third of the night. Scoring it would book a 300-order under-run
 * against Uline. The stamp is the mailbox receive time when the archive has it, else the
 * time WE filed it (nights before v0.81.3 carry no receivedAt, and every one of them is a
 * complete report filed at 1am); a night with neither is excluded with that reason rather
 * than guessed at — Number(null) is 0, and 0 is 7pm on 1969-12-31.
 */
export function actualFromManifestDay(row, shipIso) {
  const l = row?.latest || null;
  if (!l) return { status: 'missing', actual: null, reason: 'no manifest on file' };
  const orders = Number(l.orders);
  const reports = Number(row?.reportCount) || Number(l.reportNo) || null;
  const base = { actual: Number.isFinite(orders) ? orders : null, reportNo: l.reportNo ?? null, reports, mailbox: l.mailbox ?? null };
  if (row?.sawOrderCountFall) return { ...base, status: 'count_fell', reason: 'a report came back shorter than the one before it — the count is not trusted' };
  if (!l.verified) return { ...base, status: 'unverified', reason: 'the manifest did not reconcile against its own printed totals' };
  if (!Number.isFinite(orders)) return { ...base, status: 'unverified', reason: 'no order count on the record' };
  let stamp = null; let stampFrom = null;
  if (l.receivedAt != null && Number.isFinite(Number(l.receivedAt)) && Number(l.receivedAt) > 0) { stamp = Number(l.receivedAt); stampFrom = 'receivedAt'; }
  else if (l.at && Number.isFinite(Date.parse(l.at))) { stamp = Date.parse(l.at); stampFrom = 'filedAt'; }
  if (stamp == null) return { ...base, status: 'unknown', reason: 'no receive or file time on the record — cannot tell the preliminary from the final' };
  const p = etParts(stamp);
  const provisional = !!p && (p.date < shipIso || (p.date === shipIso && p.hour < PROVISIONAL_CUTOFF_HOUR));
  const when = p ? `${p.date === shipIso ? '' : `${mdLabel(p.date)} `}${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : '';
  if (provisional) return { ...base, status: 'provisional', stamp, stampFrom, reason: `only the early report on file (${orders} at ${when}${stampFrom === 'filedAt' ? ', filed' : ''}) — the full reports land from 8pm` };
  return { ...base, status: 'actual', stamp, stampFrom, reason: null };
}

/**
 * Where a ship date stands, given the version in force for it and what the archive holds.
 *
 *   scored        a verified, final manifest and a forecast row — it counts
 *   provisional / unverified / count_fell / unknown   a manifest, but not one to score (reason given)
 *   pending       forecast > 0, no manifest yet, and the delivery day has not come — Sunday's
 *                 reports cannot be filed until Monday evening's board exists; never a hole
 *   hole          forecast > 0, no manifest, delivery day past — the manifest ingest missed a night
 *   before_archive  same, but earlier than the first archived night — nothing to miss
 *   closed        no forecast row on a Mon–Fri (or a Saturday), and no manifest — Uline closed
 *   unforecast    a manifest with no forecast row (a Saturday, or a day Uline said closed)
 *   unreadable    Uline sent a row for the day that could not be read
 *   uncovered     no version in force covers the date at all
 */
export function classifyNight({ shipIso, version, row, floor, today, davisClosed = null }) {
  const v = version;
  const cov = covers(v, shipIso);
  const unreadable = cov && unknownShipDays(v).has(shipIso);
  const est = cov ? estOf(v, shipIso) : null;
  const upper = cov ? upperOf(v, shipIso) : null;
  const has = !!row?.latest;
  if (!cov) return { status: 'uncovered', est: null, upper: null, reason: v ? `the forecast in force (${v.sentDate}) runs ${v.from} to ${v.to}` : 'no forecast on file for this date' };
  if (unreadable) return { status: 'unreadable', est: null, upper: null, reason: `the ${v.sentDate} file carried a row for this day that could not be read` };
  if (est == null || est === 0) {
    if (has) return { status: 'unforecast', est: est ?? null, upper, reason: 'Uline shipped, nothing was forecast for this day' };
    return { status: 'closed', est: 0, upper: null, reason: isoWeekday(shipIso) === 6 ? 'Saturday — Uline does not ship' : 'Uline closed' };
  }
  const deliverOn = deliveryDayFor(shipIso, davisClosedDays(v, davisClosed));
  // TONIGHT IS NOT A NIGHT YET (see the header): whatever is on file for today's ship date is
  // a count in progress. It is scored after the 5am roll; the tonight line reads it live.
  if (today && shipIso === today) {
    const soFar = has && Number.isFinite(Number(row.latest.orders)) ? Number(row.latest.orders) : null;
    return { status: 'pending', est, upper, deliverOn, actual: soFar, reportNo: row?.latest?.reportNo ?? null, inProgress: has,
      reason: has ? `tonight — ${soFar ?? '?'} so far (#${row.latest.reportNo ?? '?'}); scored after the 5am roll` : `reports land in the mailbox on the night of ${mdLabel(shipIso)}; filed once the ${dayLabel(deliverOn)} board is scanned` };
  }
  if (has) {
    const a = actualFromManifestDay(row, shipIso);
    return { status: a.status === 'actual' ? 'scored' : a.status, est, upper, actual: a.actual, reportNo: a.reportNo, reports: a.reports, stamp: a.stamp ?? null, stampFrom: a.stampFrom ?? null, mailbox: a.mailbox ?? null, reason: a.reason };
  }
  if (today && deliverOn && deliverOn > today) return { status: 'pending', est, upper, deliverOn, reason: `reports land in the mailbox on the night of ${mdLabel(shipIso)}; filed once the ${dayLabel(deliverOn)} board is scanned` };
  if (floor && shipIso < floor) return { status: 'before_archive', est, upper, reason: `before the manifest archive began (${floor})` };
  return { status: 'hole', est, upper, deliverOn, reason: 'Uline forecast freight and no manifest is on file — the manifest ingest may have missed this night' };
}

// ── ONE NIGHT: THE SCORE ──────────────────────────────────────────────────────

/**
 * err = actual − estimate. POSITIVE means Uline under-forecast — the expensive direction.
 * verdict, exactly one:
 *   over_high      actual STRICTLY above Uline's own high (764 against 764 is AT the ceiling)
 *   heavy          err ≥ one route-day: freight nobody staffed for
 *   light_suspect  actual < est − 2·band: more often a filed fragment than a quiet night —
 *                  "check this night's reports" rather than a huge over-forecast on the record
 *   light          err ≤ −2 route-days (a quiet night; over-forecasting is the cheap mistake)
 *   on             everything else, uncoloured
 * Fixed constants, never a rolling MAE: a night's colour must not change after the fact.
 */
export function scorePair({ actual, est, upper, medianBand, routeDay }) {
  const rd = Number.isFinite(Number(routeDay)) && Number(routeDay) > 0 ? Number(routeDay) : ROUTE_DAY_ORDERS_DEFAULT;
  // Number(null) is 0. A missing actual is not a zero-order night and must never score as one.
  if (actual == null || est == null || actual === '' || est === '') return { err: null, absErr: null, pct: null, band: null, overHigh: false, verdict: 'on' };
  const a = Number(actual); const e = Number(est);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return { err: null, absErr: null, pct: null, band: null, overHigh: false, verdict: 'on' };
  const u = upper != null && Number.isFinite(Number(upper)) ? Number(upper) : null;
  const band = u != null ? u - e : (Number.isFinite(Number(medianBand)) ? Number(medianBand) : null);
  const err = a - e;
  const pct = e > 0 ? err / e : null;
  const overHigh = u != null && a > u;
  let verdict = 'on';
  if (overHigh) verdict = 'over_high';
  else if (err >= rd) verdict = 'heavy';
  else if (band != null && band > 0 && a < e - 2 * band) verdict = 'light_suspect';
  else if (err <= -2 * rd) verdict = 'light';
  return { err, absErr: Math.abs(err), pct, band, overHigh, verdict };
}

// ── ROLL-UPS ──────────────────────────────────────────────────────────────────

/** An empty window is n:0 with nulls — never NaN, never a confident zero. */
export function summarize(pairs) {
  const ps = (pairs || []).filter((p) => Number.isFinite(p?.err));
  if (!ps.length) return { n: 0, mae: null, bias: null, mape: null, p90AbsErr: null, overHigh: { count: 0, rate: null }, heavy: 0, light: 0, worst: null };
  const errs = ps.map((p) => p.err);
  const pcts = ps.map((p) => p.pct).filter(Number.isFinite).map(Math.abs);
  const over = ps.filter((p) => p.overHigh).length;
  let worst = ps[0];
  for (const p of ps) if (Math.abs(p.err) > Math.abs(worst.err)) worst = p;
  return {
    n: ps.length,
    mae: round1(mean(errs.map(Math.abs))),
    bias: round1(mean(errs)),
    mape: pcts.length ? round1(100 * mean(pcts)) : null,
    p90AbsErr: percentile(errs.map(Math.abs), 0.9),
    overHigh: { count: over, rate: round1(over / ps.length) },
    heavy: ps.filter((p) => p.verdict === 'heavy' || p.verdict === 'over_high').length,
    light: ps.filter((p) => p.verdict === 'light' || p.verdict === 'light_suspect').length,
    worst: { date: worst.date, err: worst.err, verdict: worst.verdict },
  };
}

/** By SHIP weekday. Figures print only at n ≥ minN; below it the row says so. */
export function byWeekday(pairs, minN = MIN_WEEKDAY_N) {
  const out = {};
  for (let w = 0; w < 7; w++) {
    const ps = (pairs || []).filter((p) => isoWeekday(p.date) === w && Number.isFinite(p?.err));
    const s = summarize(ps);
    out[w] = { dow: DOW[w], n: s.n, shown: s.n >= minN, mae: s.n >= minN ? s.mae : null, bias: s.n >= minN ? s.bias : null, overHigh: s.overHigh.count };
  }
  return out;
}

/** By how far out the number was. Uses EVERY version's pair for a night ("how good is a
 *  number k weeks old"), not just the one in force. */
export function byHorizon(ladderPairs) {
  const out = {};
  for (const [name] of HORIZON_BUCKETS) {
    const ps = (ladderPairs || []).filter((p) => p.bucket === name && Number.isFinite(p?.err));
    const s = summarize(ps);
    out[name] = { n: s.n, mae: s.mae, bias: s.bias, shown: s.n >= MIN_WEEKDAY_N };
  }
  return out;
}

/** Per ship weekday, over the last `windowDays`: n and mean err. Feeds the plan figure. */
export function weekdayBias(pairs, today, windowDays = BIAS_WINDOW_DAYS) {
  const lo = shiftIso(today, -windowDays);
  const out = {};
  for (let w = 0; w < 7; w++) {
    const ps = (pairs || []).filter((p) => isoWeekday(p.date) === w && Number.isFinite(p?.err) && p.date >= lo && p.date <= today);
    out[w] = { n: ps.length, bias: ps.length ? round1(mean(ps.map((p) => p.err))) : null };
  }
  return out;
}

/** "Tuesdays have run 40 low for 3 of the last 5 weeks" — the sentence for the Uline call.
 *  Per ship weekday, the last 5 scorable nights; 3 on the same side by ≥ 30 makes a sentence.
 *  A single night is never one. */
export function patternSentences(pairs) {
  const out = [];
  for (let w = 0; w < 7; w++) {
    const ps = (pairs || []).filter((p) => isoWeekday(p.date) === w && Number.isFinite(p?.err)).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, PATTERN_LAST_N);
    if (ps.length < PATTERN_MIN_HITS) continue;
    const over = ps.filter((p) => p.err >= PATTERN_MIN_ORDERS);
    const under = ps.filter((p) => p.err <= -PATTERN_MIN_ORDERS);
    const side = over.length >= PATTERN_MIN_HITS ? over : under.length >= PATTERN_MIN_HITS ? under : null;
    if (!side) continue;
    const avg = Math.round(Math.abs(mean(side.map((p) => p.err))));
    // "low" is Uline's number running low against what came (they under-forecast).
    out.push({ dow: DOW[w], hits: side.length, of: ps.length, orders: avg, direction: side === over ? 'low' : 'high',
      text: `${DOW_PLURAL[w]}: Uline's number has run ${avg} ${side === over ? 'low' : 'high'} on ${side.length} of the last ${ps.length}` });
  }
  return out;
}

// ── THE OUTLOOK: DELIVERY DAYS, FROM TODAY'S BEST VERSION ─────────────────────

/**
 * The next `days` calendar days as DELIVERY-day rows. Each ship date lands on
 * deliveryDayFor(ship, closed) — expectedDeliveryDate rolled past days Uline is closed.
 *
 * plan = Σ over the day's ship components of (est + max(0, bias of that ship weekday)),
 * rounded UP to the next 5, only when EVERY contributing weekday has n ≥ MIN_WEEKDAY_N; else
 * plan = est and the row says so. Only upward: a Uline that runs high leaves the plan alone
 * and the row says "Uline has run 7 high on Tuesdays" — the software never trims for the
 * dispatcher.
 */
export function deliveryOutlook({ version, today, days = OUTLOOK_DAYS, capacity = null, bias = null, unreadableDates = null, davisClosed = null }) {
  if (!usable(version) || !ISO_RE.test(String(today || ''))) return [];
  const closed = closedShipDays(version);                       // Uline's calendar: where freight comes from
  const noDelivery = davisClosedDays(version, davisClosed);     // Davis's calendar: whether a route runs
  const unreadable = new Set([...(Array.isArray(unreadableDates) ? unreadableDates : []), ...unknownShipDays(version)]);
  const groups = new Map();   // deliverOn -> { ships, closedShips, unreadableShips, rolled }
  const g = (d) => { if (!groups.has(d)) groups.set(d, { ships: [], closedShips: [], unreadableShips: [], rolled: [] }); return groups.get(d); };
  // The delivery days this outlook renders are decided FIRST: `days` counts delivery days, and
  // 14 of them span ~20 calendar days. Grouping ship dates only to today+17 left the last row
  // or two reading "no Uline freight expected" against a 770-order Tuesday, on 51 of 90 days.
  const deliveryDates = [];
  for (let d = shiftIso(today, 1); d && deliveryDates.length < days; d = shiftIso(d, 1)) if (isDeliveryDay(d)) deliveryDates.push(d);
  const last = deliveryDates[deliveryDates.length - 1] || today;   // a ship date never delivers before it ships
  for (let d = shiftIso(today, -7); d && d <= last; d = shiftIso(d, 1)) {
    const w = isoWeekday(d);
    if (w === 6) continue;                           // Uline never ships Saturday
    const deliverOn = deliveryDayFor(d, noDelivery);
    if (!deliverOn) continue;
    if (unreadable.has(d) && covers(version, d)) { g(deliverOn).unreadableShips.push(d); continue; }
    if (closed.has(d)) { g(deliverOn).closedShips.push(d); continue; }
    const e = estOf(version, d);
    if (e == null) continue;
    const grp = g(deliverOn);
    grp.ships.push({ date: d, dow: DOW[w], est: e, upper: upperOf(version, d) });
    const usual = expectedDeliveryDate(d);
    if (usual && usual !== deliverOn) grp.rolled.push({ date: d, past: usual });
  }
  // The typical delivery day FOR THAT WEEKDAY across the whole version, for LIGHT.
  const typicalByW = {};
  {
    const byDay = new Map();
    for (let d = version.from; d <= version.to; d = shiftIso(d, 1)) {
      if (isoWeekday(d) === 6 || closed.has(d) || unreadable.has(d)) continue;
      const e = estOf(version, d); if (e == null) continue;
      const k = deliveryDayFor(d, noDelivery); if (!k) continue;
      byDay.set(k, (byDay.get(k) || 0) + e);
    }
    const byW = {};
    for (const [k, total] of byDay) { const w = isoWeekday(k); (byW[w] = byW[w] || []).push(total); }
    for (const w of Object.keys(byW)) typicalByW[w] = median(byW[w]);
  }
  const cap = Number.isFinite(Number(capacity)) && Number(capacity) > 0 ? Number(capacity) : null;

  const rows = [];
  for (const d of deliveryDates) {
    const w = isoWeekday(d);
    const row = { deliverOn: d, dow: DOW[w], label: dayLabel(d), ships: [], est: null, upper: null, plan: null, adjusted: false, adjustedBy: 0, chips: [], notes: [], status: 'ok' };
    if (noDelivery.has(d)) { row.status = 'closed'; row.notes.push(`${noDelivery.get(d)} — no deliveries`); rows.push(row); continue; }
    const grp = groups.get(d);
    if (!grp || (!grp.ships.length && !grp.unreadableShips.length)) {
      if (d > version.to) { row.status = 'not_forecast_yet'; row.notes.push(`not forecast yet — the ${version.sentDate} file runs to ${version.to}`); }
      else { row.status = 'none'; row.notes.push('no Uline freight expected'); if (grp?.closedShips.length) row.notes.push(`Uline closed ${grp.closedShips.map(mdLabel).join(', ')}`); }
      rows.push(row); continue;
    }
    row.ships = grp.ships;
    row.est = grp.ships.reduce((a, s) => a + s.est, 0);
    const uppers = grp.ships.map((s) => s.upper);
    row.upper = uppers.every((u) => u != null) ? uppers.reduce((a, b) => a + b, 0) : null;
    if (grp.unreadableShips.length) { row.status = 'unreadable'; row.notes.push(`no readable estimate for ${grp.unreadableShips.map(mdLabel).join(', ')} in the ${version.sentDate} file`); }
    if (grp.rolled.length) row.notes.push(`${grp.rolled.map((r) => `${dayLabel(r.date)} freight`).join(' + ')} rolled past ${[...new Set(grp.rolled.map((r) => noDelivery.get(r.past) || mdLabel(r.past)))].join(', ')}`);
    if (grp.closedShips.length) row.notes.push(`Uline closed ${grp.closedShips.map(mdLabel).join(', ')}`);
    // The plan.
    const contributing = [...new Set(grp.ships.map((s) => isoWeekday(s.date)))];
    const ready = !!bias && contributing.every((wd) => (bias[wd]?.n || 0) >= MIN_WEEKDAY_N);
    if (ready && row.status !== 'unreadable') {
      let add = 0; const high = [];
      for (const s of grp.ships) { const b = bias[isoWeekday(s.date)]?.bias || 0; if (b > 0) add += b; else if (b < 0) high.push(`${DOW[isoWeekday(s.date)]} ${Math.abs(Math.round(b))} high`); }
      // Rounded UP to 5 only when something was added: a plan of 811 is false precision, but
      // Uline's own 769 stays 769 — the screen must not misquote the shipper.
      row.plan = add > 0 ? roundUp5(row.est + add) : row.est;
      row.adjusted = add > 0; row.adjustedBy = Math.round(add);
      if (add > 0) row.notes.push(`plan adds ${Math.round(add)} — Uline has run low on ${contributing.map((wd) => DOW[wd]).join('/')}`);
      if (high.length) row.notes.push(`Uline has run ${high.join(', ')} — the plan is not trimmed for that`);
    } else if (row.status !== 'unreadable') {
      row.plan = row.est;
      row.notes.push("Uline's number — not enough nights to adjust");
    }
    if (row.plan != null) {
      if (cap != null) {
        if (row.plan > cap) row.chips.push('HEAVY');
        else if (row.upper != null && row.upper > cap) row.chips.push('could be over');
      }
      const typical = typicalByW[w];
      if (typical != null && row.plan < LIGHT_RATIO * typical) { row.chips.push('LIGHT'); row.notes.push(`light for a ${DOW[w]} — typical ${Math.round(typical)}`); }
    }
    rows.push(row);
  }
  return rows;
}

// ── VERSIONS OVER TIME ────────────────────────────────────────────────────────

/** What moved between two versions over the next weeks, in the sentences worth reading. */
export function diffVersions(prev, next, today) {
  if (!usable(prev) || !usable(next)) return { overlap: 0, unchanged: 0, meanAbsDelta: null, maxDelta: null, weeks: [] };
  const deltas = [];
  for (const d of Object.keys(next.days)) {
    const a = estOf(prev, d); const b = estOf(next, d);
    if (a == null || b == null) continue;
    deltas.push({ date: d, prev: a, next: b, delta: b - a });
  }
  const overlap = deltas.length;
  const unchanged = deltas.filter((x) => x.delta === 0).length;
  const meanAbsDelta = overlap ? round1(mean(deltas.map((x) => Math.abs(x.delta)))) : null;
  const maxDelta = overlap ? deltas.reduce((m, x) => (Math.abs(x.delta) > Math.abs(m) ? x.delta : m), 0) : null;
  const weeks = [];
  if (ISO_RE.test(String(today || ''))) {
    // Weeks start Monday; the six that begin on or after this week's Monday.
    const wd = isoWeekday(today);
    const monday = shiftIso(today, wd === 0 ? -6 : 1 - wd);
    for (let i = 0; i < CHANGE_WEEKS; i++) {
      const start = shiftIso(monday, 7 * i); const end = shiftIso(start, 6);
      const ws = deltas.filter((x) => x.date >= start && x.date <= end);
      if (ws.length < CHANGE_MIN_DAYS) continue;
      const m = mean(ws.map((x) => x.delta));
      const base = mean(ws.map((x) => x.prev));
      const up = ws.filter((x) => x.delta > 0).length; const down = ws.filter((x) => x.delta < 0).length;
      const sameSign = Math.max(up, down);
      const material = Math.abs(m) >= CHANGE_MIN_ORDERS || (base > 0 && Math.abs(m) / base >= CHANGE_MIN_PCT);
      if (material && sameSign >= CHANGE_MIN_DAYS) {
        weeks.push({ weekOf: start, meanDelta: Math.round(m), days: ws.length, direction: m > 0 ? 'raised' : 'cut',
          text: `Uline ${m > 0 ? 'raised' : 'cut'} the week of ${mdLabel(start)} by ~${Math.abs(Math.round(m))}/day` });
      }
    }
  }
  return { overlap, unchanged, meanAbsDelta, maxDelta, weeks };
}

/** True from the 11th when no readable version was received this calendar month. Judged on
 *  `ok` and `sentDate` alone — the status endpoint passes the MASKED list, which carries no
 *  `days`, and judging it with usable() said "missing" from the 11th of every month for ever. */
export function expectedVersionMissing(versions, today) {
  if (!ISO_RE.test(String(today || ''))) return false;
  if (Number(today.slice(8, 10)) < VERSION_DUE_DAY) return false;
  const month = today.slice(0, 7);
  return !(versions || []).some((v) => !!v && v.ok !== false && String(v.sentDate || '').startsWith(month));
}

// ── TONIGHT ───────────────────────────────────────────────────────────────────

/** One line for the dispatcher already on the screen: is tonight's count a lot for this day? */
export function tonightLine({ version, row, shipIso, today, routeDay, davisClosed = null }) {
  const v = version;
  const cov = covers(v, shipIso);
  const est = cov ? estOf(v, shipIso) : null; const upper = cov ? upperOf(v, shipIso) : null;
  const closed = cov ? closedShipDays(v) : new Set();
  const noDelivery = cov ? davisClosedDays(v, davisClosed) : new Map();
  const deliverOn = deliveryDayFor(shipIso, noDelivery);
  const head = `Ship ${dayLabel(shipIso)} → deliver ${deliverOn ? dayLabel(deliverOn) : '—'}`;
  const out = { shipIso, deliverOn, est, upper, actual: null, reportNo: null, status: 'none', tone: 'grey', text: '', head };
  if (isoWeekday(shipIso) === 6) {
    // Saturday: Uline never ships. Not "no forecast" — that is what a short file reads as.
    const sun = shiftIso(shipIso, 1); const sunEst = cov ? estOf(v, sun) : null; const sunUp = cov ? upperOf(v, sun) : null;
    out.status = 'closed'; out.head = `${dayLabel(shipIso)} — Uline does not ship Saturdays`;
    out.text = sunEst != null ? `next: ${dayLabel(sun)} ships → ${dayLabel(deliveryDayFor(sun, noDelivery))} · Uline ${sunEst}${sunUp != null ? ` (high ${sunUp})` : ''}` : 'no reports tonight';
    return out;
  }
  if (!cov || est == null) {
    if (closed.has(shipIso)) { out.status = 'closed'; out.head = dayLabel(shipIso); out.text = noDelivery.has(shipIso) ? `${noDelivery.get(shipIso)} — Uline closed, no reports tonight` : 'Uline closed today — no reports tonight'; }
    else { out.status = 'no_forecast'; out.text = `no Uline forecast for ${mdLabel(shipIso)}`; }
    return out;
  }
  const a = actualFromManifestDay(row, shipIso);
  out.actual = a.actual; out.reportNo = a.reportNo ?? null;
  if (a.status === 'missing') { out.status = 'no_report'; out.text = `Uline ${est}${upper != null ? ` (high ${upper})` : ''} · no report yet tonight — the preliminary usually lands ~10:50am, full reports from 8pm`; return out; }
  if (a.status === 'provisional') { out.status = 'provisional'; out.text = `Uline ${est}${upper != null ? ` (high ${upper})` : ''} · only the preliminary so far (${a.actual}${a.stamp ? ` at ${String(etParts(a.stamp).hour).padStart(2, '0')}:${String(etParts(a.stamp).minute).padStart(2, '0')}` : ''})`; return out; }
  if (a.status !== 'actual') { out.status = a.status; out.text = `Uline ${est} · manifest ${a.actual ?? '—'} — ${a.reason}`; return out; }
  const s = scorePair({ actual: a.actual, est, upper, medianBand: v.medianBand, routeDay });
  out.status = s.verdict; out.err = s.err;
  const stampTxt = a.stamp ? `#${a.reportNo ?? a.reports ?? '?'}, ${String(etParts(a.stamp).hour).padStart(2, '0')}:${String(etParts(a.stamp).minute).padStart(2, '0')}` : `#${a.reportNo ?? '?'}`;
  const rel = s.err === 0 ? 'on the estimate' : `${Math.abs(s.err)} ${s.err > 0 ? 'over' : 'under'} the estimate`;
  if (s.overHigh) { out.tone = 'red'; out.text = `Uline ${est} (high ${upper}) · manifest so far ${a.actual} (${stampTxt}) · OVER ULINE'S HIGH by ${a.actual - upper} — heavy morning`; }
  else { out.tone = s.verdict === 'heavy' ? 'amber' : 'grey'; out.text = `Uline ${est}${upper != null ? ` (high ${upper})` : ''} · manifest so far ${a.actual} (${stampTxt}) · ${rel}${upper != null ? ', under the high' : ''}`; }
  return out;
}

// ── THE ACTUALS, FROM TWO SOURCES ─────────────────────────────────────────────

/** manifest_days wins; uline_actual_days (the historical read-back) fills the rest. A date in
 *  both with a different count is a disagreement — listed, never averaged. */
export function mergeActuals(manifestRows, actualRows) {
  const rows = new Map(); const disagreements = [];
  const dateOf = (r) => { const id = String(r?._id || r?.date || ''); const m = /(\d{4}-\d{2}-\d{2})$/.exec(id); return m ? m[1] : null; };
  for (const r of manifestRows || []) { const d = dateOf(r); if (d && r?.latest) rows.set(d, { source: 'manifest_days', ...r }); }
  for (const r of actualRows || []) {
    const d = dateOf(r); if (!d) continue;
    const shaped = { source: 'uline_actual_days', latest: { orders: r.orders, verified: r.verified, receivedAt: r.receivedAt ?? null, at: r.at ?? null, reportNo: r.reportNo ?? null, mailbox: r.mailbox ?? 'gmail-backfill' }, reportCount: r.reportsSeen ?? null, sawOrderCountFall: false, _id: r._id };
    const have = rows.get(d);
    if (!have) { rows.set(d, shaped); continue; }
    if (Number(have.latest?.orders) !== Number(r.orders)) disagreements.push({ date: d, manifestDays: Number(have.latest?.orders), backfill: Number(r.orders) });
  }
  return { rows, disagreements };
}

// ── THE WHOLE SCREEN ──────────────────────────────────────────────────────────

/**
 * Everything the card shows, computed on read. `versions` are the stored version docs whose
 * range overlaps the window (plus the masked list for the versions panel), `manifestRows` the
 * masked manifest_days docs, `actualRows` the back-filled nights (empty until PR 2).
 */
export function buildView({ versions = [], manifestRows = [], actualRows = [], today, nowMs = null, capacity = null, routeDay = ROUTE_DAY_ORDERS_DEFAULT, windowDays = 60, outlookDays = OUTLOOK_DAYS, davisClosed = null } = {}) {
  const t = ISO_RE.test(String(today || '')) ? today : (nowMs != null ? operatingDayET(nowMs) : null);
  const empty = { ok: true, today: t, latest: null, versions: [], tonight: null, outlook: [], scored: [], unscored: [], pending: [], holes: [], closed: [], unforecast: [], changes: [], pattern: [], stats: { windows: {}, byWeekday: {}, byHorizon: {} }, expectedVersionMissing: false, floor: null, disagreements: [], counts: {}, holidays: [], windowDays, statsDays: STATS_WINDOW_DAYS, note: null };
  if (!t) return { ...empty, note: 'no operating day — nowMs or today is required' };
  const usableVersions = (versions || []).filter(usable).sort((a, b) => Number(a.sentAt) - Number(b.sentAt));
  const latest = latestUsable(usableVersions);
  const { rows, disagreements } = mergeActuals(manifestRows, actualRows);
  const archiveDates = [...rows.keys()].sort();
  const floor = archiveDates[0] ?? null;
  if (!latest) return { ...empty, versions: (versions || []).map(versionSummary), floor, disagreements, note: (versions || []).length ? 'no readable forecast on file yet' : 'no forecast on file yet' };

  // The LISTS cover `windowDays`; the LEDGER behind the figures always reaches back 180 days.
  const lo = shiftIso(t, -windowDays);
  const statsDays = Math.max(Number(windowDays) || 0, STATS_WINDOW_DAYS);
  const loStats = shiftIso(t, -statsDays);
  const scored = []; const unscored = []; const pending = []; const holes = []; const closed = []; const unforecast = [];
  const ladderPairs = [];
  // Start at the later of the ledger's reach and the first day ANY file was in force: a day
  // before a forecast existed is not an "uncovered" night, it is nothing. (The old clamp took
  // the MINIMUM of the two and never clamped — 32 grey "no forecast on file" rows.)
  const inForceFrom = (v) => { const s = ISO_RE.test(String(v.sentDate || '')) ? shiftIso(v.sentDate, 1) : null; return s && s > v.from ? s : v.from; };
  const firstFrom = usableVersions.map(inForceFrom).sort()[0] || null;
  const start = firstFrom && firstFrom > loStats ? firstFrom : loStats;
  for (let d = start; d && d <= t; d = shiftIso(d, 1)) {
    const v = versionInForce(usableVersions, d);
    const row = rows.get(d) || null;
    const c = classifyNight({ shipIso: d, version: v, row, floor, today: t, davisClosed });
    const base = { date: d, dow: dowName(d), status: c.status, est: c.est ?? null, upper: c.upper ?? null, reason: c.reason ?? null, versionId: v?.versionId ?? null, source: row?.source ?? null };
    if (c.status === 'scored') {
      const s = scorePair({ actual: c.actual, est: c.est, upper: c.upper, medianBand: v.medianBand, routeDay });
      const h = horizonDays(v.sentDate, d);
      const ladder = ladderForDate(usableVersions, d).map((l) => ({ ...l, err: c.actual - l.estimate }));
      for (const l of ladder) ladderPairs.push({ date: d, bucket: l.bucket, ...scorePair({ actual: c.actual, est: l.estimate, upper: l.upperEst, medianBand: v.medianBand, routeDay }) });
      scored.push({ ...base, actual: c.actual, reportNo: c.reportNo ?? null, reports: c.reports ?? null, stampFrom: c.stampFrom ?? null, mailbox: c.mailbox ?? null, deliverOn: deliveryDayFor(d, davisClosedDays(v, davisClosed)), horizonDays: h, bucket: horizonBucket(h), ...s, ladder });
    } else if (c.status === 'pending') pending.push({ ...base, deliverOn: c.deliverOn, actual: c.actual ?? null, reportNo: c.reportNo ?? null, inProgress: !!c.inProgress });
    else if (c.status === 'hole') holes.push({ ...base, deliverOn: c.deliverOn });
    else if (c.status === 'closed') closed.push(base);
    else if (c.status === 'unforecast') unforecast.push({ ...base, actual: row?.latest?.orders ?? null });
    else unscored.push({ ...base, actual: row?.latest?.orders ?? null, reports: c.reports ?? null });
  }
  const pairs = scored;
  const windowPairs = (n) => pairs.filter((p) => p.date >= shiftIso(t, -n));
  const bias = weekdayBias(pairs, t);
  const outlook = deliveryOutlook({ version: latest, today: t, days: outlookDays, capacity, bias, davisClosed });
  const prev = usableVersions.filter((v) => v !== latest).sort((a, b) => Number(b.sentAt) - Number(a.sentAt))[0] || null;
  const changes = prev ? diffVersions(prev, latest, t).weeks : [];
  const tonight = tonightLine({ version: latest, row: rows.get(t) || null, shipIso: t, today: t, routeDay, davisClosed });
  const holidays = [...davisClosedDays(latest, davisClosed)].filter(([d]) => d >= t).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 8).map(([date, reason]) => ({ date, dow: dowName(date), reason }));
  const listed = (xs) => xs.filter((x) => x.date >= lo);
  const newestFirst = (a, b) => (a.date < b.date ? 1 : -1);
  const scoredL = listed(scored).sort(newestFirst); const unscoredL = listed(unscored).sort(newestFirst);
  const pendingL = listed(pending); const holesL = listed(holes); const closedL = listed(closed); const unforecastL = listed(unforecast);
  return {
    ok: true, today: t, floor, windowDays, statsDays,
    latest: versionSummary(latest),
    versions: (versions || []).map(versionSummary).sort((a, b) => Number(b.sentAt) - Number(a.sentAt)),
    tonight, outlook, holidays,
    scored: scoredL, unscored: unscoredL,
    pending: pendingL, holes: holesL, closed: closedL, unforecast: unforecastL,
    changes, pattern: patternSentences(pairs),
    stats: { windows: { 30: summarize(windowPairs(30)), 90: summarize(windowPairs(90)), 180: summarize(windowPairs(180)) }, byWeekday: byWeekday(pairs), byHorizon: byHorizon(ladderPairs), bias },
    expectedVersionMissing: expectedVersionMissing(usableVersions, t),
    disagreements,
    counts: { scored: scoredL.length, unscored: unscoredL.length, pending: pendingL.length, holes: holesL.length, closed: closedL.length, unforecast: unforecastL.length, versions: usableVersions.length,
      scoredAll: scored.length, holesAll: holes.length,
      provisionalByDow: DOW.map((_, w) => unscoredL.filter((u) => u.status === 'provisional' && isoWeekday(u.date) === w).length) },
    note: null,
  };
}

/** The version fields the panel lists — never the ~330-key `days` map. */
export function versionSummary(v) {
  if (!v) return null;
  return { versionId: v.versionId ?? null, sentAt: Number(v.sentAt) || null, sentDate: v.sentDate ?? null, ok: v.ok !== false, reason: v.reason ?? null, from: v.from ?? null, to: v.to ?? null, rowsUsed: v.rowsUsed ?? null, rowsTotal: v.rowsTotal ?? null, seen: v.seen ?? null, emailIds: Array.isArray(v.emailIds) ? v.emailIds : [], subject: v.subject ?? null, fileName: v.fileName ?? null, xlsxStored: !!v.xlsxStored, headers: Array.isArray(v.headers) ? v.headers : [], warnings: Array.isArray(v.warnings) ? v.warnings.slice(0, 20) : [], unreadableDates: Array.isArray(v.unreadableDates) ? v.unreadableDates : [], medianBand: v.medianBand ?? null, filedBy: v.filedBy ?? null };
}
