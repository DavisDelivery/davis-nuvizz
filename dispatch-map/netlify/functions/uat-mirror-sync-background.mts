// uat-mirror-sync-background.mts — EVERY 10 MINUTES, COPY WHAT PRODUCTION CHANGED INTO THE UAT MIRROR.
//
// Chad, 2026-09-26: "any update i make to production should automatically be here as well but
// any change to uat should not automatically go to production without explicit approval."
//
// The rules — what is copied, how "changed" is decided, what is and is not deleted, why nothing
// can flow the other way — are lib/uat-live-sync.mts. This file is the schedule and the gates.
//
// THE GATES, IN ORDER, before anything is read:
//   (1) MIRROR ONLY, keyed on FIRESTORE_DATABASE. On production the same cron fires and this
//       returns in its first line: nothing is read, nothing is written, nothing is spent.
//   (2) UAT_PROD_MIRROR=off — the mirror is not reading production at all.
//   (3) UAT_LIVE_SYNC=off — THE WAY BACK for this change: the tick stops, and the mirror's
//       roster reads return to what they did before (nuvizz-loads-roster.mts).
//   (4) FIREBASE_SA present.
//   (5) ONE TICK AT A TIME: a lease on uat_mirror_sync/davis. A tick that outlives the next
//       cron (a Shiplify import is thousands of documents) is not doubled; a lease older than
//       14 minutes is presumed dead and taken over.
//
// ZERO NuVizz calls, by construction — nothing here imports a nuvizz-* module.
//
// CONFIRM IT RAN with GET uat-mirror-refresh?sync=1 — the last tick's report, unit by unit.
// See what the next tick WOULD copy, writing nothing, with GET uat-mirror-refresh?sync=explain.
// Read the 202 a background function answers as "received", never as "done".
import { isMirrorDeploy, firestoreDatabaseName } from './lib/mirror-guard.mts';
import { prodMirrorReadEnabled } from './lib/prod-mirror-read.mts';
import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { liveSyncEnabled, planUnits, runSync, runPath, leaseHeld, SYNC_BUDGET_MS, type SyncDeps, type SyncReport } from './lib/uat-live-sync.mts';
import { realSyncDeps } from './lib/uat-live-sync-io.mts';

const TENANT = 'davis';

export async function syncTickHandler(
  _req: Request,
  io: { deps?: SyncDeps; env?: Record<string, any>; today?: string; firestore?: boolean } = {},
): Promise<Response> {
  const env = io.env || process.env;
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  // (1)
  if (!isMirrorDeploy(env)) {
    return J({ ok: false, refused: 'not a mirror deploy — the live sync never runs on production', database: firestoreDatabaseName(env) }, 403);
  }
  // (2)
  if (!prodMirrorReadEnabled(env)) return J({ ok: false, refused: 'UAT_PROD_MIRROR=off — this mirror is not reading production' });
  // (3)
  if (!liveSyncEnabled(env)) return J({ ok: false, refused: 'UAT_LIVE_SYNC=off — production changes reach this mirror only on the 06:45 refresh' });
  // (4)
  if (!(io.firestore ?? isFirestoreEnabled())) return J({ ok: false, error: 'FIREBASE_SA not set' });

  const deps = io.deps || realSyncDeps();
  const nowMs = deps.now ? deps.now() : Date.now();
  const nowIso = () => (deps.nowIso ? deps.nowIso() : new Date().toISOString());
  // (5) NO .catch — a failed read must not look like "no lease" and start a second tick.
  const prior: any = await deps.getMirror(runPath(TENANT));
  if (leaseHeld(prior, nowMs)) {
    console.log(`[uat-live-sync] a tick has held the lease since ${prior.running_since} — skipping this one`);
    return J({ ok: true, skipped: 'a tick is already running', running_since: prior.running_since });
  }
  const today = io.today || etDayString();
  await deps.setMirror(runPath(TENANT), { ...(prior || {}), tenant: TENANT, running_since: nowIso() });

  let report: SyncReport | null = null;
  let failure: string | null = null;
  try {
    report = await runSync(deps, planUnits(today, { tenant: TENANT }), { tenant: TENANT, today, budgetMs: SYNC_BUDGET_MS });
  } catch (e: any) {
    failure = String(e?.message || e).slice(0, 300);
    console.error(`[uat-live-sync] tick FAILED: ${failure}`);
  } finally {
    // The lease is released whatever happened, and the outcome is written where ?sync=1 reads it.
    await deps.setMirror(runPath(TENANT), {
      tenant: TENANT,
      running_since: null,
      updated_at: nowIso(),
      last: report ?? prior?.last ?? null,
      last_error: failure,
      last_ok_at: report && !failure ? report.finished_at : (prior?.last_ok_at ?? null),
      nuvizz_calls: 0,
    });
  }
  if (!report) return J({ ok: false, error: failure }, 500);
  const t = report.totals;
  console.log(`[uat-live-sync] ${today}: ${t.changed} changed in production, ${t.copied} copied, ${t.removed} removed, ${t.errors} unit error(s)${report.deferred.length ? `, ${report.deferred.length} deferred to the next tick` : ''}, nuvizz_calls 0`);
  return J({ ok: t.errors === 0, today, totals: t, deferred: report.deferred, nuvizz_calls: 0 });
}

export default (req: Request): Promise<Response> => syncTickHandler(req);

// A literal, not SYNC_SCHEDULE: Netlify reads `config` out of the source without running it.
// The test pins the two equal.
export const config = {
  schedule: '*/10 * * * *',
};
