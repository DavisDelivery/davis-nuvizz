// routing-engine-shadow-background.mts
//
// NIGHTLY SHADOW pass of the learned routing engine. Takes the routes
// dispatch actually built for the just-closed board date, re-sequences each
// with the constraint solver, scores against the dispatcher's order with the
// official Amazon/MIT challenge metric, and writes route_proposals + the
// route_proposals_daily rollup. SHADOW ONLY — proposes and scores, changes
// NOTHING. No write-back, no edits to live plan data.
//
// Data diet: history_days + routing_reference_routes + the MarginIQ roster.
// ZERO NuVizz calls, ZERO Google Route Matrix calls. Reference lookups use
// dates STRICTLY BEFORE the target date.
//
// Kill switch: ROUTING_ENGINE=off silently skips the scheduled run (and the
// nightly miner pass in the capture pipeline). Manual POSTs report the skip.
//
// Idempotent re-run guard: a date whose rollup already carries the current
// ENGINE_VERSION is skipped unless ?force=1 (recompute is an overwrite of the
// same doc ids either way).
//
// Manual trigger (cron only fires on PUBLISHED deploys):
//   POST /.netlify/functions/routing-engine-shadow-background
//     ?date=YYYY-MM-DD   → explicit target (default: ET-yesterday)
//     ?force=1           → recompute even if already scored at this version
//
// ── Schedule: 07:30 UTC nightly ──────────────────────────────────────────────
// The history capture runs at 06:00 UTC and this feeds off its output, so run
// ~90 minutes later; the capture (one day) finishes well inside that window.
//
// ROUTING CALENDAR PROOF (why this timing is CORRECT and needs no re-timing):
// dispatch builds routes OVERNIGHT, ~20:00 ET → ~07:00 ET (Sunday night builds
// Monday; Thursday night builds Friday; no Sat/Sun boards, no Fri/Sat-night
// routing — routing_engine_config.routing_calendar). So board date D is FINAL
// by ~07:00 ET on D and fully executed by D evening. This job targets D-1 at
// 07:30 UTC = 02:30/03:30 ET — many hours after D-1 closed. Always final.
//
// ET ANCHORING / DST DRIFT: the cron fires at a fixed UTC instant, so its ET
// wall time drifts one hour across DST flips (03:30 EDT ↔ 02:30 EST). Both
// instants sit safely inside the "D-1 is closed, D is still being built"
// window, so the drift is harmless — do NOT re-time the cron for DST.
//
// FUTURE PHASES (Assist): any job reading the CURRENT day's plan must gate on
// assertCurrentDayReadAllowed (>= 07:30 ET on D), and proposal generation must
// eventually run INSIDE the 20:00–07:00 build window. Encoded in
// routing-engine-config.mts; inherit it, don't re-derive it.
import { isFirestoreEnabled, listDocs, setDoc } from './lib/firestore.mts';
import { etYesterday } from './lib/history-core.mts';
import { getManifest } from './lib/history-store.mts';
import { routingEngineDisabled, loadEngineConfig, isBoardDay, ENGINE_VERSION } from './lib/routing-engine-config.mts';
import { runShadowForDate, listReferencesBefore } from './lib/routing-engine-core.mts';
import { runPlanForDate, summarizePlanVersion, planVersionRollupPath, PLAN_PROPOSALS_DAILY_COLLECTION } from './lib/routing-plan-core.mts';
import { gateScheduledOverride } from './lib/background-gate.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ?date / ?force drive the nightly shadow by hand. ?force discards the already-scored guard, so
// a caller can re-score any captured day into route_proposals — the Engine tab's trend, and the
// evidence a tuning change gets judged on — as often as they like. The 07:30 UTC cron sends no
// query string and scores ET-yesterday.
export const OVERRIDE_PARAMS = ['date', 'force'] as const;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  // Before the kill-switch check and before any read: a refused override must cost nothing.
  const refused = await gateScheduledOverride(req, 'routing-engine-shadow-background', OVERRIDE_PARAMS);
  if (refused) return refused;
  if (routingEngineDisabled()) {
    console.log('[engine-shadow] ROUTING_ENGINE=off — nightly shadow skipped');
    return new Response(JSON.stringify({ ok: true, skipped: 'ROUTING_ENGINE=off' }), { status: 200, headers });
  }
  if (!isFirestoreEnabled()) {
    console.error('[engine-shadow] FIREBASE_SA not set — cannot read warehouse / write proposals');
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }

  const url = new URL(req.url);
  const qDate = url.searchParams.get('date');
  const date = qDate && DATE_RE.test(qDate) ? qDate : etYesterday();
  const force = url.searchParams.get('force') === '1';

  const cfg = await loadEngineConfig(TENANT);

  // ROUTING CALENDAR (Phase 2.1): weekend / no-board dates are EXPECTED IDLE,
  // not failures. A non-board-day target exits as a distinct idle state — no
  // failure record, no empty rollup polluting the trend. Same for a date the
  // warehouse tombstoned (holiday: manifest no_board:true).
  if (!isBoardDay(date, cfg.routing_calendar)) {
    console.log(`[engine-shadow] ${date} is not a board day (routing_calendar) — idle`);
    return new Response(JSON.stringify({ ok: true, idle: 'not_a_board_day', date }), { status: 200, headers });
  }
  const manifest = await getManifest(TENANT, date);
  if (manifest && manifest.no_board) {
    console.log(`[engine-shadow] ${date} is tombstoned (no board) — idle`);
    return new Response(JSON.stringify({ ok: true, idle: 'tombstoned_no_board', date }), { status: 200, headers });
  }

  // TRAIN-BEFORE-JUDGE gate (audit finding 5): the replays skip dates with
  // fewer than min_prior_reference_days of reference history; the nightly job
  // now behaves identically on thin history instead of emitting low, mostly-
  // unguided scores that dilute the gated trend. Distinct state, no rollup.
  const references = await listReferencesBefore(TENANT, date);
  const priorRefDays = new Set(references.map((r: any) => String(r.date))).size;
  if (priorRefDays < cfg.min_prior_reference_days && !force) {
    console.log(`[engine-shadow] ${date}: only ${priorRefDays} prior reference day(s) (< ${cfg.min_prior_reference_days}) — skipped, not scored`);
    return new Response(JSON.stringify({ ok: true, idle: 'insufficient_reference_history', date, prior_reference_days: priorRefDays }), { status: 200, headers });
  }

  console.log(`[engine-shadow] v${ENGINE_VERSION} scoring ${date}${force ? ' (force)' : ''}`);
  // Phase 1 — sequence scoring (re-sequence each dispatched load, score vs actual).
  // The reference library is already loaded for the gate above; hand it down
  // (runShadowForDate re-applies the strict < date filter internally regardless).
  const seq = await runShadowForDate(TENANT, date, { force, cfg, references });
  console.log('[engine-shadow] sequence done:', JSON.stringify(seq));

  // Phase 2 — assignment scoring (build the whole day plan, score vs dispatch).
  // Best-effort: a plan failure must not lose the sequence result.
  let plan: any = null;
  try {
    plan = await runPlanForDate(TENANT, date, { force });
    console.log('[engine-shadow] plan done:', JSON.stringify(plan));
  } catch (e: any) {
    console.error(`[engine-shadow] plan scoring failed for ${date}:`, e?.message);
    plan = { ok: false, error: e?.message };
  }

  // Refresh THIS version's cross-version progress snapshot as the new day accrues
  // (see summarizePlanVersion). Best-effort — the day docs above are already durable.
  try {
    const dailyDocs = await listDocs(PLAN_PROPOSALS_DAILY_COLLECTION);
    const rollup = summarizePlanVersion(dailyDocs.filter((d: any) => d?.tenant === TENANT), ENGINE_VERSION, TENANT);
    await setDoc(planVersionRollupPath(TENANT, ENGINE_VERSION), rollup);
    console.log('[engine-shadow] version rollup:', JSON.stringify(rollup));
  } catch (e: any) { console.warn(`[engine-shadow] version rollup failed:`, e?.message); }

  return new Response(JSON.stringify({ engine_version: ENGINE_VERSION, sequence: seq, plan }), { status: 200, headers });
};

export const config = {
  schedule: '30 7 * * *',
};
