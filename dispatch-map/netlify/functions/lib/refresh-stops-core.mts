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
import { isFirestoreEnabled, writeStops, writeFleetIndex, getDoc, markScanState, readCallCounter } from './firestore.mts';
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
  const now = new Date();
  const url = new URL(req.url);
  const isManual = url.searchParams.get('manual') === '1';
  const dateParam = url.searchParams.get('date');
  const daysParam = url.searchParams.get('days');
  const explicit = !!(dateParam || daysParam); // ops/testing: full forced scan of given dates
  const trigger = isManual ? 'manual' : (explicit ? 'explicit' : 'schedule');

  const [today, tomorrow] = scanDatesFrom(todayUTC(), 2);
  const fsOn = isFirestoreEnabled();
  const ceiling = Number(process.env.NUVIZZ_DAILY_CEILING) || 100000;

  // Read today's last LOAD scan time — this is what drives the elapsed-time
  // cadence (Fix 1). Also read the shared day counter for the log line.
  let lastLoadScanAt: string | null = null;
  let dayCount = 0;
  if (fsOn) {
    try {
      const m = (await getDoc(`nuvizz_stop_index/${TENANT}__${today}`)) as any;
      lastLoadScanAt = m?.lastLoadScanAt ?? m?.last_scanned_at ?? null;
    } catch { /* treat as never-scanned */ }
    try { dayCount = await readCallCounter(today); } catch { /* best effort */ }
  }

  const decision = scanDecision(now, isManual, lastLoadScanAt);

  // Fix 4 — exactly ONE structured line per invocation, so "why didn't it scan"
  // is answerable from the log. today/tomorrow report the DECISION's feed intent.
  const fmtEl = (m: number) => (m === Infinity ? 'inf' : String(Math.round(m)));
  const no = { l: false, u: false };
  const logScan = (skip: string, act: boolean, t: { l: boolean; u: boolean }, m: { l: boolean; u: boolean }, extra = '') => {
    console.log(`[scan] trigger=${trigger} etHour=${decision.etHour} etMin=${decision.etMin} act=${act} today={loads:${t.l},unplanned:${t.u}} tomorrow={loads:${m.l},unplanned:${m.u}} lastLoadScanAt=${lastLoadScanAt || 'null'} elapsedMin=${fmtEl(decision.elapsedMin)} intervalMin=${decision.intervalMin} dayCount=${dayCount} ceiling=${ceiling} skip=${skip}${extra}`);
  };

  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  // Kill switch (Fix 5: record halted state for the UI banner).
  if (!scansEnabled()) {
    if (fsOn) { try { await markScanState(TENANT, today, { halted: true, reason: 'killswitch', since: now.toISOString() }); } catch { /* */ } }
    logScan('killswitch', false, no, no);
    return json({ ok: true, skipped: 'scans-disabled' });
  }

  if (!fsOn) {
    logScan('error', false, no, no, ' msg=FIREBASE_SA-not-set');
    return json({ ok: false, error: 'FIREBASE_SA not set' });
  }

  // Circuit breaker — daily ceiling reached (Fix 5: record halted state).
  if (await breakerTripped()) {
    try { await markScanState(TENANT, today, { halted: true, reason: 'ceiling', since: now.toISOString() }); } catch { /* */ }
    logScan('ceiling', false, no, no);
    return json({ ok: true, skipped: 'circuit-open' });
  }

  const results: any[] = [];

  // scanAndWrite — one date. includeUnplanned gates the order descent; `forced`
  // (manual/explicit) bypasses the per-date min-interval floor; manual caps the
  // unplanned descent lower so the synchronous endpoint finishes in time.
  const scanAndWrite = async (date: string, includeUnplanned: boolean, forced: boolean, includeLoads = true) => {
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
        includeLoads,
        unplanned: (isManual && includeUnplanned) ? { maxProbes: 800 } : undefined,
      });
      const meta = await writeStops(TENANT, date, scan.stops, scan.scannedAt, { includeUnplanned, includeLoads });
      // Only rebuild the fleet (load) index when we actually scanned loads — an
      // unplanned-only run would otherwise wipe the load index with an empty scan.
      if (includeLoads) {
        const fleet = deriveFleetSummary(scan.stops, scan.loadHeaders);
        await writeFleetIndex(TENANT, date, fleet.loads, fleet.summary, fleet.driverIndex, scan.scannedAt);
      }
      results.push({ date, ok: true, ms: Date.now() - t0, includeUnplanned, includeLoads, count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount });
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
    try { dayCount = await readCallCounter(today); } catch { /* */ }
    logScan('none', true, { l: true, u: true }, { l: true, u: true });
    return json({ ok: true, tenant: TENANT, mode: 'explicit', totalMs: Date.now() - startedAt, dates: results });
  }

  // Cadence gate (Fix 1: elapsed-time, not wall-clock minute).
  if (!decision.act) {
    logScan(decision.skip, false, no, no);
    return json({ ok: true, skipped: decision.skip, reason: decision.reason });
  }

  // Today: loads always; orders inside the 10am-midnight window.
  await scanAndWrite(today, decision.scanTodayUnplanned, isManual, true);
  // Tomorrow (Fix 2): descend orders 10am-midnight, but only scan tomorrow's LOADS
  // 8pm-midnight (they don't exist earlier) — avoids ~13 empty load scans/day.
  if (decision.scanTomorrowLoads || decision.scanTomorrowUnplanned) {
    await scanAndWrite(tomorrow, decision.scanTomorrowUnplanned, isManual, decision.scanTomorrowLoads);
  }

  try { dayCount = await readCallCounter(today); } catch { /* */ }
  logScan('none', true,
    { l: true, u: decision.scanTodayUnplanned },
    { l: decision.scanTomorrowLoads, u: decision.scanTomorrowUnplanned });
  return json({ ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', decision, totalMs: Date.now() - startedAt, dates: results });
}
