// test/claude-shadow-lost-round.test.mjs — A ROUND THAT WAS PAID FOR IS COUNTED, EVEN WHEN ITS RECORD WAS LOST.
//
// The worker pays for a round, then writes its record. When Firestore refused that write for longer than
// the store's ~15 s of retries (the 2026-09-25 throttle), the job was left running and the round's claim
// stayed on file with no record behind it. 16 minutes on, the next tick took the claim over and paid for
// the round AGAIN — and only the second payment was ever recorded. The per-run $ cap, the 24-hour ceiling
// and the Shadow tab's spend all read the recorded spend, so each lost round let real spend run past them
// unseen (audit 2026-09-27, shadow-backend-3: 2 calls billed $1.36, job.usd $0.68). Now a round claimed by
// a run that never recorded it is charged as an unread call — the high-side estimate the loop already
// charges a call whose answer was lost — before the next one is paid for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, runRounds } from '../netlify/functions/lib/claude-shadow/plan-loop.mts';
import { usageCost } from '../netlify/functions/lib/claude-shadow/anthropic.mts';
import { enqueueBacktests, workerTick, resultPath, CLAIM_STALE_MS } from '../netlify/functions/lib/claude-shadow/backtest.mts';

// A long round: nearly every output token the 32,000 cap allows, on a request the size of this test's day.
const usage = { input_tokens: 3000, output_tokens: 30000 };
const PAID = usageCost('claude-opus-5-5', usage).usd;   // what one of these rounds is billed ($0.612)

// ── the loop ────────────────────────────────────────────────────────────────
const SETTINGS = { model: 'claude-opus-5-5', effort: 'high', maxTokens: 32000, maxRounds: 8, maxUsd: 5 };
const problem = () => ({
  system: 'You plan loads.', briefing: 'Loads: A. Stops: 1.',
  tools: [{ name: 'submit_plan', description: 'submit', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
  evaluate: () => ({ ok: true, summary: {}, plan: { loads: [{ load: 'A', stops: [1] }] } }),
});
const SUBMIT = (input = {}) => ({ ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit_plan', input }], usage } });

test('a round claimed by a worker run that never recorded it is charged before the next round is paid for', async () => {
  const sent = [];
  const st = await runRounds(problem(), emptyState(), SETTINGS, {
    call: async () => { sent.push(1); return SUBMIT(); },
    claim: async (n) => (n === 1 ? 'lost' : true),
    checkpoint: async () => {}, now: () => 0, iso: () => 'x',
  }, 60_000);
  assert.equal(sent.length, 1, 'one new call — the lost one is not re-asked under its own number');
  assert.equal(st.ended, 'submitted');
  assert.equal(st.rounds.length, 2);
  const [lost, real] = st.rounds;
  assert.equal(lost.ok, false);
  assert.match(lost.error, /never recorded/);
  assert.match(lost.costBasis, /ESTIMATE, high side/);
  assert.ok(lost.usd >= 0.64, `the lost call is charged on the high side (at least every output token it was allowed): ${lost.usd}`);
  assert.equal(st.usd, Math.round((lost.usd + real.usd) * 1e6) / 1e6, 'both count toward the cap');
});

// ── the worker, with the 2026-09-25 throttle on the round's record ─────────
const D = '2026-09-23';
function store(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const children = (coll) => [...docs.entries()]
    .filter(([p]) => p.startsWith(coll + '/') && p.slice(coll.length + 1).split('/').length === 1)
    .map(([p, d]) => ({ ...d, _id: p.slice(coll.length + 1) }));
  let throttleRoundOne = true;
  return {
    docs,
    getDoc: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
    listDocs: async (coll, opts) => children(coll).map((d) => {
      const c = structuredClone(d);
      if (!opts?.mask) return c;
      return Object.fromEntries(Object.entries(c).filter(([k]) => k === '_id' || opts.mask.includes(k)));
    }),
    // The first write of round 1's record is refused past the store's retries.
    shadowSet: async (p, d) => {
      assert.ok(p.startsWith('claude_shadow_'), p);
      if (p.endsWith('/rounds/r01') && throttleRoundOne) { throttleRoundOne = false; throw new Error(`setDoc ${p} failed: 429 RESOURCE_EXHAUSTED`); }
      docs.set(p, structuredClone(d)); return true;
    },
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
const PLAN = { loads: [{ load: 'L1', stops: [1, 2], why: 'a' }, { load: 'L2', stops: [3, 4], why: 'b' }], unplanned: [], summary: 's' };

test('a paid round whose record Firestore refused is counted when the next tick re-runs it: recorded spend is never less than what was billed', async () => {
  const st = store(seedDay());
  let t = Date.parse('2026-09-25T12:00:00Z');
  const calls = [];
  const d = { ...st, now: () => new Date(t), env: { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' }, firestoreOn: () => true, call: async () => { calls.push(t); return SUBMIT(PLAN); } };
  await enqueueBacktests([D], 'disp', d);
  const t1 = await workerTick(d);
  assert.equal(t1.transient, 1, JSON.stringify(t1));
  assert.equal(calls.length, 1, 'round 1 was paid for');
  t += CLAIM_STALE_MS + 60_000;   // the claim goes stale; the next tick takes it over
  const t2 = await workerTick(d);
  assert.equal(t2.done, true, JSON.stringify(t2));
  const billed = calls.length * PAID;
  const job = [...st.docs.entries()].find(([p]) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p))[1];
  const res = st.docs.get(resultPath(D));
  assert.ok(job.usd >= billed - 1e-9, `the job records $${job.usd} for $${billed} billed`);
  assert.equal(res.usd, job.usd, 'the result says the same');
  const r01 = [...st.docs.entries()].find(([p]) => p.endsWith('/rounds/r01'))[1];
  assert.match(r01.error, /never recorded/, 'the lost round is on file, and says what it is');
});
