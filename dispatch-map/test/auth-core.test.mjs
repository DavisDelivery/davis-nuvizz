// THE USER SYSTEM'S RULES, PINNED.
//
// Chad, 2026-09: "We need to build the backend of a user based system with usernames and
// passwords with password resets." These tests are the part that has to be right before a
// single endpoint matters: a password never verifies against the wrong hash, a token never
// verifies with the wrong secret or after expiry, a lockout starts over after it lapses, and
// a reset link works once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';

const core = await import('../netlify/functions/lib/auth-core.mts');
const {
  normalizeUsername, normalizeEmail, normalizeRole, roleAtLeast, passwordProblem,
  hashPassword, verifyPassword, parseHash, hashNeedsUpgrade,
  isLockedOut, nextFailureState, lockFromCount, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES,
  issueSessionToken, verifySessionToken, bearerFromHeaders, sessionsConfigured,
  newResetToken, resetTokenMatches, resetExpired, generateTempPassword, safeEqual,
} = core;

// ── identifiers ──────────────────────────────────────────────────────────────

test('usernames are lower-cased, trimmed, and can never be a Firestore path escape', () => {
  assert.equal(normalizeUsername('  Chad '), 'chad');
  assert.equal(normalizeUsername('dispatch_2'), 'dispatch_2');
  assert.equal(normalizeUsername('a'), null, 'too short');
  assert.equal(normalizeUsername('..'), null);
  assert.equal(normalizeUsername('../customer_notes/x'), null);
  assert.equal(normalizeUsername('chad?x=1'), null);
  assert.equal(normalizeUsername('chad.blyth'), null, 'dots are refused: they are path-adjacent');
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername(null), null);
});

test('emails: lower-cased, header-injection characters refused', () => {
  assert.equal(normalizeEmail(' Chad@DavisDelivery.com '), 'chad@davisdelivery.com');
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail('a@b.com\r\nBcc: x@y.com'), null);
  assert.equal(normalizeEmail('"a b"@x.com'), null);
});

test('unknown roles fall to viewer, never upward', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('ADMIN'), 'viewer');
  assert.equal(normalizeRole(undefined), 'viewer');
  assert.ok(roleAtLeast('admin', 'dispatcher'));
  assert.ok(!roleAtLeast('viewer', 'dispatcher'));
  assert.ok(roleAtLeast('dispatcher', 'dispatcher'));
});

// ── password policy + hashing ────────────────────────────────────────────────

test('password policy: length, repetition, username, common words', () => {
  assert.match(passwordProblem('short'), /at least/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /repeated/);
  assert.match(passwordProblem('chad-is-here-2026', 'chad'), /username/);
  assert.match(passwordProblem('password1'), /common|at least/);
  assert.equal(passwordProblem('Freight-moves-at-5am!'), null);
});

test('a password verifies only against its own hash; hashes are salted and self-describing', async () => {
  const h1 = await hashPassword('Freight-moves-at-5am!');
  const h2 = await hashPassword('Freight-moves-at-5am!');
  assert.notEqual(h1, h2, 'two hashes of the same password differ (random salt)');
  assert.ok(await verifyPassword('Freight-moves-at-5am!', h1));
  assert.ok(!(await verifyPassword('Freight-moves-at-5am?', h1)));
  assert.ok(!(await verifyPassword('', h1)));
  const p = parseHash(h1);
  assert.equal(p.N, 32768); assert.equal(p.r, 8); assert.equal(p.p, 1);
  assert.equal(hashNeedsUpgrade(h1), false);
});

test('a malformed or hostile stored hash verifies FALSE, never throws, never passes', async () => {
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', 'plaintext-password'), false);
  assert.equal(await verifyPassword('x', 'scrypt$notanumber$8$1$00$00'), false);
  assert.equal(await verifyPassword('x', 'scrypt$1048576000$8$1$' + '00'.repeat(16) + '$' + '00'.repeat(32)), false, 'absurd N refused');
  assert.equal(parseHash('scrypt$16384$8$1$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(32))?.N, 16384);
});

test('a hash made at a lower cost is flagged for upgrade on next login', async () => {
  const low = 'scrypt$16384$8$1$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(32);
  assert.equal(hashNeedsUpgrade(low), true);
});

// ── lockout ──────────────────────────────────────────────────────────────────

test('eight wrong passwords lock the account for fifteen minutes', () => {
  let doc = { failedAttempts: 0, lockedUntil: null };
  const now = Date.parse('2026-09-02T09:00:00Z');
  for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
    doc = nextFailureState(doc, now);
    assert.equal(doc.failedAttempts, i);
    assert.equal(doc.lockedUntil, null);
  }
  doc = nextFailureState(doc, now);
  assert.equal(doc.failedAttempts, MAX_FAILED_ATTEMPTS);
  assert.equal(Date.parse(doc.lockedUntil), now + LOCKOUT_MINUTES * 60_000);
  assert.ok(isLockedOut(doc, now + 60_000));
  assert.ok(!isLockedOut(doc, now + LOCKOUT_MINUTES * 60_000 + 1));
});

test('one mistyped password AFTER a lockout has lapsed does not re-lock (the load-scan bug)', () => {
  const now = Date.parse('2026-09-02T09:00:00Z');
  const locked = { failedAttempts: MAX_FAILED_ATTEMPTS, lockedUntil: new Date(now - 1000).toISOString() };
  const next = nextFailureState(locked, now);
  assert.equal(next.failedAttempts, 1);
  assert.equal(next.lockedUntil, null);
});

test('lockFromCount decides on the post-increment value', () => {
  assert.equal(lockFromCount(MAX_FAILED_ATTEMPTS - 1), null);
  assert.ok(lockFromCount(MAX_FAILED_ATTEMPTS));
});

// ── session tokens ───────────────────────────────────────────────────────────

test('a session token round-trips and carries the tokenVersion', () => {
  const { token, expiresAt } = issueSessionToken({ username: 'chad', displayName: 'Chad', role: 'admin', tokenVersion: 3 });
  const c = verifySessionToken(token);
  assert.equal(c.sub, 'chad'); assert.equal(c.role, 'admin'); assert.equal(c.tv, 3);
  assert.ok(Date.parse(expiresAt) > Date.now());
});

test('a token expires, cannot be tampered with, and ignores the header alg', () => {
  const now = Date.now();
  const { token } = issueSessionToken({ username: 'chad', role: 'admin', tokenVersion: 0 }, now);
  assert.equal(verifySessionToken(token, now + 15 * 86400_000), null, 'expired after the session window');
  const [h, p, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'chad', role: 'admin', tv: 0, iat: 0, exp: 4102444800 })).toString('base64url');
  assert.equal(verifySessionToken(`${h}.${forged}.${s}`, now), null, 'payload swap fails the signature');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verifySessionToken(`${noneHeader}.${p}.`, now), null, 'alg:none is not a thing');
  assert.equal(verifySessionToken('garbage', now), null);
});

test('a token signed under a different secret is refused; no secret means no sessions', () => {
  const { token } = issueSessionToken({ username: 'chad', role: 'admin', tokenVersion: 0 });
  const saved = process.env.AUTH_SESSION_SECRET;
  process.env.AUTH_SESSION_SECRET = 'a-completely-different-secret-of-32-chars!';
  assert.equal(verifySessionToken(token), null);
  process.env.AUTH_SESSION_SECRET = 'short';
  assert.equal(sessionsConfigured(), false);
  assert.equal(verifySessionToken(token), null, 'fail closed');
  assert.throws(() => issueSessionToken({ username: 'chad', role: 'admin' }));
  process.env.AUTH_SESSION_SECRET = saved;
});

test('the bearer token comes from a header, never the query string', () => {
  const h = new Headers({ authorization: 'Bearer abc.def.ghi' });
  assert.equal(bearerFromHeaders(h), 'abc.def.ghi');
  assert.equal(bearerFromHeaders(new Headers({ 'x-auth-token': 'xyz' })), 'xyz');
  assert.equal(bearerFromHeaders(new Headers()), null);
});

// ── reset tokens ─────────────────────────────────────────────────────────────

test('a reset token matches only its own hash and expires', () => {
  const { token, hash } = newResetToken();
  assert.ok(resetTokenMatches(token, hash));
  assert.ok(!resetTokenMatches(token + 'x', hash));
  assert.ok(!resetTokenMatches(token, newResetToken().hash));
  assert.ok(!resetTokenMatches('', hash));
  assert.ok(!resetTokenMatches(token, null));
  const now = Date.now();
  assert.equal(resetExpired(new Date(now + 60_000).toISOString(), now), false);
  assert.equal(resetExpired(new Date(now - 1).toISOString(), now), true);
  assert.equal(resetExpired(null, now), true);
  assert.equal(resetExpired('not a date', now), true);
});

test('temporary passwords pass the policy and avoid look-alike characters', () => {
  for (let i = 0; i < 20; i++) {
    const p = generateTempPassword();
    assert.equal(passwordProblem(p), null);
    assert.doesNotMatch(p, /[0O1lI]/);
  }
});

test('safeEqual: constant-time, and empty never equals anything', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('', ''));
  assert.ok(!safeEqual(undefined, 'x'));
});
