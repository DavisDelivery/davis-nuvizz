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
import { restoreState } from '../netlify/functions/lib/claude-shadow/plan-loop.mts';

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
    // Honours a field mask the way Firestore does: a listed doc carries ONLY the masked fields. A
    // fake that returned whole docs hid a resume that read the plan off a masked listing.
    listDocs: async (coll, opts) => children(coll).map((d) => {
      const c = structuredClone(d);
      if (!opts?.mask) return c;
      return Object.fromEntries(Object.entries(c).filter(([k]) => k === '_id' || opts.mask.includes(k)));
    }),
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
// Stop ids are numbered by PLACE (zone, then position): the two northern stops are 1-2, the southern 3-4.
const PLAN = { loads: [{ load: 'L1', stops: [1, 2] }, { load: 'L2', stops: [3, 4] }], unplanned: [] };
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
  assert.match(routerRefusal({ ANTHROPIC_API_KEY: 'k', CLAUDE_SHADOW_MODEL: 'claude-unpriced-9' }, true), /no price row/, 'a model whose spend cannot be counted is never run');
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

test('a clean plan found in an EARLIER tick survives the resume: a run that then ends at its round cap is scored from it, not failed', async () => {
  const st = store({ ...seedDay(), [ROUTER_SETTINGS_PATH]: { maxRounds: 2 } });
  const c = clock();
  const OVER = { loads: [{ load: 'L1', stops: [1, 2, 3, 4] }, { load: 'L2', stops: [] }], unplanned: [] };
  const m = model([
    reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
    reply([{ type: 'tool_use', id: 't2', name: 'evaluate_plan', input: { ...OVER, loads: [{ load: 'L1', stops: [1, 2, 3] }, { load: 'L9', stops: [4] }] } }]),
  ]);
  const slow = async (req) => { c.tick(5 * 60 * 1000); return m.call(req); };
  const d = { ...deps(st, m, c), call: slow };
  await enqueueBacktests([D], 'disp', d);
  assert.equal((await workerTick(d)).continuing, true);
  const out = await workerTick(d);
  assert.equal(out.done, true, JSON.stringify(out));
  assert.equal(m.calls.length, 2);
  const res = st.docs.get(resultPath(D));
  assert.equal(res.submitted, false);
  assert.match(res.planFrom, /round 1/);
});

test('a job already holding an accepted plan is never paid for again, even when a stale tick picks it up as running', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([reply([{ type: 'tool_use', id: 't1', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'w' })), summary: 's' } }])]);
  const d = deps(st, m, c);
  await enqueueBacktests([D], 'disp', d);
  assert.equal((await workerTick(d)).done, true);
  const jp = [...st.docs.keys()].find((p) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p));
  st.docs.set(jp, { ...st.docs.get(jp), status: 'running' });     // an overlapping tick's stale view
  const again = await workerTick(d);
  assert.equal(m.calls.length, 1, 'no second paid round');
  assert.equal(again.done, true);
  assert.equal(st.docs.get(resultPath(D)).submitted, true);
});

test('the state rebuilt from stored rounds is the state the live run had', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([
    reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
    reply([{ type: 'tool_use', id: 't2', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'w' })), summary: 's' } }]),
  ]);
  const d = deps(st, m, c);
  await enqueueBacktests([D], 'disp', d);
  await workerTick(d);
  const rounds = [...st.docs.entries()].filter(([p]) => /\/rounds\/r\d+$/.test(p)).map(([, r]) => r);
  const back = restoreState(rounds);
  assert.equal(back.ended, 'submitted');
  assert.deepEqual(back.final.loads.map((l) => l.stops), PLAN.loads.map((l) => l.stops));
  assert.equal(back.bestCleanRound, 2);
  assert.equal(back.usd, st.docs.get(jp(st)).usd);
});
const jp = (st) => [...st.docs.keys()].find((p) => /^claude_shadow_jobs\/bt__[^/]+$/.test(p));

test('Stop pressed while the worker is still building the day is not undone by the "running" write — nothing is paid for', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }])]);
  const d = deps(st, m, c);
  await enqueueBacktests([D], 'disp', d);
  const id = jp(st).split('/')[1];
  let pressed = false;
  const getDoc = async (p) => {
    // The dispatcher presses Stop in the middle of the day's reads.
    if (!pressed && p.startsWith('customer_notes/')) { pressed = true; await cancelJob(id, 'disp', d); }
    return d.getDoc(p);
  };
  const out = await workerTick({ ...d, getDoc });
  assert.ok(pressed);
  assert.equal(m.calls.length, 0, JSON.stringify(out));
  assert.equal(st.docs.get(jp(st)).status, 'cancelled');
  assert.equal((await workerTick(d)).idle, true, 'and no later tick picks it up');
});

test('a tick that overlaps the owner and trips on one read leaves the job alone; the owner’s own failure still marks it failed', async () => {
  const st = store(seedDay());
  const c = clock();
  const m = model([reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }])]);
  const slow = async (req) => { c.tick(5 * 60 * 1000); return m.call(req); };
  const d = { ...deps(st, m, c), call: slow };
  await enqueueBacktests([D], 'disp', d);
  await workerTick(d);                                        // the owner: built the day, paid round 1
  assert.equal(st.docs.get(jp(st)).status, 'running');
  // An overlapping tick: its read of the rounds throws once.
  const flaky = { ...d, listDocs: async (coll, o) => { if (coll.endsWith('/rounds')) throw new Error('Firestore 503'); return d.listDocs(coll, o); } };
  const out = await workerTick(flaky);
  assert.equal(out.ok, false);
  assert.equal(st.docs.get(jp(st)).status, 'running', 'the live job is not marked failed by a tick that did nothing');
  // The owner building a day that cannot be read does fail it.
  const st2 = store(seedDay());
  const d2 = deps(st2, model([]), clock());
  await enqueueBacktests([D], 'disp', d2);
  const broken = { ...d2, getDoc: async (p) => { if (p.startsWith('nuvizz_load_roster/')) throw new Error('boom'); return d2.getDoc(p); } };
  await workerTick(broken);
  assert.equal(st2.docs.get(jp(st2)).status, 'failed');
});
