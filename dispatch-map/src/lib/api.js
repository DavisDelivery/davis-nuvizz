// api.js — THE ONE PLACE A SESSION TOKEN GETS ONTO A REQUEST.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY ONE PLACE, AND WHY THIS SHAPE.
//
// There are ~70 raw fetch() calls in this client and 17 server endpoints that now check
// who is asking. Attaching the header at each call site means 70 chances to forget one,
// and a forgotten one does not fail loudly — it 401s the moment AUTH_REQUIRED is turned
// on, in one screen, on one morning. So every call goes through here instead and the
// header is a property of the URL, not of the caller's discipline.
//
// THE THREE RULES, EACH FOR A CONCRETE FAILURE:
//
// 1. ATTACH ONLY TO OUR OWN FUNCTIONS (/.netlify/functions/* and /api/*, same-origin).
//    A session token on a request to Google Maps, to a NuVizz POD image host, or to any
//    other origin is a credential handed to a third party in a header they log.
//
// 2. NEVER TOUCH loadscan-admin. components/DriversPanel.jsx already sends a LOAD-SCAN
//    dispatcher token in Authorization, and loadscan-admin.mts forwards that header
//    UNTOUCHED to another origin (the load-scan site). Overwriting it breaks the Drivers
//    panel outright, and — worse — ships a dispatch-map session token to a second site
//    that has no business holding one. Excluded by URL so no future refactor of
//    callProxy can walk into it.
//
// 3. MERGE, NEVER REPLACE. Callers already build their own headers: hdrs() on the
//    Customer-emails screen sends x-comms-token, several posts send Content-Type, and
//    withKey() puts a key in the QUERY STRING that must survive untouched. A wrapper
//    that assigned `headers: { Authorization }` would silently drop the comms token and
//    turn a working PUT into a 403 nobody could explain.
//
// PURE CORE, THIN EDGE: shouldAttachToken() and mergeAuthHeaders() are pure and tested;
// apiFetch() is the six lines of edge around them.
// ─────────────────────────────────────────────────────────────────────────────

import { sessionToken, emitAuthEvent } from './session.js';

/** Our own function paths. /api/* is the alias netlify.toml redirects to the same place. */
const FUNCTION_PREFIXES = ['/.netlify/functions/', '/api/'];

/**
 * Endpoints on our own origin that must NEVER receive our Authorization header.
 * See rule 2 above — this is not a style preference, it is a credential leak.
 */
export const AUTH_HEADER_EXCLUDED = ['loadscan-admin'];

/** The path part of a URL that points at THIS origin, or null for anything cross-origin. */
function samePath(url) {
  const s = String(url ?? '');
  if (!s) return null;
  if (s.startsWith('/')) return s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;    // a bare relative path like "version.json"
  let origin = '';
  try { origin = (typeof location !== 'undefined' && location?.origin) || ''; } catch { origin = ''; }
  if (origin && s.startsWith(`${origin}/`)) return s.slice(origin.length);
  return null;                                          // absolute and not us → never attach
}

/**
 * PURE. Does this URL get our session token?
 *
 * Note the excluded check runs on the PATH, so a query string carrying the word
 * "loadscan-admin" (the proxy passes ?target=…) cannot accidentally exclude something
 * else, and the real proxy call is excluded whatever query it carries.
 */
export function shouldAttachToken(url) {
  const path = samePath(url);
  if (!path) return false;
  const clean = path.split('?')[0].split('#')[0];
  if (!FUNCTION_PREFIXES.some((p) => clean.startsWith(p))) return false;
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  return !AUTH_HEADER_EXCLUDED.includes(name);
}

/**
 * PURE. The caller's headers with Authorization added — in whatever shape they gave them
 * (Headers instance, array of pairs, or plain object), because all three appear in this
 * codebase and a wrapper that only understood one would drop the others on the floor.
 *
 * AN AUTHORIZATION HEADER THE CALLER ALREADY SET WINS. They know something we do not
 * (see DriversPanel); silently replacing a credential is how you ship one to the wrong
 * place.
 */
export function mergeAuthHeaders(headers, token) {
  if (!token) return headers;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    if (headers.has('authorization')) return headers;
    const h = new Headers(headers);
    h.set('Authorization', `Bearer ${token}`);
    return h;
  }
  if (Array.isArray(headers)) {
    if (headers.some(([k]) => String(k).toLowerCase() === 'authorization')) return headers;
    return [...headers, ['Authorization', `Bearer ${token}`]];
  }
  const obj = headers && typeof headers === 'object' ? headers : {};
  if (Object.keys(obj).some((k) => k.toLowerCase() === 'authorization')) return obj;
  return { ...obj, Authorization: `Bearer ${token}` };
}

// ── WHOSE 401 IS IT? ─────────────────────────────────────────────────────────
//
// NOT EVERY 401 AND 403 THIS APP SEES COMES FROM ITS OWN GATE, and acting on the status
// code alone signs people out for things that have nothing to do with them. Counted in
// this codebase, on endpoints this client actually calls:
//
//   nuvizz-write          403 'live writes disabled — set NUVIZZ_WRITE_ENABLED=true'
//   customer-comms-config 403 'not authorised — … x-comms-token header'
//   customer-comms-test   403 same
//   history-tombstone     403 'not authorized'  (its own admin token)
//   gmail-auth            401 'unauthorized'    (a bad ?key=, not a session)
//   debug-capture         401 'Unauthorized'    (its own token)
//
// A dispatcher pressing Save with NUVIZZ_WRITE_ENABLED unset would have been told "your
// account is not allowed to do that", which is false and is the kind of plausible-looking
// story that costs an hour on the phone. So the REFUSAL IS READ, not just counted.
//
// The vocabulary is requireUser()'s own (netlify/functions/lib/require-user.mts):
//   401 'sign in required' | 'sign-in not configured (…)' | 'session invalid or expired'
//       | 'account inactive' | 'session revoked — sign in again'
//   403 `requires <role>`
// The server-side helper shouldSignOutOfFirebase() in lib/auth-firebase.mts draws the same
// line for the same reason; test/api-fetch.test.mjs pins these against the real strings in
// require-user.mts so a wording change on the server goes red here instead of going quiet.

/** PURE. Does this refusal come from OUR gate, and which kind is it? */
export function classifyRefusal(status, error) {
  const e = String(error ?? '').trim();
  if (status === 403) {
    // requireUser answers exactly `requires <role>`. Everything else with a 403 on it is a
    // FEATURE switch or a per-endpoint admin token, and neither is a statement about who
    // this person is.
    return /^requires\s+\w+$/i.test(e) ? 'forbidden' : null;
  }
  if (status === 401) {
    // Deliberately broad enough to survive a re-wording of the five messages above, and
    // deliberately narrow enough that a bare 'unauthorized' — which is what the endpoints
    // holding their OWN tokens say — never reaches it.
    return /\bsession\b|\bsign[ -]in\b|\baccount inactive\b/i.test(e) ? 'expired' : null;
  }
  return null;
}

/**
 * Drop-in for fetch(). Same arguments, same return value, same errors — so a call site
 * converts by changing the word `fetch` and nothing else, and every existing `if (!r.ok)`
 * and `await r.json()` around it keeps working.
 *
 * 401 AND 403 ARE DIFFERENT PROBLEMS AND ARE REPORTED DIFFERENTLY.
 *   401 — the session is invalid, expired or revoked. The session is cleared and the app
 *         shows the login screen. Nothing on the board can be trusted to be complete.
 *   403 — signed in, but this account's role is too low for that endpoint. Signing out and
 *         back in changes NOTHING; an admin has to change the role. A viewer who presses a
 *         dispatcher's button must not be thrown into a login loop for it.
 *
 * The caller's response body is never touched: the refusal is read off a CLONE, so the
 * stream the caller is about to parse is still whole.
 */
export async function apiFetch(url, init = {}) {
  const attach = shouldAttachToken(url);
  const token = attach ? sessionToken() : null;
  const opts = token ? { ...init, headers: mergeAuthHeaders(init?.headers, token) } : init;
  const resp = await fetch(url, opts);
  // Only OUR endpoints speak this vocabulary at all. A 401 from another origin (a POD image
  // host, a tile server) means nothing about our session and must not sign anyone out.
  if (attach && (resp.status === 401 || resp.status === 403)) {
    let error = '';
    try { error = String((await resp.clone().json())?.error ?? ''); } catch { /* HTML 502, empty body */ }
    const kind = classifyRefusal(resp.status, error);
    if (kind) emitAuthEvent({ kind, url: String(url), message: error });
  }
  return resp;
}

export default apiFetch;
