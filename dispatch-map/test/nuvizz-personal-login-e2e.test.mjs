// test/nuvizz-personal-login-e2e.test.mjs — personal NuVizz logins, end to end.
//
// Real handlers (auth-nuvizz-login, nuvizz-write), real session tokens, real sealing — over an
// in-memory Firestore and a fake NuVizz that records WHOSE credentials every call carried. The
// question every test here answers is the one Chad asked: does a dispatcher's change go to NuVizz
// under the dispatcher's own login, instead of his?
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
import loginHandler from '../netlify/functions/auth-nuvizz-login.mts';
import writeHandler from '../netlify/functions/nuvizz-write.mts';

// NuVizz's user directory, as far as this test is concerned.
const NUVIZZ_USERS = { sharednv: 'shared-pw', jdoe: 'jane-pw', msmith: 'mike-pw' };
const HEX = '6a438e9d52ef82bd1ed4516b';

const USERS = {
  owner: { username: 'owner', displayName: 'The Owner', role: 'admin', active: true, tokenVersion: 0 },
  jane: { username: 'jane', displayName: 'Jane Doe', role: 'dispatcher', active: true, tokenVersion: 0 },
  mike: { username: 'mike', displayName: 'Mike Smith', role: 'dispatcher', active: true, tokenVersion: 0 },
};

function whoFromBasic(h) {
  const m = /^Basic\s+(.+)$/i.exec(String(h || ''));
  if (!m) return null;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return { user: u, pass: rest.join(':') };
}

// A NuVizz that checks every credential it is handed and remembers who made each call.
function fakeNuvizz() {
  const calls = [];
  const handler = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const h = init.headers || {};
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    const T = (t, s = 200) => new Response(t, { status: s });
    // ── portal sign-in ──
    if (url.startsWith('https://login.test/loginreg/') && method === 'GET') { calls.push({ kind: 'portal-page' }); return T('<meta name="_csrf" content="c"><meta name="_csrf_header" content="X-CSRF-TOKEN">'); }
    if (url.includes('checkCompanyLogin')) { calls.push({ kind: 'portal-company' }); return J({ ok: true }); }
    if (url.includes('auth/userLogin')) {
      const u = init.body?.get?.('username'); const p = init.body?.get?.('password');
      calls.push({ kind: 'portal-signin', as: u });
      return NUVIZZ_USERS[u] && NUVIZZ_USERS[u] === p ? J({ data: { jwtToken: `jwt-${u}` } }) : J({ success: false, message: 'Invalid username or password' });
    }
    if (url.includes('/authtoken/')) { const jwt = JSON.parse(String(init.body)).password; calls.push({ kind: 'portal-token', as: jwt.slice(4) }); return J({ authToken: `tok-${jwt.slice(4)}` }); }
    // ── the v7 API (Basic auth on every call) ──
    const cred = whoFromBasic(h.Authorization ?? h.authorization);
    const good = cred && NUVIZZ_USERS[cred.user] === cred.pass;
    if (url.includes('/load/info/')) { calls.push({ kind: 'v7-read', as: cred?.user, ok: !!good }); return good ? J({}, 404) : J({ message: 'Unauthorized' }, 401); }
    if (url.includes('/load/assignanddispatch/')) { calls.push({ kind: 'v7-assign', as: cred?.user, ok: !!good }); return good ? J({ status: 'SUCCESS' }) : J({ message: 'Unauthorized' }, 401); }
    calls.push({ kind: 'other', url });
    return J({});
  };
  return { calls, handler };
}

const seedUsers = (extra = {}) => Object.fromEntries(Object.entries(USERS).map(([k, u]) => [`app_users/${k}`, { ...u, ...(extra[k] || {}) }]));
const bearer = (u) => `Bearer ${issueSessionToken(USERS[u]).token}`;
const LOGIN_URL = 'http://localhost/.netlify/functions/auth-nuvizz-login';
const WRITE_URL = 'http://localhost/.netlify/functions/nuvizz-write';
const loginPost = (as, body) => loginHandler(new Request(LOGIN_URL, { method: 'POST', headers: { authorization: bearer(as), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const loginGet = (as, q = '') => loginHandler(new Request(`${LOGIN_URL}${q}`, { method: 'GET', headers: as ? { authorization: bearer(as) } : {} }));
const assign = (as, extraBody = {}) => writeHandler(new Request(WRITE_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(as ? { authorization: bearer(as) } : {}) },
  body: JSON.stringify({ op: 'assignDriver', payload: { loadId: HEX, driverId: 7 }, clientOpId: `op-${crypto.randomUUID()}`, createdBy: 'dispatcher', ...extraBody }),
}));

async function world(extra, fn) {
  _resetUserCacheForTests();
  _resetThrottleForTests();
  _resetRwbSessions();
  const nv = fakeNuvizz();
  const fake = installFirestoreFake(seedUsers(extra), nv.handler);
  try { return await fn({ fake, nv }); } finally { fake.restore(); }
}
async function withMode(mode, fn) {
  const prev = process.env.NUVIZZ_PERSONAL_LOGINS;
  if (mode == null) delete process.env.NUVIZZ_PERSONAL_LOGINS; else process.env.NUVIZZ_PERSONAL_LOGINS = mode;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.NUVIZZ_PERSONAL_LOGINS; else process.env.NUVIZZ_PERSONAL_LOGINS = prev; }
}

// ── saving a login ───────────────────────────────────────────────────────────

test('Jane saves her own NuVizz login: tested as HER, sealed, and never handed back', async () => {
  await world({}, async ({ fake, nv }) => {
    const res = await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.login.saved, true);
    assert.equal(j.login.username, 'jdoe');
    assert.equal(j.login.savedBy, 'jane');
    assert.equal(j.check.portal, 'ok');
    assert.equal(j.check.api, 'ok');
    assert.equal(j.check.apiStatus, 404, 'the check reads a load that cannot exist');
    assert.equal(j.check.calls, 5, '4 portal + 1 API — measured, and what the button says');
    // Every NuVizz call the test made was made AS jdoe.
    assert.deepEqual(nv.calls.filter((c) => c.as).map((c) => c.as), ['jdoe', 'jdoe', 'jdoe']);
    // Stored sealed; the password is nowhere in the document or the answer.
    const stored = fake.store.get('app_users/jane');
    assert.match(stored.nuvizzPasswordSealed, /^v1\./);
    assert.ok(!JSON.stringify(stored).includes('jane-pw'));
    assert.ok(!JSON.stringify(j).includes('jane-pw'));
    assert.ok(!JSON.stringify(j).includes(stored.nuvizzPasswordSealed), 'not even the ciphertext reaches a browser');
    // The dispatch-map password fields were not touched by the masked write.
    assert.equal(stored.role, 'dispatcher');
    assert.equal(stored.tokenVersion, 0);
  });
});

test('a wrong NuVizz password is NOT saved, and the API is not asked a second time', async () => {
  await world({}, async ({ fake, nv }) => {
    const res = await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'typo' });
    const j = await res.json();
    assert.equal(res.status, 422);
    assert.match(j.error, /nothing was saved/);
    assert.match(j.error, /lock the NuVizz account/);
    assert.equal(j.check.portal, 'refused');
    assert.equal(j.check.api, 'skipped');
    assert.equal(nv.calls.filter((c) => c.kind === 'v7-read').length, 0, 'one wrong attempt at NuVizz, not two');
    assert.equal(fake.store.get('app_users/jane').nuvizzUsername, undefined);
  });
});

test('The owner (admin) sets Mike\'s login; Mike cannot touch Jane\'s', async () => {
  await world({}, async ({ fake }) => {
    const res = await loginPost('owner', { action: 'save', username: 'mike', nuvizzUsername: 'msmith', nuvizzPassword: 'mike-pw' });
    assert.equal(res.status, 200);
    assert.equal(fake.store.get('app_users/mike').nuvizzSavedBy, 'owner');
    const denied = await loginPost('mike', { action: 'save', username: 'jane', nuvizzUsername: 'msmith', nuvizzPassword: 'mike-pw' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'requires admin');
    const peek = await loginGet('mike', '?username=jane');
    assert.equal(peek.status, 403);
  });
});

test('no session: refused, but the screen can still learn which mode the switch is in', async () => {
  await world({}, async () => {
    const res = await loginGet(null);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.mode, 'preferred');
    assert.equal(j.login, undefined);
  });
});

test('remove clears the login and nothing else', async () => {
  await world({}, async ({ fake }) => {
    await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    const res = await loginPost('jane', { action: 'remove' });
    assert.equal(res.status, 200);
    const d = fake.store.get('app_users/jane');
    assert.equal(d.nuvizzUsername, null);
    assert.equal(d.nuvizzPasswordSealed, null);
    assert.equal(d.displayName, 'Jane Doe');
    assert.equal((await res.json()).login.saved, false);
  });
});

// ── writing under it ─────────────────────────────────────────────────────────

test('THE ASK: Jane assigns a driver and NuVizz sees jdoe, not the shared login', async () => {
  await world({}, async ({ fake, nv }) => {
    await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    nv.calls.length = 0;
    const res = await assign('jane');
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.deepEqual(nv.calls.filter((c) => c.kind === 'v7-assign').map((c) => c.as), ['jdoe']);
    assert.deepEqual(j.identity, { mode: 'preferred', as: 'personal', appUser: 'jane', nuvizzUser: 'jdoe' });
    assert.ok(!JSON.stringify(j).includes('jane-pw'));
    // Our own ledger names her too — the person AND the NuVizz login.
    const rec = [...fake.store.entries()].find(([k]) => k.includes('op-') && k.startsWith('nuvizz_write_ops'));
    assert.ok(rec, 'the op record was written');
    assert.equal(rec[1].by, 'jane');
    assert.equal(rec[1].nuvizzAs, 'jdoe');
  });
});

test('preferred: Mike has nothing saved — his write goes out as the shared login, and SAYS so', async () => {
  await world({}, async ({ nv }) => {
    const res = await assign('mike');
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(nv.calls.filter((c) => c.kind === 'v7-assign').map((c) => c.as), ['sharednv']);
    assert.equal(j.identity.as, 'shared');
    assert.equal(j.identity.why, 'not-saved');
    assert.match(j.identity.note, /No NuVizz login is saved for Mike Smith/);
  });
});

test('required: Mike has nothing saved — refused BEFORE any NuVizz call', async () => {
  await withMode('required', () => world({}, async ({ nv }) => {
    const res = await assign('mike');
    const j = await res.json();
    assert.equal(res.status, 403);
    assert.match(j.error, /No NuVizz login is saved for Mike Smith/);
    assert.equal(j.identity.as, 'refused');
    assert.equal(nv.calls.length, 0);
  }));
});

test('required: the pre-login caller (no session) is refused too — "required" means required', async () => {
  await withMode('required', () => world({}, async ({ nv }) => {
    const res = await assign(null);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /sign in under Account & logins/);
    assert.equal(nv.calls.length, 0);
  }));
});

test('off: even with a saved login, every write is the shared login — exactly as before', async () => {
  await withMode('off', () => world({}, async ({ nv }) => {
    await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    nv.calls.length = 0;
    const res = await assign('jane');
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(nv.calls.filter((c) => c.kind === 'v7-assign').map((c) => c.as), ['sharednv']);
    assert.equal(j.identity.as, 'shared');
    assert.equal(j.identity.why, 'off');
  }));
});

test('the pre-login caller under preferred: the shared login, exactly as today', async () => {
  await world({}, async ({ nv }) => {
    const res = await assign(null);
    assert.equal(res.status, 200);
    assert.deepEqual(nv.calls.filter((c) => c.kind === 'v7-assign').map((c) => c.as), ['sharednv']);
  });
});

// ── the night the password changed ───────────────────────────────────────────

test('NuVizz refuses Jane\'s saved login mid-write: marked on her account, and the NEXT write never tries it', async () => {
  await world({}, async ({ fake, nv }) => {
    await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    // Jane changes her password in the NuVizz portal and forgets the copy saved here.
    NUVIZZ_USERS.jdoe = 'jane-NEW-pw';
    try {
      nv.calls.length = 0;
      const first = await assign('jane');
      const j1 = await first.json();
      assert.equal(first.ok, false);
      assert.match(j1.loginRefused, /401/);
      const doc = fake.store.get('app_users/jane');
      assert.ok(doc.nuvizzRejectedAt, 'the refusal is recorded on her account');
      assert.equal(nv.calls.filter((c) => c.as === 'jdoe').length, 1, 'one wrong attempt');

      nv.calls.length = 0;
      const second = await assign('jane');
      const j2 = await second.json();
      assert.equal(second.status, 200, 'preferred: the board keeps moving on the shared login');
      assert.equal(nv.calls.filter((c) => c.as === 'jdoe').length, 0, 'her stale password is not sent again');
      assert.equal(j2.identity.why, 'rejected');
      assert.match(j2.identity.note, /NuVizz refused the login saved for Jane Doe/);

      // She re-enters the new one: tested, saved, refusal cleared, and she writes as herself again.
      const fix = await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-NEW-pw' });
      assert.equal(fix.status, 200);
      assert.equal(fake.store.get('app_users/jane').nuvizzRejectedAt, null);
      nv.calls.length = 0;
      await assign('jane');
      assert.deepEqual(nv.calls.filter((c) => c.kind === 'v7-assign').map((c) => c.as), ['jdoe']);
    } finally { NUVIZZ_USERS.jdoe = 'jane-pw'; }
  });
});

test('Test on a saved login that NuVizz now refuses takes it out of service; a good Test puts it back', async () => {
  await world({}, async ({ fake }) => {
    await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    NUVIZZ_USERS.jdoe = 'changed';
    try {
      const t1 = await (await loginPost('jane', { action: 'test' })).json();
      assert.equal(t1.check.portal, 'refused');
      assert.ok(fake.store.get('app_users/jane').nuvizzRejectedAt);
      assert.ok(t1.login.rejected);
    } finally { NUVIZZ_USERS.jdoe = 'jane-pw'; }
    _resetRwbSessions();   // a new instance: the in-memory hold does not follow her there
    const t2 = await (await loginPost('jane', { action: 'test' })).json();
    assert.equal(t2.check.portal, 'ok');
    assert.equal(fake.store.get('app_users/jane').nuvizzRejectedAt, null);
    assert.equal(t2.login.rejected, null);
  });
});

test('too many tests of one account are refused before NuVizz is asked', async () => {
  await world({}, async ({ nv }) => {
    for (let i = 0; i < 3; i++) await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: `wrong-${i}` });
    const before = nv.calls.length;
    const res = await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'wrong-5' });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /lock the NuVizz account/);
    assert.equal(nv.calls.length, before);
  });
});

// ── one person, one NuVizz login ─────────────────────────────────────────────

test('a NuVizz login already saved for someone else is refused — named, and NuVizz is never asked', async () => {
  await world({}, async ({ nv }) => {
    await loginPost('owner', { action: 'save', username: 'mike', nuvizzUsername: 'msmith', nuvizzPassword: 'mike-pw' });
    nv.calls.length = 0;
    const res = await loginPost('jane', { action: 'save', nuvizzUsername: 'MSmith', nuvizzPassword: 'mike-pw' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already saved for Mike Smith/);
    assert.equal(nv.calls.length, 0);
  });
});

test('the shared login is not a dispatcher\'s personal login; the admin may save it as their own', async () => {
  await world({}, async ({ fake, nv }) => {
    const res = await loginPost('jane', { action: 'save', nuvizzUsername: 'sharednv', nuvizzPassword: 'shared-pw' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /shared NuVizz login the board has been using/);
    assert.equal(nv.calls.length, 0, 'refused before any NuVizz call');
    const own = await loginPost('owner', { action: 'save', nuvizzUsername: 'sharednv', nuvizzPassword: 'shared-pw' });
    assert.equal(own.status, 200);
    assert.equal(fake.store.get('app_users/owner').nuvizzUsername, 'sharednv');
  });
});

test('off: the login door neither saves nor tests — no NuVizz call — but seeing and removing still work', async () => {
  await world({}, async ({ nv }) => {
    await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
    nv.calls.length = 0;
    await withMode('off', async () => {
      const save = await loginPost('jane', { action: 'save', nuvizzUsername: 'jdoe', nuvizzPassword: 'jane-pw' });
      assert.equal(save.status, 409);
      assert.match((await save.json()).error, /switched off/);
      assert.equal((await loginPost('jane', { action: 'test' })).status, 409);
      assert.equal(nv.calls.length, 0);
      const seen = await (await loginGet('jane')).json();
      assert.equal(seen.mode, 'off');
      assert.equal(seen.login.saved, true);
      assert.equal((await loginPost('jane', { action: 'remove' })).status, 200);
    });
  });
});
