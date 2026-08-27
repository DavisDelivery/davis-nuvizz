// The Compare card seed. The RWB save is DECLARATIVE: anything the load holds in
// NuVizz that the payload neither ORDERS nor REMOVES is "unaccounted" and the
// whole load is refused with "has N stop(s) the board isn't showing — refresh and
// retry", advice that cannot work. So the one invariant that matters here is
// baseline ⊆ order ∪ removed, for every input shape the board can produce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedStagedCard } from '../src/lib/workbench-stage.js';

const accounted = (r) => {
  const o = new Set(r.order), rm = new Set(r.removed);
  return r.baseline.every((id) => o.has(id) || rm.has(id));
};

test('THE INVARIANT: nothing the load holds is ever left unaccounted', () => {
  const cases = [
    [[], [], new Map(), 'A'],
    [['1', '2', '3'], ['9'], new Map(), 'A'],
    [['1', '2'], ['1'], new Map(), 'A'],                              // add one it already has
    [['1', '2'], ['3'], new Map([['2', 'B']]), 'A'],                  // one of its own held elsewhere
    [['1', '2'], ['3'], new Map([['3', 'B']]), 'A'],                  // the ADD is held elsewhere
    [['1', '1', '2'], ['2', '2'], new Map(), 'A'],                    // duplicated board row + duplicated add
    [['1'], ['2'], new Map([['1', 'A']]), 'A'],                       // held by THIS card
    [null, null, null, 'A'],                                          // absent everything
    [['1', '2', '3'], ['4', '5'], new Map([['1', 'B'], ['4', 'C']]), 'A'],
  ];
  for (const [board, add, held, key] of cases) {
    const r = seedStagedCard(board, add, held, key);
    assert.ok(accounted(r), `unaccounted stop for ${JSON.stringify({ board, add })} → ${JSON.stringify(r)}`);
    assert.equal(new Set(r.order).size, r.order.length, 'order has no duplicates');
    assert.equal(new Set(r.baseline).size, r.baseline.length, 'baseline has no duplicates');
    for (const id of r.order) assert.ok(!r.removed.includes(id), `${id} is both ordered and removed`);
  }
});

test('the WHOLE current membership is the baseline — an ungeocoded stop is still on the truck', () => {
  // The bug this module exists for: the old seed built baseline from the
  // coord-ONLY projection, so a load holding an ungeocoded stop produced a
  // baseline missing it and the save was refused.
  const r = seedStagedCard(['100', '101', '102'], ['200'], new Map(), 'SUW 2');
  assert.deepEqual(r.baseline, ['100', '101', '102']);
  assert.deepEqual(r.order, ['100', '101', '102', '200']);
  assert.deepEqual(r.removed, []);
});

test('a stop staged on ANOTHER card is REMOVED, not dropped — that is what a move is', () => {
  const held = new Map([['101', 'ALPHA']]);
  const r = seedStagedCard(['100', '101'], ['200'], held, 'SUW 2');
  assert.deepEqual(r.removed, ['101'], 'it is leaving this load — say so');
  assert.deepEqual(r.order, ['100', '200'], 'and it is not on this load any more');
  assert.ok(accounted(r));
});

test('a stop held by THIS card is already here, not elsewhere', () => {
  const r = seedStagedCard(['100'], ['100'], new Map([['100', 'SUW 2']]), 'SUW 2');
  assert.deepEqual(r.removed, [], 'never remove a stop from the card that holds it');
  assert.deepEqual(r.order, ['100']);
});

test('an add already held by another card is reported, never silently taken', () => {
  const r = seedStagedCard(['100'], ['200', '201'], new Map([['200', 'ALPHA']]), 'SUW 2');
  assert.deepEqual(r.skippedHeld, ['200']);
  assert.deepEqual(r.order, ['100', '201']);
});

test('a duplicated board row does not double-count, and a duplicated add lands once', () => {
  const r = seedStagedCard(['100', '100', '101'], ['200', '200'], new Map(), 'A');
  assert.deepEqual(r.baseline, ['100', '101']);
  assert.deepEqual(r.order, ['100', '101', '200']);
});

test('null and undefined arguments produce an empty card, never a throw', () => {
  const r = seedStagedCard(undefined, undefined, undefined, 'A');
  assert.deepEqual(r, { baseline: [], order: [], removed: [], skippedHeld: [] });
  // a non-Map heldBy is treated as "nothing is held" rather than crashing mid-stage
  const r2 = seedStagedCard(['1'], ['2'], { '1': 'B' }, 'A');
  assert.deepEqual(r2.order, ['1', '2']);
});
