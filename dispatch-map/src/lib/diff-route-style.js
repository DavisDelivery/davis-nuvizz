// lib/diff-route-style.js
//
// Two routes for the same driver on one map: what dispatch actually ran (ORIGINAL) and what the
// engine proposes (NEW). Chad, on the Diff tab with Aaron Mitchell focused: "need an orginal
// line and new line."
//
// Both lines were already being drawn — `drawDispatch('diff'); drawEngine();` — so this was
// never a missing line. It was drawn as if only one of them mattered:
//
//   original  weight 2.5 · opacity 0.50 · zIndex 4
//   new       weight 4.0 · opacity 0.95 · zIndex 6
//
// A thinner, fainter line underneath a thicker, solid one is INVISIBLE wherever the two agree —
// and on a real day two plans for the same driver agree over most of the route. What little grey
// escaped along the edges read as a road, because a 50%-opacity slate line on a Google basemap
// looks exactly like map furniture. So the tab whose entire purpose is comparing two routes
// showed one route, and the legend promised a grey line the dispatcher could not find.
//
// THE FIX IS WIDTH, and it has to be: opacity and colour both lose to whatever is painted on top,
// but a wider line under a narrower one still shows on both sides of it. The original is drawn as
// a CASING — wider, softer, underneath — so where the plans agree you see the new route running
// inside a grey sleeve, and where they diverge you see two plainly separate lines. Neither state
// is ambiguous, and neither line can ever be fully hidden by the other.
//
// Dashes are deliberately NOT used to tell original from new: on this map a dashed line already
// means "trip 2+", and overloading it would make a second trip on the new route indistinguishable
// from the original route.

/**
 * The dispatch side of the map, grouped into the TRIPS it was actually driven as.
 *
 * `actual_pos` restarts at 1 on every load, so a driver who ran two trips has two stops at
 * position 1, two at position 2, and so on. Grouping that driver's stops into ONE line and
 * sorting by position interleaves the trips — trip-1 stop, trip-2 stop, trip-1 stop — and draws
 * a route shuttling back and forth across the metro. That is the bundle of wide grey bands on
 * Nana Owusu's diff (2 trips, 24 stops): one line pretending two trips were one. It was always
 * wrong; it only became visible when the original route became a casing in v0.54.7, because at
 * 2.5px and half opacity nobody could see what it was drawing.
 *
 * The engine side has always drawn one line per trip (`engine_trips`). This gives dispatch the
 * same treatment. A plan computed before `actual_trip` existed has none, and every stop for a
 * driver collapses into a single group — exactly the old behaviour, so nothing breaks while
 * stored plans catch up.
 *
 * @returns [{drv, stops}] — one entry per trip, stops in driven order.
 */
export function groupDispatchTrips(stops) {
  const byTrip = new Map();
  for (const s of stops || []) {
    if (!s?.actual_driver) continue;
    // The driver rides ON the group rather than being parsed back out of the composite key —
    // driver ids are free text and can contain the separator.
    const key = s.actual_driver + '::' + (s.actual_trip ?? '');
    (byTrip.get(key) ?? byTrip.set(key, { drv: s.actual_driver, stops: [] }).get(key)).stops.push(s);
  }
  for (const g of byTrip.values()) {
    // A stop with no position sorts to the end rather than to the front, where it would drag
    // the line out to a random corner before the route has started.
    g.stops.sort((a, b) => (a.actual_pos ?? 1e9) - (b.actual_pos ?? 1e9));
  }
  return [...byTrip.values()];
}

/** Neutral slate — the original is never drawn in a driver's colour, so it can't be misread
 *  as one of the engine's routes. Darker than the old #64748b so it reads as drawn, not as road. */
export const DIFF_ORIGINAL_COLOR = '#475569';

/** How much wider the casing is than the line it sits under. 2.3x leaves a visible sleeve on
 *  both sides at every zoom, without the original swamping the route it is being compared to. */
export const DIFF_CASING_RATIO = 2.3;

const NEW_WEIGHT = 3.5;

/**
 * Polyline options for one side of the diff.
 *
 * @param kind 'original' (dispatch, as run) | 'new' (engine proposal)
 * @param opts color — the driver colour, used by 'new' only; ignored for 'original'.
 * @returns {{strokeColor: string, strokeOpacity: number, strokeWeight: number, zIndex: number}}
 */
export function diffRouteStyle(kind, opts = {}) {
  if (kind === 'original') {
    return {
      strokeColor: DIFF_ORIGINAL_COLOR,
      // Soft enough that the new route reads as the foreground, opaque enough to be a line.
      strokeOpacity: 0.45,
      strokeWeight: Math.round(NEW_WEIGHT * DIFF_CASING_RATIO * 10) / 10,
      zIndex: 3,          // under the new route AND under the pins
    };
  }
  return {
    strokeColor: opts.color || DIFF_ORIGINAL_COLOR,
    strokeOpacity: 1,     // fully opaque: it is the answer being proposed
    strokeWeight: NEW_WEIGHT,
    zIndex: 6,
  };
}
