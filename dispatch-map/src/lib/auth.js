// auth.js — the Firebase Authentication wiring. The ENGINE, not the screen.
//
// Firebase Auth is invisible: it checks a password, issues a signed token saying who
// this is and what role they carry, and keeps that token fresh. The login SCREEN is a
// normal component (components/LoginScreen.jsx). This file is the layer between them.
//
// INERT UNLESS THE FLAG IS ON. Nothing here imports firebase/auth at module load — the
// import is dynamic and only happens once authEnabled() is true. That matters for more
// than bundle size: with the flag off, a project whose Auth product has never been
// enabled in the Firebase console cannot throw an initialization error into the app
// that 700 stops depend on.
//
// A session persists in the browser (Firebase's default local persistence), so a
// dispatcher signs in ONCE PER DEVICE and stays signed in for weeks, like Gmail — not
// a password every morning. That was the explicit promise; it is a one-line setting
// and it is the default, so this file simply does not override it.
import { app, firebaseConfigured } from './firebase.js';
import { emailAllowed, friendlyAuthError } from './auth-gate.js';

/** The switch. Unset/'' → the whole login layer stays asleep and App() renders as before. */
export function authEnabled() {
  const v = String(import.meta.env.VITE_AUTH_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Optional allow-list for Google sign-in, e.g. "@davisdelivery.com". */
export function allowedDomains() {
  return String(import.meta.env.VITE_AUTH_ALLOWED_EMAILS ?? '').trim();
}

let _authPromise = null;
/** Lazily load firebase/auth. Returns null when the flag is off or Firebase is unconfigured. */
async function getAuthLib() {
  if (!authEnabled() || !firebaseConfigured || !app) return null;
  if (!_authPromise) _authPromise = import('firebase/auth');
  return _authPromise;
}

let _auth = null;
async function getAuth() {
  const lib = await getAuthLib();
  if (!lib) return null;
  if (!_auth) _auth = lib.getAuth(app);
  return _auth;
}

/**
 * Watch who is signed in. Calls back with ({ ready, user }) — `ready` flips true on the
 * FIRST report from Firebase, which is what stops a signed-in dispatcher seeing a login
 * flash on every page load (see auth-gate.gateState).
 *
 * Returns an unsubscribe function. With the flag off it reports ready immediately with
 * no user and subscribes to nothing.
 */
export function observeAuth(cb) {
  let stopped = false;
  let unsub = () => {};
  (async () => {
    const lib = await getAuthLib();
    const auth = await getAuth();
    if (!lib || !auth) { if (!stopped) cb({ ready: true, user: null }); return; }
    unsub = lib.onAuthStateChanged(auth, async (u) => {
      if (stopped) return;
      if (!u) { cb({ ready: true, user: null }); return; }
      // The ROLE rides in a custom claim on the ID token, set server-side by an admin.
      // Read it off the token rather than a Firestore doc: a claim is signed and is the
      // same thing the Firestore rules will read, so the screen and the rules cannot
      // come to disagree about what someone is allowed to do.
      let claims = {};
      try { claims = (await u.getIdTokenResult()).claims || {}; } catch { /* stale token — treat as no claim */ }
      cb({ ready: true, user: { uid: u.uid, email: u.email, displayName: u.displayName, claims } });
    }, () => { if (!stopped) cb({ ready: true, user: null }); });
  })();
  return () => { stopped = true; try { unsub(); } catch { /* never throw on teardown */ } };
}

/** Email + password. Resolves { ok } or { ok:false, message, code }. Never throws. */
export async function signInWithPassword(email, password) {
  const lib = await getAuthLib();
  const auth = await getAuth();
  if (!lib || !auth) return { ok: false, message: 'Sign-in is not configured yet.', code: 'not-configured' };
  try {
    await lib.signInWithEmailAndPassword(auth, String(email || '').trim(), String(password || ''));
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e?.code, message: friendlyAuthError(e?.code) };
  }
}

/**
 * Google sign-in, allow-listed.
 *
 * THE ALLOW-LIST IS CHECKED AFTER THE POPUP AND THE USER IS SIGNED BACK OUT ON A MISS.
 * Google will authenticate any Google account on earth, so without this a stranger
 * becomes a signed-in user — and once the Firestore rules start trusting request.auth,
 * "signed in" is exactly what they need. Firebase's own authorized-domains list governs
 * which SITE may sign in, not which PERSON, so it does not cover this.
 */
export async function signInWithGoogle() {
  const lib = await getAuthLib();
  const auth = await getAuth();
  if (!lib || !auth) return { ok: false, message: 'Sign-in is not configured yet.', code: 'not-configured' };
  try {
    const provider = new lib.GoogleAuthProvider();
    const res = await lib.signInWithPopup(auth, provider);
    const email = res?.user?.email || '';
    if (!emailAllowed(email, allowedDomains())) {
      try { await lib.signOut(auth); } catch { /* best effort */ }
      return { ok: false, code: 'not-allowed', message: 'That account is not allowed to use this app.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e?.code, message: friendlyAuthError(e?.code) };
  }
}

export async function signOut() {
  const lib = await getAuthLib();
  const auth = await getAuth();
  if (!lib || !auth) return;
  try { await lib.signOut(auth); } catch { /* best effort */ }
}

/**
 * The current ID token, for putting on calls to the Netlify Functions so the server can
 * verify WHO is asking. Returns null when the flag is off — callers then send exactly
 * the request they send today, which is what keeps this phase inert.
 */
export async function idToken() {
  const auth = await getAuth();
  const u = auth?.currentUser;
  if (!u) return null;
  try { return await u.getIdToken(); } catch { return null; }
}
