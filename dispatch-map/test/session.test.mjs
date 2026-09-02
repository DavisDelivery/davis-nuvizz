// test/session.test.mjs — WHERE THE SIGNED-IN SESSION LIVES.
//
// The failures these are named for are the quiet ones: a "session" with no token that
// makes the app look signed in and 401s every call; a stored session that survives a
// private-mode browser throwing on setItem; a sign-out in one tab that leaves the other
// two open on the dispatch station.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_KEY, normalizeSession, sessionExpired, readSessionFrom, writeSessionTo,
  setSession, clearSession, getSession, sessionToken, subscribeSession,
  onAuthEvent, emitAuthEvent,
} from '../src/lib/session.js';

/** A localStorage stand-in. `explode` reproduces Safari with all cookies blocked. */
function fakeStore({ explode = false } = {}) {
  const m = new Map();
  return {
    getItem: (k) => (explode ? (() => { throw new Error('blocked'); })() : (m.has(k) ? m.get(k) : null)),
    setItem: (k, v) => { if (explode) throw new Error('blocked'); m.set(k, String(v)); },
    removeItem: (k) => { if (explode) throw new Error('blocked'); m.delete(k); },
    _map: m,
  };
}

const LIVE = { token: 'tok.abc', expiresAt: '2099-01-01T00:00:00.000Z', user: { username: 'jrivera', displayName: 'Chad', role: 'admin' } };

test('A SESSION WITH NO TOKEN IS NOT A SESSION', () => {
  // The half-state this refuses: a UI that looks signed in and cannot make one authorised
  // call, so every screen 401s and nothing on the page says why.
  assert.equal(normalizeSession({ user: { username: 'jrivera' } }), null);
  assert.equal(normalizeSession({ token: '' }), null);
  assert.equal(normalizeSession({ token: '   ' }), null, 'whitespace is not a token');
  assert.equal(normalizeSession(null), null);
  assert.equal(normalizeSession('tok'), null, 'a bare string is not a session');
});

test('an unknown role in a stored session is not a promotion', () => {
  const s = normalizeSession({ token: 't', user: { username: 'x', role: 'wizard' } });
  assert.equal(s.user.role, 'wizard', 'stored verbatim…');
  // …and auth-gate.roleOf is what decides; see auth-gate.test.mjs. This file only pins that
  // the store does not INVENT a role when one is absent.
  assert.equal(normalizeSession({ token: 't', user: {} }).user.role, 'viewer');
  assert.equal(normalizeSession({ token: 't' }).user.username, '');
});

test('A MISSING EXPIRY IS NOT AN EXPIRED SESSION', () => {
  // The server re-verifies the HMAC and the tokenVersion on every call; it is the authority
  // on lifetime. Treating an absent field as expired here would sign a dispatcher out
  // mid-morning over a field the server never promised to send.
  assert.equal(sessionExpired({ token: 't' }), false);
  assert.equal(sessionExpired({ token: 't', expiresAt: 'not a date' }), false);
  assert.equal(sessionExpired({ token: 't', expiresAt: '2099-01-01T00:00:00Z' }), false);
  assert.equal(sessionExpired({ token: 't', expiresAt: '2020-01-01T00:00:00Z' }), true);
  const now = Date.parse('2026-09-02T12:00:00Z');
  assert.equal(sessionExpired({ token: 't', expiresAt: '2026-09-02T12:00:00Z' }, now), true, 'the instant it expires');
  assert.equal(sessionExpired({ token: 't', expiresAt: '2026-09-02T12:00:01Z' }, now), false);
});

test('a corrupt stored session is a signed-out browser, never a crash', () => {
  const st = fakeStore();
  st._map.set(SESSION_KEY, '{not json');
  assert.equal(readSessionFrom(st), null);
  st._map.set(SESSION_KEY, '{"user":{"username":"jrivera"}}');
  assert.equal(readSessionFrom(st), null, 'and a token-less one is still nothing');
});

test('A BROWSER THAT REFUSES STORAGE STILL GETS A WORKING SIGNED-IN TAB', () => {
  // Safari with "block all cookies" throws on getItem/setItem. Without this, signing in
  // would appear to do nothing at all — press Sign in, land back on the login screen.
  const st = fakeStore({ explode: true });
  assert.equal(readSessionFrom(st), null, 'reading throws and is caught');
  const s = writeSessionTo(st, LIVE);
  assert.equal(s.token, 'tok.abc', 'and the in-memory session is still returned');
});

test('an expired token is never put on a request', () => {
  // Sending a token we already know is dead spends a round trip to learn what we knew, and
  // lands the person on the login screen a beat later than they could have been.
  setSession({ ...LIVE, expiresAt: '2020-01-01T00:00:00Z' });
  assert.equal(sessionToken(), null);
  assert.ok(getSession(), 'the session object is still there for the UI to explain itself');
  setSession(LIVE);
  assert.equal(sessionToken(), 'tok.abc');
  clearSession();
  assert.equal(sessionToken(), null);
});

test('subscribers hear a sign-in and a sign-out', () => {
  clearSession();
  const seen = [];
  const off = subscribeSession((s) => seen.push(s ? s.user.username : null));
  setSession(LIVE);
  clearSession();
  off();
  assert.deepEqual(seen, [null, 'jrivera', null]);
});

test('A 401 SIGNS YOU OUT; A 403 DOES NOT', () => {
  // They are different problems. 401 means the session is gone — clear it and show the
  // login. 403 means the account's ROLE is too low: signing out and back in changes
  // nothing, and throwing a viewer into a login loop for pressing a dispatcher's button
  // teaches them nothing each time round.
  setSession(LIVE);
  const heard = [];
  const off = onAuthEvent((e) => heard.push(e.kind));

  emitAuthEvent({ kind: 'forbidden', url: '/.netlify/functions/nuvizz-scan-config' });
  assert.ok(getSession(), '403 must NOT clear the session');

  emitAuthEvent({ kind: 'expired', url: '/.netlify/functions/nuvizz-write' });
  assert.equal(getSession(), null, '401 clears it');

  off();
  assert.deepEqual(heard, ['forbidden', 'expired']);
});

test('a listener that throws cannot stop the others being told', () => {
  clearSession();
  let reached = false;
  const offBad = onAuthEvent(() => { throw new Error('bad listener'); });
  const offGood = onAuthEvent(() => { reached = true; });
  emitAuthEvent({ kind: 'forbidden' });
  assert.equal(reached, true);
  offBad(); offGood();
});
