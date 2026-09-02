// routing-engine-experiment-background.mts
//
// LABELED OFFLINE EXPERIMENTS for the assignment engine — the missing sweep
// harness. A run = a config OVERLAY (e.g. {"w_candidate_rank":2}) replayed over
// the captured warehouse window in DRY-RUN mode: every day is solved and scored
// exactly like the nightly, but NOTHING in the trend collections is written —
// results land in engine_experiments/{tenant}__{label}, their own collection,
// so a sweep can never clobber plan_proposals_daily or the version rollups
// (the exact failure mode that made knob experiments untrustworthy before).
//
// ZERO NuVizz calls: reads are the history warehouse + learning collections,
// writes are the experiment doc only. Ignores ROUTING_ENGINE=off — invoking
// this by hand IS the intent (same policy as the replays).
//
//   POST /.netlify/functions/routing-engine-experiment-background
//     body: { label: 'rank-aware-2',            // [a-z0-9_-]{1,40}, REQUIRED
//             config: { w_candidate_rank: 2 },  // overlay, clamped; {} = baseline
//             from: '2026-06-29', to: '2026-07-20',  // window (stored on first call)
//             reset: true }                     // discard the stored run, start over
//
// Chunked to the 12-min budget; resume = POST again with the same label (days
// already scored are skipped — the doc is the cursor). Read results via
// routing-engine-data?view=experiments. Compare labels with identical windows
// only; the doc stores the window so that check is trivial.
import { isFirestoreEnabled, listDocs, getDoc, setDoc } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { HISTORY_COLLECTION } from './lib/history-store.mts';
import { ENGINE_VERSION, loadEngineConfig, clampEngineConfig, type EngineConfig } from './lib/routing-engine-config.mts';
import { REFERENCE_ROUTES_COLLECTION, type ReferenceRouteDoc } from './lib/routing-reference.mts';
import { DRIVER_DAYS_COLLECTION, type DriverDayDoc } from './lib/routing-driver-days.mts';
import { SERVICE_TIMES_COLLECTION, fleetServicePath } from './lib/routing-service-times.mts';
import { CUSTOMER_DRIVERS_COLLECTION } from './lib/routing-customer-drivers.mts';
import { runPlanForDate, summarizePlanVersion, experimentPath, type PlanInputs } from './lib/routing-plan-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_RE = /^[a-z0-9_-]{1,40}$/;
const TIME_BUDGET_MS = 12 * 60 * 1000;

// Key-order-insensitive equality: clampEngineConfig emits NUMERIC_KEYS order
// while Firestore returns map fields in its own order — stringify comparison
// would 409 a legitimate resume and its error text tells the user to destroy
// the run with reset:true. Compare values, not serializations.
function sameOverlay(a: any, b: any): boolean {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => Number(a[k]) === Number(b[k]));
}

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
  // GATED AT admin. A sweep replays the whole captured window and writes engine_experiments —
  // the numbers a tuning decision gets made on. Netlify already answered 202 and discarded
  // our status (lib/background-gate.mts), so the refusal lands in
  // nuvizz_ops/background_refusals. It is DELIBERATELY not written onto the experiment doc:
  // that doc is the resume cursor for a scored run, and stamping a refusal into it would
  // destroy hours of scoring to report a permission error.
  const gate = await requireUserForBackground(req, 'routing-engine-experiment-background', { role: 'admin' });
  if (!gate.ok) return gate.response;
  const t0 = Date.now();
  let body: any = null;
  try { body = await req.json(); } catch { /* handled below */ }
  const label = String(body?.label || '');
  if (!LABEL_RE.test(label)) {
    return new Response(JSON.stringify({ ok: false, error: 'label required: [a-z0-9_-]{1,40}' }), { status: 400, headers });
  }
  const overlay = clampEngineConfig(body?.config || {});
  const docPath = experimentPath(TENANT, label);

  // A malformed date must ERROR, not silently widen the run to the full window
  // — a pinned wrong window is unfixable without reset:true.
  for (const k of ['from', 'to']) {
    if (body?.[k] != null && !DATE_RE.test(String(body[k]))) {
      return new Response(JSON.stringify({ ok: false, error: `bad ${k}: '${body[k]}' (YYYY-MM-DD)` }), { status: 400, headers });
    }
  }

  // NO .catch here — getDoc returns null on 404 and throws only on real errors.
  // Swallowing a transient failure would read as "no stored run" and the first
  // persist() would REPLACE the doc, resetting hours of scored days on a blip.
  let doc: any = body?.reset ? null : await getDoc(docPath);
  // A stored run pins its window, overlay, BASE CONFIG and engine version:
  // resuming with any of them changed silently mixes two experiments under one
  // name — refuse instead.
  if (doc) {
    if (body?.config !== undefined && !sameOverlay(doc.config_overlay || {}, overlay)) {
      return new Response(JSON.stringify({ ok: false, error: `label '${label}' already ran with a different config overlay — pass reset:true to redo it, or use a new label`, stored_overlay: doc.config_overlay }), { status: 409, headers });
    }
    if (doc.engine_version && doc.engine_version !== ENGINE_VERSION) {
      return new Response(JSON.stringify({ ok: false, error: `label '${label}' was scored under engine ${doc.engine_version}; this deploy is ${ENGINE_VERSION} — mixed-version runs are not comparable. reset:true to redo it, or use a new label.` }), { status: 409, headers });
    }
  }
  const from = String(doc?.window_from || body?.from || '');
  const to = String(doc?.window_to || body?.to || '');

  let dates = await listCapturedDates();
  if (DATE_RE.test(from)) dates = dates.filter((d) => d >= from);
  if (DATE_RE.test(to)) dates = dates.filter((d) => d <= to);

  // The BASE config is pinned on the doc at first run — a live tuning edit
  // between passes must not shift the baseline under a labeled experiment.
  const baseConfig: EngineConfig = (doc?.base_config as EngineConfig) ?? await loadEngineConfig(TENANT);
  const cfg: EngineConfig = { ...baseConfig, ...(doc?.config_overlay ?? overlay) };

  // Load the WHOLE observation set once (identical discipline to the plan
  // replay: the pure functions filter < D internally, so this is leakage-safe).
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
    if (h?.match_key) habitDocByKey.set(String(h.match_key), h);
  }
  const [notesRows, tractorRows, employees] = await Promise.all([
    listDocs('customer_notes'), listDocs('tractor_locations'),
    listDocs('employees').catch(() => [] as any[]),
  ]);
  const notesRestrictions = new Map<string, any[]>();
  for (const n of notesRows) { const mk = n?.match_key || n?._id; if (mk) notesRestrictions.set(String(mk), n?.equipment_restrictions || []); }
  const tractorCapable = new Set<string>();
  for (const t of tractorRows) { const mk = t?.match_key || t?._id; if (mk) tractorCapable.add(String(mk)); }
  const inputs: PlanInputs = { driverDaysBefore: allDriverDays, referencesBefore: allRefs, serviceDocByKey, fleetServiceDoc: fleetDoc, habitDocByKey, notesRestrictions, tractorCapable, employees };

  const refDates = [...new Set(allRefs.map((r) => String(r.date)))].sort();
  const ddDates = [...new Set(allDriverDays.map((d) => String(d.date)))];

  const days: Record<string, any> = { ...(doc?.days || {}) };
  const skipped: string[] = [...(doc?.skipped || [])];
  let stoppedEarly = false;

  const persist = async (done: boolean) => {
    // The experiment summary reuses the SAME stop-weighted fold as the version
    // rollups (summarizePlanVersion), so an experiment number and a version-card
    // number always mean the same thing.
    const summary = summarizePlanVersion(Object.values(days), ENGINE_VERSION, TENANT);
    await setDoc(docPath, {
      tenant: TENANT, label, engine_version: ENGINE_VERSION,
      config_overlay: doc?.config_overlay ?? overlay,
      base_config: baseConfig,
      window_from: DATE_RE.test(from) ? from : (dates[0] ?? null),
      window_to: DATE_RE.test(to) ? to : (dates[dates.length - 1] ?? null),
      days, skipped: [...new Set(skipped)],
      days_scored: Object.keys(days).length,
      summary, done,
      created_at: doc?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  };

  for (const date of dates) {
    if (days[date]) continue;                       // the doc IS the cursor
    if (skipped.includes(date)) continue;
    if (Date.now() - t0 > TIME_BUDGET_MS) { stoppedEarly = true; break; }
    if (refDates.filter((d) => d < date).length < cfg.min_prior_reference_days) { skipped.push(date); continue; }
    if (!ddDates.some((d) => d < date)) { skipped.push(date); continue; }
    const s = await runPlanForDate(TENANT, date, { cfg, force: true, inputs, writeResults: false });
    if (!s.planned_stops) { skipped.push(date); continue; }
    days[date] = {
      tenant: TENANT, date, engine_version: ENGINE_VERSION,
      planned_stops: s.planned_stops, drivers: s.drivers,
      trips_engine: s.trips_engine, trips_actual: s.trips_actual,
      unassigned_count: s.unassigned_count,
      stop_agreement_pct: s.stop_agreement_pct,
      stop_agreement_known_pct: s.stop_agreement_known_pct,
      stop_agreement_fallback_pct: s.stop_agreement_fallback_pct,
      candidate_containment_pct: s.candidate_containment_pct,
      coload_agreement_pct: s.coload_agreement_pct,
      coload_precision_pct: s.coload_precision_pct,
      est_travel_engine_min: s.est_travel_engine_min,
      est_travel_actual_min: s.est_travel_actual_min,
      tie_margin: s.tie_margin,
    };
    // Crash-safe: each scored day is durable before the next begins — a died
    // invocation loses at most one day, and the next POST resumes past it.
    await persist(false);
    console.log(`[experiment:${label}] ${date}: stop ${s.stop_agreement_pct ?? '—'}% known ${s.stop_agreement_known_pct ?? '—'}% contain ${s.candidate_containment_pct ?? '—'}%`);
  }

  await persist(!stoppedEarly);
  const summaryOut = { ok: true, label, days_scored: Object.keys(days).length, skipped: skipped.length, done: !stoppedEarly, ms: Date.now() - t0 };
  console.log(`[experiment:${label}] pass done:`, JSON.stringify(summaryOut));
  return new Response(JSON.stringify(summaryOut), { status: 200, headers });
};
