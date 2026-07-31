// src/lib/route-status.js — which roster row gets to say what a route's STATUS is (PURE).
//
// Chad, Jul 31, with the portal open beside the app: "why are we showing this load canceled
// its not canceled in nuvizz." STEVEN — 16 orders, a driver, 52 miles, plainly alive in the
// portal — wore a red CANCELLED badge on our board.
//
// The route's status comes from the day's load roster, looked up out of a Map the roster
// effect builds. That map was keyed BY NAME with last-write-wins:
//
//     status.set(nm, l.status || '');     // two loads named STEVEN → whichever came last
//
// and the lookup consulted the NAME FIRST, ahead of the load id — even for a route whose id
// we know exactly, because it was derived from its own stops. So a second roster row named
// STEVEN (a cancelled instance) decided the live route's badge. The identity index built on
// the very next line already guarded this ("Two loads share a NAME → the name key is
// AMBIGUOUS"), and openRouteInWorkbench / onAssignDriver already refuse ambiguous entries —
// the status path was the one consumer that never got the same treatment.
//
// This is newly easy to hit: cancelling a route and rebuilding it under the same name is
// exactly the workflow v0.54.19–v0.54.22 opened up, and it leaves two same-named rows on the
// day — one Cancelled, one live.
//
// The rule here: IDENTITY WINS. A route we can identify (loadId, or a real load number) takes
// its status from that row and nothing else. A NAME may only speak when it is unambiguous.
// When neither can answer, the caller falls back to the execution-derived status (built from
// the route's own stops), which is always about THIS route and can never be another load's.

export const ROSTER_ID_PREFIX = '#id:';
export const ROSTER_AMBIGUOUS_PREFIX = '#amb:';

/** Key a roster status by load id — the only unambiguous handle a load has. */
export const rosterIdKey = (loadId) => ROSTER_ID_PREFIX + String(loadId ?? '');
/** Marker key: this lower-cased NAME is carried by two or more loads on the day. */
export const rosterAmbiguousKey = (name) => ROSTER_AMBIGUOUS_PREFIX + String(name ?? '').trim().toLowerCase();

/**
 * Build the status map the board reads, from the day's raw roster rows.
 *
 * Keys written:
 *   '<name lc>'      the load's status BY NAME — only trustworthy when unique
 *   '#id:<loadId>'   by id, and by loadNbr where the roster carries one — always trustworthy
 *   '#amb:<name lc>' true when 2+ DIFFERENT loads share that name
 *
 * A name is ambiguous when two rows carrying it have different load ids. Two rows for the
 * same load (the roster listing it twice) is not a collision.
 */
export function buildRosterStatusMap(rosterLoads = []) {
  const status = new Map();
  const idByName = new Map();
  for (const l of rosterLoads || []) {
    const nm = String(l?.name ?? '').trim().toLowerCase();
    const id = l?.loadId != null ? String(l.loadId) : null;
    const raw = l?.status ?? '';
    if (nm) {
      const prior = idByName.get(nm);
      if (prior !== undefined && String(prior) !== String(id)) status.set(rosterAmbiguousKey(nm), true);
      else idByName.set(nm, id);
      status.set(nm, raw);
    }
    if (id) status.set(rosterIdKey(id), raw);
    // The real load NUMBER is just as unambiguous as the id, and a group that resolved one
    // should be able to use it.
    if (l?.loadNbr != null && String(l.loadNbr).trim()) status.set(rosterIdKey(String(l.loadNbr)), raw);
  }
  return status;
}

/**
 * The roster status for one route group, or null when no row may speak for it.
 *
 * `group`: { name, loadId, loadNbr } — loadNbr on a board-derived group is usually the route
 * NAME (the stops feed has no number column), which simply won't match an id key. Harmless.
 */
export function resolveRosterStatus(group, statusByKey) {
  if (!statusByKey || typeof statusByKey.get !== 'function') return null;
  // 1. IDENTITY — the id we derived from this route's own stops, then a real load number.
  for (const id of [group?.loadId, group?.loadNbr]) {
    if (id == null || String(id).trim() === '') continue;
    const hit = statusByKey.get(rosterIdKey(String(id)));
    if (hit !== undefined) return hit;
  }
  // 2. NAME — only when exactly one load on the day carries it.
  const nm = String(group?.name ?? '').trim().toLowerCase();
  if (!nm) return null;
  if (statusByKey.get(rosterAmbiguousKey(nm)) === true) return null;
  const byName = statusByKey.get(nm);
  return byName === undefined ? null : byName;
}
