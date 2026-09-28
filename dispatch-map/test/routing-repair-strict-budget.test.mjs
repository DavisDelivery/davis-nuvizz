// routing-backend-loadscan-config-4 — a STRICT build takes EVERY violator off the truck.
//
// Repair's Phase A removes one violator per pass. Its loop guard re-read the shrinking route
// (`guard++ < stops.length + 2`), so the budget halved as it went and the loop quit after about
// (n+2)/2 removals. On a strict build with more than half a truck's stops closed on the board
// day (or all missing their STRICT windows), the rest stayed on the route the file promises is
// "provably valid" — a driver routed to docks the system already knew were shut, and the risk
// flag then calling a strict build's stop "kept on the route as advisory". The solver's own
// Phase 3 names and fixes exactly this pattern with a budget fixed before the loop.
// These run the REAL solveRouting + repair.
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveRouting } from '../netlify/functions/lib/routing-solver.mts';
import { repair } from '../netlify/functions/lib/routing-repair.mts';
import { REASON } from '../netlify/functions/lib/routing-constraints.mts';

const stop = (id, over = {}) => ({
  id, lat: 0, lng: 0, skids: 1, weightLbs: 100, linearFeetIn: 48, oversize: false,
  serviceMin: 0, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: [], ...over,
});
const truck = { id: 'T1', maxSkids: 100, maxWeightLbs: 1e6, deckLengthIn: 1e6, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } };
// Every stop 60s from every other and from the depot.
const flatMatrix = (n) => {
  const m = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === j ? 0 : 60)));
  return { durationSec: m, distanceMeters: m };
};
const run = (stops, windowMode) => {
  const input = {
    stops, trucks: [truck], depot: { lat: 0, lng: 0 }, matrix: flatMatrix(stops.length),
    strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0, windowMode,
  };
  return repair(input, solveRouting(input));
};
const onTruck = (out) => out.routes.flatMap((r) => r.orderedStopIds);

test('a strict build takes EVERY customer closed on the delivery day off the truck — 8 shut docks out of 10, not the first 6', () => {
  const stops = Array.from({ length: 10 }, (_, i) => stop(`S${i}`, i < 8 ? { closedToday: true } : {}));
  const out = run(stops, 'strict');
  const kept = onTruck(out);
  const shutStillOn = kept.filter((id) => Number(id.slice(1)) < 8);
  assert.deepEqual(shutStillOn, [], `closed customers still routed: ${shutStillOn.join(',')}`);
  assert.deepEqual(kept.sort(), ['S8', 'S9'], 'the two open customers stay on the truck');
  for (let i = 0; i < 8; i++) {
    const u = out.unassigned.find((x) => x.stopId === `S${i}`);
    assert.ok(u?.reasons.includes(REASON.closedToday), `S${i} is listed with its reason`);
  }
});

test('a strict build where every STRICT window is missed spills all 20 stops, and nothing is left flagged as advisory', () => {
  // Window closes at 10s; the nearest stop is 60s out, so every stop is late wherever it goes.
  const stops = Array.from({ length: 20 }, (_, i) => stop(`W${i}`, { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 10 } }));
  const out = run(stops, 'strict');
  assert.deepEqual(onTruck(out), [], 'late STRICT stops kept on a strict build');
  assert.equal(out.unassigned.length, 20);
  for (const r of out.routes) assert.deepEqual(r.windowViolatedIds, [], 'strict mode never keeps a window violator');
});

test('advisory mode is unchanged: the same late stops all stay on the truck and are flagged', () => {
  const stops = Array.from({ length: 20 }, (_, i) => stop(`W${i}`, { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 10 } }));
  const out = run(stops, 'advisory');
  assert.equal(onTruck(out).length, 20);
  assert.equal(out.unassigned.length, 0);
  assert.equal(out.routes[0].windowViolatedIds.length, 20);
});
