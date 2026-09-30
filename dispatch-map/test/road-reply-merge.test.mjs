// A LATE ROAD REPLY LANDS ON THE CARD AS IT IS NOW (Chad, 2026-09-30: "I see bugs one through
// three, and those look like something I want to fix."). The road box's order comes back after a
// Google call, computed from the stops the card held at the pick. mergeReplyOrder is the whole of
// what the card does with it (App.jsx applyOrder), so these pin the rule on the function it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReplyOrder, roadReplyDropsMovedStopsEnabled } from '../src/lib/routing-select.js';

// The reply was computed for A B C D E; it puts them in the road order below.
const REPLY = ['C', 'A', 'E', 'B', 'D'];

test('a stop dragged to another card while the road reply was out stays on the other card', () => {
  // D went to another card during the Google call. The old reading put it back here: one stop, two loads.
  const now = ['A', 'B', 'C', 'E'];
  assert.deepEqual(mergeReplyOrder(REPLY, now), ['C', 'A', 'E', 'B']);
  assert.deepEqual(mergeReplyOrder(REPLY, now, false), ['C', 'A', 'E', 'B', 'D'], 'switch off: the old reading, D revived');
});

test('a stop removed while the road reply was out is not put back, so its unplan is still sent', () => {
  const now = ['A', 'C', 'D', 'E'];            // B removed: it sits in the card's removals, not its order
  const out = mergeReplyOrder(REPLY, now);
  assert.equal(out.includes('B'), false);
  assert.deepEqual(out, ['C', 'A', 'E', 'D']);
});

test('a stop added while the reply was out, or one the matrix could not place, rides after it — never dropped', () => {
  const now = ['A', 'B', 'C', 'D', 'E', 'NEW'];
  assert.deepEqual(mergeReplyOrder(REPLY, now), ['C', 'A', 'E', 'B', 'D', 'NEW']);
  // The reply left out two ids (no map location): they ride at the end in the card's order.
  assert.deepEqual(mergeReplyOrder(['C', 'A'], ['X', 'A', 'Y', 'C']), ['C', 'A', 'X', 'Y']);
});

test('nothing changed while the reply was out: exactly the reply, the same as before this fix', () => {
  const now = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(mergeReplyOrder(REPLY, now), REPLY);
  assert.deepEqual(mergeReplyOrder(REPLY, now, false), REPLY);
});

test('every stop on the card comes back exactly once, whatever the reply holds', () => {
  const now = ['1', '2', '3', '4', '5', '6'];
  for (const reply of [[], ['9', '8'], ['3', '3', '1'], ['6', '5', '4', '3', '2', '1', '7']]) {
    const out = mergeReplyOrder(reply, now);
    assert.deepEqual([...out].sort(), [...now].sort(), JSON.stringify(reply));
  }
  // Numeric ids on the card compare as the strings the reply carries.
  assert.deepEqual(mergeReplyOrder(['2', '1'], [1, 2, 3]), ['2', '1', '3']);
  assert.deepEqual(mergeReplyOrder(null, undefined), []);
});

test('switch: on unless an explicit off-word — a typo never turns the fix off', () => {
  assert.equal(roadReplyDropsMovedStopsEnabled({}), true);
  assert.equal(roadReplyDropsMovedStopsEnabled(undefined), true);
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(roadReplyDropsMovedStopsEnabled({ VITE_ROAD_REPLY_DROPS_MOVED_STOPS: v }), false, v);
  for (const v of ['on', '1', 'offf', 'disable', '']) assert.equal(roadReplyDropsMovedStopsEnabled({ VITE_ROAD_REPLY_DROPS_MOVED_STOPS: v }), true, `"${v}" leaves it on`);
});
