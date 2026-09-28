// src/lib/route-load-stamp.js — READING THE LOAD THE SCAN RESOLVED, ONE RULE FOR EVERY READER.
//
// The scan (netlify/functions/lib/route-load-day.mts) writes, on a routed board row, the NuVizz
// load that holds it — its roster load NUMBER and id for the day (CLAUDE.md, "THE ROSTER SCAN HAS
// THE LOAD NUMBERS") — and, on an order still sitting on a PAST day's load, `heldOn`. Those stamps
// are true of the row AS THE SCAN SAW IT. A confirmed Save rewrites the plan fields on the stored
// row (patchBoardPlan spreads the old row and overlays route / planned-ness) without touching the
// stamps, so for the minutes until the next scan a row can read "Route JOE" beside MARCUS's load
// number, or "planned" beside "still on Friday's load".
//
// So a stamp is honoured only while the row still says what it said when it was stamped:
//   • a load stamp → the row is PLANNED and on the SAME route name the stamp was written for
//     (`rosterLoadRoute`);
//   • a held stamp → the row is UN-PLANNED.
// Anything else reads as "no stamp", and each reader falls back to what it showed before stamps
// existed. The Map feed, the Stop lookup card, stop-explain, debug capture, the Claude shadow and
// the scan's own filing all ask through these two functions, so they can never disagree.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => (v == null ? '' : String(v).trim());

/**
 * The roster load the scan resolved for a PLANNED row: { loadNbr, loadId, day, via, route } —
 * `day` is set only when the scan read the load's membership and filed the row on that load's
 * day; a stamp named from the day's roster by route carries no day of its own. null when there
 * is no stamp, or the row's plan has moved since it was written.
 */
export function stampedLoadOf(row) {
  if (!row || row.isPlanned !== true) return null;
  const loadNbr = str(row.rosterLoadNbr);
  if (!loadNbr) return null;
  const stampedRoute = str(row.rosterLoadRoute);
  const route = str(row.routeName) || str(row.loadNbr);
  if (!stampedRoute || !route || stampedRoute.toLowerCase() !== route.toLowerCase()) return null;
  const day = str(row.loadDay);
  return {
    loadNbr,
    loadId: str(row.rosterLoadId) || null,
    day: DAY.test(day) ? day : null,
    via: str(row.rosterLoadVia) || null,
    route,
  };
}

/**
 * The past day's load an UN-PLANNED row is still sitting on in NuVizz: { loadNbr, loadId, day,
 * route, driver }. null when the row is not held, or has been planned since.
 */
export function heldLoadOf(row) {
  if (!row || row.isUnplanned !== true || row.isPlanned === true) return null;
  const h = row.heldOn;
  if (!h || typeof h !== 'object') return null;
  const loadNbr = str(h.loadNbr);
  if (!loadNbr) return null;
  const day = str(h.day);
  return {
    loadNbr,
    loadId: str(h.loadId) || null,
    day: DAY.test(day) ? day : null,
    route: str(h.route) || null,
    driver: str(h.driver) || null,
  };
}
