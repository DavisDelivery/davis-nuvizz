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
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = `${OPENAPI_BASE}/entity/filterdata/${LOAD_ENTITY}/${companyCode}`;
  const body = JSON.stringify(buildLoadBody(periodForDate(targetDateUTC)));
  const resp = await getNuvizzRequester().request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata(roster)', tenant: companyCode });
  if (!resp.ok) throw new Error(`load roster filterdata ${resp.status}`);
  return normalizeLoads(await resp.json());
}

// DIAGNOSTIC: the RAW openapi PkgRoute response — every column key + its human label, plus a few
// sample rows (link-objects unwrapped). Lets us see EXACTLY which columns entity/filterdata returns
// for our list-def (which differs from the portal's Export), so we can wire loadNbr correctly.
export async function rawLoadListForDate(targetDateUTC: string, sampleN = 3): Promise<any> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = `${OPENAPI_BASE}/entity/filterdata/${LOAD_ENTITY}/${companyCode}`;
  const body = JSON.stringify(buildLoadBody(periodForDate(targetDateUTC)));
  const resp = await getNuvizzRequester().request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata(rawdump)', tenant: companyCode });
  const j: any = await resp.json().catch(() => ({}));
  const colDefs: Record<string, any> = (j && j.filterData && j.filterData[0]) || {};
  const cols = Object.keys(colDefs);
  const columns = cols.map((k) => ({ key: k, label: colDefs[k]?.columnName ?? null }));
  const values: any[] = Array.isArray(j?.values) ? j.values : [];
  const samples = values.slice(0, sampleN).map((row: any[]) => row.map((cell) => linkVal(cell)));

  // PROBE: does the PORTAL /deliverit/filterdata endpoint (the one whose response includes the
  // rteNbr = "Load Number" column, per the HAR) accept our server-side Basic auth? If so we can
  // switch the scan to it and get the number for free. Multipart form, raw-object filter values.
  let portal: any = null;
  try {
    const portalUrl = `${OPENAPI_BASE.replace(/\/openapi$/, '')}/filterdata`;
    const b = buildLoadBody(periodForDate(targetDateUTC));
    const bd = '----ddFormBoundary' + LOAD_LISTDEF;
    const fields: Record<string, string> = {
      filterList: JSON.stringify(b.filterList.map((f: any) => ({ sequence: f.sequence, value: f.sequence === 1 ? { period: periodForDate(targetDateUTC) } : -1 }))),
      listDefId: '', customListDefId: String(LOAD_LISTDEF), userDefaultFilter: 'false',
      currentPageSize: '0', canDelete: 'false', canEdit: 'false', canShow: 'false', canSelect: 'true',
      page: '1', maxResult: '5', defaultSize: '5', filterArgsJson: '{}', filterValues: '[]',
    };
    const mp = Object.entries(fields).map(([k, v]) => `--${bd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`).join('\r\n') + `\r\n--${bd}--\r\n`;
    const pr = await getNuvizzRequester().request(portalUrl, { method: 'POST', headers: { Authorization: basicAuthHeader(), Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${bd}` }, body: mp }, { route: '/filterdata(portal-probe)', tenant: companyCode });
    const pj: any = await pr.json().catch(() => ({}));
    const pdefs: Record<string, any> = (pj && pj.filterData && pj.filterData[0]) || {};
    const pcols = Object.keys(pdefs);
    portal = { url: portalUrl, httpStatus: pr.status, columnCount: pcols.length, columns: pcols.map((k) => ({ key: k, label: pdefs[k]?.columnName ?? null })), hasRteNbr: pcols.some((k) => /rtenbr|load.?(nbr|number)/i.test(`${k} ${pdefs[k]?.columnName ?? ''}`)) };
  } catch (e: any) { portal = { error: e?.message || 'portal probe failed' }; }

  return { openapi: { httpStatus: resp.status, listDefId: LOAD_LISTDEF, entity: LOAD_ENTITY, columnCount: cols.length, columns, rowCount: values.length, samples }, portal };
}
