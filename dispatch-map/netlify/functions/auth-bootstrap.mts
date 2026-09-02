// auth-bootstrap.mts — create the FIRST admin, once.
//
//   curl -X POST https://<site>/.netlify/functions/auth-bootstrap \
//     -H 'Content-Type: application/json' \
//     -d '{"secret":"<AUTH_BOOTSTRAP_SECRET>","username":"owner","password":"...","displayName":"Owner","email":"..."}'
//
// Guarded three ways: the env var must be set (unset ⇒ the endpoint does not exist),
// the secret is compared in constant time, and it REFUSES once any active admin exists
// — so unlike load-scan's bootstrap it is not a standing back door while the variable
// lingers. Remove AUTH_BOOTSTRAP_SECRET from the site afterwards anyway.

import { readJsonBody, jsonResponse } from './lib/require-user.mts';
import { safeEqual, normalizeUsername, normalizeEmail, passwordProblem, hashPassword, sessionsConfigured } from './lib/auth-core.mts';
import { countActiveAdmins, createUser, newUserDoc, publicUser, storeReady } from './lib/auth-store.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);
  const want = String(process.env.AUTH_BOOTSTRAP_SECRET || '').trim();
  if (want.length < 16) return jsonResponse({ ok: false, error: 'bootstrap not enabled' }, 404);
  if (!storeReady()) return jsonResponse({ ok: false, error: 'user store not configured (FIREBASE_SA)' }, 503);

  const b = await readJsonBody(req);
  if (!b.ok) return b.response;
  if (!safeEqual(String(b.body.secret || ''), want)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

  if (await countActiveAdmins() > 0) {
    return jsonResponse({ ok: false, error: 'an active admin already exists — use auth-users with that account' }, 409);
  }

  const username = normalizeUsername(b.body.username);
  if (!username) return jsonResponse({ ok: false, error: 'username must be 2–40 chars: lower-case letters, digits, _ or -' }, 400);
  const password = typeof b.body.password === 'string' ? b.body.password : '';
  const problem = passwordProblem(password, username);
  if (problem) return jsonResponse({ ok: false, error: problem }, 400);
  const email = b.body.email ? normalizeEmail(b.body.email) : null;
  if (b.body.email && !email) return jsonResponse({ ok: false, error: 'email is not a valid address' }, 400);

  const doc = newUserDoc({
    username,
    displayName: String(b.body.displayName || '').trim().slice(0, 80) || username,
    email,
    role: 'admin',
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
    createdBy: 'bootstrap',
  });
  const created = await createUser(doc);
  if (!created) return jsonResponse({ ok: false, error: 'username already exists' }, 409);
  console.log(`[auth-bootstrap] created first admin user=${username}`);
  return jsonResponse({
    ok: true,
    user: publicUser(doc),
    next: [
      'Remove AUTH_BOOTSTRAP_SECRET from the site.',
      sessionsConfigured() ? 'Sign in at auth-login.' : 'Set AUTH_SESSION_SECRET (32+ random chars) so sign-in works.',
      'Create the other accounts with auth-users, then set AUTH_REQUIRED=true.',
    ],
  });
};
