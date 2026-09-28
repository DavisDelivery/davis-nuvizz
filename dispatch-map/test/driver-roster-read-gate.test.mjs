// test/driver-roster-read-gate.test.mjs — the Drivers view's roster read (X-authgates-3).
//
// The roster read served every Davis user's phone, CDL number, licence state and licence
// expiry to anyone who asked: only the ?refresh=1 branch called the gate, and the plain GET
// the Drivers view makes had none — so it stayed open even after AUTH_REQUIRED=true. The read
// is now gated at viewer (like messaging-roster and driver-phone, which carry the same phone
// numbers), and the licence fields are stripped on the way out, the way the root proxy's
// publicRosterUser already strips them. The stored roster document keeps what NuVizz sent.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests } from '../netlify/functions/lib/require-user.mts';
import roster, { publicRosterUser } from '../netlify/functions/nuvizz-driver-roster.mts';

const VIEWER = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });
const URL_READ = 'https://x.netlify.app/.netlify/functions/nuvizz-driver-roster?tenant=davis';

// The shape normalizeRosterUser stores (see nuvizz-driver-roster.mts), with the licence fields.
const JIM = {
  userName: 'JIM', userId: 1883, id: 'u1', name: 'Jim Pallette', firstName: 'Jim', lastName: 'Pallette',
  email: 'jim@x', mobileNumber: '555-0100', cdlNumber: 'CDL123', licenseState: 'GA',
  licenseExpirationDttm: '2027-01-01T00:00:00', status: 'ENABLED', isEnabled: true, userType: null,
  roles: ['DI_Driver'], isDriver: true, startDate: null, city: null, state: null, lastUpdateDTTM: null,
};
const SEED = {
  'app_users/ro': VIEWER,
  'nuvizzRoster/davis': { users: [JIM], totalUsers: 1, driverCount: 1, _updatedAt: '2026-09-01T12:00:00.000Z' },
};

async function withFake(authRequired, fn) {
  if (authRequired) process.env.AUTH_REQUIRED = 'true'; else delete process.env.AUTH_REQUIRED;
  _resetUserCacheForTests();
  const fake = installFirestoreFake(SEED);   // no onOther: any NuVizz call throws
  try { return await fn(fake); } finally { fake.restore(); delete process.env.AUTH_REQUIRED; }
}

test('once sign-in is required, a signed-out caller cannot read every driver\'s phone and CDL off the roster', async () => {
  await withFake(true, async (fake) => {
    const r = await roster(new Request(URL_READ));
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.ok(!/CDL123|555-0100/.test(body), 'nothing from the roster leaves with the refusal');
    assert.equal(fake.log.other.length, 0);
  });
});

test('a signed-in viewer opening the Drivers view gets names and phones, never a CDL number, licence state or expiry', async () => {
  await withFake(true, async (fake) => {
    const r = await roster(new Request(URL_READ, { headers: bearer(VIEWER) }));
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.driverCount, 1);
    const [jim] = d.drivers;
    // What RoutingDriversPanel (App.jsx) actually reads survives.
    for (const k of ['userName', 'name', 'status', 'mobileNumber']) assert.equal(jim[k], JIM[k], k);
    for (const k of ['cdlNumber', 'licenseState', 'licenseExpirationDttm']) assert.equal(k in jim, false, `${k} must not leave`);
    assert.equal(fake.log.other.length, 0, 'the read spends zero NuVizz calls');
  });
});

test('before the switch flips, the board still reads the roster — but the licence fields are already gone', async () => {
  await withFake(false, async () => {
    const r = await roster(new Request(URL_READ));
    assert.equal(r.status, 200);
    const [jim] = (await r.json()).drivers;
    assert.equal(jim.mobileNumber, '555-0100');
    assert.equal('cdlNumber' in jim, false);
  });
});

test('the Update list refresh is still a dispatcher\'s act — a viewer is refused before any NuVizz call', async () => {
  await withFake(true, async (fake) => {
    const r = await roster(new Request(`${URL_READ}&refresh=1`, { method: 'POST', headers: bearer(VIEWER) }));
    assert.equal(r.status, 403);
    assert.equal(fake.log.other.length, 0);
  });
});

test('publicRosterUser strips every licence/CDL-named field by name and by pattern, without mutating the stored record', () => {
  const u = { ...JIM, licenseClass: 'A' };
  const out = publicRosterUser(u);
  for (const k of ['cdlNumber', 'licenseState', 'licenseExpirationDttm', 'licenseClass']) assert.equal(k in out, false, k);
  assert.equal(out.mobileNumber, '555-0100');
  assert.equal(u.cdlNumber, 'CDL123', 'input is not mutated');
  assert.equal(publicRosterUser(null), null);
});
