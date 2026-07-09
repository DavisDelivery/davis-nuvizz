// nuvizz-stop-explorer.mts
//
// Read-only proxy for the NuVizz stop list (VizzonStop filterdata) that backs the
// bottom-grid's "pull from NuVizz" filters. The list logic lives in lib/nuvizz-list
// (shared with the scheduled scanner's list-discovery path); this is just the HTTP
// handler. Creds stay server-side; calls ride the shared requester so they count in
// the call dashboard.
//
// POST body: { arrivalPeriod?: "0d"|"+/-7d"|..., statusCodes?: string[], page?, pageSize? }

import { getNuvizzRequester, setCallTrigger } from './lib/nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './lib/nuvizz-scan.mts';
import { buildBody, normalize, cleanPeriod, coveringPeriodForRange, rowInRange, OPENAPI_BASE, SAVED_SEARCHES, fetchSavedSearchRaw, fetchSavedSearchRows, toBoardStop, boardDayFor } from './lib/nuvizz-list.mts';

// Re-exported so the existing test (test/stop-explorer.test.mjs) keeps importing them here.
export { buildBody, normalize, cleanPeriod } from './lib/nuvizz-list.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405, headers: cors });
  setCallTrigger('on-demand'); // bottom-grid stop explorer pull → on-demand

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

  // DIAGNOSTIC (read-only): { savedSearch:'active'|'completed', full:true, find?:'<stopNbr>' } runs the
  // EXACT saved-search pull the scanner uses (full result set, our filterList verbatim) and reports the
  // total rows it returns, the per-board-day + per-status distribution, and whether a specific PRO is in
  // it. Lets us compare OUR pull against the portal's run of the same saved search. One filterdata call.
  if (body.full && (body.savedSearch === 'active' || body.savedSearch === 'completed')) {
    try {
      const def = SAVED_SEARCHES[body.savedSearch as 'active' | 'completed'];
      const rows = await fetchSavedSearchRows(def);
      const stops = rows.map(toBoardStop);
      const byDay: Record<string, number> = {};
      const statusCounts: Record<string, number> = {};
      for (const s of stops) {
        const d = boardDayFor(s) || '(no board day)';
        byDay[d] = (byDay[d] || 0) + 1;
        const st = String(s.status ?? '?');
        statusCounts[st] = (statusCounts[st] || 0) + 1;
      }
      let found: any = null;
      if (body.find) {
        const want = String(body.find).replace(/^0+/, '');
        const hit = stops.find((s: any) => String(s.stopNbr ?? '').replace(/^0+/, '') === want);
        if (hit) found = { stopNbr: hit.stopNbr, status: hit.status, normalizedStatus: hit.normalizedStatus, isUnplanned: hit.isUnplanned, scheduledFrom: hit.scheduledFrom, scheduledDate: hit.scheduledDate, requestedDate: hit.requestedDate, boardDate: hit.boardDate, routeName: hit.routeName };
      }
      return new Response(JSON.stringify({ ok: true, savedSearch: body.savedSearch, customListDefId: def.customListDefId, total: stops.length, byDay, statusCounts, find: body.find || null, present: !!found, found }), { status: 200, headers: cors });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e?.message || 'full saved-search failed' }), { status: 500, headers: cors });
    }
  }

  // Optional explicit calendar range (the bottom grid's "Custom range"). NuVizz has no
  // absolute from/to, so pull the smallest covering symmetric window and filter rows to
  // the exact range below — one cheap list pull regardless of range width.
  const isDay = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const range: { from: string; to: string } | null =
    (isDay(body.fromDate) && isDay(body.toDate))
      ? (body.fromDate <= body.toDate ? { from: body.fromDate, to: body.toDate } : { from: body.toDate, to: body.fromDate })
      : null;
  const period = range ? coveringPeriodForRange(range.from, range.to) : cleanPeriod(body.arrivalPeriod);
  const codes = Array.isArray(body.statusCodes) ? body.statusCodes.filter((c: any) => /^\d{1,2}$/.test(String(c))).map(String) : [];
  const statusCsv = codes.length ? codes.join(',') : '-1';
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  // A wider window / custom range needs a higher row cap to actually return the stops in
  // it — still ONE filterdata call (maxResult is rows-per-call, not extra NuVizz calls).
  const pageSize = Math.max(1, Math.min(2000, parseInt(body.pageSize, 10) || 100));

  // Hard time budget: a slow/large window must return a clean JSON error rather than
  // overrun the function — Netlify would otherwise serve an HTML 502 the client's r.json()
  // can't parse (the "Unexpected token '<'" symptom). The abort fires safely under this
  // function's timeout (netlify.toml → 26s).
  const TIMEOUT_MS = Number(process.env.NUVIZZ_EXPLORER_TIMEOUT_MS) || 22_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const { companyCode } = getCreds();
    const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
    const payload = JSON.stringify(buildBody(period, statusCsv, page, pageSize));
    const base = `${OPENAPI_BASE}/entity`;
    const reqr = getNuvizzRequester();
    // Data + total in parallel; the stops filterdata response omits totalRecords, so the
    // count endpoint supplies it (only meaningful on page 1). maxRetries:1 keeps this
    // user-facing pull snappy — the scanner's 4× / 20s backoff would blow the time budget.
    const [dataResp, countResp] = await Promise.all([
      reqr.request(`${base}/filterdata/VizzonStop/${companyCode}`, { method: 'POST', headers: hdr, body: payload, signal: ac.signal, maxRetries: 1 }, { route: '/entity/filterdata', tenant: companyCode }),
      (page === 1 && !range)
        ? reqr.request(`${base}/filterdatatotalcount/VizzonStop/${companyCode}`, { method: 'POST', headers: hdr, body: payload, signal: ac.signal, maxRetries: 1 }, { route: '/entity/filtercount', tenant: companyCode }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!dataResp.ok) {
      return new Response(JSON.stringify({ ok: false, error: `NuVizz returned ${dataResp.status}` }), { status: 502, headers: cors });
    }
    // Parse defensively: NuVizz (or an upstream gateway) can answer a too-large window with
    // an HTML error PAGE at HTTP 200. Calling .json() straight would throw the raw
    // "Unexpected token '<'" parse error at the user; detect non-JSON and return a short,
    // actionable message instead.
    const text = await dataResp.text();
    let j: any;
    try { j = JSON.parse(text); }
    catch {
      return new Response(JSON.stringify({ ok: false, error: 'NuVizz returned a non-JSON response — the date window may be too large. Try a narrower range.' }), { status: 502, headers: cors });
    }
    let rows = normalize(j);
    let total: number | null = null;
    if (range) {
      // Filter the covering-window rows to the exact calendar range; the count endpoint
      // counts the WHOLE covering window, so report the exact in-range count instead.
      rows = rows.filter((r: any) => rowInRange(r, range.from, range.to));
      total = rows.length;
    } else {
      total = j?.totalRecords ?? null;
      if (total == null && countResp && countResp.ok) {
        try { total = JSON.parse(await countResp.text()).totalRecords; } catch { /* ignore */ }
      }
    }
    return new Response(JSON.stringify({ ok: true, period, range, statusCodes: codes, page, pageSize, total: total ?? rows.length, rows }), { status: 200, headers: cors });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''));
    return new Response(JSON.stringify({ ok: false, error: aborted ? 'NuVizz timed out — the date window may be too large. Try a narrower range.' : (e?.message || 'stop-explorer failed') }), { status: aborted ? 504 : 500, headers: cors });
  } finally {
    clearTimeout(timer);
  }
};
