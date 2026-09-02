// THE BRIDGE TO FIRESTORE RULES, PINNED.
//
// Firestore rules can only read request.auth, and only Firebase Authentication fills it in.
// Our session token is invisible to them. So this custom token is the ONLY thing standing
// between "the browser signs in" and "the rules can tell a dispatcher from a stranger", and
// every way it can go wrong goes wrong quietly:
//
//   • a token signed with the wrong key            → signInWithCustomToken fails, blank board
//   • a uid that is not the username               → rules match the wrong person
//   • an exp past Firebase's one-hour cap          → auth/invalid-custom-token at 5am
//   • a missing FIREBASE_SA that mints anyway      → a token nothing will ever accept
//   • the endpoint minting for an anonymous caller → a database key handed to the internet
//
// Plus the header-precedence rule, which is not cosmetic: get it wrong and the Drivers panel
// 401s the day loadscan-admin is gated, before AUTH_REQUIRED is ever flipped.
//
// NO NETWORK. Every test here signs and verifies locally against a key pair generated in
// this process; the endpoint tests deliberately stop at refusals, which is the only part of
// the handler reachable without a Firestore read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

// A real RSA pair standing in for the service account. Signing against a key we hold the
// public half of is the only way to assert the token would actually verify at Google's end.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_EMAIL = 'dispatch-map@davismarginiq.iam.gserviceaccount.com';
process.env.FIREBASE_SA = JSON.stringify({
  type: 'service_account',
  project_id: 'davismarginiq',
  client_email: SA_EMAIL,
  private_key: privateKey,
});

const {
  mintCustomToken, firebaseTokensConfigured, shouldSignOutOfFirebase, serviceAccountProblem,
  CUSTOM_TOKEN_AUD, CUSTOM_TOKEN_TTL_SEC,
} = await import('../netlify/functions/lib/auth-firebase.mts');
const { issueSessionToken, bearerFromHeaders } = await import('../netlify/functions/lib/auth-core.mts');
const { requireUser } = await import('../netlify/functions/lib/require-user.mts');

const decode = (seg) => JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
const partsOf = (token) => {
  const p = String(token).split('.');
  assert.equal(p.length, 3, 'a JWT is three dot-separated segments');
  return { header: decode(p[0]), claims: decode(p[1]), signing: `${p[0]}.${p[1]}`, sig: p[2] };
};

const TINA = { username: 'tina', role: 'dispatcher', tokenVersion: 3 };

// ── the token itself ─────────────────────────────────────────────────────────

test('the minted token is the exact shape Google accepts — wrong aud or uid and nobody signs in', () => {
  const at = Date.UTC(2026, 8, 2, 10, 0, 0);
  const { header, claims } = partsOf(mintCustomToken(TINA, at).token);

  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' }, 'HS256 here would be silently rejected by identitytoolkit');
  assert.equal(claims.aud, CUSTOM_TOKEN_AUD);
  assert.equal(
    claims.aud,
    'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    'the audience is a fixed Google identifier — a typo here fails only at 5am, in the browser',
  );
  // iss and sub are both the service account: it vouches, about itself, for `uid`.
  assert.equal(claims.iss, SA_EMAIL);
  assert.equal(claims.sub, SA_EMAIL);
  assert.equal(claims.uid, 'tina', 'the uid IS the username — rules and logs both name the human by it');
  assert.notEqual(claims.sub, claims.uid, 'sub is the signer, not the user; swapping them signs everyone in as the SA');
  assert.equal(claims.iat, Math.floor(at / 1000));
  assert.equal(claims.exp, Math.floor(at / 1000) + 3600);
});

test('the token expires in exactly one hour — Firebase rejects anything longer', () => {
  // Not a policy choice: identitytoolkit refuses a custom token whose exp is more than
  // 3600s past its iat, and the client sees auth/invalid-custom-token, i.e. "could not
  // sign in", with no hint that the server picked a bad number.
  assert.equal(CUSTOM_TOKEN_TTL_SEC, 3600);
  const at = 1_770_000_000_000;
  const m = mintCustomToken(TINA, at);
  const { claims } = partsOf(m.token);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(m.expiresIn, 3600);
  assert.equal(m.expiresAt, new Date((Math.floor(at / 1000) + 3600) * 1000).toISOString());

  // A bad clock must not produce a well-signed token with `"iat": null` — that fails only
  // later, in a dispatcher's browser, as "could not sign in", miles from the cause.
  for (const bad of [NaN, Infinity, null, 'now']) {
    assert.throws(() => mintCustomToken(TINA, bad), /non-finite time/, String(bad));
  }
});

test('the role and tokenVersion the rules will read come from the STORE, carried verbatim', () => {
  const { claims } = partsOf(mintCustomToken(TINA).token);
  assert.deepEqual(claims.claims, { role: 'dispatcher', tv: 3, username: 'tina' });

  // An unrecognised role is a viewer, never a promotion — same rule as the session token,
  // because a custom token that read 'admin' off a corrupt document would hand the whole
  // database to it the day the rules go on.
  const odd = partsOf(mintCustomToken({ username: 'ops1', role: 'wizard' }).token);
  assert.equal(odd.claims.claims.role, 'viewer');
  assert.equal(odd.claims.claims.tv, 0, 'a user document with no tokenVersion is version 0, not NaN');
});

test('the token is signed with the service-account key and any tampering breaks it', () => {
  const token = mintCustomToken(TINA).token;
  const { signing, sig, claims } = partsOf(token);

  const v = createVerify('RSA-SHA256');
  v.update(signing);
  assert.ok(
    v.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    'the signature must verify against the service account Google knows about',
  );

  // Promote yourself to admin in the payload and the signature no longer covers it.
  const forged = { ...claims, claims: { ...claims.claims, role: 'admin' } };
  const forgedPayload = Buffer.from(JSON.stringify(forged)).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const v2 = createVerify('RSA-SHA256');
  v2.update(`${signing.split('.')[0]}.${forgedPayload}`);
  assert.equal(v2.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), false);
});

test('a username that is not a legal uid is refused rather than escaped into a Firebase path', () => {
  // USERNAME_RE already guarantees this for anything that came out of the store, but this
  // function must not depend on every future caller having normalised first — a uid is a
  // path segment inside Firebase, and 'a' is below the two-character minimum.
  for (const bad of ['../app_users/admin', 'a', '', 'ops.one', 'ops one', '-lead', null, undefined, {}, []]) {
    assert.throws(() => mintCustomToken({ username: bad, role: 'admin' }), /invalid username/, String(bad));
  }
  // 'Tina' is NOT refused: normalizeUsername lower-cases, and the store id is 'tina'. The
  // uid must be the same string the session token's `sub` carries, or a rule that names the
  // user and a log that names the user would disagree about who acted.
  assert.equal(partsOf(mintCustomToken({ username: 'Tina', role: 'dispatcher' }).token).claims.uid, 'tina');
});

// ── fail closed ──────────────────────────────────────────────────────────────

test('with FIREBASE_SA removed, minting FAILS rather than emitting an unsignable token', () => {
  // This runs AFTER a successful mint on purpose. loadServiceAccount() memoises the parsed
  // service account for the life of the instance, so an instance that had once seen a key
  // would happily keep minting after the variable was pulled. The env var is checked first
  // for exactly that reason.
  const saved = process.env.FIREBASE_SA;
  delete process.env.FIREBASE_SA;
  try {
    assert.equal(firebaseTokensConfigured(), false);
    assert.throws(() => mintCustomToken(TINA), /FIREBASE_SA not set/);
  } finally {
    process.env.FIREBASE_SA = saved;
  }
  assert.equal(firebaseTokensConfigured(), true, 'and it recovers once the variable is back');
});

test('a truncated or wrong-shaped service account is named, not passed to crypto to fail cryptically', () => {
  // Tested against the pure rule rather than the env var ON PURPOSE: loadServiceAccount()
  // memoises the parsed JSON for the life of the instance, so once any service account has
  // been loaded, rewriting FIREBASE_SA cannot feed a different one through. Asserting via
  // the env var here would pass for the wrong reason — it would be reading the cached good
  // account, not the bad one the test thinks it installed.
  assert.equal(serviceAccountProblem({ client_email: SA_EMAIL, private_key: privateKey }), null);
  assert.match(serviceAccountProblem({ client_email: SA_EMAIL, private_key: '' }), /private_key/);
  assert.match(serviceAccountProblem({ client_email: SA_EMAIL, private_key: 'AAAA-not-a-pem' }), /private_key/);
  assert.match(serviceAccountProblem({ private_key: privateKey }), /client_email/);
  assert.match(serviceAccountProblem({}), /client_email/);
  assert.match(serviceAccountProblem(null), /service-account object/);
  assert.match(serviceAccountProblem('a string'), /service-account object/);
});

// ── the endpoint ─────────────────────────────────────────────────────────────

const handler = (await import('../netlify/functions/auth-firebase-token.mts')).default;
const call = (init = {}) => handler(new Request('https://dd-dispatch-map.test/.netlify/functions/auth-firebase-token', { method: 'POST', ...init }));

test('a caller with NO session gets no Firebase key, even with the site switch off', async () => {
  // The whole point of strict mode. AUTH_REQUIRED is unset here — the state the site is in
  // today — and the legacy principal is an admin. Minting for it would hand a database key
  // to any anonymous request on a public URL the day firestore.rules starts trusting
  // request.auth.
  delete process.env.AUTH_REQUIRED;
  const res = await call();
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(!('customToken' in body), 'and nothing token-shaped leaks in the refusal');
});

test('a forged or expired session token gets no Firebase key', async () => {
  // Refused before any store read, so this test touches no network.
  for (const bad of ['not.a.token', 'a.b.c', '']) {
    const res = await call({ headers: { 'x-auth-token': bad } });
    assert.equal(res.status, 401, `refused: ${JSON.stringify(bad)}`);
  }
  const wrongSecret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aW5hIiwiZXhwIjo5OTk5OTk5OTk5fQ.bm90LWEtc2ln';
  assert.equal((await call({ headers: { authorization: `Bearer ${wrongSecret}` } })).status, 401);
});

test('the endpoint answers only GET and POST', async () => {
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    assert.equal((await call({ method })).status, 405, method);
  }
});

// ── B1: two token systems on one request ─────────────────────────────────────

test('a load-scan token in Authorization does not shadow our session token in x-auth-token', () => {
  // The Drivers panel (src/components/DriversPanel.jsx:46) signs a dispatcher into LOAD-SCAN
  // and sends that token as `Authorization: Bearer …`, which loadscan-admin.mts forwards
  // untouched to the other origin. Read Authorization first and requireUser finds a token it
  // cannot verify — and an unverifiable token is a 401 even in legacy mode — so the Drivers
  // panel would break the day loadscan-admin is gated.
  const ours = issueSessionToken({ username: 'tina', role: 'dispatcher', tokenVersion: 0 }).token;
  const theirs = 'loadscan.dispatcher.token';

  assert.equal(bearerFromHeaders(new Headers({ authorization: `Bearer ${theirs}`, 'x-auth-token': ours })), ours);
  // Order in the object must not matter — Headers is a map, not a list.
  assert.equal(bearerFromHeaders(new Headers({ 'x-auth-token': ours, authorization: `Bearer ${theirs}` })), ours);
});

test('Authorization still works on its own — curl, the tests, and every caller written before x-auth-token', () => {
  const ours = issueSessionToken({ username: 'tina', role: 'dispatcher', tokenVersion: 0 }).token;
  assert.equal(bearerFromHeaders(new Headers({ authorization: `Bearer ${ours}` })), ours);
  assert.equal(bearerFromHeaders(new Headers({ authorization: `bearer ${ours}` })), ours, 'the scheme is case-insensitive');
  assert.equal(bearerFromHeaders(new Headers()), null);
  assert.equal(bearerFromHeaders(new Headers({ 'x-auth-token': ours })), ours);
});

test('a BLANK x-auth-token does not turn a signed-in caller into an anonymous one', () => {
  // A client that sets the header from an empty variable would otherwise erase its own
  // Authorization token and drop to the legacy principal without noticing.
  const ours = issueSessionToken({ username: 'tina', role: 'dispatcher', tokenVersion: 0 }).token;
  assert.equal(bearerFromHeaders(new Headers({ 'x-auth-token': '   ', authorization: `Bearer ${ours}` })), ours);
  assert.equal(bearerFromHeaders(new Headers({ 'x-auth-token': '' })), null);
});

test('end to end: the gate identifies the dispatcher from x-auth-token while a foreign token rides along', async () => {
  const deps = { getUser: async (u) => (u === 'tina' ? { username: 'tina', displayName: 'Tina', role: 'dispatcher', active: true, tokenVersion: 0 } : null) };
  const ours = issueSessionToken({ username: 'tina', role: 'dispatcher', tokenVersion: 0 }).token;
  const req = new Request('https://x.test/.netlify/functions/loadscan-admin?target=driver-admin', {
    headers: { authorization: 'Bearer loadscan.dispatcher.token', 'x-auth-token': ours },
  });
  const gate = await requireUser(req, { deps, role: 'dispatcher' });
  assert.ok(gate.ok, 'the Drivers panel must keep working once loadscan-admin is gated');
  assert.equal(gate.user.username, 'tina');
  assert.equal(gate.user.tokenVersion, 0, 'the live store version is carried out for the Firebase claim');
});

test('KNOWN RESIDUAL: a load-scan token ALONE is still refused — gate loadscan-admin only after the client sends x-auth-token', async () => {
  // The precedence fix lets the two systems coexist; it cannot invent a session token that
  // is not there. Until the client rollout puts ours in x-auth-token, a Drivers-panel call
  // carries only the foreign Authorization header, and an unverifiable token is refused
  // unconditionally by design ("a client that thinks it is signed in must find out").
  // This test exists so that ordering constraint is visible in CI rather than in folklore.
  const req = new Request('https://x.test/.netlify/functions/loadscan-admin?target=driver-admin', {
    headers: { authorization: 'Bearer loadscan.dispatcher.token' },
  });
  const gate = await requireUser(req, { deps: { getUser: async () => null } });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'bad-token');
});

// ── mitigation (1): the two doors stay in step ───────────────────────────────

test('a demoted dispatcher\'s 401 from any gated function tells the client to drop its Firebase session', async () => {
  // The gap this closes: require-user re-reads app_users every ~30s, but a Firebase session
  // refreshes itself with the claims frozen at mint time. Without this the demoted user keeps
  // writing customer_notes all afternoon. The refusals are driven through the REAL gate so
  // this test fails if anyone reworders them.
  const store = {
    lead: { username: 'lead', displayName: 'Lead', role: 'admin', active: true, tokenVersion: 5 },
    gone: { username: 'gone', displayName: 'Gone', role: 'dispatcher', active: false, tokenVersion: 0 },
  };
  const deps = { getUser: async (u) => store[u] || null };
  const withToken = (t) => new Request('https://x.test/f', { headers: { 'x-auth-token': t } });

  // "sign out everywhere" / a password change bumped tokenVersion out from under this token
  const stale = await requireUser(withToken(issueSessionToken({ username: 'lead', role: 'admin', tokenVersion: 4 }).token), { deps });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'revoked');
  assert.ok(shouldSignOutOfFirebase({ status: stale.response.status, error: (await stale.response.json()).error }));

  // deactivated account
  const dead = await requireUser(withToken(issueSessionToken({ username: 'gone', role: 'dispatcher', tokenVersion: 0 }).token), { deps });
  assert.equal(dead.ok, false);
  assert.ok(shouldSignOutOfFirebase({ status: dead.response.status, error: (await dead.response.json()).error }));

  // an expired or forged token
  const bad = await requireUser(withToken('not.a.token'), { deps });
  assert.ok(shouldSignOutOfFirebase({ status: bad.response.status, error: (await bad.response.json()).error }));
});

test('a PIN typo in the Drivers panel must NOT blank the board', () => {
  // loadscan-admin and load-scan itself both answer 401 for their own reasons. Signing a
  // dispatcher out of Firestore because somebody mistyped a driver PIN would empty the map
  // for a cause nobody could connect to the effect.
  assert.equal(shouldSignOutOfFirebase({ status: 401, error: 'unauthorized' }), false);
  assert.equal(shouldSignOutOfFirebase({ status: 401, error: 'wrong driver number or PIN' }), false);
});

test('the day AUTH_REQUIRED is flipped on, a not-yet-signed-in client is not force-signed-out of Firebase', async () => {
  // 'sign in required' means the client never HELD a token, so there is no stale Firebase
  // identity to clear; forcing a sign-out there would only cost a redundant round trip in
  // the middle of the one change that can lock a dispatcher out of a 700-stop morning.
  process.env.AUTH_REQUIRED = 'true';
  const gate = await requireUser(new Request('https://x.test/f'), { deps: { getUser: async () => null } });
  delete process.env.AUTH_REQUIRED;
  assert.equal(gate.ok, false);
  const body = await gate.response.json();
  assert.match(body.error, /sign in required/);
  assert.equal(shouldSignOutOfFirebase({ status: 401, error: body.error }), false);
});

test('a 403 role refusal is not a revocation — the session is fine, the user simply may not', () => {
  assert.equal(shouldSignOutOfFirebase({ status: 403, error: 'requires admin' }), false);
  assert.equal(shouldSignOutOfFirebase({ status: 200, error: undefined }), false);
  assert.equal(shouldSignOutOfFirebase({ status: 503, error: 'user store unavailable' }), false);
  assert.equal(shouldSignOutOfFirebase(null), false);
  assert.equal(shouldSignOutOfFirebase(undefined), false);
  assert.equal(shouldSignOutOfFirebase({}), false);
});
