// driver-login.mts
//
// POST { driverNumber, pin } -> { token, displayName, mustChangePin }
//
// Five wrong PINs locks the credential for 15 minutes. An inactive credential is
// refused outright, which is how a terminated driver loses access on their next
// request without anyone touching a laptop.
//
// ZERO NuVizz calls.

import { getDoc, patchDoc, isFirestoreEnabled } from './lib/firestore.mts';
import {
  DRIVER_AUTH, hashPin, verifyPin, issueToken, isLockedOut, nextFailureState, LOCKOUT_MINUTES,
} from './lib/auth.mts';
import { ok, bad, json, readJson } from './lib/http.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);
  if (!isFirestoreEnabled()) return bad('FIREBASE_SA not set', 503);

  const body = await readJson(req);
  const driverNumber = String(body?.driverNumber ?? '').trim();
  const pin = String(body?.pin ?? '');

  if (!driverNumber || !pin) return bad('driverNumber and pin are required');

  const doc = await getDoc(`${DRIVER_AUTH}/${driverNumber}`);

  // Same response for "no such driver" and "wrong PIN" — a different message
  // would let anyone enumerate valid driver numbers.
  const genericReject = () => json({ ok: false, error: 'invalid_credentials' }, 401);

  if (!doc) return genericReject();
  if (doc.active === false) return json({ ok: false, error: 'inactive' }, 403);

  if (isLockedOut(doc)) {
    return json({ ok: false, error: 'locked', lockedUntil: doc.lockedUntil }, 423);
  }

  const good = await verifyPin(pin, String(doc.pinHash || ''));
  if (!good) {
    const next = nextFailureState(doc);
    await patchDoc(`${DRIVER_AUTH}/${driverNumber}`, next);
    return next.lockedUntil
      ? json({ ok: false, error: 'locked', lockedUntil: next.lockedUntil, lockoutMinutes: LOCKOUT_MINUTES }, 423)
      : genericReject();
  }

  const nowIso = new Date().toISOString();
  await patchDoc(`${DRIVER_AUTH}/${driverNumber}`, {
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: nowIso,
  });

  return ok({
    token: issueToken(driverNumber, String(doc.displayName || ''), doc.role === 'dispatcher' ? 'dispatcher' : 'driver'),
    driverNumber,
    displayName: String(doc.displayName || ''),
    mustChangePin: doc.mustChangePin === true,
    role: doc.role === 'dispatcher' ? 'dispatcher' : 'driver',
  });
};

// Re-exported for the seed path in driver-admin, so both places hash identically.
export { hashPin };
