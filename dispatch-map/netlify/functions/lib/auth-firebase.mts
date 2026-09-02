// lib/auth-firebase.mts — THE BRIDGE FROM OUR USER STORE TO FIRESTORE RULES.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
//
// Gating a Netlify function closes ONE door. The browser talks to Firestore DIRECTLY
// (src/lib/firebase.js), and firestore.rules is still `allow read, write: if true`, so
// today a person holding the web config out of the JS bundle writes nuvizz_ops/scan_config
// from a console tab and never touches nuvizz-scan-config.mts or its admin gate at all.
// The function gates and the rules cutover are ONE piece of work; this is the half that
// makes the other half possible.
//
// Firestore rules can only read `request.auth`, and only Firebase Authentication populates
// it. Our session token is an HS256 JWT signed with AUTH_SESSION_SECRET (auth-core.mts) —
// entirely invisible to a rule. So a signed-in dispatcher is, as far as Firestore is
// concerned, anonymous, and `isStaff()` in the drafted rules block would be false for every
// human on the site. Minting a Firebase CUSTOM TOKEN is the supported way across: the
// browser exchanges it via signInWithCustomToken(), Firebase issues its own ID token, and
// the `claims` below land in request.auth.token where a rule can finally see them.
//
// auth-core.mts already anticipated this in its header: "a session here can mint a Firebase
// custom token when that day comes." This is that day.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO firebase-admin DEPENDENCY
//
// firebase-admin exists mostly to do the thing below, and it drags in a large tree for it.
// The exact RS256 signing primitive is already in this repo and already proven in
// production — lib/firestore.mts:getAccessToken() builds a service-account JWT with
// crypto.createSign('RSA-SHA256') and sa.private_key, and every Firestore read the scanner
// does depends on it working. A custom token is the same construction with a different
// `aud` and a `uid`, so it reuses the same service account (FIREBASE_SA) and the same
// loadServiceAccount().
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REVOCATION GAP — READ THIS BEFORE TRUSTING THE ROLE CLAIM
//
// The two doors do NOT revoke at the same speed, and pretending otherwise is how a demoted
// dispatcher keeps writing.
//
//   • The FUNCTION door (require-user.mts) re-reads the user document on every call behind
//     a 30-second cache (USER_CACHE_MS) and compares the live tokenVersion with the token's
//     `tv`. Deactivate someone, demote them, reset their password, or "sign out everywhere",
//     and their next call fails within ~30 seconds. That is a real revocation.
//
//   • The FIRESTORE door has NO such check. Once the browser has exchanged this custom token
//     for a Firebase session, that session refreshes itself for as long as the tab lives and
//     the refresh token stands. The `role` and `tv` claims below are frozen at mint time.
//     A user demoted from dispatcher to viewer at 09:00 keeps writing customer_notes
//     straight through the afternoon, because nothing re-reads app_users on that path.
//
// Three mitigations. ONE is implemented here; the other two are described so the next person
// does not have to rediscover them:
//
//   (1) IMPLEMENTED — shouldSignOutOfFirebase() below. The client already talks to gated
//       functions constantly. The moment one of them answers 401 'session revoked' or
//       'account inactive', the app knows its identity is dead and calls signOut(auth),
//       dropping the Firebase session in the same ~30 seconds the function door took. It is
//       CLIENT-SIDE and therefore not a security boundary on its own — a hostile tab simply
//       does not call it — but it is what makes the honest case (a real dispatcher who was
//       demoted) behave correctly, and it costs nothing.
//
//   (2) NOT IMPLEMENTED — identitytoolkit accounts:update with `validSince` on every
//       tokenVersion bump. This is the EXACT one: it tells Firebase to reject any ID token
//       issued before that instant, so a demotion kills the Firestore session server-side,
//       for every tab, whether or not the client cooperates. Cost: it needs an OAuth scope
//       beyond the `https://www.googleapis.com/auth/datastore` that firestore.mts:99 asks
//       for (`.../auth/firebase` or `cloud-platform`), so getAccessToken() would need a
//       per-scope token cache rather than the single __token it holds now, plus a call on
//       the bump path in auth-store.mts. Both files are outside this change.
//
//   (3) NOT IMPLEMENTED — a rules-level `get(/databases/$(database)/documents/app_users/…)`
//       so every rule evaluation reads the live role. Exact and needs no extra scope, but it
//       bills a document read per rule evaluation, and this app holds long-lived onSnapshot
//       listeners over several collections on a 700-stop board. That is a standing cost on
//       every listener, all day, for a case that happens a few times a year.
//
// RECOMMENDED: (2), added when the rules cutover ships, with (1) kept as the fast path.
// (1) alone is honest but voluntary; (2) is the one that actually closes the door. Do NOT
// ship the cutover believing (1) is a revocation mechanism — it is a convenience.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ROLE-VOCABULARY HAZARD THE CUTOVER MUST SETTLE FIRST
//
// Three vocabularies are live in this repo and they do not agree:
//   server  auth-core.mts:35     'admin' | 'dispatcher' | 'viewer'
//   client  src/lib/auth-gate.js 'driver' | 'loader' | 'dispatcher' | 'admin'
//   rules   firestore.rules:111  isStaff() = role in ['dispatcher', 'admin']
//
// The claim below carries the SERVER role verbatim, because the server store is the
// authoritative one and inventing a mapping here would hide the disagreement rather than
// settle it. The consequence is concrete and must not be discovered in production: under
// the drafted rules block a 'viewer' matches neither isStaff() nor anything else, so every
// read is denied — and seven of the browser's ten Firestore read paths swallow
// permission-denied silently, so that viewer gets a BLANK BOARD WITH NO ERROR at 6am.
// Whoever flips firestore.rules must add 'viewer' to the read predicate (or decide viewers
// do not sign into Firebase at all) in the same change. This comment is the handoff.

import { createSign } from 'node:crypto';
import { loadServiceAccount } from './firestore.mts';
import { type Role, normalizeRole, normalizeUsername } from './auth-core.mts';

/** Google's fixed audience for custom tokens. Not a URL that gets fetched — an identifier. */
export const CUSTOM_TOKEN_AUD =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

/**
 * One hour, and it is not ours to choose: Firebase rejects a custom token whose exp is more
 * than 3600s past its iat. Mint a longer one and signInWithCustomToken fails with
 * auth/invalid-custom-token, which the client would show as "could not sign in".
 */
export const CUSTOM_TOKEN_TTL_SEC = 3600;

const b64url = (s: Buffer | string): string =>
  Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * PURE. What is wrong with this service account, or null when it can sign.
 *
 * Separate from the loading so the rule is testable without an env var: loadServiceAccount()
 * memoises the parsed JSON for the life of the instance, so once anything has loaded a
 * service account there is no way to feed a different one through the env var again.
 *
 * A truncated or wrong-shaped key must be caught HERE. Left to node:crypto it surfaces as
 * "error:1E08010C:DECODER routines::unsupported", which tells whoever is looking at a 5am
 * deploy failure nothing at all about which variable to fix.
 */
export function serviceAccountProblem(sa: any): string | null {
  if (!sa || typeof sa !== 'object') return 'FIREBASE_SA is not a service-account object';
  if (!String(sa.client_email || '').trim()) return 'FIREBASE_SA is missing client_email';
  if (!String(sa.private_key || '').includes('PRIVATE KEY')) return 'FIREBASE_SA is missing or malformed private_key';
  return null;
}

/**
 * The service account, or a clear throw. FAIL CLOSED: a missing FIREBASE_SA must never
 * produce a token, and it must never produce a vague one either.
 *
 * The env var is checked BEFORE loadServiceAccount() because that function memoises the
 * parsed JSON for the life of the instance — without this check, an instance that had once
 * seen a service account would keep minting after the variable was removed.
 */
function signingAccount(): { clientEmail: string; privateKey: string } {
  if (!String(process.env.FIREBASE_SA || '').trim()) {
    throw new Error('FIREBASE_SA not set — cannot mint a Firebase custom token');
  }
  let sa: any;
  try {
    sa = loadServiceAccount();
  } catch (e: any) {
    throw new Error(`FIREBASE_SA is not valid service-account JSON: ${e?.message || e}`);
  }
  const problem = serviceAccountProblem(sa);
  if (problem) throw new Error(`${problem} — cannot mint a Firebase custom token`);
  return { clientEmail: String(sa.client_email).trim(), privateKey: String(sa.private_key) };
}

/** Can this instance mint at all? Lets an endpoint answer 503 instead of throwing a 500. */
export function firebaseTokensConfigured(): boolean {
  try { signingAccount(); return true; } catch { return false; }
}

export interface MintableUser {
  username: string;
  role: any;
  tokenVersion?: number | null;
}

export interface MintedToken {
  token: string;
  uid: string;
  role: Role;
  expiresIn: number;
  expiresAt: string;
}

/**
 * Mint a Firebase custom token for one of OUR users.
 *
 * `uid` is the username. USERNAME_RE (auth-core.mts:53) already narrows it to
 * `[a-z0-9][a-z0-9_-]{1,39}` because the username is a Firestore document id, and that set
 * is a strict subset of what Firebase accepts as a uid (1–128 chars, no path characters), so
 * the uid needs no separate escaping. It is re-validated here anyway: this function must not
 * depend on every caller having normalised first.
 *
 * `claims` are Firebase "developer claims" and land verbatim in request.auth.token:
 *   role      what firestore.rules will branch on
 *   tv        the tokenVersion this identity was minted at — see the revocation gap above;
 *             a rules-level check has nothing to compare against without it
 *   username  so a rule (or a log) can name the human without a lookup
 * None of these collide with Firebase's reserved claim names, which would be rejected.
 */
export function mintCustomToken(user: MintableUser, nowMs: number = Date.now()): MintedToken {
  const uid = normalizeUsername(user?.username);
  if (!uid) throw new Error(`refusing to mint a Firebase token for an invalid username: ${JSON.stringify(user?.username)}`);
  const role = normalizeRole(user?.role);
  const tv = Math.max(0, Number(user?.tokenVersion) || 0);
  // A non-finite clock would serialise as `"iat": null, "exp": null` — a perfectly
  // well-signed token that Firebase refuses, so the failure would surface as "could not
  // sign in" in a dispatcher's browser and nowhere near the caller that passed the bad
  // number. Refuse it here, where the stack still names the culprit.
  if (!Number.isFinite(nowMs)) throw new Error(`refusing to mint a Firebase token at a non-finite time: ${nowMs}`);
  const { clientEmail, privateKey } = signingAccount();

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + CUSTOM_TOKEN_TTL_SEC;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    // iss and sub are both the service account: it is asserting, about itself, that it
    // vouches for `uid`. This is the shape Google's identity toolkit checks.
    iss: clientEmail,
    sub: clientEmail,
    aud: CUSTOM_TOKEN_AUD,
    iat,
    exp,
    uid,
    claims: { role, tv, username: uid },
  };

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const token = `${unsigned}.${b64url(signer.sign(privateKey))}`;

  return { token, uid, role, expiresIn: CUSTOM_TOKEN_TTL_SEC, expiresAt: new Date(exp * 1000).toISOString() };
}

// ── Mitigation (1): keeping the two doors in step, client-side ───────────────

/**
 * PURE. Given the status and error of a reply from one of OUR gated functions, has this
 * client's identity been revoked — meaning the Firebase session minted from it must be
 * dropped too, right now, with signOut(auth)?
 *
 * The client wires it as:
 *   if (shouldSignOutOfFirebase({ status: res.status, error: json?.error })) await signOut(auth);
 *
 * WHY IT MATCHES ON THE MESSAGE AND NOT SIMPLY ON 401. Not every 401 this app sees comes
 * from its own gate. loadscan-admin.mts answers 401 'unauthorized' when a LOAD-SCAN
 * dispatcher token is missing or stale (see bearerFromHeaders — the two systems share a
 * request), and load-scan's own endpoints answer 401 on a wrong driver PIN. Signing a
 * dispatcher out of Firestore because somebody mistyped a PIN in the Drivers panel would
 * blank the board for a reason nobody could connect to the cause.
 *
 * So it fires on exactly the three refusals that mean "the session token you HELD is dead":
 * 'session invalid or expired', 'account inactive', 'session revoked'. It deliberately does
 * NOT fire on 'sign in required' or 'sign-in not configured' — those mean the client never
 * had a token in the first place (AUTH_REQUIRED was just flipped on), so there is no stale
 * Firebase identity to clear and forcing a sign-out would only cost a redundant round trip.
 * 403 never fires either: a role refusal means the session is perfectly valid and the user
 * simply may not do that thing.
 */
export function shouldSignOutOfFirebase(res: { status?: any; error?: any } | null | undefined): boolean {
  if (Number(res?.status) !== 401) return false;
  const err = String(res?.error ?? '').toLowerCase();
  return /session invalid|session expired|session revoked|account inactive/.test(err);
}
