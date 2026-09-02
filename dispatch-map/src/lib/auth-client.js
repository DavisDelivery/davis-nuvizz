// auth-client.js — THE BROWSER SIDE OF THE app_users LOGIN.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS REPLACES THE FIREBASE LOGIN RATHER THAN JOINING IT.
//
// v0.76.0 shipped a Firebase email/password gate (lib/auth.js). v0.83.0 shipped a
// SECOND, unrelated system server-side: usernames and passwords in Firestore `app_users`,
// HMAC session tokens, and requireUser() on 17 functions. Running both is not "belt and
// braces", it is actively broken — a Firebase ID token in the Authorization header parses
// as our JWT shape and then fails the HMAC compare, so requireUser answers 401 even with
// AUTH_REQUIRED unset, i.e. turning the OLD login on would break the app in LEGACY mode.
// One of them has to be the one that signs a person in. It is this one, because it is the
// one the functions actually verify.
//
// FIREBASE IS STILL IN THE PICTURE — as a CONSEQUENCE of signing in, not as the sign-in.
// Firestore rules can only read `request.auth`, and nothing this client does to a Netlify
// Function puts anything there. So after a successful sign-in we redeem the session for a
// Firebase CUSTOM token (auth-firebase-token.mts) and hand it to signInWithCustomToken.
// That single call is the whole reason the rules cutover is possible.
//
// AND IF THAT SECOND LEG FAILS, WE SAY SO. A person signed in to the functions but NOT to
// Firebase gets a board that loads and is quietly missing every receiving hour — the exact
// silent failure lib/permission-denied.js exists to stop. So sign-in reports the Firebase
// leg's real outcome ('ok' | 'skipped' | 'failed'), never an assumed one.
// ─────────────────────────────────────────────────────────────────────────────

import { setSession, clearSession, getSession, sessionToken } from './session.js';
import { clearDenied } from './permission-denied.js';

const FN = '/.netlify/functions';

/** Vite injects import.meta.env at build time; in Node (the unit suite) it is simply absent. */
function env(name) {
  try { return String(import.meta.env?.[name] ?? '').trim(); } catch { return ''; }
}
function flagOn(name) {
  const v = env(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** The switch for THIS login. Unset ⇒ no gate at all and the app renders as it always has. */
export function serverLoginEnabled() { return flagOn('VITE_LOGIN_ENABLED'); }

// ── the transport ────────────────────────────────────────────────────────────
//
// DELIBERATELY NOT apiFetch. Three of these endpoints answer 401 for reasons that have
// nothing to do with a dead session:
//   auth-login          401 = "wrong username or password"
//   auth-change-password 401 = "current password is wrong"
//   auth-reset-confirm   (400s, but the same class of user error)
// apiFetch treats a 401 from our own functions as "the session is gone", clears it and
// throws the app back to the login screen. Routed through it, a dispatcher who fat-fingers
// their CURRENT password on the forced-change screen would be signed out for the typo.
// So this transport attaches the token itself and interprets nothing.
async function authCall(path, { method = 'POST', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = sessionToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  let resp;
  try {
    resp = await fetch(`${FN}/${path}`, {
      method,
      cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    // No connection at all. Named separately from a server refusal because the two want
    // different things from the person reading it: one waits, the other calls Chad.
    return { ok: false, status: 0, error: 'No connection. Check signal and try again.', offline: true };
  }
  let data = null;
  try { data = await resp.json(); } catch { /* an HTML 502 from the platform */ }
  if (!resp.ok || data?.ok === false) {
    return { ok: false, status: resp.status, error: friendlyServerError(resp.status, data?.error), raw: data };
  }
  return { ok: true, status: resp.status, ...(data || {}) };
}

/**
 * PURE. A sentence a dispatcher at 6am can act on.
 *
 * The server's own `error` strings were written for a person and are used verbatim where
 * they exist — re-wording them here would give us two vocabularies for one failure and no
 * way to tell which one someone was quoting. The status-based fallbacks cover the cases
 * where the platform, not the handler, answered (an HTML 502 has no `error` at all).
 */
export function friendlyServerError(status, error) {
  const e = String(error || '').trim();
  if (e) return e.charAt(0).toUpperCase() + e.slice(1);
  if (status === 401) return 'Wrong username or password.';
  if (status === 403) return 'This account is not allowed to do that.';
  if (status === 423) return 'That account is locked. Wait a few minutes, or ask an admin.';
  if (status === 429) return 'Too many tries. Wait a few minutes and try again.';
  if (status === 503) return 'Sign-in is not switched on yet on the server. Tell Chad.';
  if (status >= 500) return 'The server had a problem. Try again in a moment.';
  return 'Could not sign in. Try again, and tell Chad if it keeps happening.';
}

// ── Firebase: the second leg ─────────────────────────────────────────────────
//
// Loaded dynamically, exactly like lib/auth.js did, and for the same reason: a project
// whose Auth product is not enabled must not be able to throw an initialisation error
// into the app that 700 stops depend on, and nothing should be imported at all while the
// login is switched off.

let _fbPromise = null;
async function firebaseAuth() {
  if (!_fbPromise) {
    _fbPromise = (async () => {
      const [{ app, firebaseConfigured }, lib] = await Promise.all([
        import('./firebase.js'),
        import('firebase/auth'),
      ]);
      if (!firebaseConfigured || !app) return null;
      return { lib, auth: lib.getAuth(app) };
    })().catch(() => null);
  }
  return _fbPromise;
}

/**
 * Redeem the session for a Firebase custom token and sign in with it.
 * Returns 'ok' | 'skipped' | 'failed' — never a claim we did not observe.
 *
 * 'skipped' means Firebase is not configured in this build at all (no VITE_FIREBASE_*),
 * which is a legitimate state for a preview deploy and is NOT a failure to report at a
 * dispatcher.
 */
export async function redeemFirebaseSession() {
  const fb = await firebaseAuth();
  if (!fb) return { state: 'skipped' };
  const r = await authCall('auth-firebase-token', { auth: true });
  if (!r.ok || !r.customToken) return { state: 'failed', error: r.error || 'no token returned' };
  try {
    await fb.lib.signInWithCustomToken(fb.auth, r.customToken);
    return { state: 'ok', uid: r.uid, expiresIn: r.expiresIn };
  } catch (e) {
    return { state: 'failed', error: e?.message || String(e) };
  }
}

/**
 * Called on every boot that already holds a session. Firebase keeps its OWN refresh token
 * in the browser, so the usual answer is "already signed in, do nothing" — this exists for
 * the case where it is not (cleared storage, a new browser profile, an expired refresh),
 * because that case is indistinguishable on screen from a working board right up until the
 * hours are missing.
 */
export async function ensureFirebaseSession() {
  if (!getSession()) return { state: 'skipped' };
  const fb = await firebaseAuth();
  if (!fb) return { state: 'skipped' };
  if (fb.auth.currentUser) return { state: 'ok', cached: true };
  return redeemFirebaseSession();
}

/**
 * Drop the Firebase identity. Best effort, and never throws — the caller is always on a
 * path where the session is already gone and a rejected promise there would take the
 * notice down with it.
 *
 * EXPORTED BECAUSE A DELIBERATE SIGN-OUT IS NOT THE ONLY WAY A SESSION DIES, and the other
 * way is the dangerous one. lib/auth-firebase.mts calls this mitigation (1) and documents
 * it as IMPLEMENTED: the two doors revoke at different speeds, so when a gated function
 * answers 401 'session revoked' or 'account inactive', the Firebase session minted from
 * that dead identity has to be dropped in the same ~30 seconds — otherwise it refreshes
 * itself for as long as the tab lives. Concretely: a dispatcher deactivated at 09:00 is put
 * on the login screen straight away, and under the cutover rules keeps full read/write on
 * customer_notes and sms_messages from a console tab all afternoon, because clearSession()
 * only clears OUR token and Firebase keeps its refresh token in its own storage.
 */
export async function dropFirebaseSession() {
  const fb = await firebaseAuth();
  if (!fb) return;
  try { await fb.lib.signOut(fb.auth); } catch { /* best effort — the session is already gone */ }
}

// ── the operations ───────────────────────────────────────────────────────────

/**
 * Sign in. Stores the session BEFORE redeeming the Firebase token, because the redeem
 * call needs it in the Authorization header.
 *
 * Resolves { ok:true, user, firebase } or { ok:false, error, status }. Never throws.
 */
export async function signIn(username, password) {
  const r = await authCall('auth-login', { body: { username: String(username || '').trim().toLowerCase(), password: String(password || '') } });
  if (!r.ok) return { ok: false, error: r.error, status: r.status, offline: r.offline };
  setSession({ token: r.token, expiresAt: r.expiresAt, user: r.user });
  clearDenied();                       // the previous person's refusals are not this person's
  const firebase = await redeemFirebaseSession();
  return { ok: true, user: r.user, firebase };
}

/** The forced change (mustChangePassword) and the ordinary one. A new session comes back. */
export async function changePassword(currentPassword, newPassword) {
  const r = await authCall('auth-change-password', { auth: true, body: { currentPassword, newPassword } });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  setSession({ token: r.token, expiresAt: r.expiresAt, user: r.user });
  const firebase = await redeemFirebaseSession();   // the old custom token carried the old tokenVersion
  return { ok: true, user: r.user, firebase };
}

/**
 * Ask for a reset link. The server answers the SAME generic success whether or not the
 * account exists (so this page cannot be used to enumerate usernames), and this passes
 * that through unchanged rather than inventing a more helpful lie.
 */
export async function requestPasswordReset(identifier) {
  const r = await authCall('auth-reset-request', { body: { identifier: String(identifier || '').trim() } });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  return { ok: true, message: r.message || 'If that account exists, a reset link is on its way.' };
}

/** Finish a reset from the emailed link. On success the person is signed in, no second step. */
export async function confirmPasswordReset(username, token, newPassword) {
  const r = await authCall('auth-reset-confirm', { body: { username, token, newPassword } });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  if (r.token) {
    setSession({ token: r.token, expiresAt: r.expiresAt, user: r.user });
    clearDenied();
    const firebase = await redeemFirebaseSession();
    return { ok: true, user: r.user, firebase, signedIn: true };
  }
  // AUTH_SESSION_SECRET is not set: the password IS changed but nobody can sign in yet.
  // Reported as exactly that rather than as a failure, because retrying will not help.
  return { ok: true, user: r.user, signedIn: false, note: r.note || 'Password set. Sign-in is not switched on yet.' };
}

/**
 * Sign out. The server call bumps tokenVersion so every OTHER device this person is signed
 * in on dies too — that is the point of it and it is why the local clear happens even when
 * the call fails: a network error must never leave someone looking signed in.
 */
export async function signOut() {
  try { await authCall('auth-logout', { auth: true }); } catch { /* local clear below is the guarantee */ }
  await dropFirebaseSession();
  clearDenied();
  clearSession();
}

/** Who does the SERVER think this is? Used on boot to catch a revoked or demoted session. */
export async function fetchMe() {
  const r = await authCall('auth-me', { method: 'GET', auth: true });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  return { ok: true, user: r.user, authRequired: r.authRequired === true };
}

// ── the password policy, mirrored ────────────────────────────────────────────
//
// THE SERVER IS THE AUTHORITY. passwordProblem() in netlify/functions/lib/auth-core.mts
// is what actually decides, and it is re-checked on every change and reset. This mirror
// exists only so the screen can say "at least 10 characters" while someone is typing
// instead of after a round trip and a rejected form — which is the difference between a
// hint and a scolding.
//
// The two must not drift, so test/auth-client.test.mjs imports the real auth-core rule and
// asserts the two agree on the whole boundary table. If someone tightens the server policy
// and forgets this file, that test goes red rather than the screen going quietly wrong.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const COMMON = ['password', 'davisdelivery', 'dispatch', 'qwertyuiop', '1234567890'];

/** PURE. A human-readable problem, or null when the password is acceptable. */
export function passwordProblem(pw, username) {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (s.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  if (/^(.)\1+$/.test(s)) return 'password cannot be one repeated character';
  const low = s.toLowerCase();
  if (username && low.includes(String(username).toLowerCase())) return 'password cannot contain the username';
  if (COMMON.some((w) => low === w || low === `${w}1` || low === `${w}!`)) return 'password is too common';
  return null;
}

// ── the reset link ───────────────────────────────────────────────────────────

/**
 * PURE. Is this page load an emailed reset link, and for whom?
 *
 * lib/auth-mail.mts builds `${origin}/reset-password?u=<username>&t=<token>`. Both halves
 * are required: a bare /reset-password with no token is somebody's bookmark, and showing
 * them a password form that cannot possibly work is worse than showing them the app.
 */
export function resetLinkParams(pathname, search) {
  if (!/^\/reset-password\/?$/.test(String(pathname || ''))) return null;
  let params;
  try { params = new URLSearchParams(String(search || '')); } catch { return null; }
  const username = String(params.get('u') || '').trim();
  const token = String(params.get('t') || '').trim();
  if (!username || !token) return null;
  return { username, token };
}

/** Read it off the live location. Returns null anywhere there is no location (tests, SSR). */
export function currentResetLink() {
  try {
    if (typeof location === 'undefined') return null;
    return resetLinkParams(location.pathname, location.search);
  } catch { return null; }
}

/**
 * Take the ?u=/&t= out of the address bar once the reset screen has read them, so a shared
 * screenshot or a browser-history entry does not carry a live password-reset token. Best
 * effort: a browser without history.replaceState simply keeps the URL it had.
 */
export function scrubResetLink() {
  try {
    if (typeof history === 'undefined' || typeof history.replaceState !== 'function') return false;
    history.replaceState(null, '', '/');
    return true;
  } catch { return false; }
}
