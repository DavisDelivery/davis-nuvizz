// src/lib/stop-pace.js — THE PERFORMANCE SCREEN'S ARITHMETIC (PURE).
//
// Chad, 2026-09-30: "track performance over days, weeks, months … and also … interday to track
// the number of stops that we've done compared to other days or like the daily average at that
// point in time to let us know if we're behind or ahead of schedule."
//
// The server hands over three things (netlify/functions/stop-performance.mts): a summary per day,
// the recent days' 5-minute delivery curves, and today's board run through the same builder.
// Everything the screen then DECIDES — which days make the typical day, where the band sits at
// 11:15, whether today is ahead or behind, what a week or a month adds up to — is decided here,
// so it is tested here (test/stop-pace-view.test.mjs), and the screen only draws it.
//
// ── THREE JUDGEMENTS, SAID OUT LOUD BECAUSE A NUMBER HIDES THEM ────────────────────────────
//
// 1. "BEHIND" MEANS BELOW THE TYPICAL RANGE, NOT BELOW THE AVERAGE. Half of all normal days are
//    below their own median by definition; a signal that fires whenever today is one stop under
//    the middle day fires on half of all good days, and a dispatcher stops reading it by Friday.
//    Behind is below the 25th percentile of the comparison days at that minute; ahead is above
//    the 75th. The middle half is "on pace", and the chart draws that band so the reader sees the
//    same line the status is judged against.
//
// 2. THE TYPICAL DAY IS THE SAME WEEKDAY BY DEFAULT. Weekdays need not look alike — how far
//    apart Davis's are is what the screen's "Delivered by weekday" card shows — and against a
//    plain average of all days a heavy weekday would read "ahead" all morning and a light one
//    "behind", which says nothing about the drivers.
//    Recent weekdays is one tap away in Filters — for the week after a holiday, when there are
//    too few of one weekday to make a band.
//
// 3. A DAY THAT CANNOT BE PLACED ON THE CLOCK DOES NOT VOTE. A day whose deliveries mostly carry
//    no time (untimed) has a curve that stops short of what happened; mixed into the median it
//    drags the typical line down and makes an ordinary morning look ahead. It is left out of the
//    typical day and named on screen, never quietly averaged in.
//
// NO CLOCK AND NO NETWORK IN THIS FILE: "now" and "today" are arguments.

import { weekOf, weekLabel } from './load-lookup.js';
import { completionPct } from './completion-pct.js';

export const BUCKET_MIN = 5;
export const BUCKETS = (24 * 60) / BUCKET_MIN;
/** A band drawn from fewer days than this is a guess with error bars; the screen says so instead. */
export const MIN_BASELINE_DAYS = 4;
/** A day counts toward the typical curve only when at least this share of its deliveries carries a time. */
export const MIN_TIMED_SHARE = 0.9;

export const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => typeof v === 'string' && DAY_RE.test(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── dates ────────────────────────────────────────────────────────────────────

/** YYYY-MM-DD plus n calendar days. Noon UTC, so no offset can move the day. */
export function addDays(day, n) {
  if (!isDay(day)) return null;
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/** Inclusive count of calendar days, so one day is 1. */
export function daySpan(from, to) {
  if (!isDay(from) || !isDay(to)) return 0;
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function weekdayOf(day) {
  if (!isDay(day)) return null;
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** "Tue Sep 29", or "Tue Sep 29, 2025" when the year is not `refDay`'s. */
export function dayLabel(day, refDay = null) {
  if (!isDay(day)) return '';
  const wd = WEEKDAY_SHORT[weekdayOf(day)];
  const base = `${wd} ${MONTH_SHORT[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
  return refDay && isDay(refDay) && refDay.slice(0, 4) !== day.slice(0, 4) ? `${base}, ${day.slice(0, 4)}` : base;
}

/** "Sep 2026". */
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? `${MONTH_SHORT[Number(m[2]) - 1]} ${m[1]}` : '';
}

function lastOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
}

/**
 * THE DATE-RANGE PRESETS. Each ends TODAY — a range that is still running includes the day being
 * worked, drawn as "so far" — and the custom range is whatever the two boxes say, earlier first.
 */
export const RANGE_PRESETS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'mtd', label: 'Month to date' },
  { id: 'ytd', label: 'Year to date' },
];

export function presetRange(id, today, custom = {}) {
  if (!isDay(today)) return null;
  switch (id) {
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case '90d': return { from: addDays(today, -89), to: today };
    case 'mtd': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'ytd': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom': {
      const a = custom?.from; const b = custom?.to;
      if (!isDay(a) || !isDay(b)) return null;
      const lo = a <= b ? a : b; const hi = a <= b ? b : a;
      return { from: lo, to: hi > today ? today : hi };
    }
    default: return null;
  }
}

/** The period of the same length immediately before [from, to] — what a % change compares with. */
export function previousRange(from, to) {
  const len = daySpan(from, to);
  if (!len) return null;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(len - 1)), to: prevTo };
}

/** "Sep 1 – 30", "Aug 31 – Sep 29", "Dec 29, 2025 – Jan 4". */
export function rangeLabel(from, to) {
  if (!isDay(from) || !isDay(to)) return '';
  const md = (d) => `${MONTH_SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  if (from === to) return md(from);
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${md(from)} – ${Number(to.slice(8, 10))}`;
  return `${md(from)} – ${md(to)}`;
}

// ── the clock ────────────────────────────────────────────────────────────────

/** Minute of the day as the app writes it everywhere else: "9:05a", "12:30p". "—" for nothing. */
export function fmtClock(m) {
  const v = num(m);
  if (v == null) return '—';
  const r = Math.round(v);
  const h = Math.floor(r / 60), x = ((r % 60) + 60) % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(x).padStart(2, '0')}${h >= 12 ? 'p' : 'a'}`;
}

/**
 * The last WHOLE bucket at or before `minute`. Today at 11:14 with a scan at 11:10 is compared
 * through 11:09 — the bucket that holds 11:10–11:14 is not finished, and counting a half-filled
 * bucket against full ones would read as falling behind at every scan.
 */
export function compareBucket(minute) {
  const m = num(minute);
  if (m == null) return null;
  return Math.min(BUCKETS - 1, Math.floor((m + 1) / BUCKET_MIN) - 1);
}

/** The minute a bucket closes on: bucket 131 is 10:55–10:59, so "by 10:59". */
export const bucketEndMinute = (b) => b * BUCKET_MIN + (BUCKET_MIN - 1);

// ── curves ───────────────────────────────────────────────────────────────────

/** Running total of a per-bucket curve. A malformed curve is all zeros, never a throw. */
export function cumulative(curve) {
  const out = new Array(BUCKETS).fill(0);
  if (!Array.isArray(curve)) return out;
  let run = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const v = Number(curve[b]);
    run += Number.isFinite(v) && v > 0 ? v : 0;
    out[b] = run;
  }
  return out;
}

/** Linear-interpolated quantile of an ASCENDING list (Excel's PERCENTILE.INC). */
export function quantile(sorted, q) {
  const n = Array.isArray(sorted) ? sorted.length : 0;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h); const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/**
 * WHICH DAYS MAKE THE TYPICAL DAY. Newest first, before today, weekdays only, and — in the default
 * mode — the same weekday as today. A day Chad left out, a day with no curve, a day with nothing
 * delivered and a day whose deliveries mostly carry no time are skipped AND RETURNED, so the
 * screen can name what was left out rather than quietly drawing a band from fewer days.
 */
export function chooseBaseline(pool, { today, weekday, mode = 'weekday', size, excluded, minTimedShare = MIN_TIMED_SHARE } = {}) {
  const want = Math.max(1, Math.floor(Number(size) || (mode === 'weekday' ? 8 : 20)));
  const left = excluded instanceof Set ? excluded : new Set(excluded || []);
  const days = [];
  const skipped = [];
  const sorted = (Array.isArray(pool) ? pool : [])
    .filter((d) => d && isDay(d.date) && (!isDay(today) || d.date < today))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const d of sorted) {
    if (days.length >= want) break;
    const wd = num(d.weekday) ?? weekdayOf(d.date);
    if (!(wd >= 1 && wd <= 5)) continue;
    if (mode === 'weekday' && wd !== weekday) continue;
    if (left.has(d.date)) { skipped.push({ date: d.date, reason: 'left-out' }); continue; }
    if (!Array.isArray(d.curve) || d.curve.length !== BUCKETS) { skipped.push({ date: d.date, reason: 'no-curve' }); continue; }
    const delivered = num(d.delivered) ?? 0;
    if (delivered <= 0) { skipped.push({ date: d.date, reason: 'nothing-delivered' }); continue; }
    const share = (num(d.timed) ?? 0) / delivered;
    if (share < minTimedShare) { skipped.push({ date: d.date, reason: 'untimed', share }); continue; }
    days.push(d);
  }
  return { days, skipped, mode, size: want };
}

/**
 * THE BAND. For every bucket: the 25th percentile, the median and the 75th percentile of the
 * chosen days' running totals — or, with `share`, of each day's running total as a fraction of
 * that day's own board, which is what makes a 900-stop Monday and a 600-stop Friday comparable.
 */
export function baselineBands(days, { share = false } = {}) {
  const list = Array.isArray(days) ? days : [];
  const median = new Array(BUCKETS).fill(null);
  const p25 = new Array(BUCKETS).fill(null);
  const p75 = new Array(BUCKETS).fill(null);
  const cums = list.map((d) => ({ cum: cumulative(d.curve), gradable: num(d.gradable) }));
  if (!cums.length) return { n: 0, median, p25, p75 };
  for (let b = 0; b < BUCKETS; b++) {
    const vals = [];
    for (const c of cums) {
      const v = share ? (c.gradable > 0 ? c.cum[b] / c.gradable : null) : c.cum[b];
      if (v != null && Number.isFinite(v)) vals.push(v);
    }
    vals.sort((x, y) => x - y);
    median[b] = quantile(vals, 0.5);
    p25[b] = quantile(vals, 0.25);
    p75[b] = quantile(vals, 0.75);
  }
  return { n: cums.length, median, p25, p75 };
}

/**
 * TODAY AGAINST THE BAND, at the minute today's board actually knows up to.
 *
 *   `asOfMinute` — the last scan dated today (the server works it out). Preferred: see
 *                  compareBucket and lib/stop-pace.mts boardAsOfMinute for why the wall clock is
 *                  the wrong minute.
 *   `nowMinute`  — the wall clock, used only when no scan has landed today.
 *   `measure`    — 'stops' judges the running count; 'share' judges the share of today's board.
 *
 * Returns the numbers the hero reads AND the status, or a status that says why there is none:
 * 'no-board' (nothing planned today), 'insufficient' (too few comparison days), 'not-started'
 * (before a typical day's first delivery). None of those is a verdict about the day.
 */
export function paceNow(live, bands, { asOfMinute = null, nowMinute = null, measure = 'stops', shareBands = null, minDays = MIN_BASELINE_DAYS } = {}) {
  if (!live || !Array.isArray(live.curve)) return { status: 'no-board' };
  const minute = num(asOfMinute) ?? num(nowMinute);
  if (minute == null) return { status: 'no-clock' };
  const bucket = compareBucket(minute);
  const cum = cumulative(live.curve);
  const count = bucket >= 0 ? cum[bucket] : 0;
  const gradable = num(live.gradable);
  const share = gradable > 0 ? count / gradable : null;
  const n = bands?.n ?? 0;
  const base = {
    minute, bucket, count, share, gradable, n,
    atMinute: bucket >= 0 ? bucketEndMinute(bucket) : null,
    fromScan: num(asOfMinute) != null,
  };
  if (n < minDays) return { ...base, status: 'insufficient' };
  if (bucket < 0) return { ...base, status: 'not-started' };

  const med = bands.median[bucket];
  const lo = bands.p25[bucket];
  const hi = bands.p75[bucket];
  const sMed = shareBands?.median?.[bucket] ?? null;
  const sLo = shareBands?.p25?.[bucket] ?? null;
  const sHi = shareBands?.p75?.[bucket] ?? null;
  const out = {
    ...base,
    median: med, p25: lo, p75: hi,
    delta: med == null ? null : count - med,
    deltaPct: med > 0 ? (count - med) / med : null,
    shareMedian: sMed, shareP25: sLo, shareP75: sHi,
    shareDelta: share != null && sMed != null ? share - sMed : null,
  };
  // Before a typical day has delivered anything, there is nothing to be behind.
  if ((med ?? 0) <= 0 && count <= 0) return { ...out, status: 'not-started' };
  const [v, l, h] = measure === 'share' ? [share, sLo, sHi] : [count, lo, hi];
  if (v == null || l == null || h == null) return { ...out, status: 'insufficient' };
  return { ...out, status: v < l ? 'behind' : v > h ? 'ahead' : 'on-pace' };
}

export const PACE_STATUS_LABEL = {
  ahead: 'Ahead',
  'on-pace': 'On pace',
  behind: 'Behind',
  'not-started': 'Not started',
  insufficient: 'Not enough history',
  'no-board': 'No board today',
  'no-clock': 'No clock',
};

// ── periods ──────────────────────────────────────────────────────────────────

const countOf = (d, k) => num(d?.counts?.[k]) ?? 0;

/**
 * Totals over a set of day summaries. CLOSED DAYS ONLY — today's board is still being worked,
 * and folding a half-finished day into an average drags the average down by exactly how early
 * in the day it is. The caller filters; this adds.
 */
export function periodTotals(days) {
  const t = { days: 0, planned: 0, gradable: 0, delivered: 0, manual: 0, unable: 0, open: 0, cancelled: 0 };
  for (const d of Array.isArray(days) ? days : []) {
    t.days += 1;
    t.planned += num(d.planned) ?? 0;
    t.gradable += num(d.gradable) ?? 0;
    t.delivered += num(d.delivered) ?? 0;
    t.manual += countOf(d, 'delivered_manual');
    t.unable += countOf(d, 'unable');
    t.open += num(d.open) ?? 0;
    t.cancelled += countOf(d, 'cancelled');
  }
  return {
    ...t,
    perDay: t.days ? t.delivered / t.days : null,
    completionRate: t.gradable ? t.delivered / t.gradable : null,
    manualRate: t.delivered ? t.manual / t.delivered : null,
  };
}

/** Relative change, or null when there is nothing to change from. */
export function pctChange(cur, prev) {
  const c = num(cur); const p = num(prev);
  if (c == null || p == null || p === 0) return null;
  return (c - p) / p;
}

/**
 * THE TREND'S BARS — a day, a Monday-to-Sunday week (load-lookup's weekOf, so "this week" means
 * the same thing here as on Stop lookup) or a calendar month.
 *
 * `partial` marks a period that is still running (it holds today, or ends after it) and `gaps`
 * counts days inside it that the warehouse sealed but no digest has been built for yet. Both
 * are DRAWN, not hidden: a half-finished week drawn like a finished one reads as a crash, and a
 * week missing two days reads as a slow week.
 */
export function aggregateDays(days, granularity = 'day', { today = null, missing = [] } = {}) {
  const gapsOn = new Set(Array.isArray(missing) ? missing : []);
  const buckets = new Map();
  const keyOf = (date) => {
    if (granularity === 'week') { const w = weekOf(date); return { key: w.from, from: w.from, to: w.to, label: weekLabel(w) }; }
    if (granularity === 'month') { const ym = date.slice(0, 7); return { key: ym, from: `${ym}-01`, to: lastOfMonth(ym), label: monthLabel(ym) }; }
    return { key: date, from: date, to: date, label: dayLabel(date) };
  };
  for (const d of Array.isArray(days) ? days : []) {
    if (!d || !isDay(d.date)) continue;
    const k = keyOf(d.date);
    let b = buckets.get(k.key);
    if (!b) { b = { ...k, days: [], live: false }; buckets.set(k.key, b); }
    b.days.push(d);
    if (d.source === 'live') b.live = true;
  }
  for (const date of gapsOn) {
    if (!isDay(date)) continue;
    const k = keyOf(date);
    if (!buckets.has(k.key)) buckets.set(k.key, { ...k, days: [], live: false });
  }
  const out = [];
  for (const b of buckets.values()) {
    const closed = b.days.filter((d) => d.source !== 'live');
    const tot = periodTotals(b.days);
    const closedTot = periodTotals(closed);
    let gaps = 0;
    for (const g of gapsOn) if (g >= b.from && g <= b.to) gaps += 1;
    out.push({
      key: b.key, label: b.label, from: b.from, to: b.to,
      delivered: tot.delivered, gradable: tot.gradable, planned: tot.planned,
      unable: tot.unable, open: tot.open, manual: tot.manual,
      days: tot.days,
      // An AVERAGE uses closed days only; the total says what happened, today's share included.
      perDay: closedTot.perDay,
      completionRate: closedTot.completionRate,
      partial: b.live || (isDay(today) && b.to >= today),
      gaps,
      firstMin: b.days.length === 1 ? num(b.days[0].firstMin) : null,
      halfMin: b.days.length === 1 ? num(b.days[0].halfMin) : null,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Trailing moving average over `window` points; null until the window is full or where a value is. */
export function movingAverage(values, window = 5) {
  const w = Math.max(1, Math.floor(window));
  const out = new Array(values.length).fill(null);
  for (let i = w - 1; i < values.length; i++) {
    let s = 0; let ok = true;
    for (let j = i - w + 1; j <= i; j++) { const v = num(values[j]); if (v == null) { ok = false; break; } s += v; }
    if (ok) out[i] = s / w;
  }
  return out;
}

// ── categories ───────────────────────────────────────────────────────────────

/**
 * WHERE THE PERIOD'S PLANNED STOPS ENDED UP, as the 6:30 report sorts them. Cancelled is not in
 * the denominator (the day did not fail to deliver an order that was pulled) and is returned on
 * the side, so it can be said without being drawn as a share of the work.
 */
export function outcomeMix(days) {
  const t = periodTotals(days);
  const scan = t.delivered - t.manual;
  const rows = [
    { key: 'scan', label: 'Delivered, scanned', count: scan, status: 'good' },
    { key: 'hand', label: 'Delivered, closed by hand', count: t.manual, status: 'good' },
    { key: 'open', label: 'Still open at day’s end', count: t.open, status: 'warning' },
    { key: 'unable', label: 'Unable to deliver', count: t.unable, status: 'critical' },
  ];
  const whole = rows.reduce((a, r) => a + r.count, 0);
  return {
    rows: rows.map((r) => ({ ...r, share: whole ? r.count / whole : null })),
    whole,
    cancelled: t.cancelled,
    // The four rows are the gradable stops, and they should add to it. When they do not (a stop
    // closed on a later board sits in neither), the difference is returned rather than hidden.
    unaccounted: t.gradable - whole,
  };
}

/** Average delivered per weekday, Monday to Friday, over closed days — and how many days each is from. */
export function weekdayProfile(days) {
  const acc = new Map([1, 2, 3, 4, 5].map((w) => [w, { weekday: w, label: WEEKDAY_SHORT[w], total: 0, n: 0 }]));
  for (const d of Array.isArray(days) ? days : []) {
    if (!d || d.source === 'live') continue;
    const w = num(d.weekday) ?? weekdayOf(d.date);
    const a = acc.get(w);
    if (!a) continue;
    a.total += num(d.delivered) ?? 0;
    a.n += 1;
  }
  return [...acc.values()].map((a) => ({ ...a, avg: a.n ? a.total / a.n : null }));
}

// ── the table ────────────────────────────────────────────────────────────────

/**
 * One row per day for the Days table. `vsLastWeek` compares with the SAME WEEKDAY seven days
 * earlier — the like-for-like change a dispatcher reads, not yesterday (a Monday against the
 * Friday before it is a comparison between two different kinds of day).
 */
export function dayRows(days, { excluded, today = null } = {}) {
  const left = excluded instanceof Set ? excluded : new Set(excluded || []);
  const byDate = new Map((Array.isArray(days) ? days : []).filter((d) => d && isDay(d.date)).map((d) => [d.date, d]));
  return [...byDate.values()].map((d) => {
    const prev = byDate.get(addDays(d.date, -7));
    const live = d.source === 'live';
    return {
      id: d.date,
      date: d.date,
      label: dayLabel(d.date, today),
      weekday: num(d.weekday) ?? weekdayOf(d.date),
      planned: num(d.gradable),
      delivered: num(d.delivered),
      completionRate: num(d.completionRate),
      manual: countOf(d, 'delivered_manual'),
      unable: countOf(d, 'unable'),
      open: num(d.open),
      firstMin: num(d.firstMin),
      halfMin: num(d.halfMin),
      lastMin: num(d.lastMin),
      untimed: num(d.untimed) ?? 0,
      vsLastWeek: live || !prev || prev.source === 'live' ? null : pctChange(d.delivered, prev.delivered),
      live,
      leftOut: left.has(d.date),
    };
  });
}

/**
 * One row per route for a day. `perHour` is deliveries per hour BETWEEN THE ROUTE'S FIRST AND
 * LAST DELIVERY — the drive out and back is not in it, and the screen says so — and only when
 * there are at least three deliveries over at least half an hour, because two stamps ten minutes
 * apart make a "rate" of 12 an hour out of nothing. `vsFleet` is the route's share done against
 * the whole board's, in points: a route at 20% when the fleet is at 60% is the phone call.
 */
export function routeRows(digest, { fleetShare = null } = {}) {
  const routes = Array.isArray(digest?.routes) ? digest.routes : [];
  return routes.map((r) => {
    const gradable = (num(r.planned) ?? 0) - (num(r.cancelled) ?? 0);
    const share = gradable > 0 ? (num(r.delivered) ?? 0) / gradable : null;
    const span = num(r.firstMin) != null && num(r.lastMin) != null ? r.lastMin - r.firstMin : null;
    const perHour = (num(r.delivered) ?? 0) >= 3 && span != null && span >= 30 ? ((r.delivered - 1) / span) * 60 : null;
    return {
      id: r.route,
      route: r.route,
      driver: r.driver || null,
      planned: gradable,
      delivered: num(r.delivered) ?? 0,
      manual: num(r.manual) ?? 0,
      open: num(r.open) ?? 0,
      inFlight: num(r.inFlight) ?? 0,
      unable: num(r.unable) ?? 0,
      share,
      firstMin: num(r.firstMin),
      lastMin: num(r.lastMin),
      perHour,
      vsFleet: share != null && num(fleetShare) != null ? share - fleetShare : null,
    };
  });
}

/** Case-insensitive match of every word of `q` against the named fields. Empty query matches all. */
export function searchRows(rows, q, fields) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = fields.map((f) => String(r[f] ?? '')).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Stable sort on one key. Nulls sit LAST in both directions — a blank is never the top value. */
export function sortRows(rows, key, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = a.r[key]; const y = b.r[key];
      const xn = x == null || (typeof x === 'number' && !Number.isFinite(x));
      const yn = y == null || (typeof y === 'number' && !Number.isFinite(y));
      if (xn && yn) return a.i - b.i;
      if (xn) return 1;
      if (yn) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.r);
}

/** One page of rows, and the numbers the footer prints. Page is clamped, never out of range. */
export function paginate(rows, page, pageSize) {
  const total = Array.isArray(rows) ? rows.length : 0;
  const size = Math.max(1, Math.floor(Number(pageSize) || 25));
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)));
  const start = (p - 1) * size;
  return { rows: total ? rows.slice(start, start + size) : [], page: p, pages, total, size, first: total ? start + 1 : 0, last: Math.min(total, start + size) };
}

// ── words and numbers ────────────────────────────────────────────────────────

/** 1,284 · 12.9K. Integers stay whole below ten thousand. */
export function fmtCount(v) {
  const n = num(v);
  if (n == null) return '—';
  if (Math.abs(n) >= 10000) return `${(n / 1000).toFixed(Math.abs(n) >= 100000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** A share as a whole percent that cannot claim 100% or 0% unless it is (completion-pct.js). */
export function fmtShare(v) {
  const p = completionPct(num(v));
  return p == null ? '—' : `${p}%`;
}

/** +12 / −3 / 0, with a real minus sign. */
export function fmtSigned(v, digits = 0) {
  const n = num(v);
  if (n == null) return '—';
  const r = Number(n.toFixed(digits));
  if (r === 0) return digits ? (0).toFixed(digits) : '0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** +4.2% / −11.7% — a CHANGE, so unlike fmtShare it may be any size and carries its sign. */
export function fmtPctChange(v, digits = 1) {
  const n = num(v);
  if (n == null) return '—';
  const r = n * 100;
  if (Math.abs(r) < 0.05) return '0%';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}%`;
}

/** Points between two shares: "+2.1 pts". */
export function fmtPoints(v, digits = 1) {
  const n = num(v);
  if (n == null) return '—';
  const r = n * 100;
  if (Math.abs(r) < 0.05) return '0 pts';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)} pts`;
}

/** Days left out of the typical day, remembered per device. Anything unreadable is "none left out". */
export function parseLeftOut(raw) {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return new Set(Array.isArray(v) ? v.filter(isDay) : []);
  } catch {
    return new Set();
  }
}

// ── the screen's words ───────────────────────────────────────────────────────

/**
 * TODAY'S VERDICT IN WORDS — the sentence Chad asked the screen for ("to let us know if we're
 * behind or ahead of schedule") and the four numbers it stands on. Both views say the same words
 * and lay them out their own way.
 *
 * `facts` is null whenever there is no verdict to stand on, and `note` then says why in one
 * sentence: too few days to compare with, nothing planned yet, before a typical day's first
 * delivery. None of those is a verdict about the day, and none of them is drawn as a zero.
 *
 * @param pace          paceNow(...)
 * @param measure       'stops' | 'share'
 * @param typical       'weekday' | 'recent'
 * @param typicalLabel  "Typical Wednesday"
 * @param todayWd       ISO weekday of today
 */
export function paceWords({ pace, measure = 'stops', typical = 'weekday', typicalLabel = 'Typical day', todayWd = null } = {}) {
  const p = pace || {};
  const share = measure === 'share';
  const f = (v) => (v == null ? '—' : share ? fmtShare(v) : fmtCount(v));
  const clock = fmtClock(p.atMinute);
  const wd = WEEKDAY_LONG[todayWd] || null;
  const sameWeekday = typical === 'weekday' && !!wd && todayWd <= 5;
  const n = num(p.n) ?? 0;
  const kind = (k) => (sameWeekday ? (k === 1 ? wd : `${wd}s`) : (k === 1 ? 'weekday' : 'weekdays'));
  switch (p.status) {
    case 'no-board':
      return { head: null, facts: null, note: 'Nothing is on today’s board yet, so there is no pace to judge.' };
    case 'no-clock':
      return { head: null, facts: null, note: 'No scan has landed today and the time could not be read, so there is no minute to compare at.' };
    case 'insufficient':
      if (typical === 'weekday' && wd && todayWd > 5) {
        // A weekend board: the typical day is only ever built from weekdays, so there is no typical
        // Saturday to be behind — said as that, not as a shortage the History card could fix.
        return {
          head: null,
          facts: null,
          note: `Today is a ${wd}, and typical days are built from weekdays only. To compare anyway, set Typical day to the last 20 weekdays in Filters.`,
        };
      }
      return {
        head: null,
        facts: null,
        note: `${fmtCount(n)} ${kind(n)} built to compare with, and ${MIN_BASELINE_DAYS} are needed before today is called ahead or behind. The History card builds the rest.`,
      };
    case 'not-started':
      return {
        head: null,
        facts: null,
        note: p.atMinute == null
          ? 'The day has not started yet.'
          : `A typical ${sameWeekday ? wd : 'weekday'} has not delivered anything by ${clock} either — there is nothing to be behind yet.`,
      };
    case 'ahead': case 'on-pace': case 'behind': break;
    default: return { head: null, facts: null, note: null };
  }
  const cur = share ? p.share : p.count;
  const med = share ? p.shareMedian : p.median;
  const lo = share ? p.shareP25 : p.p25;
  const hi = share ? p.shareP75 : p.p75;
  const diff = share ? p.shareDelta : p.delta;
  const where = p.status === 'ahead' ? 'above' : p.status === 'behind' ? 'below' : 'inside';
  const what = share ? `${fmtShare(cur)} of today’s board done` : `${fmtCount(cur)} delivered`;
  return {
    head: `${what} by ${clock} — ${where} the middle half of the last ${n} ${kind(n)} (${f(lo)}–${f(hi)}).`,
    facts: [
      { key: 'now', label: `Today by ${clock}`, value: f(cur), sub: p.fromScan ? 'at the last scan' : 'at the clock — no scan today yet' },
      { key: 'typical', label: `${typicalLabel} by then`, value: f(med), sub: `median of ${n} day${n === 1 ? '' : 's'}` },
      { key: 'band', label: 'Middle half', value: lo != null && hi != null ? `${f(lo)}–${f(hi)}` : '—', sub: 'where half of those days were' },
      {
        key: 'diff',
        label: 'Against typical',
        value: diff == null ? '—' : share ? fmtPoints(diff) : fmtSigned(diff),
        tone: diff == null ? null : diff >= 0 ? 'good' : 'bad',
        sub: share ? 'share of the board' : p.deltaPct != null ? `${fmtPctChange(p.deltaPct)} of the median` : null,
      },
    ],
    note: null,
  };
}

/**
 * The line under the screen's title: how fresh the board is, when the screen last read it, and the
 * call count — which is always zero, and says so, because "did that just cost NuVizz calls?" is the
 * first question anybody asks of a screen that refreshes itself. `short` is the phone's wording of
 * the same three facts, so the call count is never the part a 360px screen cuts off.
 */
export function freshnessLine({ live = null, hasData = false, readAt = null, short = false } = {}) {
  const bits = [];
  if (live?.asOf && num(live.asOf.minute) != null) bits.push(short ? `Scan ${fmtClock(live.asOf.minute)}` : `Board as of the ${fmtClock(live.asOf.minute)} scan`);
  else if (live) bits.push(short ? 'No scan today' : 'No scan has landed today yet');
  else if (hasData) bits.push(short ? 'No board today' : 'No board for today');
  if (readAt) bits.push(`read ${readAt}`);
  bits.push('0 NuVizz calls');
  return bits.join(' · ');
}

const ET_HOUR_MINUTE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Minute of the EASTERN day for an instant — so "read 3:37p" is on the same clock as "scan 11:10a"
 * (the board's clock), whatever time zone the device happens to be set to. null for a non-instant.
 */
export function etMinuteOf(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = Object.fromEntries(ET_HOUR_MINUTE.formatToParts(d).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24; const m = Number(parts.minute);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/** "Typical Wednesday" → "typical Wednesday": lower-case the first letter only, never a weekday's. */
export const lowerFirst = (s) => { const t = String(s ?? ''); return t ? t[0].toLowerCase() + t.slice(1) : t; };

/**
 * True while a DIFFERENT range is loading — the screen keeps the old answer on screen, dimmed, so the
 * frame never blanks; the three-minute refresh of the SAME range is not dimmed, or the charts would
 * flicker every three minutes for nothing. A range the endpoint had to cut short (`clamped`) starts
 * later than asked on every read, and is not "different" for that.
 */
export function rangeIsStale({ loading = false, served = null, range = null, prev = null } = {}) {
  if (!loading || !served || !range || !prev) return false;
  return served.to !== range.to || (served.from !== prev.from && served.clamped !== 'range-too-long');
}
