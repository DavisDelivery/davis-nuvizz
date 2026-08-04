// driver-login.mts
//
// POST { driverNumber, pin } -> { token, displayName, mustChangePin }
//
// driverNumber carries whatever the driver typed: the number, or the name as it
// shows on the board. A name resolves through the same exactly-one-claimant rule
// as stop resolution, against active credentials only — a terminated driver's
// name must not contest the board name a replacement now uses.
//
// Five wrong PINs locks the credential for 15 minutes. An inactive credential is
// refused outright, which is how a terminated driver loses access on their next
// request without anyone touching a laptop.
//
// ZERO NuVizz calls.

import { getDoc, patchDoc, listDocs, isFirestoreEnabled } from './lib/firestore.mts';
import {
  DRIVER_AUTH, hashPin, verifyPin, issueToken, isLockedOut, nextFailureState, LOCKOUT_MINUTES,
} from './lib/auth.mts';
import { resolveLoginIdentifier } from './lib/aliases.mts';
import { ok, bad, json, readJson } from './lib/http.mts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);
  // This is the one endpoint that cannot demand a token, so it must not name the
  // missing variable either — an anonymous caller learns only that sign-in is
  // unavailable. The real reason is in the function log.
  if (!isFirestoreEnabled()) {
    console.error('[driver-login] FIREBASE_SA is not set — sign-in cannot work');
    return bad('sign-in unavailable', 503);
  }

  const body = await readJson(req);
  const identifier = String(body?.driverNumber ?? '').trim();
  const pin = String(body?.pin ?? '');

  if (!identifier || !pin) return bad('driverNumber and pin are required');

  // Same response for "no such driver", "unknown name" and "wrong PIN" — a
  // different message would let anyone enumerate valid driver numbers or names.
  const genericReject = () => json({ ok: false, error: 'invalid_credentials' }, 401);

  let driverNumber = identifier;
  let doc: any = null;

  if (/^\d+$/.test(identifier)) {
    doc = await getDoc(`${DRIVER_AUTH}/${identifier}`);
  } else {
    // The name on the board. Exactly one ACTIVE credential must claim it, via
    // displayName or the hand-seeded alias set. Zero or several claimants is a
    // refusal, never a guess.
    const all = await listDocs(DRIVER_AUTH);
    const active = all.filter((d: any) => d?.active !== false);
    const r = resolveLoginIdentifier(identifier, active.map((d: any) => ({
      driverNumber: String(d?._id ?? d?.driverNumber ?? ''),
      displayName: String(d?.displayName || ''),
      nuvizzAliases: Array.isArray(d?.nuvizzAliases) ? d.nuvizzAliases : [],
    })));
    if (r.kind === 'name' && r.status === 'resolved') {
      driverNumber = r.driverNumber;
      doc = active.find((d: any) => String(d?._id ?? d?.driverNumber) === r.driverNumber) || null;
    } else if (r.kind === 'name' && r.status === 'unresolved' && r.reason === 'ambiguous') {
      // Worth a log line: two active credentials claiming one name is a seeding
      // mistake the dispatcher panel already surfaces, and it just cost a
      // sign-in. No detail in the response, though.
      console.warn(`[driver-login] name sign-in ambiguous across ${r.claimedBy.length} credentials`);
    }
  }

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
