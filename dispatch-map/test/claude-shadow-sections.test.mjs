// test/claude-shadow-sections.test.mjs — PLANNING IN SECTIONS (v1.78.0).
//
// Chad, 2026-09-27: "instead of letting you do it all at once i would like the choice to do it in
// sections where i have a map in a drawer and can select the stops i want you to put the stops on."
// What a dispatcher relies on when planning a board a piece at a time: only the stops picked on the
// map are placed; a truck used again in the next section still carries what the last section put on
// it (and that counts against its room); a truck not used again keeps its stops, carried forward; no
// stop is offered twice; and NuVizz outranks a section — a stop on a load in NuVizz is where NuVizz
// has it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlanParams, validateStopsParams, selectPlanStops, pickIdentity, placementsOf, leftOffOf, MAX_PLAN_STOPS, STOP_NBR_RE,
} from '../netlify/functions/lib/claude-shadow/plan-core.mts';
import { readPlanDay, planStops, planPreview, planResult } from '../netlify/functions/lib/claude-shadow/plan.mts';
import { enqueuePlan } from '../netlify/functions/lib/claude-shadow/plan-jobs.mts';
import { workerTick, jobPath, routerSettingsFrom } from '../netlify/functions/lib/claude-shadow/backtest.mts';
import { PLAN_SYSTEM, BT_SYSTEM, btBriefing, evaluateAssignment, makeSequencer } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';

const D = '2026-09-28';
const ENV = { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' };
const RS = routerSettingsFrom(null);

const stop = (nbr, lat, lng, o = {}) => ({
  stopNbr: nbr, stopType: 'DO', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true,
  cartons: 2, volume: 0, weight: 500, businessName: `CUST ${nbr}`, addr1: `${nbr} MAIN ST`, city: 'GAINESVILLE', zip: '30501', lat, lng, ...o,
});
const planned = (nbr, route, lat, lng) => stop(nbr, lat, lng, { status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, routeName: route, loadNbr: route, driverName: 'Scott Hart' });
const DAY = () => [
  stop('U1', 34.30, -83.80), stop('U2', 34.31, -83.81), stop('U3', 33.90, -84.20), stop('U4', 33.91, -84.21), stop('U5', 33.92, -84.22),
  planned('K1', 'SCOTT', 34.305, -83.805),
  planned('P2', 'OTHER', 34.0, -84.0),
  stop('PU1', 34.1, -83.9, { stopType: 'PU' }),
  stop('F1', 34.1, -83.9, { status: '90', normalizedStatus: 'DELIVERED' }),
  stop('N1', null, null),
];
function board(rows = DAY()) {
  return {
    readStops: async (_t, d) => ({ meta: d === D ? { last_scanned_at: '2026-09-26T19:38:56Z' } : null, stops: d === D ? structuredClone(rows) : [] }),
    readActivePool: async () => null, readActiveUnplannedSet: async () => null, readCarryoverRetired: async () => ({}),
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
function deps(st, extra = {}) {
  let t = Date.parse('2026-09-26T23:00:00Z');
  return { ...st, now: () => new Date(t += 1000), env: ENV, firestoreOn: () => true, board: board(), call: async () => { throw new Error('no model in this test'); }, ...extra };
}
const SCOTT = { kind: 'roster', route: 'SCOTT', driver: 'Scott Hart', cls: null, loadNbr: 'DAVIS000204626' };
const SPARE = { kind: 'truck', route: 'SPARE BOX 1', driver: null, cls: 'box_truck', loadNbr: null };
const SPARE2 = { kind: 'truck', route: 'SPARE BOX 2', driver: null, cls: 'box_truck', loadNbr: null };
const P = (o = {}) => ({ date: D, lookbackDays: 0, scope: 'unplanned', picks: [SCOTT, SPARE], ...o });

test('a section is a list of stop numbers or nothing; the plan it builds on is a plan id — anything else is refused and every reason is said', () => {
  const v = validatePlanParams(P());
  assert.equal(v.ok, true);
  assert.equal(v.params.section, null, 'no section: every stop the scope allows');
  assert.equal(v.params.after, null);
  assert.deepEqual(validatePlanParams(P({ section: ['U1', ' U2 ', 'U1', 7] })).params.section, ['U1', 'U2', '7'], 'trimmed, one of each');
  assert.equal(validatePlanParams(P({ section: [] })).ok, false, 'a section with no stops is not a section');
  assert.equal(validatePlanParams(P({ section: 'U1' })).ok, false);
  assert.equal(validatePlanParams(P({ section: ['a/b'] })).ok, false, 'a slash is never part of a stop number');
  assert.equal(validatePlanParams(P({ section: [{}] })).ok, false);
  assert.equal(validatePlanParams(P({ section: Array.from({ length: MAX_PLAN_STOPS + 1 }, (_, i) => `S${i}`) })).ok, false);
  assert.equal(validatePlanParams(P({ after: 'pl__2026-09-28__2026-09-27T01-00-00-000Z__abc123' })).ok, true);
  for (const bad of ['bt__x', 'pl__../x', 42, '']) assert.equal(validatePlanParams(P({ after: bad })).ok, false, `after ${JSON.stringify(bad)}`);
  const many = validatePlanParams(P({ section: [], after: 'nope', lookbackDays: 99 }));
  assert.equal(many.errors.length, 3);
  for (const n of ['DAVIS00203731', 'AVRT-0028093763', 'ESTES-0538243875', 'A B']) assert.ok(STOP_NBR_RE.test(n), n);
  const m = validateStopsParams({ date: D, lookbackDays: 3, scope: 'open' });
  assert.equal(m.ok, true, 'the stop map needs no loads');
  assert.deepEqual(m.params, { date: D, lookbackDays: 3, scope: 'open', after: null });
});

test('the same load is the same load from one section to the next: a roster load by its load number, anything else by what it is, its route and its driver', () => {
  assert.equal(pickIdentity(SCOTT), 'nbr:DAVIS000204626');
  assert.equal(pickIdentity({ ...SCOTT, route: 'SCOTT (renamed)' }), 'nbr:DAVIS000204626', 'a roster load keeps its identity when its name changes');
  assert.equal(pickIdentity(SPARE), pickIdentity({ ...SPARE }));
  assert.notEqual(pickIdentity(SPARE), pickIdentity(SPARE2));
  assert.notEqual(pickIdentity({ kind: 'driver', route: 'X', driver: 'A B' }), pickIdentity({ kind: 'driver', route: 'X', driver: 'C D' }));
});

test('A SECTION PLACES ONLY ITS PICKED STOPS: the rest are left for later, a stop already on a picked truck still rides it, and a picked stop that cannot be planned is counted', () => {
  const rows = DAY();
  const r = selectPlanStops(rows, D, 'unplanned', 0, new Set(['SCOTT']), undefined, new Set(), { section: new Set(['U1', 'U2', 'F1', 'P2', 'GONE']) });
  assert.deepEqual(r.chosen.map((x) => x.stopNbr).sort(), ['K1', 'U1', 'U2'], 'the two picked, and K1 because SCOTT carries it in NuVizz');
  assert.equal(r.counts.toPlan, 2);
  assert.equal(r.counts.section, 5);
  assert.equal(r.counts.leftForLater, 3, 'U3, U4, U5 wait for another section');
  assert.deepEqual(r.sectionMissing.sort(), ['F1', 'GONE', 'P2'], 'finished, not on the board, on a load not picked');
  assert.equal(r.counts.sectionMissing, 3);
  assert.deepEqual(r.counts.byDay, { [D]: 2 });
  const all = selectPlanStops(rows, D, 'unplanned', 0, new Set(['SCOTT']));
  assert.equal(all.counts.section, null, 'no section: nothing counted as left for later');
  assert.equal(all.counts.toPlan, 5);
  assert.equal(all.counts.leftForLater, 0);
});

test('AN EARLIER SECTION’S STOPS: kept on a truck picked again, carried forward on one that is not, never offered twice — and NuVizz outranks it', () => {
  const rows = [...DAY(), stop('M1', 34.2, -83.7, { isPlanned: true, routeName: 'OTHER', loadNbr: 'OTHER' })];
  const earlier = new Map([
    ['U1', { key: pickIdentity(SPARE), route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }],
    ['U2', { key: pickIdentity(SPARE2), route: 'SPARE BOX 2', driver: '(no driver)', cls: 'box_truck' }],
    ['F1', { key: pickIdentity(SPARE), route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }],   // finished since
    ['M1', { key: pickIdentity(SPARE), route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }],   // NuVizz put it on OTHER since
    ['K1', { key: pickIdentity(SPARE), route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }],   // NuVizz put it on SCOTT since
  ]);
  const pickOf = new Map([[pickIdentity(SCOTT), 0], [pickIdentity(SPARE), 1]]);
  const r = selectPlanStops(rows, D, 'unplanned', 0, new Set(['SCOTT']), undefined, new Set(), { section: new Set(['U1', 'U3']), earlier, pickOf });
  assert.deepEqual([...r.pinTo], [['U1', 1]], 'U1 stays on SPARE BOX 1, picked again');
  assert.deepEqual(r.carried.map((c) => [c.n, c.route]), [['U2', 'SPARE BOX 2']], 'U2 rides SPARE BOX 2, not picked here: carried forward as placed');
  assert.deepEqual(r.earlierDropped.sort(), ['F1', 'M1'], 'finished, and moved in NuVizz to a load not picked: dropped from the chain');
  assert.ok(r.kept.has('K1'), 'NuVizz has K1 on SCOTT, picked: kept there as NuVizz says, not where the section put it');
  assert.ok(!r.pinTo.has('K1'));
  assert.deepEqual(r.chosen.map((x) => x.stopNbr).sort(), ['K1', 'U1', 'U3']);
  assert.equal(r.counts.toPlan, 1, 'only U3 is Claude’s to place');
  assert.equal(r.counts.sectionAlreadyPlaced, 1, 'U1 was picked on the map again but the earlier section already placed it');
  assert.equal(r.counts.earlierKept, 1);
  assert.equal(r.counts.earlierCarried, 1);
  assert.equal(r.counts.earlierDropped, 2);
});

test('an earlier section’s stops ride their load in the problem, are flagged to Claude as such, and the evaluator holds them there in words that are true', async () => {
  const st = store({
    'claude_shadow_plans/pl__2026-09-28__a': {
      date: D, at: '2026-09-26T23:30:00Z',
      loadKeys: [{ id: 'L1', key: pickIdentity(SCOTT) }, { id: 'L2', key: pickIdentity(SPARE) }],
      loads: [{ id: 'L1', route: 'SCOTT', driver: 'Scott Hart', cls: 'box_truck' }, { id: 'L2', route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }],
      placements: [{ n: 'U1', load: 'L2' }, { n: 'U2', load: 'L1' }],
      section: { carried: [{ n: 'U5', key: pickIdentity(SPARE2), route: 'SPARE BOX 2', driver: '(no driver)', cls: 'box_truck' }] },
    },
  });
  const params = validatePlanParams(P({ picks: [SPARE, SCOTT], section: ['U3', 'U4'], after: 'pl__2026-09-28__a' })).params;
  const { problem } = await readPlanDay(params, RS, deps(st));
  const at = (n) => problem.stops.find((s) => s.n === n);
  assert.equal(at('U1').pin, 'L1', 'SPARE BOX 1 is L1 in this plan: U1 stays on it');
  assert.equal(at('U1').pinFrom, 'section');
  assert.equal(at('U2').pin, 'L2', 'SCOTT is L2 in this plan');
  assert.equal(at('K1').pinFrom, 'nuvizz', 'K1 rides SCOTT because NuVizz has it there');
  assert.ok(!at('U5'), 'U5 rides SPARE BOX 2, not picked here: not in this plan');
  assert.deepEqual(problem.section.carried.map((c) => c.n), ['U5'], 'and carried forward with the result');
  assert.deepEqual(problem.loadKeys, [{ id: 'L1', key: pickIdentity(SPARE) }, { id: 'L2', key: pickIdentity(SCOTT) }]);
  assert.equal(problem.counts.toPlan, 2);
  const brief = btBriefing(problem);
  assert.match(brief, /\| keep on L1, earlier section$/m, 'Claude is told the stop is there from an earlier section');
  assert.match(brief, / keep on L2$/m, 'and a NuVizz stop is flagged as before');
  assert.match(PLAN_SYSTEM, /earlier section/);
  assert.doesNotMatch(BT_SYSTEM, /earlier section/, 'a backtest’s prompt is untouched');
  assert.ok(problem.approximations.some((a) => /SECTION/.test(a)) && problem.approximations.some((a) => /builds on an earlier section/.test(a)));
  const cfg = effectiveEngineConfig(null, ENV);
  const plan = { loads: [{ load: 'L2', stops: problem.stops.filter((s) => s.n !== 'U1').map((s) => s.id).concat(at('U1').id) }], unplanned: [] };
  const ev = evaluateAssignment(problem, plan, cfg, makeSequencer(problem, cfg));
  assert.ok(ev.summary.hardViolations.some((h) => /is already on L1 from an earlier section and stays there/.test(h)), JSON.stringify(ev.summary.hardViolations));
});

test('a section cannot build on a plan of another day, a plan with no result, or one made before sections existed', async () => {
  const st = store({
    'claude_shadow_plans/pl__2026-09-27__x': { date: '2026-09-27', placements: [], loadKeys: [] },
    'claude_shadow_plans/pl__2026-09-28__old': { date: D, loads: [] },
  });
  const d = deps(st);
  const go = (after) => readPlanDay(validatePlanParams(P({ after })).params, RS, d);
  await assert.rejects(go('pl__2026-09-27__x'), /of 2026-09-27, not 2026-09-28/);
  await assert.rejects(go('pl__2026-09-28__none'), /no result yet/);
  await assert.rejects(go('pl__2026-09-28__old'), /before sections existed/);
});

test('THE STOP MAP reads the same board, free: every open delivery with where it is and what it carries, marked on a load or placed earlier', async () => {
  const st = store({
    'claude_shadow_plans/pl__2026-09-28__a': {
      date: D, at: '2026-09-26T23:30:00Z', loadKeys: [{ id: 'L1', key: pickIdentity(SPARE) }],
      loads: [{ id: 'L1', route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }], placements: [{ n: 'U1', load: 'L1' }], section: null,
    },
  });
  const r = await planStops({ date: D, lookbackDays: 0, scope: 'unplanned', after: 'pl__2026-09-28__a' }, deps(st));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.deepEqual(b.stops.map((s) => s.n).sort(), ['K1', 'P2', 'U1', 'U2', 'U3', 'U4', 'U5'], 'no pickup, no finished stop, no stop without a map point');
  assert.equal(b.counts.noLocation, 1);
  assert.equal(b.stops.find((s) => s.n === 'K1').onLoad, 'SCOTT');
  assert.deepEqual(b.stops.find((s) => s.n === 'U1').earlier, { route: 'SPARE BOX 1', driver: '(no driver)' });
  assert.equal(b.stops.find((s) => s.n === 'U2').spots, 2);
  assert.equal(b.stops.find((s) => s.n === 'U2').lbs, 500);
  assert.equal(b.truncated, false);
  assert.equal(b.nuvizzCalls, 0);
  assert.equal(st.writes.length, 0, 'a read writes nothing');
  assert.equal((await planStops({ date: 'x' }, deps(st))).status, 400);
});

test('a section with nothing of its own to place is refused at preview and at Plan, and a queued section keeps its size on the job, not its list', async () => {
  const st = store();
  const d = deps(st);
  const pv = await planPreview(P({ section: ['F1', 'P2'] }), RS, d);
  assert.equal(pv.status, 200);
  assert.match(pv.body.nothingToPlace, /none of the 2 stops picked/);
  const q = await enqueuePlan(P({ section: ['F1', 'P2'] }), 'disp', d);
  assert.equal(q.status, 422);
  assert.match(q.body.error, /none of the 2 stops picked/);
  const ok = await enqueuePlan(P({ section: ['U1', 'U2'] }), 'disp', d);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const job = st.docs.get(jobPath(ok.body.jobId));
  assert.equal(job.params.section, null);
  assert.equal(job.params.sectionSize, 2);
  const stored = JSON.parse(st.docs.get(`${jobPath(ok.body.jobId)}/data/problem`).problemJson);
  assert.deepEqual(stored.stops.map((s) => s.n).sort(), ['K1', 'U1', 'U2'], 'the frozen problem holds the section');
});

test('TWO SECTIONS, END TO END: the first places its stops; the second, built on it, keeps them on the truck picked again, carries the rest, and places only its own', async () => {
  const st = store();
  const d = deps(st);
  const usage = { input_tokens: 2000, output_tokens: 1000 };
  const reply = (content) => ({ ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content, usage } });
  const runWith = async (id, planOf) => {
    const p = JSON.parse(st.docs.get(`${jobPath(id)}/data/problem`).problemJson);
    const PLAN = planOf(p, (n) => p.stops.find((s) => s.n === n).id);
    const script = [
      reply([{ type: 'tool_use', id: 't1', name: 'evaluate_plan', input: PLAN }]),
      reply([{ type: 'tool_use', id: 't2', name: 'submit_plan', input: { ...PLAN, loads: PLAN.loads.map((l) => ({ ...l, why: 'area' })), summary: 'ok' } }]),
    ];
    let i = 0;
    const w = await workerTick({ ...d, call: async () => script[i++] });
    assert.equal(w.done, true, JSON.stringify(w));
    return (await planResult(id, d)).body.result;
  };
  // SECTION 1: U1 and U2 onto SCOTT (which already carries K1) and SPARE BOX 1.
  const q1 = await enqueuePlan(P({ picks: [SCOTT, SPARE], section: ['U1', 'U2'] }), 'disp', d);
  assert.equal(q1.status, 200, JSON.stringify(q1.body));
  const r1 = await runWith(q1.body.jobId, (p, id) => ({ loads: [{ load: 'L1', stops: [id('K1'), id('U1')] }, { load: 'L2', stops: [id('U2')] }], unplanned: [] }));
  assert.deepEqual(r1.placements.map((x) => [x.n, x.load]).sort(), [['U1', 'L1'], ['U2', 'L2']], 'Claude’s placements; K1 is NuVizz’s, not Claude’s');
  assert.deepEqual(r1.loadKeys.map((x) => x.key), [pickIdentity(SCOTT), pickIdentity(SPARE)]);
  // SECTION 2: U3 and U4, built on section 1, onto SPARE BOX 1 and a new SPARE BOX 2 — SCOTT not picked again.
  const q2 = await enqueuePlan(P({ picks: [SPARE, SPARE2], section: ['U3', 'U4', 'U1'], after: q1.body.jobId }), 'disp', d);
  assert.equal(q2.status, 200, JSON.stringify(q2.body));
  const p2 = JSON.parse(st.docs.get(`${jobPath(q2.body.jobId)}/data/problem`).problemJson);
  assert.deepEqual(p2.stops.map((s) => [s.n, s.pin ?? null]).sort(), [['U2', 'L1'], ['U3', null], ['U4', null]], 'U2 stays on SPARE BOX 1 (L1 now); U1 rode SCOTT, which is not picked: not here');
  assert.deepEqual(p2.section.carried.map((c) => [c.n, c.route]), [['U1', 'SCOTT']]);
  assert.equal(p2.counts.sectionAlreadyPlaced, 1, 'U1 was picked again on the map; it is already placed');
  const r2 = await runWith(q2.body.jobId, (p, id) => ({ loads: [{ load: 'L1', stops: [id('U2'), id('U3')] }, { load: 'L2', stops: [id('U4')] }], unplanned: [] }));
  // THE CHAIN: every stop Claude placed across both sections, from the second's result alone.
  const chain = placementsOf(r2);
  assert.deepEqual([...chain].map(([n, e]) => [n, e.route]).sort(), [['U1', 'SCOTT'], ['U2', 'SPARE BOX 1'], ['U3', 'SPARE BOX 1'], ['U4', 'SPARE BOX 2']]);
  assert.equal(r2.loads.find((l) => l.id === 'L1').earlier, 1, 'the result says how many stops on a load came from the earlier section');
  assert.ok(st.writes.every((w) => w.startsWith('claude_shadow_')));
});

// ── REVIEW (v1.78.0): what the adversarial review found, each pinned by the case that showed it ──────
const earlierResult = (o = {}) => ({
  date: D, at: '2026-09-26T23:30:00Z', params: { date: D, lookbackDays: 0, scope: 'unplanned' },
  loadKeys: [{ id: 'L1', key: pickIdentity(SCOTT) }, { id: 'L2', key: pickIdentity(SPARE) }],
  loads: [{ id: 'L1', route: 'SCOTT', driver: 'Scott Hart', cls: 'box_truck' }, { id: 'L2', route: 'SPARE BOX 1', driver: '(no driver)', cls: 'box_truck' }],
  placements: [{ n: 'U1', load: 'L1' }, { n: 'U2', load: 'L2' }], section: null, unplanned: [], ...o,
});

test('ONE DRIVER, ONE DAY: a section that hands a driver another truck while his earlier stops ride one not picked is refused at $0, naming the truck to pick again', async () => {
  const st = store({ 'claude_shadow_plans/pl__2026-09-28__a': earlierResult() });
  const d = deps(st);
  const SCOTT_DRIVER = { kind: 'driver', route: 'SCOTT 2', driver: 'Scott Hart', cls: 'box_truck', loadNbr: null };
  const params = P({ picks: [SCOTT_DRIVER, SPARE], section: ['U3'], after: 'pl__2026-09-28__a' });
  const pv = await planPreview(params, RS, d);
  assert.equal(pv.status, 200);
  assert.match(pv.body.infeasible, /Scott Hart already has 1 stop from the earlier section on SCOTT, which is not picked here — pick SCOTT again/);
  const q = await enqueuePlan(params, 'disp', d);
  assert.equal(q.status, 422);
  assert.match(q.body.error, /booked on two trucks across the sections/);
  const ok = await planPreview(P({ picks: [SCOTT, SPARE], section: ['U3'], after: 'pl__2026-09-28__a' }), RS, d);
  assert.equal(ok.body.infeasible, null, 'picking SCOTT again keeps U1 on it and shares his day: nothing to refuse');
});

test('a plan with nothing for Claude to place is refused — a section, a plan built on one, and a plain plan whose every stop is already on its truck', async () => {
  const st = store({ 'claude_shadow_plans/pl__2026-09-28__a': earlierResult({ placements: ['U1', 'U2', 'U3', 'U4', 'U5'].map((n) => ({ n, load: 'L2' })) }) });
  const d = deps(st);
  const after = await planPreview(P({ after: 'pl__2026-09-28__a' }), RS, d);
  assert.match(after.body.nothingToPlace, /already placed by the earlier sections/);
  assert.equal((await enqueuePlan(P({ after: 'pl__2026-09-28__a' }), 'disp', d)).status, 422);
  const onlyKept = board([stop('K1', 34.3, -83.8, { isPlanned: true, routeName: 'SCOTT', loadNbr: 'SCOTT' })]);
  const d2 = deps(store(), { board: onlyKept });
  const plain = await planPreview(P(), RS, d2);
  assert.match(plain.body.nothingToPlace, /already on the picked loads in NuVizz/);
  assert.equal((await enqueuePlan(P(), 'disp', d2)).status, 422, 'Claude would decide nothing: not paid for');
});

test('a section keeps the choice and at least the look-back of the plan it builds on — a shorter one would read its carried-over orders as gone', async () => {
  const st = store({ 'claude_shadow_plans/pl__2026-09-28__a': earlierResult({ params: { date: D, lookbackDays: 3, scope: 'unplanned' } }) });
  const d = deps(st);
  await assert.rejects(readPlanDay(validatePlanParams(P({ after: 'pl__2026-09-28__a', lookbackDays: 1 })).params, RS, d), /looked back 3 days; this section must look back at least as far/);
  await assert.rejects(readPlanDay(validatePlanParams(P({ after: 'pl__2026-09-28__a', lookbackDays: 3, scope: 'open' })).params, RS, d), /keeps the same choice/);
  const map = await planStops({ date: D, lookbackDays: 0, scope: 'unplanned', after: 'pl__2026-09-28__a' }, d);
  assert.equal(map.status, 422, 'the stop map says so too');
  await readPlanDay(validatePlanParams(P({ after: 'pl__2026-09-28__a', lookbackDays: 5 })).params, RS, d);
});

test('an earlier stop that has lost its map point stays in the chain: carried forward, counted, and its room held back on a truck picked again', async () => {
  const rows = DAY().map((r) => (r.stopNbr === 'U1' ? { ...r, lat: null, lng: null } : r));
  const st = store({ 'claude_shadow_plans/pl__2026-09-28__a': earlierResult() });
  const d = deps(st, { board: board(rows) });
  const { problem } = await readPlanDay(validatePlanParams(P({ section: ['U3'], after: 'pl__2026-09-28__a' })).params, RS, d);
  assert.equal(problem.counts.earlierNoLocation, 1);
  assert.equal(problem.counts.earlierDropped, 0, 'not dropped: it has not left its truck');
  assert.ok(problem.section.carried.some((c) => c.n === 'U1' && c.route === 'SCOTT'), 'carried, so the next section still has it');
  const scott = problem.loads.find((l) => l.route === 'SCOTT');
  assert.match(scott.capNote, /held back for 1 stop on it with no location/);
});

test('a roster load renamed in NuVizz since the earlier section is planned under its name now, so its NuVizz stops are still kept on it', async () => {
  const st = store({ [`nuvizz_load_roster/davis__${D}`]: { loadsJson: JSON.stringify([{ loadNbr: 'DAVIS000204626', name: 'SCOTT NORTH', driver: 'Scott Hart', status: 'Draft' }]) } });
  const rows = DAY().map((r) => (r.stopNbr === 'K1' ? { ...r, routeName: 'SCOTT NORTH', loadNbr: 'SCOTT NORTH' } : r));
  const { problem } = await readPlanDay(validatePlanParams(P({ picks: [SCOTT, SPARE] })).params, RS, deps(st, { board: board(rows) }));
  assert.equal(problem.counts.kept, 1, 'K1 rides SCOTT NORTH, the load picked as SCOTT');
  assert.equal(problem.loads[0].route, 'SCOTT NORTH');
});

test('the left-off record runs through the chain, the stop map says why a free stop was left off, and a stop now on a NuVizz load is drawn as NuVizz’s', async () => {
  const r1 = earlierResult({ section: { carried: [], leftOff: [{ n: 'U4', reason: 'no truck had room' }] }, placements: [{ n: 'U1', load: 'L1' }, { n: 'U2', load: 'L2' }, { n: 'K1', load: 'L2' }] });
  assert.deepEqual([...leftOffOf(r1)], [['U4', 'no truck had room']]);
  assert.deepEqual([...leftOffOf({ unplanned: [{ n: 'X9', reason: 'too heavy' }] })], [['X9', 'too heavy']], 'a result from before the chain kept the list gives its own');
  const st = store({ 'claude_shadow_plans/pl__2026-09-28__a': r1 });
  const map = await planStops({ date: D, lookbackDays: 0, scope: 'unplanned', after: 'pl__2026-09-28__a' }, deps(st));
  const at = (n) => map.body.stops.find((s) => s.n === n);
  assert.equal(at('U4').leftOff, 'no truck had room');
  assert.equal(at('K1').earlier, null, 'K1 is on SCOTT in NuVizz now: NuVizz’s, not the earlier section’s');
  assert.equal(at('K1').onLoad, 'SCOTT');
  assert.deepEqual(at('U1').earlier, { route: 'SCOTT', driver: 'Scott Hart' });
  const { problem } = await readPlanDay(validatePlanParams(P({ section: ['U3'], after: 'pl__2026-09-28__a' })).params, RS, deps(st));
  assert.deepEqual(problem.section.leftOff, [{ n: 'U4', reason: 'no truck had room' }], 'U4 is not in this section: its reason is kept on the record');
});

test('an earlier section’s stops that no longer fit their truck are refused with the way out that works; Claude is not told the dispatcher accepted anything', async () => {
  const st = store({ 'claude_shadow_plans/pl__2026-09-28__a': earlierResult({ placements: ['U1', 'U2', 'U3', 'U4', 'U5'].map((n) => ({ n, load: 'L2' })) }) });
  const heavy = board(DAY().map((r) => (/^U/.test(r.stopNbr) ? { ...r, weight: 4000 } : r)));
  const pv = await planPreview(P({ after: 'pl__2026-09-28__a', picks: [SCOTT, SPARE, SPARE2] }), RS, deps(st, { board: heavy }));
  assert.match(pv.body.infeasible, /from the earlier section, past its .* lb limit/);
  assert.match(pv.body.infeasible, /press Start fresh, or unpick that load/);
  assert.doesNotMatch(pv.body.infeasible, /plan every open stop instead/);
  assert.doesNotMatch(PLAN_SYSTEM, /accepted/);
});
