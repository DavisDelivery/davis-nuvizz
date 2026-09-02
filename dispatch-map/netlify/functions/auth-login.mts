// auth-login.mts — POST { username, password } → { token, expiresAt, user }
//
// The only place a password is checked against the store. Rules that live here and
// nowhere else:
//   • one generic 401 for "no such user", "inactive" and "wrong password" — a miss
//     runs a dummy scrypt so timing does not enumerate accounts either;
//   • 423 with the lock time when the account is locked (that one IS the user's own
//     business, and knowing when to come back beats guessing);
//   • the failed-attempt counter is atomic when the shared client offers it, so a
//     burst of parallel guesses costs one increment each;
//   • a per-instance IP throttle as a belt over the per-account lockout.
// No CORS header: the app is same-origin, and a browser on another site has no
// business posting passwords here.

import { readJsonBody, jsonResponse, denied, clientIp, throttled } from './lib/require-user.mts';
import {
  normalizeUsername, verifyPassword, dummyVerify, isLockedOut, issueSessionToken, sessionsConfigured,
  hashNeedsUpgrade, hashPassword,
} from './lib/auth-core.mts';
import { getUser, recordLoginFailure, recordLoginSuccess, publicUser, storeReady } from './lib/auth-store.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);
  if (!sessionsConfigured()) return denied(503, 'sign-in not configured (AUTH_SESSION_SECRET)');
  if (!storeReady()) return denied(503, 'user store not configured (FIREBASE_SA)');

  const ip = clientIp(req);
  if (throttled(`login:${ip}`, 30, 10 * 60_000)) {
    return jsonResponse({ ok: false, error: 'too many attempts — wait a few minutes' }, 429);
  }

  const b = await readJsonBody(req);
  if (!b.ok) return b.response;
  const username = normalizeUsername(b.body.username);
  const password = typeof b.body.password === 'string' ? b.body.password : '';
  if (!username || !password) return jsonResponse({ ok: false, error: 'username and password required' }, 400);

  const generic = () => denied(401, 'wrong username or password');

  let doc;
  try { doc = await getUser(username); } catch (e: any) {
    console.error('[auth-login] store read failed:', e?.message || e);
    return denied(503, 'user store unavailable');
  }
  if (!doc) { await dummyVerify(password); return generic(); }
  if (isLockedOut(doc)) return denied(423, 'account locked — try again later', { lockedUntil: doc.lockedUntil });
  if (doc.active === false) { await dummyVerify(password); return generic(); }

  const ok = await verifyPassword(password, doc.passwordHash);
  if (!ok) {
    try {
      const st = await recordLoginFailure(doc);
      console.warn(`[auth-login] wrong password user=${username} ip=${ip} attempts=${st.failedAttempts}`);
      if (st.lockedUntil) return denied(423, 'account locked — try again later', { lockedUntil: st.lockedUntil });
    } catch (e: any) {
      console.error('[auth-login] could not record failure:', e?.message || e);
    }
    return generic();
  }

  // Transparent cost upgrade: a hash made at a lower scrypt cost is rewritten now, while
  // the plaintext is legitimately in hand.
  const extra: Record<string, any> = {};
  if (hashNeedsUpgrade(doc.passwordHash)) extra.passwordHash = await hashPassword(password);
  try { await recordLoginSuccess(doc, Date.now(), extra); } catch (e: any) {
    console.error('[auth-login] could not record success:', e?.message || e);
  }

  const { token, expiresAt } = issueSessionToken(doc);
  console.log(`[auth-login] ok user=${username} role=${doc.role} ip=${ip}`);
  return jsonResponse({ ok: true, token, expiresAt, user: publicUser(doc) });
};
