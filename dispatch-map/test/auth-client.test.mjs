// test/auth-client.test.mjs — SIGNING IN AGAINST app_users.
//
// The failures named here are the ones that would be found in production, not in review:
//
//  · A dispatcher fat-fingers their CURRENT password on the forced-change screen and gets
//    signed out for it, because auth-change-password answers 401 for "wrong password" and
//    something routed it through the generic 401-means-your-session-died handler.
//  · Sign-in "succeeds" and the board is silently missing every receiving hour, because the
//    Firebase custom-token leg failed and nobody said so.
//  · The screen enforces a password rule the server does not, or the reverse, so a person
//    is rejected by a form that never explains itself.
//  · An emailed reset link opens the board instead of a password form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resetLinkParams, friendlyServerError, passwordProblem, PASSWORD_MIN, PASSWORD_MAX,
  signIn, changePassword, requestPasswordReset,
} from '../src/lib/auth-client.js';
import { passwordProblem as serverPasswordProblem, PASSWORD_MIN as SERVER_MIN } from '../netlify/functions/lib/auth-core.mts';
import { getSession, clearSession, setSession } from '../src/lib/session.js';

function stubFetch(responder) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responder({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

// ── THE EMAILED RESET LINK ───────────────────────────────────────────────────

test('A RESET LINK NEEDS BOTH HALVES OR IT IS SOMEBODY’S BOOKMARK', () => {
  // lib/auth-mail.mts builds ${origin}/reset-password?u=<username>&t=<token>. Showing a
  // password form that cannot possibly work is worse than showing the app.
  assert.deepEqual(resetLinkParams('/reset-password', '?u=jrivera&t=abc123'), { username: 'jrivera', token: 'abc123' });
  assert.deepEqual(resetLinkParams('/reset-password/', '?u=jrivera&t=abc123'), { username: 'jrivera', token: 'abc123' });
  assert.equal(resetLinkParams('/reset-password', '?u=jrivera'), null, 'no token');
  assert.equal(resetLinkParams('/reset-password', '?t=abc'), null, 'no username');
  assert.equal(resetLinkParams('/reset-password', ''), null, 'a bare bookmark');
  assert.equal(resetLinkParams('/', '?u=jrivera&t=abc'), null, 'a stray query on the board is NOT a reset');
  assert.equal(resetLinkParams('/reset-password-x', '?u=jrivera&t=abc'), null, 'and neither is a look-alike path');
  assert.equal(resetLinkParams(null, null), null);
});

test('the reset path netlify.toml serves is the SPA, not a 404', () => {
  // If /reset-password did not fall through to index.html, every reset email in the rollout
  // would land on Netlify's 404 page and no password would ever get set. Netlify takes the
  // FIRST matching rule, so this must be the catch-all and nothing above it may claim the path.
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const rules = [...toml.matchAll(/\[\[redirects\]\]\s*\n\s*from\s*=\s*"([^"]+)"\s*\n\s*to\s*=\s*"([^"]+)"/g)]
    .map(([, from, to]) => ({ from, to }));
  const match = rules.find(({ from }) => from === '/reset-password' || from === '/*'
    || (from.endsWith('/*') && '/reset-password'.startsWith(from.slice(0, -1))));
  assert.ok(match, 'some redirect claims /reset-password');
  assert.equal(match.to, '/index.html', '/reset-password must be served the SPA');
});

// ── THE PASSWORD RULE ────────────────────────────────────────────────────────

test('THE SCREEN AND THE SERVER AGREE ON THE PASSWORD RULE', () => {
  // The client mirror exists only so the form can say "at least 10 characters" while
  // someone is typing instead of after a round trip. If the two ever drift, a person is
  // rejected by a form that already told them they were fine — so the drift fails here.
  assert.equal(PASSWORD_MIN, SERVER_MIN);
  const cases = [
    '', 'short', 'aaaaaaaaaa', 'password', 'password1', 'PASSWORD!', 'dispatch',
    'qwertyuiop', '1234567890', 'davisdelivery', 'a-good-enough-one', 'jr-is-here-1234',
    'x'.repeat(PASSWORD_MAX), 'x'.repeat(PASSWORD_MAX + 1), '0123456789',
  ];
  for (const pw of cases) {
    assert.equal(!!passwordProblem(pw, 'jrivera'), !!serverPasswordProblem(pw, 'jrivera'), `verdict for ${JSON.stringify(pw)}`);
    assert.equal(passwordProblem(pw, 'jrivera'), serverPasswordProblem(pw, 'jrivera'), `wording for ${JSON.stringify(pw)}`);
  }
  assert.equal(passwordProblem('jrivera-loves-freight', 'jrivera'), 'password cannot contain the username');
  assert.equal(passwordProblem(null, 'jrivera'), `password must be at least ${PASSWORD_MIN} characters`, 'null is not a password');
});

// ── WHAT A PERSON READS WHEN IT FAILS ────────────────────────────────────────

test('a failed sign-in says something a dispatcher can act on', () => {
  // The server writes its own error strings for a person, so they are used verbatim rather
  // than reworded — two vocabularies for one failure means nobody can tell which one
  // somebody is quoting down a phone.
  assert.equal(friendlyServerError(401, 'wrong username or password'), 'Wrong username or password');
  assert.match(friendlyServerError(423, 'account locked — try again later'), /locked/i);
  // The platform, not the handler, answered — an HTML 502 has no `error` at all.
  assert.match(friendlyServerError(502, ''), /server had a problem/i);
  assert.match(friendlyServerError(429, null), /Wait a few minutes/i);
  assert.match(friendlyServerError(503, undefined), /not switched on/i);
  const unknown = friendlyServerError(0, '');
  assert.ok(unknown.length > 10 && !/undefined|null/.test(unknown), unknown);
});

// ── SIGN-IN ──────────────────────────────────────────────────────────────────

test('A SIGN-IN THAT DID NOT REACH FIREBASE SAYS SO', () => {
  // The password check is only half of signing in. The Firebase custom token is the ONLY
  // thing that gives the Firestore rules a request.auth to read; without it the board loads
  // and is quietly missing every receiving hour. Never report an intent as an outcome.
  const f = stubFetch(({ url }) => {
    if (url.endsWith('auth-login')) return { body: { ok: true, token: 't1', expiresAt: '2099-01-01T00:00:00Z', user: { username: 'jrivera', role: 'admin' } } };
    if (url.endsWith('auth-firebase-token')) return { status: 503, body: { ok: false, error: 'Firebase sign-in not configured (FIREBASE_SA)' } };
    return { body: { ok: true } };
  });
  return signIn('jrivera', 'a-good-enough-one').then((res) => {
    f.restore();
    assert.equal(res.ok, true, 'the person IS signed in to the functions');
    // The invariant, stated as the thing that must never happen: a redeem that did not
    // happen is NEVER reported as done. (Under node the dynamic firebase import is absent,
    // so this lands on 'skipped'; in the browser the 503 above lands on 'failed'. Either
    // way 'ok' is a lie and the test refuses it.)
    assert.notEqual(res.firebase.state, 'ok', 'never report an intent as an outcome');
    assert.ok(['failed', 'skipped'].includes(res.firebase.state), `firebase leg reported: ${res.firebase.state}`);
    assert.ok(getSession(), 'and the session is stored');
    clearSession();
  }, (e) => { f.restore(); clearSession(); throw e; });
});

test('a refused sign-in stores nothing and says why', async () => {
  clearSession();
  const f = stubFetch(() => ({ status: 401, body: { ok: false, error: 'wrong username or password' } }));
  try {
    const res = await signIn('jrivera', 'nope');
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.match(res.error, /Wrong username or password/i);
    assert.equal(getSession(), null, 'nothing was stored');
  } finally { f.restore(); clearSession(); }
});

test('no connection reads as no connection, not as a wrong password', async () => {
  // A dispatcher in a dead spot who is told their password is wrong will change it.
  clearSession();
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    const res = await signIn('jrivera', 'a-good-enough-one');
    assert.equal(res.ok, false);
    assert.equal(res.offline, true);
    assert.match(res.error, /connection/i);
  } finally { globalThis.fetch = prev; }
});

test('the username is normalised to lower case before it is sent', async () => {
  // auth-core's USERNAME_RE is lower-case only, so "Chad" typed on a phone that
  // auto-capitalises would simply never match an account.
  clearSession();
  const f = stubFetch(({ url }) => (url.endsWith('auth-login')
    ? { status: 401, body: { ok: false, error: 'wrong username or password' } }
    : { body: { ok: true } }));
  try {
    await signIn('  JRIVERA  ', 'x');
    assert.equal(JSON.parse(f.calls[0].init.body).username, 'jrivera');
  } finally { f.restore(); clearSession(); }
});

// ── THE 401 THAT IS NOT A DEAD SESSION ───────────────────────────────────────

test('A WRONG CURRENT PASSWORD MUST NOT SIGN THE DISPATCHER OUT', () => {
  // auth-change-password answers 401 for "current password is wrong". apiFetch treats a 401
  // from our own functions as "the session is gone" and clears it — so if this call went
  // through apiFetch, a typo on the forced-change screen would eject someone mid-morning.
  // The transport in auth-client sends the header itself and interprets nothing; that is
  // the whole reason it exists, and this pins it two ways.
  const src = readFileSync(new URL('../src/lib/auth-client.js', import.meta.url), 'utf8');
  assert.ok(!/\bapiFetch\s*\(/.test(src), 'auth-client must not route its own endpoints through apiFetch');

  setSession({ token: 't1', expiresAt: '2099-01-01T00:00:00Z', user: { username: 'jrivera', role: 'admin' } });
  const f = stubFetch(() => ({ status: 401, body: { ok: false, error: 'current password is wrong' } }));
  return changePassword('wrong', 'a-good-enough-one').then((res) => {
    f.restore();
    assert.equal(res.ok, false);
    assert.match(res.error, /current password is wrong/i);
    assert.ok(getSession(), 'STILL SIGNED IN — a typo is not a dead session');
    clearSession();
  }, (e) => { f.restore(); clearSession(); throw e; });
});

test('the session token is sent on the calls that need it, and not on the ones that do not', async () => {
  setSession({ token: 't1', expiresAt: '2099-01-01T00:00:00Z', user: { username: 'jrivera', role: 'admin' } });
  const f = stubFetch(() => ({ body: { ok: true, message: 'sent' } }));
  try {
    await requestPasswordReset('jrivera');
    assert.equal(f.calls[0].init.headers.Authorization, undefined,
      'a reset request is made by someone who is LOCKED OUT — it must not need a session');
  } finally { f.restore(); clearSession(); }
});

test('a reset request never confirms whether the account exists', async () => {
  // auth-reset-request deliberately answers the same generic success for every input so the
  // page cannot be used to find out who works here. The screen must not undo that by being
  // more helpful than the server.
  const f = stubFetch(() => ({ body: { ok: true, message: 'If that account exists, a reset link is on its way.' } }));
  try {
    const a = await requestPasswordReset('jrivera');
    const b = await requestPasswordReset('nobody-here');
    assert.deepEqual(a, b, 'a real and a fake identifier are indistinguishable');
    assert.match(a.message, /if that account exists/i);
  } finally { f.restore(); }
});
