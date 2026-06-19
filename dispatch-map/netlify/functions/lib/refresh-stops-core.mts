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

import { scanDate, todayUTC, scansEnabled, deriveFleetSummary, estimateLoadRange, buildScanState, shadowWouldProbe, selectLoadProbeTargets, groupLoadMembers, estimateStopFrontier, unplannedFloor, FLOOR_MARGIN, loadNbrToInt, stopNbrToInt } from './nuvizz-scan.mts';
import { loadProbeParity, frontierParity, loadMembershipDelta, dateSliceMismatch } from './scan-parity.mts';
import { isFirestoreEnabled, writeStops, writeFleetIndex, getDoc, markScanState, readCallStats, readCircuit, readScanState, writeScanState } from './firestore.mts';
import { breakerTripped, scanIntervalElapsed, breakerMode } from './nuvizz-request.mts';
import { scanDecision, isInRoutingWindow } from './scan-schedule.mts';

// Reuse the CANONICAL integer parsers from nuvizz-scan so the parity log's
// load/stop numbers are extracted identically to selectLoadProbeTargets /
// buildScanState (a divergent local parser could emit false MISSED_LOADS).
const loadNbrInt = loadNbrToInt;
const stopNbrInt = stopNbrToInt;

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
  // Phase 2 — lean load discovery (known-active + buffer + gap sweep). OFF by
  // default; flip NUVIZZ_LEAN_DISCOVERY=on only AFTER preview stop-set parity is
  // confirmed. Off = the proven wide-window probe, unchanged.
  const LEAN_DISCOVERY = (process.env.NUVIZZ_LEAN_DISCOVERY || '').toLowerCase() === 'on';

  // Read today's last LOAD scan time — this is what drives the elapsed-time
  // cadence (Fix 1). Also read the shared call counter + breaker for the log line.
  let lastLoadScanAt: string | null = null;
  let dayCount = 0;
  let byRoute: Record<string, number> = {};
  let breakerState = false;
  const mode = breakerMode();
  const refreshOps = async () => {
    try { const st = await readCallStats(today); dayCount = st.count; byRoute = st.byRoute; } catch { /* best effort */ }
    try { breakerState = (await readCircuit()).open; } catch { /* best effort */ }
  };
  if (fsOn) {
    try {
      const m = (await getDoc(`nuvizz_stop_index/${TENANT}__${today}`)) as any;
      lastLoadScanAt = m?.lastLoadScanAt ?? m?.last_scanned_at ?? null;
    } catch { /* treat as never-scanned */ }
    await refreshOps();
  }

  const decision = scanDecision(now, isManual, lastLoadScanAt);

  // Fix 4 — exactly ONE structured line per invocation, so "why didn't it scan"
  // is answerable from the log. today/tomorrow report the DECISION's feed intent.
  // Now also carries today's NuVizz volume: total, per-route, breaker + mode.
  const fmtEl = (m: number) => (m === Infinity ? 'inf' : String(Math.round(m)));
  const fmtByRoute = (br: Record<string, number>) => {
    const parts = Object.entries(br).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
    return parts.length ? parts.join(',') : '-';
  };
  const no = { l: false, u: false };
  const logScan = (skip: string, act: boolean, t: { l: boolean; u: boolean }, m: { l: boolean; u: boolean }, extra = '') => {
    console.log(`[scan] trigger=${trigger} etHour=${decision.etHour} etMin=${decision.etMin} act=${act} today={loads:${t.l},unplanned:${t.u}} tomorrow={loads:${m.l},unplanned:${m.u}} lastLoadScanAt=${lastLoadScanAt || 'null'} elapsedMin=${fmtEl(decision.elapsedMin)} intervalMin=${decision.intervalMin} dayCount=${dayCount} ceiling=${ceiling} mode=${mode} breaker=${breakerState} byRoute=${fmtByRoute(byRoute)} skip=${skip}${extra}`);
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
      // Read this date's existing roster ONCE — used for BOTH Phase 2 lean planning
      // (as the current known-active set) and the Phase 1 shadow write below.
      const priorState = includeLoads ? await readScanState(date) : null;

      // Phase 2 (gated by NUVIZZ_LEAN_DISCOVERY=on): probe only known-active loads +
      // forward buffer + periodic gap sweep instead of the ±window. null plan ⇒
      // leave loadTargets undefined ⇒ scanDate falls back to the wide window.
      let loadTargets: number[] | null = null;
      if (LEAN_DISCOVERY && includeLoads) {
        try {
          const plan = selectLoadProbeTargets(priorState, {
            inWindow: isInRoutingWindow(decision.etHour),
            scanCount: priorState?.scanCount || 0,
            fwdIn: 50, fwdOut: 10, gapSweepEvery: 3,
          });
          if (plan) {
            loadTargets = plan.numbers;
            console.log(`[scan-lean] date=${date} mode=${plan.mode} probe=${plan.numbers.length} active=${plan.activeLoads} buffer=${plan.forwardBuffer} gapSweep=${plan.gapSweep}`);
          } else {
            console.log(`[scan-lean] date=${date} mode=cold-fallback (no roster yet) → wide window`);
          }
        } catch (e: any) { console.warn(`[scan-lean] ${date} planning failed, wide window: ${e?.message}`); }
      }

      // Phase 1 (shadow): capture the load-number window THIS cycle is about to
      // probe BEFORE scanDate calibrates the in-memory cache (serverless runs are
      // almost always cold → this is the real ~600-wide window). Only meaningful
      // when NOT using lean targets.
      const preRange = (includeLoads && !loadTargets) ? estimateLoadRange(date) : null;
      // Phase 3 lean unplanned: only on a WARM cycle (we have a roster + high-water);
      // descend only NEW stop numbers above the last high-water. Cold cycles do the
      // full descent (establishes the high-water), same as the wide load fallback.
      const leanUnplanned = LEAN_DISCOVERY && includeUnplanned && !!loadTargets && (priorState?.highWaterUnplannedStopNbr != null);
      const unplannedOpts: any = {};
      if (isManual && includeUnplanned) unplannedOpts.maxProbes = 800;
      // Bound on the UNPLANNED-only high-water so planned stop numbers can't ratchet
      // the floor past genuine new orders (audit finding).
      if (leanUnplanned) unplannedOpts.sinceStopNbr = priorState!.highWaterUnplannedStopNbr;
      const scan = await scanDate(date, {
        includeUnplanned,
        includeLoads,
        loadTargets,
        unplanned: Object.keys(unplannedOpts).length ? unplannedOpts : undefined,
      });
      // partial* : in lean mode we re-pulled only a SUBSET of each feed — tell
      // writeStops to PRESERVE the stops it didn't re-scan (terminal loads /
      // older still-unplanned orders) so lean never prunes already-known stops.
      const meta = await writeStops(TENANT, date, scan.stops, scan.scannedAt, { includeUnplanned, includeLoads, partialLoads: !!loadTargets, partialUnplanned: leanUnplanned });
      // Only rebuild the fleet (load) index when we actually scanned loads — an
      // unplanned-only run would otherwise wipe the load index with an empty scan.
      if (includeLoads) {
        const fleet = deriveFleetSummary(scan.stops, scan.loadHeaders);
        await writeFleetIndex(TENANT, date, fleet.loads, fleet.summary, fleet.driverIndex, scan.scannedAt);
      }
      // Phase 1 (shadow mode): persist scan_state + log what lean discovery WOULD
      // probe (known-active loads + buffer) vs the wide window we ACTUALLY probed.
      // NO probing change yet — this de-risks Phase 2. Best-effort; never fails a scan.
      if (includeLoads) {
        try {
          const state = buildScanState(date, scan.stops, priorState, scan.scannedAt, {
            descentComplete: scan.descentComplete,
            observedFrontierStopNbr: scan.observedFrontierStopNbr,
          });
          await writeScanState(date, state);
          const inWindow = isInRoutingWindow(decision.etHour);
          const wp = shadowWouldProbe(state, { inWindow, fwdIn: 50, fwdOut: 10 });
          const windowSize = preRange ? (preRange.endNbr - preRange.startNbr + 1) : (loadTargets ? loadTargets.length : null);
          console.log(`[scan-shadow] date=${date} lean=${!!loadTargets} knownLoads=${state.knownLoads.length} active=${wp.activeLoads} terminal=${wp.terminalLoads} routes=${Object.keys(state.routeMap).length} minLoad=${state.minLoadNbr} maxLoad=${state.maxLoadNbr} highWaterStop=${state.highWaterStopNbr} inWindow=${inWindow} WOULD_PROBE_LOADS=${wp.wouldProbe} (active=${wp.activeLoads}+buffer=${wp.forwardBuffer}) PROBED=${windowSize} scanCount=${state.scanCount}`);

          // ── Step 1 parity (SHADOW; logging only — lean/frontier remain OFF) ──
          // Set-membership comparison: what lean WOULD have probed from the PRIOR
          // roster vs what the wide scan actually found. This is the real
          // "would lean miss something?" gate. Self-contained try/catch so a
          // parity bug can never affect the scan or the state write above.
          try {
            const foundLoads = [...new Set(
              scan.stops.filter((s: any) => s.isPlanned && s.loadNbr)
                .map((s: any) => loadNbrInt(s.loadNbr)).filter((n: any): n is number => n != null),
            )];
            const leanPlan = selectLoadProbeTargets(priorState, {
              inWindow, scanCount: priorState?.scanCount || 0, fwdIn: 50, fwdOut: 10, gapSweepEvery: 3,
            });
            const lp = loadProbeParity(leanPlan ? leanPlan.numbers : null, foundLoads);

            const foundUnplanned = scan.includeUnplanned
              ? [...new Set(scan.stops.filter((s: any) => s.isPlanned === false)
                  .map((s: any) => stopNbrInt(s.stopNbr)).filter((n: any): n is number => n != null))]
              : [];
            const hwu = priorState?.highWaterUnplannedStopNbr ?? null;
            const floor = (scan.includeUnplanned && hwu != null)
              ? unplannedFloor(estimateStopFrontier(date) - FLOOR_MARGIN, hwu) : null;
            const fp = frontierParity(floor, foundUnplanned, priorState?.unplannedStopNbrs);

            const mem = loadMembershipDelta(priorState?.loadMembers, groupLoadMembers(scan.stops));
            const dmax = (state.maxLoadNbr != null && priorState?.maxLoadNbr != null)
              ? state.maxLoadNbr - priorState.maxLoadNbr : null;
            const dateAudit = scan.includeUnplanned
              ? dateSliceMismatch(scan.stops.filter((s: any) => s.isPlanned === false).map((s: any) => s.scheduledFrom), date)
              : { mismatch: 0, unauditable: 0 };

            console.log(`[scan-parity] date=${date} loadMode=${lp.mode} foundLoads=${lp.foundCount} leanTargets=${lp.targetCount} MISSED_LOADS=${JSON.stringify(lp.missed)} emptyProbed=${lp.extra.length} | frontierFloor=${fp.floor ?? 'na'} foundUnplanned=${fp.foundCount} BELOW_FLOOR_NEW=${JSON.stringify(fp.belowFloorNew)} belowFloorKnown=${fp.belowFloorKnown.length} | LOAD_REMOVED=${mem.removed.length} LOAD_ADDED=${mem.added.length} | dMaxLoad=${dmax ?? 'na'} dateSliceMismatch=${dateAudit.mismatch} dateUnauditable=${dateAudit.unauditable} descentComplete=${scan.descentComplete ?? 'na'}`);
            if (lp.missed.length) console.warn(`[scan-parity] date=${date} ⚠ LEAN WOULD MISS LOADS ${JSON.stringify(lp.missed)}`);
            if (fp.belowFloorNew.length) console.warn(`[scan-parity] date=${date} ⚠ FRONTIER WOULD MISS NEW UNPLANNED ${JSON.stringify(fp.belowFloorNew.slice(0, 20))}${fp.belowFloorNew.length > 20 ? ' …' : ''}`);
            if (mem.removed.length) console.log(`[scan-parity] date=${date} off-load removals=${JSON.stringify(mem.removed.slice(0, 20))}`);
          } catch (e: any) { console.warn(`[scan-parity] ${date} failed: ${e?.message}`); }
        } catch (e: any) { console.warn(`[scan-shadow] ${date} failed: ${e?.message}`); }
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
    await refreshOps();
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

  await refreshOps();
  logScan('none', true,
    { l: true, u: decision.scanTodayUnplanned },
    { l: decision.scanTomorrowLoads, u: decision.scanTomorrowUnplanned });
  return json({ ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', decision, totalMs: Date.now() - startedAt, dates: results });
}
