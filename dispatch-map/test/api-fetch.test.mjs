// test/api-fetch.test.mjs — THE ONE PLACE A SESSION TOKEN GETS ONTO A REQUEST.
//
// Two failures these are named for, both concrete and both already in this codebase:
//
//  1. THE DRIVERS PANEL. components/DriversPanel.jsx signs in against LOAD-SCAN and sends
//     THAT dispatcher token in Authorization; loadscan-admin.mts forwards the header
//     untouched to another origin. Overwriting it breaks the panel outright and ships a
//     dispatch-map session token to a second site.
//  2. THE COMMS TOKEN. The Customer-emails screen builds its own headers (x-comms-token,
//     Content-Type). A wrapper that ASSIGNED headers instead of merging would silently
//     drop it and turn a working PUT into a 403 nobody could explain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldAttachToken, mergeAuthHeaders, apiFetch, classifyRefusal, AUTH_HEADER_EXCLUDED } from '../src/lib/api.js';
import { setSession, clearSession, getSession } from '../src/lib/session.js';

const SESSION = { token: 'sess.tok', expiresAt: '2099-01-01T00:00:00.000Z', user: { username: 'jrivera', role: 'admin' } };

/** Records what fetch was called with and answers `status`. */
function stubFetch(status = 200, body = { ok: status < 400 }) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

// ── WHICH URLS ───────────────────────────────────────────────────────────────

test('our own functions get the token; nothing else does', () => {
  assert.equal(shouldAttachToken('/.netlify/functions/nuvizz-write'), true);
  assert.equal(shouldAttachToken('/.netlify/functions/send-sms?x=1'), true);
  assert.equal(shouldAttachToken('/api/nuvizz-write'), true, 'the netlify.toml alias is the same endpoint');
  assert.equal(shouldAttachToken('/version.json'), false);
  assert.equal(shouldAttachToken('/'), false);
  assert.equal(shouldAttachToken('/davis-logo.jpg'), false);
});

test('A TOKEN IS NEVER SENT TO ANOTHER ORIGIN', () => {
  // A session token on a request to Google Maps, a tile server or a POD image host is a
  // credential handed to a third party in a header they log.
  assert.equal(shouldAttachToken('https://maps.googleapis.com/maps/api/js'), false);
  assert.equal(shouldAttachToken('https://davis-driver-scorecard.netlify.app/.netlify/functions/x'), false);
  assert.equal(shouldAttachToken('http://evil.example/.netlify/functions/nuvizz-write'), false);
  assert.equal(shouldAttachToken(''), false);
  assert.equal(shouldAttachToken(null), false);
  assert.equal(shouldAttachToken(undefined), false);
});

test('LOADSCAN-ADMIN IS EXCLUDED BY URL, WHATEVER QUERY IT CARRIES', () => {
  // The Drivers panel already puts a LOAD-SCAN token in Authorization there, and the proxy
  // forwards that header untouched to another site. Ours must never go near it.
  assert.ok(AUTH_HEADER_EXCLUDED.includes('loadscan-admin'));
  assert.equal(shouldAttachToken('/.netlify/functions/loadscan-admin'), false);
  assert.equal(shouldAttachToken('/.netlify/functions/loadscan-admin?target=drivers&q=1'), false);
  assert.equal(shouldAttachToken('/api/loadscan-admin?target=drivers'), false);
  // …and the exclusion is on the PATH, so a query string that merely mentions the name
  // cannot switch off the header on an unrelated endpoint.
  assert.equal(shouldAttachToken('/.netlify/functions/nuvizz-write?from=loadscan-admin'), true);
});

// ── MERGING, NOT REPLACING ───────────────────────────────────────────────────

test('THE COMMS TOKEN SURVIVES: existing headers are merged, never replaced', () => {
  const built = { 'Content-Type': 'application/json', 'x-comms-token': 'comms123' };
  const out = mergeAuthHeaders(built, 'sess.tok');
  assert.equal(out['x-comms-token'], 'comms123');
  assert.equal(out['Content-Type'], 'application/json');
  assert.equal(out.Authorization, 'Bearer sess.tok');
  assert.notEqual(out, built, 'and the caller’s object is not mutated');
  assert.equal(built.Authorization, undefined);
});

test('all three header shapes this codebase uses are handled', () => {
  const arr = mergeAuthHeaders([['x-comms-token', 'c']], 'sess.tok');
  assert.deepEqual(arr, [['x-comms-token', 'c'], ['Authorization', 'Bearer sess.tok']]);
  const h = mergeAuthHeaders(new Headers({ 'x-comms-token': 'c' }), 'sess.tok');
  assert.equal(h.get('authorization'), 'Bearer sess.tok');
  assert.equal(h.get('x-comms-token'), 'c');
  assert.equal(mergeAuthHeaders(undefined, 'sess.tok').Authorization, 'Bearer sess.tok');
});

test('AN AUTHORIZATION HEADER THE CALLER ALREADY SET WINS', () => {
  // The caller knows something we do not — see the Drivers panel. Silently replacing a
  // credential is how you send one to the wrong place.
  assert.equal(mergeAuthHeaders({ Authorization: 'Bearer loadscan.tok' }, 'sess.tok').Authorization, 'Bearer loadscan.tok');
  assert.equal(mergeAuthHeaders({ authorization: 'Bearer lower.case' }, 'sess.tok').authorization, 'Bearer lower.case');
  assert.deepEqual(mergeAuthHeaders([['authorization', 'x']], 'sess.tok'), [['authorization', 'x']]);
  assert.equal(mergeAuthHeaders({ 'x-comms-token': 'c' }, null)['x-comms-token'], 'c', 'no token, no change');
  assert.equal(mergeAuthHeaders({ a: 1 }, '').a, 1);
});

// ── THE CALL ─────────────────────────────────────────────────────────────────

test('signed in, the header rides along; signed out, the request is unchanged', async () => {
  const f = stubFetch();
  try {
    clearSession();
    await apiFetch('/.netlify/functions/nuvizz-write', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(f.calls[0].init.headers.Authorization, undefined, 'no session, no header');

    setSession(SESSION);
    await apiFetch('/.netlify/functions/nuvizz-write', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(f.calls[1].init.headers.Authorization, 'Bearer sess.tok');
    assert.equal(f.calls[1].init.method, 'POST', 'and everything else is passed through');
    assert.equal(f.calls[1].init.headers['content-type'], 'application/json');
  } finally { f.restore(); clearSession(); }
});

test('AN EXPIRED SESSION IS NOT SENT', async () => {
  const f = stubFetch();
  try {
    setSession({ ...SESSION, expiresAt: '2020-01-01T00:00:00Z' });
    await apiFetch('/.netlify/functions/nuvizz-write', { method: 'POST' });
    assert.equal(f.calls[0].init.headers, undefined, 'no header built at all — nothing to send');
    assert.equal(f.calls[0].init.method, 'POST', 'and the caller’s request is otherwise untouched');
  } finally { f.restore(); clearSession(); }
});

test('A 401 FROM OUR OWN GATE SIGNS YOU OUT; A 403 FROM IT LEAVES YOU SIGNED IN', async () => {
  // Different problems, different remedies. 401: the session is gone, show the login.
  // 403: the ROLE is too low — an admin has to change it, and signing out achieves nothing.
  let f = stubFetch(403, { ok: false, error: 'requires dispatcher' });
  try {
    setSession(SESSION);
    await apiFetch('/.netlify/functions/nuvizz-scan-config', { method: 'POST' });
    assert.ok(getSession(), '403 must not sign anyone out');
    f.restore();

    f = stubFetch(401, { ok: false, error: 'session revoked — sign in again' });
    await apiFetch('/.netlify/functions/nuvizz-write', { method: 'POST' });
    assert.equal(getSession(), null, '401 clears the session');
  } finally { f.restore(); clearSession(); }
});

test('PRESSING SAVE WITH LIVE WRITES OFF IS NOT "YOUR ACCOUNT IS NOT ALLOWED"', () => {
  // nuvizz-write answers 403 'live writes disabled — set NUVIZZ_WRITE_ENABLED=true'. On the
  // status code alone, a dispatcher in Beta mode would be told their account was too weak to
  // save — false, unfixable by them, and an hour on the phone. Every one of these is a real
  // string from a real endpoint this client calls.
  const notOurs = [
    [403, 'live writes disabled — set NUVIZZ_WRITE_ENABLED=true to enable'],   // nuvizz-write
    [403, 'not authorised — set COMMS_ADMIN_TOKEN on this site and send it as the x-comms-token header'],
    [403, 'not authorized'],                                                    // history-tombstone
    [403, 'forbidden'],                                                         // auth-bootstrap
    [401, 'unauthorized'],                                                      // gmail-auth: a bad ?key=
    [401, 'Unauthorized'],                                                      // debug-capture: its own token
    [401, ''],                                                                  // an HTML 502 with no body
  ];
  for (const [status, error] of notOurs) {
    assert.equal(classifyRefusal(status, error), null, `${status} ${JSON.stringify(error)} is not our gate`);
  }
});

test('THE CLIENT AND THE SERVER USE THE SAME WORDS FOR A DEAD SESSION', () => {
  // Every refusal requireUser() can produce must be recognised here. If the server re-words
  // one and this is not updated, a revoked account keeps a board open and nobody finds out —
  // so the drift fails HERE, naming the string that moved.
  const src = readFileSync(new URL('../netlify/functions/lib/require-user.mts', import.meta.url), 'utf8');
  // Every plain string on a denied(401, …) call — including BOTH branches of the ternary
  // that picks between 'sign in required' and 'sign-in not configured (…)'.
  const messages = [...src.matchAll(/denied\(\s*401\s*,([^\n]*)/g)]
    .flatMap(([, tail]) => [...tail.matchAll(/'([^']+)'/g)].map(([, m]) => m));
  assert.ok(messages.length >= 5, `found ${messages.length} 401 strings in require-user.mts: ${messages}`);
  for (const error of messages) {
    assert.equal(classifyRefusal(401, error), 'expired',
      `require-user.mts answers 401 "${error}" — api.js must classify it (see classifyRefusal)`);
  }
  // The 403 is built from a template literal, so it is checked by shape rather than scraped.
  assert.match(src, /denied\(403, `requires \$\{opts\.role\}`\)/, 'the role refusal still reads `requires <role>`');
  for (const r of ['admin', 'dispatcher', 'viewer']) {
    assert.equal(classifyRefusal(403, `requires ${r}`), 'forbidden', r);
  }
});

test('A 401 FROM SOMEWHERE ELSE MUST NOT SIGN A DISPATCHER OUT', async () => {
  // A POD image host or a tile server answering 401 says nothing about our session. Only
  // endpoints we actually put the token on speak this vocabulary.
  const f = stubFetch(401, { ok: false, error: 'session revoked — sign in again' });
  try {
    setSession(SESSION);
    await apiFetch('https://third-party.example/pod/123.jpg');
    assert.ok(getSession(), 'still signed in');
    await apiFetch('/.netlify/functions/loadscan-admin?target=drivers', { headers: { Authorization: 'Bearer loadscan.tok' } });
    assert.ok(getSession(), 'and a 401 from the excluded proxy is the LOAD-SCAN token’s problem, not ours');
  } finally { f.restore(); clearSession(); }
});

test('the response is handed back untouched — its body is still the caller’s', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, n: 7 }), { status: 200 });
  try {
    const r = await apiFetch('/.netlify/functions/day-completion');
    assert.deepEqual(await r.json(), { ok: true, n: 7 }, 'apiFetch did not consume the stream');
  } finally { globalThis.fetch = prev; }
});
