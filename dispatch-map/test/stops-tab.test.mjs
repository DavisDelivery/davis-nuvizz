// The desktop "Stops" tab sits on the bar only in a window wide enough to keep Messages on it
// (v1.104.1). Chad, choosing between that and loosening the layout check: "1 i like your idea".
import test from 'node:test';
import assert from 'node:assert/strict';
import { STOPS_BAR_MIN_WIDTH, STOPS_BAR_QUERY, stopsOnBar, STOPS_MORE_ITEM } from '../src/lib/stops-tab.js';

test('a 1366px laptop finds Stops under More — the width where it cut off the Messages badge', () => {
  assert.equal(stopsOnBar(1366), false);
  assert.equal(stopsOnBar(1180), false);
  assert.equal(stopsOnBar(1439), false);
});

test('a 1440px window and anything wider carries it on the bar, right of Routing', () => {
  assert.equal(stopsOnBar(1440), true);
  assert.equal(stopsOnBar(1920), true);
  assert.equal(stopsOnBar(2560), true);
});

test('the media query the shell listens to is the same cutoff', () => {
  assert.equal(STOPS_BAR_MIN_WIDTH, 1440);
  assert.equal(STOPS_BAR_QUERY, '(min-width: 1440px)');
});

test('no width to read (a test, no window) leaves it on the bar, its desktop home', () => {
  assert.equal(stopsOnBar(undefined), true);
  assert.equal(stopsOnBar(null), true);
  assert.equal(stopsOnBar('wide'), true);
});

test('under More it is still called "Stops" and still opens the same screen', () => {
  assert.equal(STOPS_MORE_ITEM.label, 'Stops');
  assert.equal(STOPS_MORE_ITEM.id, 'stoplookup');
  assert.ok(Object.isFrozen(STOPS_MORE_ITEM));
});
