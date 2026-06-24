// nuvizz-stop-explorer.mts
//
// Read-only proxy for the stop list the NuVizz UI uses (the "VizzonStop" filter
// grid). Lets the in-app bottom-grid filters (delivery-date window + status) pull
// stops straight from NuVizz with the Basic credentials we ALREADY have — the same
// endpoint the portal calls, verified to accept Basic auth. This is the list NuVizz
// has but the public openapi/v7 lacks, so it sidesteps the number-space probing.
//
// POST body: { arrivalPeriod?: "0d"|"+/-7d"|..., statusCodes?: string[], page?, pageSize? }
//   arrivalPeriod → filter seq 10 (Estimated Arrival), e.g. "0d" today, "+/-7d" ±7d
//   statusCodes   → filter seq 2 (Stop Status) codes: 10=Un-Planned 20=Planned
//                   40=In-Transit 50=Arrived 90/91=Completed 99=Cancelled
// Returns { ok, total, page, pageSize, rows } with rows normalized to the grid shape.
//
// Calls ride the shared NuVizz requester so they count in the call dashboard and
// honor the breaker, exactly like the scanner's calls.

import { getNuvizzRequester } from './lib/nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './lib/nuvizz-scan.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const OPENAPI_BASE = NUVIZZ_BASE.replace(/\/v7\/?$/, ''); // → .../deliverit/openapi
const STOP_LISTDEF = Number(process.env.NUVIZZ_STOP_LISTDEF) || 35824; // the saved stop-list columns

// Some columns arrive as a JSON "link" object string carrying the real value.
function linkVal(x: any): any {
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

// Map the column-def order (filterData[0]) onto each values[] row, then pull the
// fields we care about BY KEY (robust to column reordering), in the grid's shape.
export function normalize(j: any): any[] {
  const cols = Object.keys((j.filterData && j.filterData[0]) || {});
  const idx: Record<string, number> = {};
  cols.forEach((k, i) => { idx[k] = i; });
  const g = (row: any[], key: string) => (idx[key] != null ? row[idx[key]] : undefined);
  return (j.values || []).map((row: any[]) => ({
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

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405, headers: cors });

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const period = cleanPeriod(body.arrivalPeriod);
  const codes = Array.isArray(body.statusCodes) ? body.statusCodes.filter((c: any) => /^\d{1,2}$/.test(String(c))).map(String) : [];
  const statusCsv = codes.length ? codes.join(',') : '-1';
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(body.pageSize, 10) || 100));

  try {
    const { companyCode } = getCreds();
    const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
    const payload = JSON.stringify(buildBody(period, statusCsv, page, pageSize));
    const base = `${OPENAPI_BASE}/entity`;
    const reqr = getNuvizzRequester();
    // Data + total in parallel; the stops filterdata response omits totalRecords,
    // so the count endpoint supplies it (only meaningful on page 1).
    const [dataResp, countResp] = await Promise.all([
      reqr.request(`${base}/filterdata/VizzonStop/${companyCode}`, { method: 'POST', headers: hdr, body: payload }, { route: '/entity/filterdata', tenant: companyCode }),
      page === 1
        ? reqr.request(`${base}/filterdatatotalcount/VizzonStop/${companyCode}`, { method: 'POST', headers: hdr, body: payload }, { route: '/entity/filtercount', tenant: companyCode }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!dataResp.ok) {
      return new Response(JSON.stringify({ ok: false, error: `NuVizz returned ${dataResp.status}` }), { status: 502, headers: cors });
    }
    const j = await dataResp.json();
    const rows = normalize(j);
    let total = j?.totalRecords ?? null;
    if (total == null && countResp && countResp.ok) { try { total = (await countResp.json()).totalRecords; } catch { /* ignore */ } }
    return new Response(JSON.stringify({ ok: true, period, statusCodes: codes, page, pageSize, total: total ?? rows.length, rows }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'stop-explorer failed' }), { status: 500, headers: cors });
  }
};
