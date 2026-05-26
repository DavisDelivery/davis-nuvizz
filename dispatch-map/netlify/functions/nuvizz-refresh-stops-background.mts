// nuvizz-refresh-stops-background.mts  (M5.2)
//
// Scheduled BACKGROUND function (15-min limit) that pre-warms the Firestore stop
// index. The inline scan can't run on the request path — load+unplanned scan is
// >22s and 502s past the 26s request cap — so the scan lives here instead, and
// the map reads the index in <2s (see nuvizz-pull-today-stops.mts).
//
// Each run scans TODAY + the next 7 calendar days and upserts every normalized
// stop into nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}, with a meta doc
// carrying last_scanned_at. Future dates are scanned so date-picker selections
// ahead of today aren't empty (see PR caveat). Davis doesn't dispatch weekends,
// so scheduled weekend runs are skipped (manual HTTP triggers still run).
//
// Triggers:
//   • cron */5 Mon–Fri (config.schedule below)
//   • manual: POST /.netlify/functions/nuvizz-refresh-stops-background
//     (background functions return 202 and run async; poll the stop index or the
//      read endpoint's lastScannedAt to confirm completion — used by the
//      acceptance test in RESEARCH-m5.md)
//
// Query params (manual runs): ?date=YYYY-MM-DD (single date) | ?days=N (today+N-1)

import { scanDate, todayUTC } from './lib/nuvizz-scan.mts';
import { isFirestoreEnabled, writeStops } from './lib/firestore.mts';

const TENANT = 'davis';
const DEFAULT_DAYS = 8; // today + next 7

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async (req: Request): Promise<Response> => {
  const startedAt = Date.now();

  if (!isFirestoreEnabled()) {
    console.error('refresh-stops: FIREBASE_SA not set on this site — cannot write index');
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse manual overrides (scheduled invocations have no useful query string).
  let dates: string[];
  let manual = false;
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get('date');
    const daysParam = url.searchParams.get('days');
    manual = req.method === 'POST' || !!dateParam || !!daysParam;
    if (dateParam) {
      dates = [dateParam];
    } else {
      const n = daysParam ? Math.max(1, Math.min(31, parseInt(daysParam, 10) || DEFAULT_DAYS)) : DEFAULT_DAYS;
      const today = todayUTC();
      dates = Array.from({ length: n }, (_, i) => addDaysUTC(today, i));
    }
  } catch {
    const today = todayUTC();
    dates = Array.from({ length: DEFAULT_DAYS }, (_, i) => addDaysUTC(today, i));
  }

  // Davis doesn't dispatch weekends — skip scheduled weekend runs (manual runs proceed).
  const dow = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (!manual && (dow === 0 || dow === 6)) {
    console.log(`refresh-stops: weekend skip (${todayUTC()})`);
    return new Response(JSON.stringify({ ok: true, skipped: 'weekend' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const results: any[] = [];
  // Sequential per date — keeps concurrent NuVizz load light and bounds memory.
  for (const date of dates) {
    const t0 = Date.now();
    try {
      const scan = await scanDate(date);
      const meta = await writeStops(TENANT, date, scan.stops, scan.scannedAt);
      results.push({ date, ok: true, ms: Date.now() - t0, count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount });
    } catch (e: any) {
      results.push({ date, ok: false, ms: Date.now() - t0, error: e?.message });
    }
  }

  const summary = { ok: true, tenant: TENANT, totalMs: Date.now() - startedAt, dates: results };
  console.log('refresh-stops results:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '*/5 * * * *',
};
