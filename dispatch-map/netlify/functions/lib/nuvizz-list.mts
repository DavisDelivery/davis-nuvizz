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

export const LIST_PAGE_SIZE = Number(process.env.NUVIZZ_LIST_PAGE_SIZE) || 200;
export const LIST_MAX_PAGES = Number(process.env.NUVIZZ_LIST_MAX_PAGES) || 30;

// Pull every stop in the given Estimated-Arrival window (all statuses), paged. Rides
// the shared requester so calls count in the dashboard + honor the breaker.
export async function fetchListRows(period: string): Promise<any[]> {
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const url = `${OPENAPI_BASE}/entity/filterdata/VizzonStop/${companyCode}`;
  const all: any[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const body = JSON.stringify(buildBody(cleanPeriod(period), '-1', page, LIST_PAGE_SIZE));
    const resp = await reqr.request(url, { method: 'POST', headers: hdr, body }, { route: '/entity/filterdata', tenant: companyCode });
    if (!resp.ok) throw new Error(`list filterdata ${resp.status}`);
    const rows = normalize(await resp.json());
    all.push(...rows);
    if (rows.length < LIST_PAGE_SIZE) break;
  }
  return all;
}

// Pull the window and return board-shaped stops + a date→stops bucket map.
export async function listScanWindow(period = '+/-7d'): Promise<{ stops: any[]; byDate: Map<string, any[]> }> {
  const stops = fromRows(await fetchListRows(period));
  return { stops, byDate: bucketByDate(stops) };
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
