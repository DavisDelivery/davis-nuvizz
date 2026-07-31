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

// A CANCELLED load holds no planned work — NuVizz returns its orders to Un-Planned. So when a
// name is carried by two loads and only one of them is live, there is no real contest: the
// live one owns the name, and the board's stops can only be its. Chad, Jul 31, on his two
// STEVENs: "the active and canceled one". Without this the app refuses to guess — correct but
// useless, since it cost him the status badge AND the ability to save the card. With it, the
// everyday cancel-and-rebuild case just works, and a genuine contest (two LIVE loads sharing a
// name) still refuses.
export function isCancelledStatus(raw) {
  return /cancel/i.test(String(raw ?? ''));
}

/**
 * Which load owns `name` on this day → { load, ambiguous }.
 *   • one candidate              → it owns the name
 *   • several, one not cancelled → the live one owns it
 *   • several live               → ambiguous; nothing may speak for the name
 */
export function resolveNameOwner(name, rosterLoads = []) {
  const nm = String(name ?? '').trim().toLowerCase();
  if (!nm) return { load: null, ambiguous: false };
  const all = (rosterLoads || []).filter((l) => String(l?.name ?? '').trim().toLowerCase() === nm);
  // The SAME load listed twice is not a contest.
  const distinct = [];
  for (const l of all) {
    const id = String(l?.loadId ?? l?.loadNbr ?? '');
    if (!distinct.some((x) => String(x?.loadId ?? x?.loadNbr ?? '') === id)) distinct.push(l);
  }
  if (distinct.length <= 1) return { load: distinct[0] || null, ambiguous: false };
  const live = distinct.filter((l) => !isCancelledStatus(l?.status));
  if (live.length === 1) return { load: live[0], ambiguous: false };
  return { load: null, ambiguous: true };
}

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
  const owners = new Map();   // name lc → { load, ambiguous }; a cancelled twin never wins
  for (const l of rosterLoads || []) {
    const nm = String(l?.name ?? '').trim().toLowerCase();
    const id = l?.loadId != null ? String(l.loadId) : null;
    const raw = l?.status ?? '';
    if (nm) {
      if (!owners.has(nm)) owners.set(nm, resolveNameOwner(nm, rosterLoads));
      const own = owners.get(nm);
      // The NAME key carries the OWNER's status — never last-write-wins, and never a cancelled
      // twin's while a live load holds the name.
      if (own.ambiguous) status.set(rosterAmbiguousKey(nm), true);
      else if (own.load) status.set(nm, own.load.status ?? '');
      if (!status.has(nm)) status.set(nm, raw);
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
