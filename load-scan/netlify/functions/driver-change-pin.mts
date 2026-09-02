// driver-change-pin.mts
//
// POST { currentPin, newPin } -> { ok }
//
// Requires a valid token. newPin must be 4-6 digits and must differ from the
// current one — a temp PIN that can be "changed" to itself defeats the whole
// mustChangePin flow.
//
// A wrong currentPin counts against the credential exactly as a wrong PIN at
// sign-in does. It did not: this endpoint verified the PIN and returned 401
// with no accounting, so anyone holding a driver's 90-day token (a phone left
// on the dock) could guess all 10,000 four-digit PINs here while driver-login
// locked after five.
//
// ZERO NuVizz calls.

import { getDoc, patchDoc, isFirestoreEnabled } from './lib/firestore.mts';
import {
  DRIVER_AUTH, authenticate, verifyPin, hashPin, isValidPinFormat, isLockedOut, nextFailureState, LOCKOUT_MINUTES,
} from './lib/auth.mts';
import { ok, bad, json, unauthorized, readJson } from './lib/http.mts';

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

  if (isLockedOut(doc)) {
    return json({ ok: false, error: 'locked', lockedUntil: doc.lockedUntil }, 423);
  }

  if (!(await verifyPin(currentPin, String(doc.pinHash || '')))) {
    const next = nextFailureState(doc);
    await patchDoc(path, next);
    return next.lockedUntil
      ? json({ ok: false, error: 'locked', lockedUntil: next.lockedUntil, lockoutMinutes: LOCKOUT_MINUTES }, 423)
      : bad('current PIN is incorrect', 401);
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
