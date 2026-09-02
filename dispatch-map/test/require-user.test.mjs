// THE GATE EVERY WRITING FUNCTION WILL CALL — pinned in both modes.
//
// Inert mode (AUTH_REQUIRED unset) must let a token-less request through as the legacy
// principal, because eighty functions get wired to this before a single dispatcher has an
// account. Enforced mode must refuse it. In BOTH modes a token that is present is checked
// for real: signature, expiry, the live user's active flag, and the tokenVersion — so a
// deactivated or demoted user is cut off on the next request, not at token expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

const { issueSessionToken } = await import('../netlify/functions/lib/auth-core.mts');
const {
  requireUser, authRequired, LEGACY_PRINCIPAL, throttled, _resetThrottleForTests, readJsonBody,
} = await import('../netlify/functions/lib/require-user.mts');

const USERS = {
  lead: { username: 'lead', displayName: 'Lead', role: 'admin', active: true, tokenVersion: 2 },
  tina: { username: 'tina', displayName: 'Tina', role: 'dispatcher', active: true, tokenVersion: 0 },
  gone: { username: 'gone', displayName: 'Gone', role: 'dispatcher', active: false, tokenVersion: 0 },
  ro:   { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 },
};
const deps = { getUser: async (u) => USERS[u] || null };
const req = (token) => new Request('https://x.test/.netlify/functions/y', { headers: token ? { authorization: `Bearer ${token}` } : {} });
const tokenFor = (u, tv = USERS[u].tokenVersion) => issueSessionToken({ ...USERS[u], tokenVersion: tv }).token;

test('inert mode: no token → the legacy principal (today\'s behaviour, unchanged)', async () => {
  delete process.env.AUTH_REQUIRED;
  assert.equal(authRequired(), false);
  const r = await requireUser(req(null), { deps });
  assert.ok(r.ok);
  assert.equal(r.user, LEGACY_PRINCIPAL);
  assert.equal(r.user.role, 'admin');
  assert.equal(r.user.authenticated, false);
});

test('inert mode: a VALID token is honoured and identifies the caller', async () => {
  delete process.env.AUTH_REQUIRED;
  const r = await requireUser(req(tokenFor('tina')), { deps });
  assert.ok(r.ok);
  assert.equal(r.user.username, 'tina');
  assert.equal(r.user.role, 'dispatcher');
  assert.equal(r.user.authenticated, true);
});

test('inert mode: a BAD token is refused rather than downgraded to legacy', async () => {
  delete process.env.AUTH_REQUIRED;
  const r = await requireUser(req('not.a.token'), { deps });
  assert.ok(!r.ok);
  assert.equal(r.response.status, 401);
});

test('enforced mode: no token → 401 with WWW-Authenticate', async () => {
  process.env.AUTH_REQUIRED = 'true';
  const r = await requireUser(req(null), { deps });
  assert.ok(!r.ok);
  assert.equal(r.response.status, 401);
  assert.equal(r.response.headers.get('www-authenticate'), 'Bearer');
  delete process.env.AUTH_REQUIRED;
});

test('strict endpoints enforce even when the site switch is off (user admin is never anonymous)', async () => {
  delete process.env.AUTH_REQUIRED;
  const r = await requireUser(req(null), { deps, strict: true });
  assert.ok(!r.ok);
  assert.equal(r.response.status, 401);
});

test('a deactivated user\'s still-valid token is refused on the next request', async () => {
  const r = await requireUser(req(tokenFor('gone')), { deps });
  assert.ok(!r.ok);
  assert.equal(r.response.status, 401);
  assert.equal(r.reason, 'inactive');
});

test('a token from before "sign out everywhere" / a password change is refused (tokenVersion)', async () => {
  const stale = tokenFor('lead', 1); // store says 2
  const r = await requireUser(req(stale), { deps });
  assert.ok(!r.ok);
  assert.equal(r.reason, 'revoked');
  const fresh = await requireUser(req(tokenFor('lead', 2)), { deps });
  assert.ok(fresh.ok);
});

test('role is read from the STORE, not the token, and the minimum role is enforced', async () => {
  // A viewer's token that claims admin: the store wins.
  const forgedClaims = issueSessionToken({ ...USERS.ro, role: 'admin' }).token;
  const r = await requireUser(req(forgedClaims), { deps, role: 'dispatcher' });
  assert.ok(!r.ok);
  assert.equal(r.response.status, 403);
  const ok = await requireUser(req(tokenFor('tina')), { deps, role: 'dispatcher' });
  assert.ok(ok.ok);
  const admin = await requireUser(req(tokenFor('tina')), { deps, role: 'admin' });
  assert.equal(admin.ok, false);
});

test('an unknown username in a validly signed token is refused', async () => {
  const t = issueSessionToken({ username: 'nobody', role: 'admin', tokenVersion: 0 }).token;
  const r = await requireUser(req(t), { deps });
  assert.ok(!r.ok);
});

test('store failure: fail CLOSED when enforcing, legacy when inert', async () => {
  const broken = { getUser: async () => { throw new Error('firestore down'); } };
  delete process.env.AUTH_REQUIRED;
  const inert = await requireUser(req(tokenFor('tina')), { deps: broken });
  assert.ok(inert.ok); assert.equal(inert.user.legacy, true);
  process.env.AUTH_REQUIRED = '1';
  const enforced = await requireUser(req(tokenFor('tina')), { deps: broken });
  assert.ok(!enforced.ok); assert.equal(enforced.response.status, 503);
  delete process.env.AUTH_REQUIRED;
});

test('the per-instance throttle trips at the limit and forgets after the window', () => {
  _resetThrottleForTests();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(throttled('k', 3, 1000, t0 + i), false);
  assert.equal(throttled('k', 3, 1000, t0 + 3), true);
  assert.equal(throttled('k', 3, 1000, t0 + 2000), false, 'window elapsed');
});

test('readJsonBody: empty is {}, garbage is 400, oversized is 413', async () => {
  const mk = (s) => new Request('https://x.test/', { method: 'POST', body: s });
  assert.deepEqual((await readJsonBody(mk(''))).body, {});
  assert.equal((await readJsonBody(mk('{nope'))).response.status, 400);
  assert.equal((await readJsonBody(mk('x'.repeat(70_000)))).response.status, 413);
  assert.deepEqual((await readJsonBody(mk('[1,2]'))).body, {}, 'a non-object body is treated as empty');
});
