// src/lib/route-create.js — deriving a NuVizz load number for a NEW route (PURE).
//
// A route has TWO identifiers and they are not the same thing (see loadDisplayName /
// looksLikeLoadNbr in App.jsx): the human ROUTE NAME the board groups by ("TRAILER 6",
// "SUW 2"), and the LOAD NUMBER NuVizz keys load/info by. Portal-created loads get a
// NuVizz-minted number (DAVIS000000123); a route created through routePlan/update must
// supply its own, unique to the business and capped at 20 characters.
//
// The dispatcher types only the NAME. This derives the number, and the date is part of it
// on purpose: TRAILER 6 runs most days, so the number has to identify THAT DAY'S instance —
// otherwise the second day's create would collide with the first day's route and be refused.
export const ROUTE_FIELD_MAX = 20;

/** Strip a route name to the characters a load number may carry: A-Z, 0-9. */
export function routeNameSlug(routeName) {
  return String(routeName ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * Derive the load number for `routeName` on `date` (yyyy-mm-dd) → e.g.
 * ("TRAILER 6", "2026-07-31") → "TRAILER6-0731".
 *
 * The MMDD suffix is never truncated — it is what makes each day's instance distinct — so
 * the NAME is what gives way when the two together would exceed NuVizz's 20-char cap.
 * Returns '' when either input is unusable, so callers can treat '' as "not valid yet".
 */
export function routeLoadNbr(routeName, date) {
  const slug = routeNameSlug(routeName);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  if (!slug || !m) return '';
  const suffix = `-${m[2]}${m[3]}`;
  return slug.slice(0, ROUTE_FIELD_MAX - suffix.length) + suffix;
}

/**
 * Client-side pre-flight for the New route form. Catches everything that would otherwise
 * cost a NuVizz round-trip to learn, and one thing the server CANNOT catch: a name already
 * on today's board. (The server's own collision guard is the real authority — it refuses on
 * the load NUMBER, read live from NuVizz. This is the courtesy check, not the safety one.)
 *
 * `existingNames` = route names already on the board for that day.
 * Returns { ok, error, loadNbr }.
 *
 * NOTE (Aug 3 2026): NuVizz refuses a route with no stop node (reason 903), but that check
 * does NOT live here — the form only makes a LOCAL Compare card; the create is sent on Save
 * with the card's orders riding along, and Save is where an empty card is refused.
 */
export function validateNewRoute({ routeName, date, existingNames = [], hasOrigin = true } = {}) {
  const name = String(routeName ?? '').trim();
  if (!name) return { ok: false, error: 'Give the route a name (what you want to see on the board, e.g. TRAILER 6).', loadNbr: '' };
  if (name.length > ROUTE_FIELD_MAX) return { ok: false, error: `NuVizz caps a route name at ${ROUTE_FIELD_MAX} characters — "${name}" is ${name.length}.`, loadNbr: '' };
  if (!routeNameSlug(name)) return { ok: false, error: 'A route name needs at least one letter or number.', loadNbr: '' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '').trim())) return { ok: false, error: 'Pick the day this route runs.', loadNbr: '' };
  const clash = existingNames.map((n) => String(n ?? '').trim().toUpperCase()).includes(name.toUpperCase());
  if (clash) return { ok: false, error: `${name} is already on the board for that day — open it from the Routes list instead of creating a second one.`, loadNbr: '' };
  if (!hasOrigin) return { ok: false, error: 'Set a ship-from address in the New Order tab first — NuVizz will not create a route without one.', loadNbr: '' };
  return { ok: true, error: null, loadNbr: routeLoadNbr(name, date) };
}
