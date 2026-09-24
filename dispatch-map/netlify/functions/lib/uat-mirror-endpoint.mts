// lib/uat-mirror-endpoint.mts — THE ONE HANDLER BEHIND BOTH WAYS OF RUNNING THE UAT MIRROR REFRESH.
//
//   uat-mirror-refresh-background.mts   SCHEDULED, 06:45 UTC. Netlify's cron is its only caller:
//                                        "You can't invoke scheduled functions directly with a
//                                        URL" (Netlify docs) — a POST to it answers 403 before
//                                        this code runs (observed on the UAT site, 2026-09-24).
//   uat-mirror-resume-background.mts    PLAIN background function, NO schedule, so a POST reaches
//                                        it. This is the manual door: finish a run that stopped at
//                                        the budget, or run one now. Same pattern, for the same
//                                        reason, as nuvizz-manual-scan-background.mts.
//
// Both call mirrorRefreshHandler, so the gates, the plan and the run cannot drift apart.
//
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD   sealed-day window (default: the 90 days ending yesterday)
//     ?days=N                          history window length when ?from is absent (default 90)
//     ?horizon=N                       board days after today (default 3; 0 = today only)
//     ?board=off ?history=off ?static=off ?remine=off ?lean=off   (on unless an off-word)
//     ?reset=1                         discard the stored progress and start the window over
//     ?recopy=1                        copy every sealed day, even one the mirror holds unchanged
//   Progress: uat_mirror_refresh/{tenant} — the cursor a resume reads; served by the sync
//   endpoint uat-mirror-refresh (?status=1), which also answers ?explain=1 with no writes.
//
// THE GATES, IN ORDER. (1) MIRROR ONLY, keyed on FIRESTORE_DATABASE, before any parsing —
// production cannot reach the body. (2) UAT_PROD_MIRROR=off puts a mirror back to its own
// database. (3) FIREBASE_SA present. (4) The manual door's gate, which its entry file passes
// in (dispatcher, like the Scan-now button) — a plain background function answers any POST;
// the cron entry passes none. (5) Overrides at admin through gateScheduledOverride, on both. A
// refused request is recorded in nuvizz_ops/background_refusals (lib/background-gate.mts),
// because these are *-background functions and the platform throws the response away.
//
// READ THE 202 AS "RECEIVED", NEVER AS "DONE" (docs/ATTEMPTS.md says why). Confirm a run with
// GET uat-mirror-refresh?status=1 — the progress document says what was copied, what the
// miners did, where it stopped, and it carries nuvizz_calls: 0 on purpose.
import { isMirrorDeploy, firestoreDatabaseName } from './mirror-guard.mts';
import { isFirestoreEnabled, getDoc, setDoc, listDocs, etDayString } from './firestore.mts';
import { listProdDocs, getProdDoc, prodMirrorReadEnabled } from './prod-mirror-read.mts';
import { gateScheduledOverride } from './background-gate.mts';
import { runPostSealHooks, recordPostSealOutcome } from './history-postseal.mts';
import {
  planRefresh, runRefresh, progressPath, onOff, planLabel, TIME_BUDGET_MS,
  type RefreshDeps, type RefreshProgress,
} from './uat-mirror-refresh.mts';

const TENANT = 'davis';
export const OVERRIDE_PARAMS = ['from', 'to', 'days', 'horizon', 'board', 'history', 'static', 'remine', 'lean', 'reset', 'recopy'] as const;
export const RESUME_JOB = 'uat-mirror-resume-background';

export interface MirrorRefreshOptions {
  job: string;
  /** The manual door's gate, passed in by the entry file so the door is visible where it is. */
  manualGate?: (req: Request) => Promise<{ ok: boolean; response?: Response }>;
}

export async function mirrorRefreshHandler(req: Request, opts: MirrorRefreshOptions): Promise<Response> {
  const headers = { 'Content-Type': 'application/json' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

  // (1) MIRROR ONLY — the first thing this handler does, before the URL is even parsed.
  if (!isMirrorDeploy()) {
    return J({ ok: false, refused: 'not a mirror deploy — the mirror refresh never runs on production', database: firestoreDatabaseName() }, 403);
  }
  // (2) the switch that puts a mirror back to reading only its own database
  if (!prodMirrorReadEnabled()) {
    return J({ ok: false, refused: 'UAT_PROD_MIRROR=off — this mirror is not reading production', database: firestoreDatabaseName() }, 200);
  }
  // (3)
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 200);
  // (4) the manual door
  if (opts.manualGate) {
    const gate = await opts.manualGate(req);
    if (!gate.ok) return gate.response || J({ ok: false, refused: 'not signed in' }, 401);
  }
  // (5) overrides at admin; the cron path (no query string) never consults the gate
  const refused = await gateScheduledOverride(req, opts.job, OVERRIDE_PARAMS);
  if (refused) return refused;

  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  const num = (k: string) => { const v = q(k); if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  let plan;
  try {
    plan = planRefresh({
      tenant: TENANT, today: etDayString(),
      from: q('from'), to: q('to'),
      historyDays: num('days'), horizonDays: num('horizon'),
      board: onOff(q('board')), history: onOff(q('history')), static: onOff(q('static')),
      remine: onOff(q('remine')), lean: onOff(q('lean')),
      recopy: q('recopy') === '1',
    });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'bad parameters' }, 400);
  }

  const reset = q('reset') === '1';
  // NO .catch here — getDoc returns null on 404 and throws only on real errors. Swallowing a
  // transient failure would read as "no stored run" and restart a window from the top.
  const prior = reset ? null : ((await getDoc(progressPath(TENANT))) as RefreshProgress | null);
  if (prior && prior.finished && prior.label === planLabel(plan)) {
    // The same window already finished. The nightly cron gets a NEW window every day (the
    // dates move), so this branch is only ever a repeated manual run — say so and do nothing.
    console.log(`[mirror-refresh] window ${prior.label} already finished at ${prior.updated_at} — pass ?reset=1 to redo it`);
    return J({ ok: true, already_finished: true, label: prior.label, finished_at: prior.updated_at });
  }

  const deps: RefreshDeps = {
    listProd: (p, o) => listProdDocs(p, o),
    getProd: (p) => getProdDoc(p),
    setDoc,
    listMirror: (p, o) => listDocs(p, o),
    getMirror: (p) => getDoc(p),
    // The SAME miners the nightly capture runs after a seal (lib/history-postseal.mts), over the
    // copied records, writing the mirror's learned collections. The outcome is recorded on the
    // copied manifest exactly as the nightly records it — history-capture-health on the UAT site
    // reads a mined day as mined, and runRefresh reads post_seal_at to know a day needs no
    // second pass (mirroredDayIsCurrent).
    remine: async (tenant, date, stops) => {
      const res = await runPostSealHooks(tenant, date, stops);
      await recordPostSealOutcome(tenant, date, res);
      return res;
    },
    persist: (p) => setDoc(progressPath(TENANT), p).then(() => undefined),
    log: (line) => console.log(line),
  };

  console.log(`[mirror-refresh] ${opts.job}: ${prior && prior.label === planLabel(plan) ? 'resuming' : 'starting'} ${planLabel(plan)} on ${firestoreDatabaseName()}`);
  const progress = await runRefresh(deps, plan, prior, { budgetMs: TIME_BUDGET_MS });
  console.log(`[mirror-refresh] ${progress.finished ? 'finished' : `stopped at ${progress.stopped_at} (budget) — POST ${RESUME_JOB} to go on, or the next 06:45 run will`}: history ${progress.done.history.length}/${progress.history_dates_in_prod.length}, board ${progress.done.board.length}/${plan.boardDates.length}, nuvizz_calls 0`);
  return J({ ok: true, finished: progress.finished, stopped_at: progress.stopped_at, label: progress.label, nuvizz_calls: 0 });
}
