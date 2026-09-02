// auth-change-password.mts — POST { currentPassword, newPassword } with a bearer token.
//
// Requires the CURRENT password even though the caller holds a valid session: a phone
// picked up unlocked must not be able to change the password out from under its owner.
// A wrong current password counts toward the lockout exactly like a failed login, so
// this is not a password oracle for a token holder (the audit found load-scan's
// change-pin was). On success every other session is signed out and a fresh token is
// returned for this one.

import { requireUser, readJsonBody, jsonResponse, denied } from './lib/require-user.mts';
import { verifyPassword, passwordProblem, hashPassword, issueSessionToken, isLockedOut } from './lib/auth-core.mts';
import { getUser, patchUser, bumpTokenVersion, recordLoginFailure, publicUser } from './lib/auth-store.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);
  const gate = await requireUser(req, { strict: true });
  if (!gate.ok) return gate.response;

  const b = await readJsonBody(req);
  if (!b.ok) return b.response;
  const current = typeof b.body.currentPassword === 'string' ? b.body.currentPassword : '';
  const next = typeof b.body.newPassword === 'string' ? b.body.newPassword : '';
  if (!current || !next) return jsonResponse({ ok: false, error: 'currentPassword and newPassword required' }, 400);

  const doc = await getUser(gate.user.username);
  if (!doc || doc.active === false) return denied(401, 'account inactive');
  if (isLockedOut(doc)) return denied(423, 'account locked — try again later', { lockedUntil: doc.lockedUntil });

  if (!(await verifyPassword(current, doc.passwordHash))) {
    const st = await recordLoginFailure(doc).catch(() => null);
    if (st?.lockedUntil) return denied(423, 'account locked — try again later', { lockedUntil: st.lockedUntil });
    return denied(401, 'current password is wrong');
  }
  const problem = passwordProblem(next, doc.username);
  if (problem) return jsonResponse({ ok: false, error: problem }, 400);
  if (await verifyPassword(next, doc.passwordHash)) return jsonResponse({ ok: false, error: 'new password must differ from the current one' }, 400);

  const now = new Date().toISOString();
  await patchUser(doc.username, {
    passwordHash: await hashPassword(next),
    mustChangePassword: false,
    passwordChangedAt: now,
    resetTokenHash: null,
    resetExpiresAt: null,
    failedAttempts: 0,
    lockedUntil: null,
  });
  const tv = await bumpTokenVersion(doc);
  const { token, expiresAt } = issueSessionToken({ ...doc, tokenVersion: tv });
  console.log(`[auth-change-password] user=${doc.username} changed password; other sessions revoked`);
  return jsonResponse({ ok: true, token, expiresAt, user: publicUser({ ...doc, mustChangePassword: false }) });
};
