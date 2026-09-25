// test/claude-shadow-plan-loop.test.mjs — THE CLAUDE ROUTER'S CONVERSATION, AGAINST A SCRIPTED MODEL.
//
// Every test runs the real loop against a fake Messages API that answers from a script, so the
// rules are pinned without spending a cent: a plan that breaks a hard rule is never recorded as
// final, a round the budget cannot cover is never started, a model that talks instead of calling a
// tool is nudged, thinking blocks go back exactly as they came, and a run cut off mid-night picks
// up where it stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, buildRequest, messagesFor, mayStartRound, applyResponse, runRounds,
  NUDGE_NO_TOOL, NUDGE_MAX_TOKENS,
} from '../netlify/functions/lib/claude-shadow/plan-loop.mts';

const SETTINGS = { model: 'claude-opus-5-5', effort: 'high', maxTokens: 32000, maxRounds: 6, maxUsd: 5 };

// A toy problem: two loads, three stops; load A holds 2 stops, B holds 1. The evaluator refuses
// any plan that puts 3 stops on one load ("over cap") or misses a stop.
const problem = () => ({
  system: 'You plan loads.',
  briefing: 'Loads: A (cap 2), B (cap 1). Stops: 1, 2, 3.',
  tools: [
    { name: 'evaluate_plan', description: 'check', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    { name: 'submit_plan', description: 'submit', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  ],
  evaluate: (input) => {
    const loads = input?.loads || [];
    const seen = loads.flatMap((l) => l.stops);
    const over = loads.filter((l) => l.stops.length > (l.load === 'A' ? 2 : 1)).map((l) => l.load);
    const missing = [1, 2, 3].filter((s) => !seen.includes(s));
    const ok = !over.length && !missing.length;
    return { ok, summary: { over, missing }, plan: { loads } };
  },
});

const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// $ for that usage at $4/$20 per MTok: 1000*4/1e6 + 500*20/1e6 = 0.004 + 0.01 = 0.014
const ROUND_USD = 0.014;
const THINK = { type: 'thinking', thinking: '', signature: 'sig-abc==' };
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (content, stop = 'tool_use', extra = {}) => ({ ok: true, httpStatus: 200, timedOut: false, ms: 1000, error: null, body: { model: 'claude-opus-5-5', stop_reason: stop, content, usage, ...extra } });

const GOOD = { loads: [{ load: 'A', stops: [1, 2] }, { load: 'B', stops: [3] }] };
const OVER = { loads: [{ load: 'A', stops: [1, 2, 3] }, { load: 'B', stops: [] }] };

function scripted(responses) {
  const sent = [];
  let i = 0;
  return {
    sent,
    deps: {
      call: async (req) => { sent.push(JSON.parse(JSON.stringify(req))); return responses[i++] ?? responses[responses.length - 1]; },
      checkpoint: async () => {},
      now: () => 0,
      iso: () => '2026-09-25T02:00:00.000Z',
    },
  };
}

test('the request sets effort explicitly, uses auto tool choice with strict tools, and caches the system prompt and the briefing', () => {
  const req = buildRequest(problem(), emptyState(), SETTINGS);
  assert.deepEqual(req.output_config, { effort: 'high' });
  assert.deepEqual(req.tool_choice, { type: 'auto' }, 'forced tool use is a 400 on this model');
  assert.ok(req.tools.every((t) => t.strict === true));
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(req.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(req.cache_control, { type: 'ephemeral' });
  assert.equal(req.thinking, undefined, 'thinking cannot be disabled on this model; the loop never sends a thinking config that could 400');
});

test('an over-cap plan is shown back to the model and a clean submit ends the run with that plan as final', async () => {
  const { sent, deps } = scripted([
    reply([THINK, toolUse('t1', 'evaluate_plan', OVER)]),
    reply([THINK, toolUse('t2', 'evaluate_plan', GOOD)]),
    reply([THINK, toolUse('t3', 'submit_plan', GOOD)]),
  ]);
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  assert.equal(st.ended, 'submitted');
  assert.deepEqual(st.final, { loads: GOOD.loads });
  assert.equal(st.rounds.length, 3);
  // Round 1's tool result carried the violation back to the model.
  const r1 = JSON.parse(st.rounds[0].replyJson);
  assert.equal(r1[0].type, 'tool_result');
  assert.deepEqual(JSON.parse(r1[0].content).over, ['A']);
  assert.equal(sent.length, 3);
  assert.equal(Math.round(st.usd * 1000), Math.round(3 * ROUND_USD * 1000));
});

test('a submitted plan that breaks a hard rule is NEVER recorded as final — it goes back as an error and the run continues', async () => {
  const { deps } = scripted([
    reply([THINK, toolUse('t1', 'submit_plan', OVER)]),
    reply([THINK, toolUse('t2', 'submit_plan', GOOD)]),
  ]);
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  const r1 = JSON.parse(st.rounds[0].replyJson);
  assert.equal(r1[0].is_error, true);
  assert.match(r1[0].content, /not recorded/);
  assert.equal(st.ended, 'submitted');
  assert.deepEqual(st.final.loads, GOOD.loads);
});

test('thinking blocks are replayed exactly as they came back, and the history is only appended to', async () => {
  const { sent, deps } = scripted([
    reply([THINK, toolUse('t1', 'evaluate_plan', OVER)]),
    reply([THINK, toolUse('t2', 'submit_plan', GOOD)]),
  ]);
  await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  const second = sent[1].messages;
  assert.equal(second.length, 3, 'briefing, round 1 assistant, round 1 tool results');
  assert.deepEqual(second[1], { role: 'assistant', content: [THINK, toolUse('t1', 'evaluate_plan', OVER)] });
  // The first request's messages are a prefix of the second's.
  assert.deepEqual(second.slice(0, sent[0].messages.length), sent[0].messages);
});

test('a model that answers in text instead of calling a tool is nudged, and a max_tokens stop gets its own nudge', async () => {
  const { deps } = scripted([
    reply([THINK, { type: 'text', text: 'I think load A...' }], 'end_turn'),
    reply([THINK], 'max_tokens'),
    reply([THINK, toolUse('t3', 'submit_plan', GOOD)]),
  ]);
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  assert.deepEqual(JSON.parse(st.rounds[0].replyJson), [{ type: 'text', text: NUDGE_NO_TOOL }]);
  assert.deepEqual(JSON.parse(st.rounds[1].replyJson), [{ type: 'text', text: NUDGE_MAX_TOKENS }]);
  assert.equal(st.ended, 'submitted');
});

test('the run stops at the round cap and keeps the best CLEAN evaluated plan (never an over-cap one) as a fallback', async () => {
  const { deps } = scripted([
    reply([THINK, toolUse('t1', 'evaluate_plan', GOOD)]),
    reply([THINK, toolUse('t2', 'evaluate_plan', OVER)]),
  ]);
  const st = await runRounds(problem(), emptyState(), { ...SETTINGS, maxRounds: 2 }, deps, 60_000);
  assert.equal(st.ended, 'max-rounds');
  assert.equal(st.final, null, 'nothing was submitted');
  assert.deepEqual(st.bestClean, { loads: GOOD.loads });
  assert.equal(st.bestCleanRound, 1);
});

test('a round the budget cannot cover at the last round\'s price is never started', () => {
  const st = { ...emptyState(), usd: 4.99, rounds: [{ n: 1, usd: 0.5, assistantJson: '[]', ok: true }] };
  const g = mayStartRound(st, SETTINGS);
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'max-usd');
  assert.match(g.note, /the cap is \$5\.00/);
});

test('an invocation out of time stops WITHOUT ending the run, so the next worker tick continues from the checkpoint', async () => {
  let t = 0;
  const { deps } = scripted([reply([THINK, toolUse('t1', 'evaluate_plan', OVER)])]);
  deps.now = () => t;
  deps.call = async (req) => { t += 5000; return reply([THINK, toolUse('t1', 'evaluate_plan', OVER)]); };
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 4000);
  assert.equal(st.rounds.length, 1, 'one round, then out of time');
  assert.equal(st.ended, null, 'the run is not over — only this invocation is');
  // Resuming from the checkpoint replays round 1 and asks for round 2.
  const req = buildRequest(problem(), st, SETTINGS);
  assert.equal(req.messages.length, 3);
});

test('a 400 ends the run with the reason; a timeout is recorded and retried from the same history', () => {
  const bad = { ok: false, httpStatus: 400, timedOut: false, ms: 10, error: 'tool_choice any not supported', body: null };
  const a = applyResponse(problem(), emptyState(), SETTINGS, bad, 'x');
  assert.equal(a.ended, 'api-error');
  assert.match(a.endNote, /HTTP 400/);
  const to = { ok: false, httpStatus: null, timedOut: true, ms: 600000, error: 'timed out', body: null };
  const b = applyResponse(problem(), emptyState(), SETTINGS, to, 'x');
  assert.equal(b.ended, null);
  assert.equal(b.rounds.length, 1);
  assert.equal(messagesFor(problem(), b).length, 1, 'a failed call adds nothing to the conversation');
});

test('a refusal ends the run and says why', () => {
  const r = { ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { category: null, explanation: 'no' }, content: [], usage } };
  const st = applyResponse(problem(), emptyState(), SETTINGS, r, 'x');
  assert.equal(st.ended, 'refused');
});

test('an unknown tool or an unreadable plan is answered as an error, never crashes the run', () => {
  const pr = problem();
  pr.evaluate = () => { throw new Error('stop 99 does not exist'); };
  const r = reply([toolUse('t1', 'evaluate_plan', { loads: [] }), toolUse('t2', 'guess_plan', {})]);
  const st = applyResponse(pr, emptyState(), SETTINGS, r, 'x');
  const rep = JSON.parse(st.rounds[0].replyJson);
  assert.equal(rep.length, 2, 'every tool_use gets its tool_result, in ONE user message');
  assert.ok(rep.every((b) => b.is_error === true));
  assert.match(rep[0].content, /stop 99/);
});

test('a round another worker has claimed is never paid for twice: this invocation stops, the run is untouched', async () => {
  const { sent, deps } = scripted([reply([THINK, toolUse('t1', 'evaluate_plan', GOOD)])]);
  deps.claim = async (n) => n !== 1;
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  assert.equal(sent.length, 0, 'no call made');
  assert.equal(st.rounds.length, 0);
  assert.equal(st.ended, null);
});

test('a call that timed out after it was sent is charged a HIGH-side estimate, never $0; a 429 was refused before any work and costs nothing', () => {
  const to = { ok: false, httpStatus: null, timedOut: true, ms: 600000, error: 'timed out', body: null };
  const st = applyResponse(problem(), emptyState(), SETTINGS, to, 'x');
  const r = st.rounds[0];
  // At least every output token it was allowed: 32000 × $20/MTok = $0.64.
  assert.ok(r.usd >= 0.64, `charged ${r.usd}`);
  assert.equal(st.usd, r.usd, 'the estimate counts toward the cap');
  assert.match(r.costBasis, /ESTIMATE, high side/);
  const e5 = applyResponse(problem(), emptyState(), SETTINGS, { ok: false, httpStatus: 529, timedOut: false, ms: 10, error: 'overloaded', body: null }, 'x');
  assert.ok(e5.usd > 0, 'a 5xx may have run; it is charged too');
  const rl = applyResponse(problem(), emptyState(), SETTINGS, { ok: false, httpStatus: 429, timedOut: false, ms: 10, error: 'rate limited', body: null }, 'x');
  assert.equal(rl.usd, 0);
  assert.equal(rl.rounds[0].usd, null);
  // The next round is then refused by the cap once the estimates add up.
  const three = [1, 2, 3].reduce((s) => applyResponse(problem(), s, { ...SETTINGS, maxUsd: 2 }, to, 'x'), emptyState());
  assert.equal(mayStartRound(three, { ...SETTINGS, maxUsd: 2 }).ok, false);
});
