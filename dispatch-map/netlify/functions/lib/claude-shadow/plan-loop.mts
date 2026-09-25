// lib/claude-shadow/plan-loop.mts — THE CLAUDE ROUTER'S CONVERSATION: propose, check, revise, submit.
//
// Claude does not hand back a plan and hope. It proposes a full assignment through the
// evaluate_plan tool; a PURE evaluator (the caller's) checks every HARD rule and sequences each
// load, and answers with per-load stops, skid spots against the cap, miles, drive minutes and every
// violation; Claude revises; and only submit_plan ends the run. A submitted plan that still breaks
// a HARD rule is sent back as an error, never stored as final.
//
// This file owns the loop and nothing about freight: the problem (system prompt, briefing, tools,
// evaluator) comes in from the caller, and so does the model call — so the whole loop runs in a
// test against a scripted "model", and a checkpointed run resumes from Firestore on the next
// worker tick exactly where it stopped.
//
// WHAT THE API REQUIRES OF A LOOP LIKE THIS, for claude-opus-5-5 (checked against the API
// reference, not recalled):
//   - thinking cannot be switched off; effort (output_config.effort) is the only control and its
//     default is `medium`, so it is ALWAYS set explicitly here;
//   - forced tool_choice ("any"/"tool") is a 400 — tool_choice is `auto`, the tools are strict,
//     and the loop CHECKS that a tool was called, nudging once per round when it was not;
//   - thinking blocks go back UNCHANGED and the history is only ever appended to — so a round's
//     assistant content is stored as the exact JSON it arrived as, and replayed from that;
//   - prompt caching: the system prompt and the briefing are the stable prefix (breakpoints on
//     both), and a top-level cache_control lets the growing history cache round to round.
//
// MONEY IS COUNTED FROM THE RESPONSE. Every round's `usage` is priced by usageCost (anthropic.mts)
// and summed; the loop will not START a round that the run's cap cannot cover at the last round's
// cost, and it stops at the round cap. Both stops are recorded as the reason the run ended.
import { usageCost, PRICES_PER_MTOK, type CallResult } from './anthropic.mts';

export interface ToolDef { name: string; description: string; strict: true; input_schema: Record<string, any> }

export interface Problem {
  system: string;                 // stable across the run (cached)
  briefing: string;               // the day's loads and stops (cached)
  tools: ToolDef[];               // evaluate_plan + submit_plan
  evaluate: (input: any) => EvalResult;
}

export interface EvalResult {
  ok: boolean;                    // true only when NO hard rule is broken
  summary: any;                   // what goes back to Claude (compact, JSON-able)
  plan: any;                      // the normalised plan the evaluator judged
}

export interface LoopSettings {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  maxRounds: number;
  maxUsd: number;
}

// One round as stored: the assistant's content EXACTLY as it came back (JSON text, so a replay is
// byte-identical in content), and the user turn the loop answered it with.
export interface RoundRecord {
  n: number;
  at: string;
  ms: number;
  httpStatus: number | null;
  ok: boolean;
  error: string | null;
  stopReason: string | null;
  servedModel: string | null;
  assistantJson: string | null;   // JSON.stringify(response.content)
  replyJson: string | null;       // JSON.stringify(user content the loop sent back)
  tools: { name: string; ok: boolean | null }[];
  usage: any | null;
  usd: number | null;
  costBasis: string | null;
  // What the round DECIDED, so a resumed run is rebuilt from its rounds alone (restoreState):
  cleanPlanJson?: string | null;   // the last plan this round evaluated with no HARD violation
  finalPlanJson?: string | null;   // the plan this round submitted and the rules accepted
  endedWith?: EndReason;           // 'refused' / 'api-error' / 'submitted' — ended by this round
  endNote?: string | null;
}

export type EndReason = 'submitted' | 'max-rounds' | 'max-usd' | 'refused' | 'api-error' | 'budget' | null;

export interface LoopState {
  rounds: RoundRecord[];
  usd: number;
  ended: EndReason;
  endNote: string | null;
  final: any | null;              // the submitted plan that passed every HARD rule
  finalSummary: any | null;
  bestClean: any | null;          // the last evaluate_plan result with no HARD violation
  bestCleanSummary: any | null;
  bestCleanRound: number | null;
}

export function emptyState(): LoopState {
  return { rounds: [], usd: 0, ended: null, endNote: null, final: null, finalSummary: null, bestClean: null, bestCleanSummary: null, bestCleanRound: null };
}

/**
 * Rebuild a run's state from its stored rounds alone — the same state applyResponse built live.
 * The rounds are the record: each is written before the job doc is touched, so nothing a later
 * write loses (a masked read, a crash between two writes) can make a resumed run forget a clean
 * plan it paid for, or pay for more rounds after a plan was already accepted.
 */
export function restoreState(records: RoundRecord[]): LoopState {
  const st = emptyState();
  st.rounds = records.filter((r) => typeof r?.n === 'number').slice().sort((a, b) => a.n - b.n);
  for (const r of st.rounds) {
    if (typeof r.usd === 'number') st.usd = Math.round((st.usd + r.usd) * 1e6) / 1e6;
    if (r.cleanPlanJson) { const c = JSON.parse(r.cleanPlanJson); st.bestClean = c.plan; st.bestCleanSummary = c.summary; st.bestCleanRound = r.n; }
    if (r.finalPlanJson) { const f = JSON.parse(r.finalPlanJson); st.final = f.plan; st.finalSummary = f.summary; }
    if (r.endedWith) { st.ended = r.endedWith; st.endNote = r.endNote ?? null; }
  }
  return st;
}

export const NUDGE_NO_TOOL = 'You answered without calling a tool. Call evaluate_plan with a complete assignment, or submit_plan when the last evaluation had no hard violations.';
export const NUDGE_MAX_TOKENS = 'Your last answer hit the output limit before a tool call finished. Call evaluate_plan again with a complete assignment; keep your reasoning brief.';

/** The messages array for the next request: the briefing, then every stored round, appended. */
export function messagesFor(problem: Problem, state: LoopState): any[] {
  const msgs: any[] = [{
    role: 'user',
    content: [{ type: 'text', text: problem.briefing, cache_control: CACHE }],
  }];
  for (const r of state.rounds) {
    if (!r.assistantJson) continue;           // a failed call added nothing to the conversation
    msgs.push({ role: 'assistant', content: JSON.parse(r.assistantJson) });
    if (r.replyJson) msgs.push({ role: 'user', content: JSON.parse(r.replyJson) });
  }
  return msgs;
}

// ONE HOUR, on all three markers (they must match: a longer TTL may not follow a shorter one).
// Rounds start more than 5 minutes apart whenever one runs long or crosses a worker tick, and a
// 5-minute entry would be re-written at 1.25× each time; the reference puts a 5–60 minute gap on
// the 1-hour TTL.
const CACHE = { type: 'ephemeral', ttl: '1h' } as const;

export function buildRequest(problem: Problem, state: LoopState, s: LoopSettings): Record<string, any> {
  return {
    model: s.model,
    max_tokens: s.maxTokens,
    // Streamed: an unstreamed round sends no headers until it is done, and Node's HTTP client
    // gives up on headers at ~300 s — well inside a round's budget. The door folds the stream back
    // into the same message, so nothing downstream changes.
    stream: true,
    // Thinking is always on for this model; effort is the one control, set explicitly.
    output_config: { effort: s.effort },
    // Top-level: cache the growing history round to round (the prefix grows by one round each time).
    cache_control: CACHE,
    system: [{ type: 'text', text: problem.system, cache_control: CACHE }],
    tools: problem.tools,
    tool_choice: { type: 'auto' },
    messages: messagesFor(problem, state),
  };
}

/** Whether the run may start another round, and if not, why. Pure. */
export function mayStartRound(state: LoopState, s: LoopSettings, problem?: Problem): { ok: boolean; reason: EndReason; note: string | null } {
  if (state.ended) return { ok: false, reason: state.ended, note: state.endNote };
  if (state.rounds.length >= s.maxRounds) return { ok: false, reason: 'max-rounds', note: `stopped at the round cap (${s.maxRounds})` };
  // Do not start a round the cap cannot cover at its WORST: the check is BEFORE the spend, because
  // a round cannot be stopped halfway once it is billed — and round 1 is checked like any other.
  // Priced at the most it could cost, the cap is a ceiling, not an estimate.
  let next: number;
  let basis: string;
  if (problem) {
    const worst = worstRoundUsd(problem, state, s);
    if (worst === null) return { ok: false, reason: 'budget', note: `no price for ${s.model}: spend could not be counted, so no round is started` };
    next = worst; basis = 'the most the next round could cost';
  } else {
    next = [...state.rounds].reverse().find((r) => typeof r.usd === 'number')?.usd ?? 0; basis = 'the last round cost';
  }
  if (state.usd + next > s.maxUsd) {
    return { ok: false, reason: 'max-usd', note: `stopped before round ${state.rounds.length + 1}: $${state.usd.toFixed(2)} spent, ${basis} $${next.toFixed(2)}, the cap is $${s.maxUsd.toFixed(2)}` };
  }
  return { ok: true, reason: null, note: null };
}

/**
 * The most the next round could cost: the whole request at the dearest input rate (~2 characters
 * a token, well under the real ratio, so an overcount) plus every output token it may write.
 * null when the model has no price row — then nothing can be promised, and nothing is started.
 */
export function worstRoundUsd(problem: Problem, state: LoopState, s: LoopSettings): number | null {
  const r = PRICES_PER_MTOK[s.model];
  if (!r) return null;
  const input = Math.ceil(JSON.stringify(buildRequest(problem, state, s)).length / 2);
  return Math.round(((input * Math.max(r.input, r.cacheWrite5m, r.cacheWrite1h) + s.maxTokens * r.output) / 1e6) * 1e6) / 1e6;
}

/**
 * A call that left and came back with no usage — our deadline, a dropped connection, a 5xx — may
 * still have been billed, and what it cost cannot be read back. Charge it on the HIGH side (the
 * whole request at the uncached input price, plus every output token it was allowed) so the cap
 * stops a run early rather than late. A 4xx (429 included) is refused before any work: $0.
 */
export function unreadCost(problem: Problem, state: LoopState, s: LoopSettings, call: CallResult): { usd: number | null; basis: string } | null {
  if (call.ok) return null;
  const sent = call.timedOut || call.httpStatus === null || call.httpStatus >= 500;
  if (!sent) return null;
  // ~2 characters per token is well under the real ratio for this JSON, so this overcounts.
  const input = Math.ceil(JSON.stringify(buildRequest(problem, state, s)).length / 2);
  const est = usageCost(s.model, { input_tokens: input, output_tokens: s.maxTokens });
  if (est.usd === null) return null;
  return { usd: est.usd, basis: `ESTIMATE, high side: the call failed (${call.timedOut ? 'timed out' : call.httpStatus ?? 'no response'}) after it was sent, so its billed usage cannot be read — charged as ~${input} input tokens at the uncached price plus all ${s.maxTokens} output tokens` };
}

/**
 * Take ONE response and fold it into the state: record the round, run every tool the model
 * called, and build the reply the next request will carry. Pure apart from problem.evaluate.
 */
export function applyResponse(problem: Problem, state: LoopState, s: LoopSettings, call: CallResult, at: string): LoopState {
  const next: LoopState = { ...state, rounds: [...state.rounds] };
  const n = state.rounds.length + 1;
  const body = call.ok ? call.body : null;
  const content: any[] = Array.isArray(body?.content) ? body.content : [];
  const servedModel = typeof body?.model === 'string' ? body.model : null;
  const cost = body?.usage ? usageCost(servedModel || s.model, body.usage) : unreadCost(problem, state, s, call);
  const round: RoundRecord = {
    n, at, ms: call.ms, httpStatus: call.httpStatus, ok: call.ok, error: call.error,
    stopReason: typeof body?.stop_reason === 'string' ? body.stop_reason : null,
    servedModel,
    assistantJson: null, replyJson: null, tools: [],
    usage: body?.usage ?? null, usd: cost?.usd ?? null, costBasis: cost?.basis ?? null,
    cleanPlanJson: null, finalPlanJson: null, endedWith: null, endNote: null,
  };
  if (typeof round.usd === 'number') next.usd = Math.round((state.usd + round.usd) * 1e6) / 1e6;
  // Served by a model with no price row: this round's tokens are real but its dollars cannot be
  // counted, so the cap no longer means anything. The round is kept; the run stops after it.
  const unpriced = call.ok && body?.usage && round.usd === null;

  if (!call.ok) {
    next.rounds.push(round);
    // A 4xx is the request's fault and will not fix itself; stop and say why. A timeout or 5xx
    // may be transient: the round is recorded (it may still have been billed: unreadCost charges it on the high side)
    // and the next attempt starts from the same history.
    const permanent = call.httpStatus !== null && call.httpStatus >= 400 && call.httpStatus < 500 && call.httpStatus !== 429;
    if (permanent) { next.ended = 'api-error'; next.endNote = `the API refused the request (HTTP ${call.httpStatus}): ${call.error}`; }
    round.endedWith = next.ended; round.endNote = next.endNote;
    return next;
  }

  if (round.stopReason === 'refusal') {
    round.assistantJson = JSON.stringify(content);
    next.rounds.push(round);
    next.ended = 'refused';
    next.endNote = `the model declined (${body?.stop_details?.category ?? 'no category'}): ${body?.stop_details?.explanation ?? ''}`.trim();
    round.endedWith = next.ended; round.endNote = next.endNote;
    return next;
  }

  round.assistantJson = JSON.stringify(content);
  const uses = content.filter((b) => b?.type === 'tool_use');
  const reply: any[] = [];
  let submitted: EvalResult | null = null;
  for (const u of uses) {
    const name = String(u?.name || '');
    if (name !== 'evaluate_plan' && name !== 'submit_plan') {
      reply.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Unknown tool ${JSON.stringify(name)}. Use evaluate_plan or submit_plan.` });
      round.tools.push({ name, ok: null });
      continue;
    }
    let res: EvalResult;
    try { res = problem.evaluate(u.input); }
    catch (e: any) {
      reply.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `The plan could not be read: ${String(e?.message || e)}` });
      round.tools.push({ name, ok: false });
      continue;
    }
    round.tools.push({ name, ok: res.ok });
    if (res.ok) { next.bestClean = res.plan; next.bestCleanSummary = res.summary; next.bestCleanRound = n; round.cleanPlanJson = JSON.stringify({ plan: res.plan, summary: res.summary }); }
    if (name === 'submit_plan' && res.ok) {
      submitted = res;
      reply.push({ type: 'tool_result', tool_use_id: u.id, content: 'Accepted. The plan is recorded.' });
    } else if (name === 'submit_plan') {
      reply.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: JSON.stringify({ rejected: 'the plan breaks a hard rule and was not recorded; fix it and submit again', ...res.summary }) });
    } else {
      reply.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(res.summary) });
    }
  }

  if (submitted) {
    next.final = submitted.plan;
    next.finalSummary = submitted.summary;
    next.ended = 'submitted';
    next.endNote = null;
    round.finalPlanJson = JSON.stringify({ plan: submitted.plan, summary: submitted.summary });
    round.endedWith = 'submitted';
    round.replyJson = JSON.stringify(reply);
    next.rounds.push(round);
    return next;
  }
  if (!uses.length) reply.push({ type: 'text', text: round.stopReason === 'max_tokens' ? NUDGE_MAX_TOKENS : NUDGE_NO_TOOL });
  round.replyJson = JSON.stringify(reply);
  if (unpriced) {
    next.ended = 'budget';
    next.endNote = `served by ${servedModel || s.model}, which has no price row: spend can no longer be counted against the cap, so the run stops here`;
    round.endedWith = next.ended; round.endNote = next.endNote;
  }
  next.rounds.push(round);
  return next;
}

export interface LoopDeps {
  call: (request: Record<string, any>) => Promise<CallResult>;
  checkpoint: (state: LoopState) => Promise<void>;
  now: () => number;
  iso: () => string;
  // Claim round n BEFORE paying for it: false means another worker holds it, and this invocation
  // stops without touching the run. Two overlapping ticks can never both spend on one round.
  claim?: (n: number) => Promise<boolean>;
}

/**
 * Run rounds until the plan is submitted, a cap is hit, or this invocation's time budget runs out
 * (then the state is checkpointed and the next worker tick continues it). A round is only STARTED
 * while there is time to finish it: `startBeforeMs` is measured from the start of this call.
 */
export async function runRounds(problem: Problem, state: LoopState, s: LoopSettings, deps: LoopDeps, startBeforeMs: number): Promise<LoopState> {
  const t0 = deps.now();
  let st = state;
  for (;;) {
    const gate = mayStartRound(st, s, problem);
    if (!gate.ok) {
      if (!st.ended) { st = { ...st, ended: gate.reason, endNote: gate.note }; await deps.checkpoint(st); }
      return st;
    }
    if (deps.now() - t0 >= startBeforeMs) return st;   // out of time for THIS invocation, not the run
    if (deps.claim && !(await deps.claim(st.rounds.length + 1))) return st;
    const call = await deps.call(buildRequest(problem, st, s));
    st = applyResponse(problem, st, s, call, deps.iso());
    await deps.checkpoint(st);
    if (st.ended) return st;
  }
}
