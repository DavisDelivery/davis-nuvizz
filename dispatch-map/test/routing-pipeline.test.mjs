// test/routing-pipeline.test.mjs — five-stage pipeline end-to-end with mocks.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';

// Mock matrix dep: euclidean (meters≈deg, durations≈meters). depot first.
function mockMatrix() {
  return async (depot, pts) => {
    const nodes = [depot, ...pts];
    const n = nodes.length;
    const dist = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000);
    const distanceMeters = nodes.map((a) => nodes.map((b) => dist(a, b)));
    return { distanceMeters, durationSec: distanceMeters };
  };
}

const truck = (over = {}) => ({
  id: 'BOX', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 }, ...over,
});

const stops = [
  { stopNbr: 'S1', lat: 0, lng: 1, pallets: 2, weight: 1000, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S2', lat: 0, lng: 2, pallets: 2, weight: 1000, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S3', lat: 0, lng: 3, pallets: 2, weight: 1000, weightUOM: 'LB', stopDetails: [] },
];

test('deterministic-only (no model deps): produces valid routes + deterministic rationale', async () => {
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix() }, // no parseIntent/geometryAssist/explain
  );
  assert.equal(plan.routes.length, 1);
  assert.deepEqual(plan.routes[0].orderedStopIds, ['S1', 'S2', 'S3']);
  assert.equal(plan.aiAssist.intent, false);
  assert.equal(plan.aiAssist.explain, false);
  assert.match(plan.rationale, /MIN DISTANCE|min distance/i);
  assert.equal(plan.intent.source, 'fallback');
  // ETAs strictly increase along the route.
  const e = plan.routes[0].etas;
  assert.ok(e[0] < e[1] && e[1] < e[2]);
});

test('intent model output flips the strategy and is reflected in sequencing', async () => {
  const parseIntent = async () => '{"strategy":"FARTHEST_FIRST"}';
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', intentText: 'go to the far ones first', date: '2026-06-10' },
    { buildMatrix: mockMatrix(), parseIntent },
  );
  assert.equal(plan.intent.strategy, 'FARTHEST_FIRST');
  assert.deepEqual(plan.routes[0].orderedStopIds, ['S3', 'S2', 'S1']);
  assert.equal(plan.aiAssist.intent, true);
});

test('explain model output replaces the deterministic rationale + risk flags', async () => {
  const explain = async () => ({ rationale: 'AI says: tight day.', riskFlags: ['Confirm S2 dock hours'] });
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix(), explain },
  );
  assert.equal(plan.rationale, 'AI says: tight day.');
  assert.deepEqual(plan.riskFlags, ['Confirm S2 dock hours']);
  assert.equal(plan.aiAssist.explain, true);
});

test('a broken explain model falls back to deterministic summary (no crash)', async () => {
  const explain = async () => { throw new Error('model down'); };
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix(), explain },
  );
  assert.equal(plan.aiAssist.explain, false);
  assert.ok(plan.rationale.length > 0);
});

test('capacity overflow spills with reasons; shown route stays within capacity', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ stopNbr: `S${i}`, lat: 0, lng: i + 1, pallets: 3, weight: 1000, weightUOM: 'LB', stopDetails: [] }));
  const plan = await runPipeline(
    { stops: many, trucks: [truck({ maxSkids: 9 })], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix() },
  );
  const route = plan.routes[0];
  assert.ok(route.load.skids <= route.capacity.skids);
  assert.ok(plan.unassigned.length > 0);
  assert.ok(plan.unassigned.every((u) => u.reasons.length > 0));
});

test('STRICT window honored: an unreachable appointment is spilled, route valid', async () => {
  // S_far is geographically distant with a tight early STRICT window.
  const reqStops = [
    { stopNbr: 'NEAR', lat: 0, lng: 1, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
    { stopNbr: 'FAR', lat: 0, lng: 500, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [], scheduledFrom: '08:00', scheduledTo: '08:05', timeConstraint: 'STRICT' },
  ];
  const plan = await runPipeline(
    { stops: reqStops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10', departHHMM: '08:00' },
    { buildMatrix: mockMatrix() },
  );
  assert.ok(plan.unassigned.some((u) => u.stopId === 'FAR' && u.reasons.some((r) => /window/.test(r))));
  assert.ok(plan.routes.some((r) => r.orderedStopIds.includes('NEAR')));
});
