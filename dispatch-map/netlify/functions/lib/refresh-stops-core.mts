// refresh-stops-core.mts
//
// Shared handler for the scheduled stop-index writers. Two thin function
// wrappers (daytime + evening) both delegate here — Netlify allows only ONE
// cron expression per scheduled function, so covering two UTC windows requires
// two function files sharing this one implementation.
//
// Each run scans TODAY + the next 7 calendar days and upserts every normalized
// stop into nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}, with a meta doc
// carrying last_scanned_at. Future dates are scanned so date-picker selections
// ahead of today aren't empty (see PR caveat).
//
// Scheduling is governed ENTIRELY by the two wrappers' cron expressions (see
// nuvizz-refresh-stops-background.mts) — there is deliberately no UTC-weekday
// skip here, because the Friday-evening ET window lands on Saturday UTC and a
// naive getUTCDay() check would wrongly drop it. Manual HTTP runs always proceed.

import { scanDate, todayUTC } from './nuvizz-scan.mts';
import { isFirestoreEnabled, writeStops } from './firestore.mts';

const TENANT = 'davis';
const DEFAULT_DAYS = 8; // today + next 7

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function runRefreshStops(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // Kill switch — set NUVIZZ_SCANS_ENABLED=false to stop the scheduled NuVizz
  // stop-index scans (the board then serves the last scanned index and goes
  // stale until re-enabled). Any value other than the string "false" leaves
  // scanning on, so the default (unset) behavior is unchanged.
  if (process.env.NUVIZZ_SCANS_ENABLED === 'false') {
    console.log('refresh-stops: NUVIZZ_SCANS_ENABLED=false — scan skipped');
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'NUVIZZ_SCANS_ENABLED=false' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isFirestoreEnabled()) {
    console.error('refresh-stops: FIREBASE_SA not set on this site — cannot write index');
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Manual overrides: ?date=YYYY-MM-DD (single) | ?days=N (today+N-1).
  // Scheduled invocations carry no query string (a JSON {next_run} body) and
  // fall through to the today+7 default.
  let dates: string[];
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get('date');
    const daysParam = url.searchParams.get('days');
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
}
