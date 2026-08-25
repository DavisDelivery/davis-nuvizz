// nuvizz-scan-config.mts
//
// Read + edit the live scan schedule from the Diagnostics UI.
//   GET  /.netlify/functions/nuvizz-scan-config
//        → { ok, config, stored, defaults, bounds }
//        config   = effective schedule the scanner runs (defaults overlaid with stored)
//        stored   = just the persisted overrides (so the UI can show what's customized)
//        defaults = env/hardcoded baseline (what an empty doc falls back to)
//        bounds   = per-field [min,max] the editor clamps to
//   POST /.netlify/functions/nuvizz-scan-config   body: partial ScanConfig
//        → validates + clamps to bounds, persists to nuvizz_ops/scan_config, returns
//          the new effective config. The scheduled scanner reads this each run, so an
//          edit takes effect on the next cron fire (no redeploy).
//
// Validation/clamping is the SAME pure helper the scanner uses (scan-schedule.mts),
// so the UI can never persist a value the scanner would reject.

import { isFirestoreEnabled, readScanConfig, writeScanConfig, getDoc, readScanKindStamps, readScanRuns, readCallStats, readCircuit, etDayString } from './lib/firestore.mts';
import { clampScanConfig, effectiveScanConfig, scanConfigDefaults, SCAN_CONFIG_BOUNDS, scanDecision } from './lib/scan-schedule.mts';
import { clampScanRules, defaultScanRules, dueKinds, overrideCadenceSkip, scanPath } from './lib/scan-plan.mts';
import { breakerMode, reportedDailyCeiling } from './lib/nuvizz-request.mts';

const TENANT = process.env.NUVIZZ_TENANT || 'davis';

/**
 * WHY DIDN'T IT SCAN? — the dry run, answered without scanning.
 *
 * Chad, 10:02 on a Tuesday, three feed rows all reading "3 hr ago": "Something is very wrong
 * with my scan schedule." Nothing in the app could answer that. The scheduler's whole
 * reasoning existed only as one console line per fire in Netlify's log viewer, and the app is
 * what he has open — so the honest answer to a question about a job that runs 288 times a day
 * on its own was "let me go read the logs."
 *
 * This runs the REAL decision functions — scanDecision, dueKinds, overrideCadenceSkip,
 * scanPath, the same ones refresh-stops-core calls — against the live stamps, and reports what
 * the next fire would do and why. ZERO NuVizz calls: every input is Firestore or arithmetic.
 * Beside it sits the ledger of what recent fires ACTUALLY did, and any run with a startedAt
 * and no finishedAt is called out by name — that is the shape of the failure where the pulls
 * land, the per-kind clocks advance, and the ~700-stop board write never finishes, so the
 * schedule reads healthy while the board quietly stops moving.
 */
async function explain(): Promise<any> {
  const now = new Date();
  const today = etDayString(now);
  const stored = await readScanConfig().catch(() => ({}));
  const cfg = clampScanConfig(stored || {});
  const rulesStored = clampScanRules((cfg as any)?.rules);
  const rules = rulesStored.length ? rulesStored : defaultScanRules();

  const [meta, kindStamps, runs, stats, circuit] = await Promise.all([
    getDoc(`nuvizz_stop_index/${TENANT}__${today}`).catch(() => null) as Promise<any>,
    readScanKindStamps().catch(() => ({})),
    readScanRuns().catch(() => []),
    readCallStats(today).catch(() => ({ count: 0, byHour: {}, byTrigger: {}, byApp: {} } as any)),
    readCircuit().catch(() => ({ open: false } as any)),
  ]);

  const lastLoadScanAt = meta?.lastLoadScanAt ?? meta?.last_scanned_at ?? null;
  const legacy = scanDecision(now, false, lastLoadScanAt, cfg);
  const due = dueKinds(legacy.weekday, legacy.etHour, rules, kindStamps as any, now.getTime());
  const decision = overrideCadenceSkip(legacy, due.planned.due, due.completed.due, due.roster.due);
  const path = scanPath(decision.act, {
    plannedDue: due.planned.due, completedDue: due.completed.due, rosterDue: due.roster.due,
  });

  const ageMin = (iso: any) => {
    const t = iso ? Date.parse(String(iso)) : NaN;
    return Number.isFinite(t) ? Math.round((now.getTime() - t) / 60000) : null;
  };
  // An unfinished row is the diagnosis, so it gets its own list rather than being left for
  // somebody to notice. A run still inside its own budget is simply in flight, not stuck.
  const STUCK_AFTER_MIN = 16;
  const unfinished = (runs || []).filter((r: any) => r?.startedAt && !r?.finishedAt
    && (ageMin(r.startedAt) ?? 0) > STUCK_AFTER_MIN);

  return {
    ok: true,
    now: { iso: now.toISOString(), etDate: today, etHour: decision.etHour, etMin: decision.etMin, weekday: decision.weekday },
    wouldDoNow: {
      path,
      act: decision.act,
      skip: decision.skip,
      reason: decision.reason,
      legacyGate: { intervalMin: legacy.intervalMin, elapsedMin: legacy.elapsedMin === Infinity ? null : Math.round(legacy.elapsedMin), skip: legacy.skip, reason: legacy.reason },
      due,
    },
    // What the BOARD is serving — the three rows on the status card, in one place, with ages.
    // These move only when a board write lands, which is exactly what makes them the right
    // thing to compare against the per-kind clocks below.
    board: {
      date: today,
      lastScannedAt: meta?.last_scanned_at ?? null, lastScannedAgeMin: ageMin(meta?.last_scanned_at),
      lastLoadScanAt, lastLoadScanAgeMin: ageMin(lastLoadScanAt),
      lastUnplannedScanAt: meta?.lastUnplannedScanAt ?? null, lastUnplannedScanAgeMin: ageMin(meta?.lastUnplannedScanAt),
      lastCompletedScanAt: meta?.lastCompletedScanAt ?? null, lastCompletedScanAgeMin: ageMin(meta?.lastCompletedScanAt),
      count: meta?.count ?? null, plannedCount: meta?.plannedCount ?? null, unplannedCount: meta?.unplannedCount ?? null,
      scanState: meta?.scanState ?? null,
    },
    // The SCHEDULER's own clocks. When these are fresh and the board's are not, the scan is
    // starting and not finishing — the two disagreeing is the whole signal.
    kindStamps: Object.fromEntries(Object.entries(kindStamps as any).map(([k, v]) => [k, { at: v, ageMin: ageMin(v) }])),
    spend: {
      today: stats.count ?? 0,
      ceiling: reportedDailyCeiling((cfg as any)?.dailyCeiling),
      breakerMode: breakerMode(),
      circuitOpen: !!circuit?.open,
      circuitReason: circuit?.reason ?? null,
      byHour: stats.byHour ?? {},
      byTrigger: stats.byTrigger ?? {},
      byApp: stats.byApp ?? {},
    },
    killSwitch: {
      env: String(process.env.NUVIZZ_SCANS_ENABLED ?? '').toLowerCase() === 'false',
      config: (cfg as any)?.scansEnabled === false,
    },
    rules,
    rulesSource: rulesStored.length ? 'stored' : 'shipped-default',
    runs: (runs || []).slice(-40).reverse(),
    unfinishedRuns: unfinished,
  };
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  if (!isFirestoreEnabled()) {
    // No Firestore (e.g. preview without FIREBASE_SA): still serve the defaults so the
    // editor renders, but it can't persist.
    return new Response(JSON.stringify({
      ok: true, persistent: false, config: effectiveScanConfig({}), stored: {},
      defaults: scanConfigDefaults(), bounds: SCAN_CONFIG_BOUNDS,
    }), { status: 200, headers: cors });
  }

  try {
    if (req.method === 'GET') {
      // ?explain=1 — the dry run. Read-only, zero NuVizz calls.
      if (new URL(req.url).searchParams.get('explain')) {
        return new Response(JSON.stringify(await explain()), { status: 200, headers: cors });
      }
      const stored = await readScanConfig();
      return new Response(JSON.stringify({
        ok: true, persistent: true, config: effectiveScanConfig(stored), stored,
        defaults: scanConfigDefaults(), bounds: SCAN_CONFIG_BOUNDS,
      }), { status: 200, headers: cors });
    }

    if (req.method === 'POST') {
      let body: any;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), { status: 400, headers: cors }); }

      const clean = clampScanConfig(body);
      // Merge onto any existing overrides so a partial edit doesn't drop other fields,
      // then stamp metadata. The scanner re-clamps on read, so this is safe regardless.
      const prior = await readScanConfig().catch(() => ({}));
      const toStore = { ...prior, ...clean, updatedAt: new Date().toISOString(), updatedBy: String(body?.updatedBy || 'diagnostics-ui').slice(0, 120) };
      await writeScanConfig(toStore);

      return new Response(JSON.stringify({
        ok: true, persistent: true, config: effectiveScanConfig(toStore), stored: toStore,
        defaults: scanConfigDefaults(), bounds: SCAN_CONFIG_BOUNDS,
      }), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ ok: false, error: 'GET or POST only' }), { status: 405, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'scan-config failed' }), { status: 500, headers: cors });
  }
};
