// test/truck-capacity.test.mjs — no truck is ever planned as if it were bottomless.
//
// Chad's 2026-09-15 board: 25 orders ≈ 25 skids, two box trucks that hold ~14, and the build
// put 4 on one and 20 on the other. Measured through the real pipeline, a 14-skid cap splits
// it 11/14; the lopsided split needs a cap that does not bind — and a BLANK cap is the worst
// kind, because capLimited reads a non-positive number as "no limit".
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTruckCaps, capsForTruck, CLASS_CAPS } from '../netlify/functions/lib/truck-capacity.mts';

const box = (over = {}) => ({ id: 'BOX A', label: 'BOX A', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 }, ...over });
const tractor = (over = {}) => ({ id: 'TRL', label: 'TRAILER 1', maxSkids: 28, maxWeightLbs: 44000, deckLengthIn: 636, capabilities: { liftgate: false, tractor: true, lengthClassFt: 53 }, ...over });

test('A BLANK SKIDS BOX NO LONGER MEANS AN INFINITE TRUCK', () => {
  const { trucks, notes } = resolveTruckCaps([box({ maxSkids: 0 })]);
  assert.equal(trucks[0].maxSkids, 14, 'a box truck falls back to its class floor');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].field, 'maxSkids');
  assert.match(notes[0].text, /BOX A has no skid limit/);
  assert.match(notes[0].text, /2 · Plan onto → Trucks/, 'the note says where to fix it');
});

test('every shape of missing — null, undefined, NaN, negative, a string — takes the floor', () => {
  for (const bad of [0, null, undefined, NaN, -5, '14']) {
    const { trucks, notes } = resolveTruckCaps([box({ maxSkids: bad })]);
    assert.equal(trucks[0].maxSkids, 14, `maxSkids=${JSON.stringify(bad)}`);
    assert.equal(notes.length, 1, `maxSkids=${JSON.stringify(bad)} should be reported`);
  }
});

test('A CAP THE DISPATCHER SET IS NEVER LOWERED — 20 skids on a box is their call', () => {
  const { trucks, notes } = resolveTruckCaps([box({ maxSkids: 20 })]);
  assert.equal(trucks[0].maxSkids, 20);
  assert.deepEqual(notes, [], 'a real number is not second-guessed');
});

test('a 53ft trailer floors at 28, not at the box number', () => {
  const { trucks } = resolveTruckCaps([tractor({ maxSkids: 0 })]);
  assert.equal(trucks[0].maxSkids, CLASS_CAPS.tractor.maxSkids);
  // …and a long truck that forgot to set `tractor` is still read as one by its length class.
  assert.equal(capsForTruck({ capabilities: { lengthClassFt: 53 } }).maxSkids, 28);
  assert.equal(capsForTruck({ capabilities: { lengthClassFt: 26 } }).maxSkids, 14);
  assert.equal(capsForTruck({}).maxSkids, 14, 'no capability block at all reads as a box, the smaller floor');
});

test('weight is filled in the same way and reported separately', () => {
  const { trucks, notes } = resolveTruckCaps([box({ maxSkids: 0, maxWeightLbs: 0 })]);
  assert.equal(trucks[0].maxWeightLbs, 10000);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.field).sort(), ['maxSkids', 'maxWeightLbs']);
});

test('a clean fleet is passed through untouched and says nothing', () => {
  const { trucks, notes } = resolveTruckCaps([box(), tractor()]);
  assert.deepEqual(notes, []);
  assert.equal(trucks[0].maxSkids, 14);
  assert.equal(trucks[1].maxSkids, 28);
});

test('the empty, the absent and the malformed', () => {
  assert.deepEqual(resolveTruckCaps(), { trucks: [], notes: [] });
  assert.deepEqual(resolveTruckCaps([]), { trucks: [], notes: [] });
  const { trucks } = resolveTruckCaps([null]);
  assert.equal(trucks[0], null, 'a null truck is left alone rather than invented');
});

// ── Chad's board, end to end ────────────────────────────────────────────────
// 25 orders of one skid each over his four towns, two box trucks. This is the case that
// produced 4/20 on 2026-09-15; the numbers below are what the real pipeline returns.
import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';
import { haversineMatrix } from '../netlify/functions/google-route-matrix.mts';

const DEPOT = { lat: 34.14838, lng: -83.95948 }; // Buford terminal
const TOWNS = [
  ['FLOWERY BRANCH', 34.1851, -83.9252, 9],
  ['BUFORD', 34.1207, -84.0044, 6],
  ['GAINESVILLE', 34.2979, -83.8241, 6],
  ['OAKWOOD', 34.2276, -83.8852, 4],
];
function board() {
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out = []; let i = 0;
  for (const [town, lat, lng, n] of TOWNS) {
    for (let k = 0; k < n; k++) {
      i += 1;
      out.push({ stopNbr: `S${i}`, businessName: `${town} ${k + 1}`, lat: lat + (rnd() - 0.5) * 0.03, lng: lng + (rnd() - 0.5) * 0.03, cartons: 1, weight: 400, weightUOM: 'LB', stopDetails: [], equipmentReqs: [] });
    }
  }
  return out;
}
const split = async (trucks) => {
  const plan = await runPipeline(
    { stops: board(), trucks, depot: DEPOT, date: '2026-09-15', departHHMM: '07:00', strategy: 'MIN_DISTANCE', matrixMode: 'haversine' },
    { buildMatrix: async (d, pts) => ({ matrix: haversineMatrix(d, pts), source: 'haversine' }) },
  );
  return { skids: plan.routes.map((r) => r.load.skids).sort((a, b) => a - b), spilled: plan.unassigned.length };
};

test('CHAD\'S BOARD: 25 skids on two blank-capped box trucks came back 4/20 — the floor fixes it', async () => {
  const blank = () => [
    { id: 'BOX A', label: 'BOX A', maxSkids: 0, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } },
    { id: 'BOX B', label: 'BOX B', maxSkids: 0, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } },
  ];
  // Before: a non-positive cap is read as NO LIMIT, so the skid gate is off and loadFraction —
  // the balance term — is 0. One truck takes nearly everything.
  const before = await split(blank());
  assert.deepEqual(before.skids, [6, 19], 'the unbalanced split this bug produced');
  assert.ok(before.skids[1] > 14, 'and the big one is over what a 26ft box can physically hold');

  // After: the floor gives both trucks their class cap and the same board splits inside it.
  const { trucks, notes } = resolveTruckCaps(blank());
  const after = await split(trucks);
  assert.deepEqual(after.skids, [11, 14], 'balanced, and every truck inside its own ceiling');
  assert.equal(after.spilled, 0, '25 skids fit two 14-skid trucks — nothing should spill');
  assert.equal(notes.length, 2, 'and the dispatcher is told a cap was supplied for each truck');
});
