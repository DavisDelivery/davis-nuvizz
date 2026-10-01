// test/build-trims-selection.test.mjs — after a Build puts its routes on Compare cards, the
// selection holds only the orders it left off.
//
// Chad, 2026-10-01, on a Build onto CRUMPTON and RASHEED: "all that should be left on the
// selection table is the orders it did not put on the route". The Build's staging never wrote
// the selection, so every order he gave it stayed selected after 19 of them were on the cards.
// The chip read "PUT ON CRUMPTON (23)" (all 28 skids, for a 14-skid box), and a Discard left all
// 23 highlighted until a refresh. The rule is pure (selectionAfterBuildStage); the screen runs it
// from one effect that writes only the selection. Both are pinned here, because a rule wired to
// nothing is this repo's recurring failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { selectionAfterBuildStage, houseSwitchOn } from '../src/lib/routing-select.js';

// His Build: 23 orders selected; the Build put 9 on CRUMPTON and 10 on RASHEED and left 4 off.
const LEFT_OFF = ['007184000', 'ESTES-0318330338', 'ESTES-0492779392', 'ESTES-1958108993'];
const CRUMPTON = Array.from({ length: 9 }, (_, i) => `C${i + 1}`);
const RASHEED = Array.from({ length: 10 }, (_, i) => `R${i + 1}`);
const ALL = [...CRUMPTON, ...RASHEED, ...LEFT_OFF];

/** One pass of the screen's effect: what the selection is after the rule runs. */
function afterEffect(selected, built, onCard, trimmed) {
  const { take } = selectionAfterBuildStage({ selected, built, onCard, trimmed });
  for (const id of take) trimmed.add(id);
  const n = new Set(selected);
  for (const id of take) n.delete(id);
  return n;
}

test('his CRUMPTON / RASHEED Build: once the routes are on the cards, only the 4 left off stay selected', () => {
  const selected = new Set(ALL);
  const onCard = new Set([...CRUMPTON, ...RASHEED]);
  const after = afterEffect(selected, [...CRUMPTON, ...RASHEED], onCard, new Set());
  assert.deepEqual([...after].sort(), [...LEFT_OFF].sort());
  assert.equal(after.size, 4, 'the chip reads PUT ON CRUMPTON (4), not (23)');
});

test('before the cards hold the routes, nothing is taken out (the selection is never emptied ahead of the stage)', () => {
  const selected = new Set(ALL);
  const { take } = selectionAfterBuildStage({ selected, built: [...CRUMPTON, ...RASHEED], onCard: new Set(), trimmed: new Set() });
  assert.deepEqual(take, []);
});

test('an order the Build routed but that is NOT on a card (workbench full, card closed) stays selected', () => {
  // RASHEED's card could not open: its 10 orders are held by nothing else, so they stay selected.
  const selected = new Set(ALL);
  const after = afterEffect(selected, [...CRUMPTON, ...RASHEED], new Set(CRUMPTON), new Set());
  assert.deepEqual([...after].sort(), [...RASHEED, ...LEFT_OFF].sort());
});

test('an order on a card that the Build did NOT route is never taken out by this rule', () => {
  // A dispatcher's own card already holds X1, and X1 is selected through the keep-selected Send flow.
  const selected = new Set([...ALL, 'X1']);
  const onCard = new Set([...CRUMPTON, ...RASHEED, 'X1']);
  const after = afterEffect(selected, [...CRUMPTON, ...RASHEED], onCard, new Set());
  assert.ok(after.has('X1'), 'X1 was not the Build’s, so the Build does not touch it');
});

test('an order selected again by hand after the trim stays selected (taken out once per plan)', () => {
  const trimmed = new Set();
  const onCard = new Set([...CRUMPTON, ...RASHEED]);
  let sel = afterEffect(new Set(ALL), [...CRUMPTON, ...RASHEED], onCard, trimmed);
  sel = new Set([...sel, 'C3']);                         // he selects C3 again
  sel = afterEffect(sel, [...CRUMPTON, ...RASHEED], onCard, trimmed);   // the effect runs again
  assert.ok(sel.has('C3'));
});

test('Discard: the selection is left as it is (only what was left off), so the routed orders do not come back highlighted', () => {
  // The effect returns early once the plan is gone; the selection it left is what Discard keeps.
  const trimmed = new Set();
  const sel = afterEffect(new Set(ALL), [...CRUMPTON, ...RASHEED], new Set([...CRUMPTON, ...RASHEED]), trimmed);
  const afterDiscardAndClose = afterEffect(sel, [], new Set(), trimmed);
  assert.deepEqual([...afterDiscardAndClose].sort(), [...LEFT_OFF].sort());
});

test('the empty, the absent and the malformed: no selection, no cards, numeric ids, duplicates', () => {
  assert.deepEqual(selectionAfterBuildStage({ selected: new Set(), built: ['1'], onCard: new Set(['1']) }).take, []);
  assert.deepEqual(selectionAfterBuildStage({ selected: null, built: ['1'], onCard: new Set(['1']) }).take, []);
  assert.deepEqual(selectionAfterBuildStage({ selected: new Set(['1']), built: null, onCard: new Set(['1']) }).take, []);
  assert.deepEqual(selectionAfterBuildStage({ selected: new Set(['1']), built: ['1'], onCard: null }).take, []);
  // routesView carries stop numbers; the selection and the cards carry strings.
  assert.deepEqual(selectionAfterBuildStage({ selected: new Set(['7']), built: [7, 7, '7'], onCard: new Set(['7']) }).take, ['7']);
});

// ── The wiring: the screen runs the rule, behind its switch, and writes ONLY the selection. ──
const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('the switch is house shape: on by default, an off-word turns it off, anything malformed leaves it on', () => {
  assert.ok(/const BUILD_TRIMS_SELECTION = \(\(\) => \{\n {2}try \{ return houseSwitchOn\(import\.meta\.env\.VITE_ROUTING_BUILD_TRIMS_SELECTION\); \} catch \{ return true; \}/.test(code));
  for (const v of [undefined, '', 'on', 'yes', 'ture', ' 1 ']) assert.equal(houseSwitchOn(v), true, String(v));
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' No ']) assert.equal(houseSwitchOn(v), false, v);
});

test('the effect runs the rule, writes only the selection, and never touches the cards or the staging', () => {
  assert.ok(/import \{[^}]*\bselectionAfterBuildStage\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code), 'selectionAfterBuildStage is not imported');
  const start = code.indexOf('const buildTrimRef = useRef(');
  assert.ok(start > 0, 'the effect is not in App.jsx');
  const body = code.slice(start, code.indexOf('}, [job?.id, job?.status, viewing, routesView, wbRoutes, selectedIds]);', start));
  assert.ok(body.length > 0 && body.length < 2000, 'the effect could not be isolated');
  assert.ok(/if \(!BUILD_TRIMS_SELECTION \|\| viewing \|\| job\?\.status !== 'done' \|\| !routesView\.length\) return;/.test(body), 'not gated on the switch, a finished plan and its routes');
  assert.ok(/selectionAfterBuildStage\(\{ selected: selectedIds, built: routesView\.flatMap\(\(rv\) => rv\.order\), onCard, trimmed: buildTrimRef\.current\.ids \}\)/.test(body));
  assert.ok(/setSelectedIds\(/.test(body), 'it does not write the selection');
  for (const frozen of ['setWbRoutes', 'stagePlanOntoLoads', 'wbStagedRef', 'seedStagedCard', 'effectiveRouteInfo', 'setJob', 'setRouteState']) {
    assert.ok(!body.includes(frozen), `the effect names ${frozen}`);
  }
  // It sits after the auto-stage, so on the render the cards appear it can already see them.
  assert.ok(start > code.indexOf('const autoStagedJobRef = useRef(null);'));
});

test('Discard still says the selection is kept, and neither discard handler was changed to put orders back', () => {
  assert.ok(code.includes("setLastAction('Discarded plan — selection kept');"));
  const discard = code.slice(code.indexOf('const discardPlan = useCallback('), code.indexOf('const discardPlanAndCloseCards = useCallback('));
  assert.ok(!/setSelectedIds/.test(discard));
});
