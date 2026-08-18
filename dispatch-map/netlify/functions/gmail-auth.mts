// gmail-auth.mts
//
// ── CONNECT A GMAIL MAILBOX TO THE MANIFEST CHECK ────────────────────────────
//
//   GET  /.netlify/functions/gmail-auth?action=status        → is it connected, and to what
//   GET  /.netlify/functions/gmail-auth?action=start[&key=]  → 302 to Google's consent screen
//   GET  /.netlify/functions/gmail-auth?code=…&state=…       → Google's callback (inferred)
//   POST /.netlify/functions/gmail-auth?action=query[&key=]  { query } → save the mailbox search
//   POST /.netlify/functions/gmail-auth?action=disconnect[&key=]      → revoke + forget
//
// Chad: "I want the gmail auth added to the manifest tabs so it can parse my
// emails looking for manifest to check against data we have in firestore."
//
// SCOPE IS READ-ONLY (gmail.readonly). Nothing in this codebase can send,
// label, archive or delete mail, and the grant cannot be widened without a new
// consent screen.
//
// ── the open-endpoint problem, and what actually guards this ────────────────
// This site has no login, so the start URL is reachable by anyone who finds it.
// Three things make that survivable, and none of them should be "simplified":
//   1. The CALLBACK refuses to store a mailbox that isn't ours — an explicit
//      GMAIL_ALLOWED_ACCOUNTS list, or trust-on-first-use pinning to the first
//      address that connects. Without this a stranger finishing the flow would
//      silently replace Chad's grant with their own mailbox.
//   2. The refresh token is SEALED (AES-256-GCM, server-only key) before it
//      touches Firestore, which an unauthenticated browser can read.
//   3. GMAIL_ADMIN_SECRET, when set, is required on start/disconnect/query —
//      the same optional-shared-secret pattern debug-capture uses.
// Nothing here returns a token, sealed or otherwise, to any caller.
//
// The redirect URI defaults to THIS function's own URL — register exactly that
// in Google Cloud Console (APIs & Services → Credentials → Web application →
// Authorized redirect URIs), or set GMAIL_OAUTH_REDIRECT_URI to override.

import crypto from 'node:crypto';
import { isFirestoreEnabled } from './lib/firestore.mts';
import {
  buildAuthUrl, exchangeCode, gmailProfile, accessTokenFor, accountAllowed,
  gmailOAuthConfig, gmailRedirectUri, revokeToken, GMAIL_SCOPE,
} from './lib/gmail.mts';
import { DEFAULT_GMAIL_QUERY } from './lib/gmail-source.mts';
import { normalizeQuery } from './lib/mail-sources.mts';
import {
  saveGrant, loadGrant, clearGrant, readStatus, patchStatus, issueState, consumeState,
} from './lib/gmail-store.mts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const J = (o: any, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: CORS });

/** Constant-time compare that never leaks length through an early return. */
function secretOk(provided: any, required: string): boolean {
  const a = crypto.createHash('sha256').update(String(provided ?? '')).digest();
  const b = crypto.createHash('sha256').update(required).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Back to the app, with a result the Manifest check tab can read and clear. */
function backToApp(reqUrl: string, params: Record<string, string>): Response {
  const u = new URL(reqUrl);
  const to = new URL('/', u.origin);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  return new Response('', { status: 302, headers: { Location: to.toString(), 'Cache-Control': 'no-store' } });
}

export default async (req: Request): Promise<Response> => {
  try { return await handle(req); } catch (e: any) {
    // Firestore write failures and the like. A thrown handler returns Netlify's
    // HTML error page, which the tab's fetch cannot parse — so it would read as
    // "Gmail is broken" with nothing to act on. Answer in JSON, always.
    return J({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
  }
};

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const oauthErr = url.searchParams.get('error');
  // Google's callback carries no action of ours, so infer it. That keeps the
  // registered redirect URI free of a query string — one less thing to keep in
  // sync with the Cloud Console.
  const action = (code || oauthErr) ? 'callback' : String(url.searchParams.get('action') || 'status');

  const cfg = gmailOAuthConfig();
  const adminSecret = String(process.env.GMAIL_ADMIN_SECRET || '').trim();
  const needsKey = adminSecret.length > 0;
  const keyOk = !needsKey || secretOk(url.searchParams.get('key'), adminSecret);

  // ── status ────────────────────────────────────────────────────────────────
  if (action === 'status') {
    if (!isFirestoreEnabled()) {
      return J({ ok: true, configured: cfg.configured, credentialProblem: cfg.problem, credentialWarning: cfg.warning, firestore: false, connected: false, error: 'Firestore is off — there is no board to check against' });
    }
    const status = await readStatus().catch(() => null);
    // Trust the SEALED doc, not the status flag: a rotated key or a hand-deleted
    // secret must read as disconnected rather than as connected-and-silently-dead.
    const grant = await loadGrant().catch(() => null);
    // A token pinned in Netlify env (v0.54.74's original path) WINS over anything
    // connected here — so say so, rather than showing a Connect button whose
    // result would be quietly ignored by every poll.
    const envPinned = !!String(process.env.GMAIL_REFRESH_TOKEN || '').trim();
    return J({
      ok: true,
      configured: cfg.configured,
      // WHY these ride on status: the card is the only place anybody looks
      // before clicking Connect, and a credential that cannot work is exactly
      // what it must not stay silent about.
      credentialProblem: cfg.problem,
      credentialWarning: cfg.warning,
      firestore: true,
      needsKey,
      envPinned,
      connected: !!grant,
      email: grant?.email || null,
      scope: grant?.scope || null,
      connectedAt: grant?.connectedAt || null,
      query: normalizeQuery(status?.query),
      defaultQuery: DEFAULT_GMAIL_QUERY,
      lastRunAt: status?.lastRunAt || null,
      lastRunSummary: status?.lastRunSummary || null,
      needsReconnect: !!status?.needsReconnect,
      allowListSet: !!String(process.env.GMAIL_ALLOWED_ACCOUNTS || '').trim(),
    });
  }

  // ── start ─────────────────────────────────────────────────────────────────
  if (action === 'start') {
    // cfg.problem always names the actual fault (missing, or an address pasted
    // into a credential box). Sending the reader to Google to be told "invalid
    // client" is a worse version of information we already hold.
    if (!cfg.configured) return J({ ok: false, error: cfg.problem || 'Gmail is not configured on this site — set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET' }, 503);
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore is off — the grant would have nowhere to live' }, 503);
    if (!keyOk) return J({ ok: false, error: 'unauthorized' }, 401);
    const state = await issueState(new Date().toISOString());
    // login_hint pre-selects the mailbox we already know about, so a reconnect
    // lands on the right Google account instead of whichever one is signed in.
    const known = (await loadGrant().catch(() => null))?.email || null;
    const to = buildAuthUrl({ clientId: cfg.clientId, redirectUri: gmailRedirectUri(req.url), state, loginHint: known });
    return new Response('', { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
  }

  // ── callback ──────────────────────────────────────────────────────────────
  if (action === 'callback') {
    if (oauthErr) return backToApp(req.url, { gmail: 'error', reason: String(oauthErr).slice(0, 120) });
    if (!cfg.configured || !isFirestoreEnabled()) return backToApp(req.url, { gmail: 'error', reason: cfg.problem || 'not configured' });
    if (!(await consumeState(String(url.searchParams.get('state') || ''), Date.now()))) {
      return backToApp(req.url, { gmail: 'error', reason: 'the sign-in link expired — start again from the Manifest check tab' });
    }
    try {
      const tok = await exchangeCode({
        code: String(code), clientId: cfg.clientId, clientSecret: cfg.clientSecret,
        redirectUri: gmailRedirectUri(req.url),
      });
      const refreshToken = String(tok?.refresh_token ?? '');
      const accessToken = String(tok?.access_token ?? '');
      if (!refreshToken) {
        // Without a refresh token the poll would work for an hour and then stop
        // forever. Refuse rather than store a grant that is going to rot.
        if (accessToken) await revokeToken(accessToken);
        return backToApp(req.url, { gmail: 'error', reason: 'Google returned no long-lived permission — remove this app at myaccount.google.com/permissions and connect again' });
      }

      const profile = await gmailProfile(
        accessToken || await accessTokenFor({ refreshToken, clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
      );
      const pinned = (await loadGrant().catch(() => null))?.email || null;
      const verdict = accountAllowed(profile.emailAddress, {
        allowList: process.env.GMAIL_ALLOWED_ACCOUNTS, pinned,
      });
      if (!verdict.ok) {
        // Hand the unwanted grant straight back to Google — we asked for it, so
        // we clean it up rather than leaving a live token nobody uses.
        await revokeToken(refreshToken);
        return backToApp(req.url, { gmail: 'error', reason: verdict.reason || 'that account is not allowed here' });
      }

      const existingQuery = normalizeQuery((await readStatus().catch(() => null))?.query);
      await saveGrant({
        refreshToken,
        email: profile.emailAddress,
        scope: String(tok?.scope ?? GMAIL_SCOPE),
        connectedAt: new Date().toISOString(),
      }, existingQuery);
      return backToApp(req.url, { gmail: 'connected', account: profile.emailAddress });
    } catch (e: any) {
      return backToApp(req.url, { gmail: 'error', reason: String(e?.message || e).slice(0, 160) });
    }
  }

  // ── the two writes ────────────────────────────────────────────────────────
  if (req.method !== 'POST') return J({ ok: false, error: `POST required for ${action}` }, 405);
  if (!keyOk) return J({ ok: false, error: 'unauthorized' }, 401);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore is off' }, 503);

  if (action === 'disconnect') {
    const grant = await loadGrant().catch(() => null);
    if (grant?.refreshToken) await revokeToken(grant.refreshToken);
    await clearGrant();
    return J({ ok: true, connected: false });
  }

  if (action === 'query') {
    let body: any = null;
    try { body = await req.json(); } catch { return J({ ok: false, error: 'body must be JSON' }, 400); }
    const q = normalizeQuery(body?.query);
    if (q.length > 500) return J({ ok: false, error: 'search is too long' }, 400);
    await patchStatus({ query: q });
    return J({ ok: true, query: q });
  }

  return J({ ok: false, error: `unknown action: ${action}` }, 400);
}
