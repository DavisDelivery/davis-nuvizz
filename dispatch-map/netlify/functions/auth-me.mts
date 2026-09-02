// auth-me.mts — GET with a bearer token → { user, authRequired }
//
// Always strict: this endpoint exists to tell a client whether its token is still good,
// so it never answers with the legacy principal. `authRequired` tells the client whether
// the site is enforcing sign-in yet, so the login screen can be shown ahead of the flip.

import { requireUser, jsonResponse, authRequired } from './lib/require-user.mts';
import { sessionsConfigured } from './lib/auth-core.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return jsonResponse({ ok: false, error: 'GET only' }, 405);
  const gate = await requireUser(req, { strict: true });
  if (!gate.ok) {
    // Unauthenticated callers may still learn the two site-level facts a login screen
    // needs; nothing about any account is disclosed.
    const body = { ok: false, authRequired: authRequired(), configured: sessionsConfigured() };
    const orig = await gate.response.json().catch(() => ({}));
    return jsonResponse({ ...orig, ...body }, gate.response.status);
  }
  return jsonResponse({ ok: true, user: gate.user, authRequired: authRequired(), configured: true });
};
