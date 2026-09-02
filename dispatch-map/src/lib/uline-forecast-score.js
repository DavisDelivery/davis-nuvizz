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
// THE FILE IS THE HOLIDAY CALENDAR. expectedDeliveryDate knows nothing about holidays, and
// this repo has no holiday list. It does not need one: a Monday–Friday ship date inside the
// forecast's range with NO row is Uline closed (Labor Day, Thanksgiving, Christmas, New
// Year's, Memorial Day and the July 4th observance are all simply absent from the Aug-2026
// file), and a day Uline does not ship is a day Davis does not deliver. So freight whose
// delivery day lands on a closed day rolls forward: Fri 9/4 and Sun 9/6 both deliver Tue 9/8,
// and Mon 9/7 reads "Uline closed". Without this rule the outlook printed a plan for Labor
// Day and called the day after it light.
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
/** LIGHT when the plan is under 0.8 × the median delivery day across the version — "is this
 *  a day I can give someone a short route". Compared to ALL delivery days, not the same
 *  weekday: every Monday is a Friday ship, so against its own weekday Monday would never
 *  read light, and Monday IS the light day (508 vs 665 → 0.76). */
export const LIGHT_RATIO = 0.8;
export const OUTLOOK_DAYS = 14;
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

/** Mon–Fri ship dates inside the version's range that Uline sent NO row for (or zero): closed
 *  days. A date Uline sent an UNREADABLE row for is not closed — it is unknown. */
export function closedShipDays(version) {
  const closed = new Set();
  if (!usable(version)) return closed;
  const unreadable = new Set(Array.isArray(version.unreadableDates) ? version.unreadableDates : []);
  for (let d = version.from; d <= version.to; d = shiftIso(d, 1)) {
    const w = isoWeekday(d);
    if (w == null || w === 0 || w === 6) continue;
    if (unreadable.has(d)) continue;
    const e = estOf(version, d);
    if (e == null || e === 0) closed.add(d);
  }
  return closed;
}

/** Where freight shipped on `shipIso` delivers, rolling past days Uline is closed. */
export function deliveryDayFor(shipIso, closed) {
  let d = expectedDeliveryDate(shipIso);
  for (let guard = 0; d && closed && closed.has(d) && guard < 8; guard++) d = nextDeliveryDay(d);
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
export function classifyNight({ shipIso, version, row, floor, today }) {
  const v = version;
  const cov = covers(v, shipIso);
  const unreadable = cov && Array.isArray(v.unreadableDates) && v.unreadableDates.includes(shipIso);
  const est = cov ? estOf(v, shipIso) : null;
  const upper = cov ? upperOf(v, shipIso) : null;
  const has = !!row?.latest;
  if (!cov) return { status: 'uncovered', est: null, upper: null, reason: v ? `the forecast in force (${v.sentDate}) runs ${v.from} to ${v.to}` : 'no forecast on file for this date' };
  if (unreadable) return { status: 'unreadable', est: null, upper: null, reason: `the ${v.sentDate} file carried a row for this day that could not be read` };
  if (has) {
    if (est == null || est === 0) return { status: 'unforecast', est: est ?? null, upper, reason: 'Uline shipped, nothing was forecast for this day' };
    const a = actualFromManifestDay(row, shipIso);
    return { status: a.status === 'actual' ? 'scored' : a.status, est, upper, actual: a.actual, reportNo: a.reportNo, reports: a.reports, stamp: a.stamp ?? null, stampFrom: a.stampFrom ?? null, mailbox: a.mailbox ?? null, reason: a.reason };
  }
  if (est == null || est === 0) return { status: 'closed', est: 0, upper: null, reason: isoWeekday(shipIso) === 6 ? 'Saturday — Uline does not ship' : 'Uline closed' };
  const deliverOn = deliveryDayFor(shipIso, closedShipDays(v));
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
export function deliveryOutlook({ version, today, days = OUTLOOK_DAYS, capacity = null, bias = null, unreadableDates = null }) {
  if (!usable(version) || !ISO_RE.test(String(today || ''))) return [];
  const closed = closedShipDays(version);
  const unreadable = new Set(Array.isArray(unreadableDates) ? unreadableDates : (Array.isArray(version.unreadableDates) ? version.unreadableDates : []));
  const groups = new Map();   // deliverOn -> { ships, closedShips, unreadableShips }
  const g = (d) => { if (!groups.has(d)) groups.set(d, { ships: [], closedShips: [], unreadableShips: [] }); return groups.get(d); };
  const last = shiftIso(today, days + 3);
  for (let d = shiftIso(today, -7); d && d <= last; d = shiftIso(d, 1)) {
    const w = isoWeekday(d);
    if (w === 6) continue;                           // Uline never ships Saturday
    const deliverOn = deliveryDayFor(d, closed);
    if (!deliverOn) continue;
    if (unreadable.has(d) && covers(version, d)) { g(deliverOn).unreadableShips.push(d); continue; }
    if (closed.has(d)) { g(deliverOn).closedShips.push(d); continue; }
    const e = estOf(version, d);
    if (e == null) continue;
    g(deliverOn).ships.push({ date: d, dow: DOW[w], est: e, upper: upperOf(version, d) });
  }
  // The typical delivery day across the whole version, for LIGHT.
  const totals = [];
  {
    const byDay = new Map();
    for (let d = version.from; d <= version.to; d = shiftIso(d, 1)) {
      if (isoWeekday(d) === 6 || closed.has(d)) continue;
      const e = estOf(version, d); if (e == null) continue;
      const k = deliveryDayFor(d, closed); if (!k) continue;
      byDay.set(k, (byDay.get(k) || 0) + e);
    }
    totals.push(...byDay.values());
  }
  const typical = median(totals);
  const cap = Number.isFinite(Number(capacity)) && Number(capacity) > 0 ? Number(capacity) : null;

  const rows = [];
  for (let d = shiftIso(today, 1); d && rows.length < days; d = shiftIso(d, 1)) {
    if (!isDeliveryDay(d)) continue;
    const w = isoWeekday(d);
    const row = { deliverOn: d, dow: DOW[w], label: dayLabel(d), ships: [], est: null, upper: null, plan: null, adjusted: false, adjustedBy: 0, chips: [], notes: [], status: 'ok' };
    if (closed.has(d)) { row.status = 'closed'; row.notes.push('Uline closed — no deliveries'); rows.push(row); continue; }
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
    if (grp.closedShips.length) row.notes.push(`Uline closed ${grp.closedShips.map(mdLabel).join(', ')} — rolled into this day`);
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
      if (typical != null && row.plan < LIGHT_RATIO * typical) row.chips.push('LIGHT');
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

/** True from the 11th when no usable version was received this calendar month. */
export function expectedVersionMissing(versions, today) {
  if (!ISO_RE.test(String(today || ''))) return false;
  if (Number(today.slice(8, 10)) < VERSION_DUE_DAY) return false;
  const month = today.slice(0, 7);
  return !(versions || []).some((v) => usable(v) && String(v.sentDate || '').startsWith(month));
}

// ── TONIGHT ───────────────────────────────────────────────────────────────────

/** One line for the dispatcher already on the screen: is tonight's count a lot for this day? */
export function tonightLine({ version, row, shipIso, today, routeDay }) {
  const v = version;
  const cov = covers(v, shipIso);
  const est = cov ? estOf(v, shipIso) : null; const upper = cov ? upperOf(v, shipIso) : null;
  const closed = cov ? closedShipDays(v) : new Set();
  const deliverOn = deliveryDayFor(shipIso, closed);
  const head = `Ship ${dayLabel(shipIso)} → deliver ${deliverOn ? dayLabel(deliverOn) : '—'}`;
  const out = { shipIso, deliverOn, est, upper, actual: null, reportNo: null, status: 'none', tone: 'grey', text: '', head };
  if (!cov || est == null) { out.status = closed.has(shipIso) ? 'closed' : 'no_forecast'; out.text = closed.has(shipIso) ? 'Uline closed today' : `no Uline forecast for ${mdLabel(shipIso)}`; return out; }
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
export function buildView({ versions = [], manifestRows = [], actualRows = [], today, nowMs = null, capacity = null, routeDay = ROUTE_DAY_ORDERS_DEFAULT, windowDays = 60, outlookDays = OUTLOOK_DAYS } = {}) {
  const t = ISO_RE.test(String(today || '')) ? today : (nowMs != null ? operatingDayET(nowMs) : null);
  const empty = { ok: true, today: t, latest: null, versions: [], tonight: null, outlook: [], scored: [], unscored: [], pending: [], holes: [], closed: [], unforecast: [], changes: [], pattern: [], stats: { windows: {}, byWeekday: {}, byHorizon: {} }, expectedVersionMissing: false, floor: null, disagreements: [], counts: {}, note: null };
  if (!t) return { ...empty, note: 'no operating day — nowMs or today is required' };
  const usableVersions = (versions || []).filter(usable).sort((a, b) => Number(a.sentAt) - Number(b.sentAt));
  const latest = latestUsable(usableVersions);
  const { rows, disagreements } = mergeActuals(manifestRows, actualRows);
  const archiveDates = [...rows.keys()].sort();
  const floor = archiveDates[0] ?? null;
  if (!latest) return { ...empty, versions: (versions || []).map(versionSummary), floor, disagreements, note: (versions || []).length ? 'no readable forecast on file yet' : 'no forecast on file yet' };

  const lo = shiftIso(t, -windowDays);
  const scored = []; const unscored = []; const pending = []; const holes = []; const closed = []; const unforecast = [];
  const ladderPairs = [];
  const firstDate = [lo, ...usableVersions.map((v) => v.from)].sort()[0];
  for (let d = lo < firstDate ? firstDate : lo; d && d <= t; d = shiftIso(d, 1)) {
    const v = versionInForce(usableVersions, d);
    const row = rows.get(d) || null;
    const c = classifyNight({ shipIso: d, version: v, row, floor, today: t });
    const base = { date: d, dow: dowName(d), status: c.status, est: c.est ?? null, upper: c.upper ?? null, reason: c.reason ?? null, versionId: v?.versionId ?? null, source: row?.source ?? null };
    if (c.status === 'scored') {
      const s = scorePair({ actual: c.actual, est: c.est, upper: c.upper, medianBand: v.medianBand, routeDay });
      const h = horizonDays(v.sentDate, d);
      const ladder = ladderForDate(usableVersions, d).map((l) => ({ ...l, err: c.actual - l.estimate }));
      for (const l of ladder) ladderPairs.push({ date: d, bucket: l.bucket, ...scorePair({ actual: c.actual, est: l.estimate, upper: l.upperEst, medianBand: v.medianBand, routeDay }) });
      scored.push({ ...base, actual: c.actual, reportNo: c.reportNo ?? null, reports: c.reports ?? null, stampFrom: c.stampFrom ?? null, mailbox: c.mailbox ?? null, deliverOn: deliveryDayFor(d, closedShipDays(v)), horizonDays: h, bucket: horizonBucket(h), ...s, ladder });
    } else if (c.status === 'pending') pending.push({ ...base, deliverOn: c.deliverOn });
    else if (c.status === 'hole') holes.push({ ...base, deliverOn: c.deliverOn });
    else if (c.status === 'closed') closed.push(base);
    else if (c.status === 'unforecast') unforecast.push({ ...base, actual: row?.latest?.orders ?? null });
    else unscored.push({ ...base, actual: row?.latest?.orders ?? null, reports: c.reports ?? null });
  }
  const pairs = scored;
  const windowPairs = (n) => pairs.filter((p) => p.date >= shiftIso(t, -n));
  const bias = weekdayBias(pairs, t);
  const outlook = deliveryOutlook({ version: latest, today: t, days: outlookDays, capacity, bias });
  const prev = usableVersions.filter((v) => v !== latest).sort((a, b) => Number(b.sentAt) - Number(a.sentAt))[0] || null;
  const changes = prev ? diffVersions(prev, latest, t).weeks : [];
  const tonight = tonightLine({ version: latest, row: rows.get(t) || null, shipIso: t, today: t, routeDay });
  return {
    ok: true, today: t, floor,
    latest: versionSummary(latest),
    versions: (versions || []).map(versionSummary).sort((a, b) => Number(b.sentAt) - Number(a.sentAt)),
    tonight, outlook,
    scored: scored.sort((a, b) => (a.date < b.date ? 1 : -1)),
    unscored: unscored.sort((a, b) => (a.date < b.date ? 1 : -1)),
    pending, holes, closed, unforecast,
    changes, pattern: patternSentences(pairs),
    stats: { windows: { 30: summarize(windowPairs(30)), 90: summarize(windowPairs(90)), 180: summarize(windowPairs(180)) }, byWeekday: byWeekday(pairs), byHorizon: byHorizon(ladderPairs), bias },
    expectedVersionMissing: expectedVersionMissing(usableVersions, t),
    disagreements,
    counts: { scored: scored.length, unscored: unscored.length, pending: pending.length, holes: holes.length, closed: closed.length, unforecast: unforecast.length, versions: usableVersions.length,
      provisionalByDow: DOW.map((_, w) => unscored.filter((u) => u.status === 'provisional' && isoWeekday(u.date) === w).length) },
    note: null,
  };
}

/** The version fields the panel lists — never the ~330-key `days` map. */
export function versionSummary(v) {
  if (!v) return null;
  return { versionId: v.versionId ?? null, sentAt: Number(v.sentAt) || null, sentDate: v.sentDate ?? null, ok: v.ok !== false, reason: v.reason ?? null, from: v.from ?? null, to: v.to ?? null, rowsUsed: v.rowsUsed ?? null, rowsTotal: v.rowsTotal ?? null, seen: v.seen ?? null, emailIds: Array.isArray(v.emailIds) ? v.emailIds : [], subject: v.subject ?? null, fileName: v.fileName ?? null, xlsxStored: !!v.xlsxStored, headers: Array.isArray(v.headers) ? v.headers : [], warnings: Array.isArray(v.warnings) ? v.warnings.slice(0, 20) : [], unreadableDates: Array.isArray(v.unreadableDates) ? v.unreadableDates : [], medianBand: v.medianBand ?? null, filedBy: v.filedBy ?? null };
}
