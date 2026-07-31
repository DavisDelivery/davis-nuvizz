// src/lib/day-loads.js — the day's NuVizz LOADS as one list (PURE).
//
// Chad, Jul 31, on the Routing right rail: "eroutes never end up on the column even though it
// says its what its for." He was right, and it was a naming collision rather than a bug. There
// are TWO different things called a load in this app:
//
//   • a NuVizz LOAD  — a real route on the day's board (TRAILER 6, SUW 2), which is what the
//     bottom grid's Loads view lists and what the dispatcher actually works with; and
//   • a SAVED PLAN   — the output of the routing optimizer, stored in Firestore by "Save load".
//
// The right rail's "Loads" tab was wired to the second one, so a dispatcher looking at 99 real
// loads in the bottom grid saw "No saved loads yet" in the column beside it.
//
// This builds the FIRST list, from two sources that must both be present:
//   • routeGroups  — loads WITH stops on the board (count, driver, freight, progress). Derived
//                    from stops, so a load nobody has planned onto yet cannot appear here.
//   • rosterList   — the day's full load roster, which is the ONLY source of empty Draft loads.
// On Chad's Jul 31 board that second source is nearly all of it: 99 loads, almost every one
// "No orders yet · Draft".

/** Loads that carry orders sort FIRST — on a board that is mostly empty drafts, the working
 *  routes must not be buried under 90-odd Drafts. Within each half, by display name. */
function compareLoads(a, b) {
  const aWork = a.count > 0 ? 0 : 1;
  const bWork = b.count > 0 ? 0 : 1;
  if (aWork !== bWork) return aWork - bWork;
  return String(a.display).localeCompare(String(b.display));
}

/**
 * mergeDayLoads(routeGroups, rosterList) → one row per load on the day.
 *
 * Row: { key, display, name, loadNbr, loadId, driver, count, locCount, delivered, exceptions,
 *        skids, loose, weight, status, rosterStatus, empty, ambiguous }
 *
 * Matching is by NAME, lower-cased — the same join the bottom grid uses, and the only one
 * available: a board stop carries the route NAME in its loadNbr field (the stops feed has no
 * load-number column), so the roster's real number can't be the key.
 *
 * A name carried by two different roster loads is marked `ambiguous` rather than silently
 * deduped: identity consumers already refuse those (openRouteInWorkbench, onAssignDriver),
 * and hiding one behind the other is how a card ends up wearing the wrong load's number.
 */
export function mergeDayLoads(routeGroups = [], rosterList = []) {
  const nameCounts = new Map();
  for (const l of rosterList || []) {
    const nm = String(l?.name ?? '').trim().toLowerCase();
    if (nm) nameCounts.set(nm, (nameCounts.get(nm) || 0) + 1);
  }
  const rows = [];
  const seen = new Set();
  for (const g of routeGroups || []) {
    const name = String(g?.name ?? g?.key ?? '').trim();
    const lc = name.toLowerCase();
    if (lc) seen.add(lc);
    rows.push({
      key: String(g?.key ?? name),
      display: name || String(g?.loadNbr ?? 'Unnamed load'),
      name,
      loadNbr: g?.loadNbr != null ? String(g.loadNbr) : null,
      loadId: g?.loadId != null ? String(g.loadId) : null,
      driver: String(g?.driver ?? ''),
      count: Number(g?.count) || 0,
      locCount: Number(g?.locCount) || 0,
      delivered: Number(g?.delivered) || 0,
      exceptions: Number(g?.exceptions) || 0,
      skids: Number(g?.skids) || 0,
      loose: Number(g?.loose) || 0,
      weight: Number(g?.weight) || 0,
      status: String(g?.status ?? ''),
      rosterStatus: String(g?.rosterStatus ?? ''),
      empty: false,
      ambiguous: lc ? (nameCounts.get(lc) || 0) > 1 : false,
    });
  }
  // Every roster load the board didn't already account for — the empty Drafts. These have no
  // stops to group, so this merge is the only way they are ever visible.
  for (const l of rosterList || []) {
    const name = String(l?.name ?? '').trim();
    const lc = name.toLowerCase();
    if (lc && seen.has(lc)) continue;
    if (lc) seen.add(lc);
    const loadNbr = l?.loadNbr != null ? String(l.loadNbr) : null;
    const loadId = l?.loadId != null ? String(l.loadId) : null;
    if (!name && !loadNbr && !loadId) continue;   // nothing identifiable — never render a ghost row
    rows.push({
      key: String(loadId || loadNbr || name),
      display: name || String(loadNbr || loadId),
      name,
      loadNbr, loadId,
      driver: '',
      count: 0, locCount: 0, delivered: 0, exceptions: 0,
      skids: 0, loose: 0, weight: 0,
      status: String(l?.status ?? ''),
      rosterStatus: String(l?.status ?? ''),
      empty: true,
      ambiguous: lc ? (nameCounts.get(lc) || 0) > 1 : false,
    });
  }
  return rows.sort(compareLoads);
}

/** Counts for the tab label + header line: how much of the day is actually built. */
export function dayLoadTally(rows = []) {
  let withOrders = 0, empty = 0, stops = 0;
  for (const r of rows) {
    if (r.empty || r.count === 0) empty += 1;
    else { withOrders += 1; stops += r.count; }
  }
  return { total: rows.length, withOrders, empty, stops };
}
