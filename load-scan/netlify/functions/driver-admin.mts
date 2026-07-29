// driver-admin.mts — dispatcher controls for the driver credential store.
//
// Dispatcher role required on the token, EXCEPT the one-time bootstrap below.
// Without this endpoint a terminated driver keeps access until someone reaches a
// laptop, so it ships in Phase 1 alongside the driver app.
//
// GET  ?action=list                     -> every credential (no hashes)
// GET  ?action=unmatched                -> the unresolved-alias review queue
// POST { action:'upsert', ... }         -> create/update displayName, aliases, active
// POST { action:'issue-pin', ... }      -> set a temp PIN, force change, activate
// POST { action:'clear-lockout', ... }  -> zero failedAttempts, drop lockedUntil
// POST { action:'set-active', ... }     -> deactivate / reactivate
// POST { action:'resolve-unmatched' }   -> clear a review-queue row
//
// BOOTSTRAP: with no dispatcher credential yet, nobody can call this. A request
// carrying x-bootstrap-secret matching LOADSCAN_ADMIN_BOOTSTRAP_SECRET may create
// the first dispatcher and nothing else. Unset the env var once that is done.
//
// ZERO NuVizz calls.

import { getDoc, setDoc, patchDoc, listDocs, isFirestoreEnabled } from './lib/firestore.mts';
import { DRIVER_AUTH, UNMATCHED_ALIASES, authenticate, hashPin, isValidPinFormat } from './lib/auth.mts';
import { normalizeDriverAlias, findAmbiguousAliases } from './lib/aliases.mts';
import { ok, bad, unauthorized, forbidden, readJson } from './lib/http.mts';

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
  role: d?.role === 'dispatcher' ? 'dispatcher' : 'driver',
  createdAt: d?.createdAt || null,
  lastLoginAt: d?.lastLoginAt || null,
});

function bootstrapAllowed(req: Request): boolean {
  const want = process.env.LOADSCAN_ADMIN_BOOTSTRAP_SECRET;
  if (!want || want.length < 16) return false;
  const got = req.headers.get('x-bootstrap-secret') || '';
  return got.length === want.length && got === want;
}

export default async (req: Request): Promise<Response> => {
  // Authorize BEFORE any configuration check: a caller with no token must not be
  // able to learn whether this site is configured.
  const claims = authenticate(req);
  const isDispatcher = claims?.role === 'dispatcher';
  const isBootstrap = bootstrapAllowed(req);

  if (!isDispatcher && !isBootstrap) return claims ? forbidden('dispatcher role required') : unauthorized();

  if (!isFirestoreEnabled()) return bad('not configured', 503);

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
  const driverNumber = String(body?.driverNumber ?? '').trim();

  // ── Bootstrap is allowed exactly one action ────────────────────────────────
  if (isBootstrap && !isDispatcher) {
    if (action !== 'bootstrap-dispatcher') return forbidden('bootstrap may only create the first dispatcher');
    if (!driverNumber) return bad('driverNumber is required');
    const pin = String(body?.pin ?? '');
    if (!isValidPinFormat(pin)) return bad('pin must be 4-6 digits');
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
    await patchDoc(`${UNMATCHED_ALIASES}/${id}`, { resolved: true, resolvedAt: new Date().toISOString() });
    return ok({ resolved: id });
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
      if (!existing) {
        fields.pinHash = '';
        fields.role = 'driver';
        fields.mustChangePin = true;
        fields.failedAttempts = 0;
        fields.lockedUntil = null;
        fields.createdAt = new Date().toISOString();
        fields.lastLoginAt = null;
        await setDoc(path, fields);
      } else {
        await patchDoc(path, fields);
      }
      return ok({ driverNumber, aliases, created: !existing });
    }

    case 'issue-pin': {
      const pin = String(body?.pin ?? '');
      if (!isValidPinFormat(pin)) return bad('pin must be 4-6 digits');
      if (!existing) return bad('create the driver first with action=upsert', 404);
      await patchDoc(path, {
        pinHash: await hashPin(pin),
        mustChangePin: true,
        active: true,
        failedAttempts: 0,
        lockedUntil: null,
        pinIssuedAt: new Date().toISOString(),
      });
      return ok({ driverNumber, tempPinSet: true });
    }

    case 'clear-lockout': {
      if (!existing) return bad('no such driver', 404);
      await patchDoc(path, { failedAttempts: 0, lockedUntil: null });
      return ok({ driverNumber, cleared: true });
    }

    case 'set-active': {
      if (!existing) return bad('no such driver', 404);
      const active = body?.active === true;
      await patchDoc(path, { active });
      console.log(`[driver-admin] ${active ? 'reactivated' : 'DEACTIVATED'} ${driverNumber}`);
      return ok({ driverNumber, active });
    }

    default:
      return bad(`unknown action: ${action}`);
  }
};
