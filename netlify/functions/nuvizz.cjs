// netlify/functions/nuvizz.js
// Proxy + aggregator for nuVizz REST API v7.
//
// CREDENTIALS: Uses HTTP Basic Auth directly on every call (no JWT exchange).
// The /auth/token endpoint issues JWTs that resource endpoints reject with
// "Invalid signature" — but Basic Auth works directly. This matches the
// pattern used by sentinel-time-theft, davisdeliverytracking, and Davis MarginIQ.
//
// Endpoints exposed:
//   ?tenant=davis&path=__health             → auth check for both tenants
//   ?tenant=davis&path=/stop/info/X/Davis   → raw passthrough (any nuVizz path)
//   ?tenant=davis&path=__today              → aggregated today's stops + loads
//   ?tenant=davis&path=__daterange&from=...&to=... → date-range aggregate
//   ?tenant=davis&path=__loadsbydate&date=YYYY-MM-DD → loads for a specific day

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

function getCreds(tenant) {
  if (tenant === 'uline') {
    return {
      companyCode: process.env.NUVIZZ_ULINE_COMPANY_CODE || 'Uline',
      user: process.env.NUVIZZ_ULINE_USER,
      pass: process.env.NUVIZZ_ULINE_PASS,
    };
  }
  return {
    companyCode: process.env.NUVIZZ_DAVIS_COMPANY_CODE || 'Davis',
    user: process.env.NUVIZZ_DAVIS_USER,
    pass: process.env.NUVIZZ_DAVIS_PASS,
  };
}

function basicAuthHeader(tenant) {
  const { user, pass } = getCreds(tenant);
  if (!user || !pass) throw new Error(`Missing NUVIZZ_${tenant.toUpperCase()}_USER or _PASS env var`);
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
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
