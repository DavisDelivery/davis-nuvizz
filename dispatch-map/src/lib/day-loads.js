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
// ── THE ROSTER IS THE AUTHORITY (Chad, Jul 31) ───────────────────────────────
// First cut of this file keyed rows by NAME, which meant two loads sharing a name collapsed
// into one row. Chad: "shouldn't they have different load numbers so for this particular day
// we should display both." Exactly right, and it is the deeper point: NuVizz identifies a load
// by its NUMBER. A name is a label two loads can wear at once — a route cancelled and rebuilt
// under the same name leaves two, which is what v0.54.19-v0.54.22 made routine. Hiding one
// behind the other loses a real load the dispatcher may need to act on.
//
// So the day's ROSTER is the list, one row per load, each with its own number, status and stop
// count straight from NuVizz. Board data (driver, freight, delivered) is then merged ONTO the
// row it belongs to, matched by load id — never by name when a name is contested.
//
// Board groups come from stops and carry a load id only when their stops were enriched; the
// stops feed itself has no load-number column (it puts the route NAME in loadNbr). So when two
// loads share a name and the board group has no id, the group genuinely CANNOT be attributed
// to either — and it is left as its own row saying so, rather than being guessed onto one.

/** Loads that carry orders sort FIRST — on a board that is mostly empty drafts, the working
 *  routes must not be buried under 90-odd Drafts. Within each half, by display name. */
function compareLoads(a, b) {
  const aWork = a.count > 0 ? 0 : 1;
  const bWork = b.count > 0 ? 0 : 1;
  if (aWork !== bWork) return aWork - bWork;
  return String(a.display).localeCompare(String(b.display)) || String(a.loadNbr ?? '').localeCompare(String(b.loadNbr ?? ''));
}

const lc = (v) => String(v ?? '').trim().toLowerCase();
const num = (v) => Number(v) || 0;

function rowFromRoster(l, ambiguous) {
  const name = String(l?.name ?? '').trim();
  const loadNbr = l?.loadNbr != null && String(l.loadNbr).trim() ? String(l.loadNbr) : null;
  const loadId = l?.loadId != null && String(l.loadId).trim() ? String(l.loadId) : null;
  return {
    key: String(loadId || loadNbr || name),
    display: name || String(loadNbr || loadId || 'Unnamed load'),
    name, loadNbr, loadId,
    driver: '',
    // The roster's own trip count — so a load with orders reads correctly even before any of
    // its stops reach the board (and, for two same-named loads, each shows ITS own count).
    count: num(l?.trips), locCount: 0, delivered: 0, exceptions: 0,
    skids: 0, loose: 0, weight: 0,
    status: String(l?.status ?? ''), rosterStatus: String(l?.status ?? ''),
    empty: num(l?.trips) === 0,
    fromRoster: true, onBoard: false,
    ambiguous, unattributed: false,
  };
}

function rowFromGroup(g, ambiguous, unattributed) {
  const name = String(g?.name ?? g?.key ?? '').trim();
  return {
    key: String(g?.key ?? name),
    display: name || String(g?.loadNbr ?? 'Unnamed load'),
    name,
    loadNbr: g?.loadNbr != null ? String(g.loadNbr) : null,
    loadId: g?.loadId != null ? String(g.loadId) : null,
    driver: String(g?.driver ?? ''),
    count: num(g?.count), locCount: num(g?.locCount), delivered: num(g?.delivered), exceptions: num(g?.exceptions),
    skids: num(g?.skids), loose: num(g?.loose), weight: num(g?.weight),
    status: String(g?.status ?? ''), rosterStatus: String(g?.rosterStatus ?? ''),
    empty: num(g?.count) === 0,
    fromRoster: false, onBoard: true,
    ambiguous, unattributed,
  };
}

/** Merge a board group's live numbers onto the roster row it belongs to. */
function applyBoard(row, g) {
  row.onBoard = true;
  row.driver = String(g?.driver ?? '') || row.driver;
  row.count = num(g?.count) || row.count;
  row.locCount = num(g?.locCount);
  row.delivered = num(g?.delivered);
  row.exceptions = num(g?.exceptions);
  row.skids = num(g?.skids); row.loose = num(g?.loose); row.weight = num(g?.weight);
  row.empty = row.count === 0;
  // The group's status already went through the roster resolver (route-status.js), so it is
  // either this load's own status or an execution-derived one — never a rival's.
  if (g?.status) row.status = String(g.status);
  return row;
}

/**
 * mergeDayLoads(routeGroups, rosterList) → one row per LOAD on the day.
 *
 * Row: { key, display, name, loadNbr, loadId, driver, count, locCount, delivered, exceptions,
 *        skids, loose, weight, status, rosterStatus, empty, fromRoster, onBoard, ambiguous,
 *        unattributed }
 *
 * `ambiguous`    — another load on the day carries this same name.
 * `unattributed` — board stops that could not be tied to a specific load (a contested name and
 *                  no load id to settle it). Never merged into a real load's row: showing 16
 *                  orders against the wrong STEVEN is worse than showing them unattached.
 */
export function mergeDayLoads(routeGroups = [], rosterList = []) {
  const roster = (rosterList || []).filter(Boolean);
  // A name is contested when two rows carrying it are DIFFERENT loads.
  const idsByName = new Map();
  for (const l of roster) {
    const nm = lc(l?.name);
    if (!nm) continue;
    const id = String(l?.loadId ?? l?.loadNbr ?? '');
    const set = idsByName.get(nm) || new Set();
    set.add(id);
    idsByName.set(nm, set);
  }
  const isAmbiguous = (nm) => (idsByName.get(nm)?.size || 0) > 1;

  // One row per roster load — the day's real inventory, each with its own number.
  const rows = [];
  const byId = new Map();
  const byNbr = new Map();
  const byName = new Map();
  for (const l of roster) {
    const nm = lc(l?.name);
    const row = rowFromRoster(l, isAmbiguous(nm));
    rows.push(row);
    if (row.loadId) byId.set(row.loadId, row);
    if (row.loadNbr) byNbr.set(row.loadNbr, row);
    if (nm && !isAmbiguous(nm) && !byName.has(nm)) byName.set(nm, row);
  }

  // Board groups enrich the load they belong to — matched by IDENTITY first.
  for (const g of routeGroups || []) {
    if (!g) continue;
    const gid = g.loadId != null ? String(g.loadId) : null;
    const gnbr = g.loadNbr != null ? String(g.loadNbr) : null;
    const nm = lc(g.name ?? g.key);
    const target = (gid && byId.get(gid)) || (gnbr && byNbr.get(gnbr)) || null;
    if (target) { applyBoard(target, g); continue; }
    // No identity match. An UNCONTESTED name is a safe join — it can only mean one load.
    if (nm && !isAmbiguous(nm) && byName.has(nm)) { applyBoard(byName.get(nm), g); continue; }
    // Contested name (or a load the roster doesn't know): its own row. When the name is
    // contested this is board work we cannot attribute — say so rather than pick a load.
    rows.push(rowFromGroup(g, nm ? isAmbiguous(nm) : false, nm ? isAmbiguous(nm) : false));
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
