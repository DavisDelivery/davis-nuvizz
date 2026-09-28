// test/claude-shadow-bt-room-check.test.mjs — A BACKTEST MAY NOT DROP A BOX-ONLY STOP BESIDE A BOX TRUCK WITH ROOM.
//
// A backtest lets Claude leave off exactly one kind of stop: a no-tractor stop dispatch ran on a
// tractor, because no box truck may have room for it. The briefing says so — "the ONLY stop that may
// be listed unplanned instead is a no-tractor stop no box-truck load has room for … and the evaluator
// refuses any other" — but the evaluator never checked the room. So Claude could drop the stop beside
// a half-empty box truck and the scorecard credited it with the miles of a delivery it simply did not
// make (audit 2026-09-27, shadow-backend-5: 109.1 mi driven vs 24.5 mi "planned", -77.5%).
// SHADOW_BT_ROOM_CHECK=off puts the old rule back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssignment, makeSequencer, btLoopProblem, compareBacktest } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { btRoomCheckEnabled } from '../netlify/functions/lib/claude-shadow/config.mts';
import { enqueueBacktests, workerTick, backtestView, resultPath } from '../netlify/functions/lib/claude-shadow/backtest.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';

const cfg = effectiveEngineConfig(null, {});
const S = (id, lat, lng, o = {}) => ({ id, n: `S${id}`, lat, lng, zone: 'Z', skids: 2, loose: 0, spots: 2, weight: 500, zip: null, city: null, name: null, k: null, blocksTractor: false, ...o });
// L1: a TRACTOR dispatch ran with stop 3 (a no-tractor stop) on it; L2: a box truck of cap `boxCap` carrying stop 2.
const day = (boxCap = 22) => ({
  date: '2026-09-23', loosePerSkid: 10, capRule: 'tighter', mode: 'backtest', lbsLimits: { box_truck: 10000, tractor: 30000 }, capMode: 'hard',
  ceilings: { box_truck: 22, tractor: 37 }, capsHeld: {}, dispatchOver: { cap: 0, lbs: 0 }, depot: { lat: 34.1, lng: -84.0 }, serviceMin: 15, shiftMin: 600,
  loads: [
    { id: 'L1', route: 'T', driver: 'Tom', cls: 'tractor', clsSource: 'roster', cap: 28, capSource: 'x', capNote: null, dispatch: [1, 3], orderSource: 'driven', maxMin: 600, maxMinNote: null, maxLbs: 30000 },
    { id: 'L2', route: 'B', driver: 'Bob', cls: 'box_truck', clsSource: 'roster', cap: boxCap, capSource: 'x', capNote: null, dispatch: [2], orderSource: 'driven', maxMin: 600, maxMinNote: null, maxLbs: 10000 },
  ],
  stops: [S(1, 34.2, -83.9), S(2, 34.21, -83.91), S(3, 34.9, -83.2, { blocksTractor: true })],
  excluded: { noCoords: [], duplicate: [] }, counts: {}, roster: 'read', stampGate: 'applied', capModel: { days: 0, first: null, last: null }, approximations: [],
});
const DROP = { loads: [{ load: 'L1', stops: [1] }, { load: 'L2', stops: [2] }], unplanned: [{ stop: 3, reason: 'no box truck has room' }] };

test('a backtest refuses to let Claude drop a box-only stop that rode a tractor while a box truck has room for it — the drop never reads as a mileage saving', () => {
  const p = day(22);
  const ev = evaluateAssignment(p, DROP, cfg, makeSequencer(p, cfg));
  assert.equal(ev.ok, false, 'L2 has 20 spots free: the stop must ride it');
  assert.match(ev.summary.hardViolations.join(' | '), /stop 3 is left unplanned but L2 has room for it/);
  // Only a CLEAN plan is ever scored, so the headline cannot be built on the drop.
  const onBox = evaluateAssignment(p, { loads: [{ load: 'L1', stops: [1] }, { load: 'L2', stops: [2, 3] }], unplanned: [] }, cfg, makeSequencer(p, cfg));
  assert.equal(onBox.ok, true, JSON.stringify(onBox.summary.hardViolations));
  const cmp = compareBacktest(p, onBox.plan, cfg, { perMile: null, perDriveHour: null });
  assert.equal(cmp.columns.claude.unplanned, 0);
  assert.equal(cmp.columns.claude.stops, cmp.columns.driven.stops, 'both columns carry every delivery');
});

test('a box-only stop that rode a tractor may still be left off, with its reason, when no box truck has room for it', () => {
  const p = day(2);   // the box truck is full with stop 2's two spots
  const ev = evaluateAssignment(p, DROP, cfg, makeSequencer(p, cfg));
  assert.equal(ev.ok, true, JSON.stringify(ev.summary.hardViolations));
  const silent = evaluateAssignment(p, { ...DROP, unplanned: [{ stop: 3, reason: ' ' }] }, cfg, makeSequencer(p, cfg));
  assert.match(silent.summary.hardViolations.join(' '), /stop 3 is unplanned with no reason/);
});

test('an ordinary delivered stop left off is refused once, as before — not twice over for room', () => {
  const p = day(22);
  const ev = evaluateAssignment(p, { loads: [{ load: 'L1', stops: [3] }, { load: 'L2', stops: [] }], unplanned: [{ stop: 1, reason: 'far' }, { stop: 2, reason: 'far' }] }, cfg, makeSequencer(p, cfg));
  const aboutOne = ev.summary.hardViolations.filter((v) => /\bstop 1\b/.test(v));
  assert.deepEqual(aboutOne, ['stop 1 must be on a load: it was delivered this day and a load can legally carry it']);
});

test('SHADOW_BT_ROOM_CHECK: default on, an off-word puts the old rule back (the drop is accepted), a typo leaves it on', () => {
  assert.equal(btRoomCheckEnabled({}), true);
  for (const w of ['off', 'OFF', '0', 'false', 'no', ' no ']) assert.equal(btRoomCheckEnabled({ SHADOW_BT_ROOM_CHECK: w }), false, w);
  for (const w of ['on', '1', 'yes', 'of', 'nope', '']) assert.equal(btRoomCheckEnabled({ SHADOW_BT_ROOM_CHECK: w }), true, w);
  const p = day(22);
  assert.equal(btLoopProblem(p, cfg, { btRoomCheck: true }).evaluate(DROP).ok, false);
  assert.equal(btLoopProblem(p, cfg, { btRoomCheck: false }).evaluate(DROP).ok, true, 'off: accepted with any reason, as before');
});

// ── through the real queue and worker: the switch reaches the evaluator the model is answered by ─────
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
  const s = {
    [`history_days/davis__${D}`]: { complete: true, verified: true, captured_at: '2026-09-24T06:00:00Z' },
    'employees/e1': { vehicleType: 'tractor', fullName: 'Ann Lee' },
    'employees/e2': { vehicleType: 'box truck', fullName: 'Bob Ray' },
    // Ann's first customer takes box trucks only — and dispatch ran it on her tractor.
    'customer_notes/C1': { equipment_restrictions: ['box_truck_only'] },
  };
  const rows = [row('A', 'Ann Lee', 34.2, -83.9), row('A', 'Ann Lee', 34.0, -84.1), row('B', 'Bob Ray', 34.21, -83.91), row('B', 'Bob Ray', 34.01, -84.11)];
  for (const r of rows) s[`history_days/davis__${D}/stops/${r.stopNbr}`] = r;
  return s;
}
// The model reads the briefing it was sent: drop the no-tractor stop first, then put it on the box truck.
function briefed(req) {
  const text = req.messages[0].content[0].text.split('\n');
  const at = (h) => text.findIndex((l) => l.startsWith(h));
  const loads = text.slice(at('LOADS:') + 1).filter((l) => / \| /.test(l) && !l.startsWith('STOPS')).slice(0, 2).map((l) => l.split(' | '));
  const stops = text.slice(at('STOPS:') + 1).map((l) => l.split(' | '));
  const tractor = loads.find((l) => l[3].startsWith('tractor'))[0];
  const box = loads.find((l) => l[3] === 'box truck')[0];
  const x = Number(stops.find((s) => /no-tractor/.test(s[9] || ''))[0]);
  const rest = stops.map((s) => Number(s[0])).filter((id) => id !== x);
  return { tractor, box, x, rest };
}
function model() {
  const calls = [];
  const usage = { input_tokens: 2000, output_tokens: 1000 };
  return {
    calls,
    call: async (req) => {
      calls.push(req);
      const b = briefed(req);
      const input = calls.length === 1
        ? { loads: [{ load: b.tractor, stops: b.rest, why: 'a' }, { load: b.box, stops: [], why: 'b' }], unplanned: [{ stop: b.x, reason: 'no box truck has room' }], summary: 's' }
        : { loads: [{ load: b.tractor, stops: b.rest, why: 'a' }, { load: b.box, stops: [b.x], why: 'b' }], unplanned: [], summary: 's' };
      return { ok: true, httpStatus: 200, timedOut: false, ms: 5, error: null, body: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${calls.length}`, name: 'submit_plan', input }], usage } };
    },
  };
}
const worker = (env) => { const st = store(seedDay()); const m = model(); return { st, m, d: { ...st, call: m.call, now: () => new Date('2026-09-25T12:00:00Z'), env, firestoreOn: () => true } }; };

test('through the worker: the drop is refused and the box-only stop ends up on the box truck; SHADOW_BT_ROOM_CHECK=off takes the drop as before', async () => {
  const on = worker({ ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' });
  await enqueueBacktests([D], 'disp', on.d);
  assert.equal((await workerTick(on.d)).done, true);
  assert.equal(on.m.calls.length, 2, 'the drop was sent back, and the second submit placed the stop');
  assert.equal(on.st.docs.get(resultPath(D)).columns.claude.unplanned, 0);
  assert.equal((await backtestView(on.d)).btRoomCheck, true, 'the switch position is read back');

  const off = worker({ ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x', SHADOW_BT_ROOM_CHECK: 'off' });
  await enqueueBacktests([D], 'disp', off.d);
  assert.equal((await workerTick(off.d)).done, true);
  assert.equal(off.m.calls.length, 1, 'off: the drop was accepted on the first submit');
  assert.equal(off.st.docs.get(resultPath(D)).columns.claude.unplanned, 1);
  assert.equal((await backtestView(off.d)).btRoomCheck, false);
});
