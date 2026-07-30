// test/cancel-guard.test.mjs — the "this will CANCEL the route" Save gate.
//
// Emptying a load is the only Compare edit that DESTROYS something: NuVizz cancels the route,
// the load stops existing, its orders return to Un-Planned, and this app has no undo. Until now
// that was announced by the same non-blocking toast used for "N stops not loaded yet", fired at
// the moment the write left (Chad, Jul 30: "before you are allowed to cancel the entire route i
// want a warning to pop up that this will delete a route").
//
// Imports the SAME functions App.jsx ships (no copy), so these prove the real gate. The pins that
// matter are the two directions: the gate FIRES on every shape of an emptied load, and it NEVER
// fires on an ordinary Save — an accidental widening would put a popup in front of every reorder,
// which is exactly the thing that was deliberately removed from this panel.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cancelsIn, cancelSummary } from '../src/lib/cancel-guard.js';

// The payload builder's shapes (buildBoardPayload in App.jsx).
const emptied = (routeName, orders, extra = {}) => ({
  __key: routeName, routeName, loadNbr: 'DAVIS000000123', loadId: '6a438e9d52ef82bd1ed4516b',
  emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: orders, ...extra,
});
const reordered = (routeName, order) => ({
  __key: routeName, routeName, loadNbr: 'DAVIS000000123', loadId: '6a438e9d52ef82bd1ed4516b',
  orderedStopNbrs: order, orderedStopIds: order.map((n) => `id-${n}`),
});

test('the gate FIRES on an emptied load and reports what it destroys', () => {
  // The Jul 30 TRAILER 6 save: six orders struck off, the card's order list empty.
  const loads = [emptied('TRAILER 6', ['THG', 'HAEWA', 'ROSSINI', 'TELECONNECT', 'DMS', 'SIXTH'])];
  const cancels = cancelsIn(loads);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].routeName, 'TRAILER 6');
  assert.equal(cancels[0].orderCount, 6, 'the dispatcher is told how many orders come back');
  assert.equal(cancels[0].loadNbr, 'DAVIS000000123');
});

test('the gate NEVER fires on an ordinary Save — reorder, unplan-some, driver-only, dispatch', () => {
  // Each of these commits with NO popup, exactly as before. A widening here would re-introduce
  // the per-save confirmation this panel deliberately dropped.
  const ordinary = [
    reordered('SUW 2', ['A', 'B', 'C']),                                     // pure reorder
    { routeName: 'SUW 3', loadNbr: 'DAVIS000000456', orderedStopNbrs: ['A'], removeStopNbrs: ['B', 'C'] },  // unplan SOME
    { routeName: 'SUW 4', loadNbr: 'DAVIS000000789', driverId: 'drv-1', driverName: 'Leroy Smith' },        // driver only
    { routeName: 'SUW 5', loadNbr: 'DAVIS000000012', dispatch: true },                                      // dispatch only
    { routeName: 'SUW 6', loadNbr: 'DAVIS000000345', removeStopNbrs: [] },                                  // nothing removed
  ];
  assert.deepEqual(cancelsIn(ordinary), [], 'no ordinary save is ever gated');
  // An empty order list ALONE is not the signal — the builder sets emptyLoad explicitly, and a
  // card whose reorder was dropped (unenriched stops) also carries no orderedStopNbrs.
  assert.deepEqual(cancelsIn([{ routeName: 'SUW 7', loadNbr: 'DAVIS000000678', orderedStopNbrs: [] }]), [],
    'only the explicit emptyLoad flag qualifies — never an inferred-empty payload');
  assert.deepEqual(cancelsIn([{ routeName: 'X', emptyLoad: 'yes' }]), [], 'truthy-but-not-true never qualifies');
});

test('a mixed Save gates on ONLY the cancelling load — the rest still ride along', () => {
  const loads = [reordered('SUW 2', ['A', 'B']), emptied('TRAILER 6', ['C', 'D']), reordered('SUW 3', ['E'])];
  const cancels = cancelsIn(loads);
  assert.equal(cancels.length, 1, 'one route dies, two are ordinary saves');
  assert.equal(cancels[0].routeName, 'TRAILER 6');
  // The modal reports the difference so "Cancel the route" can't read as "discard everything".
  assert.equal(loads.length - cancels.length, 2);
});

test('cancelSummary says DELETE, names the routes, counts the orders, and admits there is no undo', () => {
  const one = cancelSummary(cancelsIn([emptied('TRAILER 6', ['A', 'B', 'C', 'D', 'E', 'F'])]));
  assert.match(one, /DELETES the route TRAILER 6 in NuVizz/);
  assert.match(one, /6 orders go back to Un-Planned/);
  assert.match(one, /cannot be undone/i);

  // Singular grammar is not an afterthought — the last-order case is exactly the one v0.54.17
  // opened, so it is the likeliest thing a dispatcher reads.
  const single = cancelSummary(cancelsIn([emptied('SUW 2', ['ONLY'])]));
  assert.match(single, /DELETES the route SUW 2/);
  assert.match(single, /1 order goes back to Un-Planned/);

  // Two and three routes read as English, not as a joined array.
  const two = cancelSummary(cancelsIn([emptied('TRAILER 6', ['A']), emptied('SUW 2', ['B', 'C'])]));
  assert.match(two, /DELETES routes TRAILER 6 and SUW 2/);
  assert.match(two, /3 orders go back/);
  const three = cancelSummary(cancelsIn([emptied('A1', ['a']), emptied('B2', ['b']), emptied('C3', ['c'])]));
  assert.match(three, /DELETES routes A1, B2 and C3/);

  assert.equal(cancelSummary([]), '', 'no cancels → no sentence to show');
});

test('cancelSummary never shows a hex id as a route name (nameOf is the app\'s loadDisplayName)', () => {
  // A Loads-grid card's "name" is its 24-hex loadId; App passes loadDisplayName, which refuses a
  // hash-like token — the same guard that keeps a hex out of the board's routeName (audit C5).
  const HEX = '6b449e9d52ef82bd1ed4516c';
  const cancels = cancelsIn([emptied(HEX, ['A', 'B'])]);
  const text = cancelSummary(cancels, (c) => (/^[0-9a-f]{24}$/i.test(String(c.routeName)) ? '' : c.routeName) || 'this load');
  assert.ok(!text.includes(HEX), 'a hex id never reaches the dispatcher as a route name');
  assert.match(text, /DELETES the route this load in NuVizz/);
});

test('gate input is defensive — a missing/odd payload never throws in front of a Save', () => {
  assert.deepEqual(cancelsIn(undefined), []);
  assert.deepEqual(cancelsIn(null), []);
  assert.deepEqual(cancelsIn([]), []);
  assert.deepEqual(cancelsIn([null, undefined]), []);
  // emptyLoad with no removeStopNbrs (a card emptied without a tracked removal list) still gates —
  // the count is simply unknown, and the modal drops the parenthetical rather than claiming zero.
  const odd = cancelsIn([{ emptyLoad: true, routeName: 'ODD' }]);
  assert.equal(odd.length, 1);
  assert.equal(odd[0].orderCount, 0);
  assert.match(cancelSummary(odd), /DELETES the route ODD/);
});
