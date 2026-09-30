// lib/stop-pace.mts — ONE BOARD DAY, REDUCED TO HOW FAST IT WAS DELIVERED (PURE).
//
// Chad, 2026-09-30: "track performance over days, weeks, months … to see how we're
// performing and also … interday to track the number of stops that we've done compared to
// other days or like the daily average at that point in time to let us know if we're behind
// or ahead of schedule."
//
// THE QUESTION IS "AT THIS POINT IN THE DAY", AND THAT IS WHAT MAKES IT EXPENSIVE. A day's
// total is one number; "how many had we done by 11:15 on the last eight Tuesdays" is every
// delivered stop of eight days, each read for its delivery stamp — at the ~535 documents a day
// history-search-rebuild sizes a day at, over 4,000 reads to draw one line, on every refresh.
// Stop lookup met the same wall with a year of
// customer history (v1.47.0: "A year is ~510,000 reads") and answered it the same way this
// does: PAY ONCE, AT WRITE TIME. The nightly post-seal hook already holds every stop of the day
// it just sealed; counting its deliveries into 5-minute buckets while it is there turns the
// pace question into one small document per day.
//
// THE COUNT IS THE 6:30 REPORT'S COUNT, NOT A SECOND OPINION. What counts as planned, what
// counts as delivered (90 AND 91), which routes are left out (CHAD, ULINE APPT) and which
// copies were closed on another day's board are all decided by buildDayCompletion — the same
// function the 6:30 email, the day-completion endpoint and (through isSetAsideRoute) the
// phone's Stops completed card already share. This file CALLS it for every total it stores and
// only adds the one thing the report never needed: WHEN each delivery happened. A parity test
// (test/stop-pace.test.mjs) pins that the stamped and unstamped deliveries here add up to the
// report's delivered count, route by route, so the two cannot drift apart unnoticed.
//
// WHEN A DELIVERY HAPPENED is finishedAt (src/lib/load-lookup.js): the stamp from wherever the
// record keeps it, read ON THE DIGITS. The board stores Eastern wall-clock text with no zone;
// Date.parse reads it as UTC and moves every delivery four or five hours — the bug App.jsx's
// stopWhen and the flag-history column were each fixed for. A delivery whose stamp is missing,
// or dated some other day, is counted and SAID ("untimed"), never placed on the curve at a
// guessed minute: a lump of made-up 5pm deliveries would make every afternoon look ahead.
//
// PURE, and network-free by construction: stop records in, one value out. No clock, no
// Firestore, no NuVizz. The caller supplies the date and the build stamp, so a day rebuilt from
// the warehouse next month is byte-for-byte the one the nightly hook wrote.

import {
  buildDayCompletion, stopOutcome, isDeliveredOutcome, isExcludedRoute, excludedRouteNames,
  type Outcome,
} from './day-completion.mts';
import { finishedAt } from '../../../src/lib/load-lookup.js';

/** Bumped when the stored shape changes, so a reader can tell an old digest from a new one. */
export const PACE_VERSION = 1;
/** One bucket per five minutes of the ET day. Fine enough to answer "by 11:15", coarse enough
 *  that a day is 288 small integers rather than a list of 800 timestamps. */
export const PACE_BUCKET_MIN = 5;
export const PACE_BUCKETS = (24 * 60) / PACE_BUCKET_MIN;

/**
 * THE ONLY FIELDS THE DIGEST READS. Both the live board read (readStops) and the warehouse read
 * (listStops) pass it as their mask, so the answer for today and the answer rebuilt from a sealed
 * day are computed from the same fields. test/stop-pace.test.mjs pins that every field the
 * builder reads is in it — a field read but not masked is a field that is always undefined.
 *
 *   planned / route / day       isPlanned, loadNbr, routeName, closedOnBoard
 *   outcome (stopOutcome)       status, normalizedStatus, deliveredDTTM, arrivalDTTM, and the
 *                               warehouse's executed.* copies of the same three
 *   when (finishedAt)           deliveredDTTM, executed.deliveredDTTM,
 *                               raw.stopExecutionInfo.to.deliveredDTTM
 *   the table                   driverName, driverUserName, stopNbr, pro
 */
export const PACE_STOP_FIELDS = [
  'stopNbr', 'pro', 'isPlanned', 'loadNbr', 'routeName', 'closedOnBoard',
  'status', 'normalizedStatus', 'deliveredDTTM', 'arrivalDTTM',
  'executed.stopStatus', 'executed.deliveredDTTM', 'executed.arrivalDTTM',
  'raw.stopExecutionInfo.to.deliveredDTTM',
  'driverName', 'driverUserName',
];

/** The summary fields — everything but the curve and the route rows. What a trend reads. */
export const PACE_SUMMARY_FIELDS = [
  'tenant', 'date', 'v', 'weekday', 'source', 'builtAt',
  'planned', 'gradable', 'delivered', 'open', 'counts', 'completionRate', 'manualRate',
  'excluded', 'closedElsewhere', 'timed', 'untimed', 'firstMin', 'lastMin', 'halfMin', 'p90Min',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: any) => String(v ?? '').trim();

/** ISO weekday of a YYYY-MM-DD, 1 = Monday … 7 = Sunday. Noon UTC, so no offset can move it. */
export function isoWeekday(date: string): number | null {
  if (!DATE_RE.test(str(date))) return null;
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * PURE. Minute of the ET day (0–1439) a delivery stamp names — but ONLY when the stamp is dated
 * `date`. A stamp from another day is not a minute of this one: an order delivered at 00:20 the
 * next morning is not "20 minutes past midnight today", and pretending it was would put it at
 * the very start of the curve.
 */
export function stampMinute(stamp: string | null | undefined, date: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(str(stamp));
  if (!m || m[1] !== date) return null;
  const hh = Number(m[2]), mm = Number(m[3]);
  if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) return null;
  return hh * 60 + mm;
}

/**
 * PURE. Does this row count toward `date`'s numbers at all? The SAME three gates, in the same
 * order, as buildDayCompletion — planned only, not closed on another day's board, not a route the
 * report stays quiet about. Kept beside the builder below and pinned by the parity test: if
 * buildDayCompletion ever changes its gates, the parity test goes red before a chart drifts.
 */
export function countsOnDay(s: any, date: string, excludeRoutes: string[]): boolean {
  const isPlanned = s?.isPlanned === false ? false : (s?.isPlanned === true || !!str(s?.loadNbr || s?.routeName));
  if (!isPlanned) return false;
  const closedOn = str(s?.closedOnBoard);
  if (closedOn && closedOn !== date) return false;
  const rk = str(s?.loadNbr || s?.routeName);
  if (isExcludedRoute(rk, excludeRoutes)) return false;
  return true;
}

export interface PaceRoute {
  route: string;
  driver: string | null;
  planned: number;
  delivered: number;
  manual: number;
  open: number;
  inFlight: number;
  unable: number;
  cancelled: number;
  firstMin: number | null;
  lastMin: number | null;
}

export interface PaceDigest {
  v: number;
  tenant: string;
  date: string;
  weekday: number | null;
  /** 'sealed' — built from the warehouse after the day closed; 'live' — today's board, now. */
  source: 'sealed' | 'live';
  builtAt: string | null;
  planned: number;
  gradable: number;
  delivered: number;
  open: number;
  counts: Record<Outcome, number>;
  completionRate: number | null;
  manualRate: number | null;
  /** Rows on CHAD / ULINE APPT — left out of every number above, and said. */
  excluded: number;
  /** Copies finished on a LATER day's board; that day counts them. */
  closedElsewhere: number;
  /** Deliveries placed on the curve (a same-day stamp) and deliveries that could not be. */
  timed: number;
  untimed: number;
  bucketMin: number;
  /** Deliveries stamped in each 5-minute bucket of the ET day — NOT cumulative. */
  curve: number[];
  firstMin: number | null;
  lastMin: number | null;
  /** The minute by which half, and nine in ten, of the timed deliveries were done. */
  halfMin: number | null;
  p90Min: number | null;
  routes: PaceRoute[];
}

/** The k-th smallest of an ascending list, as a minute (nearest-rank; no invented minutes). */
function rankOf(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * PURE. The whole day's pace in one value.
 *
 * Every TOTAL comes from buildDayCompletion — see the header. This adds only the timing: one
 * pass over the same rows, through the same gates, reading each delivered row's stamp.
 */
export function buildPaceDigest(
  stops: any[],
  { tenant = 'davis', date, source = 'sealed', builtAt = null, excludeRoutes = excludedRouteNames() }:
    { tenant?: string; date: string; source?: 'sealed' | 'live'; builtAt?: string | null; excludeRoutes?: string[] },
): PaceDigest {
  if (!DATE_RE.test(str(date))) throw new Error(`pace digest: not a day id: ${date}`);
  const rows = Array.isArray(stops) ? stops : [];
  const day = buildDayCompletion(rows, { date, asOf: builtAt, excludeRoutes });

  const routes = new Map<string, PaceRoute>();
  for (const r of day.byRoute) {
    routes.set(r.route, {
      route: r.route, driver: r.driver ?? null,
      planned: r.planned, delivered: r.delivered, manual: 0, open: r.open,
      inFlight: r.inFlight, unable: r.unable, cancelled: r.cancelled,
      firstMin: null, lastMin: null,
    });
  }

  const curve = new Array(PACE_BUCKETS).fill(0);
  const minutes: number[] = [];
  let untimed = 0;
  for (const s of rows) {
    if (!countsOnDay(s, date, excludeRoutes)) continue;
    const outcome = stopOutcome(s);
    if (!isDeliveredOutcome(outcome)) continue;
    const routeKey = str(s?.loadNbr || s?.routeName) || '(unrouted)';
    const r = routes.get(routeKey);
    if (r && outcome === 'delivered_manual') r.manual += 1;
    const m = stampMinute(finishedAt(s), date);
    if (m == null) { untimed += 1; continue; }
    minutes.push(m);
    curve[Math.floor(m / PACE_BUCKET_MIN)] += 1;
    if (r) {
      if (r.firstMin == null || m < r.firstMin) r.firstMin = m;
      if (r.lastMin == null || m > r.lastMin) r.lastMin = m;
    }
  }
  minutes.sort((a, b) => a - b);

  return {
    v: PACE_VERSION,
    tenant,
    date,
    weekday: isoWeekday(date),
    source,
    builtAt,
    planned: day.planned,
    gradable: day.gradable,
    delivered: day.delivered,
    open: day.open,
    counts: day.counts,
    completionRate: day.completionRate,
    manualRate: day.manualRate,
    excluded: day.excluded.reduce((a, e) => a + e.stops, 0),
    closedElsewhere: day.closedElsewhere.length,
    timed: minutes.length,
    untimed,
    bucketMin: PACE_BUCKET_MIN,
    curve,
    firstMin: minutes.length ? minutes[0] : null,
    lastMin: minutes.length ? minutes[minutes.length - 1] : null,
    halfMin: rankOf(minutes, 0.5),
    p90Min: rankOf(minutes, 0.9),
    routes: [...routes.values()].sort((a, b) => a.route.localeCompare(b.route)),
  };
}

/** PURE. The digest without its curve and route rows — the shape a trend reads. */
export function paceSummaryOf(d: any): any {
  if (!d || typeof d !== 'object') return null;
  const out: any = {};
  for (const k of PACE_SUMMARY_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

// ── the ET clock, for the endpoint (the builder above never reads one) ─────────

const ET_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * PURE given its argument. An instant as the ET calendar day and minute of that day, or null for
 * anything that is not an instant. Used for "now" and for the board's last-scan stamps, which
 * the store keeps as UTC instants (StopIndexMeta).
 */
export function etClockOf(v: Date | string | number | null | undefined): { date: string; minute: number } | null {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const hh = Number(p.hour) % 24;
  const mm = Number(p.minute);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return { date: `${p.year}-${p.month}-${p.day}`, minute: hh * 60 + mm };
}

/**
 * PURE. HOW FAR TODAY'S BOARD ACTUALLY KNOWS — the latest scan stamp that is dated today, as a
 * minute of the ET day, or null when nothing has scanned today yet.
 *
 * THIS IS THE MINUTE TODAY IS COMPARED AT, NOT THE WALL CLOCK. The completed feed lands every
 * fifteen minutes or so; at 11:14 the board may know only what was delivered by 11:00. Compared
 * with "a typical Tuesday by 11:14", fourteen minutes of peak deliveries — forty or fifty stops —
 * would read as falling behind, every quarter hour, on a day that is exactly on pace. A pace
 * signal that cries wolf four times an hour is a signal nobody reads by lunchtime.
 */
export function boardAsOfMinute(meta: any, today: string): { minute: number; at: string } | null {
  let best: { minute: number; at: string; t: number } | null = null;
  for (const k of ['lastCompletedScanAt', 'lastLoadScanAt', 'last_scanned_at']) {
    const at = meta?.[k];
    const c = etClockOf(at);
    if (!c || c.date !== today) continue;
    const t = Date.parse(String(at));
    if (!best || t > best.t) best = { minute: c.minute, at: String(at), t };
  }
  return best ? { minute: best.minute, at: best.at } : null;
}
