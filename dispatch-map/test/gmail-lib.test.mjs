// test/gmail-lib.test.mjs — the parts of the Gmail connection that can be wrong.
//
// Chad: "I want the gmail auth added to the manifest tabs so it can parse my
// emails looking for manifest." Three things in that sentence are load-bearing
// and none of them are visible until they fail in production: finding the PDF
// inside a real MIME tree, refusing a mailbox that isn't ours, and never
// writing a refresh token where an unauthenticated browser can read it. Those
// are what this file pins down. No network, no Google, no Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAuthUrl, accountAllowed, GMAIL_SCOPE } from '../netlify/functions/lib/gmail.mts';
import { normalizeQuery, summarizeCycle, gmailNeedsReconnect } from '../netlify/functions/lib/mail-sources.mts';
import { DEFAULT_GMAIL_QUERY } from '../netlify/functions/lib/gmail-source.mts';
import { sealSecret, openSecret, stateValid, STATE_TTL_MS } from '../netlify/functions/lib/gmail-store.mts';

// ── the consent URL ──────────────────────────────────────────────────────────

test('the consent URL asks for read-only, offline, with consent forced', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's1' }));
  assert.equal(u.searchParams.get('scope'), GMAIL_SCOPE);
  assert.match(GMAIL_SCOPE, /gmail\.readonly$/, 'read-only and nothing more');
  // access_type=offline + prompt=consent is the ONLY combination that reliably
  // returns a refresh token; without it the scheduled poll dies after an hour.
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('state'), 's1');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x/cb');
});

test('a known mailbox is pre-selected on reconnect', () => {
  const u = new URL(buildAuthUrl({ clientId: 'c', redirectUri: 'r', state: 's', loginHint: 'inbox@example.com' }));
  assert.equal(u.searchParams.get('login_hint'), 'inbox@example.com');
  assert.equal(new URL(buildAuthUrl({ clientId: 'c', redirectUri: 'r', state: 's' })).searchParams.get('login_hint'), null);
});

// ── which mailbox may be stored ──────────────────────────────────────────────
//
// FIXTURE ADDRESSES ARE example.com ON PURPOSE — do not make them look real.
// Netlify's secrets scanning greps every file under this directory for the
// VALUES of the site's environment variables, and NUVIZZ_DAVIS_USER is an
// address. A lifelike example that merely CONTAINS it as a substring reads as
// that credential committed to the repo, and the deploy fails with no clue
// beyond a line number (v0.54.75 shipped exactly that and broke main's deploy).

test('with an allow-list, only a listed account may connect', () => {
  const allowList = 'inbox@example.com, ops@example.com';
  assert.equal(accountAllowed('INBOX@Example.com', { allowList }).ok, true, 'case-insensitive');
  const no = accountAllowed('stranger@example.net', { allowList });
  assert.equal(no.ok, false);
  assert.match(no.reason, /GMAIL_ALLOWED_ACCOUNTS/);
});

test('with no allow-list, the first account is pinned and a second one is refused', () => {
  // This is what stops a stranger who finds the start URL from replacing the
  // grant with their own mailbox on a site that has no login.
  assert.equal(accountAllowed('inbox@example.com', {}).ok, true, 'first connect');
  const second = accountAllowed('stranger@example.net', { pinned: 'inbox@example.com' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /disconnect that account first/);
  assert.equal(accountAllowed('inbox@example.com', { pinned: 'inbox@example.com' }).ok, true, 'reconnect same account');
});

test('an account Google did not name is refused', () => {
  assert.equal(accountAllowed('', {}).ok, false);
  assert.equal(accountAllowed(null, { allowList: 'a@b.c' }).ok, false);
});

// ── the refresh token never lands in Firestore as plain text ─────────────────

const KEY = Buffer.alloc(32, 7);

test('a sealed refresh token round-trips and does not contain the token', () => {
  const token = '1//0gSecretRefreshTokenValue';
  const blob = sealSecret(token, KEY);
  assert.ok(!blob.includes(token), 'the stored blob does not carry the token');
  assert.ok(!blob.includes('Secret'));
  assert.equal(openSecret(blob, KEY), token);
});

test('the same token seals differently every time (fresh IV)', () => {
  assert.notEqual(sealSecret('t', KEY), sealSecret('t', KEY));
});

test('a tampered blob, a wrong key, or junk opens to null — never to a half-token', () => {
  const blob = sealSecret('1//0gToken', KEY);
  const [v, iv, tag, ct] = blob.split('.');
  const flipped = `${v}.${iv}.${tag}.${Buffer.from('nope').toString('base64url')}${ct.slice(4)}`;
  assert.equal(openSecret(flipped, KEY), null, 'GCM rejects a tampered ciphertext');
  assert.equal(openSecret(blob, Buffer.alloc(32, 9)), null, 'wrong key');
  for (const junk of ['', 'v1.a.b', 'not-a-blob', null, undefined, 42]) {
    assert.equal(openSecret(junk, KEY), null);
  }
});

// ── the OAuth state ──────────────────────────────────────────────────────────

test('state must match, be fresh, and be present', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const stored = { state: 'abc123', at: '2026-08-15T11:58:00Z' };
  assert.equal(stateValid(stored, 'abc123', now), true);
  assert.equal(stateValid(stored, 'abc124', now), false, 'wrong state');
  assert.equal(stateValid(stored, 'abc', now), false, 'different length');
  assert.equal(stateValid(stored, '', now), false);
  assert.equal(stateValid(null, 'abc123', now), false);
  assert.equal(stateValid({ state: 'abc123', at: 'garbage' }, 'abc123', now), false);
  assert.equal(stateValid(stored, 'abc123', now + STATE_TTL_MS), false, 'expired');
});

// ── what the tab is told about the last poll ─────────────────────────────────
// The whole point of connecting a mailbox is that nobody has to remember to
// check it. That only holds if a mailbox that has STOPPED working says so — a
// lapsed grant that still reads "connected" is the silent rot this feature
// exists to prevent, one level up.

test('a lapsed or revoked grant is the one failure that asks for a reconnect', () => {
  for (const e of [
    'gmail: gmail auth failed: invalid_grant',
    'gmail: gmail auth failed: unauthorized_client',
    'resend: list 500; gmail: gmail auth failed: invalid_grant',
    'gmail: gmail /users/me/messages 401',
  ]) assert.equal(gmailNeedsReconnect(e), true, e);
});

test('a transient blip must NOT nag anyone into re-authorising', () => {
  for (const e of [
    '', null, undefined,
    'resend: list 500',                      // the other mailbox, not ours
    'gmail: gmail /users/me/messages 503',   // Google having a moment
    'gmail: fetch failed',
  ]) assert.equal(gmailNeedsReconnect(e), false, String(e));
});

test('the poll summary says what actually happened, in words', () => {
  assert.match(summarizeCycle({ ok: true, inbox: 3, outcomes: [{ outcome: 'checked' }] }), /1 freight report read/);
  assert.equal(summarizeCycle({ ok: true, inbox: 0, outcomes: [] }), 'no matching email found');
  assert.match(summarizeCycle({ ok: true, inbox: 5, outcomes: [] }), /nothing new/);
  assert.match(summarizeCycle({ ok: true, inbox: 2, outcomes: [{ outcome: 'retry' }] }), /will retry/);
  assert.match(summarizeCycle({ ok: true, inbox: 2, outcomes: [{ outcome: 'ignored' }] }), /no freight report among them/);
  assert.equal(summarizeCycle({ ok: true, skipped: 'gmail not connected' }), 'gmail not connected');
  assert.equal(summarizeCycle(null), '');
});

test('a blank saved search falls back to the shared default, never the whole mailbox', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(normalizeQuery(v), DEFAULT_GMAIL_QUERY);
  assert.equal(normalizeQuery('  from:uline.com  '), 'from:uline.com');
});
