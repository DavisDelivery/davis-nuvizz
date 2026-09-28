// A4-S23-2 — "No 53ft" as the app WRITES it must keep a 53' trailer off the stop.
//
// The dispatcher's Equipment restrictions dropdown stores `no_53ft` (App.jsx EQUIPMENT_OPTIONS,
// { value: 'no_53ft', label: 'No 53ft' }). The routing engine only ever knew the spelling
// `no_53`: the Build button's requirement list dropped `no_53ft` as unknown, equipmentReqOk fell
// through to "unknown restriction → don't block", and the assignment solver's blocker set did
// not have it. So the most literal "a 53-footer cannot come here" mark a person can tick was
// ignored by every builder, and a 53' could be sent to a dock that cannot take one — a refused
// delivery found at the door. These run the REAL modules the builders run.
import test from 'node:test';
import assert from 'node:assert/strict';

import { equipmentReqsFrom, KNOWN_REQS, TRAILER_BLOCKERS } from '../netlify/functions/lib/routing-equipment.mts';
import { equipmentReqOk, REASON } from '../netlify/functions/lib/routing-constraints.mts';
import { restrictionsBlockTractor } from '../netlify/functions/lib/routing-assignment-solver.mts';
import { solveRouting } from '../netlify/functions/lib/routing-solver.mts';
import { repair } from '../netlify/functions/lib/routing-repair.mts';
import { buildCleanupPlan } from '../netlify/functions/lib/routing-cleanup-core.mts';
import { liveMatchKey } from '../netlify/functions/lib/routing-draft-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { blocksTractor as shadowBlocksTractor } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';

const TRAILER_53 = { tractor: true, liftgate: false, lengthClassFt: 53, overheadClearance: true };
const BOX_26 = { tractor: false, liftgate: true, lengthClassFt: 26, overheadClearance: true };
const TICKED = { equipment_restrictions: ['no_53ft'], manual_overrides: { equipment_restrictions: true } };

// ── the Build button: equipmentReqsFrom → solveRouting → repair ──
const solverStop = (id, note) => ({
  id, lat: 34.1, lng: -84.0, skids: 2, weightLbs: 500, linearFeetIn: 96, oversize: false,
  serviceMin: 15, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: equipmentReqsFrom(note),
});
const solverTruck = (id, capabilities) => ({
  id, label: id, maxSkids: 28, maxWeightLbs: 30000, deckLengthIn: 636, capabilities,
});
const oneStopMatrix = { durationSec: [[0, 600], [600, 0]], distanceMeters: [[0, 9000], [9000, 0]] };
const build = (trucks, note = TICKED) => {
  const input = {
    stops: [solverStop('S1', note)], trucks, depot: { lat: 34.09, lng: -84.01 }, matrix: oneStopMatrix,
    strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0,
  };
  return repair(input, solveRouting(input));
};
const truckOf = (out, id) => out.routes.find((r) => r.orderedStopIds.includes(id))?.truckId ?? null;

test('a stop a dispatcher ticked "No 53ft" is kept off the only 53′ trailer by the Build button, with the reason named', () => {
  const out = build([solverTruck('TRL 53', TRAILER_53)]);
  assert.equal(truckOf(out, 'S1'), null, 'the 53′ was sent to a dock marked No 53ft');
  const spill = out.unassigned.find((u) => u.stopId === 'S1');
  assert.ok(spill, 'the stop is listed, not silently dropped');
  assert.ok(spill.reasons.includes(REASON.needsNo53), `reasons were ${JSON.stringify(spill.reasons)}`);
});

test('with a box and a 53′ in the build, a "No 53ft" stop rides the box', () => {
  const out = build([solverTruck('TRL 53', TRAILER_53), solverTruck('BOX 26', BOX_26)]);
  assert.equal(truckOf(out, 'S1'), 'BOX 26');
});

test('a GREEN Tractor-OK mark still overrules "No 53ft" — green wins, as it does for every trailer blocker', () => {
  const out = build([solverTruck('TRL 53', TRAILER_53)], { ...TICKED, vehicle_eligibility: 'tractor' });
  assert.equal(truckOf(out, 'S1'), 'TRL 53');
});

test('"No 53ft" and "no_53" are the same rule in the requirement list and the constraint', () => {
  assert.ok(KNOWN_REQS.has('no_53ft') && TRAILER_BLOCKERS.has('no_53ft'));
  for (const key of ['no_53', 'no_53ft']) {
    assert.deepEqual(equipmentReqOk(key, { capabilities: TRAILER_53 }), { ok: false, reason: REASON.needsNo53 }, key);
    assert.deepEqual(equipmentReqOk(key, { capabilities: BOX_26 }), { ok: true }, key);
  }
});

test('the engine’s assignment solver (step 4, the nightly draft) reads "No 53ft" as a stop a tractor cannot take', () => {
  assert.equal(restrictionsBlockTractor(['no_53ft']), true);
  assert.equal(restrictionsBlockTractor(['no_53']), true);
});

test('the Claude shadow backtest judges a "No 53ft" stop on a tractor the same way the engine does', () => {
  assert.equal(shadowBlocksTractor(TICKED), true);
});

// ── Step 4 · Fill my loads under the Build rules ──
test('Fill my loads does not put a "No 53ft" stop on the 53′ it was handed — it lists it with the reason', () => {
  const row = {
    stopNbr: 'N1', isUnplanned: true, isPlanned: false, businessName: 'NARROW LANE SUPPLY',
    addr1: '1 Main St', city: 'Buford', zip: '30518', lat: 34.1, lng: -84.0,
    cartons: 2, volume: 0, pallets: 2, weight: 500, timeConstraint: null,
  };
  const notes = new Map([[liveMatchKey(row), TICKED]]);
  const inputs = {
    driverDaysBefore: [], referencesBefore: [],
    serviceDocByKey: new Map(), fleetServiceDoc: null, habitDocByKey: new Map(),
    notesRestrictions: new Map([[liveMatchKey(row), TICKED.equipment_restrictions]]),
    noteByKey: notes, tractorCapable: new Set(), employees: [],
  };
  const p = buildCleanupPlan('davis', '2026-08-27', {
    cfg: engineConfigDefaults({}), inputs, liveStops: [row], meta: null, rules: 'build',
    trucks: [{
      key: 'TRL', name: 'TRL', loadNbr: 'L-TRL', loadId: null, truck_class: 'tractor',
      max_skids: 28, max_weight_lb: 30000, liftgate: false, capabilities: TRAILER_53, driver_user_name: null,
    }],
    nowIso: '2026-08-27T01:00:00Z',
  });
  assert.ok(!p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'N1')), 'rode the 53′');
  const l = p.left_unplanned.find((s) => s.stopNbr === 'N1');
  assert.equal(l?.reason, 'equipment');
  assert.match(l.detail, /53ft/);
});
