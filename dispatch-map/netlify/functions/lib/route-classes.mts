// lib/route-classes.mts — WHICH TRUCK RUNS EACH ROUTE, in one place.
//
// This was written inline inside eta-flag-alert-background, where it was correct and where
// only one of the two sweeps could reach it. The evening sweep therefore judged tomorrow's
// board with NO truck-class map at all — every route on the fleet travel curve, and (once R7
// existed) no way to know which loads were running a tractor. Copying forty lines into the
// second sweep is how two answers to one question get born, so it moved here instead.
//
// TRUTHIEST SOURCE FIRST, and the order is the whole design:
//
//   load header   the NuVizz load's own vehicleType — the unit actually ASSIGNED to this
//                 load, refreshed into the fleet index on every scan. This is a fact about
//                 today.
//   roster        the MarginIQ employee roster's per-driver vehicleType, where the header is
//                 silent. This is the driver's USUAL truck — an inference, and on exactly the
//                 day that matters (tractor in the shop, driver in a rental box) the header
//                 knows and the roster does not.
//
// A route neither source can class is ABSENT from the map, deliberately. "I do not know what
// truck is on this load" and "it is a box truck" are different claims, and a caller that
// treats absence as a class turns the first into the second silently.
//
// `sourceByRoute` is returned alongside because the two are not equally strong and a consumer
// is entitled to say which one it is quoting. Firestore only; ZERO NuVizz calls.
import { travelClassOf } from '../../../src/lib/travel-model.js';
import { loadVehicleRoster, vehicleTypeForStop } from './tractor-flags.mts';

export type ClassSource = 'load_header' | 'roster';

export interface RouteClassResult {
  classes: Record<string, string>;          // routeKey (loadNbr or routeName) -> 'tractor' | 'box'
  sourceByRoute: Record<string, ClassSource>;
  source: 'none' | 'load_header' | 'roster' | 'header+roster';
  fromHeader: number;
  fromRoster: number;
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
export function buildRouteClasses(loads: any[], stops: any[], roster: any): RouteClassResult {
  const classes: Record<string, string> = {};
  const sourceByRoute: Record<string, ClassSource> = {};
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

  let fromRoster = 0;
  if (roster) {
    const votes = new Map<string, Map<string, number>>();
    for (const s of (stops || []) as any[]) {
      const k = String(s?.loadNbr || s?.routeName || '').trim();
      if (!k || k in classes) continue;
      // Same electorate as the nightly calibration: deliveries on judged routes only.
      if (String(s?.stopType || '').toUpperCase() === 'PU') continue;
      if (/\b(?:APPTS?|APPOINTMENTS?)\b/i.test(k)) continue;
      const cls = travelClassOf(vehicleTypeForStop(s, roster));
      if (!cls) continue;
      if (!votes.has(k)) votes.set(k, new Map());
      const v = votes.get(k)!;
      v.set(cls, (v.get(cls) || 0) + 1);
    }
    for (const [k, v] of votes) {
      const ranked = [...v.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
        classes[k] = ranked[0][0];
        sourceByRoute[k] = 'roster';
        fromRoster++;
      }
    }
  }

  const source = fromHeader && fromRoster ? 'header+roster'
    : fromHeader ? 'load_header'
      : fromRoster ? 'roster' : 'none';
  return { classes, sourceByRoute, source, fromHeader, fromRoster };
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
): Promise<RouteClassResult> {
  let loads: any[] = [];
  try {
    loads = (await listLoads()) || [];
  } catch (e: any) {
    console.error('fleet-index class read failed (roster will carry it):', e?.message);
  }
  let roster: any = null;
  try {
    roster = await loadVehicleRoster();
  } catch (e: any) {
    console.error('vehicle roster unavailable (headers alone will carry it):', e?.message);
  }
  return buildRouteClasses(loads, stops, roster);
}
