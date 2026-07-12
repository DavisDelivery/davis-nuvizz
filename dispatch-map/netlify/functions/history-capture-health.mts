// history-capture-health.mts
//
// READ endpoint for the Diagnostics "Capture health" strip, plus a per-date
// reference-eligibility diagnostic. ZERO NuVizz calls.
//
//   GET  /.netlify/functions/history-capture-health
//        → trailing-21-day capture health. CHEAP: one manifest list + one
//          failures list, NO stop scans. Classifies each date as
//          sealed | healed | tombstone | failed | missing (weekday, no manifest
//          and no failure record) | idle_weekend.
//        After the seal fix, an unsealed day always leaves a failure record, so
//        "stops without a manifest" surfaces here without a stop scan.
//
//   GET  ?diagnose=YYYY-MM-DD
//        → why the reference miner saw a date the way it did. Reads that one
//          day's stops (an explicit stop scan, not part of the cheap strip) and
//          reports the eligibility breakdown + the miner's skip reasons. This is
//          the Phase-4 tool for the 2026-07-03 zero-mine question.
import { isFirestoreEnabled, listDocs } from './lib/firestore.mts';
import { HISTORY_COLLECTION, listStops } from './lib/history-store.mts';
import { listCaptureFailures, classifyCaptureDay } from './lib/history-seal.mts';
import { loadKeyForStop, extractReferenceRoutes } from './lib/routing-reference.mts';
import { loadEngineConfig } from './lib/routing-engine-config.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_DAYS = 21;

function etDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

// ── Phase 4: reference-eligibility diagnostic for one date ───────────────────
async function diagnoseDate(date: string): Promise<any> {
  const stops = await listStops(TENANT, date);
  const cfg = await loadEngineConfig(TENANT);
  const finite = (v: any) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

  const tally = {
    total: stops.length,
    planned: stops.filter((s) => s.isPlanned === true).length,
    unplanned: stops.filter((s) => s.isUnplanned === true || s.isPlanned !== true).length,
    terminal: stops.filter((s) => s.isTerminal === true).length,
    attempt: stops.filter((s) => s.isAttempt === true).length,
    eligible: stops.filter((s) => s.isPlanned === true && s.isTerminal !== true && s.isUnplanned !== true && s.isAttempt !== true).length,
    with_load_key: stops.filter((s) => !!loadKeyForStop(s)).length,
    with_numeric_routeseq: stops.filter((s) => finite(s.routeSeq)).length,
    with_delivered_dttm: stops.filter((s) => String(s.deliveredDTTM ?? '').trim()).length,
    with_coords: stops.filter((s) => finite(s.lat) && finite(s.lng)).length,
  };

  // Group eligible stops by load to show per-load stop counts (min_route_stops gate).
  const byLoad = new Map<string, number>();
  for (const s of stops) {
    if (!(s.isPlanned === true && s.isTerminal !== true && s.isUnplanned !== true && s.isAttempt !== true)) continue;
    const k = loadKeyForStop(s);
    if (!k) continue;
    byLoad.set(k, (byLoad.get(k) || 0) + 1);
  }
  const loadSizes = [...byLoad.entries()].map(([load_key, n]) => ({ load_key, stops: n })).sort((a, b) => b.stops - a.stops);

  const { routes, skipped } = extractReferenceRoutes(stops, { tenant: TENANT, date, cfg });

  // Plain-language conclusion.
  let conclusion: string;
  if (routes.length > 0) conclusion = `mined ${routes.length} reference route(s) — not a zero-mine day`;
  else if (tally.total === 0) conclusion = 'no stored stops for this date';
  else if (tally.eligible === 0) conclusion = 'zero eligible stops (all terminal / unplanned / attempt, or none planned)';
  else if (tally.with_load_key === 0) conclusion = 'eligible stops exist but none carry a load identity (no loadNbr and no routeName+driverUserName)';
  else if (loadSizes.every((l) => l.stops < cfg.min_route_stops)) conclusion = `every load is under min_route_stops=${cfg.min_route_stops} (largest load has ${loadSizes[0]?.stops ?? 0} eligible stops)`;
  else if (tally.with_numeric_routeseq === 0 && tally.with_delivered_dttm === 0) conclusion = 'no numeric routeSeq and no deliveredDTTM — neither planned nor executed ordering available';
  else conclusion = `eligible loads exist but all were skipped by the miner — see skipped reasons`;

  return {
    date,
    min_route_stops: cfg.min_route_stops,
    tally,
    eligible_loads: loadSizes,
    mined_routes: routes.length,
    skipped,
    conclusion,
  };
}

// ── Phase 5: trailing-window capture health (cheap) ──────────────────────────
async function captureHealth(): Promise<any> {
  const anchor = addDaysUTC(etDateString(new Date()), -1); // ET-yesterday
  const from = addDaysUTC(anchor, -(WINDOW_DAYS - 1));

  const manifests = await listDocs(HISTORY_COLLECTION);
  const byDate = new Map<string, any>();
  for (const m of manifests) {
    const id = String(m?._id || '');
    if (!id.startsWith(`${TENANT}__`)) continue;
    const date = id.slice(TENANT.length + 2);
    if (DATE_RE.test(date)) byDate.set(date, m);
  }
  const failures = await listCaptureFailures(TENANT);
  const failByDate = new Map<string, any>();
  for (const f of failures) if (f?.date) failByDate.set(String(f.date), f);

  const days: any[] = [];
  const summary = { sealed: 0, healed: 0, tombstone: 0, failed: 0, missing: 0, idle_weekend: 0 };
  for (let d = from; d <= anchor; d = addDaysUTC(d, 1)) {
    const m = byDate.get(d);
    const f = failByDate.get(d);
    const weekend = isWeekend(d);
    const { state } = classifyCaptureDay(m, f, weekend);
    let detail: any = null;
    if (state === 'tombstone') detail = { reason: m.tombstone_reason ?? null };
    else if (state === 'healed' || state === 'sealed') detail = { counts: m.counts ?? null };
    else if (state === 'failed') detail = f
      ? { stage: f.stage ?? null, error: f.error ?? null, at: f.at ?? null }
      : { stage: 'unsealed_manifest', error: 'manifest present but not verified' };
    summary[state] = (summary[state] || 0) + 1;
    days.push({ date: d, weekday: weekend ? 'weekend' : 'weekday', state, detail });
  }

  return { ok: true, tenant: TENANT, window: { from, to: anchor, days: WINDOW_DAYS }, summary, days };
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  try {
    const url = new URL(req.url);
    const diagnose = url.searchParams.get('diagnose');
    if (diagnose) {
      if (!DATE_RE.test(diagnose)) {
        return new Response(JSON.stringify({ ok: false, error: 'bad ?diagnose date' }), { status: 400, headers });
      }
      return new Response(JSON.stringify({ ok: true, ...(await diagnoseDate(diagnose)) }), { status: 200, headers });
    }
    return new Response(JSON.stringify(await captureHealth()), { status: 200, headers });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'capture-health failed' }), { status: 500, headers });
  }
};
