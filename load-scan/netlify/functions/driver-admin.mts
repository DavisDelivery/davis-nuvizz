// driver-admin.mts — dispatcher controls for the driver credential store.
//
// Dispatcher role required on the token, EXCEPT the one-time bootstrap below.
// Without this endpoint a terminated driver keeps access until someone reaches a
// laptop, so it ships in Phase 1 alongside the driver app.
//
// GET  ?action=list                     -> every credential (no hashes)
// GET  ?action=unmatched                -> the unresolved-alias review queue
// POST { action:'upsert', ... }         -> create/update displayName, aliases, active
// POST { action:'issue-pin', ... }      -> set a PIN, activate. STANDING by
//                                          default; forceChange:true for a
//                                          one-off reset the driver must replace
// POST { action:'clear-lockout', ... }  -> zero failedAttempts, drop lockedUntil
// POST { action:'set-active', ... }     -> deactivate / reactivate
// POST { action:'set-role', ... }       -> driver | loader | dispatcher. NEVER
//                                          moves the last active dispatcher off
//                                          the role — with the bootstrap secret
//                                          used and removed, zero dispatchers
//                                          is unrecoverable
// POST { action:'resolve-unmatched' }   -> clear a review-queue row
//
// BOOTSTRAP: with no dispatcher credential yet, nobody can call this. A request
// carrying x-bootstrap-secret matching LOADSCAN_ADMIN_BOOTSTRAP_SECRET may create
// the first dispatcher and nothing else. Unset the env var once that is done.
//
// ZERO NuVizz calls.

import { getDoc, setDoc, patchDoc, listDocs, isFirestoreEnabled } from './lib/firestore.mts';
import { DRIVER_AUTH, UNMATCHED_ALIASES, authenticate, hashPin, isValidPinFormat, isLastActiveDispatcher, hasActiveDispatcher, normalizeRole } from './lib/auth.mts';
import { normalizeDriverAlias, findAmbiguousAliases, planAliasAdd, planAliasRemove } from './lib/aliases.mts';
import { nextDriverNumber, pinFromPhone } from './lib/driver-ids.mts';
import { ok, bad, unauthorized, forbidden, readJson, viaProxy, secretMatches } from './lib/http.mts';

/** Strip anything that must never leave the server. */
const publicCred = (d: any) => ({
  driverNumber: String(d?._id ?? d?.driverNumber ?? ''),
  displayName: String(d?.displayName || ''),
  nuvizzAliases: Array.isArray(d?.nuvizzAliases) ? d.nuvizzAliases : [],
  active: d?.active !== false,
  mustChangePin: d?.mustChangePin === true,
  hasPin: !!d?.pinHash,
  failedAttempts: Number(d?.failedAttempts || 0),
  lockedUntil: d?.lockedUntil || null,
  role: normalizeRole(d?.role),
  createdAt: d?.createdAt || null,
  lastLoginAt: d?.lastLoginAt || null,
});

/**
 * Policy, exported so the test suite can pin it: an issued PIN stands unless
 * the dispatcher explicitly forces a change. Do not reintroduce a forced
 * change as the default.
 */
export const issuedPinMustChange = (body: any): boolean => body?.forceChange === true;

/**
 * The only shape an id may take before it is spliced into a Firestore path.
 *
 * driverNumber, the review-row id and resolveId all become path segments in
 * driver_auth/ and load_scan_unmatched_aliases/. Unchecked, a body carrying
 * `../customer_notes/X` reaches a document in a different collection — see
 * assertSafeSegment in lib/firestore.mts, which is the backstop. This is the
 * front door: a clean 400 with the reason, before any read happens.
 */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidId = (v: any): boolean => ID_RE.test(String(v ?? ''));
const ID_HELP = 'must be 1-64 letters, digits, _ or -';

function bootstrapAllowed(req: Request): boolean {
  const want = process.env.LOADSCAN_ADMIN_BOOTSTRAP_SECRET;
  if (!want || want.length < 16) return false;
  // Constant-time, like the proxy secret. `===` returns on the first wrong
  // character, and this header is the one thing that mints a dispatcher.
  return secretMatches(want, req.headers.get('x-bootstrap-secret') || '');
}

export default async (req: Request): Promise<Response> => {
  // Authorize BEFORE any configuration check: a caller with no token must not be
  // able to learn whether this site is configured.
  const claims = authenticate(req);
  const isDispatcher = claims?.role === 'dispatcher';
  const isBootstrap = bootstrapAllowed(req);

  if (!isDispatcher && !isBootstrap) return claims ? forbidden('dispatcher role required') : unauthorized();

  if (!isFirestoreEnabled()) return bad('not configured', 503);

  // Tokens live 90 days, so the role claim alone would let a demoted or
  // deactivated dispatcher keep administering until expiry. Re-check the live
  // credential: demotion takes effect on the next admin call, not next sign-in.
  if (isDispatcher) {
    const me = await getDoc(`${DRIVER_AUTH}/${claims!.sub}`);
    if (!me || me.active === false || me.role !== 'dispatcher') {
      return forbidden('dispatcher role required');
    }
  }

  // Provenance, for the audit trail: which surface issued this admin action.
  const surface = viaProxy(req) ? 'dispatch-map-proxy' : 'load-scan-direct';

  if (req.method === 'GET') {
    if (!isDispatcher) return forbidden('dispatcher role required');
    const url = new URL(req.url);
    const action = String(url.searchParams.get('action') || 'list');

    if (action === 'unmatched') {
      const rows = await listDocs(UNMATCHED_ALIASES);
      return ok({
        unmatched: rows
          .filter((r: any) => r?.resolved !== true)
          .sort((a: any, b: any) => String(b?.at || '').localeCompare(String(a?.at || ''))),
      });
    }

    const docs = await listDocs(DRIVER_AUTH);
    const drivers = docs.map(publicCred).sort((a, b) => a.driverNumber.localeCompare(b.driverNumber));
    return ok({ drivers, ambiguousAliases: findAmbiguousAliases(drivers) });
  }

  if (req.method !== 'POST') return bad('GET or POST only', 405);

  const body = await readJson(req);
  const action = String(body?.action || '');
  console.log(`[driver-admin] ${action} via ${surface} by ${claims?.sub ?? 'bootstrap'}`);
  let driverNumber = String(body?.driverNumber ?? '').trim();
  if (driverNumber && !isValidId(driverNumber)) return bad(`driverNumber ${ID_HELP}`);

  // ── Bootstrap is allowed exactly one action ────────────────────────────────
  if (isBootstrap && !isDispatcher) {
    if (action !== 'bootstrap-dispatcher') return forbidden('bootstrap may only create the first dispatcher');
    if (!driverNumber) return bad('driverNumber is required');
    const pin = String(body?.pin ?? '');
    if (!isValidPinFormat(pin)) return bad('pin must be 4-6 digits');
    // The FIRST dispatcher, literally. The header comment says to unset the env
    // var afterwards, but nothing enforced it, so a secret left in place was a
    // standing way to mint dispatchers past every role check above. Once an
    // active dispatcher exists this path is closed whether the var is set or not.
    if (hasActiveDispatcher(await listDocs(DRIVER_AUTH))) {
      console.warn(`[driver-admin] BOOTSTRAP refused: an active dispatcher already exists`);
      return bad('a dispatcher already exists — sign in as one; bootstrap only creates the first', 409);
    }
    if (await getDoc(`${DRIVER_AUTH}/${driverNumber}`)) return bad('that driverNumber already exists', 409);

    await setDoc(`${DRIVER_AUTH}/${driverNumber}`, {
      driverNumber,
      displayName: String(body?.displayName || 'Dispatcher'),
      nuvizzAliases: [],
      pinHash: await hashPin(pin),
      role: 'dispatcher',
      active: true,
      mustChangePin: true,
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    });
    console.log(`[driver-admin] BOOTSTRAP dispatcher created: ${driverNumber}`);
    return ok({ created: driverNumber, role: 'dispatcher' });
  }

  if (action === 'resolve-unmatched') {
    const id = String(body?.id ?? '').trim();
    if (!id) return bad('id is required');
    if (!isValidId(id)) return bad(`id ${ID_HELP}`);
    await patchDoc(`${UNMATCHED_ALIASES}/${id}`, { resolved: true, resolvedAt: new Date().toISOString() });
    return ok({ resolved: id });
  }

  // Davis drivers have NO number on their paperwork — they sign in with the name
  // on the board and a PIN. Demanding one here is what made "Add a driver"
  // impossible: the Save button gated on a field nobody could fill. The number
  // survives only as the document id, so generate it and never ask.
  if (!driverNumber && action === 'upsert') {
    const all = await listDocs(DRIVER_AUTH);
    driverNumber = nextDriverNumber(all.map((d: any) => d?._id ?? d?.driverNumber));
    console.log(`[driver-admin] generated driverNumber ${driverNumber}`);
  }

  if (!driverNumber) return bad('driverNumber is required');
  const path = `${DRIVER_AUTH}/${driverNumber}`;
  const existing = await getDoc(path);

  switch (action) {
    case 'upsert': {
      // Aliases are hand-maintained, so normalize and de-duplicate on the way in
      // rather than trusting whatever was typed.
      const aliases = [
        ...new Set(
          (Array.isArray(body?.nuvizzAliases) ? body.nuvizzAliases : [])
            .map(normalizeDriverAlias)
            .filter(Boolean),
        ),
      ];
      const fields: any = {
        driverNumber,
        displayName: String(body?.displayName ?? existing?.displayName ?? ''),
        nuvizzAliases: aliases,
        active: body?.active === undefined ? existing?.active !== false : body.active === true,
      };
      // A PIN may ride along on creation. Adding a driver is ONE job — name,
      // spellings, PIN — and splitting it left half-made credentials that could
      // not sign in, with nothing on screen saying why.
      const rawPin = String(body?.pin ?? '').trim();
      const pin = rawPin ? (isValidPinFormat(rawPin) ? rawPin : pinFromPhone(rawPin)) : '';
      if (rawPin && !pin) return bad('PIN must be 4-6 digits, or a phone number to take the last 4 from');

      if (!existing) {
        fields.pinHash = pin ? await hashPin(pin) : '';
        fields.role = normalizeRole(body?.role) || 'driver';
        // A PIN the dispatcher set from the driver's cell is a STANDING PIN —
        // there is nothing to hand out and nothing to reset at 5am.
        fields.mustChangePin = !pin;
        fields.failedAttempts = 0;
        fields.lockedUntil = null;
        fields.createdAt = new Date().toISOString();
        fields.lastLoginAt = null;
        if (pin) fields.pinIssuedAt = new Date().toISOString();
        await setDoc(path, fields);
      } else {
        if (pin) {
          fields.pinHash = await hashPin(pin);
          fields.pinIssuedAt = new Date().toISOString();
          fields.failedAttempts = 0;
          fields.lockedUntil = null;
        }
        await patchDoc(path, fields);
      }
      return ok({ driverNumber, aliases, created: !existing, pinSet: !!pin });
    }

    case 'add-alias': {
      // The real fix for an unmatched sign-in: attach the name that IS on the
      // board to this driver's credential. "Mark reviewed" only hides the row —
      // this is what stops it coming back tomorrow.
      if (!existing) return bad('create the driver first with action=upsert', 404);
      // Checked BEFORE the alias write: a refusal must leave nothing half-done.
      const resolveId = String(body?.resolveId ?? '').trim();
      if (resolveId && !isValidId(resolveId)) return bad(`resolveId ${ID_HELP}`);

      const all = (await listDocs(DRIVER_AUTH)).map(publicCred);
      const plan = planAliasAdd(publicCred({ ...existing, _id: driverNumber }), body?.alias, all);
      if ('error' in plan) return bad(plan.error, 409);

      await patchDoc(path, { nuvizzAliases: plan.aliases });

      // Clear the review row in the SAME request. Two round trips could leave a
      // driver fixed but still flagged, or flagged-clear but still broken.
      if (resolveId) {
        await patchDoc(`${UNMATCHED_ALIASES}/${resolveId}`, {
          resolved: true,
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'alias_assigned',
          assignedAlias: normalizeDriverAlias(body?.alias),
        });
      }
      console.log(`[driver-admin] ALIAS ${normalizeDriverAlias(body?.alias)} -> ${driverNumber} (added=${plan.added})`);
      return ok({ driverNumber, aliases: plan.aliases, added: plan.added, resolved: resolveId || null });
    }

    case 'remove-alias': {
      // Drop ONE alias. The upsert path rewrites the whole set from a
      // comma-separated string, so a careless edit there silently deletes the
      // other spellings and that driver stops matching their stops.
      if (!existing) return bad('unknown driver', 404);
      const plan = planAliasRemove(publicCred({ ...existing, _id: driverNumber }), body?.alias);
      await patchDoc(path, { nuvizzAliases: plan.aliases });
      console.log(`[driver-admin] ALIAS-REMOVE ${normalizeDriverAlias(body?.alias)} from ${driverNumber} (removed=${plan.removed})`);
      return ok({ driverNumber, aliases: plan.aliases, removed: plan.removed });
    }

    case 'issue-pin': {
      const pin = String(body?.pin ?? '');
      if (!isValidPinFormat(pin)) return bad('pin must be 4-6 digits');
      if (!existing) return bad('create the driver first with action=upsert', 404);
      // Issued PINs are STANDING PINs — last 4 of the driver's cell, permanent.
      // Deliberate: nothing to hand out, no 5am reset calls. The security cost
      // is written up in the README. forceChange:true is the one-off reset path
      // and the only way mustChangePin gets set here.
      const forceChange = issuedPinMustChange(body);
      await patchDoc(path, {
        pinHash: await hashPin(pin),
        mustChangePin: forceChange,
        active: true,
        failedAttempts: 0,
        lockedUntil: null,
        pinIssuedAt: new Date().toISOString(),
      });
      return ok({ driverNumber, pinSet: true, mustChangePin: forceChange });
    }

    case 'clear-lockout': {
      if (!existing) return bad('no such driver', 404);
      await patchDoc(path, { failedAttempts: 0, lockedUntil: null });
      return ok({ driverNumber, cleared: true });
    }

    case 'set-active': {
      if (!existing) return bad('no such driver', 404);
      const active = body?.active === true;
      if (!active && isLastActiveDispatcher(await listDocs(DRIVER_AUTH), driverNumber)) {
        return bad('cannot deactivate the last dispatcher — promote another one first', 409);
      }
      await patchDoc(path, { active });
      console.log(`[driver-admin] ${active ? 'reactivated' : 'DEACTIVATED'} ${driverNumber}`);
      return ok({ driverNumber, active });
    }

    case 'set-role': {
      if (!existing) return bad('no such driver', 404);
      const role = ['driver', 'loader', 'dispatcher'].includes(body?.role) ? body.role : null;
      if (!role) return bad('role must be driver, loader or dispatcher');
      // Any move OFF dispatcher is a demotion, loader included — the guard keys
      // on the target role, not on 'driver' specifically.
      if (role !== 'dispatcher' && isLastActiveDispatcher(await listDocs(DRIVER_AUTH), driverNumber)) {
        return bad('cannot demote the last dispatcher — promote another one first', 409);
      }
      await patchDoc(path, { role });
      // Role changes are the audit line that matters most in this file.
      console.log(`[driver-admin] role=${role} set on ${driverNumber} by ${claims?.sub} via ${surface}`);
      return ok({ driverNumber, role });
    }

    default:
      return bad(`unknown action: ${action}`);
  }
};
