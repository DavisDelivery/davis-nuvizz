// test/claude-shadow-backtest-jobs.test.mjs — THE BACKTEST QUEUE AND WORKER, AGAINST A FAKE STORE AND A SCRIPTED MODEL.
//
// What a dispatcher relies on when pressing Backtest: nothing runs (or spends) where it must not —
// switch off, no key, the UAT mirror; a day is queued once; a stopped job stops before its next
// paid round; a run that outlives one worker tick picks up where it left off without paying for a
// round twice; and a finished run leaves one comparison per day, on one yardstick.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueBacktests, workerTick, cancelJob, backtestView, backtestResult, saveRouterSettings,
  routerSettingsFrom, validateRouterChange, routerRefusal, ROUTER_DEFAULTS, ROUTER_SETTINGS_PATH, jobPath, resultPath,
} from '../netlify/functions/lib/claude-shadow/backtest.mts';

const D = '2026-09-23';
const ENV = { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' };

function store(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const children = (coll) => [...docs.entries()]
    .filter(([p]) => p.startsWith(coll + '/') && p.slice(coll.length + 1).split('/').length === 1)
    .map(([p, d]) => ({ ...d, _id: p.slice(coll.length + 1) }));
  const writes = [];
  return {
    docs, writes,
    getDoc: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
    listDocs: async (coll) => children(coll).map((d) => structuredClone(d)),
    shadowSet: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), `write outside the shadow: ${p}`); writes.push(p); docs.set(p, structuredClone(d)); return true; },
    shadowPatch: async (p, d) => { assert.ok(p.startsWith('claude_shadow_')); writes.push(p); docs.set(p, { ...(docs.get(p) || {}), ...structuredClone(d) }); return true; },
    shadowCreate: async (p, d) => { assert.ok(p.startsWith('claude_shadow_')); if (docs.has(p)) return false; writes.push(p); docs.set(p, structuredClone(d)); return true; },
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
  const s = {
    [`history_days/davis__${D}`]: { complete: true, verified: true, captured_at: '2026-09-24T06:00:00Z' },
    'history_days/davis__2026-09-22': { complete: false, verified: true, captured_at: 'x' },
  };
  const rows = [row('A', 'Ann', 34.2, -83.9), row('A', 'Ann', 34.0, -84.1), row('B', 'Bob', 34.21, -83.91), row('B', 'Bob', 34.01, -84.11)];
  for (const r of rows) s[`history_days/davis__${D}/stops/${r.stopNbr}`] = r;
  return s;
}

const usage = { input_tokens: 2000, output_tokens: 1000 };
const reply = (content) => ({ ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content, usage } });
const PLAN = { loads: [{ load: 'L1', stops: [1, 3] }, { load: 'L2', stops: [2, 4] }], unplanned: [] };
function model(script) {
  const calls = [];
  let i = 0;
  return { calls, call: async (req) => { calls.push(req); return script[i++] ?? script[script.length - 1]; } };
}
const clock = (startMs = Date.parse('2026-09-25T12:00:00Z')) => { let t = startMs; return { now: () => new Date(t), tick: (ms) => { t += ms; } }; };

function deps(st, m, c, env = ENV) {
  return { ...st, call: m.call, now: c.now, env, firestoreOn: () => true };
}

test('the router refuses — and spends nothing — with the switch off, with no key, or on a site reading a mirror database', async () => {
  assert.match(routerRefusal({ CLAUDE_SHADOW: 'off', ANTHROPIC_API_KEY: 'k' }, true), /CLAUDE_SHADOW is off/);
  assert.match(routerRefusal({}, true), /ANTHROPIC_API_KEY is not set/);
  assert.match(routerRefusal({ ANTHROPIC_API_KEY: 'k' }, false), /Firestore is not usable/);
  assert.match(routerRefusal({ ANTHROPIC_API_KEY: 'k', FIRESTORE_DATABASE: 'uat-mirror' }, true), /uat-mirror database/, 'UAT copies production\u2019s key; it must not spend it');
  assert.equal(routerRefusal({ ANTHROPIC_API_KEY: 'k' }, true), null);
  const st = store(seedDay());
  const m = model([reply([])]);
  const out = await workerTick(deps(st, m, clock(), { CLAUDE_SHADOW: 'off', ANTHROPIC_API_KEY: 'k' }));
  assert.equal(out.idle, true);
  assert.equal(m.calls.length, 0);
});

test('only sealed days are queued, a day already queued is not queued twice, and the ceiling is stated', async () => {
  const st = store(seedDay());
  const d = deps(st, model([]), clock());
  const bad = await enqueueBacktests(['2026-09-22'], 'disp', d);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not sealed/);
  const ok = await enqueueBacktests([D], 'disp', d);
  assert.deepEqual(ok.body.queued, [D]);
  assert.equal(ok.body.maxUsdTotal, ROUTER_DEFAULTS.maxUsd);
  const again = await enqueueBacktests([D], 'disp', d);
  assert.deepEqual(again.body.queued, []);
  assert.deepEqual(again.body.skipped, [D]);
  assert.equal((await enqueueBacktests(Array.from({ length: 32 }, (_, i) => `2026-08-${String(i).padStart(2, '0')}`), 'x', d)).status, 400);
});

test('a queued day runs to a scored comparison: the plan is checked, submitted, and stored once per day with every column', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([
    reply([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
    reply([{ type: 'tool_use', id: 't2', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'area' })), summary: 'ok' } }]),
  ]);
  const d = deps(st, m, c);
  await enqueueBacktests([D], 'disp', d);
  const out = await workerTick(d);
  assert.equal(out.done, true, JSON.stringify(out));
  assert.equal(m.calls.length, 2);
  const job = [...st.docs.entries()].find(([p]) => p.startsWith('claude_shadow_jobs/') && p.split('/').length === 2)[1];
  assert.equal(job.status, 'done');
  assert.equal(job.submitted, true);
  const res = st.docs.get(resultPath(D));
  assert.ok(res.columns.driven && res.columns.reseq && res.columns.claude);
  assert.equal(res.columns.claude.trucks, 2);
  assert.ok(res.columns.claude.miles < res.columns.driven.miles, 'dispatch crossed the two areas; the plan straightened them');
  assert.equal(res.costs.claude, null, 'no rate entered → no dollars');
  assert.equal(res.nuvizzCalls, 0);
  assert.ok(st.writes.every((p) => p.startsWith('claude_shadow_')));
  // One read path for the screen.
  const r = await backtestResult(D, d);
  assert.equal(r.status, 200);
  const v = await backtestView(d);
  assert.equal(v.days.find((x) => x.date === D).result.date, D);
});

test('a run that outlives one worker tick resumes on the next, from the same stored day, without paying for a round twice', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([
    reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
    reply([{ type: 'tool_use', id: 't2', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'w' })), summary: 's' } }]),
  ]);
  // Each call takes five minutes: the first tick fits one round, then is out of time to START another.
  const slow = async (req) => { c.tick(5 * 60 * 1000); return m.call(req); };
  const d = { ...deps(st, m, c), call: slow };
  await enqueueBacktests([D], 'disp', d);
  const first = await workerTick(d);
  assert.equal(first.continuing, true);
  assert.equal(m.calls.length, 1);
  const problemDoc = [...st.docs.entries()].find(([p]) => p.endsWith('/data/problem'))[1];
  const second = await workerTick(d);
  assert.equal(second.done, true, JSON.stringify(second));
  assert.equal(m.calls.length, 2, 'round 1 was not paid for again');
  // The second tick replayed round 1 and showed Claude the same stored briefing.
  assert.equal(m.calls[1].messages[0].content[0].text, m.calls[0].messages[0].content[0].text);
  assert.equal(m.calls[1].messages.length, 3);
  assert.equal([...st.docs.entries()].find(([p]) => p.endsWith('/data/problem'))[1].problemJson, problemDoc.problemJson);
});

test('a stopped job stops before its next paid round', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }])]);
  const d = deps(st, m, c);
  const q = await enqueueBacktests([D], 'disp', d);
  const id = [...st.docs.keys()].find((p) => p.startsWith('claude_shadow_jobs/bt__'));
  const jobId = id.split('/')[1];
  assert.equal((await cancelJob(jobId, 'disp', d)).status, 200);
  const out = await workerTick(d);
  assert.equal(out.idle, true, 'a cancelled job is not picked up');
  assert.equal(m.calls.length, 0);
  assert.equal((await cancelJob(jobId, 'disp', d)).status, 409);
  void q;
});

test('router settings: a cost rate has no default, a bad value refuses the whole change, and blanks put a rate back to none', async () => {
  assert.equal(routerSettingsFrom(null).costPerMile, null);
  assert.equal(routerSettingsFrom(null).capRule, 'tighter');
  assert.equal(routerSettingsFrom({ maxUsd: 'lots', effort: 'turbo' }).maxUsd, ROUTER_DEFAULTS.maxUsd, 'malformed keeps the default');
  const bad = validateRouterChange({ costPerMile: '-1', maxRounds: 3 });
  assert.equal(bad.ok, false);
  const good = validateRouterChange({ costPerMile: '2.10', costPerDriveHour: null, capRule: 'route' });
  assert.deepEqual(good.fields, { costPerMile: 2.1, costPerDriveHour: null, capRule: 'route' });
  const st = store();
  const d = deps(st, model([]), clock());
  const saved = await saveRouterSettings({ costPerMile: 2.1 }, 'disp', d);
  assert.equal(saved.body.settings.costPerMile, 2.1);
  assert.equal(st.docs.get(ROUTER_SETTINGS_PATH).updatedBy, 'disp');
  void jobPath;
});

test('Stop pressed while the last round is at the model: that round is paid for, but no result is published and the job stays stopped', async () => {
  const st = store(seedDay());
  const c = clock();
  const d = deps(st, model([]), c);
  await enqueueBacktests([D], 'disp', d);
  const jobId = [...st.docs.keys()].find((p) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p)).split('/')[1];
  const submit = reply([{ type: 'tool_use', id: 't1', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'w' })), summary: 's' } }]);
  let calls = 0;
  const out = await workerTick({ ...d, call: async () => { calls++; await cancelJob(jobId, 'disp', d); return submit; } });
  assert.equal(calls, 1);
  assert.equal(out.cancelled, true, JSON.stringify(out));
  assert.equal(st.docs.get(jobPath(jobId)).status, 'cancelled', 'a finished round does not flip a stopped job back to done');
  assert.equal(st.docs.has(resultPath(D)), false, 'nothing is published for a stopped day');
  assert.ok(st.docs.get(jobPath(jobId)).usd > 0, 'what the round cost is still on the job');
});

test('a deploy between ticks cannot change what a resumed run replays: the prompt is frozen with the job', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([
    reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
    reply([{ type: 'tool_use', id: 't2', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'w' })), summary: 's' } }]),
  ]);
  const slow = async (req) => { c.tick(5 * 60 * 1000); return m.call(req); };
  const d = { ...deps(st, m, c), call: slow };
  await enqueueBacktests([D], 'disp', d);
  await workerTick(d);
  // Stand in for "the build that started this job had different prompt text": rewrite what was frozen.
  const [path, doc] = [...st.docs.entries()].find(([p]) => p.endsWith('/data/problem'));
  const frozen = JSON.parse(doc.promptJson);
  st.docs.set(path, { ...doc, promptJson: JSON.stringify({ ...frozen, system: 'OLD BUILD SYSTEM TEXT', briefing: 'OLD BUILD BRIEFING' }) });
  await workerTick(d);
  assert.equal(m.calls.length, 2);
  assert.equal(m.calls[1].system[0].text, 'OLD BUILD SYSTEM TEXT', 'the resumed round is sent the text the run started with');
  assert.equal(m.calls[1].messages[0].content[0].text, 'OLD BUILD BRIEFING');
});
