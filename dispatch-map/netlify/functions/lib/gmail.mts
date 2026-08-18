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

/**
 * Is this pair actually a Google OAuth client, or did something else get pasted
 * into the box?
 *
 * WHY THIS EXISTS. GMAIL_CLIENT_ID spent a day set to an EMAIL ADDRESS. Every
 * surface reported success: status said `configured: true` (both strings were
 * non-empty, which was the whole test), the Connect button rendered, and
 * /gmail-auth?action=start happily 302'd to Google carrying
 * `client_id=CHAD%40DAVISDELIVERY.COM`. The only place the truth existed was
 * Google's own error page, AFTER the click. Finding it took hand-reading the
 * Location header of the redirect.
 *
 * So: check the shape, and say so BEFORE the click.
 *
 * The check is deliberately lopsided, because the two mistakes are not equally
 * knowable:
 *
 *   • REJECT what cannot possibly be a credential. An `@` means somebody pasted
 *     an address — an email, an account, a mailbox. No Google client id or
 *     secret has ever contained one. That is the failure we actually had, and
 *     it is worth blocking outright: the flow cannot complete, so sending the
 *     user to Google only buys a worse error message.
 *
 *   • WARN, don't block, on merely-unfamiliar. Today a client id ends in
 *     `.apps.googleusercontent.com` and a secret starts with `GOCSPX-`, but
 *     those are Google's conventions, not our contract. Hard-failing on them
 *     would mean that the day Google changes a prefix, this app refuses a
 *     credential that works. A warning costs nothing if we are wrong.
 *
 * Returns null when nothing is worth saying.
 */
export function credentialProblem(clientId: string, clientSecret: string): string | null {
  if (!clientId && !clientSecret) return 'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are not set';
  if (!clientId) return 'GMAIL_CLIENT_ID is not set';
  if (!clientSecret) return 'GMAIL_CLIENT_SECRET is not set';
  // The one that bit us. Name the variable AND what it looks like, so the fix
  // needs no second round trip to work out which box is wrong.
  if (clientId.includes('@')) {
    return `GMAIL_CLIENT_ID is an email address, not an OAuth client ID — it should end in .apps.googleusercontent.com (from Google Cloud Console → Credentials)`;
  }
  if (clientSecret.includes('@')) {
    return 'GMAIL_CLIENT_SECRET is an email address, not an OAuth client secret — it should start with GOCSPX-';
  }
  // Two names for one value is a copy-paste that fails the token exchange only,
  // long after the consent screen has already been accepted.
  if (clientId === clientSecret) return 'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are set to the same value';
  return null;
}

/** Shape we recognise, but never require — see credentialProblem. */
export function credentialWarning(clientId: string, clientSecret: string): string | null {
  if (clientId && !clientId.endsWith('.apps.googleusercontent.com')) {
    return 'GMAIL_CLIENT_ID does not end in .apps.googleusercontent.com — check it came from Google Cloud Console → Credentials';
  }
  if (clientSecret && !clientSecret.startsWith('GOCSPX-')) {
    return 'GMAIL_CLIENT_SECRET does not start with GOCSPX- — check it is the client secret and not the client ID';
  }
  return null;
}

/** The OAuth client. Same env names gmail-source.mts already documents in
 *  .env.example — one credential, not two spellings of it.
 *
 *  `configured` now means "we have a credential that could work", not merely
 *  "both strings are non-empty". A value we can prove is unusable reads as NOT
 *  configured, so the Connect button and the start redirect refuse it here
 *  rather than handing it to Google to reject. */
export function gmailOAuthConfig(): {
  clientId: string; clientSecret: string; configured: boolean;
  problem: string | null; warning: string | null;
} {
  const clientId = String(process.env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GMAIL_CLIENT_SECRET || '').trim();
  const problem = credentialProblem(clientId, clientSecret);
  return {
    clientId, clientSecret,
    configured: !problem,
    problem,
    warning: problem ? null : credentialWarning(clientId, clientSecret),
  };
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
