// test/nuvizz-write-sequence.test.mjs — §10 "anchor method" manual sequencing (PURE).
// No network: planSequence is a pure function. Covers the doc's verified reorder example
// plus add / remove / no-op / unsafe-refusal cases.
import test from 'node:test';
import assert from 'node:assert/strict';

import { planSequence } from '../netlify/functions/lib/nuvizz-write-ops.mts';

test('planSequence: the doc-verified reorder [M,C,K,Ca] → [Ca,K,C,M]', () => {
  // BEFORE order, WANT order — anchor is the first DESIRED stop (Ca), already on the load.
  const p = planSequence(['M', 'C', 'K', 'Ca'], ['Ca', 'K', 'C', 'M']);
  assert.equal(p.ok, true);
  assert.equal(p.unchanged, false);
  assert.equal(p.anchor, 'Ca');
  assert.deepEqual(p.removeStopIds, ['M', 'C', 'K'], 'remove every current delivery except the anchor');
  assert.deepEqual(p.insertOrdered, ['K', 'C', 'M'], 'insert the rest one-at-a-time in desired order');
  // cost ≈ 2 (load/info+load/edit) + (N-1) inserts = 2 + 3.
  assert.equal(p.insertOrdered.length, 3);
});

test('planSequence: add a new stop → appended into the order, others kept', () => {
  const p = planSequence(['A', 'B'], ['A', 'B', 'C']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'A');
  assert.deepEqual(p.removeStopIds, ['B']);
  assert.deepEqual(p.insertOrdered, ['B', 'C']);  // B re-inserted then C — yields [A,B,C]
});

test('planSequence: remove a stop → departed stop is dropped, not re-inserted', () => {
  const p = planSequence(['A', 'B', 'C'], ['A', 'C']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'A');
  assert.deepEqual(p.removeStopIds, ['B', 'C']);
  assert.deepEqual(p.insertOrdered, ['C'], 'B is removed and never re-inserted; result [A,C]');
});

test('planSequence: combined move (swap first two existing) keeps the anchor on the load', () => {
  const p = planSequence(['A', 'B'], ['B', 'A']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'B');           // B is current, so it's a valid anchor
  assert.deepEqual(p.removeStopIds, ['A']);
  assert.deepEqual(p.insertOrdered, ['A']);  // → [B,A]
});

test('planSequence: no change → unchanged, ZERO calls', () => {
  const p = planSequence(['A', 'B', 'C'], ['A', 'B', 'C']);
  assert.equal(p.ok, true);
  assert.equal(p.unchanged, true);
  assert.deepEqual(p.removeStopIds, []);
  assert.deepEqual(p.insertOrdered, []);
});

test('planSequence: REFUSE an empty desired order (would cancel the route)', () => {
  const p = planSequence(['A', 'B'], []);
  assert.equal(p.ok, false);
  assert.match(p.reason, /empty-order|cancel/);
});

test('planSequence: REFUSE promoting a brand-new stop to first (append-only cannot)', () => {
  const p = planSequence(['A', 'B'], ['X', 'A', 'B']);  // X is not on the load
  assert.equal(p.ok, false);
  assert.match(p.reason, /anchor-not-on-load/);
});

test('planSequence: tolerates null/blank ids and numeric ids', () => {
  const p = planSequence([1, 2, null, 3], [3, 1, 2]);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, '3');
  assert.deepEqual(p.removeStopIds, ['1', '2']);
  assert.deepEqual(p.insertOrdered, ['1', '2']);
});
