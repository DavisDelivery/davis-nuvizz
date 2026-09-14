// driver-label.js — WHAT THE NAME PLATE UNDER A TRUCK SAYS.
//
// PURE. No React, no Google Maps, no clock of its own — `nowMs` is passed in, so the staleness
// boundary can be tested instead of waited for.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE STATUS WORDS ARE GONE.
//
// Chad, on a photograph of the live board: "Too much text showing covering the stops up.
// Want to take all the stale and in route text off and lower the font size of the drivers
// name."
//
// He is right, and the reason is worth writing down because it is a rule about labels and not
// a preference about this one. The plate carried a SECOND line holding "en route", "stopped"
// and "stale". On a real afternoon almost every truck that is moving says "en route" — it is
// printed on nearly every plate at once, which makes it worth nothing per plate and costs a
// whole extra line of white box over the freight underneath. A label that is on everything
// distinguishes nothing; it is just weather.
//
// STALENESS IS NOT LOST WITH THE WORD. A stale fix already dims the truck to 55% and the plate
// to 60% — it always has, independently of the text — so "do not trust this dot" still reads,
// and it reads at a glance from across a room rather than requiring somebody to read 9px type.
// The word was the redundant half of that signal, not the signal.
//
// WHAT SURVIVES on line 2 is route progress ("Stop 3 of 12"), because that is not weather: it
// is different for every truck, it changes through the day, and it is the one thing on this
// plate a dispatcher acts on. It is also absent on most boards — no route match, no line —
// which is why removing the suffixes makes nearly every plate one line, which is the whole
// point of the change.
// ─────────────────────────────────────────────────────────────────────────────

/** A position older than this is not to be trusted as "where the truck is now". */
export const DRIVER_STALE_MIN = 30;

/**
 * PURE. Is this fix too old to believe?
 * A missing timestamp is NOT stale — it is "we were never told", which is a different claim,
 * and dimming a truck for it would quietly mark a whole fleet untrustworthy on a feed that
 * simply does not send the field.
 */
export function driverFixStale(locatedAt, nowMs, staleMin = DRIVER_STALE_MIN) {
  if (!locatedAt) return false;
  const at = locatedAt instanceof Date ? locatedAt.getTime() : new Date(locatedAt).getTime();
  if (!Number.isFinite(at)) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const limit = Number.isFinite(Number(staleMin)) && Number(staleMin) > 0 ? Number(staleMin) : DRIVER_STALE_MIN;
  return (now - at) / 60000 > limit;
}

/**
 * PURE. "7792 · Brent D." — the truck, then who is in it.
 *
 * FIRST NAME AND AN INITIAL, because the plate has to fit over a road. The feed may hand us
 * the parts already split (driverFirstName / driverLastInitial) or one full string, and both
 * shapes have to produce the same plate — two spellings of the same driver on two boards is
 * how a dispatcher ends up believing there are two of them.
 *
 * "(no driver)" IS SAID OUT LOUD. A truck with nobody signed into it is a real operational
 * state — it is the one you look for when a route is not moving — and a blank there would read
 * as a rendering fault rather than a fact.
 */
export function driverPlateName(d = {}) {
  const full = typeof d.driverName === 'string' ? d.driverName.trim() : '';
  if (!full && !d.driverFirstName) return '(no driver)';
  const parts = full ? full.split(/\s+/).filter(Boolean) : [];
  const first = d.driverFirstName || parts[0] || '';
  const rawLast = d.driverLastInitial || (parts.length > 1 ? parts[parts.length - 1][0] : '');
  const lastInit = rawLast ? String(rawLast)[0].toUpperCase() : '';
  if (!first) return '(no driver)';
  return lastInit ? `${first} ${lastInit}.` : String(first);
}

/**
 * PURE. The two lines of the plate, and whether the fix behind it is stale.
 *
 * Line 2 is route progress ONLY. See the header: "en route" / "stopped" / "stale" were on
 * nearly every plate at once and are gone; staleness rides the opacity the caller already
 * applies, which is returned here so the caller cannot come to disagree about the boundary.
 *
 * @returns {{line1: string, line2: string, stale: boolean}}
 */
export function driverLabelLines(d = {}, nowMs = Date.now()) {
  const line1 = `${d.vehicleNumber || '?'} · ${driverPlateName(d)}`;
  let line2 = '';
  if (d.routeAssigned && d.routeProgress && Number.isFinite(Number(d.routeProgress.total))) {
    line2 = `Stop ${d.routeProgress.completed ?? 0} of ${d.routeProgress.total}`;
  } else if (d.routeAssigned && d.routeId) {
    line2 = `Route ${d.routeId} · ${d.routeTotalStops ?? '?'} stops`;
  }
  return { line1, line2, stale: driverFixStale(d.locatedAt, nowMs) };
}
