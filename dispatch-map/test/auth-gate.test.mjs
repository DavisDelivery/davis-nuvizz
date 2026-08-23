// test/auth-gate.test.mjs — the login gate.
//
// This app has never had a login, and turning one on is the ONE change in the security
// plan that can lock a dispatcher out of a 700-stop morning. So these tests are mostly
// about the ways this must NOT fail: shipping inert, never flashing a login at someone
// already signed in, and never handing an unknown account more power than a driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  gateState, roleOf, isStaff, emailAllowed, friendlyAuthError, DEFAULT_ROLE, ROLES,
} from '../src/lib/auth-gate.js';

// ── SHIPPING INERT ───────────────────────────────────────────────────────────

test('THE FLAG OFF MEANS THE APP, ALWAYS — no login, whatever else is true', () => {
  // The whole promise of this phase: "the app works tomorrow the way it worked today."
  // With the flag off the gate must not consult readiness or the user at all, because
  // any path that can return 'login' here is a path that can lock the board.
  for (const ready of [true, false]) {
    for (const user of [null, undefined, { uid: 'u1' }]) {
      assert.equal(gateState({ enabled: false, ready, user }), 'app',
        `flag off must render the app (ready=${ready}, user=${JSON.stringify(user)})`);
    }
  }
  assert.equal(gateState({}), 'app', 'and a missing flag is an off flag');
  assert.equal(gateState(), 'app', 'and no argument at all is still the app');
});

// ── THE LOGIN FLASH ──────────────────────────────────────────────────────────

test('a signed-in dispatcher never sees a login flash on refresh', () => {
  // onAuthStateChanged resolves asynchronously on EVERY page load, so between mount and
  // that first report we do not yet know whether anyone is signed in. Rendering the
  // login there would flash it at someone already signed in on every single refresh —
  // and a flashed login is one somebody starts typing into.
  assert.equal(gateState({ enabled: true, ready: false, user: null }), 'loading');
  assert.equal(gateState({ enabled: true, ready: false, user: { uid: 'u1' } }), 'loading');
});

test('once Firebase has reported, the answer is simply who is signed in', () => {
  assert.equal(gateState({ enabled: true, ready: true, user: null }), 'login');
  assert.equal(gateState({ enabled: true, ready: true, user: { uid: 'u1' } }), 'app');
});

// ── ROLES ────────────────────────────────────────────────────────────────────

test('an account with NO role claim is a driver, never a dispatcher', () => {
  // Freshly created accounts, and any created before roles existed, arrive with no
  // claim. Defaulting those to staff would hand the board to the next person an admin
  // creates and forgets to set. load-scan's auth module already made this call in these
  // words — "anything unrecognized is a driver, the least-privileged role" — and the two
  // systems must not disagree about what an unknown user can do.
  assert.equal(roleOf({ uid: 'u1' }), DEFAULT_ROLE);
  assert.equal(roleOf({ uid: 'u1', claims: {} }), 'driver');
  assert.equal(roleOf(null), 'driver');
  assert.equal(roleOf({ claims: { role: 'wizard' } }), 'driver', 'an unrecognised role is not a promotion');
  assert.equal(roleOf({ claims: { role: '' } }), 'driver');
});

test('a real role claim is honoured, case and whitespace forgiven', () => {
  assert.equal(roleOf({ claims: { role: 'dispatcher' } }), 'dispatcher');
  assert.equal(roleOf({ claims: { role: '  ADMIN ' } }), 'admin');
  assert.equal(roleOf({ claims: { role: 'Loader' } }), 'loader');
  for (const r of ROLES) assert.equal(roleOf({ claims: { role: r } }), r);
});

test('staff is dispatcher and admin — and a driver is not staff', () => {
  // This mirrors isStaff() in firestore.rules. If the two ever disagree, the screen and
  // the database disagree about who may edit a customer's receiving hours.
  assert.equal(isStaff({ claims: { role: 'dispatcher' } }), true);
  assert.equal(isStaff({ claims: { role: 'admin' } }), true);
  assert.equal(isStaff({ claims: { role: 'driver' } }), false);
  assert.equal(isStaff({ claims: { role: 'loader' } }), false);
  assert.equal(isStaff(null), false, 'nobody signed in is not staff');
});

// ── THE GOOGLE ALLOW-LIST ────────────────────────────────────────────────────

test('Google sign-in without an allow-list would let in ANY Google account', () => {
  // Stated as a test because it is the trap: Google authenticates every Google account
  // on earth, and once the Firestore rules trust request.auth, "signed in" is exactly
  // what an attacker needs. Firebase's authorized-domains list governs which SITE may
  // sign in, not which PERSON, so it does not cover this.
  assert.equal(emailAllowed('stranger@gmail.com', '@example.com'), false);
  assert.equal(emailAllowed('dispatcher@example.com', '@example.com'), true);
  assert.equal(emailAllowed('DISPATCHER@Example.COM', '@example.com'), true, 'case must not decide access');
});

test('the allow-list takes full addresses and domains, and an empty list means no restriction', () => {
  assert.equal(emailAllowed('a@b.com', 'a@b.com'), true);
  assert.equal(emailAllowed('c@b.com', 'a@b.com'), false);
  assert.equal(emailAllowed('ops@example.com, alt@example.net', 'ops@example.com'), false,
    'the ADDRESS is matched whole — a list is on the rule side, not the input side');
  assert.equal(emailAllowed('ops@example.net', 'inbox@example.com, @example.net'), true, 'multiple rules');
  assert.equal(emailAllowed('anyone@anywhere.com', ''), true, 'no list = email/password only, admin-created');
  assert.equal(emailAllowed('', '@example.com'), false, 'no email is never allowed');
  assert.equal(emailAllowed(null, '@example.com'), false);
});

test('A DOMAIN RULE CANNOT BE SPOOFED BY A LOOK-ALIKE DOMAIN', () => {
  // The leading "@" in the rule is what makes this safe, and it is easy to lose in a
  // refactor — so it is pinned. Without it, endsWith('example.com') would happily
  // admit notexample.com and example.com.evil.com, and a stranger becomes a
  // signed-in user the moment the Firestore rules start trusting request.auth.
  const RULE = '@example.com';
  assert.equal(emailAllowed('ops@example.com', RULE), true, 'the real domain still works');
  assert.equal(emailAllowed('x@notexample.com', RULE), false, 'suffix look-alike refused');
  assert.equal(emailAllowed('x@example.com.evil.com', RULE), false, 'prefix look-alike refused');
  // A SUBDOMAIN is a different mail domain and is NOT auto-admitted. If the company ever
  // genuinely mails from a subdomain, it gets its own rule on purpose rather than by accident.
  assert.equal(emailAllowed('x@sub.example.com', RULE), false, 'a subdomain is not the domain');
});

// ── WHAT A PERSON READS WHEN IT FAILS ────────────────────────────────────────

test('a failed sign-in says something a dispatcher can act on, not a Firebase code', () => {
  // "Firebase: Error (auth/wrong-password)" at 6am teaches nobody anything.
  assert.match(friendlyAuthError('auth/wrong-password'), /Wrong password/i);
  assert.match(friendlyAuthError('auth/user-not-found'), /No account/i);
  assert.match(friendlyAuthError('auth/network-request-failed'), /connection/i);
  assert.match(friendlyAuthError('auth/too-many-requests'), /Wait a minute/i);
  // An unknown code still gets a sentence, never a blank or the raw code.
  const unknown = friendlyAuthError('auth/something-new');
  assert.ok(unknown.length > 10 && !/auth\//.test(unknown), unknown);
  assert.ok(!/undefined|null/.test(friendlyAuthError(undefined)));
});

// ── THE WIRING, PINNED AT THE SOURCE ─────────────────────────────────────────

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('the gate is OUTSIDE Shell — Shell opens Firestore subscriptions on mount', () => {
  // useCustomerNotes subscribes to the whole customer_notes collection, useSmsMessages
  // to the threads, useDispatchPresence WRITES a presence doc — all on mount. A gate
  // rendered inside Shell would leak every one of those before anyone signed in.
  const app = APP.slice(APP.indexOf('export default function App()'));
  const gate = app.indexOf('gateState(');
  const shell = app.indexOf('<Shell />');
  assert.ok(gate > 0 && shell > 0, 'found both the gate and the Shell mount');
  assert.ok(gate < shell, 'the gate must be decided BEFORE Shell is mounted');
  assert.match(app, /state === 'login'/, 'there is a login branch');
});

test('the login screen has its own mobile and desktop views', () => {
  // Chad: "mobile and desktop should be treated as 2 different views." A single
  // responsive layout here is the easy way out and it is not what this ships.
  const src = readFileSync(new URL('../src/components/LoginScreen.jsx', import.meta.url), 'utf8');
  assert.match(src, /if \(isMobile\)/, 'a distinct phone branch exists');
  assert.ok(src.includes('PHONE') && src.includes('DESKTOP'), 'both views are marked out');
  // 16px inputs on the phone: anything smaller makes iOS zoom the page on focus.
  const phone = src.slice(src.indexOf('if (isMobile)'), src.indexOf('// ── DESKTOP'));
  assert.match(phone, /text-base/, 'phone inputs are 16px so iOS does not zoom the page');
  assert.match(phone, /min-h-\[4[89]px\]|min-h-\[5\dpx\]/, 'phone targets are thumb-sized');
  assert.ok(APP.includes('isMobile={viewportWidth < MOBILE_BREAKPOINT}'), 'and the app tells it which view to be');
});
