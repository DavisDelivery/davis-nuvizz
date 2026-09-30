// CLOSEST FIRST WITHOUT THE TOWN RULE (Chad, 2026-09-30: "Try closest without it"). The Compare
// card's and the Build-result card's re-sequence menus run Closest first as the plain sweep while
// VITE_CLOSEST_FIRST_WITHOUT_TOWNS is on; Farthest first and everything else keep what they had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resequence, resequenceOnMatrix, closestFirst, farthestFirst, haversineMeters,
  sweepModeFor, closestFirstWithoutTownsEnabled, SWEEP_MODE,
} from '../src/lib/routing-select.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };   // Buford
// Six stops where the two readings differ: the town rule works S3 and S6 (one town) before S4.
const SIX = [
  { id: 'S1', lat: 34.4103, lng: -83.8767 }, { id: 'S2', lat: 34.3647, lng: -84.0329 },
  { id: 'S3', lat: 34.2009, lng: -83.9118 }, { id: 'S4', lat: 34.2015, lng: -83.8108 },
  { id: 'S5', lat: 34.3207, lng: -84.0461 }, { id: 'S6', lat: 34.2177, lng: -83.9452 },
];
const ids = (xs) => xs.map((s) => s.id);
// Unscaled straight-line metres: S3 and S6 sit 3.6 km apart, inside the 4 km town radius, so the
// town rule groups them on the matrix too (at x1.3 they would be 4.7 km apart and never one town).
const matrix = (stops) => { const n = [DEPOT, ...stops]; return n.map((a) => n.map((b) => haversineMeters(a, b))); };

test('the menu pick of Closest first runs without the town rule — everything else keeps its sweep', () => {
  assert.equal(SWEEP_MODE, 'towns', 'the house default is unchanged');
  assert.equal(sweepModeFor('closest', {}), 'pure');
  for (const s of ['farthest', 'min', 'loop', 'reverse', 'home', 'windows']) assert.equal(sweepModeFor(s, {}), SWEEP_MODE, s);
  assert.equal(sweepModeFor('closest', { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: 'off' }), SWEEP_MODE, 'switch off: the town rule is back');
});

test('straight line: the card order is the plain sweep, and the switch puts the town rule back', () => {
  const on = ids(resequence(SIX, DEPOT, 'closest', sweepModeFor('closest', {})));
  const off = ids(resequence(SIX, DEPOT, 'closest', sweepModeFor('closest', { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: 'off' })));
  assert.deepEqual(on, ['S3', 'S4', 'S6', 'S5', 'S2', 'S1']);
  assert.deepEqual(off, ['S3', 'S6', 'S4', 'S5', 'S2', 'S1'], 'the town rule: S3 and S6 together');
  assert.deepEqual(off, ids(closestFirst(SIX, DEPOT)), 'off is exactly today\'s Closest first');
  assert.deepEqual(ids(resequence(SIX, DEPOT, 'closest')), off, 'no mode passed: unchanged, for every other caller');
});

test('road box: the same, on the matrix', () => {
  const C = matrix(SIX);
  const on = ids(resequenceOnMatrix(SIX, C, 'closest', sweepModeFor('closest', {})));
  const off = ids(resequenceOnMatrix(SIX, C, 'closest', sweepModeFor('closest', { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: 'no' })));
  assert.deepEqual(on, ['S3', 'S4', 'S6', 'S5', 'S2', 'S1']);
  assert.deepEqual(off, ['S3', 'S6', 'S4', 'S5', 'S2', 'S1'], 'the town rule: S3 and S6 together');
  assert.deepEqual(off, ids(resequenceOnMatrix(SIX, C, 'closest')), 'off is exactly today\'s road-box Closest first');
});

test('Farthest first is untouched by the switch, on both paths', () => {
  const C = matrix(SIX);
  for (const env of [{}, { VITE_CLOSEST_FIRST_WITHOUT_TOWNS: 'off' }]) {
    assert.deepEqual(ids(resequence(SIX, DEPOT, 'farthest', sweepModeFor('farthest', env))), ids(farthestFirst(SIX, DEPOT)));
    assert.deepEqual(ids(resequenceOnMatrix(SIX, C, 'farthest', sweepModeFor('farthest', env))), ids(resequenceOnMatrix(SIX, C, 'farthest')));
  }
});

test('switch: on unless an explicit off-word — a typo never puts the town rule back', () => {
  assert.equal(closestFirstWithoutTownsEnabled({}), true);
  assert.equal(closestFirstWithoutTownsEnabled(undefined), true);
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(closestFirstWithoutTownsEnabled({ VITE_CLOSEST_FIRST_WITHOUT_TOWNS: v }), false, v);
  for (const v of ['on', '1', 'offf', 'towns', '']) assert.equal(closestFirstWithoutTownsEnabled({ VITE_CLOSEST_FIRST_WITHOUT_TOWNS: v }), true, `"${v}" leaves it on`);
});
