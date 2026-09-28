// test/claude-shadow-partners-shown.test.mjs — "HIDE THE N TRUCKS IT TRADED WITH" ONLY WHEN THEY ARE ON THE MAP.
//
// Audit 2026-09-27 (shadow-frontend-4): route L1 traded with L5, L4 and L6. In the drawer, the
// dispatcher taps a stop Claude moved to L4 and presses "Show both trucks". Only L1 and L4 are in
// colour, but the header flipped to "Hide the 3 trucks it traded with" — "partners shown" was worked
// out as "more than one truck coloured", so L5 and L6 read as on the map when they were not, and the
// button that would draw them was gone. Now it is "every trade partner the Show button colours is
// coloured".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { focusPicks, partnersShownIn, MAX_SELECTED } from '../src/shadow/backtest-map-core.js';

const cmp = (id, partners) => ({ load: { id }, partners: partners.map((loadId) => ({ loadId, route: loadId })) });
const L1 = cmp('L1', ['L5', 'L4', 'L6']);

test('"Show both trucks" on a stop Claude moved to L4 colours L1 and L4 only: the header still offers to show the 3 trucks L1 traded with', () => {
  const sel = new Map([['L1', 0], ['L4', 1]]);
  assert.equal(partnersShownIn(L1, sel), false);
});

test('after "Show the 3 trucks Claude traded with", all three are coloured and the header offers to hide them', () => {
  assert.equal(partnersShownIn(L1, focusPicks(L1).next), true);
  const plusOne = new Map([...focusPicks(L1).next, ['L9', 4]]);
  assert.equal(partnersShownIn(L1, plusOne), true, 'a truck coloured from the table on top of them does not hide them');
  const oneOff = new Map(focusPicks(L1).next); oneOff.delete('L6');
  assert.equal(partnersShownIn(L1, oneOff), false, 'one partner un-coloured: Show is offered again');
});

test('a route with more partners than colours counts as shown once every partner that can be coloured is', () => {
  const many = cmp('L1', Array.from({ length: MAX_SELECTED + 2 }, (_, i) => `P${i}`));
  const f = focusPicks(many);
  assert.ok(f.left > 0);
  assert.equal(partnersShownIn(many, f.next), true);
});

test('nothing open, or a route that traded with nobody, never reads as partners shown', () => {
  assert.equal(partnersShownIn(null, new Map([['L1', 0], ['L2', 1]])), false);
  assert.equal(partnersShownIn(cmp('L2', []), new Map([['L2', 0], ['L3', 1]])), false);
});

test('the page map and the drawer map both use the rule', () => {
  const src = readFileSync(new URL('../src/shadow/BacktestPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /const drawerPartnersShown = partnersShownIn\(dcmp, drawerSel\);/);
  assert.match(src, /const partnersShown = partnersShownIn\(cmp, sel\);/);
  assert.doesNotMatch(src, /Sel\.size > 1|sel\.size > 1/);
});
