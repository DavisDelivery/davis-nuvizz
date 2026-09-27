// A4-S24-2 (the half still open) — a stop the repair pass takes off a truck and then recovers
// goes back on ITS OWN truck when it fits there, before any other truck is tried.
//
// Phase B used to be first-fit over the picked trucks in the order they were picked, with no
// memory of where the stop came from. On a strict build, repair can take a stop off its truck
// for a missed window and then take a SECOND stop off the same truck — after which the first
// one fits again. First-fit then handed it to whichever truck was listed first: here the east
// truck, which now drives across town to one west-side stop and back, while the west truck
// that the solver chose for it (and that can still take it) runs light. Found by running the
// real solveRouting + repair over random two-truck strict boards.
//
// Put it back: ROUTING_REPAIR_ORIGIN_FIRST=off (house shape — default ON, an explicit
// off/0/false/no turns it off, anything malformed leaves it ON). The build's meta says which
// ran (recoverOriginFirst).
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveRouting } from '../netlify/functions/lib/routing-solver.mts';
import { repair, repairOriginFirstEnabled } from '../netlify/functions/lib/routing-repair.mts';

const hav = (a, b) => {
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// West side of town (lng ≈ -84.3) and east side (lng ≈ -83.7), depot between them.
const RAW = [
  ['S0', 33.8855, -84.3072, 1, 5307], ['S1', 34.0216, -83.6916, 1, null], ['S2', 33.9341, -84.2301, 2, 6536],
  ['S3', 33.988, -83.7874, 4, 4809], ['S4', 33.8743, -84.2893, 3, 2112], ['S5', 33.8535, -83.6019, 1, null],
  ['S6', 33.8616, -84.3753, 1, 4049],
];
const stops = RAW.map(([id, lat, lng, skids, end]) => ({
  id, lat, lng, skids, weightLbs: 300, linearFeetIn: 48, oversize: false, serviceMin: 20,
  timeWindow: end == null ? null : { startSec: 0, endSec: end }, timeConstraint: end == null ? 'SOFT' : 'STRICT', equipmentReqs: [],
}));
const depot = { lat: 34.0, lng: -84.0 };
const pts = [depot, ...stops];
const dist = pts.map((a) => pts.map((b) => hav(a, b)));
const matrix = { distanceMeters: dist, durationSec: dist.map((r) => r.map((m) => Math.round(m / 15))) };
const box = (id) => ({ id, label: id, maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } });
const input = {
  stops, trucks: [box('EAST'), box('WEST')], depot, matrix, strategy: 'MIN_DISTANCE',
  objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0, windowMode: 'strict',
};
const truckOf = (out, id) => out.routes.find((r) => r.orderedStopIds.includes(id))?.truckId ?? null;

test('the scenario is what it says: the solver puts S2 on the west truck and S3 on the east one', () => {
  const solved = solveRouting(input);
  assert.equal(truckOf(solved, 'S2'), 'WEST');
  assert.equal(truckOf(solved, 'S3'), 'EAST');
});

test('a stop repair takes off and recovers goes back on its OWN truck when it fits there — not across town onto the first truck picked', () => {
  const out = repair(input, solveRouting(input), { originFirst: true });
  assert.equal(truckOf(out, 'S2'), 'WEST', 'S2 was handed to the east truck while the west truck could still take it');
  // Every stop on every returned route is on time — nothing was bent to keep S2 where it was.
  for (const r of out.routes) assert.deepEqual(r.windowViolatedIds, [], `${r.truckId} has a late STRICT stop`);
  assert.equal(out.meta.recoverOriginFirst, true, 'the build says which rule ran');
});

test('ROUTING_REPAIR_ORIGIN_FIRST=off puts the old first-fit back, and the build says so', () => {
  const out = repair(input, solveRouting(input), { originFirst: false });
  assert.equal(truckOf(out, 'S2'), 'EAST', 'switch off is the old behaviour exactly');
  assert.equal(out.meta.recoverOriginFirst, false);
});

test('the switch has the house shape: on by default, an explicit off-word turns it off, a typo leaves it ON', () => {
  assert.equal(repairOriginFirstEnabled({}), true);
  for (const off of ['off', 'OFF ', '0', 'false', 'no']) assert.equal(repairOriginFirstEnabled({ ROUTING_REPAIR_ORIGIN_FIRST: off }), false, off);
  for (const on of ['of', 'yes', 'on', '1', 'maybe', '']) assert.equal(repairOriginFirstEnabled({ ROUTING_REPAIR_ORIGIN_FIRST: on }), true, on);
});

test('with no option given, repair reads the switch', () => {
  const prev = process.env.ROUTING_REPAIR_ORIGIN_FIRST;
  try {
    delete process.env.ROUTING_REPAIR_ORIGIN_FIRST;
    assert.equal(truckOf(repair(input, solveRouting(input)), 'S2'), 'WEST');
    process.env.ROUTING_REPAIR_ORIGIN_FIRST = 'off';
    assert.equal(truckOf(repair(input, solveRouting(input)), 'S2'), 'EAST');
  } finally {
    if (prev === undefined) delete process.env.ROUTING_REPAIR_ORIGIN_FIRST; else process.env.ROUTING_REPAIR_ORIGIN_FIRST = prev;
  }
});
