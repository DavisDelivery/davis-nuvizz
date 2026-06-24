// lib/nuvizz-list.mts
//
// The NuVizz "stop list" (VizzonStop filterdata) — the same list the portal UI
// renders, reachable with the Basic creds we already use. This is the single source
// of list logic shared by:
//   • the interactive explorer endpoint (nuvizz-stop-explorer.mts), and
//   • the scheduled scanner's list-discovery path (refresh-stops-core), which uses
//     it as the PRIMARY source instead of number-probing /load/info & /stop/info.
//
// What it provides: which stops exist for a delivery-date window, status, load
// membership, address, special instructions. What it lacks (filled elsewhere):
// lat/lng (geocoded — see lib/geocode.mts) and per-line freight detail.

import { getNuvizzRequester } from './nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './nuvizz-scan.mts';
import { etDayString } from './firestore.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
export const OPENAPI_BASE = NUVIZZ_BASE.replace(/\/v7\/?$/, ''); // → .../deliverit/openapi
const STOP_LISTDEF = Number(process.env.NUVIZZ_STOP_LISTDEF) || 35824; // saved stop-list columns

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Some columns arrive as a JSON "link" object string carrying the real value.
export function linkVal(x: any): any {
  if (typeof x === 'string' && x.startsWith('{')) {
    try { return JSON.parse(x).columnValue ?? ''; } catch { return ''; }
  }
  return x;
}
const numOrNull = (x: any) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
// Only allow the period grammar NuVizz uses (digits, d, +, -, /) so nothing odd is injected.
export const cleanPeriod = (p: any) => { const s = String(p || '0d'); return /^[+\-/0-9d]{1,8}$/.test(s) ? s : '0d'; };

export function buildBody(period: string, statusCsv: string, page: number, pageSize: number) {
  const f = (sequence: number, value: any) => ({ sequence, value });
  return {
    filterList: [
      f(1, '-1'), f(2, statusCsv || '-1'), f(3, '-1'), f(4, '-1'), f(5, '-1'),
      f(6, '-1'), f(7, '-1'), f(8, '-1'), f(9, '-1'),
      f(10, JSON.stringify({ period })), f(11, '-1'), f(12, JSON.stringify({ period: '' })),
    ],
    listDefId: '', customListDefId: STOP_LISTDEF, userDefaultFilter: false,
    currentPageSize: 0, canDelete: false, canEdit: false, canShow: false, canSelect: true,
    page, maxResult: pageSize, defaultSize: pageSize, filterArgsJson: {}, filterValues: [],
  };
}

// Map the column-def order (filterData[0]) onto each values[] row, pulling fields BY
// KEY (robust to column reordering) into an intermediate row object.
export function normalize(j: any): any[] {
  const cols = Object.keys((j && j.filterData && j.filterData[0]) || {});
  const idx: Record<string, number> = {};
  cols.forEach((k, i) => { idx[k] = i; });
  const g = (row: any[], key: string) => (idx[key] != null ? row[idx[key]] : undefined);
  // The portal's "Stop Updated Dttm" column — found by PATTERN, not a hardcoded key (the
  // dotted key varies by saved list def). Prefer a stop/shipment-scoped update column so an
  // unrelated "updatedBy/updatedOn" never wins; require an update token + a date/time token.
  const updatedKey =
    cols.find((k) => /updat/i.test(k) && /(dttm|date|time)/i.test(k) && /stop|shipment|vizzon/i.test(k)) ||
    cols.find((k) => /updat/i.test(k) && /(dttm|date|time)/i.test(k)) || null;
  return ((j && j.values) || []).map((row: any[]) => ({
    stopNbr: String(linkVal(g(row, 'vizzonInfo.shipmentInfo.stopNbr')) ?? ''),
    statusCode: String(g(row, 'default_vizzonInfo.shipmentInfo.status') ?? ''),
    statusText: g(row, 'vizzonInfo.shipmentInfo.status') ?? '',
    businessName: g(row, 'vizzonInfo.destination.address.name') ?? '',
    addr1: g(row, 'vizzonInfo.destination.address.line1') ?? '',
    addr2: g(row, 'vizzonInfo.destination.address.line2') ?? '',
    city: g(row, 'vizzonInfo.destination.address.city') ?? '',
    zip: g(row, 'vizzonInfo.destination.address.zipCode') ?? '',
    routeName: g(row, 'route.name') ?? '',
    driverName: g(row, 'route.driver.driverId') ?? '',
    cartons: numOrNull(g(row, 'vizzonInfo.shipmentInfo.cartons')),
    weight: numOrNull(g(row, 'vizzonInfo.shipmentInfo.weight')),
    proNbr: g(row, 'vizzonInfo.shipmentInfo.proNbr') ?? '',
    scheduledArrival: g(row, 'vizzonInfo.destination.earliestSchTime') ?? '',
    createdTime: g(row, 'vizzonInfo.createdTime') ?? '',
    updatedTime: updatedKey ? String(linkVal(g(row, updatedKey)) ?? '') : '',
    comments: g(row, 'comments.commentList.commentText') ?? '',
  }));
}

// NuVizz stop-status code → our board status + planned flag. (10=Un-Planned,
// 20=Planned, 40=In-Transit, 50=Arrived, 90/91=Completed, 99=Cancelled.)
export function statusFromCode(code: any, hasRoute: boolean): { status: string; planned: boolean } {
  switch (String(code)) {
    case '10': return { status: 'UNPLANNED', planned: false };
    case '20': return { status: 'SCHEDULED', planned: true };
    case '40': return { status: 'OUT_FOR_DEL', planned: true };
    case '50': return { status: 'ARRIVED', planned: true };
    case '90': case '91': return { status: 'DELIVERED', planned: true };
    case '99': return { status: 'EXCEPTION', planned: hasRoute };
    default: return hasRoute ? { status: 'SCHEDULED', planned: true } : { status: 'UNPLANNED', planned: false };
  }
}

// Parse NuVizz's "M/D/YY h:mm AM" arrival into { date:'YYYY-MM-DD', iso } (local —
// used for date bucketing + route ordering, not absolute-tz math). Null if unparseable.
export function parseSchedDate(s: any): { date: string; iso: string } | null {
  const m = String(s || '').match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let mo = +m[1], d = +m[2], y = +m[3], hh = +m[4]; const mm = +m[5]; const ap = m[6] && m[6].toUpperCase();
  if (y < 100) y += 2000;
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { date, iso: `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00` };
}

// Intermediate row → board-shaped stop (coords filled later). routeName doubles as
// the load id since the list carries the load NAME, not the numeric loadNbr.
export function toBoardStop(r: any): any {
  const hasRoute = !!String(r.routeName || '').trim();
  const { status, planned } = statusFromCode(r.statusCode, hasRoute);
  const sched = parseSchedDate(r.scheduledArrival);
  const upd = parseSchedDate(r.updatedTime);
  return {
    stopNbr: r.stopNbr || null,
    loadNbr: hasRoute ? r.routeName : null,
    routeName: r.routeName || null,
    stopType: 'DO',
    status: r.statusCode || null,
    businessName: r.businessName || null,
    addr1: r.addr1 || null,
    addr2: r.addr2 || null,
    city: r.city || null,
    state: null,
    zip: r.zip || null,
    lat: null,
    lng: null,
    cartons: r.cartons,
    weight: r.weight,
    driverName: r.driverName || null,
    driverUserName: r.driverName || null,
    isPlanned: planned,
    isUnplanned: !planned,
    normalizedStatus: status,
    plannedEtaDTTM: sched ? sched.iso : null, // drives the planned-route stop ordering
    scheduledFrom: sched ? sched.iso : null,
    scheduledTo: null,
    orderInstructions: r.comments || null,
    proNbr: r.proNbr || null,
    scheduledDate: sched ? sched.date : null,
    // "Stop Updated Dttm" from the list — when the order last changed (status flips incl.
    // planned→unplanned→planned, edits, delivery). A LIVE field: refreshed every scan, free,
    // no /stop/info call. Drives the "last updated" display + signals when detail is stale.
    listUpdatedDTTM: upd ? upd.iso : (r.updatedTime || null),
    source: 'nuvizz-list',
  };
}

// Group board stops by their scheduled delivery date (YYYY-MM-DD).
export function bucketByDate(stops: any[]): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const s of stops) {
    const d = s.scheduledDate;
    if (!d) continue;
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(s);
  }
  return m;
}

// ── Live pull ────────────────────────────────────────────────────────────────

// The entity endpoint's `page` param does NOT paginate (it returns page 1 every
// time), so we pull a whole day in ONE request with a high maxResult. Davis runs
// ~700 stops/day; 5000 is ample headroom (and the response was uncapped at 2000).
export const LIST_MAX_RESULT = Number(process.env.NUVIZZ_LIST_MAX_RESULT) || 5000;
// Status codes to include (seq 2). Default '-1' = all, so the board shows delivered
// /cancelled stops like the number-probe does — per-day scoping keeps OTHER days'
// completed out. Env-overridable to e.g. '10,20,40,50' (active only).
export const LIST_STATUS = process.env.NUVIZZ_LIST_STATUS || '-1';

// Period string for a target UTC date relative to NuVizz's ET "today". Handles the
// ET/UTC drift: at ~10pm ET the UTC date is already +1, so todayUTC → "+1d"; during
// the ET day they align → "0d". Mirrors how the scanner keys docs by UTC date while
// NuVizz's period filter is ET-relative.
export function periodForDate(targetDateUTC: string, etToday: string = etDayString()): string {
  const off = Math.round((Date.parse(targetDateUTC + 'T00:00:00Z') - Date.parse(etToday + 'T00:00:00Z')) / 86400000);
  return off === 0 ? '0d' : (off > 0 ? `+${off}d` : `${off}d`);
}

// Pull all stops for a single Estimated-Arrival day (one request). Rides the shared
// requester so calls count in the dashboard + honor the breaker.
export async function fetchListRows(period: string, statusCsv: string = LIST_STATUS): Promise<any[]> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const url = `${OPENAPI_BASE}/entity/filterdata/VizzonStop/${companyCode}`;
  const body = JSON.stringify(buildBody(cleanPeriod(period), statusCsv || '-1', 1, LIST_MAX_RESULT));
  const resp = await reqr.request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata', tenant: companyCode });
  if (!resp.ok) throw new Error(`list filterdata ${resp.status}`);
  return normalize(await resp.json());
}

// Board stops for a specific target UTC date (the doc key the scanner writes). The
// period is ET-adjusted so it matches the number-probe's "today" board.
export async function listScanForDate(targetDateUTC: string): Promise<any[]> {
  const stops = fromRows(await fetchListRows(periodForDate(targetDateUTC)));
  for (const s of stops) s.scheduledDate = targetDateUTC; // authoritative: we queried this exact day
  return stops;
}

// Live fields the LIST owns and refreshes every scan (current planning + status);
// everything ELSE is static detail merged from enrichment (/stop/info) and carried
// forward. So an enriched stop ends up with the FULL old-path field set (PROs,
// pallets, stop sequence, terminal flag, planned distances, line items, contact,
// timestamps, …) while the list keeps status/load/driver current.
export const LIVE_LIST_FIELDS = [
  'status', 'normalizedStatus', 'isPlanned', 'isUnplanned',
  'loadNbr', 'routeName', 'driverName', 'driverUserName',
  'scheduledDate', 'listUpdatedDTTM', 'source',
];
// Copy ALL non-live fields from src (a /stop/info-normalized stop, or a prior enriched
// index doc) onto target, then mark it enriched. Never overwrites a real value with a
// null/blank, so list-derived values survive when a detail field is sparse.
export function mergeEnrich(target: any, src: any): any {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (LIVE_LIST_FIELDS.includes(k) || k === 'enriched' || k === 'last_scanned_at' || k === '_id') continue;
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    target[k] = v;
  }
  target.enriched = true;
  return target;
}

// Exposed for tests: intermediate rows → board stops (dedup by stopNbr, last wins).
export function fromRows(rows: any[]): any[] {
  const byNbr = new Map<string, any>();
  for (const r of rows) {
    const s = toBoardStop(r);
    if (s.stopNbr) byNbr.set(s.stopNbr, s);
  }
  return [...byNbr.values()];
}
