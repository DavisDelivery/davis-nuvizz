// test/auth-gate.test.mjs — the login gate.
//
// This app has never had a login, and turning one on is the ONE change in the security
// plan that can lock a dispatcher out of a 700-stop morning. So these tests are mostly
// about the ways this must NOT fail: shipping inert, never flashing a login at someone
// already signed in, never handing an unknown account more power than a viewer, and
// never showing two logins at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  gateState, roleOf, isStaff, roleAtLeast, resolveGateMode,
  emailAllowed, friendlyAuthError, DEFAULT_ROLE, ROLES,
} from '../src/lib/auth-gate.js';
import { ROLES as SERVER_ROLES, normalizeRole } from '../netlify/functions/lib/auth-core.mts';

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

test('THE SCREEN AND THE SERVER USE ONE ROLE VOCABULARY, NOT THREE', () => {
  // The bug this replaces: auth-gate listed ['driver','loader','dispatcher','admin'] while
  // auth-core.mts lists ['admin','dispatcher','viewer'] and firestore.rules' isStaff() reads
  // dispatcher|admin. A real 'viewer' — the role the server hands anything it does not
  // recognise — matched nothing here, fell to 'driver', and under the drafted rules could
  // read NOTHING. Not an error message: a blank board at 6am with nothing to explain it.
  assert.deepEqual([...ROLES].sort(), [...SERVER_ROLES].sort(),
    'auth-gate.ROLES must be exactly auth-core.mts ROLES');
  assert.equal(DEFAULT_ROLE, normalizeRole('anything-unrecognised'),
    'and the two must fall back to the same least-privileged role');
});

test('an account with NO role is a viewer, never a dispatcher', () => {
  // Freshly created accounts, and any created before roles existed, arrive with nothing.
  // Defaulting those to staff would hand the board to the next person an admin creates and
  // forgets to set. The server says it in these words — "anything unrecognised is a viewer,
  // the least-privileged role, never a guess upward" — and the two must not disagree.
  assert.equal(roleOf({ username: 'u1' }), DEFAULT_ROLE);
  assert.equal(roleOf({ username: 'u1', role: '' }), 'viewer');
  assert.equal(roleOf(null), 'viewer');
  assert.equal(roleOf({ role: 'wizard' }), 'viewer', 'an unrecognised role is not a promotion');
  assert.equal(roleOf({ role: 'driver' }), 'viewer', 'and neither is a role from the OTHER system');
  assert.equal(roleOf({ claims: { role: 'loader' } }), 'viewer');
});

test('a real role is honoured from either system, case and whitespace forgiven', () => {
  // `role` is the shape auth-login returns; `claims.role` is the Firebase custom claim.
  // A session from either must resolve the same way or the screen and the rules disagree.
  assert.equal(roleOf({ role: 'dispatcher' }), 'dispatcher');
  assert.equal(roleOf({ role: '  ADMIN ' }), 'admin');
  assert.equal(roleOf({ claims: { role: 'dispatcher' } }), 'dispatcher');
  for (const r of ROLES) assert.equal(roleOf({ role: r }), r);
});

test('staff is dispatcher and admin — and a viewer is not staff', () => {
  // This mirrors isStaff() in firestore.rules. If the two ever disagree, the screen and
  // the database disagree about who may edit a customer's receiving hours.
  assert.equal(isStaff({ role: 'dispatcher' }), true);
  assert.equal(isStaff({ role: 'admin' }), true);
  assert.equal(isStaff({ role: 'viewer' }), false);
  assert.equal(isStaff(null), false, 'nobody signed in is not staff');
});

test('roleAtLeast ranks the same way the server does', () => {
  // Mirrors roleAtLeast() in auth-core.mts. A screen that thinks a viewer may press a
  // dispatcher's button shows a control that can only ever answer 403.
  assert.equal(roleAtLeast({ role: 'admin' }, 'dispatcher'), true);
  assert.equal(roleAtLeast({ role: 'dispatcher' }, 'dispatcher'), true);
  assert.equal(roleAtLeast({ role: 'viewer' }, 'dispatcher'), false);
  assert.equal(roleAtLeast(null, 'viewer'), true, 'everyone clears the floor');
  assert.equal(roleAtLeast({ role: 'dispatcher' }, 'admin'), false);
});

// ── TWO LOGINS IS ONE TOO MANY ───────────────────────────────────────────────

test('THERE IS ONE LOGIN, AND IT IS THE ONE THE SERVER VERIFIES', () => {
  // Running two is not redundancy, it is a locked-out morning: a Firebase ID token in the
  // Authorization header parses as our session-token shape and then fails the HMAC compare,
  // so requireUser() answers 401 even with AUTH_REQUIRED unset. Whichever flag is set, the
  // login that appears is the server one — including when only the RETIRED flag is set,
  // because whoever set it wanted a login and a broken one is worse than either the right
  // one or none.
  assert.equal(resolveGateMode({ serverLogin: true, firebaseLogin: true }).mode, 'server');
  assert.equal(resolveGateMode({ serverLogin: true, firebaseLogin: false }).mode, 'server');
  assert.equal(resolveGateMode({ serverLogin: false, firebaseLogin: true }).mode, 'server',
    'the retired flag must never produce a login screen that signs into nothing');
  assert.equal(resolveGateMode({ serverLogin: false, firebaseLogin: false }).mode, 'off');
  assert.equal(resolveGateMode({}).mode, 'off');
  assert.equal(resolveGateMode().mode, 'off', 'and no argument at all is no login');
});

test('and the app can SAY which flag turned it on', () => {
  // A switch whose position cannot be read is not a switch. These two booleans are the only
  // reason the resolver returns an object: the caller reports the situation instead of
  // re-deriving it from the flags it just handed in.
  assert.deepEqual(resolveGateMode({ serverLogin: false, firebaseLogin: true }),
    { mode: 'server', legacyFlagOnly: true, bothFlags: false });
  assert.deepEqual(resolveGateMode({ serverLogin: true, firebaseLogin: true }),
    { mode: 'server', legacyFlagOnly: false, bothFlags: true });
  assert.deepEqual(resolveGateMode({ serverLogin: true, firebaseLogin: false }),
    { mode: 'server', legacyFlagOnly: false, bothFlags: false });
  assert.deepEqual(resolveGateMode({}), { mode: 'off', legacyFlagOnly: false, bothFlags: false });
});

// ── THE SCREENS BETWEEN THE LOGIN AND THE BOARD ──────────────────────────────

test('A TEMPORARY PASSWORD CANNOT BE POSTPONED PAST THE BOARD', () => {
  // An admin creates an account with a temporary password. If the board opened first, the
  // change would be postponed forever and three people would share one password on the
  // dispatch whiteboard — which is the state this whole login exists to end.
  assert.equal(gateState({ enabled: true, ready: true, user: { username: 'u' }, mustChangePassword: true }), 'must-change');
  assert.equal(gateState({ enabled: true, ready: true, user: { username: 'u' }, mustChangePassword: false }), 'app');
  assert.equal(gateState({ enabled: true, ready: true, user: null, mustChangePassword: true }), 'login',
    'nobody signed in is still the login, not a password form for nobody');
});

test('AN EMAILED RESET LINK WORKS EVEN BEFORE THE LOGIN IS SWITCHED ON', () => {
  // Rollout order: accounts are created and the reset mails go out BEFORE the gate flag is
  // flipped. If the flag decided this, every one of those links would open the board and
  // silently do nothing, and nobody would set a password until somebody noticed.
  assert.equal(gateState({ enabled: false, ready: true, user: null, resetLink: true }), 'reset');
  assert.equal(gateState({ enabled: true, ready: false, user: null, resetLink: true }), 'reset',
    'and it does not wait on a session check it does not need');
  assert.equal(gateState({ enabled: true, ready: true, user: { username: 'u' }, resetLink: true }), 'reset',
    'even signed in — the person clicked a link to change a password');
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

test('EVERY auth screen has its own mobile and desktop view', () => {
  // Chad: "mobile and desktop should be treated as 2 different views and quit trying to
  // take the easy way out and make screens work for both." Four screens ship here —
  // sign-in, forgot-password, forced change, reset-from-link — and a screen built for one
  // view and patched for the other is the easy way out. Each is checked separately because
  // "the file has a phone branch somewhere" is exactly how the second screen gets missed.
  const files = {
    'LoginScreen.jsx': ['SIGN IN', 'FORGOT PASSWORD'],
    'PasswordScreens.jsx': ['FORCED PASSWORD CHANGE', 'RESET FROM THE EMAILED LINK'],
  };
  for (const [file, screens] of Object.entries(files)) {
    const src = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
    for (const s of screens) assert.ok(src.includes(s), `${file} contains the ${s} screen`);
    const phones = src.split('// ── PHONE').length - 1;
    const desktops = src.split('// ── DESKTOP').length - 1;
    assert.equal(phones, screens.length, `${file}: one phone view per screen`);
    assert.equal(desktops, screens.length, `${file}: one desktop view per screen`);
    assert.equal(src.split('if (isMobile)').length - 1, screens.length, `${file}: a distinct phone branch per screen`);
    // 16px inputs on the phone: anything smaller makes iOS zoom the whole page on focus,
    // and a zoomed password field in a truck cab at 6am is unusable one-handed.
    for (const part of src.split('// ── PHONE').slice(1)) {
      const phone = part.slice(0, part.indexOf('// ── DESKTOP') === -1 ? undefined : part.indexOf('// ── DESKTOP'));
      assert.match(phone, /text-base/, `${file}: phone inputs are 16px so iOS does not zoom`);
      assert.match(phone, /min-h-\[4[89]px\]|min-h-\[5\dpx\]/, `${file}: phone targets are thumb-sized`);
    }
  }
  assert.ok(/isMobile=\{isMobile\}/.test(APP), 'and the app tells each screen which view to be');
});
