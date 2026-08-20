// travel-model.mts — what the board's clock runs on, served to the browser.
//
// The flag engine runs in TWO places: the 20-minute server sweep and the browser's own
// 5-minute recompute. The server reaches Firestore directly; the browser gets the same
// inputs from here — the calibrated speed curve and the cached real drive times — so the
// screen and the emails can never disagree about how long a leg takes.
//
// READ-ONLY, schedule-free (a function carrying config.schedule is not reachable over
// plain HTTP in this app — a property rediscovered twice at cost). It never calls Google:
// filling the cache is the sweep's job; this only reports what is already known.
// ZERO NuVizz calls.
import { isFirestoreEnabled, getDoc, etDayString } from './lib/firestore.mts';
import { travelLegsPath, legSecondsMap, isGoogleRoutesEnabled, readTravelCalibration, readRouteClasses } from './lib/travel-store.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), {
    status: s,
    headers: {
      'Content-Type': 'application/json',
      // Short client cache: the leg cache moves at most once per 20-minute sweep, and a
      // stale curve for a minute costs nothing. Keeps refocus-storms off Firestore.
      'Cache-Control': 'public, max-age=60',
    },
  });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    // readTravelCalibration decodes the doc's array-of-maps curve back into the [at,mph]
    // pairs every consumer speaks — the browser gets pairs, same as the server engine.
    const [cal, legDoc, routeClasses] = await Promise.all([
      readTravelCalibration(TENANT),
      getDoc(travelLegsPath(TENANT)).catch(() => null),
      readRouteClasses(TENANT, etDayString()),
    ]);
    const legs = legSecondsMap(legDoc);
    return J({
      ok: true,
      // The curve: null until the first nightly fit has run — the client falls back to
      // the shipped DEFAULT_CURVE, which is itself fitted from history, so "no doc yet"
      // is a fresher-vs-shipped distinction, not a good-vs-bad one.
      curve: cal?.curve?.length ? cal.curve : null,
      serviceMin: Number.isFinite(cal?.serviceMin) ? cal.serviceMin : null,
      buckets: cal?.buckets ?? null,
      // Per-truck-class refinements: curves keyed 'tractor'/'box' (as [at,mph] pairs),
      // measured dwell per class, and TODAY's route→class map the sweep resolved from the
      // roster — so a tractor route reads on a tractor clock in the browser too.
      classCurves: cal?.classCurves ?? null,
      classService: cal?.classService ?? null,
      routeClasses,
      // The DATE the map is valid for. Route names repeat every day (SUW runs daily) and
      // drivers rotate, so a client looking at tomorrow's or Friday's board must not walk
      // it on today's trucks — it needs this to know when to drop the map.
      routeClassesDate: etDayString(),
      fittedAt: cal?.fitted_at ?? null,
      calDays: cal?.days ?? 0,
      legs,
      legCount: Object.keys(legs).length,
      googleEnabled: isGoogleRoutesEnabled(),
      legsUpdatedAt: legDoc?.updated_at ?? null,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
