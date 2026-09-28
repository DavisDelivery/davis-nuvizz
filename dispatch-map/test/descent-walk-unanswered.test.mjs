// A4-S19-8, the half the other two files cannot reach — a descent whose CEILING SEARCH was
// answered and whose WALK down from it was not.
//
// That is the realistic failure: the daily call ceiling trips, or NuVizz stalls, PARTWAY through
// a number-probe scan. In descent-unanswered-probes.test.mjs every probe is refused, so the
// ceiling search finds nothing and places the ceiling below the floor — the walk never runs, and
// only the ceiling search's tally is exercised. Here the ceiling search sees a real frontier, the
// walk starts above it, and a band of numbers inside the walk times out twice (the requester's
// one timeout retry, then it gives up). The walk then early-stops BY DESIGN on two chunks of
// older, delivered stops — which, with every probe answered, is a complete descent (the control
// below). With the band unanswered it must not be.
//
// No network: the Firestore fake's onOther is the vendor, and it refuses anything that is not a
// stubbed NuVizz URL.
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.NUVIZZ_BREAKER_MODE;
delete process.env.NUVIZZ_TERMINAL_SKIP;

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const { estimateStopFrontier } = await import('../netlify/functions/lib/nuvizz-scan.mts');
// The ceiling search anchors on the UTC today; scanning that same day keeps the floor far below
// the frontier, so the only way this walk ends is the by-design early stop.
const DATE = new Date().toISOString().slice(0, 10);
const F = estimateStopFrontier(DATE);   // the highest stop number that exists, in this fake
// Numbers the walk descends through above the frontier. The ceiling search samples 8-wide
// windows at its gallop and bisection points (F+33..F+40, F-167..F-160, F-67..F-60, F-17..F-10,
// F+8..F+15, F-5..F+2, F+1..F+8); this band sits between them, so only the walk asks about it.
const BAND = new Set(Array.from({ length: 10 }, (_, k) => F + 20 + k));

function vendor(opts) {
  const seen = { band: 0, calls: 0 };
  const fn = async (url) => {
    const u = String(url);
    if (!u.includes('nuvizz')) throw new Error(`blocked non-vendor url ${u.slice(0, 80)}`);
    seen.calls++;
    const m = u.match(/\/stop\/info\/(\d+)\//);
    if (!m) return new Response('{}', { status: 404 });
    const n = Number(m[1]);
    if (BAND.has(n)) {
      seen.band++;
      if (opts.timeoutBand) throw Object.assign(new Error('stalled (test)'), { name: 'TimeoutError' });
    }
    if (n > F) return new Response('{}', { status: 404 });
    // An older, delivered order — exists, not a target, so two chunks of them end the walk.
    return new Response(JSON.stringify({ Stop: {
      stop: { stopNbr: String(n).padStart(9, '0'), stopType: 'DO', to: { schedule: { timeFrom: '2020-01-06T08:00:00' } } },
      stopExecutionInfo: { stopStatus: '90' }, load: {},
    } }), { status: 200 });
  };
  return { fn, seen };
}

test('control: every probe answered, the walk early-stops by design — the descent is complete', async () => {
  const v = vendor({ timeoutBand: false });
  installFirestoreFake({}, v.fn);
  const { scanDate } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const r = await scanDate(DATE, { includeLoads: false });
  assert.ok(v.seen.band > 0, 'the walk really descended through the band');
  assert.equal(r.descentProbeFailures, 0);
  assert.equal(r.descentComplete, true);
});

test('NuVizz stops answering partway down the walk (after the ceiling search was answered): the descent reads INCOMPLETE', async () => {
  const v = vendor({ timeoutBand: true });
  installFirestoreFake({}, v.fn);
  const { scanDate } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const r = await scanDate(DATE, { includeLoads: false });
  assert.ok(v.seen.band > 0, 'the walk really asked about the band');
  assert.ok(r.descentProbeFailures >= BAND.size, `every unanswered walk probe is counted (got ${r.descentProbeFailures})`);
  assert.equal(r.descentComplete, false, 'a walk with numbers nobody could ask about did not reach its floor');
});
