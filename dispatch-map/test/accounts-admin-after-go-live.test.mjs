// test/accounts-admin-after-go-live.test.mjs — Account & logins is everyone's until sign-in goes
// live, and admins' only after it (v1.82.2).
//
// Chad, 2026-09-28: "so i can get all the users set up on the backend before we turn this on so its
// seemless then the access to the usesrs tab will only be in my admin setup after we go live".
//
// Each test names the morning it prevents:
//   • Chad unable to reach the one screen where the first admin is created and the accounts are set
//     up, because it was hidden before there was anyone to show it to;
//   • a dispatcher, after go-live, opening the screen that manages everybody's accounts;
//   • the office PC unable to change hands at shift change, because the only Sign out was inside the
//     screen this hides — so the next person's changes reach NuVizz under the first person's login;
//   • a dispatcher whose NuVizz password stopped working handed a button into a screen they cannot
//     open, or told to "re-enter yours" there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

import { accountsTabVisible } from '../src/lib/auth-gate.js';
import { resolveIdentity } from '../netlify/functions/lib/nuvizz-identity.mts';
import { loginNoticeFrom } from '../src/lib/nuvizz-login-notice.js';
import { rolloutSteps } from '../src/lib/account-view.js';

const ADMIN = { username: 'owner', role: 'admin' };
const DISPATCHER = { username: 'jdoe', role: 'dispatcher' };
const VIEWER = { username: 'vw', role: 'viewer' };

// ── the rule ─────────────────────────────────────────────────────────────────

test('before go-live everyone is offered Account & logins: it is the only way in, and where the setup is done', () => {
  for (const u of [null, ADMIN, DISPATCHER, VIEWER, { role: 'nonsense' }]) {
    assert.equal(accountsTabVisible(u, { gated: false }), true);
  }
});

test('after go-live only admins are offered it', () => {
  assert.equal(accountsTabVisible(ADMIN, { gated: true }), true);
  assert.equal(accountsTabVisible(DISPATCHER, { gated: true }), false);
  assert.equal(accountsTabVisible(VIEWER, { gated: true }), false);
});

test('after go-live the absent and the malformed are not admins; the role is read the way roleOf reads it', () => {
  assert.equal(accountsTabVisible(null, { gated: true }), false);
  assert.equal(accountsTabVisible({}, { gated: true }), false);
  assert.equal(accountsTabVisible({ role: 'superadmin' }, { gated: true }), false);
  assert.equal(accountsTabVisible({ role: ' Admin ' }, { gated: true }), true, 'trimmed, any case — same as roleOf');
  assert.equal(accountsTabVisible(ADMIN), true, '`gated` defaults to true, like roleGateReason');
  assert.equal(accountsTabVisible(DISPATCHER), false);
});

// ── the wiring in App.jsx ────────────────────────────────────────────────────

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('wired: Shell decides once, from the signed-in user and this build\'s login mode', () => {
  assert.match(APP, /const accountsOpen = accountsTabVisible\(signedInUser, \{ gated: LOGIN_MODE === 'server' \}\);/);
  assert.match(APP, /const signOutName = LOGIN_MODE === 'server' && signedInUser/);
});

test('wired: both menus offer the screen only when accountsOpen, and no unconditional entry is left behind', () => {
  assert.match(APP, /\.\.\.\(accountsOpen \? \[\{ id: 'users', label: 'Account & logins'/, 'desktop More');
  // A link since v1.117.0, so it can open in a new tab (ScreenLink); the gate around it is the same.
  assert.match(APP, /\{showAccounts && \(\s*<ScreenLink[\s\S]{0,300}?onSelectMenu\('users'\)/, 'phone menu');
  assert.match(APP, /showAccounts=\{accountsOpen\}/, 'the phone bar is told');
  assert.equal((APP.match(/id: 'users', label: 'Account & logins'/g) || []).length, 1);
  assert.equal((APP.match(/onSelectMenu\('users'\)/g) || []).length, 1);
});

test('wired: a screen no longer offered does not stay open, and never renders for someone it is not offered to', () => {
  assert.match(APP, /if \(tab === 'users' && !accountsOpen\) setTab\('map'\)/);
  assert.match(APP, /tab === 'users' \? \(accountsOpen \? <AccountScreen /);
});

test('wired: once sign-in is live everyone can sign out from the menu, on the desktop and on a phone', () => {
  assert.match(APP, /\.\.\.\(signOutName \? \[\{ id: 'signout', label: 'Sign out'/, 'desktop More');
  assert.match(APP, /id === 'signout' \? signOutHere\(\)/, 'desktop pick');
  assert.match(APP, /if \(next === 'signout'\) \{ signOutHere\(\); return; \}/, 'phone pick');
  assert.match(APP, /\{signOutName && \(\s*<button[\s\S]{0,300}?onSelectMenu\('signout'\)/, 'phone row');
  assert.match(APP, /signOutName=\{signOutName\}/, 'the phone bar is told');
  assert.match(APP, /endSession\(\)\.catch\(\(\) => clearSession\(\)\)/, 'the local sign-out is guaranteed');
});

test('on a phone, Sign out sits in the always-open group above the More fold: it cannot fold away, and the floating Messages button covers the bottom of the long menu', () => {
  const bar = APP.slice(APP.indexOf('function MobileAppBar('), APP.indexOf('function MobileFAB('));
  const signOut = bar.indexOf("onSelectMenu('signout')");
  const fold = bar.indexOf('setMoreOpen((v) => !v)');
  const messages = bar.indexOf("onSelectMenu('messages')");
  assert.ok(signOut > 0 && fold > 0 && messages > 0);
  assert.ok(messages < signOut && signOut < fold, 'after Messages, before the More fold');
});

// ── the refused-login bar, rendered for real ─────────────────────────────────

const BAR_SRC = readFileSync(new URL('../src/components/NuvizzLoginBar.jsx', import.meta.url), 'utf8');
const ASK_ADMIN = /export const ASK_ADMIN = '([^']+)';/.exec(BAR_SRC)[1];
const Bar = (() => {
  const start = BAR_SRC.indexOf('export default function NuvizzLoginBar(');
  assert.ok(start > 0, 'NuvizzLoginBar not found');
  const code = transformSync(BAR_SRC.slice(start).replace('export default ', ''), {
    loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  }).code;
  return new Function('React', 'KeyRound', 'ASK_ADMIN', `${code}\nreturn NuvizzLoginBar;`)(React, () => null, ASK_ADMIN);
})();
const NOTICE = { kind: 'refused-now', text: 'NuVizz refused your saved NuVizz login (x). Your changes will go out under the shared login until it is re-entered.' };
const render = (props) => renderToStaticMarkup(React.createElement(Bar, { notice: NOTICE, onDismiss: () => {}, ...props }));

test('the refused-login bar gives someone who can open the screen a button into it', () => {
  for (const isMobile of [true, false]) {
    const html = render({ isMobile, onOpen: () => {} });
    assert.match(html, /Open Account &amp; logins/);
    assert.ok(!html.includes(ASK_ADMIN));
  }
});

test('…and everyone else "ask an admin", with no button into a screen they cannot open', () => {
  for (const isMobile of [true, false]) {
    const html = render({ isMobile, onOpen: null });
    assert.doesNotMatch(html, /Open Account/);
    assert.ok(html.includes(ASK_ADMIN));
    assert.match(html, /Dismiss/);
  }
});

test('wired: Shell hands the bar its button only when the screen is offered', () => {
  assert.match(APP, /onOpen=\{accountsOpen \? \(\) => \{ setLoginNotice\(null\); openTab\('users'\); \} : null\}/);
});

// ── the sentences, worded for whoever reads them ─────────────────────────────

test('the server says what has to happen and where — never "add yours" or "re-enter it", which a dispatcher cannot do once the screen is admin-only', () => {
  const principal = { username: 'jdoe', displayName: 'Jane Doe', authenticated: true, role: 'dispatcher' };
  const open = () => null;
  const cases = [
    ['not-saved', {}, /one has to be added under Account & logins/],
    ['rejected', { nuvizzUsername: 'jdoe', nuvizzPasswordSealed: 'v1.a.b.c', nuvizzRejectedAt: '2026-09-28T10:00:00Z', nuvizzRejectedReason: 'Invalid' }, /has to be re-entered under Account & logins/],
    ['unreadable', { nuvizzUsername: 'jdoe', nuvizzPasswordSealed: 'v1.a.b.c' }, /has to be re-entered under Account & logins/],
  ];
  for (const [why, doc, re] of cases) {
    for (const mode of ['preferred', 'required']) {
      const id = resolveIdentity({ mode, principal, doc, open });
      assert.equal(id.why, why, `${why} under ${mode}`);
      const sentence = id.note ?? id.error;
      assert.match(sentence, re);
      assert.doesNotMatch(sentence, /add yours|re-enter it /);
    }
  }
});

test('the browser\'s own sentence is worded the same way round', () => {
  assert.match(loginNoticeFrom({ loginRefused: 'x', identity: { mode: 'preferred' } }).text, /shared login until it is re-entered\.$/);
  assert.match(loginNoticeFrom({ loginRefused: 'x', identity: { mode: 'required' } }).text, /refused until it is re-entered\.$/);
});

test('the portal hold says the same', () => {
  const rwb = readFileSync(new URL('../netlify/functions/lib/nuvizz-rwb.mts', import.meta.url), 'utf8');
  assert.match(rwb, /It has to be re-entered under Account & logins\./);
  assert.doesNotMatch(rwb, /Re-enter it under Account & logins/);
});

test('the checklist says, at the go-live step, what going live does to this screen', () => {
  for (const loginMode of ['off', 'server']) {
    const gate = rolloutSteps({ loginMode, configured: true, authRequired: false, mode: 'preferred', users: [] }).find((s) => s.key === 'gate');
    assert.match(gate.detail, /only admins see this screen/i);
    assert.match(gate.detail, /signs out from the menu/);
  }
});
