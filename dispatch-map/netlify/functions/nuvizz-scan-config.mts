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

import { isFirestoreEnabled, readScanConfig, writeScanConfig, getDoc, readScanKindStamps, readScanRuns, readCallStats, readCircuit, readScanRefusal, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { readBackgroundRefusals } from './lib/background-gate.mts';
import { clampScanConfig, effectiveScanConfig, scanConfigDefaults, SCAN_CONFIG_BOUNDS, scanDecision } from './lib/scan-schedule.mts';
import { clampScanRules, defaultScanRules, dueKinds, overrideCadenceSkip, scanPath } from './lib/scan-plan.mts';
import { attributeSpend } from './lib/scan-attribution.mts';
import { breakerMode, reportedDailyCeiling } from './lib/nuvizz-request.mts';

const TENANT = process.env.NUVIZZ_TENANT || 'davis';
// Matches the `runs` list below, which shows the last 40 for the same reason: enough to cover
// the morning somebody is asking about, short enough to read.
const REFUSAL_ROWS_SHOWN = 40;

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
 *
 * It also answers the OTHER version of the same question — "did somebody get refused?" — by
 * serving nuvizz_ops/background_refusals/rows (`backgroundRefusals`) and the most recent
 * refused "Scan now" (`lastScanRefusal`). A refused background job is invisible by
 * construction: the platform has already answered its caller 202 and thrown the 401 away, so
 * without this the only evidence lives in a Firestore document nothing reads.
 */
async function explain(): Promise<any> {
  const now = new Date();
  const today = etDayString(now);
  const stored = await readScanConfig().catch(() => ({}));
  const cfg = clampScanConfig(stored || {});
  const rulesStored = clampScanRules((cfg as any)?.rules);
  const rules = rulesStored.length ? rulesStored : defaultScanRules();

  const [meta, kindStamps, runs, stats, circuit, bgRefusals, scanRefusal] = await Promise.all([
    getDoc(`nuvizz_stop_index/${TENANT}__${today}`).catch(() => null) as Promise<any>,
    readScanKindStamps().catch(() => ({})),
    readScanRuns().catch(() => []),
    readCallStats(today).catch(() => ({ count: 0, byHour: {}, byTrigger: {}, byApp: {} } as any)),
    readCircuit().catch(() => ({ open: false } as any)),
    // WHAT HAS BEEN REFUSED — the half of lib/background-gate.mts that was write-only.
    // Sixteen of the eighteen gates route their ONLY durable record into
    // nuvizz_ops/background_refusals/rows, and until this line nothing in the repo read it
    // back: the record existed solely for whoever thought to open the Firebase console, which
    // is not somewhere Chad or a dispatcher has ever been. This endpoint is already the ops
    // dry run ("why didn't it scan?"), so "what did it refuse, and to whom" belongs beside it.
    // No limit: the ledger is already bounded at 100 rows and listDocs has fetched all of them
    // either way, so capping HERE would only make `count` below a lie about how many there are.
    readBackgroundRefusals().catch(() => [] as any[]),
    readScanRefusal().catch(() => null),
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
      // WHERE THE DAY WENT, joined here rather than by whoever reads this. Every hour with
      // its total, the part the scan runs account for, the remainder (live dispatcher writes
      // — real activity that no run knows about), and for the busiest hours the one run that
      // dominated with a sentence saying why. See lib/scan-attribution.
      attribution: attributeSpend(runs as any, stats.byHour ?? {}, { etDate: today }),
    },
    killSwitch: {
      env: String(process.env.NUVIZZ_SCANS_ENABLED ?? '').toLowerCase() === 'false',
      config: (cfg as any)?.scansEnabled === false,
    },
    rules,
    rulesSource: rulesStored.length ? 'stored' : 'shipped-default',
    runs: (runs || []).slice(-40).reverse(),
    unfinishedRuns: unfinished,
    // A job that was REFUSED did not run, and a scheduler that reports "nothing was due" for a
    // job somebody hand-fired is answering a different question than the one being asked. Both
    // shapes are here: every background refusal (newest first, with the age so "this morning"
    // is legible), and the one refused "Scan now" the board's own poll surfaces as
    // `lastScanRefusal` — repeated here so the two screens cannot disagree about it.
    backgroundRefusals: {
      // How many the ledger HOLDS, not how many are printed below — a count that silently means
      // "up to the display cap" is the kind of number somebody reasons from and gets wrong.
      count: bgRefusals.length,
      showing: Math.min(bgRefusals.length, REFUSAL_ROWS_SHOWN),
      // Empty is the healthy state and says so, rather than reading as a broken query.
      note: bgRefusals.length
        ? 'Background jobs refused a caller. Netlify answers a *-background function 202 and discards the 401, so this ledger is the record — the caller was told nothing.'
        : 'No background job has refused a caller. (With AUTH_REQUIRED off every gate here is inert, so an empty ledger is the expected state.)',
      // The stored row carries the caller's IP for a real investigation; this GET is NOT gated
      // (only the POST is), so it must not be the thing that publishes visitor IPs to anyone
      // who guesses the query string. Drop it here — the full row is in Firestore for the day
      // somebody genuinely needs it.
      rows: bgRefusals.slice(0, REFUSAL_ROWS_SHOWN).map(({ ip, ...r }: any) => ({ ...r, ageMin: ageMin(r?.at) })),
    },
    lastScanRefusal: scanRefusal ? { ...scanRefusal, ageMin: ageMin(scanRefusal.at) } : null,
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
      // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
      const gate = await requireUser(req, { role: 'admin' });
      if (!gate.ok) return gate.response;
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
