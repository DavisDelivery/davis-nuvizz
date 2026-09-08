// Dispatch all must stay WIRED, and stay behind its gates.
//
// The rule is executed in dispatch-all.test.mjs. These pin the connections in App.jsx, where
// every failure is a production write: a button that skips the confirm, a bulk run that fires
// in Beta, or a second copy of the eligibility rule that disagrees with the count on the label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the button and the confirm read ONE planner', () => {
  assert.ok(/const dispatchAllPlanner = useCallback\(\s*\n?\s*\(visibleGroups\) => planDispatchAll\(/.test(src),
    'the panel must be handed the same planner the action runs.');
  assert.ok(/dispatchAllPlanner\(filtered\)\.eligible\.length/.test(src),
    'the count on the label must come from that planner, not a second filter.');
});

test('it acts on the FILTERED list — what you see is what it sends', () => {
  assert.ok(/onClick=\{\(\) => onDispatchAll\(filtered\)\}/.test(src),
    'passing the unfiltered groups would dispatch routes the panel is not showing.');
});

test('nothing fires without the confirm', () => {
  // openDispatchAll only ever sets the plan; runDispatchAll is reachable only from the modal.
  assert.ok(/setDispatchAllPlan\(\{\s*\n\s*eligible,/.test(src),
    'the button must open a plan, never write.');
  assert.ok(/onConfirm=\{runDispatchAll\}/.test(src),
    'the write must hang off the confirm modal.');
});

test('the confirm lists every load and its driver, and every route it will NOT send', () => {
  assert.ok(/plan: dispatchPlanLines\(eligible, driverForRoute\)/.test(src),
    'a count cannot be checked — the loads must be named.');
  assert.ok(/warnings: skipped\.map\(\(x\) => `\$\{x\.name\} will NOT be dispatched — \$\{x\.reason\}`\)/.test(src),
    'skipped routes must be visible AT THE MOMENT of deciding, not afterwards.');
});

test('Beta sends nothing, and the role gate comes first', () => {
  assert.ok(/if \(!assignLive\) \{\s*\n\s*setDispatchAllPlan\(null\);/.test(src),
    'a Beta confirm must preview and stop.');
  assert.ok(/const openDispatchAll = useCallback\(\(visibleGroups\) => \{\s*\n\s*if \(!writeGate\.allowed\)/.test(src),
    'the dispatcher-role gate must be the first thing the bulk action checks.');
});

test('the bulk run fires the SAME write as the single button', () => {
  assert.ok(/results\.push\(await dispatchOneLoad\(g\)\)/.test(src),
    'both paths must go through dispatchOneLoad — two write paths is two behaviours.');
  assert.ok(/const res = await dispatchOneLoad\(g\);/.test(src),
    'the row button must use it too.');
});

test('the run is sequential — twenty concurrent production writes is not a saving', () => {
  assert.ok(/for \(const g of plan\.eligible\) \{/.test(src),
    'a Promise.all here turns a rate limit into a partial run nobody can read.');
});

test('the outcome is reported honestly, failures named', () => {
  assert.ok(/showMapToast\(dispatchAllSummary\(results\)\)/.test(src));
  assert.ok(/console\.log\('\[dispatch-all\]', results\)/.test(src),
    'the per-route detail must survive the toast for forensics.');
});

test('the button is hidden when live dispatch is off or there is nothing to send', () => {
  assert.ok(/onDispatchAll=\{liveWrite \? openDispatchAll : null\}/.test(src));
  assert.ok(/\{onDispatchAll && dispatchAllCount > 0 && \(/.test(src),
    'a dead "Dispatch all (0)" is indistinguishable from a broken one.');
});
