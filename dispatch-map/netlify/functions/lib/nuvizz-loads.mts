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
const LOAD_ENTITY = process.env.NUVIZZ_LOAD_ENTITY || 'PkgRoute';
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

// PURE: map the load-list response (filterData column-defs + values rows) → load rows
// { loadId, name, status, trips }. Columns are found BY PATTERN (robust to layout/key
// differences between the portal grid and the openapi entity response). Exported for tests.
export function normalizeLoads(j: any): Array<{ loadId: string; name: string; status: string; trips: number | null }> {
  const cols: string[] = Object.keys((j && j.filterData && j.filterData[0]) || {});
  if (!cols.length) return [];
  const find = (re: RegExp, avoid?: RegExp) => cols.find((k) => re.test(k) && (!avoid || !avoid.test(k)));
  const idIx = cols.indexOf('KeyColumn') >= 0 ? cols.indexOf('KeyColumn')
    : cols.indexOf(find(/loadid/i) ?? find(/(^|\.)key/i) ?? cols[0]);
  // The human recurring-load name ("BEN 2") is the load NUMBER (loadNbr); prefer it, then the
  // route-name column. loadId/KeyColumn is the internal hex id — never the display name.
  const nbrIx = cols.indexOf(find(/load.?nbr|load.?(no|num|number)/i) ?? '');
  const nameIx = cols.indexOf(find(/route.*name|(^|\.)name$/i) ?? find(/name/i) ?? '');
  const statusIx = cols.indexOf(find(/status/i, /dttm|date|time/i) ?? '');
  const tripsIx = cols.indexOf(find(/trip|stop.?count|nooftrip/i) ?? '');
  const out: Array<{ loadId: string; name: string; status: string; trips: number | null }> = [];
  for (const row of ((j && j.values) || [])) {
    const loadId = String(linkVal(row[idIx]) ?? '').trim();
    if (!loadId) continue;
    const t = Number(linkVal(row[tripsIx]));
    // First HUMAN (non-hash) name among the load-number and route-name columns; '' if none — a bare
    // NuVizz ObjectId must never become the displayed load name (#254-style guard, was missing here).
    let name = '';
    for (const ix of [nbrIx, nameIx]) {
      if (ix < 0) continue;
      const v = String(linkVal(row[ix]) ?? '').trim();
      if (v && !isHashLikeId(v)) { name = v; break; }
    }
    out.push({
      loadId,
      name,
      status: String(linkVal(row[statusIx]) ?? '').trim(),
      trips: Number.isFinite(t) ? t : null,
    });
  }
  return out;
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
export async function loadRosterForDate(targetDateUTC: string): Promise<Array<{ loadId: string; name: string; status: string; trips: number | null }>> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = `${OPENAPI_BASE}/entity/filterdata/${LOAD_ENTITY}/${companyCode}`;
  const body = JSON.stringify(buildLoadBody(periodForDate(targetDateUTC)));
  const resp = await getNuvizzRequester().request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata(roster)', tenant: companyCode });
  if (!resp.ok) throw new Error(`load roster filterdata ${resp.status}`);
  return normalizeLoads(await resp.json());
}
