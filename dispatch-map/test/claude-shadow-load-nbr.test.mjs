// test/claude-shadow-load-nbr.test.mjs
//
// THE CLAUDE SHADOW KNOWS WHICH LOAD, BY NUMBER (v1.82.0). The scan now writes onto every routed board
// row the roster load number that holds it (rosterLoadNbr, lib/route-load-day.mts). The shadow used to
// tie a board row to a picked load by ROUTE NAME only — "a board row names its load by route only" — so
// two MARCUS loads could not be told apart, and a row on Friday's MARCUS could be kept on Monday's pick.
// Chad: "I want every part of app to know and use the proper load numbers for the correct day."

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPlanStops, rowRouteKey, rowLoadNbrKey } from '../netlify/functions/lib/claude-shadow/plan-core.mts';
import { btBriefing, BT_SYSTEM, PLAN_SYSTEM } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';

const MON = '2026-09-28';
const row = (nbr, route, extra = {}) => ({ stopNbr: nbr, routeName: route, loadNbr: route, isPlanned: true, isUnplanned: false, normalizedStatus: 'SCHEDULED', status: '20', lat: 33.6, lng: -84.6, stopType: 'DO', ...extra });
const marcusKey = rowRouteKey({ routeName: 'MARCUS' });

test('a row the scan tied to Monday\'s MARCUS by number is kept on the MARCUS pick; one on another MARCUS is not', () => {
  const keepOn = new Set([marcusKey, 'nbr:DAVIS000204645']);
  const rows = [
    row('007182304-1', 'MARCUS', { rosterLoadNbr: 'DAVIS000204645' }),
    row('007182999', 'MARCUS', { rosterLoadNbr: 'DAVIS000204535' }),   // Friday's MARCUS — not the picked load
  ];
  const sel = selectPlanStops(rows, MON, 'unplanned', 0, keepOn);
  assert.equal(sel.kept.get('007182304-1'), 'nbr:DAVIS000204645');
  assert.equal(sel.kept.has('007182999'), false);
  assert.equal(sel.counts.planned, 1, 'on another load: not ours to plan, not ours to keep');
});

test('two loads named ESTES on the day are no longer a guess for a row that carries its load number', () => {
  const estes = rowRouteKey({ routeName: 'ESTES' });
  const keepOn = new Set([estes, 'nbr:DAVIS000300002']);
  const sel = selectPlanStops([row('e1', 'ESTES', { rosterLoadNbr: 'DAVIS000300002' }), row('e2', 'ESTES')], MON, 'unplanned', 0, keepOn, undefined, new Set([estes]));
  assert.equal(sel.kept.get('e1'), 'nbr:DAVIS000300002');
  assert.equal(sel.counts.ambiguous, 1, 'the row with no number is still refused, exactly as before');
});

test('with no load numbers anywhere, the name rule is exactly what it was', () => {
  const sel = selectPlanStops([row('m1', 'MARCUS')], MON, 'unplanned', 0, new Set([marcusKey]));
  assert.equal(sel.kept.get('m1'), marcusKey);
  assert.equal(rowLoadNbrKey(row('m1', 'MARCUS')), null);
  assert.equal(rowLoadNbrKey(row('m1', 'MARCUS', { rosterLoadNbr: ' DAVIS1 ' })), 'nbr:DAVIS1');
});

const problem = (loads) => ({
  date: MON, depot: { lat: 34.1, lng: -83.9 }, loosePerSkid: 4, serviceMin: 20,
  loads: loads.map((l, i) => ({ id: `L${i + 1}`, route: l.route, driver: l.driver || 'D', cls: 'box_truck', cap: 12, maxMin: 600, maxLbs: 10000, ...(l.loadNbr ? { loadNbr: l.loadNbr } : {}) })),
  stops: [],
});

test('the plan briefing names each roster load\'s NuVizz number; a backtest briefing is byte-for-byte unchanged', () => {
  const plan = btBriefing(problem([{ route: 'MARCUS', loadNbr: 'DAVIS000204645' }, { route: 'TRUCK' }]));
  assert.match(plan, /LOADS: id \| route name \| driver \| truck \| cap \(skid spots\) \| max lbs \| driver day limit \(min\) \| NuVizz load number/);
  assert.match(plan, /L1 \| MARCUS \| D \| box truck \| 12 \| 10000 \| 600 \| DAVIS000204645/);
  assert.match(plan, /L2 \| TRUCK \| D \| box truck \| 12 \| 10000 \| 600 \| —/);
  const bt = btBriefing(problem([{ route: 'MARCUS' }]));
  assert.ok(!/NuVizz load number/.test(bt));
  assert.match(bt, /L1 \| MARCUS \| D \| box truck \| 12 \| 10000 \| 600$/m);
});

test('the planner is told what a load number means; the backtest prompt is untouched', () => {
  assert.match(PLAN_SYSTEM, /A load with a NuVizz load number is that exact load in NuVizz on this day — the number comes from the day’s load roster; a route name repeats every day and never identifies a load by itself\./);
  assert.ok(!/NuVizz load number/.test(BT_SYSTEM));
});
