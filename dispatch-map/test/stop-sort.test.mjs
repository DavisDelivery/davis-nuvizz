// test/stop-sort.test.mjs — ordering the phone's stops list.
// Chad: "also want to be able to sort this screen by skids."
import test from 'node:test';
import assert from 'node:assert/strict';

import { sortStops, nextStopSort, skidsOf, looseOf, stopSort, STOP_SORTS } from '../src/lib/stop-sort.js';

// NuVizz mislabels its freight fields — `cartons` are skids, `volume` is loose pieces. The
// stop card prints them that way, so the sort must read the same fields the row shows.
const stop = (stopNbr, cartons, extra = {}) => ({ stopNbr, cartons, ...extra });

test('skids come from `cartons`, NOT the field called `pallets`', () => {
  // The trap: `pallets` is the obvious name and the wrong field. Sorting on it would
  // disagree with the "1 skid" printed on the row.
  assert.equal(skidsOf({ cartons: 4, pallets: 32 }), 4);
  assert.equal(looseOf({ volume: 2 }), 2);
});

test('missing or junk freight counts as zero, never NaN', () => {
  for (const bad of [undefined, null, '', 'x', NaN, -3]) {
    assert.equal(skidsOf({ cartons: bad }), 0, String(bad));
    assert.equal(looseOf({ volume: bad }), 0, String(bad));
  }
  assert.equal(skidsOf(undefined), 0);
});

test('skids, most first — what you reach for the sort for', () => {
  const rows = [stop('a', 1), stop('b', 14), stop('c', 4)];
  assert.deepEqual(sortStops(rows, 'skids', 'desc').map((s) => s.stopNbr), ['b', 'c', 'a']);
});

test('skids, fewest first', () => {
  const rows = [stop('a', 1), stop('b', 14), stop('c', 4)];
  assert.deepEqual(sortStops(rows, 'skids', 'asc').map((s) => s.stopNbr), ['a', 'c', 'b']);
});

test('stops with no skids recorded sort to the fewest end, they do not vanish', () => {
  const rows = [stop('a', 1), stop('b', undefined), stop('c', 5)];
  assert.deepEqual(sortStops(rows, 'skids', 'desc').map((s) => s.stopNbr), ['c', 'a', 'b']);
  assert.equal(sortStops(rows, 'skids', 'desc').length, 3, 'nothing dropped');
});

test('TIES KEEP BOARD ORDER — the list must not jitter', () => {
  // Most of a 728-stop board is 1 skid. If equal rows reshuffled, hundreds of rows would
  // reorder on every render under Chad's thumb. Stability is the whole point, which is why
  // the sort must not be implemented as sort-then-reverse.
  const rows = ['a', 'b', 'c', 'd', 'e'].map((n) => stop(n, 1));
  assert.deepEqual(sortStops(rows, 'skids', 'desc').map((s) => s.stopNbr), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(sortStops(rows, 'skids', 'asc').map((s) => s.stopNbr), ['a', 'b', 'c', 'd', 'e']);
  const mixed = [stop('a', 2), stop('b', 9), stop('c', 2), stop('d', 9)];
  assert.deepEqual(sortStops(mixed, 'skids', 'desc').map((s) => s.stopNbr), ['b', 'd', 'a', 'c']);
});

test('board order returns the list untouched — same array, not a copy', () => {
  const rows = [stop('a', 1), stop('b', 9)];
  assert.equal(sortStops(rows, 'board', 'desc'), rows, 'identity preserved so React skips the re-render');
  assert.deepEqual(sortStops(rows, null, 'desc'), rows);
});

test('sorting never mutates the caller\'s array', () => {
  const rows = [stop('a', 1), stop('b', 9)];
  const before = rows.map((s) => s.stopNbr);
  sortStops(rows, 'skids', 'desc');
  assert.deepEqual(rows.map((s) => s.stopNbr), before);
});

test('a missing/garbage list or key is survivable', () => {
  assert.deepEqual(sortStops(undefined, 'skids', 'desc'), []);
  assert.deepEqual(sortStops(null, 'skids', 'desc'), []);
  const rows = [stop('a', 1)];
  assert.equal(sortStops(rows, 'nonsense', 'desc'), rows, 'an unknown key falls back to board order');
  assert.equal(stopSort('nonsense').key, 'board');
});

test('tapping the control: a fresh key opens at most-first, tapping it again flips', () => {
  const board = { key: 'board', dir: 'desc' };
  assert.deepEqual(nextStopSort(board, 'skids'), { key: 'skids', dir: 'desc' }, 'most skids first on first tap');
  assert.deepEqual(nextStopSort({ key: 'skids', dir: 'desc' }, 'skids'), { key: 'skids', dir: 'asc' });
  assert.deepEqual(nextStopSort({ key: 'skids', dir: 'asc' }, 'skids'), { key: 'skids', dir: 'desc' });
  assert.deepEqual(nextStopSort({ key: 'skids', dir: 'asc' }, 'board'), { key: 'board', dir: 'desc' }, 'back to board order');
});

test('every advertised sort is usable', () => {
  // Guards against a key being added to the chip row with no comparator behind it.
  for (const s of STOP_SORTS) {
    assert.ok(s.key && s.label, 'each sort names itself');
    const rows = [stop('a', 3), stop('b', 1)];
    assert.equal(sortStops(rows, s.key, 'desc').length, 2);
  }
});
