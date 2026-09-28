// test/claude-shadow-overtime-no-driver.test.mjs — WHAT CLAUDE IS TOLD WHEN AN UNNAMED TRUCK RUNS PAST ITS DAY.
//
// A plan onto spare box trucks with no driver yet names every one of them "(no driver)". Each is its
// OWN day (measurePlan keys a driverless load by its id), so each one that runs long must be named to
// the model on its own. Keyed by the display name, all of them read as one shared day and only the
// first offender was ever mentioned — the model revised against feedback that was false, and paid
// rounds went on it (audit 2026-09-27, shadow-backend-6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssignment, makeSequencer } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';

const cfg = effectiveEngineConfig(null, {});
const S = (id, lat, lng) => ({ id, n: `S${id}`, lat, lng, zone: 'Z', skids: 1, loose: 0, spots: 1, weight: 100, zip: null, city: null, name: null, k: null, blocksTractor: false });
const L = (id, driver = '(no driver)') => ({ id, route: `SPARE ${id}`, driver, cls: 'box_truck', clsSource: 'pin', cap: 22, capSource: 'x', capNote: null, dispatch: [], orderSource: 'driven', maxMin: 60, maxMinNote: null, maxLbs: 10000 });
const problem = (loads) => ({
  date: '2026-09-28', mode: 'plan', loosePerSkid: 10, capRule: 'tighter', lbsLimits: { box_truck: 10000, tractor: 30000 }, capMode: 'hard',
  ceilings: { box_truck: 22, tractor: 37 }, capsHeld: {}, dispatchOver: { cap: 0, lbs: 0 }, depot: { lat: 34.1, lng: -84.0 }, serviceMin: 15, shiftMin: 60,
  loads,
  // L1 and L2 each get two far stops (well past a 60-minute day); L3 one stop by the terminal.
  stops: [S(1, 34.9, -83.1), S(2, 34.95, -83.0), S(3, 33.2, -84.9), S(4, 33.1, -85.0), S(5, 34.11, -84.01)],
  excluded: { noCoords: [], duplicate: [] }, counts: {}, roster: 'read', stampGate: 'applied', capModel: { days: 0 }, approximations: [],
});
const ASSIGN = { loads: [{ load: 'L1', stops: [1, 2] }, { load: 'L2', stops: [3, 4] }, { load: 'L3', stops: [5] }], unplanned: [] };

test('two unnamed spare trucks each past their own day are each named to Claude, and none is told it shares a day with the others', () => {
  const p = problem([L('L1'), L('L2'), L('L3')]);
  const ev = evaluateAssignment(p, ASSIGN, cfg, makeSequencer(p, cfg));
  const day = Object.fromEntries(ev.summary.loads.map((l) => [l[0], [l[9], l[10]]]));
  assert.ok(day.L1[0] > 60 && day.L2[0] > 60 && day.L3[0] <= 60, `the case needs L1 and L2 over, L3 inside: ${JSON.stringify(day)}`);
  const overtime = ev.summary.hardViolations.filter((v) => /past their/.test(v));
  assert.equal(ev.ok, false);
  assert.equal(overtime.length, 2, `one message per truck that runs long: ${JSON.stringify(overtime)}`);
  assert.ok(overtime.some((v) => new RegExp(`would work ${day.L1[0]} min on L1 \\(`).test(v)), `L1 is named with its own minutes: ${JSON.stringify(overtime)}`);
  assert.ok(overtime.some((v) => new RegExp(`would work ${day.L2[0]} min on L2 \\(`).test(v)), `L2 is named with its own minutes: ${JSON.stringify(overtime)}`);
  assert.ok(!overtime.some((v) => /L1 \+|L2 \+|\+ L3/.test(v)), `no unnamed truck is said to share a day: ${JSON.stringify(overtime)}`);
});

test('a NAMED driver on two loads is still told once, with both loads, against one day', () => {
  const p = problem([L('L1', 'Ann Lee'), L('L2', 'Ann Lee'), L('L3')]);
  const ev = evaluateAssignment(p, ASSIGN, cfg, makeSequencer(p, cfg));
  const overtime = ev.summary.hardViolations.filter((v) => /past their/.test(v));
  assert.equal(overtime.length, 1, JSON.stringify(overtime));
  assert.match(overtime[0], /^Ann Lee would work \d+ min on L1 \+ L2 \(/);
});
