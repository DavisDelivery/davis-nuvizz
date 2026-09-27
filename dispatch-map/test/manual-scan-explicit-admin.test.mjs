// test/manual-scan-explicit-admin.test.mjs — X-authgates-4.
//
// nuvizz-manual-scan (the synchronous Scan-now fallback) copies the caller's whole query string
// into runRefreshStops. `?date=` or `?days=` there sets `explicit` and runs the forced
// number-probe scan — the ~3,000-call cold scan CLAUDE.md's cost rule exists to forbid — and the
// only gate was dispatcher. nuvizz-refresh-stops-background already holds exactly those two
// parameters at ADMIN (gateScheduledOverride), so this endpoint was a dispatcher-level side door
// to the scan its sibling locks. Now the explicit branch is admin; the plain press (App.jsx
// sends no query string) stays dispatcher; and with AUTH_REQUIRED off nothing changes at all.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import manualScan from '../netlify/functions/nuvizz-manual-scan.mts';

const DISPATCHER = { username: 'tina', displayName: 'Tina', role: 'dispatcher', active: true, tokenVersion: 0 };
const ADMIN = { username: 'ada', displayName: 'Ada', role: 'admin', active: true, tokenVersion: 0 };
const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
const post = (qs, headers = {}) =>
  new Request(`https://x.netlify.app/.netlify/functions/nuvizz-manual-scan${qs}`, { method: 'POST', headers });

// Firestore is the in-memory fake (no onOther: ANY NuVizz call throws). The scan kill switch is
// thrown so a request that gets PAST the gate stops inside runRefreshStops at 'scans-disabled'
// instead of scanning — which makes "got past the gate" visible without spending anything.
async function enforcing(fn) {
  process.env.AUTH_REQUIRED = 'true';
  process.env.NUVIZZ_SCANS_ENABLED = 'false';
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const fake = installFirestoreFake({ 'app_users/tina': DISPATCHER, 'app_users/ada': ADMIN });
  try { return await fn(fake); } finally {
    fake.restore();
    delete process.env.AUTH_REQUIRED;
    delete process.env.NUVIZZ_SCANS_ENABLED;
  }
}

test('a dispatcher cannot start the ~3,000-call explicit-date scan through the Scan-now fallback', async () => {
  await enforcing(async (fake) => {
    for (const qs of ['?date=2026-09-01', '?days=3', '?days=', '?date=2026-09-01&days=31']) {
      const r = await manualScan(post(qs, bearer(DISPATCHER)));
      assert.equal(r.status, 403, `${qs} must be refused below admin`);
      assert.match((await r.json()).error, /requires admin/);
    }
    assert.equal(fake.log.other.length, 0, 'no NuVizz call');
    assert.equal(fake.log.sets.length + fake.log.commits.length, 0, 'and the run never started — no scan-run row, no state write');
  });
});

test('the Scan-now button\'s own fallback press (no query string) is still a dispatcher\'s act', async () => {
  await enforcing(async (fake) => {
    const r = await manualScan(post('', bearer(DISPATCHER)));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).skipped, 'scans-disabled', 'past the gate and into the run');
    assert.equal(fake.log.other.length, 0);
  });
});

test('an admin\'s explicit-date scan still gets through — Chad\'s hand-run ?date= scan stays', async () => {
  await enforcing(async (fake) => {
    const r = await manualScan(post('?date=2026-09-01', bearer(ADMIN)));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).skipped, 'scans-disabled', 'past the gate and into the run');
    assert.equal(fake.log.other.length, 0);
  });
});

test('signed out once sign-in is required: refused before anything runs', async () => {
  await enforcing(async (fake) => {
    assert.equal((await manualScan(post('?date=2026-09-01'))).status, 401);
    assert.equal(fake.log.other.length, 0);
  });
});
