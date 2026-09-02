// auth-logout.mts — POST with a bearer token → signs the user out EVERYWHERE.
//
// Sessions carry no per-device id, so "sign out" means bumping the user's tokenVersion:
// every token issued before this moment stops verifying on the next store read. That is
// the right shape for a shared dispatch office — a phone left in a truck is dealt with
// from any other device.

import { requireUser, jsonResponse } from './lib/require-user.mts';
import { getUser, bumpTokenVersion } from './lib/auth-store.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);
  const gate = await requireUser(req, { strict: true });
  if (!gate.ok) return gate.response;
  const doc = await getUser(gate.user.username);
  if (!doc) return jsonResponse({ ok: true, note: 'no account' });
  await bumpTokenVersion(doc);
  console.log(`[auth-logout] user=${doc.username} signed out everywhere`);
  return jsonResponse({ ok: true });
};
