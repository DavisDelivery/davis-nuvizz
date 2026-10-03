// lib/google-id-token.mts
//
// AN ID TOKEN FOR A PRIVATE CLOUD RUN SERVICE, SIGNED WITH THE SERVICE ACCOUNT WE ALREADY HOLD.
//
// The truck routing service (OSRM on Cloud Run, lib/osrm-matrix.mts) is private: Cloud Run
// answers only a request carrying a Google-signed ID token whose audience is the service's own
// URL, from a caller holding the Cloud Run Invoker role on it. From outside Google that token is
// got the documented way: sign a JWT with the service-account key (FIREBASE_SA, the same one
// lib/firestore.mts signs with), claims iss and sub = client_email, aud = the key's token_uri,
// target_audience = the service URL, and POST it to token_uri as a jwt-bearer grant. The answer's
// id_token goes in Authorization: Bearer.
//
// THE TOKEN AND THE KEY NEVER LEAVE THIS MODULE'S CALLERS' HEADERS. Nothing here logs, returns in
// a body, or stores either; an error carries the HTTP status and Google's short error code only.
// client_email may be shown (serviceAccountEmail) — it is not a secret, and the status page needs
// it to say which account has to hold the Invoker role.
//
// CACHED PER AUDIENCE, in module memory: Google's ID tokens live an hour, and a build should not
// pay a token exchange every time. A cached token is refetched once it is within REFRESH_MARGIN_MS
// of the expiry its own `exp` claim states. A token whose expiry cannot be read is used once and
// never cached — a token used past its expiry answers 401, and that would look like a broken
// service. A failed exchange throws and caches nothing.
//
// getAccessToken (Firestore's OAuth access token) and its cache are a separate thing and are left
// exactly as they are.
import crypto from 'node:crypto';
import { loadServiceAccount } from './firestore.mts';

export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const ID_TOKEN_TIMEOUT_MS = 8000;
export const REFRESH_MARGIN_MS = 5 * 60_000;

const cache = new Map<string, { token: string; expiresAtMs: number }>();
const inflight = new Map<string, Promise<string>>();

/** Tests only: forget every cached token. */
export function __resetIdTokenCache(): void { cache.clear(); inflight.clear(); }

/** The service account's email, or null when FIREBASE_SA is unset or unreadable. Safe to show. */
export function serviceAccountEmail(): string | null {
  try { return String(loadServiceAccount()?.client_email || '') || null; } catch { return null; }
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** PURE: the expiry (ms since epoch) a JWT's `exp` claim states, or null if it cannot be read. */
export function jwtExpiryMs(token: string): number | null {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const exp = Number(JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch { return null; }
}

export class IdTokenError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) { super(message); this.name = 'IdTokenError'; this.status = status; }
}

async function exchange(audience: string, timeoutMs: number): Promise<string> {
  const sa = loadServiceAccount();
  if (!sa?.client_email || !sa?.private_key) throw new IdTokenError('FIREBASE_SA has no client_email or private_key');
  const tokenUri = String(sa.token_uri || DEFAULT_TOKEN_URI);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: sa.client_email, sub: sa.client_email, aud: tokenUri, target_audience: audience, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${b64url(signer.sign(sa.private_key))}`;

  // One deadline over the request AND the body (a body stalling after the headers is still a stall).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      // Google's error code only ("invalid_grant"), never the body as a whole.
      let code = '';
      try { code = String((await resp.json())?.error || '').slice(0, 40); } catch (e: any) { if (e?.name === 'AbortError') throw e; }
      throw new IdTokenError(`ID token exchange failed: HTTP ${resp.status}${code ? ` (${code})` : ''}`, resp.status);
    }
    let body: any = null;
    try { body = await resp.json(); } catch (e: any) { if (e?.name === 'AbortError') throw e; }
    const token = typeof body?.id_token === 'string' ? body.id_token : '';
    if (!token) throw new IdTokenError('ID token exchange answered without an id_token');
    return token;
  } finally { clearTimeout(timer); }
}

/**
 * A Google ID token for `audience`. Cached per audience until REFRESH_MARGIN_MS before its own
 * expiry; concurrent callers share one exchange. Throws on any failure and caches nothing.
 */
export async function idTokenFor(audience: string, opts: { timeoutMs?: number; nowMs?: () => number } = {}): Promise<string> {
  const now = opts.nowMs || Date.now;
  const hit = cache.get(audience);
  if (hit && now() < hit.expiresAtMs - REFRESH_MARGIN_MS) return hit.token;
  if (hit) cache.delete(audience);
  const pending = inflight.get(audience);
  if (pending) return pending;
  const p = (async () => {
    try {
      const token = await exchange(audience, opts.timeoutMs ?? ID_TOKEN_TIMEOUT_MS);
      const exp = jwtExpiryMs(token);
      if (exp != null) cache.set(audience, { token, expiresAtMs: exp });
      return token;
    } finally {
      inflight.delete(audience);
    }
  })();
  inflight.set(audience, p);
  return p;
}
