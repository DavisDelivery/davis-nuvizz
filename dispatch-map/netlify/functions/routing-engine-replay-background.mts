// routing-engine-replay-background.mts
//
// HISTORICAL REPLAY for the learned routing engine — day-one trend data.
// Walks warehouse dates ASCENDING and runs the exact same shadow scoring as
// the nightly job, so the Engine tab's trend chart opens with months of
// history instead of an empty axis.
//
// NO LEAKAGE: scoring date D uses only reference routes with date < D (the
// strict filter is applied per-route inside the core, and the pre-loaded
// library handed in here is filtered again there). Dates with fewer than
// min_prior_reference_days distinct reference days before them are skipped —
// the engine isn't judged before it has a library to learn from.
//
// Chunked to stay inside the 15-min background budget: stops cleanly when the
// time budget is spent and reports exactly how far it got; re-invoke with
// ?from=<next_date> to continue. Already-scored dates (same ENGINE_VERSION)
// are skipped unless ?force=1, so repeated invocations converge.
//
// Ignores the ROUTING_ENGINE kill switch — invoking this by hand IS the
// intent. Reads history_days + routing_reference_routes + roster only; writes
// route_proposals + route_proposals_daily only. ZERO NuVizz calls.
//
//   POST /.netlify/functions/routing-engine-replay-background      → ALL captured days
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → inclusive range
//     ?force=1                        → rescore even at the current version
import { isFirestoreEnabled, listDocs } from './lib/firestore.mts';
import { HISTORY_COLLECTION, capturedDatesFromManifests } from './lib/history-store.mts';
import { ENGINE_VERSION, loadEngineConfig } from './lib/routing-engine-config.mts';
import { REFERENCE_ROUTES_COLLECTION, type ReferenceRouteDoc } from './lib/routing-reference.mts';
import { runShadowForDate } from './lib/routing-engine-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Leave headroom under Netlify's 15-min background budget for the final
// rollup writes + response.
const TIME_BUDGET_MS = 12 * 60 * 1000;

async function listCapturedDates(): Promise<string[]> {
  return capturedDatesFromManifests(await listDocs(HISTORY_COLLECTION), TENANT);
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  const t0 = Date.now();
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const force = url.searchParams.get('force') === '1';

  let dates = await listCapturedDates();
  if (from && DATE_RE.test(from)) dates = dates.filter((d) => d >= from);
  if (to && DATE_RE.test(to)) dates = dates.filter((d) => d <= to);

  const cfg = await loadEngineConfig(TENANT);

  // Load the whole reference library ONCE; the core re-filters `date < D` per
  // scored route, so walking ascending with one in-memory library is safe.
  const allRefs = (await listDocs(REFERENCE_ROUTES_COLLECTION))
    .filter((r: any) => r?.tenant === TENANT) as ReferenceRouteDoc[];
  const refDates = [...new Set(allRefs.map((r) => String(r.date)))].sort();
  console.log(`[engine-replay] v${ENGINE_VERSION}: ${dates.length} candidate date(s), ` +
    `${allRefs.length} reference route(s) across ${refDates.length} day(s)`);

  const scored: Array<{ date: string; routes_scored: number; mean_score: number | null }> = [];
  const skippedTooEarly: string[] = [];
  const skippedExisting: string[] = [];
  let stoppedAt: string | null = null;

  for (const date of dates) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { stoppedAt = date; break; }
    const priorRefDays = refDates.filter((d) => d < date).length;
    if (priorRefDays < cfg.min_prior_reference_days) {
      skippedTooEarly.push(date);
      continue;
    }
    const summary = await runShadowForDate(TENANT, date, {
      references: allRefs.filter((r) => String(r.date) < date),
      force,
      cfg,
    });
    if (summary.skipped_existing) {
      skippedExisting.push(date);
    } else {
      scored.push({ date, routes_scored: summary.routes_scored, mean_score: summary.mean_score });
      console.log(`[engine-replay] ${date}: ${summary.routes_scored} scored, mean ${summary.mean_score?.toFixed(4) ?? '—'}, ${summary.unguided_count} unguided`);
    }
  }

  const summary = {
    ok: true,
    tenant: TENANT,
    engine_version: ENGINE_VERSION,
    dates_considered: dates.length,
    dates_scored: scored.length,
    dates_skipped_too_early: skippedTooEarly.length,
    dates_skipped_existing: skippedExisting.length,
    first_skipped_too_early: skippedTooEarly[0] ?? null,
    last_scored: scored.length ? scored[scored.length - 1].date : null,
    stopped_at: stoppedAt, // non-null → re-invoke with ?from=<this> to continue
    scored,
    ms: Date.now() - t0,
  };
  console.log('[engine-replay] done:', JSON.stringify({ ...summary, scored: undefined }));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
