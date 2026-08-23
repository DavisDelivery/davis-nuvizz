// auth-gate.js — WHAT THE APP SHOWS BEFORE IT SHOWS THE BOARD.
//
// PURE. No React, no Firebase, no window. The whole decision is one function over
// three inputs, so the rule can be tested without a browser and cannot drift into a
// component where nobody can reach it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SHIPS SWITCHED OFF.
//
// This app has never had a login. Turning one on is the single change in the whole
// security plan that can lock a dispatcher out of a 700-stop morning, so it lands
// inert: with VITE_AUTH_ENABLED unset, gateState() returns 'app' before it looks at
// anything else, and App() renders exactly what it rendered yesterday. The flag is
// flipped deliberately, in a quiet window, after every account exists.
//
// A LOGIN SCREEN IS NOT THE SECURITY. Worth stating where the code lives, because it
// is the easiest thing in this plan to misread: the Firestore rules are still
// `allow read, write: if true`, so anyone holding the web config out of the JS bundle
// talks to the database directly and never sees this screen. This gate is a
// PRECONDITION for the rules lockdown (rules can only check request.auth once the
// browser actually signs in) — it is not itself the lock. See firestore.rules.
// ─────────────────────────────────────────────────────────────────────────────

/** The four things the shell can be showing. */
export const GATE = {
  DISABLED: 'app',      // flag off — behave exactly as before the login existed
  LOADING: 'loading',   // Firebase has not yet told us whether anyone is signed in
  LOGIN: 'login',       // nobody signed in
  APP: 'app',           // signed in (or gate disabled) — mount the board
};

/**
 * PURE. What to render.
 *
 * `enabled`  — the VITE_AUTH_ENABLED flag.
 * `ready`    — has Firebase reported an initial auth state yet? Until it has, we must
 *              NOT show the login screen: onAuthStateChanged fires asynchronously on
 *              every load, so a signed-in dispatcher would see a login flash on every
 *              refresh, and worse, might start typing into it.
 * `user`     — the signed-in user, or null.
 *
 * Returns 'app' | 'loading' | 'login'.
 */
export function gateState({ enabled, ready, user } = {}) {
  if (!enabled) return GATE.DISABLED;      // flag off → the app, unchanged, always
  if (!ready) return GATE.LOADING;         // never flash a login at a signed-in user
  return user ? GATE.APP : GATE.LOGIN;
}

/**
 * PURE. The role this user carries, from a Firebase custom claim.
 *
 * DEFAULTS TO THE LEAST PRIVILEGE. An account with no claim yet — freshly created, or
 * created before roles existed — is a 'driver', never a dispatcher. load-scan's own
 * auth module made the same call in the same words ("anything unrecognized is a
 * driver, the least-privileged role"), and the two systems should not disagree about
 * what an unknown user can do.
 */
export const ROLES = ['driver', 'loader', 'dispatcher', 'admin'];
export const DEFAULT_ROLE = 'driver';

export function roleOf(user) {
  const raw = String(user?.claims?.role ?? user?.role ?? '').trim().toLowerCase();
  return ROLES.includes(raw) ? raw : DEFAULT_ROLE;
}

/** Staff = the roles that run the dispatch board. Mirrors the rule in firestore.rules. */
export function isStaff(user) {
  const r = roleOf(user);
  return r === 'dispatcher' || r === 'admin';
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
