// test/routing-solver.test.mjs — PURE solver: assignment, sequencing, 2-opt, spill.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveRouting, twoOpt, nearestNeighbor, pathCost,
} from '../netlify/functions/lib/routing-solver.mts';

// Build a symmetric matrix from 1-D positions (depot first). cost = |Δpos|.
function lineMatrix(positions) {
  const n = positions.length;
  const d = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) d[i][j] = Math.abs(positions[i] - positions[j]);
  return { durationSec: d, distanceMeters: d };
}

const truck = (over = {}) => ({
  id: 'T1', maxSkids: 100, maxWeightLbs: 1e6, deckLengthIn: 1e6,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 }, ...over,
});
const stop = (id, lat, lng, over = {}) => ({
  id, lat, lng, skids: 1, weightLbs: 100, linearFeetIn: 48, oversize: false,
  serviceMin: 0, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: [], ...over,
});

test('twoOpt strictly improves a deliberately bad order', () => {
  // positions: depot@0, n1@1, n2@2, n3@3, n4@4 ; matrix index = position+1 mapping
  const cost = lineMatrix([0, 1, 2, 3, 4]).distanceMeters;
  const bad = [4, 3, 2, 1];           // D->4->3->2->1 = 4+1+1+1 = 7
  const fixed = twoOpt(bad, cost);
  assert.deepEqual(fixed, [1, 2, 3, 4]);
  assert.equal(pathCost(fixed, cost), 4);
  assert.ok(pathCost(fixed, cost) < pathCost(bad, cost));
});

test('nearestNeighbor visits all nodes once', () => {
  const cost = lineMatrix([0, 5, 1, 9]).distanceMeters;
  const nn = nearestNeighbor([1, 2, 3], cost);
  assert.deepEqual([...nn].sort(), [1, 2, 3]);
});

test('MIN_DISTANCE reorders a bad input order to the optimal sequence', () => {
  // stops given WORST-first: C(3), B(2), A(1). matrix idx: depot0, C1, B2, A3.
  const stops = [stop('C', 0, 3), stop('B', 0, 2), stop('A', 0, 1)];
  const matrix = lineMatrix([0, 3, 2, 1]); // depot, C, B, A
  const out = solveRouting({ stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, matrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 } });
  assert.equal(out.routes.length, 1);
  assert.deepEqual(out.routes[0].orderedStopIds, ['A', 'B', 'C']);
});

test('CLOSEST_FIRST vs FARTHEST_FIRST measurably flip the order', () => {
  const stops = [stop('A', 0, 1), stop('B', 0, 2), stop('C', 0, 3)];
  const matrix = lineMatrix([0, 1, 2, 3]);
  const base = { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, matrix, objectiveWeights: { distance: 1, time: 1, balance: 0 } };
  const near = solveRouting({ ...base, strategy: 'CLOSEST_FIRST' }).routes[0].orderedStopIds;
  const far = solveRouting({ ...base, strategy: 'FARTHEST_FIRST' }).routes[0].orderedStopIds;
  assert.deepEqual(near, ['A', 'B', 'C']);
  assert.deepEqual(far, ['C', 'B', 'A']);
});

test('assignment respects skid capacity and spills the remainder', () => {
  const stops = [stop('A', 0, 1, { skids: 3 }), stop('B', 0, 2, { skids: 3 }), stop('C', 0, 3, { skids: 3 })];
  const matrix = lineMatrix([0, 1, 2, 3]);
  const small = truck({ id: 'SMALL', maxSkids: 5 }); // fits only 1 of the 3-skid stops? no: 5 fits 1 (3) not 2 (6)
  const out = solveRouting({ stops, trucks: [small], depot: { lat: 0, lng: 0 }, matrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 } });
  const carried = out.routes.reduce((a, r) => a + r.orderedStopIds.length, 0);
  assert.equal(carried, 1);
  assert.equal(out.unassigned.length, 2);
  assert.ok(out.unassigned[0].reasons.some((r) => /skid/.test(r)));
});

test('equipment constraint routes a no-tractor-trailer stop only onto a box truck', () => {
  const stops = [stop('A', 0, 1, { equipmentReqs: ['no_tractor_trailer'] }), stop('B', 0, 2)];
  const matrix = lineMatrix([0, 1, 2]);
  const box = truck({ id: 'BOX', capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } });
  const tractor = truck({ id: 'TRACTOR', capabilities: { liftgate: false, tractor: true, lengthClassFt: 53 } });
  const out = solveRouting({ stops, trucks: [tractor, box], depot: { lat: 0, lng: 0 }, matrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 } });
  const boxRoute = out.routes.find((r) => r.truckId === 'BOX');
  assert.ok(boxRoute.orderedStopIds.includes('A'), 'restricted stop A must be on the box truck');
});

test('a stop that fits no truck spills with a clear reason', () => {
  const stops = [stop('A', 0, 1, { equipmentReqs: ['no_tractor_trailer'] })];
  const matrix = lineMatrix([0, 1]);
  const tractor = truck({ id: 'TRACTOR', capabilities: { liftgate: false, tractor: true, lengthClassFt: 53 } });
  const out = solveRouting({ stops, trucks: [tractor], depot: { lat: 0, lng: 0 }, matrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 } });
  assert.equal(out.routes.length, 0);
  assert.equal(out.unassigned.length, 1);
  assert.ok(out.unassigned[0].reasons.some((r) => /straight\/box truck/.test(r)));
});
