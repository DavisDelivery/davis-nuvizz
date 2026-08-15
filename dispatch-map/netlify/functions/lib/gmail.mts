// lib/gmail.mts
//
// ── THE OAUTH HANDSHAKE, SO NOBODY HAS TO MINT A TOKEN BY HAND ───────────────
//
// Chad: "I want the gmail auth added to the manifest tabs so it can parse my
// emails looking for manifest to check against data we have in firestore to make
// sure nothing is missing."
//
// v0.54.74 taught the nightly check to READ Gmail (lib/gmail-source.mts), but it
// takes GMAIL_REFRESH_TOKEN as an environment variable — which means minting one
// by hand in the OAuth playground and pasting it into Netlify. That is a
// one-time chore right up until the token lapses, and the failure mode is the
// one this whole feature exists to prevent: the check stops, quietly, and
// nothing says so. (An External consent screen still in "Testing" expires
// refresh tokens after SEVEN DAYS — see .env.example.)
//
// This module is the missing half: the consent round-trip itself, so connecting
// (and reconnecting) is a button on the Manifest check tab. It deliberately does
// NOT duplicate anything in gmail-source.mts — no listing, no MIME walking, no
// attachment download. That pipeline is already built and tested; this only
// obtains and revokes the credential it runs on.
//
// SCOPE IS READ-ONLY (gmail.readonly). Nothing in this codebase can send, label,
// archive or delete mail, and Google says so on the consent screen.

import { createHash } from 'node:crypto';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

// ── pure helpers ─────────────────────────────────────────────────────────────

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; loginHint?: string | null }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GMAIL_SCOPE);
  // offline + consent is what actually yields a REFRESH token. Without
  // prompt=consent a second authorization of an already-granted client returns
  // an access token only, and the scheduled poll would work for an hour and then
  // stop — the exact silent rot this feature exists to prevent.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', opts.state);
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
  return u.toString();
}

/**
 * WHICH Google account is allowed to be stored here.
 *
 * This site has no login, so /gmail-auth?action=start is a URL anyone who finds
 * it can open. That is survivable only because the callback REFUSES to store a
 * mailbox that isn't ours: without this check a stranger completing the flow
 * would replace Chad's grant with their own, and the nightly check would start
 * reading a mailbox we know nothing about.
 *
 * Two gates, in order:
 *   • GMAIL_ALLOWED_ACCOUNTS — an explicit comma/space separated allow-list.
 *   • trust-on-first-use — with no list configured, the FIRST account to connect
 *     is pinned, and only that address may reconnect until someone disconnects.
 */
export function accountAllowed(
  email: any,
  opts: { allowList?: string | null; pinned?: string | null } = {},
): { ok: boolean; reason?: string } {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return { ok: false, reason: 'Google did not return an account address' };
  const list = String(opts.allowList ?? '')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) {
    return list.includes(e)
      ? { ok: true }
      : { ok: false, reason: `${e} is not in GMAIL_ALLOWED_ACCOUNTS` };
  }
  const pinned = String(opts.pinned ?? '').trim().toLowerCase();
  if (pinned && pinned !== e) {
    return { ok: false, reason: `this app is already connected to ${pinned} — disconnect that account first` };
  }
  return { ok: true };
}

/** The OAuth client. Same env names gmail-source.mts already documents in
 *  .env.example — one credential, not two spellings of it. */
export function gmailOAuthConfig(): { clientId: string; clientSecret: string; configured: boolean } {
  const clientId = String(process.env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GMAIL_CLIENT_SECRET || '').trim();
  return { clientId, clientSecret, configured: !!(clientId && clientSecret) };
}

/** The redirect URI registered in Google Cloud Console. Defaults to this very
 *  function's own URL — no query string, no rewrite rule, nothing to keep in
 *  sync — and is overridable when the site sits behind a custom domain. */
export function gmailRedirectUri(reqUrl: string): string {
  const explicit = String(process.env.GMAIL_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const u = new URL(reqUrl);
  return `${u.origin}/.netlify/functions/gmail-auth`;
}

// ── network ──────────────────────────────────────────────────────────────────

async function form(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<any> {
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await resp.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!resp.ok) {
    const detail = json?.error_description || json?.error || text.slice(0, 200);
    throw new Error(`${url.replace(/^https:\/\//, '')} ${resp.status}: ${detail}`);
  }
  return json;
}

export async function exchangeCode(opts: {
  code: string; clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: typeof fetch;
}): Promise<{ refresh_token?: string; access_token?: string; scope?: string; expires_in?: number }> {
  return form(opts.fetchImpl || fetch, GOOGLE_TOKEN_URL, {
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  });
}

// Access tokens last an hour; warm invocations reuse one rather than spending a
// token round-trip. Keyed by a HASH of the refresh token — never a slice of it,
// which two grants could collide on — so a reconnect can never serve the
// previous account's token from cache. (gmail-source.mts memoises per cycle for
// the poll; this cache is only for the auth endpoint's own profile reads.)
const __accessCache = new Map<string, { token: string; expiresAtMs: number }>();

export async function accessTokenFor(opts: {
  refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch; now?: () => number;
}): Promise<string> {
  const nowMs = (opts.now || Date.now)();
  const key = createHash('sha256').update(opts.refreshToken).digest('hex');
  const hit = __accessCache.get(key);
  if (hit && nowMs < hit.expiresAtMs - 60_000) return hit.token;
  const tok = await form(opts.fetchImpl || fetch, GOOGLE_TOKEN_URL, {
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'refresh_token',
  });
  const token = String(tok?.access_token ?? '');
  if (!token) throw new Error('Google returned no access_token');
  __accessCache.set(key, { token, expiresAtMs: nowMs + (Number(tok?.expires_in) || 3600) * 1000 });
  return token;
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const resp = await fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
    return resp.ok;
  } catch { return false; }
}

/** The connected mailbox's own address — what the tab shows, and what the
 *  allow-list is checked against. */
export async function gmailProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ emailAddress: string }> {
  const resp = await fetchImpl(`${GMAIL_API}/users/me/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* keep raw */ }
    throw new Error(`gmail profile ${resp.status}: ${msg}`);
  }
  const j = text ? JSON.parse(text) : null;
  return { emailAddress: String(j?.emailAddress ?? '') };
}
