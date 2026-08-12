// load-manifest.mts
//
// GET /load-manifest?date=YYYY-MM-DD&loadNbr=DAVIS000197184
//
// Identity comes from the token, never a query param. The token's driverNumber
// reads the credential doc, whose HAND-SEEDED nuvizzAliases decide which stops
// belong to this driver.
//
//   resolved   -> one or more loads, client shows a picker when >1
//   unresolved -> loads: [], unresolved: true, and the client prompts for a load
//                 number off the paperwork. The unmatched alias is recorded for
//                 dispatcher review. NEVER a guessed load.
//
// A LOADER never takes the identity path at all. A forklift operator has no
// stops of their own — they load somebody else's truck, one start to finish and
// several per shift — so with no loadNbr they get the day's loads as pick-list
// summaries (no stops on the wire) and choose the truck they are working.
// Running the identity path for them would resolve to nothing and file an
// unmatched-alias review row on every sign-in.
//
// ?loadNbr overrides resolution entirely. That is the manual path — covering
// another route, an unresolved identity, or a loader's chosen truck. Every use
// is logged.
//
// ZERO NuVizz calls. The pre-built stop index only. Hard rule.
// FILTERING IS SERVER SIDE — a phone never receives all ~600 stops.

import { readStops, getDoc, setDoc, isFirestoreEnabled, readLoadRoster } from './lib/firestore.mts';
import { DRIVER_AUTH, UNMATCHED_ALIASES, authenticate, normalizeRole } from './lib/auth.mts';
import { DriverCred, normalizeDriverAlias, stopBelongsToDriver } from './lib/aliases.mts';
import { toManifestStop, groupIntoLoads, loadSummaries } from './lib/manifest.mts';
import { ok, bad, unauthorized, etDayString, DATE_RE } from './lib/http.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return bad('GET only', 405);
  // Authenticate BEFORE any configuration check: a caller with no token must not
  // be able to learn whether this site is configured.
  const claims = authenticate(req);
  if (!claims) return unauthorized();

  if (!isFirestoreEnabled()) return bad('not configured', 503);

  const url = new URL(req.url);
  const dateParam = String(url.searchParams.get('date') || '');
  const date = DATE_RE.test(dateParam) ? dateParam : etDayString();
  const loadOverride = String(url.searchParams.get('loadNbr') || '').trim();

  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    console.warn(`[load-manifest] ${m}`);
  };

  // The driver's own credential doc — the only source of alias truth.
  const credDoc = await getDoc(`${DRIVER_AUTH}/${claims.sub}`);
  if (!credDoc) return unauthorized();
  if (credDoc.active === false) return bad('inactive', 403);

  const cred: DriverCred = {
    driverNumber: String(claims.sub),
    displayName: String(credDoc.displayName || ''),
    nuvizzAliases: Array.isArray(credDoc.nuvizzAliases) ? credDoc.nuvizzAliases : [],
  };

  // Role comes from the LIVE credential, never the 90-day token: a driver
  // promoted to loader this morning must not wait for token expiry.
  const role = normalizeRole(credDoc.role);

  // Read the day once. mask keeps the wire small — only what the manifest needs.
  const stops = await readStops(TENANT, date, {
    mask: [
      'stopNbr', 'loadNbr', 'routeName', 'routeSeq', 'loadStopSeq',
      'driverName', 'driverUserName',
      'pros', 'primaryPro', 'proCount',
      'businessName', 'city', 'state', 'addr1', 'address1',
      'cartons', 'volume', 'pallets', 'weight',
      'normalizedStatus', 'instruction', 'instructions', 'notes', 'orderInstructions',
      // Already written to the cached stop doc by dispatch-map's normalizer, and
      // free to read — a mask is a projection, not a fetch. Omitting them was
      // hiding detail the phone had already paid for.
      'zip', 'postalCode', 'contactName', 'phone', 'sealNbr', 'plannedFrom', 'plannedTo',
      // Pickups are not loading work — see ManifestStop.isPickup.
      'type', 'stopType',
    ],
  });

  // The day's load roster — the ONLY place the genuine per-day load number and
  // loadId live, since the stop's `loadNbr` is the route name. Read straight
  // from the cache: dispatch-map's /nuvizz-loads-roster endpoint falls through
  // to a LIVE metered vendor pull when the cache is cold, and this must never
  // be able to spend money. A cold roster simply leaves loadId null.
  let roster: any[] = [];
  try {
    const r = await readLoadRoster(TENANT, date);
    roster = r?.loads || [];
  } catch {
    roster = [];
  }

  // ── The manual path: an explicit load number wins over identity ────────────
  if (loadOverride) {
    const mine = stops.filter((s: any) => String(s?.loadNbr || '').trim() === loadOverride);
    console.log(
      `[load-manifest] MANUAL load override: driver=${claims.sub} date=${date} loadNbr=${loadOverride} stops=${mine.length}`,
    );
    const loads = groupIntoLoads(mine.map((s: any) => toManifestStop(s, warn)), roster);
    return ok({
      date,
      driverNumber: cred.driverNumber,
      displayName: cred.displayName,
      role,
      resolvedBy: 'manual_load_number',
      unresolved: false,
      loads,
      warnings,
    });
  }

  // ── Loader path: every truck on the dock, as summaries ─────────────────────
  if (role === 'loader') {
    const summaries = loadSummaries(stops.map((s: any) => toManifestStop(s, warn)), roster);
    console.log(`[load-manifest] LOADER pick-list: loader=${claims.sub} date=${date} loads=${summaries.length}`);
    return ok({
      date,
      driverNumber: cred.driverNumber,
      displayName: cred.displayName,
      role,
      resolvedBy: 'loader_pick_list',
      unresolved: false,
      // Summaries only — stops arrive when a truck is picked, never all at once.
      summariesOnly: true,
      loads: summaries,
      warnings,
    });
  }

  // ── Identity path ──────────────────────────────────────────────────────────
  const mine = stops.filter((s: any) => stopBelongsToDriver(s, cred));

  if (!mine.length) {
    // Nothing matched. Record the aliases actually present on today's board so a
    // dispatcher can see what this driver's set is missing, then refuse to guess.
    const present = [...new Set(
      stops.flatMap((s: any) => [normalizeDriverAlias(s?.driverUserName), normalizeDriverAlias(s?.driverName)]),
    )].filter(Boolean);

    await recordUnmatched(date, cred, present, warn);

    console.log(
      `[load-manifest] UNRESOLVED: driver=${claims.sub} date=${date} aliases=${(cred.nuvizzAliases || []).length} boardAliases=${present.length}`,
    );
    return ok({
      date,
      driverNumber: cred.driverNumber,
      displayName: cred.displayName,
      role,
      resolvedBy: null,
      unresolved: true,
      reason: (cred.nuvizzAliases || []).length ? 'no_alias_match' : 'no_aliases_seeded',
      loads: [],
      warnings,
    });
  }

  const loads = groupIntoLoads(mine.map((s: any) => toManifestStop(s, warn)), roster);
  return ok({
    date,
    driverNumber: cred.driverNumber,
    displayName: cred.displayName,
    role,
    resolvedBy: 'alias',
    unresolved: false,
    loads,
    warnings,
  });
};

/**
 * Append to the dispatcher's review queue. Best-effort: a driver at the dock must
 * not be blocked because a diagnostic write failed.
 */
async function recordUnmatched(date: string, cred: DriverCred, boardAliases: string[], warn: (m: string) => void) {
  try {
    await setDoc(`${UNMATCHED_ALIASES}/${date}__${cred.driverNumber}`, {
      date,
      driverNumber: cred.driverNumber,
      displayName: cred.displayName || '',
      seededAliases: cred.nuvizzAliases || [],
      boardAliases: boardAliases.slice(0, 200),
      at: new Date().toISOString(),
      resolved: false,
    });
  } catch (e: any) {
    warn(`could not record unmatched alias review row: ${e?.message || e}`);
  }
}
