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

import { scanDate, todayUTC, scansEnabled, deriveFleetSummary } from './nuvizz-scan.mts';
import { isFirestoreEnabled, writeStops, writeFleetIndex, getDoc } from './firestore.mts';
import { breakerTripped, scanIntervalElapsed } from './nuvizz-request.mts';
import { scanDecision } from './scan-schedule.mts';

const TENANT = 'davis';
// Scheduled runs scan TODAY + the next BUSINESS day — the dispatcher's planning
// horizon. (The original today+next-7 was an 8× multiplier on every cron tick;
// today-only was too tight — it left tomorrow's board frozen, since the map only
// READS Firestore and never scans a future date itself.) Business-day stepping so
// a Friday run covers Monday, not an empty Saturday. Volume stays modest because
// the load-window self-calibrates to each day's actual span (see nuvizz-scan.mts).
const DEFAULT_DAYS = 2; // today + next business day (was 1 = today only)

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The next Mon–Fri date strictly after dateStr (skips Sat/Sun).
export function nextBusinessDayUTC(dateStr: string): string {
  let d = addDaysUTC(dateStr, 1);
  let dow = new Date(d + 'T00:00:00Z').getUTCDay();
  while (dow === 0 || dow === 6) { d = addDaysUTC(d, 1); dow = new Date(d + 'T00:00:00Z').getUTCDay(); }
  return d;
}

// Build the scan date list: today + the next (n-1) BUSINESS days. Exported for tests.
export function scanDatesFrom(today: string, n: number): string[] {
  const dates = [today];
  let cur = today;
  for (let i = 1; i < n; i++) { cur = nextBusinessDayUTC(cur); dates.push(cur); }
  return dates;
}

export async function runRefreshStops(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // P0 kill switch — set Netlify env NUVIZZ_SCANS_ENABLED=false to disable the
  // scheduled NuVizz scan without a code deploy. Returns 200 (so the cron run is
  // recorded as a no-op, not a failure) and touches neither NuVizz nor Firestore.
  if (!scansEnabled()) {
    console.log('refresh-stops: NUVIZZ_SCANS_ENABLED=false — skipping scan (kill switch active)');
    return new Response(JSON.stringify({ ok: true, skipped: 'scans-disabled' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // P0/Phase 4 circuit breaker — if the shared daily ceiling tripped the breaker,
  // skip the whole run (the next regression is throttled in minutes, not by a
  // vendor email). Reset by clearing nuvizz_ops/circuit, e.g. at the day rollover.
  if (await breakerTripped()) {
    console.warn('refresh-stops: NuVizz circuit breaker OPEN — skipping scan (daily ceiling reached)');
    return new Response(JSON.stringify({ ok: true, skipped: 'circuit-open' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isFirestoreEnabled()) {
    console.error('refresh-stops: FIREBASE_SA not set on this site — cannot write index');
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const isManual = url.searchParams.get('manual') === '1';
  const dateParam = url.searchParams.get('date');
  const daysParam = url.searchParams.get('days');
  const explicit = !!(dateParam || daysParam); // ops/testing: full forced scan of given dates

  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const results: any[] = [];

  // scanAndWrite — one date. includeUnplanned gates the order descent; `forced`
  // (manual/explicit) bypasses the per-date min-interval floor; manual caps the
  // unplanned descent lower so the synchronous endpoint finishes in time.
  const scanAndWrite = async (date: string, includeUnplanned: boolean, forced: boolean) => {
    const t0 = Date.now();
    try {
      if (!forced) {
        const metaDoc = await getDoc(`nuvizz_stop_index/${TENANT}__${date}`);
        if (metaDoc && !scanIntervalElapsed(metaDoc.last_scanned_at, Date.now())) {
          results.push({ date, ok: true, skipped: 'min-interval', ms: Date.now() - t0 });
          return;
        }
      }
      const scan = await scanDate(date, {
        includeUnplanned,
        unplanned: (isManual && includeUnplanned) ? { maxProbes: 800 } : undefined,
      });
      const meta = await writeStops(TENANT, date, scan.stops, scan.scannedAt, { includeUnplanned });
      const fleet = deriveFleetSummary(scan.stops, scan.loadHeaders);
      await writeFleetIndex(TENANT, date, fleet.loads, fleet.summary, fleet.driverIndex, scan.scannedAt);
      results.push({ date, ok: true, ms: Date.now() - t0, includeUnplanned, count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount, loads: fleet.loads.length });
    } catch (e: any) {
      results.push({ date, ok: false, ms: Date.now() - t0, error: e?.message });
    }
  };

  // Ops/testing path: ?date=… or ?days=N → full scan (loads + unplanned), forced.
  if (explicit) {
    let dates: string[];
    if (dateParam) dates = [dateParam];
    else { const n = Math.max(1, Math.min(31, parseInt(daysParam || '', 10) || DEFAULT_DAYS)); dates = scanDatesFrom(todayUTC(), n); }
    for (const date of dates) await scanAndWrite(date, true, true);
    const summary = { ok: true, tenant: TENANT, mode: 'explicit', totalMs: Date.now() - startedAt, dates: results };
    console.log('refresh-stops results:', JSON.stringify(summary));
    return json(summary);
  }

  // Scheduled / manual: the schedule decides whether to act and which feeds run.
  const decision = scanDecision(new Date(), isManual);
  console.log('refresh-stops decision:', JSON.stringify({ ...decision, isManual }));
  if (!decision.act) {
    return json({ ok: true, skipped: 'cadence', reason: decision.reason });
  }

  const [today, tomorrow] = scanDatesFrom(todayUTC(), 2);
  // Today's loads always; today's order descent only inside its window.
  await scanAndWrite(today, decision.scanUnplanned, isManual);
  // Tomorrow's loads only inside its window; tomorrow's unplanned never.
  if (decision.scanTomorrowLoads) await scanAndWrite(tomorrow, false, isManual);

  const summary = { ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', decision, totalMs: Date.now() - startedAt, dates: results };
  console.log('refresh-stops results:', JSON.stringify(summary));
  return json(summary);
}
