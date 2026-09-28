// test/claude-shadow-settings-read-failure.test.mjs — A READ THAT FAILED IS NOT "NO SETTINGS".
//
// The Router settings hold the per-run $ cap, the round cap, the effort, the cap rule and the weight
// limits Chad chose; the learned capacity model holds every driver's cap. A throttled read of either was
// swallowed as "no document", so a Backtest or a Plan pressed in that second was queued on the DEFAULTS —
// a $5 cap where he set $1, "tighter" where he chose "driver", 10,000/30,000 lb, every driver at the
// truck-profile cap — frozen into the job and run to the end. A finished run stored its result with no
// cost rates, permanently (audit 2026-09-27, shadow-backend-4). Now a failed read refuses the queue
// (nothing written, nothing spent) and a finish whose read fails is retried by the next tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueBacktests, workerTick, ROUTER_SETTINGS_PATH, jobPath, resultPath } from '../netlify/functions/lib/claude-shadow/backtest.mts';
import { enqueuePlan } from '../netlify/functions/lib/claude-shadow/plan-jobs.mts';
import { planResultPath } from '../netlify/functions/lib/claude-shadow/plan.mts';
import { CAPACITY_PATH } from '../netlify/functions/lib/claude-shadow/learn-core.mts';

const ENV = { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' };
const CHADS = { maxUsd: 1, effort: 'low', capRule: 'driver', lbsBox: 12000, maxRounds: 3, costPerMile: 1.5 };
const THROTTLE = (p) => new Error(`getDoc ${p} failed: 429 RESOURCE_EXHAUSTED`);

function store(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const failing = new Set();
  const children = (coll) => [...docs.entries()]
    .filter(([p]) => p.startsWith(coll + '/') && p.slice(coll.length + 1).split('/').length === 1)
    .map(([p, d]) => ({ ...d, _id: p.slice(coll.length + 1) }));
  return {
    docs, failing,
    getDoc: async (p) => { if (failing.has(p)) throw THROTTLE(p); return docs.has(p) ? structuredClone(docs.get(p)) : null; },
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
const shadowDocs = (st) => [...st.docs.keys()].filter((k) => k.startsWith('claude_shadow_') && k !== ROUTER_SETTINGS_PATH);
const usage = { input_tokens: 2000, output_tokens: 1000 };
const submit = (input) => ({ ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit_plan', input }], usage } });

// ── a backtest day ───────────────────────────────────────────────────────────
const BD = '2026-09-23';
let n = 0;
const row = (route, driver, lat, lng) => ({
  stopNbr: `S${++n}`, stopType: 'DO', status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, routeName: route, loadNbr: route,
  driverName: driver, driverUserName: driver, cartons: 2, volume: 0, weight: 500, routeSeq: n, deliveredDTTM: `${BD}T1${n % 10}:00:00`,
  zip: '30501', city: 'X', customerMatchKey: `C${n}`, businessName: `C${n}`, lat, lng,
});
function backtestSeed() {
  n = 0;
  const s = { [`history_days/davis__${BD}`]: { complete: true, verified: true, captured_at: '2026-09-24T06:00:00Z' }, [ROUTER_SETTINGS_PATH]: { ...CHADS } };
  for (const r of [row('A', 'Ann', 34.2, -83.9), row('A', 'Ann', 34.0, -84.1), row('B', 'Bob', 34.21, -83.91), row('B', 'Bob', 34.01, -84.11)]) s[`history_days/davis__${BD}/stops/${r.stopNbr}`] = r;
  return s;
}
const btDeps = (st, call = async () => { throw new Error('no model in this test'); }) => ({ ...st, call, now: () => new Date('2026-09-25T12:00:00Z'), env: ENV, firestoreOn: () => true });

test('a throttled read of the Router settings refuses the backtest — nothing queued on a $5 default in place of the $1 cap Chad set — and the next press queues it on his', async () => {
  const st = store(backtestSeed());
  st.failing.add(ROUTER_SETTINGS_PATH);
  const r = await enqueueBacktests([BD], 'disp', btDeps(st));
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /Router settings could not be read/);
  assert.deepEqual(shadowDocs(st), [], 'nothing queued, nothing written');
  st.failing.clear();
  const again = await enqueueBacktests([BD], 'disp', btDeps(st));
  assert.deepEqual(again.body.queued, [BD]);
  assert.equal(again.body.maxUsdEach, 1);
  const job = [...st.docs.entries()].find(([p]) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p))[1];
  assert.equal(job.settings.maxUsd, 1);
  assert.equal(job.settings.capRule, 'driver');
  assert.equal(job.settings.lbsBox, 12000);
});

test('a finished backtest whose Router settings read fails is finished by the next tick with its cost rates — never stored without them, never paid for twice', async () => {
  const st = store(backtestSeed());
  const PLAN = { loads: [{ load: 'L1', stops: [1, 2], why: 'a' }, { load: 'L2', stops: [3, 4], why: 'b' }], unplanned: [], summary: 's' };
  const calls = [];
  const d = btDeps(st, async (req) => { calls.push(req); return submit(PLAN); });
  await enqueueBacktests([BD], 'disp', d);
  st.failing.add(ROUTER_SETTINGS_PATH);   // Firestore throttles the settings read for this whole tick
  const t1 = await workerTick(d);
  assert.equal(t1.ok, false, JSON.stringify(t1));
  assert.ok(!st.docs.has(resultPath(BD)), 'no result stored without its rates');
  const id = [...st.docs.keys()].find((p) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p)).split('/')[1];
  assert.notEqual(st.docs.get(jobPath(id)).status, 'failed', 'a throttle is not a verdict');
  st.failing.clear();
  const t2 = await workerTick(d);
  assert.equal(t2.done, true, JSON.stringify(t2));
  assert.equal(calls.length, 1, 'the accepted plan was not paid for again');
  const res = st.docs.get(resultPath(BD));
  assert.deepEqual(res.rates, { perMile: 1.5, perDriveHour: null });
  assert.equal(typeof res.costs.claude, 'number', 'the dollars are on the result');
});

// ── a plan of a board day ────────────────────────────────────────────────────
const PD = '2026-09-28';
const stop = (nbr, lat, lng) => ({ stopNbr: nbr, stopType: 'DO', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, cartons: 2, volume: 0, weight: 500, businessName: `CUST ${nbr}`, addr1: `${nbr} MAIN ST`, city: 'GAINESVILLE', zip: '30501', lat, lng });
const board = {
  readStops: async (_t, d) => (d === PD ? { meta: { last_scanned_at: '2026-09-26T19:38:56Z' }, stops: [stop('U1', 34.30, -83.80), stop('U2', 34.31, -83.81), stop('U3', 33.90, -84.20)] } : { meta: null, stops: [] }),
  readActivePool: async () => null, readActiveUnplannedSet: async () => null, readCarryoverRetired: async () => ({}),
};
const PARAMS = { date: PD, lookbackDays: 0, scope: 'unplanned', picks: [{ kind: 'truck', route: 'SPARE BOX', driver: null, cls: 'box_truck', loadNbr: null }] };
const planDeps = (st, call = async () => { throw new Error('no model in this test'); }) => ({ ...st, call, board, now: () => new Date('2026-09-26T23:00:00Z'), env: ENV, firestoreOn: () => true });

test('a throttled read of the Router settings refuses the Plan — no job, no plan lock — instead of freezing the defaults into the run', async () => {
  const st = store({ [ROUTER_SETTINGS_PATH]: { ...CHADS } });
  st.failing.add(ROUTER_SETTINGS_PATH);
  const r = await enqueuePlan(PARAMS, 'disp', planDeps(st));
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /Router settings could not be read/);
  assert.deepEqual(shadowDocs(st), [], 'nothing queued, no lock taken');
  st.failing.clear();
  const ok = await enqueuePlan(PARAMS, 'disp', planDeps(st));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.maxUsd, 1);
  assert.equal(st.docs.get(jobPath(ok.body.jobId)).settings.capRule, 'driver');
});

test('a plan is refused when the learned capacity model cannot be read, instead of planning every driver at the truck-profile cap; a model not yet on file still plans', async () => {
  const st = store();
  st.failing.add(CAPACITY_PATH);
  const r = await enqueuePlan(PARAMS, 'disp', planDeps(st));
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /learned capacity model could not be read/);
  assert.deepEqual(shadowDocs(st), [], 'nothing queued');
  st.failing.clear();
  assert.equal((await enqueuePlan(PARAMS, 'disp', planDeps(st))).status, 200, 'no document is not a failed read');
});

test('a finished plan whose Router settings read fails is finished by the next tick with its cost rates, not stored without them', async () => {
  const st = store({ [ROUTER_SETTINGS_PATH]: { ...CHADS } });
  const q = await enqueuePlan(PARAMS, 'disp', planDeps(st));
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const p = JSON.parse(st.docs.get(`${jobPath(q.body.jobId)}/data/problem`).problemJson);
  const PLAN = { loads: [{ load: p.loads[0].id, stops: p.stops.map((s) => s.id), why: 'a' }], unplanned: [], summary: 's' };
  const calls = [];
  const d = planDeps(st, async (req) => { calls.push(req); return submit(PLAN); });
  st.failing.add(ROUTER_SETTINGS_PATH);
  const t1 = await workerTick(d);
  assert.equal(t1.ok, false, JSON.stringify(t1));
  assert.ok(!st.docs.has(planResultPath(q.body.jobId)), 'no result stored without its rates');
  st.failing.clear();
  const t2 = await workerTick(d);
  assert.equal(t2.done, true, JSON.stringify(t2));
  assert.equal(calls.length, 1);
  assert.deepEqual(st.docs.get(planResultPath(q.body.jobId)).rates, { perMile: 1.5, perDriveHour: null });
});
