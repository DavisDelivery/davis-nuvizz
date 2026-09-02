// auth-firebase-token.mts — POST (or GET) with a session token → a Firebase custom token.
//
// The client exchanges it with signInWithCustomToken(auth, customToken), which gives the
// BROWSER a Firebase identity. That is the only thing firestore.rules can see: rules read
// request.auth, request.auth is populated by Firebase Authentication and nothing else, and
// our HS256 session token is invisible to them. Without this endpoint the rules cutover
// cannot happen — every dispatcher would be anonymous to Firestore. See lib/auth-firebase.mts
// for the full reasoning, including the revocation gap this bridge does NOT close.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS SEPARATE FROM auth-login, AND NOT JUST ANOTHER FIELD IN ITS REPLY
//
// The two credentials have completely different lifetimes and completely different jobs:
//
//   session token   up to 14 days (AUTH_SESSION_DAYS, auth-core.mts:199). It is what the
//                   dispatcher's browser stores and what every gated function checks.
//   custom token    ONE HOUR — a Firebase hard cap, not a choice. It is not a session at
//                   all; it is a coupon whose only purpose is to be handed to
//                   signInWithCustomToken once, in exchange for a real Firebase session.
//
// Return it from auth-login and it is stale after an hour, while the session that came with
// it is good for a fortnight. The real cases that breaks: a laptop lidded overnight and
// reopened at 5am, a phone that dropped the tab, a browser that evicted the Firebase session
// but kept localStorage. Every one of them needs a FRESH custom token from a session that
// is still perfectly valid.
//
// Hence the second rule: THIS ENDPOINT MUST NOT ACCEPT A PASSWORD. The caller proves who it
// is with the session token it already holds, so re-minting after a cold boot is silent. If
// it took a password, that 5am reopen would put a login screen in front of a dispatcher who
// never signed out — and a login screen at 5am is the thing this whole rollout is trying not
// to do.
//
// STRICT, always. requireUser(req, { strict: true }) enforces regardless of AUTH_REQUIRED:
// the legacy "no token means everyone is admin" principal exists so eighty functions could
// be wired up without breaking the running app, but minting a Firebase identity for a
// caller who proved nothing would hand the whole database to an anonymous request the day
// the rules go on. This endpoint has no inert mode.

import { requireUser, jsonResponse, denied, clientIp, throttled } from './lib/require-user.mts';
import { mintCustomToken, firebaseTokensConfigured } from './lib/auth-firebase.mts';

export default async (req: Request): Promise<Response> => {
  // GET is allowed because this is a read of the caller's own identity with no body; POST is
  // the form the client uses, so a browser preflight-free fetch works either way.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'GET or POST only' }, 405);
  }

  const gate = await requireUser(req, { strict: true });
  if (!gate.ok) return gate.response;

  // Belt over braces. strict mode cannot return the legacy principal today (no token is a
  // 401, and the store-error path fails closed when enforcing), but "cannot happen" is how
  // an anonymous caller ends up with a database key. Say it out loud.
  if (!gate.user.authenticated || gate.user.legacy) {
    console.error('[auth-firebase-token] refusing to mint for an unauthenticated principal');
    return denied(401, 'sign in required');
  }

  // A legitimate client mints roughly once an hour per tab. Anything past this is a retry
  // loop in the browser, and an RSA sign per iteration is not free.
  if (throttled(`fbtoken:${gate.user.username}`, 20, 60_000)) {
    console.warn(`[auth-firebase-token] throttled user=${gate.user.username} ip=${clientIp(req)}`);
    return jsonResponse({ ok: false, error: 'too many token requests — wait a moment' }, 429);
  }

  if (!firebaseTokensConfigured()) {
    // 503, not 500: the deploy is missing FIREBASE_SA. Nothing the caller did is wrong, and
    // the client should treat Firestore as unavailable rather than the user as signed out.
    console.error('[auth-firebase-token] FIREBASE_SA is not set — cannot mint custom tokens');
    return denied(503, 'Firebase sign-in not configured (FIREBASE_SA)');
  }

  let minted;
  try {
    minted = mintCustomToken({
      username: gate.user.username,
      role: gate.user.role,
      // The LIVE tokenVersion the gate just read out of app_users, not the one in the
      // session token — they are equal here by construction, but the store is the truth.
      tokenVersion: gate.user.tokenVersion,
    });
  } catch (e: any) {
    console.error('[auth-firebase-token] mint failed:', e?.message || e);
    return denied(503, 'could not mint a Firebase token');
  }

  console.log(`[auth-firebase-token] minted user=${gate.user.username} role=${gate.user.role}`);
  return jsonResponse({
    ok: true,
    customToken: minted.token,
    expiresIn: minted.expiresIn,
    expiresAt: minted.expiresAt,
    uid: minted.uid,
    role: minted.role,
  });
};
