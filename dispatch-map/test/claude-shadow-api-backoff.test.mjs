// test/claude-shadow-api-backoff.test.mjs — A RATE LIMIT OR AN OVERLOAD IS WAITED OUT, NOT HAMMERED.
//
// A 429 (rate limit) or a 5xx/529 (overload) from the Messages API is not permanent, so the run goes
// on — but it went on at once, with no delay, into the same wall: all 8 rounds used up in under a
// second, each 5xx charged its high-side estimate against the job and the shared 24-hour ceiling, and
// the job failed "no plan without a hard-rule violation: stopped at the round cap (8)" when the model
// had never answered at all (audit 2026-09-27, shadow-backend-2). Now a failed call ends that worker
// tick (the next one, 3 minutes later, carries on) and a run the model never answered says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, runRounds, noPlanReason } from '../netlify/functions/lib/claude-shadow/plan-loop.mts';
import { enqueueBacktests, workerTick } from '../netlify/functions/lib/claude-shadow/backtest.mts';

// ── the loop ────────────────────────────────────────────────────────────────
const SETTINGS = { model: 'claude-opus-5-5', effort: 'high', maxTokens: 32000, maxRounds: 8, maxUsd: 5 };
const problem = () => ({
  system: 'You plan loads.', briefing: 'Loads: A. Stops: 1.',
  tools: [{ name: 'evaluate_plan', description: 'check', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
  evaluate: () => ({ ok: true, summary: {}, plan: { loads: [{ load: 'A', stops: [1] }] } }),
});
const failed = (httpStatus, error) => ({ ok: false, httpStatus, timedOut: false, ms: 40, error, body: null });
const RATE = failed(429, 'Number of request tokens has exceeded your per-minute rate limit');
const OVERLOADED = failed(529, 'Overloaded');
const usage = { input_tokens: 1000, output_tokens: 500 };
const SUBMIT = { ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit_plan', input: {} }], usage } };
const loopDeps = (script) => {
  const sent = [];
  let i = 0;
  return { sent, deps: { call: async () => { sent.push(1); return script[i++] ?? script[script.length - 1]; }, checkpoint: async () => {}, now: () => 0, iso: () => 'x' } };
};

test('a 429 ends this worker tick after ONE call — the run is not over, and the next tick carries on from the same history', async () => {
  const { sent, deps } = loopDeps([RATE, SUBMIT]);
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  assert.equal(sent.length, 1, 'no second call into the same rate limit');
  assert.equal(st.ended, null, 'only this tick is over');
  assert.equal(st.rounds.length, 1);
  const next = await runRounds(problem(), st, SETTINGS, deps, 60_000);
  assert.equal(next.ended, 'submitted');
  assert.equal(sent.length, 2);
});

test('an overloaded API (529) costs ONE high-side estimate per tick, not a burst of them within a second', async () => {
  const { sent, deps } = loopDeps([OVERLOADED]);
  const st = await runRounds(problem(), emptyState(), SETTINGS, deps, 60_000);
  assert.equal(sent.length, 1);
  assert.equal(st.ended, null);
  assert.ok(st.usd > 0 && st.usd === st.rounds[0].usd, `one estimate charged: ${st.usd}`);
});

test('a run the model never answered says so — it is not blamed on hard-rule violations; a run that did answer keeps the old words', () => {
  const never = { ...emptyState(), ended: 'max-rounds', endNote: 'stopped at the round cap (8)', rounds: [1, 2].map((n) => ({ n, ok: false, httpStatus: 429, error: 'rate limited' })) };
  const msg = noPlanReason(never);
  assert.match(msg, /^no plan: the model never answered — 2 calls failed at the API \(last: HTTP 429/);
  assert.match(msg, /stopped at the round cap \(8\)$/);
  assert.doesNotMatch(msg, /hard-rule/);
  const tried = { ...emptyState(), ended: 'max-rounds', endNote: 'stopped at the round cap (8)', rounds: [{ n: 1, ok: true }, { n: 2, ok: false, httpStatus: null, error: 'timed out' }] };
  assert.equal(noPlanReason(tried), 'no plan without a hard-rule violation: stopped at the round cap (8) (1 of 2 rounds failed at the API)');
  const clean = { ...emptyState(), ended: 'max-rounds', endNote: 'stopped at the round cap (8)', rounds: [{ n: 1, ok: true }] };
  assert.equal(noPlanReason(clean), 'no plan without a hard-rule violation: stopped at the round cap (8)');
});

// ── the worker ──────────────────────────────────────────────────────────────
const D = '2026-09-23';
function store(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const children = (coll) => [...docs.entries()]
    .filter(([p]) => p.startsWith(coll + '/') && p.slice(coll.length + 1).split('/').length === 1)
    .map(([p, d]) => ({ ...d, _id: p.slice(coll.length + 1) }));
  return {
    docs,
    getDoc: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
    listDocs: async (coll, opts) => children(coll).map((d) => {
      const c = structuredClone(d);
      if (!opts?.mask) return c;
      return Object.fromEntries(Object.entries(c).filter(([k]) => k === '_id' || opts.mask.includes(k)));
    }),
    shadowSet: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), p); docs.set(p, structuredClone(d)); return true; },
    shadowPatch: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), p); docs.set(p, { ...(docs.get(p) || {}), ...structuredClone(d) }); return true; },
    shadowCreate: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), p); if (docs.has(p)) return false; docs.set(p, structuredClone(d)); return true; },
  };
}
let n = 0;
const row = (route, driver, lat, lng) => ({
  stopNbr: `S${++n}`, stopType: 'DO', status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, routeName: route, loadNbr: route,
  driverName: driver, driverUserName: driver, cartons: 2, volume: 0, weight: 500, routeSeq: n, deliveredDTTM: `${D}T1${n % 10}:00:00`,
  zip: '30501', city: 'X', customerMatchKey: `C${n}`, businessName: `C${n}`, lat, lng,
});
function seedDay() {
  n = 0;
  const s = { [`history_days/davis__${D}`]: { complete: true, verified: true, captured_at: '2026-09-24T06:00:00Z' } };
  for (const r of [row('A', 'Ann', 34.2, -83.9), row('A', 'Ann', 34.0, -84.1), row('B', 'Bob', 34.21, -83.91), row('B', 'Bob', 34.01, -84.11)]) s[`history_days/davis__${D}/stops/${r.stopNbr}`] = r;
  return s;
}
function worker(script) {
  const st = store(seedDay());
  let t = Date.parse('2026-09-25T12:00:00Z');
  const calls = [];
  const d = { ...st, now: () => new Date(t += 10), env: { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' }, firestoreOn: () => true,
    call: async () => { calls.push(t); return script[calls.length - 1] ?? script[script.length - 1]; } };
  const job = () => [...st.docs.entries()].find(([p]) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p))[1];
  return { st, d, calls, job, nextTick: () => { t += 3 * 60 * 1000; } };
}
const PLAN = { loads: [{ load: 'L1', stops: [1, 2], why: 'a' }, { load: 'L2', stops: [3, 4], why: 'b' }], unplanned: [], summary: 's' };
const SUBMIT_PLAN = { ...SUBMIT, body: { ...SUBMIT.body, content: [{ type: 'tool_use', id: 't', name: 'submit_plan', input: PLAN }] } };

test('a backtest queued while the account is rate-limited is not burned in a second: one call per tick, and the job waits running', async () => {
  const w = worker([RATE]);
  await enqueueBacktests([D], 'disp', w.d);
  const out = await workerTick(w.d);
  assert.equal(w.calls.length, 1, 'one call into the rate limit, not eight');
  assert.equal(out.continuing, true, JSON.stringify(out));
  assert.equal(w.job().status, 'running');
  assert.equal(w.job().rounds, 1);
});

test('when the rate limit has cleared by the next tick, the day is planned and scored', async () => {
  const w = worker([RATE, SUBMIT_PLAN]);
  await enqueueBacktests([D], 'disp', w.d);
  await workerTick(w.d);
  w.nextTick();
  const out = await workerTick(w.d);
  assert.equal(out.done, true, JSON.stringify(out));
  assert.equal(w.calls.length, 2);
  assert.equal(w.job().status, 'done');
});

test('a rate limit that never clears ends the run at its round cap — one call a tick — and the job says the model never answered', async () => {
  const w = worker([RATE]);
  await enqueueBacktests([D], 'disp', w.d);
  for (let i = 0; i < 12 && w.job().status !== 'failed'; i++) { await workerTick(w.d); w.nextTick(); }
  const job = w.job();
  assert.equal(job.status, 'failed');
  assert.equal(w.calls.length, 8, 'the round cap (8), one per tick');
  assert.match(job.error, /^no plan: the model never answered — 8 calls failed at the API \(last: HTTP 429/);
  assert.doesNotMatch(job.error, /hard-rule/);
});
