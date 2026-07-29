// driver-change-pin.mts
//
// POST { currentPin, newPin } -> { ok }
//
// Requires a valid token. newPin must be 4-6 digits and must differ from the
// current one — a temp PIN that can be "changed" to itself defeats the whole
// mustChangePin flow.
//
// ZERO NuVizz calls.

import { getDoc, patchDoc, isFirestoreEnabled } from './lib/firestore.mts';
import { DRIVER_AUTH, authenticate, verifyPin, hashPin, isValidPinFormat } from './lib/auth.mts';
import { ok, bad, unauthorized, readJson } from './lib/http.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);
  // Authenticate BEFORE any configuration check: a caller with no token must not
  // be able to learn whether this site is configured.
  const claims = authenticate(req);
  if (!claims) return unauthorized();

  if (!isFirestoreEnabled()) return bad('not configured', 503);

  const body = await readJson(req);
  const currentPin = String(body?.currentPin ?? '');
  const newPin = String(body?.newPin ?? '');

  if (!isValidPinFormat(newPin)) return bad('newPin must be 4-6 digits');
  if (newPin === currentPin) return bad('newPin must differ from the current PIN');

  const path = `${DRIVER_AUTH}/${claims.sub}`;
  const doc = await getDoc(path);
  if (!doc) return unauthorized();
  if (doc.active === false) return bad('inactive', 403);

  if (!(await verifyPin(currentPin, String(doc.pinHash || '')))) {
    return bad('current PIN is incorrect', 401);
  }

  await patchDoc(path, {
    pinHash: await hashPin(newPin),
    mustChangePin: false,
    failedAttempts: 0,
    lockedUntil: null,
    pinChangedAt: new Date().toISOString(),
  });

  return ok({ changed: true });
};
