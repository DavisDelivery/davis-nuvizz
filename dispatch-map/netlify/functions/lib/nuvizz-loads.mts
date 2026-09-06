// lib/nuvizz-loads.mts
//
// The NuVizz LOAD list (PkgRoute filterdata) — the portal's "Loads" grid. Each row
// carries the load's UNIQUE per-day loadId (the recurring routes share a NAME, e.g.
// "BEN 2", every day, but each day's instance gets its OWN loadId), plus the route
// name, status, driver and trip (stop) count.
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
import { OPENAPI_BASE, linkVal, periodForDate, isHashLikeId } from './nuvizz-list.mts';

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

// A NuVizz load NUMBER looks like the company code + zero-padded digits ("DAVIS000198197")
// or (some tenants) a long bare number — NEVER the internal hex loadId (interspersed hex) and
// NEVER a short human route name ("SUW"). Distinctive enough to VALIDATE a labelled column and,
// if the column is mislabelled/absent, to FIND the number anywhere in the row — so "the loads
// scan produces the number, just grab it" holds regardless of the saved-search column naming.
export function looksLikeLoadNbr(v: any): boolean {
  const s = String(v ?? '').trim();
  return /^[A-Za-z]{2,}\d{5,}$/.test(s) || /^\d{6,}$/.test(s);
}

// PURE: map the load-list response (filterData column-defs + values rows) → load rows
// { loadId, name, loadNbr, status, trips }. Columns are found BY PATTERN against BOTH the dotted
// key AND the human column label (robust to layout/key differences between the portal grid and
// the openapi entity response). Exported for tests.
export function normalizeLoads(j: any): Array<{ loadId: string; name: string; loadNbr: string | null; status: string; trips: number | null }> {
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
  const nameIx = cols.indexOf(find(/route.?name|load.?name/, /(nbr|number|num\b)/) ?? find(/(^|\s|\.)name/, /(nbr|number|num\b)/) ?? '');
  const statusIx = cols.indexOf(find(/status/, /dttm|date|time/) ?? '');
  const tripsIx = cols.indexOf(find(/trip|stop.?count|nooftrip/) ?? '');
  const out: Array<{ loadId: string; name: string; loadNbr: string | null; status: string; trips: number | null }> = [];
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
    out.push({
      loadId,
      name,
      loadNbr: loadNbr || null,
      status: String(linkVal(row[statusIx]) ?? '').trim(),
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
 * JULY'S FRESHNESS, BOUNDED. Chad: "6 weeks ago there was no issue with the loads screen and
 * roster scans." Checked against v0.52.4 (2026-07-26): the endpoint then served a cache only
 * when it held rows and went LIVE on every other open — so a dispatcher opening Tuesday on a
 * Sunday got NuVizz's answer as of that moment, every time, at up to three calls an open. The
 * v0.93.5 rule closed that amplification and, in the same stroke, froze an empty capture for
 * the rest of the ET day: after the 11:37 manual scan wrote "0 loads", every open until
 * midnight showed 0 without asking again. Freshness he had was traded for calls.
 *
 * The bound puts it back without the bill: an empty capture is this scan day's answer for ONE
 * roster interval — the same 60 minutes the scan plan gives the roster (asserted equal in the
 * tests, so the two cannot drift) — and then one live re-ask, re-cached. While a day stays
 * empty that is at most one call an hour per date, three at worst if the client's fetch sites
 * race on the same open; July spent three on EVERY open. NUVIZZ_ROSTER_AUTO_LIVE=0 still
 * refuses every automatic call; this only decides what the cache may answer.
 */
export const ROSTER_EMPTY_RECHECK_MIN = 60;
export function shouldServeCachedRoster(
  cached: { at?: string | null; loads?: any[] } | null | undefined,
  etDayOf: (d: Date) => string,
  now: Date = new Date(),
  emptyMaxAgeMs: number = ROSTER_EMPTY_RECHECK_MIN * 60_000,
): boolean {
  if (!cached) return false;
  if ((cached.loads?.length ?? 0) > 0) return true;
  // The stamp is checked BEFORE it is trusted: `new Date(null)` is the epoch — a valid Date
  // that would read as captured in 1969 — and Intl throws outright on an unparseable one.
  // Either way an unreadable stamp means "not today", never an exception.
  if (!cached.at) return false;
  const at = new Date(cached.at);
  if (!Number.isFinite(at.getTime())) return false;
  let sameDay = false;
  try { sameDay = etDayOf(at) === etDayOf(now); } catch { return false; }
  if (!sameDay) return false;
  return (now.getTime() - at.getTime()) < emptyMaxAgeMs;
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
export async function loadRosterForDate(targetDateUTC: string): Promise<Array<{ loadId: string; name: string; loadNbr: string | null; status: string; trips: number | null }>> {
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
export interface RosterPullMeta { period: string; httpStatus: number; cols: number; rows: number; kept: number }
export async function loadRosterPull(targetDateUTC: string): Promise<{
  loads: Array<{ loadId: string; name: string; loadNbr: string | null; status: string; trips: number | null }>;
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
  const pull: RosterPullMeta = { period, httpStatus: resp.status, cols, rows, kept: loads.length };
  // One line per pull, and it names the date AND the period so a reader can see with their own
  // eyes whether "+2d" is the day the dispatcher had on screen.
  console.log(`[roster] ${targetDateUTC} period=${period} http=${resp.status} cols=${cols} rows=${rows} kept=${loads.length}`
    + (rows > 0 && loads.length === 0 ? ' ← ROWS CAME BACK AND THE PARSER KEPT NONE' : '')
    + (cols === 0 ? ' ← NO COLUMN DEFS: not the grid shape the code expects' : ''));
  return { loads, pull };
}
