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
//   POST /.netlify/functions/routing-engine-plan-replay-background   → RESUMES
//                                       from the stored cursor, else all days
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → inclusive range (ignores the cursor)
//     ?force=1                        → rescore even at the current engine version
//     ?restart=1                      → ignore the cursor, start a fresh pass
import { isFirestoreEnabled, listDocs, getDoc, setDoc } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { HISTORY_COLLECTION } from './lib/history-store.mts';
import { ENGINE_VERSION, loadEngineConfig } from './lib/routing-engine-config.mts';
import { REFERENCE_ROUTES_COLLECTION, type ReferenceRouteDoc } from './lib/routing-reference.mts';
import { DRIVER_DAYS_COLLECTION, type DriverDayDoc } from './lib/routing-driver-days.mts';
import { SERVICE_TIMES_COLLECTION, fleetServicePath } from './lib/routing-service-times.mts';
import { CUSTOMER_DRIVERS_COLLECTION } from './lib/routing-customer-drivers.mts';
import { runPlanForDate, summarizePlanVersion, planVersionRollupPath, replayCursorPath, PLAN_PROPOSALS_DAILY_COLLECTION, type PlanInputs } from './lib/routing-plan-core.mts';

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
  // GATED AT admin — the same role as routing-engine-tuning, because the Engine-tuning modal's
  // "Re-score history" button is what fires this (App.jsx), and a re-score with somebody
  // else's knobs is a tuning act.
  //
  // Netlify already answered 202 and discarded our status (lib/background-gate.mts), and this
  // client does not poll at all — it prints "Re-score started. Give it ~12 minutes" and tells
  // the operator to refresh the Assignment view. So a refusal here is INVISIBLE ON THE SCREEN
  // by construction, and the honest record is nuvizz_ops/background_refusals plus the log.
  // The refusal is not written to the replay cursor doc on purpose: that doc is where a
  // half-finished pass remembers its place, and clobbering it would silently restart the
  // window from the oldest day — the exact treadmill the cursor was added to end.
  const gate = await requireUserForBackground(req, 'routing-engine-plan-replay-background', { role: 'admin' });
  if (!gate.ok) return gate.response;
  const t0 = Date.now();
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const force = url.searchParams.get('force') === '1';
  const restart = url.searchParams.get('restart') === '1';

  let dates = await listCapturedDates();
  // RESUME (the treadmill fix). One pass only covers what fits in TIME_BUDGET_MS
  // — roughly 8 days at the 90s assignment cap — and then reports stopped_at.
  // But this is a Netlify *-background* function: it answers 202 with no body,
  // so the caller can NEVER read stopped_at and can never pass it back as ?from.
  // Every tap therefore restarted at the OLDEST date, and with force=1 bypassing
  // the already-current guard it re-scored the same first ~8 days forever. The
  // tail of the window was never reached, which is exactly why the agreement
  // trend never moved no matter how many engine versions shipped.
  //
  // So the cursor lives here instead: an early stop persists where it stopped,
  // the next unqualified call picks up from there, and finishing the window
  // clears it so the following tap starts a fresh pass. An explicit ?from / ?to
  // still wins (a targeted range must never be hijacked by a stale cursor), and
  // ?restart=1 forces a clean pass from the top.
  const cursorDoc = replayCursorPath(TENANT);
  let resumedFrom: string | null = null;
  if (!from && !to && !restart) {
    const cur = await getDoc(cursorDoc).catch(() => null);
    const at = String((cur as any)?.stopped_at || '');
    // A cursor from a DIFFERENT engine version is stale: that pass is moot now,
    // so start over rather than leaving the window half-scored across versions.
    if (DATE_RE.test(at) && (cur as any)?.engine_version === ENGINE_VERSION) resumedFrom = at;
  }
  if (resumedFrom) dates = dates.filter((d) => d >= resumedFrom!);
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
  const [notesRows, tractorRows, employees] = await Promise.all([
    listDocs('customer_notes'), listDocs('tractor_locations'),
    listDocs('employees').catch(() => [] as any[]),  // roster absent → class fallbacks
  ]);
  const notesRestrictions = new Map<string, any[]>();
  for (const n of notesRows) { const mk = n?.match_key || n?._id; if (mk) notesRestrictions.set(String(mk), n?.equipment_restrictions || []); }
  const tractorCapable = new Set<string>();
  for (const t of tractorRows) { const mk = t?.match_key || t?._id; if (mk) tractorCapable.add(String(mk)); }

  const refDates = [...new Set(allRefs.map((r) => String(r.date)))].sort();
  const ddDates = new Set(allDriverDays.map((d) => String(d.date)));

  const inputs: PlanInputs = { driverDaysBefore: allDriverDays, referencesBefore: allRefs, serviceDocByKey, fleetServiceDoc: fleetDoc, habitDocByKey, notesRestrictions, tractorCapable, employees };

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

  // Park (or clear) the resume cursor before anything else that can fail — the
  // whole point is that the NEXT tap advances, so losing this to a downstream
  // error would put the treadmill right back. A range-scoped call never touches
  // the cursor; it isn't walking the full window.
  if (!to) {
    try {
      if (stoppedAt) {
        await setDoc(cursorDoc, { tenant: TENANT, stopped_at: stoppedAt, engine_version: ENGINE_VERSION, updated_at: new Date().toISOString() });
      } else if (!from || resumedFrom) {
        // Reached the end of the window — next tap starts a clean pass.
        await setDoc(cursorDoc, { tenant: TENANT, stopped_at: null, engine_version: ENGINE_VERSION, updated_at: new Date().toISOString() });
      }
    } catch (e: any) { console.warn('[plan-replay] cursor write failed:', e?.message); }
  }

  // Snapshot THIS engine version's window aggregate into its own (version-keyed)
  // doc, so the cross-version progress series survives the next rescoring pass
  // overwriting the per-day docs. Read the daily docs fresh (the loop above just
  // rewrote them to ENGINE_VERSION). Best-effort — the day docs are already durable.
  let versionRollup: any = null;
  try {
    const dailyDocs = await listDocs(PLAN_PROPOSALS_DAILY_COLLECTION);
    versionRollup = summarizePlanVersion(dailyDocs.filter((d: any) => d?.tenant === TENANT), ENGINE_VERSION, TENANT);
    await setDoc(planVersionRollupPath(TENANT, ENGINE_VERSION), versionRollup);
    console.log('[plan-replay] version rollup:', JSON.stringify(versionRollup));
  } catch (e: any) { console.warn('[plan-replay] version rollup failed:', e?.message); }

  const summary = {
    ok: true, tenant: TENANT, engine_version: ENGINE_VERSION,
    dates_considered: dates.length, dates_scored: scored.length,
    dates_skipped_too_early: skippedTooEarly.length, dates_skipped_no_history: skippedNoHistory.length,
    last_scored: scored.length ? scored[scored.length - 1].date : null,
    stopped_at: stoppedAt, resumed_from: resumedFrom,
    window_complete: !stoppedAt,
    version_rollup: versionRollup, scored, ms: Date.now() - t0,
  };
  console.log('[plan-replay] done:', JSON.stringify({ ...summary, scored: undefined }));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
