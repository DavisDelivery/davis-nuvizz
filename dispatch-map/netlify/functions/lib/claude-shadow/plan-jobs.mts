// lib/claude-shadow/plan-jobs.mts — QUEUING A PLAN, AND THE PLANNING AREA'S READ (v1.76.0).
//
// A plan is BUILT WHEN IT IS QUEUED, not when the worker reaches it: the board it plans is the one
// the dispatcher previewed and pressed Plan on, frozen with the job (claude_shadow_jobs/{id}/data/
// problem), so a queue that is behind a backtest cannot quietly plan a board that has since moved.
// The worker (backtest.mts workerTick) then runs it exactly as it runs a backtest — the same rounds,
// Stop, resume, per-run cap and the one 24-hour ceiling — and finishPlan (plan.mts) stores the result.
//
// Reads: Firestore only (plan.mts readPlanDay), 0 NuVizz calls. Writes, through store.mts only:
//   claude_shadow_jobs/{pl__…}/data/problem   the plan's board, loads and prompt, frozen
//   claude_shadow_jobs/{pl__…}                the job (kind 'plan')
import { getDoc, listDocs, isFirestoreEnabled } from '../firestore.mts';
import { shadowSet, shadowPatch, shadowCreate } from './store.mts';
import { claudeShadowEnabled, shadowModel } from './config.mts';
import { btLoopProblem } from './backtest-core.mts';
import {
  listJobs, jobPath, routerSettingsFrom, routerRefusal, ceilingView, ROUTER_SETTINGS_PATH, JOB_KINDS,
} from './backtest.mts';
import { readPlanDay, validatePlanParams, planOptions, planPreview, planResult, planMap, planStops, nothingToPlace, type PlanDeps } from './plan.mts';
import { planCapacity } from './plan-core.mts';

export interface PlanJobDeps extends PlanDeps { firestoreOn: () => boolean }
const LIVE: PlanJobDeps = { getDoc, listDocs, shadowSet, shadowPatch, shadowCreate, now: () => new Date(), env: process.env, firestoreOn: isFirestoreEnabled };

const ACTIVE = new Set(['queued', 'running']);
/** Firestore refuses a document over 1 MiB; the frozen plan must leave room for its own field names. */
export const MAX_STORED_PLAN_BYTES = 950_000;
/** One create-only document per board day: the second of two quick Plan presses cannot slip past it. */
export const PLAN_LOCKS = 'claude_shadow_plan_locks';
const utf8 = (x: string) => new TextEncoder().encode(x).length;

/** Queue one plan. Refused whole (nothing written) when the request, the board or the size is wrong. */
export async function enqueuePlan(raw: any, by: string | null, deps: PlanJobDeps = LIVE) {
  const v = validatePlanParams(raw);
  if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors } };
  const params = v.params!;
  const rs = routerSettingsFrom(await deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null));
  const every = await listJobs(deps as any, JOB_KINDS);
  const busy = every.find((j: any) => j.kind === 'plan' && ACTIVE.has(j.status) && !j.cancelRequested && j.params?.date === params.date);
  if (busy) return { status: 409, body: { ok: false, error: `a plan of ${params.date} is already ${busy.status} — let it finish or Stop it before queuing another` } };
  let built;
  try { built = await readPlanDay(params, rs, deps); }
  catch (e: any) { return { status: 422, body: { ok: false, error: String(e?.message || e) } }; }
  const p = built.problem;
  // THE PREVIEW WAS OF A BOARD (review): if the scans rewrote the day since, the dispatcher has not
  // seen what would be planned, so it is refused and they preview again.
  const expect = typeof raw?.expectBoardAt === 'string' ? raw.expectBoardAt : null;
  if (expect && built.boardAt && expect !== built.boardAt) return { status: 409, body: { ok: false, error: `the board for ${params.date} was scanned again since your preview (then ${expect}, now ${built.boardAt}) — preview again to see what would be planned` } };
  if ((p as any).infeasible) return { status: 422, body: { ok: false, error: `not queued — ${(p as any).infeasible}` } };
  if (!p.stops.length) {
    const c: any = p.counts || {};
    return { status: 422, body: { ok: false, error: `nothing to plan on ${params.date}: of ${c.onBoard ?? 0} stops on the board, ${c.planned ?? 0} are already on a load, ${c.finished ?? 0} finished, ${c.pickups ?? 0} pickups, ${c.noLocation ?? 0} with no location` } };
  }
  const nothing = nothingToPlace(params, p);
  if (nothing) return { status: 422, body: { ok: false, error: `not queued — ${nothing}` } };
  const lp = btLoopProblem(p, built.cfg);
  const at = deps.now().toISOString();
  const stored = {
    problemJson: JSON.stringify(p), cfgJson: JSON.stringify(built.cfg),
    promptJson: JSON.stringify({ system: lp.system, tools: lp.tools, briefing: lp.briefing }), builtAt: at,
  };
  const bytes = utf8(stored.problemJson) + utf8(stored.cfgJson) + utf8(stored.promptJson);
  if (bytes > MAX_STORED_PLAN_BYTES) return { status: 422, body: { ok: false, error: `this plan is too large to store (${p.stops.length} stops, ${Math.round(bytes / 1000)} KB) — narrow the look-back, plan unplanned stops only, or plan a smaller section` } };
  const model = shadowModel(deps.env).model;
  const id = `pl__${params.date}__${at.replace(/[:.]/g, '-')}__${Math.random().toString(36).slice(2, 8)}`;
  // ONE PLAN OF A DAY AT A TIME, held by a create-only lock (the list check above is only a courtesy:
  // two presses a second apart both passed it). A lock whose job has finished is taken over.
  const lockPath = `${PLAN_LOCKS}/davis__${params.date}`;
  if (!(await deps.shadowCreate(lockPath, { jobId: id, at, by }))) {
    const lock = await deps.getDoc(lockPath).catch(() => null);
    const held = lock?.jobId ? await deps.getDoc(jobPath(String(lock.jobId))).catch(() => null) : null;
    if (held && ACTIVE.has(held.status) && !held.cancelRequested) return { status: 409, body: { ok: false, error: `a plan of ${params.date} is already ${held.status} — let it finish or Stop it before queuing another` } };
    await deps.shadowSet(lockPath, { jobId: id, at, by });
  }
  // THE BOARD FIRST, then the job: the worker only ever sees a plan job whose board is on file.
  await deps.shadowSet(`${jobPath(id)}/data/problem`, stored);
  // The job keeps the section's SIZE, not its list, so the jobs list (read every 20 s while one runs) does
  // not carry up to 1,400 stop numbers per plan; the stops the section took are frozen with the problem.
  const jobParams = { ...params, section: null, sectionSize: params.section ? params.section.length : null };
  const made = await deps.shadowCreate(jobPath(id), {
    kind: 'plan', date: params.date, params: jobParams, status: 'queued', createdAt: at, updatedAt: at, by,
    settings: { model, effort: rs.effort, maxRounds: rs.maxRounds, maxUsd: rs.maxUsd, maxTokens: rs.maxTokens, capRule: rs.capRule, lbsBox: rs.lbsBox, lbsTractor: rs.lbsTractor },
    rounds: 0, usd: 0, ended: null, endNote: null,
    stats: { stops: p.stops.length, loads: p.loads.length, noCoords: p.excluded.noCoords.length, capModelDays: p.capModel.days, boardAt: built.boardAt },
  });
  if (!made) return { status: 409, body: { ok: false, error: 'a job with that id already exists — press Plan again' } };
  // Where it stands, said honestly: the worker takes the oldest job first, backtests and plans alike,
  // and holds new work while the 24-hour ceiling is spent.
  const ahead = every.filter((j: any) => ACTIVE.has(j.status) && !j.cancelRequested).length;
  const waiting = ceilingView(every, rs, deps as any).holding ? 'ceiling' : null;
  return { status: 200, body: { ok: true, jobId: id, stops: p.stops.length, loads: p.loads.length, capacity: planCapacity(p), maxUsd: rs.maxUsd, model, ahead, waiting, nuvizzCalls: 0 } };
}

/** The planning area's read: the plan jobs (newest first), their spend, the shared ceiling, the settings. */
export async function planView(deps: PlanJobDeps = LIVE) {
  const [every, rsDoc] = await Promise.all([
    listJobs(deps as any, JOB_KINDS),
    deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null),
  ]);
  const rs = routerSettingsFrom(rsDoc);
  const plans = every.filter((j: any) => j.kind === 'plan');
  // For each queued plan, how many unfinished jobs (either kind) the worker takes before it.
  const live = every.filter((j: any) => ACTIVE.has(j.status) && !j.cancelRequested);
  const ahead: Record<string, number> = {};
  for (const j of plans) if (j.status === 'queued') ahead[j._id] = live.filter((x: any) => String(x.createdAt) < String(j.createdAt)).length;
  return {
    ok: true,
    ahead,
    jobs: plans.slice(-40).reverse(),
    spend: { usd: Math.round(plans.reduce((a: number, j: any) => a + (typeof j.usd === 'number' ? j.usd : 0), 0) * 100) / 100, runs: plans.length },
    ceiling: ceilingView(every, rs, deps as any),
    settings: rs,
    refused: routerRefusal(deps.env, deps.firestoreOn()),
    enabled: claudeShadowEnabled(deps.env),
    model: shadowModel(deps.env).model,
    nuvizzCalls: 0,
  };
}

// ── the endpoint's doors: the router settings in force, read once, and the live Firestore ─────────
const routerNow = async (deps: PlanJobDeps) => routerSettingsFrom(await deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null));
/** The picker: board days, the day's roster loads and every driver, each with the cap a plan would hold. */
export async function planOptionsNow(date: string | null, deps: PlanJobDeps = LIVE) { return planOptions(date, await routerNow(deps), deps); }
/** The preview: the plan exactly as Plan would build it, and what the picked loads lack. 0 spend. */
export async function planPreviewNow(raw: any, deps: PlanJobDeps = LIVE) {
  const rs = await routerNow(deps);
  const r = await planPreview(raw, rs, deps);
  return r;
}
export async function planResultNow(id: string, deps: PlanJobDeps = LIVE) { return planResult(id, deps); }
export async function planMapNow(id: string, deps: PlanJobDeps = LIVE) { return planMap(id, deps, jobPath); }
/** The stop map (v1.78.0): every open delivery a plan of these settings would see, for picking a section. 0 spend. */
export async function planStopsNow(raw: any, deps: PlanJobDeps = LIVE) { return planStops(raw, deps); }
