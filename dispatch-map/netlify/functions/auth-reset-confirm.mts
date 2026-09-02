// auth-reset-confirm.mts — POST { username, token, newPassword } → { token, user }
//
// Finishes a reset started by auth-reset-request (or an admin invite). The link token
// must hash to what is stored, must not have expired, and is cleared on use so it can
// never be replayed. Every existing session for the account is signed out, the lockout
// is cleared (a locked-out dispatcher who resets by email should be able to work), and
// a fresh session is returned so the client lands signed in.

import { readJsonBody, jsonResponse, clientIp, throttled } from './lib/require-user.mts';
import {
  normalizeUsername, resetTokenMatches, resetExpired, passwordProblem, hashPassword, issueSessionToken, sessionsConfigured,
} from './lib/auth-core.mts';
import { getUser, patchUser, bumpTokenVersion, publicUser, storeReady } from './lib/auth-store.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);
  if (!storeReady()) return jsonResponse({ ok: false, error: 'user store not configured' }, 503);

  const ip = clientIp(req);
  if (throttled(`reset-confirm:${ip}`, 15, 10 * 60_000)) {
    return jsonResponse({ ok: false, error: 'too many attempts — wait a few minutes' }, 429);
  }

  const b = await readJsonBody(req);
  if (!b.ok) return b.response;
  const username = normalizeUsername(b.body.username ?? b.body.u);
  const token = typeof (b.body.token ?? b.body.t) === 'string' ? String(b.body.token ?? b.body.t) : '';
  const next = typeof b.body.newPassword === 'string' ? b.body.newPassword : '';
  if (!username || !token || !next) return jsonResponse({ ok: false, error: 'username, token and newPassword required' }, 400);

  const invalid = () => jsonResponse({ ok: false, error: 'reset link is invalid or has expired — request a new one' }, 400);

  const doc = await getUser(username);
  if (!doc || doc.active === false) return invalid();
  if (!doc.resetTokenHash || resetExpired(doc.resetExpiresAt)) return invalid();
  if (!resetTokenMatches(token, doc.resetTokenHash)) {
    console.warn(`[auth-reset-confirm] bad token for user=${username} ip=${ip}`);
    return invalid();
  }

  const problem = passwordProblem(next, doc.username);
  if (problem) return jsonResponse({ ok: false, error: problem }, 400);

  const now = new Date().toISOString();
  await patchUser(doc.username, {
    passwordHash: await hashPassword(next),
    resetTokenHash: null,
    resetExpiresAt: null,
    resetRequestedAt: null,
    mustChangePassword: false,
    failedAttempts: 0,
    lockedUntil: null,
    passwordChangedAt: now,
  });
  const tv = await bumpTokenVersion(doc);
  console.log(`[auth-reset-confirm] user=${doc.username} password reset (ip=${ip}); other sessions revoked`);

  if (!sessionsConfigured()) {
    return jsonResponse({ ok: true, user: publicUser({ ...doc, mustChangePassword: false }), note: 'password set; sign-in not configured yet (AUTH_SESSION_SECRET)' });
  }
  const { token: session, expiresAt } = issueSessionToken({ ...doc, tokenVersion: tv });
  return jsonResponse({ ok: true, token: session, expiresAt, user: publicUser({ ...doc, mustChangePassword: false }) });
};
