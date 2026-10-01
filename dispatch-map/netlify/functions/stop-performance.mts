// stop-performance.mts — THE PERFORMANCE SCREEN'S ONE READ.
//
// Chad, 2026-09-30: "track performance over days, weeks, months … and also … interday to track
// the number of stops that we've done compared to other days or like the daily average at that
// point in time to let us know if we're behind or ahead of schedule."
//
// Three answers, one request, ZERO NuVizz calls:
//
//   1. THE TREND — one summary per day in [from, to]: planned, delivered (90 + 91), open,
//      unable, cancelled, completion and hand-close rates, and when the day's deliveries were
//      half done. Read from pace_days (lib/stop-pace-store.mts), one small document per day,
//      projected so no curve or route row rides along.
//   2. THE TYPICAL DAY — the latest `pool` digested days before today, WITH their 5-minute
//      delivery curves. The screen picks the comparison set (same weekday, or recent days, less
//      any day Chad left out) and draws the band; which days count is a choice made in the open,
//      on the screen, never baked in here.
//   3. TODAY, NOW — today's board, read once (masked to the 16 fields the digest reads) and run
//      through the SAME builder the nightly hook uses, so today and history are counted by one
//      function. With it, the minute the board actually knows up to (its last scan), because
//      that — not the wall clock — is the minute today is fair to compare at (stop-pace.mts,
//      boardAsOfMinute).
//
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   the trend range (default: the 30 days ending today, ≤ 800 —
//                                    a year-to-date view AND the year before it, for its % change)
//   &pool=N                          how many recent days come with curves (default 40, 8–60)
//   &day=YYYY-MM-DD                  one day's whole digest, route rows included (today = live)
//   &detailOnly=1                    with &day: that day's digest and nothing else — what the
//                                    table's "Show routes" and a chart overlay ask for
//
// NOTHING HERE IS A ZERO THAT MEANS "NOT KNOWN". A sealed day with no digest yet is listed in
// `coverage.missing` — the screen draws it as a gap and offers to build it — and a weekday that
// was never captured at all is listed in `coverage.uncaptured`. A missing day read as "0 delivered"
// would be the loudest bar on the chart and the one thing on it that is not true.
//
// Read-only. Firestore only. Gated at viewer — the same as day-completion, whose numbers these are.

import { isFirestoreEnabled, readStops, runQuery } from './lib/firestore.mts';
import { requireUser, jsonResponse } from './lib/require-user.mts';
import { HISTORY_COLLECTION } from './lib/history-store.mts';
import { dateRangeQuery } from './lib/stop-search-store.mts';
import { excludedRouteNames } from './lib/day-completion.mts';
import {
  buildPaceDigest, paceSummaryOf, PACE_STOP_FIELDS, PACE_SUMMARY_FIELDS, etClockOf, boardAsOfMinute, isoWeekday,
} from './lib/stop-pace.mts';
import { stopPaceEnabled, readPaceDays, readPaceDigest } from './lib/stop-pace-store.mts';
import { addDays, isDateStr, daysBetween } from '../../src/lib/history-range.js';

const TENANT = 'davis';
export const MAX_RANGE_DAYS = 800;
export const DEFAULT_RANGE_DAYS = 30;
export const DEFAULT_POOL = 40;
/** Calendar days searched for pool days: twelve weeks holds 60 weekdays with room for holidays. */
const POOL_WINDOW_DAYS = 84;

/**
 * PURE. The request, resolved: a trend range that exists and ends no later than today, a pool
 * size inside its bounds, and an optional detail day. `clamped` names anything that had to be
 * adjusted, so the screen can say so instead of quietly showing a different range than was asked.
 */
export function resolvePerformanceQuery(params: URLSearchParams, today: string): {
  from: string; to: string; pool: number; day: string | null; clamped: string | null;
} {
  let clamped: string | null = null;
  const q = (k: string) => (params.get(k) || '').trim();
  let to = isDateStr(q('to')) ? q('to') : today;
  if (to > today) { to = today; clamped = 'to-after-today'; }
  let from = isDateStr(q('from')) ? q('from') : addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) { const t = from; from = to; to = t; clamped = clamped || 'reversed'; }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) { from = addDays(to, -(MAX_RANGE_DAYS - 1)); clamped = clamped || 'range-too-long'; }
  const n = Math.floor(Number(q('pool') || DEFAULT_POOL));
  const pool = Number.isFinite(n) ? Math.max(8, Math.min(60, n)) : DEFAULT_POOL;
  const day = isDateStr(q('day')) && q('day') <= today ? q('day') : null;
  return { from, to, pool, day, clamped };
}

/**
 * PURE. Which days of the warehouse window are sealed, which Davis did not run (a tombstone —
 * no_board), and which WEEKDAYS are neither: a day that should have a board and has no record
 * at all. Weekends are not "uncaptured" — the capture skips them on purpose (history-core).
 */
export function classifyWarehouse(manifests: any[], from: string, to: string, tenant = TENANT): {
  sealed: string[]; noBoard: string[]; uncaptured: string[];
} {
  const sealed = new Set<string>();
  const noBoard = new Set<string>();
  for (const d of manifests || []) {
    const date = String(d?.date ?? '');
    if (!isDateStr(date) || !String(d?._id ?? '').startsWith(`${tenant}__`)) continue;
    if (date < from || date > to) continue;
    if (d?.no_board) { noBoard.add(date); continue; }
    if (d?.complete || d?.verified) sealed.add(date);
  }
  const uncaptured: string[] = [];
  if (isDateStr(from) && isDateStr(to) && from <= to) {
    for (let d = from, i = 0; d <= to && i < MAX_RANGE_DAYS + POOL_WINDOW_DAYS; d = addDays(d, 1), i++) {
      const wd = isoWeekday(d);
      if (wd == null || wd > 5) continue;
      if (!sealed.has(d) && !noBoard.has(d)) uncaptured.push(d);
    }
  }
  return { sealed: [...sealed].sort(), noBoard: [...noBoard].sort(), uncaptured };
}

export default async (req: Request): Promise<Response> => {
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  const J = (b: any, s = 200) => jsonResponse(b, s, { 'Cache-Control': 'private, max-age=60', Vary: 'Authorization' });
  if (!stopPaceEnabled()) {
    return J({ ok: false, nuvizzCalls: 0, switchedOff: true, error: 'STOP_PACE=off — the Performance screen is switched off' }, 409);
  }
  if (!isFirestoreEnabled()) return J({ ok: false, nuvizzCalls: 0, error: 'Firestore off — there is nothing to read' }, 500);

  const now = new Date();
  const clock = etClockOf(now)!;
  const today = clock.date;
  const url = new URL(req.url);
  const q = resolvePerformanceQuery(url.searchParams, today);
  const yesterday = addDays(today, -1);
  const poolFrom = addDays(today, -POOL_WINDOW_DAYS);
  const windowFrom = q.from < poolFrom ? q.from : poolFrom;

  // ONE DAY, NOTHING ELSE — a table row's "Show routes", or a day overlaid on the pace chart that
  // is older than the pool. Today is built from the board exactly as below; any other day is its
  // stored digest, or null when none was written (the screen says "not built yet", never "0").
  if (url.searchParams.get('detailOnly') === '1') {
    if (!q.day) return J({ ok: false, nuvizzCalls: 0, error: 'detailOnly needs day=YYYY-MM-DD (today or earlier)' }, 400);
    try {
      if (q.day !== today) return J({ ok: true, nuvizzCalls: 0, today, detail: await readPaceDigest(TENANT, q.day) });
      const board = await readStops(TENANT, today, { mask: PACE_STOP_FIELDS });
      const detail = board?.stops?.length
        ? { ...buildPaceDigest(board.stops, { tenant: TENANT, date: today, source: 'live', builtAt: now.toISOString() }), asOf: boardAsOfMinute(board.meta, today) }
        : null;
      return J({ ok: true, nuvizzCalls: 0, today, detail });
    } catch (e: any) {
      return J({ ok: false, nuvizzCalls: 0, error: String(e?.message || e) }, 500);
    }
  }

  try {
    const [days, poolDays, manifests, board, detailStored] = await Promise.all([
      // 1. the trend, summaries only (today is added live below, never read from a digest)
      readPaceDays(TENANT, q.from, q.to < today ? q.to : yesterday),
      // 2. the typical-day pool, with curves (route rows stay behind)
      readPaceDays(TENANT, poolFrom, yesterday, [...PACE_SUMMARY_FIELDS, 'curve']),
      // what the warehouse holds, so a day with no digest is a gap and not a zero
      runQuery(dateRangeQuery(HISTORY_COLLECTION, windowFrom, yesterday, ['tenant', 'date', 'no_board', 'complete', 'verified'])),
      // 3. today's board, masked to the fields the digest reads
      readStops(TENANT, today, { mask: PACE_STOP_FIELDS }),
      q.day && q.day !== today ? readPaceDigest(TENANT, q.day) : Promise.resolve(null),
    ]);

    let live: any = null;
    if (board?.stops?.length) {
      const digest = buildPaceDigest(board.stops, { tenant: TENANT, date: today, source: 'live', builtAt: now.toISOString() });
      live = {
        ...digest,
        asOf: boardAsOfMinute(board.meta, today),
        scanState: board.meta?.scanState ?? null,
        boardRows: board.stops.length,
      };
    }

    const trend = [...days];
    if (live && q.from <= today && today <= q.to) trend.push(paceSummaryOf(live));

    // COVERAGE IS JUDGED ONLY WHERE THIS REQUEST ACTUALLY LOOKED — the trend range and the pool
    // window. A January trend beside a September pool must not report February as "missing":
    // nothing here read February, so nothing here knows.
    const trendTo = q.to < today ? q.to : yesterday;
    const looked = (d: string) => (d >= q.from && d <= trendTo) || (d >= poolFrom && d <= yesterday);
    const wh = classifyWarehouse(manifests, windowFrom, yesterday);
    const built = new Set([...days, ...poolDays].map((d: any) => d.date));
    const missing = wh.sealed.filter((d) => looked(d) && !built.has(d));

    const pool = poolDays
      .filter((d: any) => Array.isArray(d.curve) && d.curve.length)
      .sort((a: any, b: any) => (a.date < b.date ? 1 : -1))
      .slice(0, q.pool);

    return J({
      ok: true,
      nuvizzCalls: 0,
      today,
      now: { minute: clock.minute, at: now.toISOString() },
      range: { from: q.from, to: q.to, clamped: q.clamped },
      days: trend,
      pool,
      live,
      liveNote: live ? null : 'no board for today',
      detail: q.day ? (q.day === today ? live : detailStored) : null,
      coverage: {
        from: windowFrom,
        to: yesterday,
        sealed: wh.sealed.filter(looked).length,
        built: [...built].filter(looked).length,
        missing,
        // YESTERDAY IS NEVER "UNCAPTURED" HERE: the nightly capture seals it around 2am ET, so
        // between midnight and then it is simply not done yet, and saying otherwise would raise a
        // false alarm every night. A capture that really failed is Diagnostics' to report
        // (history-capture-health); this screen only says so from the day after.
        uncaptured: wh.uncaptured.filter((d) => looked(d) && d < yesterday),
        noBoard: wh.noBoard.filter(looked),
      },
      excludedRoutes: excludedRouteNames(),
    });
  } catch (e: any) {
    return J({ ok: false, nuvizzCalls: 0, error: String(e?.message || e) }, 500);
  }
};
