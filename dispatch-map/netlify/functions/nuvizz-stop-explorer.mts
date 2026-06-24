// nuvizz-stop-explorer.mts
//
// Read-only proxy for the NuVizz stop list (VizzonStop filterdata) that backs the
// bottom-grid's "pull from NuVizz" filters. The list logic lives in lib/nuvizz-list
// (shared with the scheduled scanner's list-discovery path); this is just the HTTP
// handler. Creds stay server-side; calls ride the shared requester so they count in
// the call dashboard.
//
// POST body: { arrivalPeriod?: "0d"|"+/-7d"|..., statusCodes?: string[], page?, pageSize? }

import { getNuvizzRequester } from './lib/nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './lib/nuvizz-scan.mts';
import { buildBody, normalize, cleanPeriod, OPENAPI_BASE, SAVED_SEARCHES, fetchSavedSearchRaw } from './lib/nuvizz-list.mts';

// Re-exported so the existing test (test/stop-explorer.test.mjs) keeps importing them here.
export { buildBody, normalize, cleanPeriod } from './lib/nuvizz-list.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405, headers: cors });

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }

  // DIAGNOSTIC (read-only): { savedSearch: 'active'|'completed', raw: true } returns the saved
  // search's raw column-def keys + a few raw rows, so we can see exactly which columns it
  // exposes (route sequence? real sequenced ETA?). One filterdata call; rides the requester.
  if (body.raw && (body.savedSearch === 'active' || body.savedSearch === 'completed')) {
    try {
      const def = SAVED_SEARCHES[body.savedSearch as 'active' | 'completed'];
      const { cols, rows } = await fetchSavedSearchRaw(def, 3);
      return new Response(JSON.stringify({ ok: true, savedSearch: body.savedSearch, customListDefId: def.customListDefId, cols, rows }), { status: 200, headers: cors });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e?.message || 'raw saved-search failed' }), { status: 500, headers: cors });
    }
  }

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
