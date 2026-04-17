// netlify/functions/nuvizz.js
// Proxy + aggregator for nuVizz REST API v7.
//
// CREDENTIALS: Uses HTTP Basic Auth directly on every call (no JWT exchange).
// Two credential sets required:
//   DAVIS  — for all shipment/stop/load/route data
//   ULINE  — for document retrieval (photos, PODs). Many Uline stop docs are stored
//            under the ULINE company code, not DAVIS. Try ULINE first, fallback DAVIS.
//
// COMPANY CODE CASING: NuVizz normalizes case internally (DAVIS, davis, Davis all work)
// but the guide recommends uppercase DAVIS / ULINE for consistency.
//
// PRO NUMBERS: Always 9 digits, zero-padded. "7100000" → "007100000".
// The URL parameter order is {stopNumber}/{companyCode} — stop number FIRST.
//
// Endpoints exposed:
//   ?tenant=davis&path=__health        → auth check for both tenants
//   ?tenant=davis&path=__lookup&pro=X  → smart PRO lookup (normalizes 9-digit, returns stop + load + docs)
//   ?tenant=davis&path=__doc&guid=X&ext=jpg → document retrieval (ULINE first, DAVIS fallback)
//   ?tenant=davis&path=__stopsaway&loadNbr=X&stopNbr=Y → count of non-delivered stops before Y
//   ?tenant=davis&path=/stop/info/X/DAVIS → raw passthrough
//   ?tenant=davis&path=__today         → aggregated today's stops (limited — see note below)
//
// NOTE ON __today: NuVizz v7 does not expose a "list all loads for today" endpoint.
// Every query requires a specific reference (PRO, load number, customer account, etc).
// So __today returns empty for Davis/Uline tenants unless a prior cache exists.

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const DOC_BASE = process.env.NUVIZZ_DOC_BASE || 'https://portal.nuvizz.com/deliverit/openapi/documentapi';

// PRO normalization: always 9 digits, zero-padded
function normalizePro(input) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^0+/, '');
  if (!cleaned) return '000000000';
  if (!/^\d+$/.test(cleaned)) return null; // non-numeric = invalid
  if (cleaned.length > 9) return cleaned; // keep as-is if already longer than 9
  return cleaned.padStart(9, '0');
}

function getCreds(tenant) {
  if (tenant === 'uline') {
    return {
      companyCode: (process.env.NUVIZZ_ULINE_COMPANY_CODE || 'ULINE').toUpperCase(),
      user: process.env.NUVIZZ_ULINE_USER,
      pass: process.env.NUVIZZ_ULINE_PASS,
    };
  }
  return {
    companyCode: (process.env.NUVIZZ_DAVIS_COMPANY_CODE || 'DAVIS').toUpperCase(),
    user: process.env.NUVIZZ_DAVIS_USER,
    pass: process.env.NUVIZZ_DAVIS_PASS,
  };
}

function basicAuthHeader(tenant) {
  const { user, pass } = getCreds(tenant);
  if (!user || !pass) throw new Error(`Missing NUVIZZ_${tenant.toUpperCase()}_USER or _PASS env var`);
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// Document retrieval with dual-credential fallback.
// Most Uline stop documents live under the ULINE company code, not DAVIS.
// Strategy: try ULINE first, fall back to DAVIS if ULINE errors.
async function fetchDocument(documentGuid, ext, objectType = '02') {
  const attempts = [];

  const tryOne = async (tenant) => {
    const { companyCode } = getCreds(tenant);
    const url = `${DOC_BASE}/doc/getdocument/${encodeURIComponent(companyCode)}?documentGuid=${encodeURIComponent(documentGuid)}&objectType=${encodeURIComponent(objectType)}`;
    const resp = await fetch(url, {
      headers: { Authorization: basicAuthHeader(tenant), Accept: 'application/json' },
    });
    const text = await resp.text();
    const info = { tenant, companyCode, url, status: resp.status, ok: resp.ok, bodyPreview: text.slice(0, 200) };
    attempts.push(info);
    if (!resp.ok) return null;
    try {
      const data = JSON.parse(text);
      if (!data || !data.documentData) {
        info.reason = 'missing documentData field';
        info.keys = data ? Object.keys(data) : null;
        return null;
      }
      info.sizeBytes = data.documentData.length;
      return data.documentData;
    } catch (e) {
      info.reason = 'parse failed: ' + e.message;
      return null;
    }
  };

  // Try ULINE first
  let b64 = null;
  try { b64 = await tryOne('uline'); } catch (e) { attempts.push({ tenant: 'uline', error: e.message }); }
  // Fallback to DAVIS
  if (!b64) {
    try { b64 = await tryOne('davis'); } catch (e) { attempts.push({ tenant: 'davis', error: e.message }); }
  }
  if (!b64) return { ok: false, attempts };

  // Prepend the correct data URI prefix based on extension
  const extLower = (ext || 'jpg').toLowerCase();
  const mime =
    extLower === 'pdf' ? 'application/pdf' :
    extLower === 'png' ? 'image/png' :
    extLower === 'gif' ? 'image/gif' :
    'image/jpeg';
  return { ok: true, dataUri: `data:${mime};base64,${b64}`, mime, ext: extLower, attempts };
}

// Core authenticated fetch against nuVizz (Basic Auth directly — no JWT)
async function nvFetch(tenant, path, { method = 'GET', body = null, extraParams = {} } = {}) {
  const qs = new URLSearchParams(extraParams).toString();
  const url = `${NUVIZZ_BASE}${path}${qs ? '?' + qs : ''}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuthHeader(tenant),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    // Bubble up the NuVizz error payload — it's more helpful than HTTP code alone
    const nvMsg = data?.message || data?.reasons?.[0]?.description || `HTTP ${resp.status}`;
    const err = new Error(nvMsg);
    err.status = resp.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  return data;
}

// Concurrency-limited parallel map
async function parallelMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Aggregator: fetch all loads for a date ----
async function fetchLoadNbrsForDate(tenant, dateISO) {
  const { companyCode } = getCreds(tenant);
  const date = dateISO.slice(0, 10); // YYYY-MM-DD

  // Strategy 1: /event/eventactivity for entityType=ROUTE
  try {
    const raw = await nvFetch(tenant, `/event/eventactivity/${encodeURIComponent(companyCode)}`, {
      extraParams: { entityType: 'ROUTE', eventDttm: date },
    });
    const events = raw?.eventActivity || [];
    const loadNbrs = [...new Set(events.map(e => e.entityNbr).filter(Boolean))];
    if (loadNbrs.length > 0) return { loadNbrs, method: 'eventActivity' };
  } catch (_) {}

  // Strategy 2: /load/static/info with routeDate
  try {
    const raw = await nvFetch(tenant, `/load/static/info/${encodeURIComponent(companyCode)}`, {
      extraParams: { routeDate: date },
    });
    const routes = raw?.routes || raw?.loads || [];
    const loadNbrs = routes.map(r => r.loadNbr || r.routeNbr).filter(Boolean);
    if (loadNbrs.length > 0) return { loadNbrs, method: 'staticRoute' };
  } catch (_) {}

  // Strategy 3: stop/eventinfo by date — extract unique loadNbrs from stop data
  try {
    const raw = await nvFetch(tenant, `/stop/eventinfo/${encodeURIComponent(companyCode)}`, {
      extraParams: { eventDate: date },
    });
    const stops = raw?.stops || raw?.stopList || [];
    const loadNbrs = [...new Set(stops.map(s => s.loadNbr || s.routeNbr).filter(Boolean))];
    if (loadNbrs.length > 0) return { loadNbrs, method: 'stopEventInfo' };
  } catch (_) {}

  return { loadNbrs: [], method: 'none' };
}

async function fetchLoadsAndStopsForRange(tenant, fromDTTM, toDTTM) {
  const { companyCode } = getCreds(tenant);

  // Get all stops in range via /stop/info/customer (no customer filter → all stops)
  let stops = [];
  try {
    const stopSearch = await nvFetch(tenant, `/stop/info/customer/${encodeURIComponent(companyCode)}`, {
      extraParams: { fromDTTM, toDTTM },
    });
    stops = stopSearch?.stops || stopSearch?.stopList || stopSearch?.Stops || [];
  } catch (e) {
    // Fallback — try event-driven discovery
    const { loadNbrs } = await fetchLoadNbrsForDate(tenant, fromDTTM);
    const loadsRaw = await parallelMap(loadNbrs, 5, async (loadNbr) => {
      const data = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
      return data?.Load || data;
    });
    const loads = loadsRaw.filter(l => !l.__error);
    stops = loads.flatMap(l => (l.stops || []).map(s => ({ ...s, load: { loadNbr: l.loadHeader?.loadNbr } })));
    return { stops, loads, loadNbrs, summary: buildSummary(stops, loads), method: 'event-driven-fallback', generated: new Date().toISOString() };
  }

  // Unique loadNbrs on those stops
  const loadNbrs = Array.from(new Set(
    stops.map(s => s.load?.loadNbr || s.loadNbr || s.routeAsgnInfo?.routeNbr).filter(Boolean)
  ));

  // Fetch load details in parallel
  const loadsRaw = await parallelMap(loadNbrs, 5, async (loadNbr) => {
    const data = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
    return data?.Load || data;
  });
  const loads = loadsRaw.filter(l => !l.__error);

  return {
    stops, loads, loadNbrs,
    summary: buildSummary(stops, loads),
    method: 'stop-customer-search',
    generated: new Date().toISOString(),
  };
}

function buildSummary(stops, loads) {
  const total = stops.length;
  let completed = 0, inProgress = 0, pending = 0, failed = 0, cancelled = 0;
  let dwellSum = 0, dwellCount = 0;
  let onTime = 0, late = 0, early = 0;
  const customerCounts = {};

  for (const s of stops) {
    const exec = s.stopExecutionInfo || {};
    const status = (exec.stopStatus || s.status || '').toString().toUpperCase();
    if (status.includes('COMPLET') || status.includes('CLOSED') || status.includes('DELIV')) completed++;
    else if (status.includes('PROGRESS') || status.includes('DISPATCH') || status.includes('ENROUTE')) inProgress++;
    else if (status.includes('FAIL')) failed++;
    else if (status.includes('CANCEL')) cancelled++;
    else pending++;

    const toTs = exec.to || {};
    if (toTs.duration) { dwellSum += toTs.duration; dwellCount++; }
    if (toTs.etaCode === 'ONTIME') onTime++;
    else if (toTs.etaCode === 'LATE' || toTs.etaCode === 'DELAYED') late++;
    else if (toTs.etaCode === 'EARLY') early++;

    const cust = s.stop?.custInfo?.custName || s.custInfo?.custName || s.accountNumber || 'Unknown';
    customerCounts[cust] = (customerCounts[cust] || 0) + 1;
  }

  let miles = 0;
  for (const l of loads) {
    const exec = l.loadExecutionInfo || {};
    miles += (exec.actualDistanceMiles || exec.plannedDistanceMiles || 0);
  }

  return {
    totalStops: total, completed, inProgress, pending, failed, cancelled,
    pctComplete: total ? Math.round((completed / total) * 100) : 0,
    avgDwellMin: dwellCount ? Math.round(dwellSum / dwellCount) : 0,
    onTime, late, early,
    totalLoads: loads.length,
    totalMiles: Math.round(miles),
    topCustomers: Object.entries(customerCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
  };
}

// ---- Handler ----
exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const tenant = (params.tenant || 'davis').toLowerCase();
    const apiPath = params.path;
    if (!apiPath) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing ?path=' }) };

    // Health check — just verify Basic Auth works on a cheap endpoint for each tenant
    if (apiPath === '__health') {
      const results = {};
      for (const t of ['davis', 'uline']) {
        try {
          const { companyCode } = getCreds(t);
          // Hit a tiny endpoint that we know responds. /stop/info/NOTAREAL/ will 400 with
          // a domain-level error meaning auth succeeded (we don't care about the 400).
          const url = `${NUVIZZ_BASE}/stop/info/__probe__/${encodeURIComponent(companyCode)}`;
          const r = await fetch(url, { headers: { Authorization: basicAuthHeader(t), Accept: 'application/json' } });
          const txt = await r.text();
          const authOk = r.status !== 401 && r.status !== 403;
          results[t] = { ok: authOk, status: r.status, preview: txt.slice(0, 120) };
        } catch (e) { results[t] = { ok: false, error: e.message }; }
      }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(results) };
    }

    // Today aggregator
    if (apiPath === '__today') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const data = await fetchLoadsAndStopsForRange(tenant, start.toISOString(), end.toISOString());
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // Date range aggregator
    if (apiPath === '__daterange') {
      if (!params.from || !params.to) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need from & to ISO dates' }) };
      }
      const data = await fetchLoadsAndStopsForRange(tenant, params.from, params.to);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // Loads-by-date (simpler than today — just load nbrs, no full stop data)
    if (apiPath === '__loadsbydate') {
      const date = params.date || new Date().toISOString().slice(0, 10);
      const data = await fetchLoadNbrsForDate(tenant, date);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // --- Smart PRO lookup ---
    // Normalizes PRO to 9-digit zero-padded, fetches stop info, and includes
    // the parent load header so the UI can show "stops away" / route context.
    //   ?tenant=davis&path=__lookup&pro=7100000
    if (apiPath === '__lookup') {
      const rawPro = params.pro || params.stopNbr || '';
      const pro = normalizePro(rawPro);
      if (!pro) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid PRO number — must be numeric' }) };
      }
      const { companyCode } = getCreds(tenant);
      let stop;
      try {
        stop = await nvFetch(tenant, `/stop/info/${encodeURIComponent(pro)}/${encodeURIComponent(companyCode)}`);
      } catch (e) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: e.message, pro, normalizedPro: pro, original: rawPro }) };
      }

      // Optionally pull the load to compute stops-away
      let load = null;
      let stopsAway = null;
      let loadError = null;
      const loadNbr = stop?.Stop?.load?.loadNbr;
      if (loadNbr && params.includeLoad !== 'false') {
        try {
          load = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
          const stops = load?.Load?.stops || [];
          const targetIdx = stops.findIndex(s => s?.stop?.stopNbr === pro);
          if (targetIdx > 0) {
            stopsAway = stops.slice(0, targetIdx)
              .filter(s => (s?.stopExecutionInfo?.stopStatus || '') !== '90')
              .length;
          } else if (targetIdx === 0) {
            stopsAway = 0;
          }
        } catch (e) {
          loadError = e.message;
        }
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          pro,
          normalizedPro: pro,
          originalInput: rawPro,
          stop: stop?.Stop ?? null,
          load: (load?.Load) ?? null,
          stopsAway: stopsAway ?? null,
          loadError,
          loadNbr,
        }),
      };
    }

    // --- Document retrieval (dual-credential fallback: ULINE first, DAVIS fallback) ---
    //   ?tenant=davis&path=__doc&guid=XXX&ext=jpg&objectType=02
    //   ?tenant=davis&path=__doc&guid=XXX&ext=jpg&debug=1   → returns per-attempt details
    if (apiPath === '__doc') {
      const guid = params.guid || params.documentGuid;
      const ext = params.ext || 'jpg';
      const objectType = params.objectType || '02';
      const debug = params.debug === '1' || params.debug === 'true';
      if (!guid) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing guid' }) };
      }
      const doc = await fetchDocument(guid, ext, objectType);
      if (!doc.ok) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'Document not found under ULINE or DAVIS',
            attempts: doc.attempts,
          }),
        };
      }
      const payload = { dataUri: doc.dataUri, mime: doc.mime, ext: doc.ext };
      if (debug) payload.attempts = doc.attempts;
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(payload) };
    }

    // --- Stops-away from a reference stop on a known load ---
    //   ?tenant=davis&path=__stopsaway&loadNbr=X&stopNbr=Y
    if (apiPath === '__stopsaway') {
      const loadNbr = params.loadNbr;
      const stopNbr = normalizePro(params.stopNbr);
      if (!loadNbr || !stopNbr) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need loadNbr and stopNbr' }) };
      }
      const { companyCode } = getCreds(tenant);
      const load = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
      const stops = load?.Load?.stops || [];
      const idx = stops.findIndex(s => s?.stop?.stopNbr === stopNbr);
      if (idx < 0) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Stop not found on load', loadNbr, stopNbr }) };
      }
      const stopsAway = stops.slice(0, idx)
        .filter(s => (s?.stopExecutionInfo?.stopStatus || '') !== '90')
        .length;
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ loadNbr, stopNbr, stopsAway, totalStopsOnLoad: stops.length, position: idx + 1 }),
      };
    }

    // Passthrough
    const extraParams = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'tenant' && k !== 'path') extraParams[k] = v;
    }
    const data = await nvFetch(tenant, apiPath, {
      method: event.httpMethod,
      body: event.body ? JSON.parse(event.body) : null,
      extraParams,
    });
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
  } catch (err) {
    return {
      statusCode: err.status || 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, detail: err.body }),
    };
  }
};
