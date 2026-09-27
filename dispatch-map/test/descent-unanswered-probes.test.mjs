// A4-S19-8 — an unplanned descent whose /stop/info probes NuVizz never answered must not come
// back reading "complete".
//
// descentComplete is the one signal the board write and the nightly capture act on: false means
// "this list is not authoritative — keep the unplanned orders you already have, do not seal the
// day". probeStop folded a probe that never got an answer (the call-ceiling breaker refusing it,
// a timeout, a dropped connection) into the same `exists: false` it uses for "there is no stop
// with this number", so a descent that could not ask a single question walked down to its floor,
// found nothing, and reported complete:true — an authoritative EMPTY unplanned list.
//
// Scope, stated so nobody reads more into it: this counts probes that got NO ANSWER (the request
// threw). Which HTTP statuses on /stop/info mean "no such stop" and which mean "the vendor failed"
// depends on how NuVizz answers a number it does not hold, which the code cannot show — that half
// is a question for Chad, not a guess made here.
//
// No network: the Firestore fake's onOther is the vendor, and it refuses anything that is not a
// stubbed NuVizz URL.
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.NUVIZZ_BREAKER_MODE;   // enforce (the default)

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
const ET_TODAY = etDayString();
// The descent's ceiling is anchored on the UTC today and its floor on the scanned date, so a
// scan of TOMORROW is a range the descent can walk to its floor inside the 2,500-probe cap —
// which is exactly when a no-answer descent used to report complete:true.
const TOMORROW_UTC = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let vendorCalls = 0;
const vendor404 = async (url) => {
  const u = String(url);
  if (!u.includes('nuvizz')) throw new Error(`blocked non-vendor url ${u.slice(0, 80)}`);
  vendorCalls++;
  return new Response('{}', { status: 404 });
};

// The day's call ceiling already reached, the breaker open: the requester refuses every call
// (NuvizzCircuitOpenError) without sending it.
const breakerOpenSeed = () => ({
  'nuvizz_ops/circuit': { open: true, day: ET_TODAY, reason: 'daily ceiling reached (test)', at: new Date().toISOString() },
  [`nuvizz_ops/calls__${ET_TODAY}`]: { count: 1_000_000 },
});

test('the call ceiling trips and every forward-walk probe is refused: the descent reads INCOMPLETE, not an empty unplanned list', async () => {
  vendorCalls = 0;
  installFirestoreFake(breakerOpenSeed(), vendor404);
  const { scanDate } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const r = await scanDate(ET_TODAY, { includeLoads: false, forwardUnplanned: { start: 7_200_000 } });
  assert.equal(vendorCalls, 0, 'the breaker refused every probe — nothing reached NuVizz');
  assert.equal(r.unplannedCount, 0);
  assert.equal(r.descentComplete, false, 'a descent that asked nothing must not report complete');
  assert.ok(r.descentProbeFailures > 0, `unanswered probes are counted (got ${r.descentProbeFailures})`);
});

test('the call ceiling trips and every full-descent probe is refused: the descent reads INCOMPLETE even though it reached its floor', async () => {
  vendorCalls = 0;
  installFirestoreFake(breakerOpenSeed(), vendor404);
  const { scanDate } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const r = await scanDate(TOMORROW_UTC, { includeLoads: false });
  assert.equal(vendorCalls, 0);
  assert.equal(r.descentComplete, false);
  assert.ok(r.descentProbeFailures > 0);
});

test('the nightly capture names unanswered stop probes when it refuses to seal', async () => {
  const { scanHealthComplaint } = await import('../netlify/functions/lib/history-core.mts');
  const said = scanHealthComplaint({ descentComplete: false, descentProbeFailures: 12 });
  assert.match(said, /12 stop probe\(s\) unanswered/);
  // A truncated descent with every probe answered still complains exactly as before.
  assert.equal(scanHealthComplaint({ descentComplete: false, descentProbeFailures: 0 }), 'the unplanned descent was truncated');
  assert.equal(scanHealthComplaint({ descentComplete: false }), 'the unplanned descent was truncated');
  assert.equal(scanHealthComplaint({ descentComplete: true, descentProbeFailures: 0 }), null);
});
