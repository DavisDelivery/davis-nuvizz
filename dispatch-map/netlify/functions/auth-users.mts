// auth-users.mts — user administration. ALWAYS requires an admin session, even before
// AUTH_REQUIRED is switched on: managing accounts is never something an anonymous
// caller may do (the legacy principal is refused by `strict`).
//
//   GET                                   → { users: [...] }        (never hashes or reset tokens)
//   POST { action: 'create', username, displayName, email?, role, password?, sendInvite? }
//        → creates the account. With `password`: stored, mustChangePassword=true. Without:
//          a temporary password is generated and RETURNED ONCE (read it to the person),
//          and if the account has an email and Resend is configured, `sendInvite` also
//          emails a set-password link.
//   POST { action: 'update', username, displayName?, email?, role?, active? }
//        → a role or active change bumps tokenVersion so it takes effect immediately.
//   POST { action: 'reset', username }    → emails a reset link when possible, otherwise
//                                           returns a temporary password once. Either
//                                           way every existing session is signed out.
//   POST { action: 'unlock', username }   → clears the lockout.
//   POST { action: 'logout-all', username } → signs the user out everywhere.
//
// The last active admin cannot be demoted or deactivated — the same guard load-scan has
// for its last dispatcher. An admin may not change their own role or active flag at all;
// a second admin does that.

import { requireUser, readJsonBody, jsonResponse } from './lib/require-user.mts';
import {
  ROLES, normalizeRole, normalizeUsername, normalizeEmail, passwordProblem, hashPassword,
  generateTempPassword, newResetToken, RESET_TTL_MINUTES,
} from './lib/auth-core.mts';
import {
  getUser, listUsers, createUser, patchUser, bumpTokenVersion, countActiveAdmins, publicUser, newUserDoc,
  storeReady, findUserByEmail,
} from './lib/auth-store.mts';
import { authMailEnabled, sendResetEmail } from './lib/auth-mail.mts';

const bad = (error: string, status = 400) => jsonResponse({ ok: false, error }, status);

export default async (req: Request): Promise<Response> => {
  if (!storeReady()) return bad('user store not configured (FIREBASE_SA)', 503);
  const gate = await requireUser(req, { strict: true, role: 'admin' });
  if (!gate.ok) return gate.response;
  const admin = gate.user.username;

  if (req.method === 'GET') {
    const rows = await listUsers();
    return jsonResponse({ ok: true, users: rows.map((r) => publicUser(r)), mailConfigured: authMailEnabled(), roles: ROLES });
  }
  if (req.method !== 'POST') return bad('GET or POST only', 405);

  const b = await readJsonBody(req);
  if (!b.ok) return b.response;
  const body = b.body;
  const action = String(body.action || '');
  const username = normalizeUsername(body.username);
  if (!username) return bad('username must be 2–40 chars: lower-case letters, digits, _ or -');

  // ── create ────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const displayName = String(body.displayName || '').trim().slice(0, 80) || username;
    const email = body.email == null || body.email === '' ? null : normalizeEmail(body.email);
    if (body.email && !email) return bad('email is not a valid address');
    if (!ROLES.includes(body.role)) return bad(`role must be one of ${ROLES.join(', ')}`);
    const role = normalizeRole(body.role);
    if (email && await findUserByEmail(email)) return bad('that email already belongs to another account', 409);

    let password = typeof body.password === 'string' && body.password ? body.password : null;
    let tempPassword: string | null = null;
    if (password) {
      const problem = passwordProblem(password, username);
      if (problem) return bad(problem);
    } else {
      tempPassword = generateTempPassword();
      password = tempPassword;
    }
    const doc = newUserDoc({
      username, displayName, email, role, passwordHash: await hashPassword(password), mustChangePassword: true, createdBy: admin,
    });
    const created = await createUser(doc);
    if (!created) return bad('username already exists', 409);

    let invited = false;
    if (body.sendInvite && email && authMailEnabled()) {
      const { token, hash } = newResetToken();
      await patchUser(username, {
        resetTokenHash: hash,
        resetExpiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString(),
        resetRequestedAt: new Date().toISOString(),
      });
      invited = await sendResetEmail(email, { displayName, username, token, invite: true });
    }
    console.log(`[auth-users] ${admin} created user=${username} role=${role} invited=${invited}`);
    return jsonResponse({ ok: true, user: publicUser(doc), tempPassword, invited });
  }

  // Everything below acts on an existing account.
  const doc = await getUser(username);
  if (!doc) return bad('no such user', 404);
  const isAdmin = normalizeRole(doc.role) === 'admin' && doc.active !== false;

  // ── update ────────────────────────────────────────────────────────────────
  if (action === 'update') {
    const fields: Record<string, any> = {};
    if (body.displayName != null) fields.displayName = String(body.displayName).trim().slice(0, 80) || doc.username;
    if (body.email !== undefined) {
      const email = body.email === null || body.email === '' ? null : normalizeEmail(body.email);
      if (body.email && !email) return bad('email is not a valid address');
      if (email && email !== doc.email) {
        const other = await findUserByEmail(email);
        if (other && other.username !== doc.username) return bad('that email already belongs to another account', 409);
      }
      fields.email = email;
    }
    let revoke = false;
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return bad(`role must be one of ${ROLES.join(', ')}`);
      if (username === admin) return bad('you cannot change your own role — another admin must', 409);
      if (normalizeRole(body.role) !== normalizeRole(doc.role)) { fields.role = normalizeRole(body.role); revoke = true; }
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return bad('active must be true or false');
      if (username === admin) return bad('you cannot deactivate yourself — another admin must', 409);
      if (body.active !== (doc.active !== false)) { fields.active = body.active; revoke = true; }
    }
    if ((fields.role !== undefined && fields.role !== 'admin' && isAdmin) || (fields.active === false && isAdmin)) {
      if (await countActiveAdmins() <= 1) return bad('that is the last active admin — promote someone else first', 409);
    }
    if (!Object.keys(fields).length) return bad('nothing to update');
    if (revoke) await bumpTokenVersion(doc, fields); else await patchUser(username, fields);
    console.log(`[auth-users] ${admin} updated user=${username} fields=${Object.keys(fields).join(',')} revoke=${revoke}`);
    const fresh = await getUser(username);
    return jsonResponse({ ok: true, user: publicUser(fresh || { ...doc, ...fields }) });
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  if (action === 'reset') {
    let tempPassword: string | null = null;
    let emailed = false;
    const fields: Record<string, any> = { mustChangePassword: true, failedAttempts: 0, lockedUntil: null };
    if (doc.email && authMailEnabled() && body.tempPassword !== true) {
      const { token, hash } = newResetToken();
      fields.resetTokenHash = hash;
      fields.resetExpiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString();
      fields.resetRequestedAt = new Date().toISOString();
      await bumpTokenVersion(doc, fields);
      emailed = await sendResetEmail(doc.email, { displayName: doc.displayName, username, token });
    } else {
      tempPassword = generateTempPassword();
      fields.passwordHash = await hashPassword(tempPassword);
      fields.passwordChangedAt = new Date().toISOString();
      fields.resetTokenHash = null;
      fields.resetExpiresAt = null;
      await bumpTokenVersion(doc, fields);
    }
    console.log(`[auth-users] ${admin} reset user=${username} emailed=${emailed} temp=${!!tempPassword}`);
    return jsonResponse({ ok: true, emailed, tempPassword });
  }

  // ── unlock ────────────────────────────────────────────────────────────────
  if (action === 'unlock') {
    await patchUser(username, { failedAttempts: 0, lockedUntil: null });
    console.log(`[auth-users] ${admin} unlocked user=${username}`);
    return jsonResponse({ ok: true });
  }

  // ── logout-all ────────────────────────────────────────────────────────────
  if (action === 'logout-all') {
    await bumpTokenVersion(doc);
    console.log(`[auth-users] ${admin} signed out user=${username} everywhere`);
    return jsonResponse({ ok: true });
  }

  return bad(`unknown action '${action}'`);
};
