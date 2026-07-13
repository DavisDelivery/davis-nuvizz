// routing-engine-plan-replay-background.mts
//
// PHASE 2 historical replay of the ASSIGNMENT plan — day-one agreement trend.
// Walks warehouse dates ASCENDING and runs runPlanForDate for each, so the
// Engine tab's Assignment view opens with history instead of an empty axis.
//
// NO LEAKAGE: the engine's inputs (envelopes, affinity, service times, fleet
// chain) are computed as-of D by the pure Phase-3 functions, which filter their
// preloaded observation docs to dates strictly < D. The whole observation set is
// loaded ONCE and handed in; the < D filter lives inside the pure functions
// (same discipline as the Phase 1 replay).
//
// Skips a date below min_prior_reference_days, or with NO driver-day history
// before it (no envelopes to reason from). Chunked to the 15-min budget; reports
// stopped_at for continuation. Ignores ROUTING_ENGINE=off (running it IS intent).
//
//   POST /.netlify/functions/routing-engine-plan-replay-background   → ALL days
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → inclusive range
//     ?force=1                        → rescore even at the current engine version
import { isFirestoreEnabled, listDocs, getDoc } from './lib/firestore.mts';
import { HISTORY_COLLECTION } from './lib/history-store.mts';
import { ENGINE_VERSION, loadEngineConfig } from './lib/routing-engine-config.mts';
import { REFERENCE_ROUTES_COLLECTION, type ReferenceRouteDoc } from './lib/routing-reference.mts';
import { DRIVER_DAYS_COLLECTION, type DriverDayDoc } from './lib/routing-driver-days.mts';
import { SERVICE_TIMES_COLLECTION, fleetServicePath } from './lib/routing-service-times.mts';
import { CUSTOMER_DRIVERS_COLLECTION } from './lib/routing-customer-drivers.mts';
import { runPlanForDate, type PlanInputs } from './lib/routing-plan-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_BUDGET_MS = 12 * 60 * 1000;

async function listCapturedDates(): Promise<string[]> {
  const manifests = await listDocs(HISTORY_COLLECTION);
  return manifests
    .map((m) => String(m?._id || ''))
    .filter((id) => id.startsWith(`${TENANT}__`))
    .map((id) => id.slice(TENANT.length + 2))
    .filter((d) => DATE_RE.test(d))
    .sort();
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

  // Load the WHOLE observation set once. The Phase-3 pure functions filter each
  // to dates < D internally, so passing everything is leakage-safe.
  const [ddRows, refRows, svcRows, fleetDoc, habitRows] = await Promise.all([
    listDocs(DRIVER_DAYS_COLLECTION),
    listDocs(REFERENCE_ROUTES_COLLECTION),
    listDocs(SERVICE_TIMES_COLLECTION),
    getDoc(fleetServicePath(TENANT)),
    listDocs(CUSTOMER_DRIVERS_COLLECTION),
  ]);
  const allDriverDays = (ddRows as any[]).filter((r) => r?.tenant === TENANT) as DriverDayDoc[];
  const allRefs = (refRows as any[]).filter((r) => r?.tenant === TENANT) as ReferenceRouteDoc[];
  const serviceDocByKey = new Map<string, any>();
  for (const s of svcRows as any[]) {
    if (s?.tenant !== TENANT || s?.is_fleet) continue;
    if (s?.match_key) serviceDocByKey.set(String(s.match_key), s);
  }
  const habitDocByKey = new Map<string, any>();
  for (const h of habitRows as any[]) {
    if (h?.tenant !== TENANT) continue;
    if (h?.match_key) habitDocByKey.set(String(h.match_key), h); // habitAsOf re-filters < D per date
  }
  const [notesRows, tractorRows] = await Promise.all([
    listDocs('customer_notes'), listDocs('tractor_locations'),
  ]);
  const notesRestrictions = new Map<string, any[]>();
  for (const n of notesRows) { const mk = n?.match_key || n?._id; if (mk) notesRestrictions.set(String(mk), n?.equipment_restrictions || []); }
  const tractorCapable = new Set<string>();
  for (const t of tractorRows) { const mk = t?.match_key || t?._id; if (mk) tractorCapable.add(String(mk)); }

  const refDates = [...new Set(allRefs.map((r) => String(r.date)))].sort();
  const ddDates = new Set(allDriverDays.map((d) => String(d.date)));

  const inputs: PlanInputs = { driverDaysBefore: allDriverDays, referencesBefore: allRefs, serviceDocByKey, fleetServiceDoc: fleetDoc, habitDocByKey, notesRestrictions, tractorCapable };

  const scored: Array<{ date: string; stop_agreement_pct: number | null; coload_agreement_pct: number | null }> = [];
  const skippedTooEarly: string[] = [];
  const skippedNoHistory: string[] = [];
  let stoppedAt: string | null = null;

  for (const date of dates) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { stoppedAt = date; break; }
    if (refDates.filter((d) => d < date).length < cfg.min_prior_reference_days) { skippedTooEarly.push(date); continue; }
    if (![...ddDates].some((d) => d < date)) { skippedNoHistory.push(date); continue; }
    const s = await runPlanForDate(TENANT, date, { cfg, force, inputs });
    if (s.skipped_existing) continue;
    scored.push({ date, stop_agreement_pct: s.stop_agreement_pct, coload_agreement_pct: s.coload_agreement_pct });
    console.log(`[plan-replay] ${date}: stop ${s.stop_agreement_pct ?? '—'}% coload ${s.coload_agreement_pct ?? '—'}% (${s.drivers} drivers, ${s.trips_engine}v${s.trips_actual} trips)`);
  }

  const summary = {
    ok: true, tenant: TENANT, engine_version: ENGINE_VERSION,
    dates_considered: dates.length, dates_scored: scored.length,
    dates_skipped_too_early: skippedTooEarly.length, dates_skipped_no_history: skippedNoHistory.length,
    last_scored: scored.length ? scored[scored.length - 1].date : null,
    stopped_at: stoppedAt, scored, ms: Date.now() - t0,
  };
  console.log('[plan-replay] done:', JSON.stringify({ ...summary, scored: undefined }));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
