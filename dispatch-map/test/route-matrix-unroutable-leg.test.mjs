// test/route-matrix-unroutable-leg.test.mjs — A LEG GOOGLE CANNOT DRIVE IS NOT A FREE LEG.
//
// A5-S27-4. On a road-matrix build (mode 'google'), computeRouteMatrix answers each origin →
// destination pair with an element. When it cannot find a route it says so in `condition`
// (ROUTE_NOT_FOUND) and carries no duration or distance. The proxy asked for `condition` and never
// read it: the missing fields became 0 seconds and 0 metres, so the router saw that pair as the
// cheapest leg on the board and sequenced around a road that does not exist. An element Google
// left out of the answer stayed at 0 the same way.
//
// Now any pair without a real Google route takes the same straight-line road estimate the free
// matrix uses (1.3 x crow-flies at ~30 mph). ROUTE_MATRIX_ESTIMATE_UNROUTABLE=off puts back the
// old 0-cost reading (house shape: default ON, explicit off-word, malformed stays ON).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrixViaGoogle, haversineMatrix, unroutableEstimateEnabled } from '../netlify/functions/google-route-matrix.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const A = { lat: 34.237791, lng: -83.960911 };  // ~6 miles north
const B = { lat: 34.147791, lng: -84.060911 };  // ~6 miles west

// A stub Google that answers every pair from `answer(i, j)`; returning null leaves the element out.
function stubGoogle(answer) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (!String(url).startsWith('https://routes.googleapis.com/')) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    const out = [];
    body.origins.forEach((_, i) => body.destinations.forEach((_, j) => {
      const e = answer(i, j);
      if (e) out.push({ originIndex: i, destinationIndex: j, ...e });
    }));
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const routed = (sec, m) => ({ condition: 'ROUTE_EXISTS', duration: `${sec}s`, distanceMeters: m });

test('a depot-to-stop pair Google cannot route is priced at the road estimate, not as a free 0-mile leg', async () => {
  delete process.env.ROUTE_MATRIX_ESTIMATE_UNROUTABLE;
  const g = stubGoogle((i, j) => (i === 0 && j === 1 ? { condition: 'ROUTE_NOT_FOUND' } : i === j ? routed(0, 0) : routed(600, 9000)));
  try {
    const m = await buildMatrixViaGoogle(DEPOT, [A, B], 'test-key');
    const est = haversineMatrix(DEPOT, [A, B]);
    assert.equal(m.durationSec[0][1], est.durationSec[0][1]);
    assert.equal(m.distanceMeters[0][1], est.distanceMeters[0][1]);
    assert.ok(m.durationSec[0][1] > 0 && m.distanceMeters[0][1] > 0, 'not a free leg');
    assert.equal(m.durationSec[1][0], 600, 'a real Google leg is still Google\'s');
    assert.equal(m.distanceMeters[0][2], 9000);
  } finally { g.restore(); }
});

test('a pair Google left out of its answer is estimated too, not left at 0', async () => {
  delete process.env.ROUTE_MATRIX_ESTIMATE_UNROUTABLE;
  const g = stubGoogle((i, j) => (i === 2 && j === 1 ? null : i === j ? routed(0, 0) : routed(600, 9000)));
  try {
    const m = await buildMatrixViaGoogle(DEPOT, [A, B], 'test-key');
    const est = haversineMatrix(DEPOT, [A, B]);
    assert.equal(m.durationSec[2][1], est.durationSec[2][1]);
    assert.ok(m.distanceMeters[2][1] > 0);
  } finally { g.restore(); }
});

test('an element with no duration is no route, whatever its condition says', async () => {
  delete process.env.ROUTE_MATRIX_ESTIMATE_UNROUTABLE;
  const g = stubGoogle((i, j) => (i === 1 && j === 2 ? { distanceMeters: 0 } : i === j ? routed(0, 0) : routed(600, 9000)));
  try {
    const m = await buildMatrixViaGoogle(DEPOT, [A, B], 'test-key');
    const est = haversineMatrix(DEPOT, [A, B]);
    assert.equal(m.durationSec[1][2], est.durationSec[1][2]);
    assert.equal(m.distanceMeters[1][2], est.distanceMeters[1][2]);
  } finally { g.restore(); }
});

test('two stops at the same dock still get Google\'s real 0-second leg (unchanged)', async () => {
  delete process.env.ROUTE_MATRIX_ESTIMATE_UNROUTABLE;
  const g = stubGoogle((i, j) => (i === j || (i > 0 && j > 0) ? routed(0, 0) : routed(600, 9000)));
  try {
    const m = await buildMatrixViaGoogle(DEPOT, [A, { ...A }], 'test-key');
    assert.equal(m.durationSec[1][2], 0);
    assert.equal(m.distanceMeters[1][2], 0);
    assert.equal(m.durationSec[0][1], 600);
    assert.equal(m.durationSec[0][0], 0, 'the diagonal stays 0');
  } finally { g.restore(); }
});

test('ROUTE_MATRIX_ESTIMATE_UNROUTABLE=off puts back the old 0-cost reading', async () => {
  process.env.ROUTE_MATRIX_ESTIMATE_UNROUTABLE = 'off';
  const g = stubGoogle((i, j) => (i === 0 && j === 1 ? { condition: 'ROUTE_NOT_FOUND' } : i === j ? routed(0, 0) : routed(600, 9000)));
  try {
    const m = await buildMatrixViaGoogle(DEPOT, [A, B], 'test-key');
    assert.equal(m.durationSec[0][1], 0);
    assert.equal(m.distanceMeters[0][1], 0);
  } finally { g.restore(); delete process.env.ROUTE_MATRIX_ESTIMATE_UNROUTABLE; }
});

test('the switch is house shape: default ON, only an explicit off-word turns it off, malformed stays ON', () => {
  assert.equal(unroutableEstimateEnabled({}), true);
  for (const off of ['off', '0', 'false', 'no', ' Off ']) assert.equal(unroutableEstimateEnabled({ ROUTE_MATRIX_ESTIMATE_UNROUTABLE: off }), false, off);
  for (const on of ['on', 'yes', '1', 'ofF!', '']) assert.equal(unroutableEstimateEnabled({ ROUTE_MATRIX_ESTIMATE_UNROUTABLE: on }), true, on);
});
