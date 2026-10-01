// board-skids.mts — the day's skid count, for the drivers board.
//
// Chad: "i want the davis delivery drivers board to have a live skid count from the dispatch
// map board." Consumed by the EXTERNAL drivers board (davisdeliverydrivers.netlify.app), which
// polls it once a minute to fill its Pallets box.
//
// ZERO NuVizz calls. It reads the same pre-scanned Firestore index the map feed reads
// (nuvizz_stop_index/davis__{date}) and filters it the same way, in the same order:
// prior-day finished bleed stripped, cancelled stops dropped, UAT planning view applied. So
// "skids" here is the map's own "N total pallets" for that day (see lib/board-skids.mts).
//
// Query params:
//   date=YYYY-MM-DD   optional; defaults to today (ET), like the map feed.
//   carryDays=N       optional, 0..14 (default 0). Also counts still-UNROUTED freight from the
//                     prior N days — the map's own carry-over fold (mergeCarryover, the same
//                     function, imported), so carryDays=7 is the map with carry-over switched
//                     on (src/App.jsx CARRYOVER_DAYS = 7). Chad: "minus 7 days back".
//
// Response: { ok, date, carryDays, generated, source, lastScannedAt, stops, skids, routedSkids,
//             unroutedSkids, unroutedStops, carryoverStops, carryoverSkids, carryoverRoutedSkids, loose, weight }
//
// UNGATED ON PURPOSE, AND IT SAYS ONLY TOTALS. The drivers board holds no dispatch-map
// session, so a gated read would break it the day AUTH_REQUIRED flips (the open decision
// recorded in nuvizz-attempts.mts). This feed was built to be safe in the open instead:
// numbers only — no customer, address, driver or route name ever leaves this function.

import { isFirestoreEnabled, readStops, etDayString } from './lib/firestore.mts';
import { filterFinishedPriorDay } from './lib/nuvizz-list.mts';
import { LEAN_STOP_FIELDS } from './lib/board-fields.mts';
import { dropCancelledEnabled, dropCancelledStops } from '../../src/lib/stop-cancelled.js';
import { readPlanningMode, planningView } from './lib/uat-planning-mode.mts';
import { sumBoardSkids } from './lib/board-skids.mts';
import { mergeCarryover } from './nuvizz-pull-today-stops.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET') return new Response(JSON.stringify({ ok: false, error: 'GET only' }), { status: 405, headers: cors });

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || etDayString();
  if (!DATE_RE.test(date)) return new Response(JSON.stringify({ ok: false, error: 'date must be YYYY-MM-DD' }), { status: 400, headers: cors });
  const carryDays = Math.max(0, Math.min(14, parseInt(url.searchParams.get('carryDays') || '0', 10) || 0));

  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, date, error: 'firestore not configured' }), { status: 503, headers: cors });
  }

  try {
    const [{ meta, stops: indexed }, planning] = await Promise.all([
      readStops(TENANT, date, { mask: LEAN_STOP_FIELDS }),
      readPlanningMode(),
    ]);
    // The map feed's order, step for step: prior-day bleed, then carry-over, then cancelled,
    // then the planning view — so a cancelled carry-over row is dropped here exactly as there.
    let stops = filterFinishedPriorDay(indexed, date);
    if (carryDays > 0) {
      try { await mergeCarryover(stops, date, carryDays, undefined, LEAN_STOP_FIELDS, meta?.lastUnplannedScanAt ?? null); } catch { /* keep the day's own stops, as the map does */ }
    }
    stops = dropCancelledStops(stops, dropCancelledEnabled(process.env)).stops;
    if (planning.on) stops = stops.map(planningView);
    const totals = sumBoardSkids(stops);
    return new Response(JSON.stringify({
      ok: true,
      date,
      carryDays,
      generated: new Date().toISOString(),
      // 'index-empty' = the scan has not filed anything for this day yet — an honest zero,
      // which the drivers board shows as "no scan yet" rather than as 0 skids to route.
      source: indexed.length ? 'firestore' : 'index-empty',
      lastScannedAt: meta?.last_scanned_at ?? null,
      ...totals,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, date, error: String(e?.message || e).slice(0, 300) }), { status: 500, headers: cors });
  }
};
