// test/claude-shadow-plan.test.mjs — THE PLANNING AREA (v1.76.0): a board day planned onto picked loads.
//
// Chad, 2026-09-26: "you need to let me set the parameters for tomorrows board such as the date and
// how many days it looks back for unplanned orders." What a dispatcher relies on when pressing Plan:
// the stops are the board the Map shows (the same carry-over rule over the look-back picked), a stop
// already on a picked truck stays on it and its room counts, nothing is left off a truck that has
// room for it, and the run goes through the same queue, cap and Stop as a backtest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanParams, selectPlanStops, planCapacity, MAX_PLAN_LOADS, rowMatchKey } from '../netlify/functions/lib/claude-shadow/plan-core.mts';
import { capDocPath } from '../netlify/functions/lib/claude-shadow/settings-core.mts';
import { roomFor, measurePlan } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { readPlanDay, planOptions, planResult, planMap } from '../netlify/functions/lib/claude-shadow/plan.mts';
import { enqueuePlan, planView } from '../netlify/functions/lib/claude-shadow/plan-jobs.mts';
import { workerTick, cancelJob, backtestView, jobPath, routerSettingsFrom } from '../netlify/functions/lib/claude-shadow/backtest.mts';
import { BT_SYSTEM, PLAN_SYSTEM, btBriefing, evaluateAssignment, makeSequencer } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { boardRowsAsServed } from '../netlify/functions/lib/board-rows.mts';
import { mergeCarryover } from '../netlify/functions/nuvizz-pull-today-stops.mts';
import { filterFinishedPriorDay } from '../netlify/functions/lib/nuvizz-list.mts';
import { dropCancelledStops } from '../src/lib/stop-cancelled.js';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';

const D = '2026-09-28';
const PRIOR = '2026-09-27';
const ENV = { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' };
const RS = routerSettingsFrom(null);

const stop = (nbr, lat, lng, o = {}) => ({
  stopNbr: nbr, stopType: 'DO', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true,
  cartons: 2, volume: 0, weight: 500, businessName: `CUST ${nbr}`, addr1: `${nbr} MAIN ST`, city: 'GAINESVILLE', zip: '30501', lat, lng, ...o,
});
const planned = (nbr, route, lat, lng) => stop(nbr, lat, lng, { status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, routeName: route, loadNbr: route, driverName: 'Scott Hart' });
function boardDay() {
  return [
    stop('U1', 34.30, -83.80), stop('U2', 34.31, -83.81), stop('U3', 33.90, -84.20), stop('U4', 33.91, -84.21),
    planned('K1', 'SCOTT', 34.305, -83.805),                          // on a load that will be picked → kept on it
    planned('P2', 'OTHER', 34.0, -84.0),                              // on a load that will not be picked
    stop('PU1', 34.1, -83.9, { stopType: 'PU' }),
    stop('F1', 34.1, -83.9, { status: '90', normalizedStatus: 'DELIVERED' }),
    stop('N1', null, null),
    stop('C1', 34.2, -83.9, { raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '2026-09-26T10:00:00Z', reasonCode: 'CANCELLED' } } } }),
  ];
}
const priorDay = () => [stop('U5', 34.32, -83.82, { scheduledDate: PRIOR, boardDate: PRIOR })];

function board(days = { [D]: boardDay(), [PRIOR]: priorDay() }, judges = {}) {
  return {
    readStops: async (_t, d) => ({ meta: days[d] ? { last_scanned_at: '2026-09-26T19:38:56Z', lastUnplannedScanAt: judges.lastUnplannedScanAt ?? null } : null, stops: structuredClone(days[d] || []) }),
    readActivePool: async () => judges.pool ?? null,
    readActiveUnplannedSet: async () => judges.live ?? null,
    readCarryoverRetired: async () => judges.retired ?? {},
  };
}

function store(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const children = (coll) => [...docs.entries()]
    .filter(([p]) => p.startsWith(coll + '/') && p.slice(coll.length + 1).split('/').length === 1)
    .map(([p, d]) => ({ ...d, _id: p.slice(coll.length + 1) }));
  const writes = [];
  return {
    docs, writes,
    getDoc: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
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
const clock = (startMs = Date.parse('2026-09-26T23:00:00Z')) => { let t = startMs; return { now: () => new Date(t), tick: (ms) => { t += ms; } }; };
function deps(st, extra = {}) {
  const c = clock();
  return { ...st, now: c.now, env: ENV, firestoreOn: () => true, board: board(), call: async () => { throw new Error('no model in this test'); }, ...extra };
}
const PICKS = [
  { kind: 'roster', route: 'SCOTT', driver: 'Scott Hart', cls: null, loadNbr: 'DAVIS000204626' },
  { kind: 'truck', route: 'SPARE BOX', driver: null, cls: 'box_truck', loadNbr: null },
];
const PARAMS = { date: D, lookbackDays: 1, scope: 'unplanned', picks: PICKS };

test('the request is checked whole: a real date, a whole look-back 0–14 (a blank is not 0), a known scope, and loads that say what they are', () => {
  assert.equal(validatePlanParams(PARAMS).ok, true);
  assert.equal(validatePlanParams({ ...PARAMS, lookbackDays: undefined }).ok, true);
  assert.equal(validatePlanParams({ date: D, picks: PICKS }).params.lookbackDays, 0, 'absent is the board’s own default, no look-back');
  assert.equal(validatePlanParams({ ...PARAMS, lookbackDays: '7' }).params.lookbackDays, 7);
  for (const bad of ['', ' ', 15, -1, 3.5, 'seven', null]) assert.equal(validatePlanParams({ ...PARAMS, lookbackDays: bad }).ok, false, `look-back ${JSON.stringify(bad)} must be refused`);
  assert.equal(validatePlanParams({ ...PARAMS, date: '2026-02-30' }).ok, false, 'not a real day');
  assert.equal(validatePlanParams({ ...PARAMS, scope: 'all' }).ok, false);
  assert.equal(validatePlanParams({ ...PARAMS, picks: [] }).ok, false);
  assert.equal(validatePlanParams({ ...PARAMS, picks: [{ kind: 'truck', route: 'X', cls: null }] }).ok, false, 'an unnamed truck needs its class');
  assert.equal(validatePlanParams({ ...PARAMS, picks: [{ kind: 'driver', route: 'X', driver: null }] }).ok, false, 'a driver pick is its driver');
  assert.equal(validatePlanParams({ ...PARAMS, picks: [{ kind: 'roster', route: '1 SATL', driver: null, loadNbr: 'D1' }] }).ok, true, 'a roster load with no driver yet is still a load');
  assert.equal(validatePlanParams({ ...PARAMS, picks: [PICKS[0], PICKS[0]] }).ok, false, 'one load picked twice');
  assert.equal(validatePlanParams({ ...PARAMS, picks: Array.from({ length: MAX_PLAN_LOADS + 1 }, (_, i) => ({ kind: 'truck', route: `T${i}`, cls: 'box_truck' })) }).ok, false);
  const many = validatePlanParams({ date: 'x', lookbackDays: 99, scope: 'nope', picks: [] });
  assert.equal(many.errors.length, 4, 'every reason is said, not just the first');
});

test('the plan is the board the Map shows: prior-day orders folded in by look-back, cancelled out, and every row not planned is counted by why', async () => {
  const st = store();
  const { problem, carry } = await readPlanDay(PARAMS, RS, deps(st));
  const c = problem.counts;
  assert.equal(c.cancelled, 1, 'the cancelled stop is off, as on the Map');
  assert.equal(c.carried, 1, 'U5 from the day before is folded in');
  assert.equal(carry.added, 1);
  assert.equal(c.pickups, 1);
  assert.equal(c.finished, 1);
  assert.equal(c.planned, 1, 'P2 is on a load that was not picked: it stays where it is');
  assert.equal(c.kept, 1, 'K1 is on SCOTT, which was picked: it is kept on it');
  assert.equal(c.noLocation, 1);
  assert.equal(c.toPlan, 5);
  assert.deepEqual(c.byDay, { [D]: 4, [PRIOR]: 1 });
  assert.equal(problem.stops.length, 6, 'the five to place, and the one kept (its room counts)');
  const k1 = problem.stops.find((s) => s.n === 'K1');
  assert.equal(k1.pin, 'L1', 'kept on the SCOTT load');
  assert.equal(problem.stops.find((s) => s.n === 'U5').day, PRIOR, 'a carried order says which day it is from');
  assert.equal(problem.mode, 'plan');
  // No look-back: the prior day is not read into the plan at all.
  const none = await readPlanDay({ ...PARAMS, lookbackDays: 0 }, RS, deps(st));
  assert.equal(none.problem.counts.carried, 0);
  assert.equal(none.carry, null);
  // Every open stop: nothing is kept, the stop on the unpicked load is planned too.
  const open = await readPlanDay({ ...PARAMS, scope: 'open' }, RS, deps(st));
  assert.equal(open.problem.counts.kept, 0);
  assert.equal(open.problem.stops.filter((s) => s.pin).length, 0);
  assert.equal(open.problem.counts.toPlan, 7, 'U1–U5, K1 and P2');
});

test('a day with no board on file is refused with the reason, before anything is spent', async () => {
  const st = store();
  await assert.rejects(readPlanDay({ ...PARAMS, date: '2026-10-05' }, RS, deps(st)), /no board on file for 2026-10-05/);
});

test('THE SAME RULE AS THE MAP: the planner’s board rows equal the Map feed’s, step for step, with and without a judge', async () => {
  const POOL = { at: '2026-09-26T19:38:56Z', windowStart: '2026-09-20', windowEnd: '2026-10-05', count: 4, thin: false,
    rows: ['U1', 'U2', 'U3', 'U4'].map((n) => ({ stopNbr: n, boardDate: D, scheduledDate: D, isPlanned: false, isUnplanned: true, normalizedStatus: 'UNPLANNED', status: '10' })) };
  const bases = [];
  for (const judges of [
    {},
    { live: { at: '2026-09-26T19:38:56Z', windowStart: '2026-09-20', stopNbrs: new Set(['U1', 'U2', 'U3', 'U4']), thin: false }, lastUnplannedScanAt: '2026-09-26T19:38:56Z' },
    // The judge production uses: the open-order pool. U5 is not in it — closed or moved since.
    { pool: POOL, lastUnplannedScanAt: '2026-09-26T19:38:56Z' },
  ]) {
    const b = board(undefined, judges);
    const now = () => Date.parse('2026-09-26T20:00:00Z');
    // The Map: nuvizz-pull-today-stops's own steps.
    const mapRows = filterFinishedPriorDay((await b.readStops('davis', D)).stops, D);
    const stats = {};
    await mergeCarryover(mapRows, D, 1, { readStops: b.readStops, readActiveUnplannedSet: b.readActiveUnplannedSet, readCarryoverRetired: b.readCarryoverRetired, readActivePool: b.readActivePool, now, stats }, undefined, judges.lastUnplannedScanAt ?? null);
    const mapServed = dropCancelledStops(mapRows, true).stops;
    // The planner.
    const reads = [{ d: PRIOR, stops: (await b.readStops('davis', PRIOR)).stops }];
    const plan = boardRowsAsServed((await b.readStops('davis', D)).stops, D, { reads, live: judges.live ?? null, retired: {}, pool: judges.pool ?? null, nowMs: now, lastUnplannedScanAt: judges.lastUnplannedScanAt ?? null }, {});
    assert.deepEqual(plan.rows, mapServed, JSON.stringify(Object.keys(judges)));
    assert.deepEqual({ ...plan.carry }, { ...stats });
    bases.push(plan.carry?.basis);
  }
  assert.deepEqual(bases, ['none', 'snapshot', 'pool'], 'each judge was actually the one used');
});

test('the prompt a plan is run with differs from a backtest’s in exactly the rules it should', () => {
  assert.notEqual(PLAN_SYSTEM, BT_SYSTEM);
  assert.match(PLAN_SYSTEM, /the trucks \(loads\) the dispatcher picked for it/);
  assert.match(PLAN_SYSTEM, /ONLY when no load has room for it/);
  assert.match(PLAN_SYSTEM, /Place as many stops as the trucks can legally carry/);
  assert.match(PLAN_SYSTEM, /keep on Lx/);
  assert.doesNotMatch(PLAN_SYSTEM, /every stop was delivered/, 'a forward plan must not be told the day already ran');
  assert.doesNotMatch(PLAN_SYSTEM, /no-tractor stop no box-truck load has room for, with a reason, and the evaluator refuses any other/);
});

test('a backtest’s briefing is unchanged by the keep flag; a plan’s kept stop says which load keeps it', async () => {
  const st = store();
  const { problem } = await readPlanDay(PARAMS, RS, deps(st));
  const lines = btBriefing(problem).split('\n');
  const k1 = problem.stops.find((s) => s.n === 'K1');
  assert.ok(lines.find((l) => l.startsWith(`${k1.id} | `)).endsWith('| keep on L1'));
  const u1 = problem.stops.find((s) => s.n === 'U1');
  assert.ok(lines.find((l) => l.startsWith(`${u1.id} | `)).endsWith('| 500 | '), 'an ordinary stop’s line ends as it always did');
  const bt = btBriefing({ ...problem, mode: undefined, stops: problem.stops.map(({ pin, ...s }) => s) });
  assert.ok(!bt.includes('keep on'));
});

test('THE EVALUATOR IN PLAN MODE: nothing left off a truck with room, a kept stop stays on its load, and a stop left off says why', async () => {
  const st = store();
  const { problem: p, cfg } = await readPlanDay(PARAMS, RS, deps(st));
  const seq = makeSequencer(p, cfg);
  const id = (n) => p.stops.find((s) => s.n === n).id;
  const rest = ['U1', 'U2', 'U3', 'U4', 'U5'].map(id);
  const good = evaluateAssignment(p, { loads: [{ load: 'L1', stops: [id('K1')] }, { load: 'L2', stops: rest }], unplanned: [] }, cfg, seq);
  assert.deepEqual(good.summary.hardViolations, [], JSON.stringify(good.summary.hardViolations));
  const leftOff = evaluateAssignment(p, { loads: [{ load: 'L1', stops: [id('K1')] }, { load: 'L2', stops: rest.slice(1) }], unplanned: [{ stop: rest[0], reason: 'shorter' }] }, cfg, seq);
  assert.ok(leftOff.summary.hardViolations.some((h) => /left unplanned but L\d has room for it/.test(h)), JSON.stringify(leftOff.summary.hardViolations));
  const moved = evaluateAssignment(p, { loads: [{ load: 'L1', stops: [] }, { load: 'L2', stops: [...rest, id('K1')] }], unplanned: [] }, cfg, seq);
  assert.ok(moved.summary.hardViolations.some((h) => /already on L1 in NuVizz and stays there/.test(h)), JSON.stringify(moved.summary.hardViolations));
  // NO ROOM: shrink both trucks so only what is on them fits — then leaving the rest off is allowed, with a reason.
  const tight = { ...p, loads: p.loads.map((l) => ({ ...l, cap: l.id === 'L1' ? 2 : 4 })) };
  const tseq = makeSequencer(tight, cfg);
  const full = evaluateAssignment(tight, { loads: [{ load: 'L1', stops: [id('K1')] }, { load: 'L2', stops: rest.slice(0, 2) }], unplanned: rest.slice(2).map((s) => ({ stop: s, reason: 'no truck has room' })) }, cfg, tseq);
  assert.deepEqual(full.summary.hardViolations, [], JSON.stringify(full.summary.hardViolations));
  const noReason = evaluateAssignment(tight, { loads: [{ load: 'L1', stops: [id('K1')] }, { load: 'L2', stops: rest.slice(0, 2) }], unplanned: rest.slice(2).map((s) => ({ stop: s, reason: '' })) }, cfg, tseq);
  assert.ok(noReason.summary.hardViolations.some((h) => /unplanned with no reason/.test(h)));
  // THE DAY: room in spots and pounds is not room when the driver’s day is spent.
  const short = { ...p, loads: p.loads.map((l) => ({ ...l, maxMin: l.id === 'L2' ? 45 : l.maxMin, cap: l.id === 'L1' ? 2 : l.cap })) };
  const sseq = makeSequencer(short, cfg);
  const dayFull = evaluateAssignment(short, { loads: [{ load: 'L1', stops: [id('K1')] }, { load: 'L2', stops: [rest[0]] }], unplanned: rest.slice(1).map((s) => ({ stop: s, reason: 'day is full' })) }, cfg, sseq);
  assert.ok(!dayFull.summary.hardViolations.some((h) => /has room/.test(h)), JSON.stringify(dayFull.summary.hardViolations));
});

test('capacity before any spend: what the picked loads carry against what there is to carry, kept stops included', async () => {
  const st = store();
  const { problem } = await readPlanDay(PARAMS, RS, deps(st));
  const c = planCapacity(problem);
  assert.equal(c.stops, 6);
  assert.equal(c.kept, 1);
  assert.equal(c.spots, 12);
  assert.equal(c.capSpots, problem.loads[0].cap + problem.loads[1].cap);
  assert.equal(c.short.spots, 0);
  const lean = planCapacity({ ...problem, loads: [{ ...problem.loads[0], cap: 5 }] });
  assert.equal(lean.short.spots, 7, 'short by what does not fit, said before the run');
});

test('the picker marks a driver who already has a load that day, and says what each roster load already carries', async () => {
  const st = store({
    [`nuvizz_load_roster/davis__${D}`]: { at: '2026-09-26T19:00:00Z', loadsJson: JSON.stringify([{ name: 'SCOTT', loadNbr: 'DAVIS000204626', driver: 'Scott Hart', status: 'Draft' }, { name: '1 SATL', loadNbr: 'D2', driver: null, status: 'Draft' }]) },
    'claude_shadow_learned/davis__capacity': { drivers: [{ key: 'SCOTT HART', name: 'Scott Hart', capUsed: 18, capSource: 'learned', routes: [{ name: 'SCOTT' }], trips: 40 }], routes: [] },
  });
  const o = await planOptions(D, RS, deps(st));
  assert.equal(o.date, D);
  const scott = o.roster.loads.find((l) => l.route === 'SCOTT');
  assert.equal(scott.onBoard, 1, 'K1 is already on SCOTT');
  assert.equal(o.roster.loads.find((l) => l.route === '1 SATL').driver, null);
  assert.equal(o.nuvizzCalls, 0);
});

test('PLAN → QUEUE → WORKER → RESULT: built when queued, run by the backtest worker, stored as a plan, and read back with its map', async () => {
  const st = store();
  const c = clock();
  const d = deps(st, { now: c.now });
  const q = await enqueuePlan(PARAMS, 'disp', d);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const id = q.body.jobId;
  assert.match(id, /^pl__2026-09-28__/);
  const job = st.docs.get(jobPath(id));
  assert.equal(job.kind, 'plan');
  assert.equal(job.status, 'queued');
  assert.deepEqual(job.params.picks.map((p) => p.route), ['SCOTT', 'SPARE BOX']);
  const stored = st.docs.get(`${jobPath(id)}/data/problem`);
  assert.ok(stored.problemJson && stored.promptJson, 'the board is frozen with the job');
  const again = await enqueuePlan(PARAMS, 'disp', d);
  assert.equal(again.status, 409, 'one plan of a day at a time');
  // The model: evaluate, then submit — ids read from the frozen problem.
  const p = JSON.parse(stored.problemJson);
  const idOf = (n) => p.stops.find((s) => s.n === n).id;
  const PLAN = { loads: [{ load: 'L1', stops: [idOf('K1')] }, { load: 'L2', stops: ['U1', 'U2', 'U3', 'U4', 'U5'].map(idOf) }], unplanned: [] };
  const usage = { input_tokens: 2000, output_tokens: 1000 };
  const reply = (content) => ({ ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content, usage } });
  const script = [
    reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
    reply([{ type: 'tool_use', id: 't2', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'area' })), summary: 'ok' } }]),
  ];
  let i = 0;
  const calls = [];
  const w = await workerTick({ ...d, call: async (req) => { calls.push(req); return script[i++]; } });
  assert.equal(w.done, true, JSON.stringify(w));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].system?.[0]?.text ?? calls[0].system, JSON.parse(stored.promptJson).system, 'run with the frozen prompt');
  const done = st.docs.get(jobPath(id));
  assert.equal(done.status, 'done');
  assert.equal(done.headline.placed, 5, 'placed by Claude: the kept stop was already there');
  assert.equal(done.headline.kept, 1);
  assert.equal(done.headline.unplanned, 0);
  const r = await planResult(id, d);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.kind, 'plan');
  assert.equal(r.body.result.loads.find((l) => l.id === 'L1').kept, 1);
  assert.equal(r.body.result.nuvizzCalls, 0);
  const m = await planMap(id, d, jobPath);
  assert.equal(m.status, 200);
  assert.equal(m.body.map.kind, 'plan');
  assert.equal(m.body.map.stops.find((s) => s.n === 'U5')?.day ?? m.body.map.stops.find((s) => s.id === idOf('U5')).day, PRIOR);
  // One queue, one ceiling: the backtest list does not show the plan, but its spend counts against the shared ceiling.
  const bv = await backtestView(d);
  assert.equal(bv.jobs.length, 0);
  assert.ok(bv.ceiling.spent24h > 0);
  const pv = await planView(d);
  assert.equal(pv.jobs.length, 1);
  assert.equal(pv.jobs[0].status, 'done');
  assert.ok(st.writes.every((w2) => w2.startsWith('claude_shadow_')));
});

test('a plan is stopped like a backtest, a plan with nothing to place is refused, and a plan job whose board went missing fails plainly', async () => {
  const st = store();
  const d = deps(st);
  const q = await enqueuePlan(PARAMS, 'disp', d);
  const c = await cancelJob(q.body.jobId, 'disp', d);
  assert.equal(c.status, 200);
  assert.equal(st.docs.get(jobPath(q.body.jobId)).status, 'cancelled');
  const empty = await enqueuePlan(PARAMS, 'disp', { ...d, board: board({ [D]: [planned('K9', 'OTHER', 34, -84)] }) });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /nothing to plan on 2026-09-28/);
  // A plan job with no stored board (written by hand, or a write that never landed) is never rebuilt quietly.
  st.docs.set(jobPath('pl__2026-09-28__x'), { kind: 'plan', date: D, status: 'queued', createdAt: '2026-09-26T00:00:00Z', settings: {} });
  const w = await workerTick({ ...d, call: async () => { throw new Error('must not be called'); } });
  assert.equal(w.failed, 'no stored plan');
  assert.match(st.docs.get(jobPath('pl__2026-09-28__x')).error, /not on file — queue it again/);
});

test('an employees roster that cannot be read refuses the plan — no tractor is ever planned as a box truck — and the picker says no class is known', async () => {
  const st = store();
  const listDocs = st.listDocs;
  st.listDocs = async (coll, opts) => { if (coll === 'employees') throw new Error('listDocs employees failed: 429'); return listDocs(coll, opts); };
  await assert.rejects(readPlanDay(PARAMS, RS, deps(st)), /the employees roster could not be read, so no truck class is known/);
  const o = await planOptions(D, RS, deps(st));
  assert.equal(o.classesKnown, false);
  const q = await enqueuePlan(PARAMS, 'disp', deps(st));
  assert.equal(q.status, 422);
  assert.ok(![...st.docs.keys()].some((k) => k.startsWith('claude_shadow_jobs/')), 'nothing queued, nothing to pay for');
});


// ── v1.76.0 REVIEW FIXES ─────────────────────────────────────────────────────
test('a stop is planned where the Map draws it: at the dispatcher’s corrected pin — which also gives a stop with no feed geocode a place', async () => {
  const n1 = stop('N1', null, null);
  const u1 = stop('U1', 34.30, -83.80);
  const st = store({
    [`customer_notes/${rowMatchKey(n1)}`]: { location_override: { lat: 34.05, lng: -84.05 } },
    [`customer_notes/${rowMatchKey(u1)}`]: { location_override: { lat: 34.01, lng: -84.02 } },
  });
  const { problem } = await readPlanDay(PARAMS, RS, deps(st));
  assert.equal(problem.counts.noLocation, 0, 'N1 now has a place');
  assert.equal(problem.counts.corrected, 2);
  const s1 = problem.stops.find((x) => x.n === 'U1');
  assert.deepEqual([s1.lat, s1.lng], [34.01, -84.02], 'the corrected pin, not the feed geocode');
  assert.ok(problem.stops.some((x) => x.n === 'N1'));
});

test('a route name the roster gives to two loads cannot tie its board stops to either: they are neither kept nor planned, and counted', async () => {
  const st = store({ [`nuvizz_load_roster/davis__${D}`]: { loadsJson: JSON.stringify([{ name: 'SCOTT', loadNbr: 'A1', driver: 'Scott Hart' }, { name: 'SCOTT', loadNbr: 'A2', driver: 'Other Driver' }]) } });
  const { problem } = await readPlanDay(PARAMS, RS, deps(st));
  assert.equal(problem.counts.kept, 0);
  assert.equal(problem.counts.ambiguous, 1);
  assert.ok(!problem.stops.some((x) => x.n === 'K1'));
});

test('KEPT STOPS THAT BREAK THEIR OWN LOAD’S RULES: no plan could pass, so it is refused at preview and at Plan, before any spend', async () => {
  // Scott's own cap, typed at 1 skid spot: the 2-spot stop already on SCOTT is past it by itself.
  const st = store({ [capDocPath('driver', 'SCOTT HART')]: { kind: 'driver', key: 'SCOTT HART', name: 'Scott Hart', cap: 1 } });
  const { problem } = await readPlanDay(PARAMS, RS, deps(st));
  assert.match(problem.infeasible, /SCOTT already carries 2 skid spots in NuVizz, past its cap of 1/);
  const q = await enqueuePlan(PARAMS, 'disp', deps(st));
  assert.equal(q.status, 422);
  assert.match(q.body.error, /^not queued — the stops already on these picked loads break a rule by themselves/);
  assert.ok(![...st.docs.keys()].some((k) => k.startsWith('claude_shadow_jobs/')), 'nothing queued, nothing paid for');
});

test('two Plan presses at once queue ONE run; a plan whose board was re-scanned since its preview is refused', async () => {
  const st = store();
  const d = deps(st);
  const [a, b] = await Promise.all([enqueuePlan(PARAMS, 'disp', d), enqueuePlan(PARAMS, 'disp', d)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([...st.docs.keys()].filter((k) => /^claude_shadow_jobs\/pl__[^/]+$/.test(k)).length, 1);
  const st2 = store();
  const stale = await enqueuePlan({ ...PARAMS, expectBoardAt: '2026-09-26T18:00:00Z' }, 'disp', deps(st2));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /scanned again since your preview/);
  const ok = await enqueuePlan({ ...PARAMS, expectBoardAt: '2026-09-26T19:38:56Z' }, 'disp', deps(st2));
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.ahead, 'number');
});

test('ROOM IS NEVER A TRAP: wherever roomFor says a load has room, putting the stop there passes on that load by the evaluator’s own measure', async () => {
  const st = store();
  const { problem: p0, cfg } = await readPlanDay({ ...PARAMS, picks: [PICKS[1], { kind: 'truck', route: 'SPARE BOX 2', driver: null, cls: 'box_truck', loadNbr: null }] }, RS, deps(st));
  // A spread of days and places: some loads nearly out of day, some far stops.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let claimed = 0;
  for (let trial = 0; trial < 12; trial++) {
    const p = structuredClone(p0);
    for (const s of p.stops) { s.lat = 33.7 + rnd() * 0.9; s.lng = -84.6 + rnd() * 1.0; }
    const seq = makeSequencer(p, cfg);
    const first = p.stops.slice(0, 3).map((s) => s.id);
    const assign = new Map([[p.loads[0].id, first]]);
    const m = measurePlan(p, assign, cfg, seq, 0);
    for (const l of p.loads) l.maxMin = Math.round((m.loads.find((x) => x.id === l.id)?.driverMin ?? 0) + 16 + rnd() * 60);
    const m2 = measurePlan(p, assign, cfg, seq, 0);
    for (const s of p.stops.slice(3)) {
      const room = roomFor(p, m2, s, cfg, { seq, assign, budget: { left: 50 } });
      if (!room) continue;
      claimed++;
      const next = new Map(assign); next.set(room.load, [...(assign.get(room.load) || []), s.id]);
      const lm = measurePlan(p, next, cfg, seq, 0).loads.find((x) => x.id === room.load);
      assert.ok(lm && !lm.over && !lm.overWeight && !lm.blocked && !lm.overTime, `trial ${trial}: roomFor said ${room.load} has room for ${s.n} but it breaks (${JSON.stringify(lm)})`);
    }
  }
  assert.ok(claimed > 0, 'the property was exercised');
});
