// test/nuvizz-identity.test.mjs — whose NuVizz login a write goes out under.
//
// Pins the RULES in lib/nuvizz-identity.mts: the switch's house shape, the sealed password's
// binding to both usernames, every fallback under `preferred` and every refusal under
// `required`, and how NuVizz's answer to a login check is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  personalLoginsMode, normalizeNuvizzUsername, nuvizzPasswordProblem,
  loginKey, loginKeyReady, sealNuvizzPassword, openNuvizzPassword,
  publicNuvizzLogin, resolveIdentity, publicIdentity, basicAuthFor,
  classifyApiCheck, classifyPortalLogin, describeCheck, NUVIZZ_LOGIN_FIELD_NAMES,
} from '../netlify/functions/lib/nuvizz-identity.mts';

const KEY = crypto.createHash('sha256').update('test-key').digest();
const OTHER_KEY = crypto.createHash('sha256').update('another-key').digest();

// ── the switch ───────────────────────────────────────────────────────────────

test('switch: unset is preferred — the setting that can never stop a Save', () => {
  assert.equal(personalLoginsMode({}), 'preferred');
  assert.equal(personalLoginsMode({ NUVIZZ_PERSONAL_LOGINS: '' }), 'preferred');
});

test('switch: the house off-words put every write back on the shared login', () => {
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(personalLoginsMode({ NUVIZZ_PERSONAL_LOGINS: v }), 'off', v);
});

test('switch: required is an explicit word, and a typo of it never tightens or disables', () => {
  for (const v of ['required', 'REQUIRED', 'require', 'strict', 'only']) assert.equal(personalLoginsMode({ NUVIZZ_PERSONAL_LOGINS: v }), 'required', v);
  for (const v of ['requried', 'on', 'true', 'yes', 'maybe', 'of']) assert.equal(personalLoginsMode({ NUVIZZ_PERSONAL_LOGINS: v }), 'preferred', v);
});

// ── what a person may type ───────────────────────────────────────────────────

test('NuVizz username: trimmed, case kept, and never a colon (it would split Basic auth)', () => {
  assert.equal(normalizeNuvizzUsername('  JDoe  '), 'JDoe');
  assert.equal(normalizeNuvizzUsername('jane.doe@example.com'), 'jane.doe@example.com');
  assert.equal(normalizeNuvizzUsername('jane:doe'), null);
  assert.equal(normalizeNuvizzUsername('jane doe'), null);
  assert.equal(normalizeNuvizzUsername('jane\tdoe'), null);
  assert.equal(normalizeNuvizzUsername(''), null);
  assert.equal(normalizeNuvizzUsername('x'.repeat(121)), null);
});

test('NuVizz password: required, bounded, no control characters — spaces are fine', () => {
  assert.match(nuvizzPasswordProblem(''), /required/);
  assert.match(nuvizzPasswordProblem(undefined), /required/);
  assert.equal(nuvizzPasswordProblem('correct horse battery'), null);
  assert.match(nuvizzPasswordProblem('a'.repeat(201)), /at most 200/);
  assert.match(nuvizzPasswordProblem('abc\ndef'), /control/);
});

// ── the key ──────────────────────────────────────────────────────────────────

test('key: an explicit NUVIZZ_LOGIN_KEY wins; otherwise derived from the service account', () => {
  const a = loginKey({ NUVIZZ_LOGIN_KEY: 'pass-phrase' });
  const b = loginKey({ FIREBASE_SA: JSON.stringify({ private_key: '-----BEGIN KEY-----abc' }) });
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.notDeepEqual(a, b);
  // Its own label: the Gmail grant's key and this one are never the same bytes.
  const gmailStyle = crypto.createHash('sha256').update('dd-gmail|-----BEGIN KEY-----abc').digest();
  assert.notDeepEqual(b, gmailStyle);
});

test('key: no key material is an error, never plaintext storage', () => {
  assert.throws(() => loginKey({}), /no key material/);
  assert.throws(() => loginKey({ FIREBASE_SA: '{"client_email":"x"}' }), /private_key/);
  assert.equal(loginKeyReady({}), false);
  assert.equal(loginKeyReady({ NUVIZZ_LOGIN_KEY: 'k' }), true);
});

// ── sealing ──────────────────────────────────────────────────────────────────

test('seal: round-trips, and the ciphertext does not contain the password', () => {
  const blob = sealNuvizzPassword('Hunter2!!', 'jane', 'jdoe', KEY);
  assert.match(blob, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!blob.includes('Hunter2'));
  assert.equal(openNuvizzPassword(blob, 'jane', 'jdoe', KEY), 'Hunter2!!');
});

test('seal: a blob copied onto ANOTHER dispatch-map account does not open', () => {
  const blob = sealNuvizzPassword('Hunter2!!', 'jane', 'jdoe', KEY);
  assert.equal(openNuvizzPassword(blob, 'mike', 'jdoe', KEY), null);
});

test('seal: a blob left under an EDITED NuVizz username does not open', () => {
  const blob = sealNuvizzPassword('Hunter2!!', 'jane', 'jdoe', KEY);
  assert.equal(openNuvizzPassword(blob, 'jane', 'someone-else', KEY), null);
});

test('seal: a changed key, a flipped byte, or junk opens to null and never throws', () => {
  const blob = sealNuvizzPassword('Hunter2!!', 'jane', 'jdoe', KEY);
  assert.equal(openNuvizzPassword(blob, 'jane', 'jdoe', OTHER_KEY), null);
  const parts = blob.split('.');
  const ct = Buffer.from(parts[3], 'base64url'); ct[0] ^= 1;
  assert.equal(openNuvizzPassword([parts[0], parts[1], parts[2], ct.toString('base64url')].join('.'), 'jane', 'jdoe', KEY), null);
  for (const junk of [null, undefined, '', 'v1.a.b', 'v2.a.b.c', 42, {}]) assert.equal(openNuvizzPassword(junk, 'jane', 'jdoe', KEY), null);
});

// ── what a browser may see ───────────────────────────────────────────────────

test('public view: never the sealed blob, and "saved" needs both halves', () => {
  const doc = {
    nuvizzUsername: 'jdoe', nuvizzPasswordSealed: 'v1.a.b.c', nuvizzSavedAt: '2026-09-26T20:00:00Z', nuvizzSavedBy: 'owner',
    nuvizzCheck: { at: '2026-09-26T20:00:01Z', api: 'ok', apiStatus: 404, portal: 'ok', calls: 5 },
    nuvizzRejectedAt: null,
  };
  const p = publicNuvizzLogin(doc);
  assert.equal(p.saved, true);
  assert.equal(p.username, 'jdoe');
  assert.equal(p.check.api, 'ok');
  assert.equal(p.check.apiStatus, 404);
  assert.equal(p.check.calls, 5);
  assert.ok(!JSON.stringify(p).includes('v1.a.b.c'));
  assert.equal(publicNuvizzLogin({ nuvizzUsername: 'jdoe' }).saved, false);
  assert.equal(publicNuvizzLogin({ nuvizzPasswordSealed: 'v1.a.b.c' }).saved, false);
  assert.equal(publicNuvizzLogin(null).saved, false);
});

test('public view: an unrecognised verdict reads as "no clear answer", never as accepted', () => {
  const p = publicNuvizzLogin({ nuvizzUsername: 'j', nuvizzPasswordSealed: 'x', nuvizzCheck: { at: 't', api: 'yes', portal: true } });
  assert.equal(p.check.api, 'unknown');
  assert.equal(p.check.portal, 'unknown');
});

test('public view: a recorded refusal surfaces with its reason', () => {
  const p = publicNuvizzLogin({ nuvizzUsername: 'j', nuvizzPasswordSealed: 'x', nuvizzRejectedAt: '2026-09-26T21:00:00Z', nuvizzRejectedReason: 'NuVizz answered 401' });
  assert.deepEqual(p.rejected, { at: '2026-09-26T21:00:00Z', reason: 'NuVizz answered 401' });
});

test('remove clears exactly what save sets', () => {
  assert.deepEqual([...NUVIZZ_LOGIN_FIELD_NAMES].sort(), [
    'nuvizzCheck', 'nuvizzPasswordSealed', 'nuvizzRejectedAt', 'nuvizzRejectedReason', 'nuvizzSavedAt', 'nuvizzSavedBy', 'nuvizzUsername',
  ]);
});

// ── ONE WRITE: WHOSE LOGIN? ──────────────────────────────────────────────────

const JANE = { username: 'jane', displayName: 'Jane Doe', authenticated: true };
const LEGACY = { username: 'legacy', displayName: 'Dispatch (no login)', authenticated: false };
const opener = (key) => (blob, a, n) => openNuvizzPassword(blob, a, n, key);
const savedDoc = (over = {}) => ({ username: 'jane', nuvizzUsername: 'jdoe', nuvizzPasswordSealed: sealNuvizzPassword('Hunter2!!', 'jane', 'jdoe', KEY), ...over });

test('personal: a signed-in person with a working saved login writes as themselves', () => {
  const id = resolveIdentity({ mode: 'preferred', principal: JANE, doc: savedDoc(), open: opener(KEY) });
  assert.deepEqual(id, { kind: 'personal', appUser: 'jane', nuvizzUser: 'jdoe', password: 'Hunter2!!' });
  const req = resolveIdentity({ mode: 'required', principal: JANE, doc: savedDoc(), open: opener(KEY) });
  assert.equal(req.kind, 'personal');
});

test('off: every write is the shared login, even for a person with a working saved login', () => {
  const id = resolveIdentity({ mode: 'off', principal: JANE, doc: savedDoc(), open: opener(KEY) });
  assert.equal(id.kind, 'shared');
  assert.equal(id.why, 'off');
});

// Every reason a personal login is unusable, in both modes. `preferred` falls back and SAYS
// why; `required` refuses with the same sentence. Never a silent fallback under `required`.
const UNUSABLE = [
  ['not-signed-in', { principal: LEGACY, doc: null, open: opener(KEY) }, /sign in under Account & logins/],
  ['not-saved', { principal: JANE, doc: { username: 'jane' }, open: opener(KEY) }, /No NuVizz login is saved for Jane Doe/],
  ['rejected', { principal: JANE, doc: savedDoc({ nuvizzRejectedAt: '2026-09-26T21:00:00Z', nuvizzRejectedReason: 'NuVizz answered 401' }), open: opener(KEY) }, /NuVizz refused the login saved for Jane Doe \(NuVizz answered 401\)/],
  ['unreadable', { principal: JANE, doc: savedDoc(), open: opener(OTHER_KEY) }, /can no longer be read/],
  ['unreadable', { principal: JANE, doc: savedDoc(), open: () => { throw new Error('no key material'); } }, /can no longer be read/],
];

for (const [why, input, sentence] of UNUSABLE) {
  test(`preferred + ${why}: falls back to the shared login and says why`, () => {
    const id = resolveIdentity({ mode: 'preferred', ...input });
    assert.equal(id.kind, 'shared');
    assert.equal(id.why, why);
    assert.match(id.note, sentence);
  });
  test(`required + ${why}: refused with a 403 naming the one thing to fix`, () => {
    const id = resolveIdentity({ mode: 'required', ...input });
    assert.equal(id.kind, 'refused');
    assert.equal(id.why, why);
    assert.equal(id.status, 403);
    assert.match(id.error, sentence);
    // NOT the role-refusal shape lib/api.js turns into the role bar.
    assert.doesNotMatch(id.error, /^requires\s+\w+$/i);
  });
}

test('an account that could not be READ is not "nothing saved" — different sentence, and a 503 when strict', () => {
  const pref = resolveIdentity({ mode: 'preferred', principal: JANE, doc: null, docUnavailable: true, open: opener(KEY) });
  assert.equal(pref.kind, 'shared');
  assert.equal(pref.why, 'unavailable');
  assert.doesNotMatch(pref.note, /No NuVizz login is saved/);
  const req = resolveIdentity({ mode: 'required', principal: JANE, doc: null, docUnavailable: true, open: opener(KEY) });
  assert.equal(req.kind, 'refused');
  assert.equal(req.status, 503);
  assert.match(req.error, /try the Save again/);
});

test('the legacy principal is never treated as an account, whatever its username says', () => {
  const id = resolveIdentity({ mode: 'preferred', principal: LEGACY, doc: savedDoc({ username: 'legacy' }), open: opener(KEY) });
  assert.equal(id.kind, 'shared');
  assert.equal(id.appUser, null);
});

test('public identity: says whose login went out, never the password', () => {
  const p = publicIdentity(resolveIdentity({ mode: 'preferred', principal: JANE, doc: savedDoc(), open: opener(KEY) }), 'preferred');
  assert.deepEqual(p, { mode: 'preferred', as: 'personal', appUser: 'jane', nuvizzUser: 'jdoe' });
  assert.ok(!JSON.stringify(p).includes('Hunter2'));
  const s = publicIdentity(resolveIdentity({ mode: 'preferred', principal: JANE, doc: { username: 'jane' }, open: opener(KEY) }), 'preferred');
  assert.equal(s.as, 'shared');
  assert.equal(s.why, 'not-saved');
  assert.match(s.note, /No NuVizz login/);
});

test('Basic auth is user:password, base64', () => {
  assert.equal(basicAuthFor('jdoe', 'p w'), 'Basic ' + Buffer.from('jdoe:p w').toString('base64'));
});

// ── reading NuVizz's answer ──────────────────────────────────────────────────

test('API check: 401/403 is a refusal; any other answer means the login got past the door', () => {
  assert.equal(classifyApiCheck(401), 'refused');
  assert.equal(classifyApiCheck(403), 'refused');
  for (const s of [200, 204, 400, 404, 409]) assert.equal(classifyApiCheck(s), 'ok', String(s));
});

test('API check: an outage is never recorded as a wrong password', () => {
  for (const s of [0, null, undefined, NaN, 500, 502, 503]) assert.equal(classifyApiCheck(s), 'unknown', String(s));
});

test('portal check: a token is ok', () => {
  assert.deepEqual(classifyPortalLogin([], true), { verdict: 'ok', detail: null });
});

test('portal check: the sign-in answered and issued no token → refused, quoting NuVizz', () => {
  const r = classifyPortalLogin([{ step: 'bootstrap', status: 200, csrfFound: true }, { step: 'checkCompanyLogin', status: 200 }, { step: 'userLogin', status: 200, jwt: false, msg: 'Invalid username or password' }], false);
  assert.equal(r.verdict, 'refused');
  assert.match(r.detail, /Invalid username or password/);
  assert.equal(classifyPortalLogin([{ step: 'userLogin', status: 401, jwt: false }], false).verdict, 'refused');
});

test('portal check: signed in but no Route Workbench access → refused, and says which', () => {
  const r = classifyPortalLogin([{ step: 'userLogin', status: 200, jwt: true }, { step: 'authtoken', status: 403, authToken: false }], false);
  assert.equal(r.verdict, 'refused');
  assert.match(r.detail, /Route Workbench/);
});

test('portal check: a missing login page, a 5xx or a failed token step is NOT a wrong password', () => {
  assert.equal(classifyPortalLogin([{ step: 'bootstrap', status: 200, csrfFound: false }], false).verdict, 'unknown');
  assert.equal(classifyPortalLogin([], false).verdict, 'unknown');
  assert.equal(classifyPortalLogin([{ step: 'userLogin', status: 502, jwt: false }], false).verdict, 'unknown');
  assert.equal(classifyPortalLogin([{ step: 'userLogin', status: 0, jwt: false }], false).verdict, 'unknown');
  assert.equal(classifyPortalLogin([{ step: 'userLogin', status: 200, jwt: true }, { step: 'authtoken', status: 500 }], false).verdict, 'unknown');
});

test('describeCheck: one readable line, raw status included', () => {
  assert.equal(describeCheck(null), 'not tested');
  assert.equal(describeCheck({ at: 't', api: 'ok', apiStatus: 404, portal: 'refused' }), 'API accepted (HTTP 404) · Route Workbench REFUSED');
});
