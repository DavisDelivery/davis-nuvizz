// test/nuvizz-write-stale-hold.test.mjs — a login that re-tested OK is not failed from a stale hold.
//
// Audit 2026-09-27 (nuvizz-write-3). When NuVizz refuses a personal login, the write function
// holds that exact username+password in its own warm process for 10 minutes so a stale password
// is not tried again and again (a NuVizz lockout). The person then presses Test — which runs in
// auth-nuvizz-login, a SEPARATE function — NuVizz accepts it, and the refusal is cleared on the
// account. The write process never heard: the next Save read the account fresh, chose the personal
// login, and was then failed locally from the stale hold without asking NuVizz, and the account
// was marked refused AGAIN with "NuVizz answered 401" — a sentence about a call never sent.
//
// Real handlers over the Firestore fake and a fake NuVizz. The Test in the other process is
// simulated by writing exactly the fields auth-nuvizz-login writes on a passing test, because in
// one test process both handlers share one module instance and a real Test would clear the hold
// here — the very thing that does NOT happen in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({ project_id: 'testproj', client_email: 'sa@testproj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
process.env.NUVIZZ_WRITE_ENABLED = 'true';
process.env.NUVIZZ_DAVIS_USER = 'sharednv';
process.env.NUVIZZ_DAVIS_PASS = 'shared-pw';
process.env.NUVIZZ_RWB_ENABLED = 'true';
process.env.NUVIZZ_RWB_USER = 'sharednv';
process.env.NUVIZZ_RWB_PASS = 'shared-pw';
process.env.NUVIZZ_RWB_LOGIN_BASE = 'https://login.test';
process.env.NUVIZZ_RWB_PORTAL_BASE = 'https://portal.test';
process.env.NUVIZZ_LOGIN_KEY = 'e2e-test-key';
delete process.env.AUTH_REQUIRED;
delete process.env.NUVIZZ_PERSONAL_LOGINS;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import { _resetRwbSessions } from '../netlify/functions/lib/nuvizz-rwb.mts';
import { passingCheckAt } from '../netlify/functions/lib/nuvizz-write-identity.mts';
import loginHandler from '../netlify/functions/auth-nuvizz-login.mts';
import writeHandler from '../netlify/functions/nuvizz-write.mts';

const NUVIZZ_USERS = { sharednv: 'shared-pw', jdoe: 'jane-pw' };
const HEX = '6a438e9d52ef82bd1ed4516b';
const JANE = { username: 'jane', displayName: 'Jane Doe', role: 'dispatcher', active: true, tokenVersion: 0 };

function whoFromBasic(h) {
  const m = /^Basic\s+(.+)$/i.exec(String(h || ''));
  if (!m) return null;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return { user: u, pass: rest.join(':') };
}
function fakeNuvizz() {
  const calls = [];
  const handler = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const h = init.headers || {};
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    const T = (t, s = 200) => new Response(t, { status: s });
    if (url.startsWith('https://login.test/loginreg/') && method === 'GET') { calls.push({ kind: 'portal-page' }); return T('<meta name="_csrf" content="c"><meta name="_csrf_header" content="X-CSRF-TOKEN">'); }
    if (url.includes('checkCompanyLogin')) { calls.push({ kind: 'portal-company' }); return J({ ok: true }); }
    if (url.includes('auth/userLogin')) {
      const u = init.body?.get?.('username'); const p = init.body?.get?.('password');
      calls.push({ kind: 'portal-signin', as: u });
      return NUVIZZ_USERS[u] && NUVIZZ_USERS[u] === p ? J({ data: { jwtToken: `jwt-${u}` } }) : J({ success: false, message: 'Invalid username or password' });
    }
    if (url.includes('/authtoken/')) { const jwt = JSON.parse(String(init.body)).password; calls.push({ kind: 'portal-token', as: jwt.slice(4) }); return J({ authToken: `tok-${jwt.slice(4)}` }); }
    const cred = whoFromBasic(h.Authorization ?? h.authorization);
    const good = cred && NUVIZZ_USERS[cred.user] === cred.pass;
    if (url.includes('/load/info/')) { calls.push({ kind: 'v7-read', as: cred?.user, ok: !!good }); return good ? J({}, 404) : J({ message: 'Unauthorized' }, 401); }
    if (url.includes('/load/assignanddispatch/')) { calls.push({ kind: 'v7-assign', as: cred?.user, ok: !!good }); return good ? J({ status: 'SUCCESS' }) : J({ message: 'Unauthorized' }, 401); }
    calls.push({ kind: 'other', url });
    return J({});
  };
  return { calls, handler };
}

const bearer = () => `Bearer ${issueSessionToken(JANE).token}`;
const loginPost = (body) => loginHandler(new Request('http://localhost/.netlify/functions/auth-nuvizz-login', { method: 'POST', headers: { authorization: bearer(), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const assign = async () => {
  const r = await writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: bearer() },
    body: JSON.stringify({ op: 'assignDriver', payload: { loadId: HEX, driverId: 7 }, clientOpId: `op-${crypto.randomUUID()}`, createdBy: 'dispatcher' }),
  }));
  return { status: r.status, body: await r.json() };
};

// Jane's saved login is refused once by NuVizz on a Save (her NuVizz account locked, say): the
// write process now holds it, and her account is marked refused.
async function refusedOnce() {
  _resetUserCacheForTests(); _resetThrottleForTests(); _resetRwbSessions();
  NUVIZZ_USERS.jdoe = 'jane-pw';
  const nv = fakeNuvizz();
  const fake = installFirestoreFake({ 'app_users/jane': JANE }, nv.handler);
  const saved = await loginPost({ action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
  assert.equal(saved.status, 200);
  NUVIZZ_USERS.jdoe = 'LOCKED-OUT';
  const first = await assign();
  assert.equal(first.body.identity?.as, 'personal');
  assert.match(String(first.body.loginRefused), /401/);
  assert.ok(fake.store.get('app_users/jane').nuvizzRejectedAt, 'the refusal is on her account');
  return { nv, fake };
}

test('a NuVizz login that re-tested OK after a refusal goes out on the next Save, not failed from a stale hold', async () => {
  const { nv, fake } = await refusedOnce();
  try {
    // NuVizz unlocks her account (same password), and she presses Test — in the OTHER function.
    NUVIZZ_USERS.jdoe = 'jane-pw';
    const doc = fake.store.get('app_users/jane');
    fake.store.set('app_users/jane', { ...doc, nuvizzRejectedAt: null, nuvizzRejectedReason: null, nuvizzCheck: { at: new Date(Date.now() + 1).toISOString(), api: 'ok', portal: 'ok' } });
    _resetUserCacheForTests();

    const before = nv.calls.length;
    const { status, body } = await assign();
    const sent = nv.calls.slice(before).filter((c) => c.kind === 'v7-assign');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.identity?.as, 'personal', 'it went out as Jane');
    assert.equal(sent.length, 1, 'NuVizz was actually asked');
    assert.equal(sent[0].as, 'jdoe');
    assert.equal(body.loginRefused, undefined, 'no refusal is claimed');
    assert.equal(fake.store.get('app_users/jane').nuvizzRejectedAt, null, 'the login that just tested OK is not taken out of service again');
  } finally { fake.restore(); }
});

test('a refused NuVizz login nobody has re-tested is still not tried again on this instance', async () => {
  const { nv, fake } = await refusedOnce();
  try {
    // The mark is gone (as when marking the account failed) but NO passing check came after the
    // refusal: the only passing check on file is the one from when the login was first saved.
    NUVIZZ_USERS.jdoe = 'jane-pw';
    const doc = fake.store.get('app_users/jane');
    fake.store.set('app_users/jane', { ...doc, nuvizzRejectedAt: null, nuvizzRejectedReason: null });
    _resetUserCacheForTests();

    const before = nv.calls.length;
    const { body } = await assign();
    const sentAsJane = nv.calls.slice(before).filter((c) => c.as === 'jdoe');
    assert.equal(body.ok, false);
    assert.equal(sentAsJane.length, 0, 'the lockout brake holds — the same password is not sent again within the hold');
  } finally { fake.restore(); }
});

test('passingCheckAt: only a check that refused nothing and passed somewhere clears a hold', () => {
  const at = '2026-09-27T12:00:00.000Z';
  assert.equal(passingCheckAt({ nuvizzCheck: { at, api: 'ok', portal: 'ok' } }), at);
  assert.equal(passingCheckAt({ nuvizzCheck: { at, api: 'skipped', portal: 'ok' } }), at);
  assert.equal(passingCheckAt({ nuvizzCheck: { at, api: 'refused', portal: 'ok' } }), null, 'a refusal anywhere is not a pass');
  assert.equal(passingCheckAt({ nuvizzCheck: { at, api: 'unknown', portal: 'unknown' } }), null, 'no clear answer is not a pass');
  assert.equal(passingCheckAt({ nuvizzCheck: { at: 'not a time', api: 'ok', portal: 'ok' } }), null);
  assert.equal(passingCheckAt({}), null);
  assert.equal(passingCheckAt(null), null);
});
