// lib/nuvizz-loads.mts
//
// The NuVizz LOAD list (PkgRoute filterdata) — the portal's "Loads" grid. Each row
// carries the load's UNIQUE per-day loadId (the recurring routes share a NAME, e.g.
// "BEN 2", every day, but each day's instance gets its OWN loadId), plus the route
// name, status, driver and trip (stop) count — and since v1.7.0 we actually KEEP the
// driver, which this comment had claimed for months while normalizeLoads dropped it.
//
// We use it as an authoritative anchor for "which loads are TODAY's": a board stop
// that carries a loadId NOT in today's load list is a prior-day instance of a
// recurring route (yesterday's "BEN 2") that bled in — drop it. Confirmed from the
// warehouse: a route's genuine same-day loadId differs day to day.
//
// Best-effort + flag-gated by the caller: if this fetch fails or returns nothing,
// the anchor is a no-op (dropForeignLoadStops returns the board unchanged), so the
// board is never harmed by a load-list hiccup.
//
// Portal HAR shape (POST /deliverit/filterdata, customListDefId 35833): columns
// KeyColumn(=loadId), name(route, link-wrapped), status, noOfTrips, load.totalPlt, …
// We read the openapi equivalent (POST /openapi/entity/filterdata/PkgRoute/{co}) with
// the same Basic creds we already use for the stop list, and parse columns BY PATTERN
// so a differing column layout still resolves loadId/name/status/trips.

import { getNuvizzRequester } from './nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './nuvizz-scan.mts';
// looksLikeLoadNbr moved to nuvizz-list.mts (v1.12.0): the board write-grace needs the same
// question answered, and a third copy of it is how two readers of one fact drift apart.
import { OPENAPI_BASE, linkVal, periodForDate, isHashLikeId, looksLikeLoadNbr } from './nuvizz-list.mts';
export { looksLikeLoadNbr };

// The saved load-list def the portal uses for the Loads grid (HAR-captured). Override
// via env if Davis retunes it in the portal.
const LOAD_LISTDEF = Number(process.env.NUVIZZ_LOAD_LISTDEF) || 35833;
export const LOAD_ENTITY = process.env.NUVIZZ_LOAD_ENTITY || 'PkgRoute';
const LOAD_MAX_RESULT = Number(process.env.NUVIZZ_LOAD_MAX_RESULT) || 500;

// Body for the load list. The HAR's filterList is 5 sequences with seq1 = the period
// (Estimated date window); the rest unfiltered ('-1'). Mirrors buildBody's shape.
export function buildLoadBody(period: string, pageSize: number = LOAD_MAX_RESULT) {
  return {
    filterList: [
      // The openapi entity endpoint deserializes each sequence `value` as a STRING, so the
      // period filter must be a JSON-stringified object, not a raw object (an object value
      // returns HTTP 400 "Cannot deserialize ... from Object value"). Verified live.
      { sequence: 1, value: JSON.stringify({ period }) },
      { sequence: 2, value: '-1' },
      { sequence: 3, value: '-1' },
      { sequence: 4, value: '-1' },
      { sequence: 5, value: '-1' },
    ],
    listDefId: '', customListDefId: LOAD_LISTDEF, userDefaultFilter: false,
    currentPageSize: 0, canDelete: false, canEdit: false, canShow: false, canSelect: true,
    page: 1, maxResult: pageSize, defaultSize: pageSize, filterArgsJson: {}, filterValues: [],
  };
}

/**
 * ONE load on the day's roster — the shape every hop of the roster path passes along.
 *
 * Named rather than repeated inline (it was spelled out identically in four signatures) so a
 * field added here cannot reach three of them and miss the fourth.
 */
export interface RosterLoad {
  loadId: string;
  name: string;
  loadNbr: string | null;
  status: string;
  /**
   * WHO NUVIZZ ALREADY SAYS IS DRIVING THIS LOAD. '' when the load is genuinely unassigned.
   *
   * Chad, looking at the portal's own Loads grid beside our board: "Our roster scan shows who
   * the driver is for the load, why are we not using that? The loads are not dispatched but
   * they do already have the driver assignment."
   *
   * He is right and the waste was total. This roster pull IS that grid — the same saved search
   * (PkgRoute, customListDefId 35833), the same rows, already paid for — and its Driver Name
   * column arrived in every response we have ever made. normalizeLoads read five columns and
   * dropped it on the floor, so the board rebuilt "who is driving this" out of STOP data only.
   * A load with no stops yet (the empty trailers that are most of a Draft morning) therefore
   * showed a blank driver, and an empty shell that genuinely has NOBODY on it looked exactly
   * like the fifty that do. The one row a dispatcher needs to find was indistinguishable from
   * the noise. Keeping this field costs ZERO additional NuVizz calls — it is a parse change on
   * bytes already on the wire.
   */
  driver: string;
  trips: number | null;
}

// The Loads grid renders its driver cell as an EDITABLE control, and an unassigned load's cell
// shows the widget's own prompt. That prompt is presentation, never data: a row whose driver
// reads "Enter driver name" is a load with NO driver, and letting the string through would put
// it on the board as a person's name and — worse — make an unassigned load look assigned, which
// is the exact row a dispatcher is scanning for.
const DRIVER_PLACEHOLDER = /^(enter\s+driver\s+name|select\s+driver|unassigned|none|n\/a|-{1,2})$/i;

// Columns that cannot be a driver's NAME whatever they contain, so they are refused by their
// KEY. Note what is NOT here: anything id-shaped.
//
// v1.10.0 shipped this list with `driverid` and `\bid\b` in it, and that one decision made the
// whole feature inert on Davis's actual grid. The real column, read back out of the stored
// 2026-09-02 column dump at zero cost:
//
//     key 'driver.driverId'   label 'Driver Name'   values 'Brent Dixon', 'Trevor Seyers', …
//
// NuVizz keys the driver's NAME under `driverId`. The avoid-list matched `driverid`, the column
// was refused before anything looked at it, and every one of the 105 rows parsed perfectly with
// an empty driver — `kept: 105, drivers: 0`, which is precisely the reading the pull meta exists
// to make visible.
//
// The repo already knew. nuvizz-list.mts has read `route.driver.driverId` as a NAME candidate
// since #254 ("in some saved searches route.driver.driverId carries the human name") and judges
// it with firstNonHashName — BY VALUE. Excluding id-ish columns by NAME was me re-deciding, from
// first principles, a question this codebase had already answered from a live board.
//
// The tokens that remain are the ones no value guard can catch: a "Driver Status" of ON_DUTY or a
// "Driver Phone" is a perfectly plausible-looking string, and cleanDriverName would hand it to
// the board as a person's name.
const DRIVER_AVOID = /(phone|email|mobile|dttm|date|time|count|nbr|number|status)/;

// PURE: what a driver column's raw value is worth as a NAME. '' means "no driver", and every
// rejection here is a bug this repo has already paid for once:
//   • the widget placeholder above — an unassigned load must never read as assigned;
//   • a bare driverId (#254 put an ObjectId on the board's Driver cell as "jibberish");
//   • a load number, if the column we picked turns out to be mislabelled.
// Exported so the rules are pinned by tests rather than by the caller that happens to use them.
export function cleanDriverName(v: any): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (DRIVER_PLACEHOLDER.test(s)) return '';
  if (isHashLikeId(s)) return '';
  if (looksLikeLoadNbr(s)) return '';
  return s;
}

// PURE: map the load-list response (filterData column-defs + values rows) → load rows
// { loadId, name, loadNbr, status, driver, trips }. Columns are found BY PATTERN against BOTH the dotted
// key AND the human column label (robust to layout/key differences between the portal grid and
// the openapi entity response). Exported for tests.
export function normalizeLoads(j: any): RosterLoad[] {
  const colDefs: Record<string, any> = (j && j.filterData && j.filterData[0]) || {};
  const cols: string[] = Object.keys(colDefs);
  if (!cols.length) return [];
  // Match on "key + column label" so a column keyed by an opaque path but LABELLED "Load Number"
  // still resolves (the loads grid keys the number column differently from the stops grid).
  const colHay = (k: string) => `${k} ${String(colDefs[k]?.columnName ?? '')}`.toLowerCase();
  const find = (re: RegExp, avoid?: RegExp) => cols.find((k) => re.test(colHay(k)) && (!avoid || !avoid.test(colHay(k))));
  const idIx = cols.indexOf('KeyColumn') >= 0 ? cols.indexOf('KeyColumn')
    : cols.indexOf(find(/loadid/) ?? find(/(^|\.|\s)key/) ?? cols[0]);
  // The NUMERIC load number ("DAVIS000198197") is a DISTINCT column from the human route name
  // ("SUW"). load/info is keyed by this number, so capture it separately — the old code conflated
  // the two and dropped the number entirely, which broke reorder/unplan on any load the client
  // knew only by name (#329 follow-up). Route NAME excludes any "number"/"no" token so the two
  // never cross-match.
  const nbrIx = cols.indexOf(find(/load.?(nbr|number|num\b)|(^|\s)load.?no(\.|\s|$)/) ?? '');
  // ROUTE NAME. The avoid-list gained `driver` the day the driver column started being read, and
  // it is not defensive padding: tier 2 matches a bare ".name", and `route.driver.name` ends in
  // exactly that. On a saved search that labels no column "Load Name", the route name would have
  // quietly become the DRIVER's name — every load on the board relabelled with the person on it.
  const nameIx = cols.indexOf(find(/route.?name|load.?name/, /(nbr|number|num\b|driver)/) ?? find(/(^|\s|\.)name/, /(nbr|number|num\b|driver)/) ?? '');
  // `driver` joins this avoid-list for the same reason it joined the route name's: a column
  // labelled "Driver Status" matches /status/, and if it sorts earlier in Object.keys it wins
  // statusIx — putting the DRIVER's status where the LOAD's belongs, which then decides whether
  // the load reads Draft or Dispatched on the board.
  const statusIx = cols.indexOf(find(/status/, /dttm|date|time|driver/) ?? '');
  const tripsIx = cols.indexOf(find(/trip|stop.?count|nooftrip/) ?? '');
  // DRIVER: the grid's "Driver Name" column, matched in two tiers so the NAME column wins over
  // an id/contact column that also carries the word driver (route.driver.driverId is a real
  // column on some saved searches, and #254 is what showing it costs). Tier 1 wants a
  // driver+name-ish column; tier 2 takes any driver column that is not plainly an id, a
  // contact detail or a timestamp. Whichever tier answers, the VALUE still has to survive
  // cleanDriverName — the column choice is a preference, the value guard is the rule.
  // DRIVER: every column that could carry one, best-labelled first — and the VALUE decides which
  // of them actually speaks. A single up-front pick is what shipped broken: it had to be right
  // about the column's NAME before any data was consulted, and on this grid the name lies.
  // firstNonHashName has resolved the identical problem on the stop list since #254; this is the
  // same rule, over columns instead of fixed keys.
  const driverIxs = cols
    .filter((k) => /driver/.test(colHay(k)) && !DRIVER_AVOID.test(colHay(k)))
    // A column that says "name" is asked first; the rest are fallbacks, in grid order.
    .sort((a, b) => Number(/name/.test(colHay(b))) - Number(/name/.test(colHay(a))))
    .map((k) => cols.indexOf(k))
    .filter((i) => i >= 0 && i !== idIx);
  const out: RosterLoad[] = [];
  for (const row of ((j && j.values) || [])) {
    const loadId = String(linkVal(row[idIx]) ?? '').trim();
    if (!loadId) continue;
    const t = Number(linkVal(row[tripsIx]));
    // Load NUMBER: the labelled column if its value looks like a load number; else scan the whole
    // row for the unmistakable DAVIS000…-shaped value (never the loadId). Guarantees we grab the
    // number whenever the scan returns it, no matter which column carries it.
    let loadNbr = nbrIx >= 0 ? String(linkVal(row[nbrIx]) ?? '').trim() : '';
    if (!looksLikeLoadNbr(loadNbr)) {
      loadNbr = '';
      for (let i = 0; i < row.length; i++) {
        if (i === idIx) continue;
        const v = String(linkVal(row[i]) ?? '').trim();
        if (v !== loadId && looksLikeLoadNbr(v)) { loadNbr = v; break; }
      }
    }
    // Display NAME: the human route name. Exclude the loadId (hash) AND the load-number value so
    // the name never becomes a bare ObjectId (#254) or the raw number.
    let name = '';
    for (const ix of [nameIx, nbrIx]) {
      if (ix < 0) continue;
      const v = String(linkVal(row[ix]) ?? '').trim();
      if (v && !isHashLikeId(v) && !looksLikeLoadNbr(v)) { name = v; break; }
    }
    // DRIVER: read ONLY from the resolved driver column, never scanned for by value shape the
    // way the load number is. A load number is unmistakable ("DAVIS000198197"); a human name is
    // not, and a row-wide hunt would happily return the route name ("SHEATS") or a status word
    // and call it the driver. When the column is absent the honest answer is "we do not know",
    // which is '' — the same thing the board showed before this field existed.
    let driver = '';
    for (const ix of driverIxs) {
      const v = cleanDriverName(linkVal(row[ix]));
      if (v) { driver = v; break; }
    }
    out.push({
      loadId,
      name,
      loadNbr: loadNbr || null,
      status: String(linkVal(row[statusIx]) ?? '').trim(),
      driver,
      trips: Number.isFinite(t) ? t : null,
    });
  }
  return out;
}

// ── May a CACHED roster answer this read, or must it cost a NuVizz call? (PURE) ─────
//
// The old rule was `cached.loads.length` — a cache with rows is served, anything else goes
// live. That threw away the one answer it most needed to keep. A day the vendor genuinely
// reports NO loads for produced an empty doc, which failed the test, so every read went live;
// the live pull then wrote another empty doc, which failed it again. It never converged. With
// five fetch sites for this endpoint in the client — the Map screen's Routes panel, the
// Routing rail, the bottom grid and two refresh controls, several re-firing on ordinary UI
// state — one such day turned every panel toggle into a metered PkgRoute call. Chad, having
// counted them: "each refresh is causing like 14 calls when it should only be 3 or 4."
//
// The distinction the old rule was reaching for is real and is kept, but it lives in the
// doc's EXISTENCE, not its length:
//   • no doc at all      → nobody has ever asked for this day. Go live. (Absent is not zero.)
//   • rows               → serve it, whatever its age. Stale beats spending a call on every
//                          read; the surfaces label the age and carry a Refresh.
//   • empty, from today  → this scan day's answer IS "none". Serve it, free.
//   • empty, from before → stale AND empty. Worth one call to find out if that changed.
//
// `etDay` is injected rather than imported so this stays pure and clock-testable.
/**
 * MAY A CACHED ROSTER ANSWER THIS READ, OR MUST IT COST A NUVIZZ CALL? (PURE)
 *
 * Chad, 2026-09-06: "The roster for future dates only needs to be called once a day as they
 * will not change." So a capture taken THIS ET day is this day's answer, full stop — empty or
 * not — and the panels serve it without spending anything. The one way to re-ask inside the
 * day is the manual Scan, which always pulls. (A bound that re-asked an empty capture every
 * hour was committed and reverted the same afternoon; it was July's freshness put back, and
 * July's freshness is not what he wants.)
 *
 * The distinction that stays is EXISTENCE, not length:
 *   • no doc at all      → nobody has ever asked for this day. Go live once. (Absent is not zero.)
 *   • rows               → serve, whatever the age; the surfaces label how old it is.
 *   • empty, from today  → this scan day's answer IS "none". Serve it, free.
 *   • empty, from before → stale AND empty: nobody has asked today. Go live once.
 *
 * `etDayOf` is injected so this stays pure and clock-testable.
 */
export function shouldServeCachedRoster(
  cached: { at?: string | null; loads?: any[] } | null | undefined,
  etDayOf: (d: Date) => string,
  now: Date = new Date(),
): boolean {
  if (!cached) return false;
  if ((cached.loads?.length ?? 0) > 0) return true;
  // The stamp is checked BEFORE it is trusted: `new Date(null)` is the epoch — a valid Date
  // that would read as captured in 1969 — and Intl throws outright on an unparseable one.
  // Either way an unreadable stamp means "not today", never an exception.
  if (!cached.at) return false;
  const at = new Date(cached.at);
  if (!Number.isFinite(at.getTime())) return false;
  try { return etDayOf(at) === etDayOf(now); } catch { return false; }
}

// A board stop's load identity, when known (enriched stops carry raw.load.loadId; the
// bare list rows do not). null when the stop has no load id yet.
export function stopLoadId(s: any): string | null {
  const id = s?.raw?.load?.loadId ?? s?.loadId ?? null;
  return id ? String(id) : null;
}

// PURE: drop board stops that carry a loadId NOT in today's load-id set (a prior-day
// instance of a recurring route that bled in). Stops with NO loadId are kept (today's
// fresh list rows have none yet — we never drop on absence). If the set is empty
// (load list unavailable) this is a NO-OP, so a load-list failure can't harm the board.
// `onlyPriorTo` (the board date) restricts drops to stops whose own day is BEFORE today,
// so a today stop whose id is momentarily missing from the list is never dropped.
// Exported for tests.
export function dropForeignLoadStops(stops: any[], todayLoadIds: Set<string>, onlyPriorTo?: string): any[] {
  if (!todayLoadIds || todayLoadIds.size === 0) return stops;
  return stops.filter((s) => {
    const id = stopLoadId(s);
    if (!id || todayLoadIds.has(id)) return true;               // no id, or a known today load → keep
    if (onlyPriorTo) {
      const own = s.boardDate || s.requestedDate || s.scheduledDate;
      if (!(own && own < onlyPriorTo)) return true;             // not provably a prior-day stop → keep
    }
    return false;                                               // foreign load id on a prior-day stop → drop
  });
}

// Fetch today's (period-relative) load roster and return the set of its loadIds plus a
// little metadata for logging. Best-effort: throws are the caller's to swallow.
export async function loadIdsForDate(targetDateUTC: string): Promise<{ ids: Set<string>; count: number; cols: number }> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = `${OPENAPI_BASE}/entity/filterdata/${LOAD_ENTITY}/${companyCode}`;
  const body = JSON.stringify(buildLoadBody(periodForDate(targetDateUTC)));
  const resp = await getNuvizzRequester().request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata(load)', tenant: companyCode });
  if (!resp.ok) throw new Error(`load list filterdata ${resp.status}`);
  const j: any = await resp.json();
  const rows = normalizeLoads(j);
  return { ids: new Set(rows.map((r) => r.loadId)), count: rows.length, cols: Object.keys((j && j.filterData && j.filterData[0]) || {}).length };
}

// Fetch the FULL load roster for a date (every load incl. empty ones, with status + trip
// count) — used to surface loads that have NO orders assigned yet (a Monday load created
// but unfilled never appears on the stop-grouped board). One deliberate call; best-effort.
export async function loadRosterForDate(targetDateUTC: string): Promise<RosterLoad[]> {
  return (await loadRosterPull(targetDateUTC)).loads;
}

/**
 * What ONE roster pull actually saw, beside what it kept — the numbers that would have ended
 * two days of guessing in the first reply.
 *
 * Chad, Sunday 11:37, board on Tue Sep 8, after a manual scan: "Load roster: 0 loads · cached
 * just now". From outside the system that sentence has three different causes and they are
 * pixel-identical: the vendor answered ZERO ROWS for that period; the vendor answered rows and
 * normalizeLoads kept NONE (no filterData column defs → [] with no throw, or an id column the
 * patterns do not match); or the period string asked NuVizz for a day other than the one on
 * screen. Nothing on this path recorded which. `[scan] load-roster 2026-09-08: empty answer over
 * an empty/absent cache` is a true sentence about the WRITE and says nothing about the PULL.
 *
 * So the pull now reports itself: the period it sent, the HTTP status, how many column defs
 * and rows came back, and how many rows survived normalisation. It is logged on every pull
 * (the Netlify function log answers "vendor 0 or parser 0" for any date, forever, at zero
 * cost) and stored beside the roster so ?explain=1 can show it without a call. CLAUDE.md: build
 * the free diagnostic first.
 */
export interface RosterPullMeta {
  period: string; httpStatus: number; cols: number; rows: number; kept: number;
  /**
   * How many kept rows carry a driver. The point is the ZERO case: `kept: 106, drivers: 0` is
   * the saved search having lost its Driver Name column, and without this number that failure
   * is invisible — the board would simply show a hundred staffed trailers as unassigned and
   * look no different from a genuinely quiet morning. Same reasoning as `kept` itself, which
   * exists because "the vendor said none" and "the parser kept none" were the same blank
   * screen for three rounds. Absent on documents written before v1.7.0.
   */
  drivers: number;
}
export async function loadRosterPull(targetDateUTC: string): Promise<{
  loads: RosterLoad[];
  pull: RosterPullMeta;
}> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = `${OPENAPI_BASE}/entity/filterdata/${LOAD_ENTITY}/${companyCode}`;
  const period = periodForDate(targetDateUTC);
  const body = JSON.stringify(buildLoadBody(period));
  const resp = await getNuvizzRequester().request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata(roster)', tenant: companyCode });
  if (!resp.ok) throw new Error(`load roster filterdata ${resp.status}`);
  const j: any = await resp.json();
  const cols = Object.keys((j && j.filterData && j.filterData[0]) || {}).length;
  const rows = Array.isArray(j?.values) ? j.values.length : 0;
  const loads = normalizeLoads(j);
  const drivers = loads.filter((l) => l.driver).length;
  const pull: RosterPullMeta = { period, httpStatus: resp.status, cols, rows, kept: loads.length, drivers };
  // One line per pull, and it names the date AND the period so a reader can see with their own
  // eyes whether "+2d" is the day the dispatcher had on screen.
  console.log(`[roster] ${targetDateUTC} period=${period} http=${resp.status} cols=${cols} rows=${rows} kept=${loads.length} drivers=${drivers}`
    + (rows > 0 && loads.length === 0 ? ' ← ROWS CAME BACK AND THE PARSER KEPT NONE' : '')
    + (cols === 0 ? ' ← NO COLUMN DEFS: not the grid shape the code expects' : '')
    + (loads.length > 0 && drivers === 0 ? ' ← NOT ONE LOAD CARRIES A DRIVER: the saved search has probably lost its Driver Name column' : ''));
  return { loads, pull };
}
