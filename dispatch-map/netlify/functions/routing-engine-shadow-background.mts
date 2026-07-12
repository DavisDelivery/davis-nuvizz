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
import { isFirestoreEnabled } from './lib/firestore.mts';
import { etYesterday } from './lib/history-core.mts';
import { routingEngineDisabled, ENGINE_VERSION } from './lib/routing-engine-config.mts';
import { runShadowForDate } from './lib/routing-engine-core.mts';
import { runPlanForDate } from './lib/routing-plan-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
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

  console.log(`[engine-shadow] v${ENGINE_VERSION} scoring ${date}${force ? ' (force)' : ''}`);
  // Phase 1 — sequence scoring (re-sequence each dispatched load, score vs actual).
  const seq = await runShadowForDate(TENANT, date, { force });
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

  return new Response(JSON.stringify({ engine_version: ENGINE_VERSION, sequence: seq, plan }), { status: 200, headers });
};

export const config = {
  schedule: '30 7 * * *',
};
