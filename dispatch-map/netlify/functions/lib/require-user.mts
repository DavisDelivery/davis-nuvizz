// lib/require-user.mts — the ONE gate every function that writes or spends calls.
//
//   const gate = await requireUser(req, { role: 'dispatcher' });
//   if (!gate.ok) return gate.response;
//   ... gate.user.username is who did it ...
//
// SHIPS INERT. Until AUTH_REQUIRED=true is set on the site, a request with no token is
// let through as the "legacy" principal (role admin, exactly the power every caller has
// today), so wiring this into eighty functions changes nothing for the running app and
// nothing breaks on the morning it merges. A request that DOES carry a token is checked
// properly even in legacy mode, so the client can be rolled out first and the switch
// flipped once every dispatcher has signed in — the same order CLAUDE.md prescribes for
// the Firestore cutover (accounts first, then the lock).
//
// Endpoints that manage the user store itself pass { strict: true } and are enforced
// regardless of the switch: user admin is never a thing an anonymous caller may do.
//
// What is checked on every call with a token: signature and expiry (auth-core), then the
// live user document — active, and tokenVersion unchanged since the token was issued —
// so deactivating, demoting, resetting a password or "sign out everywhere" takes effect
// within the cache window below, not at token expiry.

import {
  type Role, normalizeRole, roleAtLeast, verifySessionToken, bearerFromHeaders, sessionsConfigured,
} from './auth-core.mts';
import { getUser as storeGetUser, type UserDoc } from './auth-store.mts';

export function authRequired(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.AUTH_REQUIRED || '').trim());
}

export interface Principal {
  username: string;
  displayName: string;
  role: Role;
  /**
   * The LIVE tokenVersion from the store (already checked to match the token's `tv`).
   * Carried out of the gate so a caller can stamp it into something it mints — the Firebase
   * custom token (auth-firebase-token.mts) puts it in a claim so a rules-level check, if one
   * is ever added, can tell a current session from one issued before a demotion.
   */
  tokenVersion: number;
  /** true when the caller proved who they are with a valid session token */
  authenticated: boolean;
  /** true when this is the pre-login "everyone" principal (AUTH_REQUIRED off, no token) */
  legacy: boolean;
}

export const LEGACY_PRINCIPAL: Principal = {
  username: 'legacy', displayName: 'Dispatch (no login)', role: 'admin', tokenVersion: 0, authenticated: false, legacy: true,
};

export interface GateOptions {
  /** minimum role; omit for "any signed-in user" */
  role?: Role;
  /** enforce even when AUTH_REQUIRED is off (user administration, /me) */
  strict?: boolean;
  /** test seam */
  deps?: { getUser?: (username: string) => Promise<UserDoc | null>; nowMs?: number };
}

export type GateResult = { ok: true; user: Principal } | { ok: false; response: Response; reason: string };

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;

export function jsonResponse(body: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...headers } });
}

export function denied(status: 401 | 403 | 423 | 503, error: string, extra: Record<string, any> = {}): Response {
  return jsonResponse({ ok: false, error, ...extra }, status, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
}

// A 30-second read-through cache of user docs, per warm instance. Long enough that a
// busy board is not one Firestore read per click; short enough that a deactivation
// lands before the dispatcher finishes their coffee.
const USER_CACHE_MS = 30_000;
const __cache = new Map<string, { doc: UserDoc | null; at: number }>();

export function _resetUserCacheForTests(): void { __cache.clear(); }

async function loadUser(username: string, deps?: GateOptions['deps']): Promise<UserDoc | null> {
  const now = deps?.nowMs ?? Date.now();
  if (deps?.getUser) return deps.getUser(username);
  const hit = __cache.get(username);
  if (hit && now - hit.at < USER_CACHE_MS) return hit.doc;
  const doc = await storeGetUser(username);
  __cache.set(username, { doc, at: now });
  return doc;
}

export async function requireUser(req: Request, opts: GateOptions = {}): Promise<GateResult> {
  const enforce = opts.strict || authRequired();
  const token = bearerFromHeaders(req.headers);

  if (!token) {
    if (!enforce) return { ok: true, user: LEGACY_PRINCIPAL };
    return { ok: false, reason: 'no-token', response: denied(401, sessionsConfigured() ? 'sign in required' : 'sign-in not configured (AUTH_SESSION_SECRET)') };
  }

  const claims = verifySessionToken(token, opts.deps?.nowMs);
  if (!claims) {
    // A bad token is refused even in legacy mode: a client that thinks it is signed in
    // must find out, not silently act as "everyone".
    return { ok: false, reason: 'bad-token', response: denied(401, 'session invalid or expired') };
  }

  let doc: UserDoc | null;
  try { doc = await loadUser(claims.sub, opts.deps); } catch (e: any) {
    // The store is unreachable. Fail CLOSED when enforcing; in legacy mode the caller
    // is no worse off than a caller with no token, so let the legacy principal through.
    if (enforce) return { ok: false, reason: 'store-error', response: denied(503, 'user store unavailable') };
    return { ok: true, user: LEGACY_PRINCIPAL };
  }
  if (!doc || doc.active === false) return { ok: false, reason: 'inactive', response: denied(401, 'account inactive') };
  if ((Number(doc.tokenVersion) || 0) !== claims.tv) return { ok: false, reason: 'revoked', response: denied(401, 'session revoked — sign in again') };

  const role = normalizeRole(doc.role);
  if (opts.role && !roleAtLeast(role, opts.role)) {
    return { ok: false, reason: 'role', response: denied(403, `requires ${opts.role}`) };
  }
  return {
    ok: true,
    user: {
      username: doc.username,
      displayName: doc.displayName || doc.username,
      role,
      tokenVersion: Number(doc.tokenVersion) || 0,
      authenticated: true,
      legacy: false,
    },
  };
}

/** Read a JSON body without ever throwing at the caller. */
export async function readJsonBody(req: Request, maxBytes = 64 * 1024): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  let text = '';
  try { text = await req.text(); } catch { return { ok: false, response: jsonResponse({ ok: false, error: 'unreadable body' }, 400) }; }
  if (text.length > maxBytes) return { ok: false, response: jsonResponse({ ok: false, error: 'body too large' }, 413) };
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const body = JSON.parse(text);
    return { ok: true, body: body && typeof body === 'object' && !Array.isArray(body) ? body : {} };
  } catch {
    return { ok: false, response: jsonResponse({ ok: false, error: 'invalid JSON' }, 400) };
  }
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// ── Per-instance request throttle ────────────────────────────────────────────
//
// A belt, not the braces: Netlify runs many instances, so this only slows a single
// hot connection. The per-account lockout in the store is the real limit.
const __hits = new Map<string, number[]>();

export function throttled(key: string, limit: number, windowMs: number, nowMs = Date.now()): boolean {
  const arr = (__hits.get(key) || []).filter((t) => nowMs - t < windowMs);
  if (arr.length >= limit) { __hits.set(key, arr); return true; }
  arr.push(nowMs);
  __hits.set(key, arr);
  if (__hits.size > 5000) __hits.clear(); // never let a flood grow the map without bound
  return false;
}

export function _resetThrottleForTests(): void { __hits.clear(); }
