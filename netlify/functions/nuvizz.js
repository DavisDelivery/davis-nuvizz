// netlify/functions/nuvizz.js
// Proxy + aggregator for nuVizz REST API v7.
//
// Endpoints exposed:
//   ?tenant=davis&path=__health              → auth check for both tenants
//   ?tenant=davis&path=/stop/info/X/Davis    → raw passthrough (any nuVizz path)
//   ?tenant=davis&path=__today               → aggregated today's stops + loads
//   ?tenant=davis&path=__daterange&from=...&to=... → aggregated range
//
// The __today/__daterange endpoints are the heart of the dashboard:
//   - Calls /stop/info/customer/{companyCode}?fromDTTM=...&toDTTM=...  (returns every stop in range)
//   - Groups stops by loadNbr
//   - For each unique load, calls /load/info/{loadNbr}/{companyCode} in parallel (concurrency-limited)
//   - Returns { stops: [...], loads: [...], summary: {...} }
//
// Auth:
//   1. GET /auth/token/{companyCode} with Basic Auth (creds from env)
//   2. Cache JWT per tenant until expiresAt
//   3. Forward with Authorization: Bearer <jwt>

// Base URL can be overridden per-tenant via NUVIZZ_BASE_URL env var.
// Default is the confirmed-working host (verified with Basic Auth returning valid JWT).
const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

// ---- token cache (survives warm invocations) ----
const tokenCache = {};

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

async function getToken(tenant) {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache[tenant];
  if (cached && cached.expiresAt && cached.expiresAt - now > 60) return cached.token;

  const { companyCode, user, pass } = getCreds(tenant);
  if (!user || !pass) throw new Error(`Missing NUVIZZ_${tenant.toUpperCase()}_USER or _PASS env var`);

  const basic = Buffer.from(`${user}:${pass}`).toString('base64');
  const url = `${NUVIZZ_BASE}/auth/token/${encodeURIComponent(companyCode)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth failed (${resp.status}) for ${tenant}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (!data.authToken) throw new Error(`Auth response missing authToken`);
  const exp = parseInt(data.expiresAt, 10) || now + 3600;
  tokenCache[tenant] = { token: data.authToken, expiresAt: exp };
  return data.authToken;
}

// Core authenticated fetch against nuVizz
async function nvFetch(tenant, path, { method = 'GET', body = null, extraParams = {} } = {}) {
  const token = await getToken(tenant);
  const qs = new URLSearchParams(extraParams).toString();
  const url = `${NUVIZZ_BASE}${path}${qs ? '?' + qs : ''}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(data?.reasons?.[0]?.reason || `HTTP ${resp.status}`);
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

// ---- Aggregator: fetch all stops + loads for a date range ----
async function fetchRange(tenant, fromDTTM, toDTTM) {
  const { companyCode } = getCreds(tenant);

  // Stop Info By Customer with no customer filter but date range = all stops in range
  // The endpoint accepts: fromDTTM, toDTTM (ISO format) - returns array of stops
  const stopSearch = await nvFetch(tenant, `/stop/info/customer/${encodeURIComponent(companyCode)}`, {
    method: 'GET',
    extraParams: { fromDTTM, toDTTM },
  });

  // The response shape varies; try several field names
  const stops = stopSearch?.stops || stopSearch?.stopList || stopSearch?.Stops || stopSearch?.stopInfo || [];

  // Unique loadNbrs present on those stops
  const loadNbrs = Array.from(new Set(
    stops.map(s => s.load?.loadNbr || s.loadNbr || s.routeAsgnInfo?.routeNbr).filter(Boolean)
  ));

  // Fetch load details in parallel, concurrency 5
  const loadsRaw = await parallelMap(loadNbrs, 5, async (loadNbr) => {
    const data = await nvFetch(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);
    return data?.Load || data;
  });

  const loads = loadsRaw.filter(l => !l.__error);
  const loadErrors = loadsRaw.filter(l => l.__error).map(l => l.__error);

  // Build summary KPIs
  const summary = buildSummary(stops, loads);

  return { stops, loads, loadNbrs, loadErrors, summary, generated: new Date().toISOString() };
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
    totalStops: total,
    completed,
    inProgress,
    pending,
    failed,
    cancelled,
    pctComplete: total ? Math.round((completed / total) * 100) : 0,
    avgDwellMin: dwellCount ? Math.round(dwellSum / dwellCount) : 0,
    onTime,
    late,
    early,
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

    // Health check
    if (apiPath === '__health') {
      const results = {};
      for (const t of ['davis', 'uline']) {
        try {
          const tok = await getToken(t);
          results[t] = { ok: true, tokenPrefix: tok.slice(0, 20) + '...', expiresAt: tokenCache[t].expiresAt };
        } catch (e) { results[t] = { ok: false, error: e.message }; }
      }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(results) };
    }

    // Today aggregator
    if (apiPath === '__today') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const data = await fetchRange(tenant, start.toISOString(), end.toISOString());
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
    }

    // Date range aggregator
    if (apiPath === '__daterange') {
      if (!params.from || !params.to) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Need from & to ISO dates' }) };
      }
      const data = await fetchRange(tenant, params.from, params.to);
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
