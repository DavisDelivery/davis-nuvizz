// lib/route-classes.mts — WHICH TRUCK RUNS EACH ROUTE, in one place.
//
// This was written inline inside eta-flag-alert-background, where it was correct and where
// only one of the two sweeps could reach it. The evening sweep therefore judged tomorrow's
// board with NO truck-class map at all — every route on the fleet travel curve, and (once R7
// existed) no way to know which loads were running a tractor. Copying forty lines into the
// second sweep is how two answers to one question get born, so it moved here instead.
//
// TWO SOURCES, AND THEY ARE NOT INTERCHANGEABLE — see `sourceByRoute`, which every consumer
// must read before it acts on a class:
//
//   load_header   the LOAD's own vehicleType. A fact about the load: somebody created it as a
//                 tractor-trailer run or a straight-truck run. From the fleet index, or from
//                 the hourly Loads grid when that saved search carries the column.
//   roster /      the MarginIQ employee roster's per-driver vehicleType, joined through the
//   roster_near   NuVizz alias. This is the driver's USUAL truck — an INFERENCE about a
//                 person, not a statement about the load.
//
// CHAD, 2026-09-02: "Loads should not be classed as tractor trailer or box truck only by the
// driver who ends up assigned to them." He is right, and the failure runs both ways: a tractor
// driver in a rental box makes us flag stops that are fine, and — the dangerous one — a box
// driver put on a tractor load makes us MISS the stop a 53-footer cannot reach. The roster
// answers "what does this person usually drive", which is a different question from "what is
// pulling this load", and only the second one may decide whether a trailer fits.
//
// So the roster class is still BUILT and still published (the travel model uses it as a proxy
// for how a driver drives, which is a speed question, not an equipment one) — but it is
// stamped `roster`, and the no-trailer rule refuses anything that is not `load_header`.
//
// A route neither source can class is ABSENT from the map, deliberately. "I do not know what
// truck is on this load" and "it is a box truck" are different claims, and a caller that
// treats absence as a class turns the first into the second silently.
//
// ── THE EVANS MISS (2026-09-02), and what it changed here ─────────────────────
//
// Chad: "Evans contracting was put on a tractor trailer last night and no text was sent it's
// hard coded. 7171235." The customer note WAS a confirmed no-tractor-trailer — run through
// dispatcherTrailerBlock it returns blocked:true — and the route WAS a tractor. The rule
// never judged it because BRENT had no class: NuVizz carries the driver as "Brent  Bryd" and
// the roster's tractor entry for Brenton Byrd carries the alias "Brent Boyd". One letter, and
// the exact join above returned nothing. Fourteen of the day's sixty-three routes were in the
// same state, and NOTHING said so: a route the map cannot class looks, on every screen and in
// every status doc, exactly like a route that was judged and found fine.
//
// Two changes, and the second matters more than the first:
//
//   NEAR-MATCH (ROUTE_CLASS_NEAR_MATCH, default on). When the exact alias join fails, a
//   roster alias with the SAME first name and a surname within ONE edit — and only when
//   exactly one alias qualifies — is accepted, and recorded as `roster_near` so nobody
//   mistakes it for the exact thing. Measured on the live roster before shipping: 59 aliases,
//   ZERO pairs that would be ambiguous under this rule, and "BRENT BRYD" resolves uniquely to
//   BRENT BOYD. It deliberately does NOT reach for the employee's display name when the alias
//   is missing — the alias exists precisely because display names and NuVizz names differ,
//   and tractor-flags.mts has "NEVER the display name" in its first paragraph for a reason.
//
//   EVERY UNCLASSED ROUTE IS NAMED, with the driver NuVizz carries and the closest thing the
//   roster has. That list rides the sweep status docs, the dry-run endpoint and the board's
//   own flag panel, so the next misspelling is a data fix somebody can see rather than a
//   refused delivery somebody finds out about on paper.
//
// `sourceByRoute` is returned alongside because the sources are not equally strong and a
// consumer is entitled to say which one it is quoting. Firestore only; ZERO NuVizz calls.
import { travelClassOf } from '../../../src/lib/travel-model.js';
import { loadVehicleRoster, vehicleTypeForStop, normalizeDriverAlias } from './tractor-flags.mts';

export type ClassSource = 'load_header' | 'roster' | 'roster_near';

export interface NearMatch { route: string; driver: string; alias: string; employee: string; vehicleType: string }
export interface UnclassedRoute {
  route: string;
  drivers: string[];                              // the names NuVizz carries on this route's stops
  reason: 'no_driver' | 'not_on_roster' | 'tie' | 'appointment_route';
  hint: string | null;                            // the closest roster fact, for whoever fixes the data
}

export interface RouteClassResult {
  classes: Record<string, string>;                // routeKey (loadNbr or routeName) -> 'tractor' | 'box'
  sourceByRoute: Record<string, ClassSource>;
  source: 'none' | 'load_header' | 'roster' | 'header+roster';
  fromHeader: number;
  fromRoster: number;
  nearMatches: NearMatch[];                       // every route classed by the near rule, named
  unclassed: UnclassedRoute[];                    // every route with stops that got NO class
}

export interface BuildOpts { nearMatch?: boolean }

/** The switch's position, read once per call so a test can flip it. Anything but an explicit
 *  off-word leaves it ON — a malformed value must not silently disable the one rule that
 *  would have caught the Evans miss. */
export function nearMatchEnabled(env: any = process.env): boolean {
  const v = String(env?.ROUTE_CLASS_NEAR_MATCH ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

// Edit distance WITH adjacent transposition counted as one (optimal string alignment).
//
// Plain Levenshtein calls BYRD -> BRYD a two — one letter out of place is a substitution
// twice — and that is precisely the shape a surname typo takes. Chad, 2026-09-02: "it's
// changed to Brent Byrd in MarginIQ" against a NuVizz string of "Brent  Bryd". A net that
// cannot see a swapped pair would miss the one case it was built for. Surnames are short,
// so the O(n·m) table is nothing.
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // an adjacent swap is ONE edit
      }
    }
  }
  return d[m][n];
}

const splitName = (normalized: string): { first: string; rest: string } => {
  const parts = normalized.split(' ').filter(Boolean);
  return { first: parts[0] || '', rest: parts.slice(1).join(' ') };
};

/**
 * PURE. The one roster alias that is "the same person, spelled slightly differently" — or
 * null when there is none, or more than one.
 *
 * THE RULE, and every clause is a refusal:
 *   • exact match first — this function is only reached when that failed;
 *   • the FIRST name must match exactly (Brent is Brent; Brenton is not);
 *   • the rest of the name must be within ONE edit, and at least four characters long, so
 *     a two-letter surname cannot match half the roster;
 *   • exactly ONE alias may qualify. Two candidates is "I do not know", not "pick one".
 * Returns the matched alias as the roster stores it, so the caller can name it.
 */
export function nearestRosterAlias(name: any, roster: any): string | null {
  const n = normalizeDriverAlias(name);
  if (!n || !roster?.aliasToVehicle?.size) return null;
  const { first, rest } = splitName(n);
  if (!first || rest.length < 4) return null;
  const hits: string[] = [];
  for (const alias of roster.aliasToVehicle.keys()) {
    const a = splitName(alias);
    if (a.first !== first || a.rest.length < 4) continue;
    if (editDistance(a.rest, rest) <= 1) hits.push(alias);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** What the roster holds that is CLOSEST to a name it could not match — for the hint. Never
 *  used to class anything; it exists so the person fixing the data is told where to look. */
function rosterHint(name: string, roster: any): string | null {
  const n = normalizeDriverAlias(name);
  if (!n) return null;
  const { first } = splitName(n);
  // A rostered employee whose DISPLAY name is this exact name but who carries no NuVizz
  // alias — the join refuses display names on purpose, and the fix is one field.
  const noAlias = (roster?.skippedNoAlias || []).find((e: any) => normalizeDriverAlias(e?.name) === n);
  if (noAlias) return `roster "${noAlias.name}" (${noAlias.vehicleType}) has no NuVizz alias — add "${String(name).trim()}"`;
  const sameFirst = roster?.aliasToVehicle
    ? [...roster.aliasToVehicle.entries()].filter(([alias]: any) => splitName(alias).first === first)
    : [];
  if (sameFirst.length) {
    return `roster alias${sameFirst.length === 1 ? '' : 'es'} sharing the first name: ${sameFirst.map(([a, v]: any) => `"${a}" (${v.name}, ${v.vehicleType})`).join(', ')}`;
  }
  return 'nobody on the roster by this name';
}

/**
 * PURE. The route -> truck-class map from raw load headers plus board stops and a roster.
 *
 * Exported separately from the I/O wrapper so the precedence and the vote can be unit-tested
 * without Firestore — the rule that decides which truck a route is on should not need a
 * database to prove.
 *
 * NOTE driverName is a LOAD-level field on this feed, so the per-stop "vote" below is one
 * voice per load in practice. It exists to survive a feed that ever stops being load-level,
 * not because ties are common — and a genuine tie is left UNCLASSED rather than broken by
 * whichever stop happened to come first.
 */
export function buildRouteClasses(loads: any[], stops: any[], roster: any, opts: BuildOpts = {}): RouteClassResult {
  const near = opts.nearMatch ?? nearMatchEnabled();
  const classes: Record<string, string> = {};
  const sourceByRoute: Record<string, ClassSource> = {};
  const nearMatches: NearMatch[] = [];
  const unclassed: UnclassedRoute[] = [];
  let fromHeader = 0;

  for (const l of loads || []) {
    const cls = travelClassOf(l?.vehicleType);
    if (!cls) continue;
    for (const key of [String(l?.loadNbr || '').trim(), String(l?.routeName || '').trim()]) {
      if (!key) continue;
      if (!(key in classes)) fromHeader++;
      classes[key] = cls;
      sourceByRoute[key] = 'load_header';
    }
  }

  // Every route the board carries, with the driver names on it — the unclassed report needs
  // the whole population, not just the voters.
  const routeDrivers = new Map<string, Set<string>>();
  const appointmentRoutes = new Set<string>();
  for (const s of (stops || []) as any[]) {
    const k = String(s?.loadNbr || s?.routeName || '').trim();
    if (!k) continue;
    if (!routeDrivers.has(k)) routeDrivers.set(k, new Set());
    for (const d of [s?.driverName, s?.driverUserName]) { const t = String(d ?? '').trim(); if (t) routeDrivers.get(k)!.add(t); }
    if (/\b(?:APPTS?|APPOINTMENTS?)\b/i.test(k)) appointmentRoutes.add(k);
  }

  let fromRoster = 0;
  const tied = new Set<string>();
  if (roster) {
    const votes = new Map<string, Map<string, number>>();
    const nearByRoute = new Map<string, NearMatch>();
    for (const s of (stops || []) as any[]) {
      const k = String(s?.loadNbr || s?.routeName || '').trim();
      if (!k || k in classes) continue;
      // Same electorate as the nightly calibration: deliveries on judged routes only.
      if (String(s?.stopType || '').toUpperCase() === 'PU') continue;
      if (appointmentRoutes.has(k)) continue;
      let vt = vehicleTypeForStop(s, roster);
      let via: ClassSource = 'roster';
      if (!vt && near) {
        for (const raw of [s?.driverName, s?.driverUserName]) {
          const alias = nearestRosterAlias(raw, roster);
          if (!alias) continue;
          const hit = roster.aliasToVehicle.get(alias);
          vt = hit.vehicleType; via = 'roster_near';
          if (!nearByRoute.has(k)) nearByRoute.set(k, { route: k, driver: String(raw).trim(), alias, employee: hit.name, vehicleType: hit.vehicleType });
          break;
        }
      }
      const cls = travelClassOf(vt);
      if (!cls) continue;
      if (!votes.has(k)) votes.set(k, new Map());
      const v = votes.get(k)!;
      v.set(cls, (v.get(cls) || 0) + 1);
      if (via === 'roster_near') sourceByRoute[k] = 'roster_near';
    }
    for (const [k, v] of votes) {
      const ranked = [...v.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
        classes[k] = ranked[0][0];
        if (sourceByRoute[k] !== 'roster_near') sourceByRoute[k] = 'roster';
        else nearMatches.push(nearByRoute.get(k)!);
        fromRoster++;
      } else {
        tied.add(k);
        delete sourceByRoute[k];
      }
    }
  }

  // THE ROUTES THAT GOT NOTHING, each with the reason and the closest roster fact.
  for (const [k, drivers] of [...routeDrivers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (k in classes) continue;
    const names = [...drivers];
    if (appointmentRoutes.has(k)) { unclassed.push({ route: k, drivers: names, reason: 'appointment_route', hint: null }); continue; }
    if (tied.has(k)) { unclassed.push({ route: k, drivers: names, reason: 'tie', hint: 'the stops on this load name drivers of different truck classes' }); continue; }
    if (!names.length) { unclassed.push({ route: k, drivers: [], reason: 'no_driver', hint: null }); continue; }
    unclassed.push({ route: k, drivers: names, reason: 'not_on_roster', hint: roster ? rosterHint(names[0], roster) : 'no roster loaded' });
  }

  const source = fromHeader && fromRoster ? 'header+roster'
    : fromHeader ? 'load_header'
      : fromRoster ? 'roster' : 'none';
  return { classes, sourceByRoute, source, fromHeader, fromRoster, nearMatches, unclassed };
}

/**
 * The same map, fetched. `listLoads` is injected so this module imports no Firestore and both
 * sweeps can hand it their own reader (and a test can hand it an array).
 *
 * NEVER THROWS. A fleet-index read that fails must cost the sweep its class map, not its
 * whole run — it is logged and the caller judges on the fleet curve, which is what happened
 * before any of this existed. Absence is reported honestly as `source: 'none'`.
 */
export async function readRouteClassesFor(
  listLoads: () => Promise<any[]>,
  stops: any[],
  opts: BuildOpts = {},
  listRoster?: () => Promise<any[]>,
): Promise<RouteClassResult> {
  let loads: any[] = [];
  try {
    loads = (await listLoads()) || [];
  } catch (e: any) {
    console.error('fleet-index class read failed (roster will carry it):', e?.message);
  }
  // THE SECOND HEADER SOURCE, AND IT COSTS NOTHING. The hourly Loads-grid cache
  // (nuvizz_load_roster) already holds every load's number and name; if that saved search
  // carries a vehicle-type column it holds the equipment too, and normalizeLoads reads it.
  // The fleet index — the other header source — has not been written since 2026-04-29 because
  // the list-discovery scan never runs the probe path that fills it, so on most days this is
  // the ONLY route a load's own type can travel. Rows are appended AFTER the fleet index so a
  // real fleet-index header still wins.
  if (listRoster) {
    try {
      const roster = (await listRoster()) || [];
      for (const l of roster) if (l?.vehicleType) loads.push({ loadNbr: l.loadNbr, routeName: l.name ?? l.routeName, vehicleType: l.vehicleType });
    } catch (e: any) {
      console.error('load-roster class read failed:', e?.message);
    }
  }
  let roster: any = null;
  try {
    roster = await loadVehicleRoster();
  } catch (e: any) {
    console.error('vehicle roster unavailable (headers alone will carry it):', e?.message);
  }
  return buildRouteClasses(loads, stops, roster, opts);
}
