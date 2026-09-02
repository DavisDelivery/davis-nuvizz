// auth-gate.js — WHAT THE APP SHOWS BEFORE IT SHOWS THE BOARD.
//
// PURE. No React, no Firebase, no window, no fetch. The whole decision is one function
// over five inputs, so the rule can be tested without a browser and cannot drift into a
// component where nobody can reach it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SHIPS SWITCHED OFF.
//
// This app has never had a login. Turning one on is the single change in the whole
// security plan that can lock a dispatcher out of a 700-stop morning, so it lands
// inert: with the login flag unset, gateState() returns 'app' before it looks at
// anything else, and App() renders exactly what it rendered yesterday. The flag is
// flipped deliberately, in a quiet window, after every account exists.
//
// A LOGIN SCREEN IS NOT THE SECURITY. Worth stating where the code lives, because it
// is the easiest thing in this plan to misread: while the Firestore rules still say
// `allow read, write: if true`, anyone holding the web config out of the JS bundle
// talks to the database directly and never sees this screen. This gate is a
// PRECONDITION for the rules lockdown (rules can only check request.auth once the
// browser actually signs in) — it is not itself the lock. See firestore.rules.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the shell can be showing before (or instead of) the board. */
export const GATE = {
  DISABLED: 'app',            // flag off — behave exactly as before the login existed
  LOADING: 'loading',         // we have not yet resolved whether anyone is signed in
  LOGIN: 'login',             // nobody signed in
  MUST_CHANGE: 'must-change', // signed in, but the account carries mustChangePassword
  RESET: 'reset',             // arrived on an emailed /reset-password?u=..&t=.. link
  APP: 'app',                 // signed in (or gate disabled) — mount the board
};

/**
 * PURE. What to render.
 *
 * `resetLink` — an emailed reset link, checked FIRST and regardless of the flag. During
 *               rollout the accounts are created and the reset emails go out BEFORE the
 *               gate is switched on; if the flag decided this, every one of those links
 *               would open the board and silently do nothing. It requires both halves of
 *               the link (see resetLinkParams), so a stray query string cannot reach it.
 * `enabled`   — the login flag. Off ⇒ the app, unchanged, always.
 * `ready`     — has the session been resolved yet? Until it has we must NOT show a login:
 *               restoring a stored session is asynchronous (it re-checks the server), so a
 *               signed-in dispatcher would see a login flash on every refresh — and a
 *               flashed login is one somebody starts typing into.
 * `user`      — the signed-in user, or null.
 * `mustChangePassword` — an admin-created account on its first sign-in. The board is NOT
 *               shown first: a temporary password that a person is allowed to postpone
 *               changing is a permanent password.
 */
export function gateState({ enabled, ready, user, mustChangePassword, resetLink } = {}) {
  if (resetLink) return GATE.RESET;        // the emailed link works with the flag either way
  if (!enabled) return GATE.DISABLED;      // flag off → the app, unchanged, always
  if (!ready) return GATE.LOADING;         // never flash a login at a signed-in user
  if (!user) return GATE.LOGIN;
  if (mustChangePassword) return GATE.MUST_CHANGE;
  return GATE.APP;
}

/**
 * PURE. IS A LOGIN IN CHARGE, AND DID THE RETIRED FLAG TURN IT ON.
 *
 * THERE IS ONLY ONE LOGIN NOW. The v0.76.0 FIREBASE email/password gate (VITE_AUTH_ENABLED,
 * lib/auth.js) is RETIRED by v0.84: a Firebase ID token in the Authorization header parses
 * as our session-token shape and then fails the HMAC compare, so requireUser() answers 401
 * even with AUTH_REQUIRED unset. Signing into it can only ever produce a screen that says
 * you are in and a board that behaves as if you are not. The system that signs a person in
 * is the server username/password one (VITE_LOGIN_ENABLED, lib/auth-client.js) because it
 * is the one the Netlify Functions actually verify.
 *
 * EITHER FLAG TURNS THAT ONE LOGIN ON. Whoever sets the old flag WANTS a login; handing
 * them a broken one because they used the older name is the worst of the three options
 * available, and quietly rendering the board instead would be a security control somebody
 * believes they switched on and did not. The caller says which flag did it, out loud —
 * a switch whose position cannot be read is not a switch.
 *
 * Returns { mode, legacyFlagOnly, bothFlags } rather than a bare string so the caller can
 * report the situation without re-deriving it from the flags it just handed in.
 */
export function resolveGateMode({ serverLogin, firebaseLogin } = {}) {
  const server = !!serverLogin;
  const legacy = !!firebaseLogin;
  return {
    mode: server || legacy ? 'server' : 'off',
    legacyFlagOnly: legacy && !server,
    bothFlags: server && legacy,
  };
}

/**
 * PURE. The role this user carries.
 *
 * ONE VOCABULARY, NOT THREE. This list used to read ['driver','loader','dispatcher','admin'],
 * borrowed from load-scan, while the server's own list (netlify/functions/lib/auth-core.mts)
 * reads ['admin','dispatcher','viewer'] and firestore.rules' isStaff() reads
 * dispatcher|admin. That disagreement had a concrete cost: a real 'viewer' — the role the
 * server hands anything it does not recognise — mapped to no known role here, fell to
 * 'driver', and under the drafted rules could read NOTHING. Not an error message: a blank
 * board at 6am with nothing on screen to explain it. The list is now the server's list.
 *
 * DEFAULTS TO THE LEAST PRIVILEGE, in the server's own words: "anything unrecognised is a
 * viewer, never a guess upward". An account with no role yet is not a dispatcher.
 *
 * Reads `user.role` (the shape auth-login returns) and, still, `user.claims.role` (the
 * Firebase custom claim), so a session from either system resolves the same way.
 */
export const ROLES = ['viewer', 'dispatcher', 'admin'];
export const DEFAULT_ROLE = 'viewer';

export function roleOf(user) {
  const raw = String(user?.role ?? user?.claims?.role ?? '').trim().toLowerCase();
  return ROLES.includes(raw) ? raw : DEFAULT_ROLE;
}

/** Staff = the roles that run the dispatch board. Mirrors isStaff() in firestore.rules. */
export function isStaff(user) {
  const r = roleOf(user);
  return r === 'dispatcher' || r === 'admin';
}

/** Mirrors roleAtLeast() in lib/auth-core.mts, so the screen and the server rank alike. */
const RANK = { viewer: 0, dispatcher: 1, admin: 2 };
export function roleAtLeast(user, need) {
  return (RANK[roleOf(user)] ?? 0) >= (RANK[String(need || 'viewer').toLowerCase()] ?? 0);
}

/**
 * PURE. Turn a Firebase auth error code into something a dispatcher can act on.
 *
 * Firebase's raw messages are developer-facing ("Firebase: Error (auth/wrong-password)")
 * and a person at 6am reading that learns nothing. Anything unrecognised falls through
 * to a plain sentence rather than the raw code — but the code is still returned
 * separately so it can be logged, because a message a user can read and a message an
 * engineer can debug are two different jobs.
 */
export function friendlyAuthError(code) {
  const c = String(code || '').replace(/^auth\//, '');
  const map = {
    'invalid-email': 'That does not look like an email address.',
    'user-disabled': 'That account has been turned off. Ask an admin to re-enable it.',
    'user-not-found': 'No account with that email. Check the address, or ask an admin to create one.',
    'wrong-password': 'Wrong password.',
    'invalid-credential': 'Email or password is wrong.',
    'invalid-login-credentials': 'Email or password is wrong.',
    'too-many-requests': 'Too many tries. Wait a minute and try again.',
    'network-request-failed': 'No connection. Check signal and try again.',
    'popup-closed-by-user': 'Sign-in window closed before finishing.',
    'popup-blocked': 'The browser blocked the sign-in window. Allow pop-ups for this site.',
    'unauthorized-domain': 'This site is not authorised for sign-in yet. An admin needs to add it in Firebase.',
    'operation-not-allowed': 'That sign-in method is not switched on in Firebase yet.',
  };
  return map[c] || 'Could not sign in. Try again, and tell Chad if it keeps happening.';
}

/**
 * PURE. Is an email allowed to sign in at all?
 *
 * Google sign-in will happily authenticate ANY Google account on earth, so without
 * this a stranger with a gmail address becomes a signed-in user the moment the rules
 * start trusting request.auth. An empty allow-list means "no restriction", which is
 * correct for email/password (an admin created the account deliberately) and is why
 * the caller passes the list only for the Google path.
 *
 * Accepts full addresses and @domain suffixes, matching testRecipientAllowed's shape
 * in lib/customer-comms.mts so there is one convention in the repo, not two.
 */
export function emailAllowed(email, allowList) {
  const rules = String(allowList || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const lc = String(email || '').trim().toLowerCase();
  if (!lc) return false;
  return rules.some((r) => (r.startsWith('@') ? lc.endsWith(r) : lc === r));
}
