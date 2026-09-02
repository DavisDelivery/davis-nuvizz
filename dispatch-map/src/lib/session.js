// session.js — WHERE THE SIGNED-IN SESSION LIVES IN THE BROWSER.
//
// One place. Before this, "who is signed in" was two disagreeing systems (a Firebase
// user object held in App state, and a load-scan dispatcher token in localStorage under
// a different key) and neither of them was the session the Netlify Functions verify.
// Everything that needs the token now reads it from here, so there is exactly one answer
// to "am I signed in", one place that clears it, and one place a test can point at.
//
// WHAT IS STORED: the opaque HMAC session token minted by auth-login.mts, its expiry, and
// the PUBLIC user record that came back with it (username, display name, role,
// mustChangePassword). Nothing secret beyond the token itself — no password, ever.
//
// localStorage and not sessionStorage: Chad's stated promise for the login was "sign in
// ONCE PER DEVICE and stay signed in, like Gmail". sessionStorage dies with the tab, so
// it would mean a password every morning, and a password every morning is a password on
// a sticky note.
//
// PURE CORE, THIN EDGE. normalizeSession/sessionExpired take their inputs and return
// answers; the storage wrappers take the store by argument and the module-level helpers
// simply pass the real localStorage in. Nothing here touches React, fetch or Firebase.

export const SESSION_KEY = 'dispatchMap.session.v1';

/**
 * PURE. Turn whatever is in storage (or came back from auth-login) into a session, or
 * null. Refuses anything without a token string, because a "session" with no token is a
 * signed-in-looking UI that cannot make a single authorised call — the exact half-state
 * that produces a board full of silent 401s.
 */
export function normalizeSession(raw) {
  const s = raw && typeof raw === 'object' ? raw : null;
  const token = typeof s?.token === 'string' ? s.token.trim() : '';
  if (!token) return null;
  const u = s.user && typeof s.user === 'object' ? s.user : {};
  return {
    token,
    // auth-login returns an ISO string; keep it as given and parse on demand, so a
    // clock-skew bug can never silently rewrite the stored value.
    expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : null,
    user: {
      username: String(u.username || ''),
      displayName: String(u.displayName || u.username || ''),
      email: u.email ? String(u.email) : null,
      role: String(u.role || 'viewer'),
      mustChangePassword: u.mustChangePassword === true,
    },
  };
}

/**
 * PURE. Is this session past its expiry?
 *
 * AN ABSENT OR UNPARSEABLE EXPIRY IS NOT EXPIRED. The server is the authority on token
 * lifetime — it re-verifies the HMAC and the tokenVersion on every call — and treating a
 * missing field as "expired" here would sign a dispatcher out mid-morning over a field
 * the server never promised to send. The only thing this check buys is not firing a
 * request we already know will 401.
 */
export function sessionExpired(session, nowMs = Date.now()) {
  const t = Date.parse(String(session?.expiresAt ?? ''));
  return Number.isFinite(t) && t <= nowMs;
}

// ── Storage, with the store passed in ────────────────────────────────────────

/** The real store, or null in Node/private-mode/quota-blocked browsers. */
function defaultStore() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch { return null; }   // Safari in "block all cookies" throws on ACCESS, not on use
}

export function readSessionFrom(store) {
  if (!store) return null;
  try {
    const raw = store.getItem(SESSION_KEY);
    if (!raw) return null;
    return normalizeSession(JSON.parse(raw));
  } catch { return null; }   // corrupt JSON is a signed-out browser, not a crash
}

export function writeSessionTo(store, session) {
  const s = normalizeSession(session);
  if (!store) return s;
  try {
    if (s) store.setItem(SESSION_KEY, JSON.stringify(s));
    else store.removeItem(SESSION_KEY);
  } catch { /* private mode / quota — the in-memory session below still works this tab */ }
  return s;
}

// ── The live session for this tab ────────────────────────────────────────────
//
// Held in memory as well as in storage so a private-mode browser (where setItem throws)
// still gets a working signed-in tab rather than a login loop.

let _session = readSessionFrom(defaultStore());
const _listeners = new Set();

function _emit() {
  for (const fn of _listeners) { try { fn(_session); } catch { /* one bad listener must not stop the rest */ } }
}

export function getSession() { return _session; }

/** The token to put on a request, or null. Never returns a token we already know is dead. */
export function sessionToken(nowMs = Date.now()) {
  if (!_session) return null;
  if (sessionExpired(_session, nowMs)) return null;
  return _session.token;
}

export function setSession(raw) {
  _session = writeSessionTo(defaultStore(), raw);
  _emit();
  return _session;
}

export function clearSession() {
  _session = null;
  writeSessionTo(defaultStore(), null);
  _emit();
  return null;
}

export function subscribeSession(fn) {
  _listeners.add(fn);
  try { fn(_session); } catch { /* ignore */ }
  return () => { _listeners.delete(fn); };
}

// A sign-out in one tab is a sign-out in all of them. The dispatch station runs this app
// in two or three tabs; "I signed out" meaning "one of my three tabs signed out" is not
// what anybody means by signing out.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e && e.key !== SESSION_KEY && e.key !== null) return;
    _session = readSessionFrom(defaultStore());
    _emit();
  });
}

// ── The auth-failure channel ─────────────────────────────────────────────────
//
// apiFetch cannot render anything, and App cannot reach inside apiFetch. A 401 and a 403
// are DIFFERENT PROBLEMS and must read differently to the person holding the phone:
//
//   'expired'   401 — the session is gone or was never valid. There is nothing to read on
//                     the screen any more; sign in again. This CLEARS the session.
//   'forbidden' 403 — signed in fine, but this account's role is too low for that button.
//                     Signing out and back in changes nothing; an admin has to change the
//                     role. Clearing the session here would send a viewer round a login
//                     loop for pressing a dispatcher's button, so it deliberately does not.

const _authEventListeners = new Set();

export function onAuthEvent(fn) {
  _authEventListeners.add(fn);
  return () => { _authEventListeners.delete(fn); };
}

export function emitAuthEvent(evt) {
  const e = { kind: String(evt?.kind || 'expired'), url: evt?.url ? String(evt.url) : '', message: evt?.message ? String(evt.message) : '' };
  if (e.kind === 'expired') clearSession();
  for (const fn of _authEventListeners) { try { fn(e); } catch { /* ignore */ } }
  return e;
}
