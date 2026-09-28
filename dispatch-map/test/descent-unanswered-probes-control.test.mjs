// A4-S19-8, the control half — kept in its own file because the requester memoises the
// breaker's position for 5 s per process, and the refusal tests next door open it.
//
// NuVizz answering "no such stop" (404) is an ANSWER, not a failure: the number-probe descent is
// built on asking about numbers that mostly do not exist, so counting those would mark every
// healthy descent incomplete — and an always-incomplete descent never prunes and never lets the
// nightly capture seal a day.
//
// No network: the Firestore fake's onOther is the vendor.
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.NUVIZZ_BREAKER_MODE;

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
const ET_TODAY = etDayString();
const TOMORROW_UTC = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let vendorCalls = 0;
const vendor404 = async (url) => {
  const u = String(url);
  if (!u.includes('nuvizz')) throw new Error(`blocked non-vendor url ${u.slice(0, 80)}`);
  vendorCalls++;
  return new Response('{}', { status: 404 });
};

test('NuVizz answering "no such stop" (404) to every probe is an ANSWER — the descent stays complete', async () => {
  vendorCalls = 0;
  installFirestoreFake({}, vendor404);
  const { scanDate } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const fwd = await scanDate(ET_TODAY, { includeLoads: false, forwardUnplanned: { start: 7_200_000 } });
  assert.ok(vendorCalls > 0, 'the probes really went to the (fake) vendor');
  assert.equal(fwd.descentComplete, true);
  assert.equal(fwd.descentProbeFailures, 0);
  const full = await scanDate(TOMORROW_UTC, { includeLoads: false });
  assert.equal(full.descentComplete, true);
  assert.equal(full.descentProbeFailures, 0);
});
