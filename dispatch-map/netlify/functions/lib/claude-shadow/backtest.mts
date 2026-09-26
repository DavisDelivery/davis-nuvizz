// lib/claude-shadow/backtest.mts — RUNNING BACKTESTS: the queue, the worker's turn, and what it stores.
//
// A backtest is a Claude conversation of several rounds, each one to three minutes at the model —
// longer than the Shadow tab's own endpoint may run (26 s), and a shadow background function cannot
// be called by hand (see claude-shadow-worker-background.mts). So the tab QUEUES a job and a
// scheduled worker runs it: each tick takes the oldest unfinished job, runs rounds while there is
// time to finish one, checkpoints every round to Firestore, and the next tick carries on.
//
// Reads (Firestore only, ZERO NuVizz calls): history_days (the sealed day), nuvizz_load_roster,
// claude_shadow_learn_days (capacity as of the day before), the shadow's settings and caps, the
// MarginIQ employees roster (truck class), customer_notes (equipment limits), routing_engine_config.
// Writes (store.mts only, so only claude_shadow_*):
//   claude_shadow_jobs/{id}                   the job: status, spend, rounds, the plan so far
//   claude_shadow_jobs/{id}/data/problem      the day exactly as Claude was shown it (a resumed run
//                                             replays the SAME briefing, byte for byte)
//   claude_shadow_jobs/{id}/rounds/r{nn}      every round: the model's content verbatim, the reply
//   claude_shadow_jobs/{id}/claims/r{n}a{k}   create-only round claims (one payer per round)
//   claude_shadow_backtests/davis__{D}        the latest finished comparison for day D
//   claude_shadow_settings/davis__router      the router's settings (cap rule, cost rates, limits)
import { getDoc, listDocs, isFirestoreEnabled } from '../firestore.mts';
import { shadowSet, shadowPatch, shadowCreate } from './store.mts';
import { callMessages, PRICES_PER_MTOK } from './anthropic.mts';
import { claudeShadowEnabled, shadowModel, anthropicKeyConfigured } from './config.mts';
import { learnRefusal, loosePerSkidFrom } from './learn.mts';
import { readSettings } from './settings.mts';
import { LEARN_DAYS_COLLECTION, HISTORY_MANIFEST_MASK, sealedDaysFrom } from './learn-core.mts';
import {
  BT_TENANT, BT_JOBS, BT_RESULTS, BT_STOP_MASK, LEARN_DAY_MASK, CAP_RULES,
  buildBacktestProblem, btLoopProblem, compareBacktest, backtestMapPayload, type BtProblem, type CapRule,
} from './backtest-core.mts';
import { restoreState, runRounds, type LoopState, type LoopSettings, type RoundRecord } from './plan-loop.mts';
import { effectiveEngineConfig, engineConfigPath } from '../routing-engine-config.mts';
import { DEPOT } from '../routing-types.mts';

export const ROUTER_SETTINGS_PATH = `claude_shadow_settings/${BT_TENANT}__router`;
// Not xhigh / max: those want max_tokens of 64K or more or they stop mid-thought, and every one of
// those tokens counts against the cap. 'high' is the most this router asks for.
export const EFFORTS = ['low', 'medium', 'high'] as const;

// THE ROUTER'S SETTINGS, with stated defaults. Cost rates have NO default: nothing in the code or
// the data says what a mile or a driver-hour costs Davis, and a guessed rate would print a guessed
// saving. Until they are entered, every result reports miles, minutes and trucks, and no dollars.
export const ROUTER_DEFAULTS = {
  capRule: 'tighter' as CapRule,
  costPerMile: null as number | null,
  costPerDriveHour: null as number | null,
  effort: 'high' as (typeof EFFORTS)[number],
  maxRounds: 8,
  maxUsd: 5,          // per backtest day
  maxTokens: 32000,   // per round (thinking + the plan)
};
export const ROUTER_BOUNDS = { maxRounds: [2, 20], maxUsd: [0.5, 50], maxTokens: [8000, 64000], costPerMile: [0, 50], costPerDriveHour: [0, 500] } as const;

export type RouterSettings = typeof ROUTER_DEFAULTS;

const numIn = (v: any, [lo, hi]: readonly [number, number]): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** The stored router settings over the defaults; anything malformed keeps the default. */
export function routerSettingsFrom(doc: any): RouterSettings {
  const d = doc || {};
  return {
    capRule: CAP_RULES.includes(d.capRule) ? d.capRule : ROUTER_DEFAULTS.capRule,
    costPerMile: d.costPerMile == null ? null : numIn(d.costPerMile, ROUTER_BOUNDS.costPerMile),
    costPerDriveHour: d.costPerDriveHour == null ? null : numIn(d.costPerDriveHour, ROUTER_BOUNDS.costPerDriveHour),
    effort: (EFFORTS as readonly string[]).includes(d.effort) ? d.effort : ROUTER_DEFAULTS.effort,
    maxRounds: numIn(d.maxRounds, ROUTER_BOUNDS.maxRounds) ?? ROUTER_DEFAULTS.maxRounds,
    maxUsd: numIn(d.maxUsd, ROUTER_BOUNDS.maxUsd) ?? ROUTER_DEFAULTS.maxUsd,
    maxTokens: numIn(d.maxTokens, ROUTER_BOUNDS.maxTokens) ?? ROUTER_DEFAULTS.maxTokens,
  };
}

/** Check a settings change whole; one bad value refuses it and nothing is written. */
export function validateRouterChange(change: any): { ok: boolean; errors: string[]; fields: Record<string, any> } {
  const errors: string[] = [];
  const fields: Record<string, any> = {};
  if (!change || typeof change !== 'object' || Array.isArray(change)) return { ok: false, errors: ['no change sent'], fields };
  if ('capRule' in change) { if (CAP_RULES.includes(change.capRule)) fields.capRule = change.capRule; else errors.push(`cap rule must be one of ${CAP_RULES.join(', ')}`); }
  if ('effort' in change) { if ((EFFORTS as readonly string[]).includes(change.effort)) fields.effort = change.effort; else errors.push(`effort must be one of ${EFFORTS.join(', ')}`); }
  for (const k of ['costPerMile', 'costPerDriveHour'] as const) {
    if (!(k in change)) continue;
    if (change[k] === null) { fields[k] = null; continue; }
    const v = numIn(change[k], ROUTER_BOUNDS[k]);
    if (v == null) errors.push(`${k} must be a number between ${ROUTER_BOUNDS[k][0]} and ${ROUTER_BOUNDS[k][1]}, or blank`); else fields[k] = Math.round(v * 100) / 100;
  }
  for (const k of ['maxRounds', 'maxUsd', 'maxTokens'] as const) {
    if (!(k in change)) continue;
    const v = numIn(change[k], ROUTER_BOUNDS[k]);
    if (v == null) errors.push(`${k} must be between ${ROUTER_BOUNDS[k][0]} and ${ROUTER_BOUNDS[k][1]}`); else fields[k] = k === 'maxUsd' ? Math.round(v * 100) / 100 : Math.round(v);
  }
  if (!errors.length && !Object.keys(fields).length) errors.push('nothing to change');
  return { ok: errors.length === 0, errors, fields };
}

export interface BtDeps {
  getDoc: (path: string) => Promise<any | null>;
  listDocs: (path: string, opts?: { mask?: string[] }) => Promise<any[]>;
  shadowSet: (path: string, data: Record<string, any>) => Promise<boolean>;
  shadowPatch: (path: string, data: Record<string, any>) => Promise<boolean>;
  shadowCreate: (path: string, data: Record<string, any>) => Promise<boolean>;
  call: typeof callMessages;
  now: () => Date;
  env: Record<string, any>;
  firestoreOn: () => boolean;
}
const LIVE: BtDeps = { getDoc, listDocs, shadowSet, shadowPatch, shadowCreate, call: callMessages, now: () => new Date(), env: process.env, firestoreOn: isFirestoreEnabled };

export const jobPath = (id: string) => `${BT_JOBS}/${id}`;
export const resultPath = (date: string) => `${BT_RESULTS}/${BT_TENANT}__${date}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = new Set(['queued', 'running']);

/** Why the router may not run here, or null. The learning refusal (switch, Firestore, UAT) plus the key. */
export function routerRefusal(env: Record<string, any>, firestoreOn: boolean = isFirestoreEnabled()): string | null {
  const r = learnRefusal(env, firestoreOn);
  if (r) return r;
  if (!anthropicKeyConfigured(env)) return 'ANTHROPIC_API_KEY is not set';
  const model = shadowModel(env).model;
  if (!PRICES_PER_MTOK[model]) return `${model} has no price row, so the per-day $ cap cannot be enforced`;
  return null;
}

// ── the 24-hour ceiling ─────────────────────────────────────────────────────
//
// Router settings are written through the same endpoint that queues backtests, so a per-day cap
// set THERE bounds nothing against whoever can reach that endpoint. This ceiling is an env var —
// nothing the API can change — over every backtest's spend in the last 24 hours. House shape:
// unset or malformed keeps the default; 0 stops all backtest spend.
export const DAILY_CEILING_DEFAULT = 25;
export function dailyCeilingUsd(env: Record<string, any>): number {
  const raw = String(env?.CLAUDE_ROUTER_DAILY_USD ?? '').trim();
  if (raw === '') return DAILY_CEILING_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : DAILY_CEILING_DEFAULT;
}
export function spentSince(jobs: any[], sinceMs: number): number {
  let t = 0;
  for (const j of jobs || []) {
    const at = Date.parse(String(j?.updatedAt || j?.createdAt || ''));
    if (Number.isFinite(at) && at >= sinceMs && typeof j?.usd === 'number') t += j.usd;
  }
  return Math.round(t * 1e6) / 1e6;
}
const DAY_MS = 24 * 60 * 60 * 1000;

// Firestore throttling (429), a 5xx, a dropped connection or a request deadline — the store's
// retries were spent, but the job itself is fine and resumes from its round records next tick.
const TRANSIENT_LIMIT = 5;
function transientFailure(e: any): boolean {
  const msg = String(e?.message || e);
  return /\bfailed: (?:429|500|502|503|504)\b/.test(msg) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|no answer within/i.test(msg)
    || e?.name === 'TimeoutError' || (e?.name === 'TypeError' && /\bfailed\b/.test(msg));
}

// ── reading one day ─────────────────────────────────────────────────────────

async function inPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const lane = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

/** Everything one backtest day is built from. Throws with a plain reason when the day cannot run. */
export async function readBacktestDay(date: string, rs: RouterSettings, deps: BtDeps = LIVE): Promise<{ problem: BtProblem; cfg: any }> {
  if (!DATE_RE.test(date)) throw new Error(`not a date: ${JSON.stringify(date)}`);
  const manifest = await deps.getDoc(`history_days/${BT_TENANT}__${date}`);
  const sealed = sealedDaysFrom(manifest ? [{ ...manifest, _id: `${BT_TENANT}__${date}` }] : []);
  if (!sealed.length) throw new Error(`${date} is not a sealed history day`);
  const [rows, roster, learnDays, settings, employees, engineDoc] = await Promise.all([
    deps.listDocs(`history_days/${BT_TENANT}__${date}/stops`, { mask: BT_STOP_MASK }),
    deps.getDoc(`nuvizz_load_roster/${BT_TENANT}__${date}`),
    deps.listDocs(LEARN_DAYS_COLLECTION, { mask: LEARN_DAY_MASK }),
    // The same reads through the injected doors, so a test's fake store serves them too.
    readSettings({ getDoc: deps.getDoc, listDocs: deps.listDocs } as any),
    deps.listDocs('employees', { mask: ['vehicleType', 'externalIds', 'fullName', 'firstName', 'lastName', 'aliases'] }).catch(() => [] as any[]),
    deps.getDoc(engineConfigPath(BT_TENANT)).catch(() => null),
  ]);
  if (settings.error) throw new Error(`the capacity settings could not be read: ${settings.error}`);
  // Equipment limits: one note per customer on the day (current state; said on the result).
  const keys = [...new Set((rows || []).map((r: any) => r?.customerMatchKey).filter((k: any) => typeof k === 'string' && /^[\w\- .&']{1,200}$/.test(k)))];
  const noteList = await inPool(keys, 8, async (k: string) => [k, await deps.getDoc(`customer_notes/${k}`).catch(() => null)] as const);
  const notes = new Map(noteList.filter(([, n]) => n) as [string, any][]);
  const cfg = effectiveEngineConfig(engineDoc, deps.env);
  const problem = buildBacktestProblem({
    date, rows, roster, stamp: sealed[0].stamp,
    learnDaysBefore: (learnDays || []).filter((d: any) => String(d?.date || '') < date),
    caps: settings.caps, loosePerSkid: loosePerSkidFrom(settings.settings).value, capRule: rs.capRule,
    employees, notes, depot: { lat: DEPOT.lat, lng: DEPOT.lng }, at: deps.now().toISOString(), cfg,
  });
  return { problem, cfg };
}

// ── the queue ───────────────────────────────────────────────────────────────

const JOB_MASK = ['kind', 'date', 'status', 'cancelRequested', 'transientErrors', 'createdAt', 'by', 'startedAt', 'finishedAt', 'updatedAt', 'rounds', 'usd', 'ended', 'endNote', 'error', 'settings', 'stats', 'headline'];

export async function listJobs(deps: BtDeps = LIVE): Promise<any[]> {
  const docs = await deps.listDocs(BT_JOBS, { mask: JOB_MASK });
  return (docs || []).filter((d: any) => d?.kind === 'backtest').sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Queue one job per date. A date already queued or running is not queued twice. */
export async function enqueueBacktests(dates: any, by: string | null, deps: BtDeps = LIVE) {
  const list = Array.isArray(dates) ? [...new Set(dates.map(String))] : [];
  if (!list.length) return { status: 400, body: { ok: false, error: 'no dates sent' } };
  if (list.length > 31) return { status: 400, body: { ok: false, error: 'at most 31 days per request' } };
  const bad = list.filter((d) => !DATE_RE.test(d));
  if (bad.length) return { status: 400, body: { ok: false, error: `not dates: ${bad.join(', ')}` } };
  const manifests = await deps.listDocs('history_days', { mask: HISTORY_MANIFEST_MASK });
  const sealed = new Set(sealedDaysFrom(manifests).map((s) => s.date));
  const notSealed = list.filter((d) => !sealed.has(d));
  if (notSealed.length) return { status: 400, body: { ok: false, error: `not sealed history days: ${notSealed.join(', ')}` } };
  const rs = routerSettingsFrom(await deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null));
  const model = shadowModel(deps.env).model;
  const active = new Set((await listJobs(deps)).filter((j) => ACTIVE.has(j.status)).map((j) => j.date));
  const at = deps.now().toISOString();
  const queued: string[] = [], skipped: string[] = [];
  for (const [i, date] of list.sort().entries()) {
    if (active.has(date)) { skipped.push(date); continue; }
    const id = `bt__${date}__${at.replace(/[:.]/g, '-')}__${i}`;
    const made = await deps.shadowCreate(jobPath(id), {
      kind: 'backtest', date, status: 'queued', createdAt: at, updatedAt: at, by,
      settings: { model, effort: rs.effort, maxRounds: rs.maxRounds, maxUsd: rs.maxUsd, maxTokens: rs.maxTokens, capRule: rs.capRule },
      rounds: 0, usd: 0, ended: null, endNote: null,
    });
    (made ? queued : skipped).push(date);
  }
  return { status: 200, body: { ok: true, queued, skipped, maxUsdEach: rs.maxUsd, maxUsdTotal: Math.round(queued.length * rs.maxUsd * 100) / 100, model } };
}

export async function cancelJob(id: string, by: string | null, deps: BtDeps = LIVE) {
  if (typeof id !== 'string' || !/^bt__[\w\-]+$/.test(id)) return { status: 400, body: { ok: false, error: 'bad job id' } };
  const job = await deps.getDoc(jobPath(id));
  if (!job) return { status: 404, body: { ok: false, error: 'no such job' } };
  if (!ACTIVE.has(job.status)) return { status: 409, body: { ok: false, error: `the job is already ${job.status}` } };
  const at = deps.now().toISOString();
  // cancelRequested is written by NOTHING else, so no later status write can undo a Stop.
  await deps.shadowPatch(jobPath(id), { status: 'cancelled', cancelRequested: true, finishedAt: at, updatedAt: at, endNote: `cancelled by ${by || 'unknown'} — a round already at the model still finishes and is billed` });
  return { status: 200, body: { ok: true } };
}

// ── the worker's turn ───────────────────────────────────────────────────────

// A round started at the model is allowed ten minutes; a worker invocation lives fifteen. So a
// round is only STARTED in the first four minutes of an invocation — it always has time to finish.
export const ROUND_TIMEOUT_MS = 10 * 60 * 1000;
export const START_ROUNDS_BEFORE_MS = 4 * 60 * 1000;
// A claim older than this whose round never landed belonged to an invocation that died.
export const CLAIM_STALE_MS = 16 * 60 * 1000;

const roundId = (n: number) => `r${String(n).padStart(2, '0')}`;

async function loadState(id: string, deps: BtDeps): Promise<LoopState> {
  const docs = await deps.listDocs(`${jobPath(id)}/rounds`);
  const rounds: RoundRecord[] = (docs || []).map((d: any) => { const { _id, ...r } = d; void _id; return r as RoundRecord; });
  return restoreState(rounds);
}

/** Create-only claim on round n; takes over a claim whose invocation died. */
async function claimRound(id: string, n: number, deps: BtDeps): Promise<boolean> {
  const now = deps.now();
  for (let k = 1; k <= 5; k++) {
    const path = `${jobPath(id)}/claims/r${n}a${k}`;
    if (await deps.shadowCreate(path, { n, attempt: k, at: now.toISOString() })) return true;
    const held = await deps.getDoc(path);
    const heldAt = Date.parse(String(held?.at || ''));
    if (Number.isFinite(heldAt) && now.getTime() - heldAt < CLAIM_STALE_MS) return false;   // someone is on it
  }
  return false;
}

const stopped = (job: any) => job?.cancelRequested === true || job?.status === 'cancelled';

async function wasCancelled(id: string, deps: BtDeps): Promise<boolean> {
  const fresh = await deps.getDoc(jobPath(id)).catch(() => null);
  if (!stopped(fresh)) return false;
  // A Stop that landed while the day was being built was overwritten by the 'running' write; put it back.
  if (fresh.status !== 'cancelled') await deps.shadowPatch(jobPath(id), { status: 'cancelled', updatedAt: deps.now().toISOString() }).catch(() => {});
  return true;
}

/** The prompt stored with the job, if it reads; a malformed one falls back to today's code. */
export function frozenPrompt(promptJson: string): Partial<{ system: string; tools: any[]; briefing: string }> {
  try {
    const p = JSON.parse(promptJson);
    if (typeof p?.system === 'string' && Array.isArray(p?.tools) && typeof p?.briefing === 'string') return { system: p.system, tools: p.tools, briefing: p.briefing };
  } catch { /* fall through */ }
  return {};
}

/** One worker tick: take the oldest unfinished job and advance it. Returns what it did. */
export async function workerTick(deps: BtDeps = LIVE): Promise<any> {
  const t0 = deps.now().getTime();
  const refused = routerRefusal(deps.env, deps.firestoreOn());
  if (refused) return { ok: true, idle: true, refused };
  const jobs = await listJobs(deps);
  const live = jobs.filter((j) => !j.cancelRequested);
  const job = live.find((j) => j.status === 'running') || live.find((j) => j.status === 'queued');
  if (!job) return { ok: true, idle: true };
  const ceiling = dailyCeilingUsd(deps.env);
  const room = Math.round((ceiling - spentSince(jobs, t0 - DAY_MS)) * 1e6) / 1e6;
  // A day not yet started waits while the last 24 hours cannot pay even one round's output; it is
  // not failed, and it starts when the window rolls on.
  const js = job.settings || {};
  const rate = PRICES_PER_MTOK[js.model || shadowModel(deps.env).model]?.output ?? Infinity;
  const oneRoundOut = ((js.maxTokens || ROUTER_DEFAULTS.maxTokens) * rate) / 1e6;
  if (job.status === 'queued' && room < oneRoundOut) return { ok: true, idle: true, held: `the 24-hour backtest ceiling ($${ceiling}, CLAUDE_ROUTER_DAILY_USD) is spent` };
  const id = String(job._id);
  const at = () => deps.now().toISOString();
  // Only the invocation that DID something with this job — built its day, or claimed a round —
  // may mark it failed. A tick that overlaps the owner (every 3 minutes, against rounds of up to
  // 10) and trips on one transient read would otherwise fail a job the owner is still paying for,
  // and a re-queue would pay for the day twice.
  let owned = false;
  try {
    // THE PROBLEM IS BUILT ONCE and stored: a resumed run must show Claude the same day it saw.
    let stored = await deps.getDoc(`${jobPath(id)}/data/problem`);
    if (!stored) {
      owned = true;
      const rs = routerSettingsFrom({ ...(await deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null)), ...(job.settings || {}) });
      const { problem, cfg } = await readBacktestDay(job.date, rs, deps);
      if (!problem.stops.length) {
        await deps.shadowPatch(jobPath(id), { status: 'failed', finishedAt: at(), updatedAt: at(), error: 'the day has no stops that rode out with a usable location' });
        return { ok: true, job: id, failed: 'no stops' };
      }
      // The prompt is frozen WITH the data: a deploy mid-job that edits the system text, the tools or
      // the briefing format would otherwise change the prefix under replayed thinking, and the API
      // refuses that. The evaluator is still today's code — it is the rules, not the conversation.
      const lp = btLoopProblem(problem, cfg);
      const promptJson = JSON.stringify({ system: lp.system, tools: lp.tools, briefing: lp.briefing });
      stored = { problemJson: JSON.stringify(problem), cfgJson: JSON.stringify(cfg), promptJson, builtAt: at() };
      await deps.shadowSet(`${jobPath(id)}/data/problem`, stored);
      await deps.shadowPatch(jobPath(id), {
        status: 'running', startedAt: at(), updatedAt: at(),
        stats: { stops: problem.stops.length, loads: problem.loads.length, noCoords: problem.excluded.noCoords.length, capModelDays: problem.capModel.days },
      });
    }
    const problem: BtProblem = JSON.parse(stored.problemJson);
    const cfg = JSON.parse(stored.cfgJson);
    const loopProblem = btLoopProblem(problem, cfg);
    if (typeof stored.promptJson === 'string') Object.assign(loopProblem, frozenPrompt(stored.promptJson));
    const s = job.settings || {};
    const settings: LoopSettings = {
      model: s.model || shadowModel(deps.env).model, effort: s.effort || ROUTER_DEFAULTS.effort,
      maxTokens: s.maxTokens || ROUTER_DEFAULTS.maxTokens, maxRounds: s.maxRounds || ROUTER_DEFAULTS.maxRounds, maxUsd: s.maxUsd || ROUTER_DEFAULTS.maxUsd,
    };
    let state = await loadState(id, deps);
    let persisted = state.rounds.length;
    // This job may spend no more than what the 24-hour ceiling has left (its own spend so far is
    // inside `room`'s total already, so its budget is what it has spent plus what is left).
    const ownCap = settings.maxUsd;
    settings.maxUsd = Math.min(ownCap, Math.round((state.usd + Math.max(0, room)) * 1e6) / 1e6);
    const apiKey = String(deps.env?.ANTHROPIC_API_KEY || '');
    state = await runRounds(loopProblem, state, settings, {
      call: (req) => deps.call(req, { apiKey, timeoutMs: ROUND_TIMEOUT_MS }),
      claim: async (n) => {
        if (await wasCancelled(id, deps)) return false;   // a job stopped mid-run stops at the next round
        const got = await claimRound(id, n, deps);
        if (got) owned = true;
        return got;
      },
      checkpoint: async (st) => {
        for (let i = persisted; i < st.rounds.length; i++) await deps.shadowSet(`${jobPath(id)}/rounds/${roundId(st.rounds[i].n)}`, st.rounds[i] as any);
        persisted = st.rounds.length;
        await deps.shadowPatch(jobPath(id), {
          updatedAt: at(), rounds: st.rounds.length, usd: st.usd, ended: st.ended, endNote: st.endNote, transientErrors: 0,
          bestCleanRound: st.bestCleanRound, bestCleanJson: st.bestClean ? JSON.stringify(st.bestClean) : null,
          finalJson: st.final ? JSON.stringify(st.final) : null,
        });
      },
      now: () => deps.now().getTime(),
      iso: at,
    }, START_ROUNDS_BEFORE_MS - (deps.now().getTime() - t0));
    if (state.ended === 'max-usd' && settings.maxUsd < ownCap) {
      state = { ...state, endNote: `${state.endNote} — the 24-hour ceiling across all backtests (CLAUDE_ROUTER_DAILY_USD, $${ceiling}) left this day $${settings.maxUsd.toFixed(2)} of its $${ownCap.toFixed(2)}` };
      await deps.shadowPatch(jobPath(id), { endNote: state.endNote, updatedAt: at() });
    }
    if (!state.ended) return { ok: true, job: id, rounds: state.rounds.length, usd: state.usd, continuing: true };
    return await finishJob(id, job, problem, cfg, state, deps);
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    if (!owned) return { ok: false, job: id, error: msg, left: 'another invocation owns this job; its status was not touched' };
    // A THROTTLE IS NOT A VERDICT. The writes already retried for ~15 s (store.mts); if Firestore
    // is still refusing, the job stays 'running' and the next tick resumes it from its round
    // records — nothing paid for is lost. Only a run of them in a row fails it, so a lasting
    // outage cannot hold the queue forever.
    if (transientFailure(e)) {
      const n = (typeof job.transientErrors === 'number' ? job.transientErrors : 0) + 1;
      if (n < TRANSIENT_LIMIT) {
        await deps.shadowPatch(jobPath(id), { transientErrors: n, lastError: msg, lastErrorAt: at(), updatedAt: at() }).catch(() => {});
        return { ok: false, job: id, error: msg, transient: n };
      }
    }
    if (!(await wasCancelled(id, deps))) await deps.shadowPatch(jobPath(id), { status: 'failed', finishedAt: at(), updatedAt: at(), error: msg }).catch(() => {});
    return { ok: false, job: id, error: msg };
  }
}

/** The run ended: score the plan (the submitted one, else the last clean one) and store the result. */
export async function finishJob(id: string, job: any, problem: BtProblem, cfg: any, state: LoopState, deps: BtDeps) {
  const at = deps.now().toISOString();
  // Stopped while its last round was at the model: Stop means stop — no result is published and the
  // job stays 'cancelled'. What that round cost is already on the job (the checkpoint wrote it).
  if (await wasCancelled(id, deps)) return { ok: true, job: id, cancelled: true, usd: state.usd };
  const plan = state.final ?? state.bestClean;
  if (!plan) {
    await deps.shadowPatch(jobPath(id), { status: 'failed', finishedAt: at, updatedAt: at, error: `no plan without a hard-rule violation: ${state.endNote || state.ended}` });
    return { ok: true, job: id, failed: state.ended };
  }
  const rs = routerSettingsFrom(await deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null));
  const cmp = compareBacktest(problem, plan, cfg, { perMile: rs.costPerMile, perDriveHour: rs.costPerDriveHour });
  const submitted = !!state.final;
  const result = {
    tenant: BT_TENANT, date: problem.date, jobId: id, at, submitted,
    planFrom: submitted ? 'submitted' : `the last clean evaluation (round ${state.bestCleanRound}) — the run ended before a submit (${state.ended})`,
    model: job?.settings?.model ?? null, effort: job?.settings?.effort ?? null, capRule: problem.capRule, loosePerSkid: problem.loosePerSkid,
    rounds: state.rounds.length, usd: state.usd, ended: state.ended, endNote: state.endNote,
    rates: { perMile: rs.costPerMile, perDriveHour: rs.costPerDriveHour },
    stats: { stops: problem.stops.length, loads: problem.loads.length, excludedNoCoords: problem.excluded.noCoords.length, capModelDays: problem.capModel.days, counts: problem.counts, roster: problem.roster ?? null, stampGate: problem.stampGate ?? null },
    approximations: problem.approximations,
    ...cmp,
    nuvizzCalls: 0,
  };
  await deps.shadowSet(resultPath(problem.date), result);
  const headline = { miles: cmp.vsDriven.miles, driveMin: cmp.vsDriven.driveMin, trucks: cmp.vsDriven.trucks, cost: cmp.vsDriven.cost };
  await deps.shadowPatch(jobPath(id), { status: 'done', finishedAt: at, updatedAt: at, headline, submitted });
  return { ok: true, job: id, done: true, headline };
}

/** The ceiling as the panel shows it — and whether the worker is holding queued days on it (same test). */
function ceilingView(jobs: any[], rs: any, deps: BtDeps) {
  const usd = dailyCeilingUsd(deps.env);
  const spent24h = spentSince(jobs, deps.now().getTime() - DAY_MS);
  const rate = PRICES_PER_MTOK[shadowModel(deps.env).model]?.output ?? Infinity;
  return { usd, spent24h, holding: usd - spent24h < ((rs.maxTokens || ROUTER_DEFAULTS.maxTokens) * rate) / 1e6 };
}

/** The Backtest panel's read: sealed days, the latest result per day, the jobs, the settings. */
export async function backtestView(deps: BtDeps = LIVE) {
  const [manifests, results, jobs, rsDoc] = await Promise.all([
    deps.listDocs('history_days', { mask: HISTORY_MANIFEST_MASK }),
    deps.listDocs(BT_RESULTS, { mask: ['date', 'at', 'jobId', 'submitted', 'usd', 'rounds', 'ended', 'columns', 'vsDriven', 'sequencingOnly', 'assignmentOnly', 'agreement', 'costs', 'stats', 'model'] }),
    listJobs(deps),
    deps.getDoc(ROUTER_SETTINGS_PATH).catch(() => null),
  ]);
  const byDate = new Map((results || []).map((r: any) => [r.date, r]));
  const days = sealedDaysFrom(manifests).map((s) => s.date).sort().reverse();
  return {
    ok: true,
    days: days.map((d) => ({ date: d, result: byDate.get(d) || null })),
    jobs: jobs.slice(-60).reverse(),
    // EVERY run's spend — failed, stopped and re-run days included — not just each day's latest result.
    spend: { usd: Math.round(jobs.reduce((a: number, j: any) => a + (typeof j.usd === 'number' ? j.usd : 0), 0) * 100) / 100, runs: jobs.length },
    ceiling: ceilingView(jobs, routerSettingsFrom(rsDoc), deps),
    settings: routerSettingsFrom(rsDoc), defaults: ROUTER_DEFAULTS, bounds: ROUTER_BOUNDS, efforts: EFFORTS, capRules: CAP_RULES,
    refused: routerRefusal(deps.env, deps.firestoreOn()),
    enabled: claudeShadowEnabled(deps.env),
    model: shadowModel(deps.env).model,
    nuvizzCalls: 0,
  };
}

export async function backtestResult(date: string, deps: BtDeps = LIVE) {
  if (!DATE_RE.test(String(date))) return { status: 400, body: { ok: false, error: 'bad date' } };
  const r = await deps.getDoc(resultPath(date));
  if (!r) return { status: 404, body: { ok: false, error: `no backtest for ${date} yet` } };
  return { status: 200, body: { ok: true, result: r } };
}

/** The map's read: the day's stored stops with their places, and each plan's loads in order. */
export async function backtestMap(date: string, deps: BtDeps = LIVE) {
  if (!DATE_RE.test(String(date))) return { status: 400, body: { ok: false, error: 'bad date' } };
  const r = await deps.getDoc(resultPath(date));
  if (!r) return { status: 404, body: { ok: false, error: `no backtest for ${date} yet` } };
  const stored = typeof r.jobId === 'string' && r.jobId ? await deps.getDoc(`${jobPath(r.jobId)}/data/problem`) : null;
  if (typeof stored?.problemJson !== 'string') return { status: 404, body: { ok: false, error: `the stops stored with ${date}'s backtest are not on file — re-run the day to map it` } };
  let problem: BtProblem;
  try { problem = JSON.parse(stored.problemJson); } catch { return { status: 500, body: { ok: false, error: 'the stored day could not be read' } }; }
  return { status: 200, body: { ok: true, map: backtestMapPayload(problem, r), nuvizzCalls: 0 } };
}

export async function saveRouterSettings(change: any, by: string | null, deps: BtDeps = LIVE) {
  const v = validateRouterChange(change);
  if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors } };
  const at = deps.now().toISOString();
  await deps.shadowPatch(ROUTER_SETTINGS_PATH, { ...v.fields, updatedAt: at, updatedBy: by });
  const back = routerSettingsFrom(await deps.getDoc(ROUTER_SETTINGS_PATH));
  return { status: 200, body: { ok: true, settings: back } };
}

