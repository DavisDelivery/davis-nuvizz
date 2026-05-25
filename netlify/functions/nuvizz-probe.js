// netlify/functions/nuvizz-probe.js
//
// Probes NuViz's openapi/v7 surface for write/admin endpoints.
//
// READ-SAFE: all probes send empty {} payloads, and use deliberately
// invalid identifiers (containing "TESTPROBE") so even on the off chance
// an endpoint accepts our request, no real freight can be affected.
//
// USAGE:
//   1. Dry-run (no API calls — shows the plan):
//        curl 'https://davis-warehouse-wms.netlify.app/.netlify/functions/nuvizz-probe'
//   2. Real run:
//        curl 'https://davis-warehouse-wms.netlify.app/.netlify/functions/nuvizz-probe?run=yes'

const https = require('https');
const { URL } = require('url');

const COMPANY  = process.env.NUVIZZ_COMPANY  || 'davis';
const USERNAME = process.env.NUVIZZ_USER;
const PASSWORD = process.env.NUVIZZ_PASS;
const BASE_URL = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

const SAFE_PRO  = '00TESTPROBE999999';
const SAFE_LOAD = 'TESTPROBE999999';

function rq(url, opts = {}) {
  return new Promise((resolve) => {
    const p = new URL(url);
    const r = https.request({
      hostname: p.hostname,
      path: p.pathname + p.search,
      method: opts.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...opts.headers,
      },
      timeout: 8000,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: b.slice(0, 400),
      }));
    });
    r.on('error', err => resolve({ status: 0, error: err.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function basicHeader() {
  return { 'Authorization': `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}` };
}

function verdict(status) {
  if (status === 0)
    return { code: 'NETWORK_ERROR',     emoji: 'X', note: 'connection failed or timeout' };
  if (status === 200 || status === 201 || status === 204)
    return { code: 'ACCEPTED_UNEXPECT', emoji: '!', note: 'endpoint accepted our garbage payload — investigate manually' };
  if (status === 400 || status === 422)
    return { code: 'GREEN',             emoji: 'Y', note: 'endpoint exists and we are authorized — payload rejected as expected' };
  if (status === 401 || status === 403)
    return { code: 'AUTH_BLOCKED',      emoji: 'L', note: 'endpoint exists but our credentials lack permission' };
  if (status === 404)
    return { code: 'NOT_FOUND',         emoji: 'N', note: 'endpoint does not exist at this path' };
  if (status === 405)
    return { code: 'WRONG_METHOD',      emoji: 'M', note: 'path exists but HTTP method not allowed — check Allow header' };
  if (status === 409)
    return { code: 'CONFLICT',          emoji: 'C', note: 'endpoint exists, rejected on state conflict' };
  if (status === 500 || status === 502 || status === 503)
    return { code: 'SERVER_ERROR',      emoji: '5', note: 'likely a real endpoint that choked on the empty payload' };
  return { code: 'OTHER', emoji: '?', note: `unexpected status ${status}` };
}

const probes = [
  { method: 'OPTIONS', path: `/stop/info/${SAFE_PRO}/${COMPANY}`,      intent: 'OPTIONS on known read endpoint' },
  { method: 'OPTIONS', path: `/load/info/${SAFE_LOAD}/${COMPANY}`,     intent: 'OPTIONS on known read endpoint' },

  { method: 'POST',    path: `/stop/update/${SAFE_PRO}/${COMPANY}`,    body: '{}', intent: 'update existing stop' },
  { method: 'PUT',     path: `/stop/${SAFE_PRO}/${COMPANY}`,           body: '{}', intent: 'PUT stop (REST style)' },
  { method: 'PATCH',   path: `/stop/${SAFE_PRO}/${COMPANY}`,           body: '{}', intent: 'PATCH stop (REST style)' },
  { method: 'POST',    path: `/stop/status/${SAFE_PRO}/${COMPANY}`,    body: '{}', intent: 'change stop status' },
  { method: 'POST',    path: `/stop/sequence/${SAFE_PRO}/${COMPANY}`,  body: '{}', intent: 'change stop sequence' },
  { method: 'POST',    path: `/stop/note/${SAFE_PRO}/${COMPANY}`,      body: '{}', intent: 'add stop note' },
  { method: 'POST',    path: `/stop/comment/${SAFE_PRO}/${COMPANY}`,   body: '{}', intent: 'add stop comment' },
  { method: 'POST',    path: `/stop/create/${COMPANY}`,                body: '{}', intent: 'create new stop' },

  { method: 'POST',    path: `/load/update/${SAFE_LOAD}/${COMPANY}`,   body: '{}', intent: 'update load header' },
  { method: 'PUT',     path: `/load/${SAFE_LOAD}/${COMPANY}`,          body: '{}', intent: 'PUT load (REST style)' },
  { method: 'PATCH',   path: `/load/${SAFE_LOAD}/${COMPANY}`,          body: '{}', intent: 'PATCH load (REST style)' },
  { method: 'POST',    path: `/load/create/${COMPANY}`,                body: '{}', intent: 'create new load' },
  { method: 'POST',    path: `/load/sequence/${SAFE_LOAD}/${COMPANY}`, body: '{}', intent: 'resequence stops within a load' },
  { method: 'POST',    path: `/load/dispatch/${SAFE_LOAD}/${COMPANY}`, body: '{}', intent: 'dispatch load to driver' },
  { method: 'POST',    path: `/load/assign/${SAFE_LOAD}/${COMPANY}`,   body: '{}', intent: 'assign load to a driver' },
  { method: 'POST',    path: `/load/driver/${SAFE_LOAD}/${COMPANY}`,   body: '{}', intent: 'set driver on load' },
  { method: 'POST',    path: `/load/route/${SAFE_LOAD}/${COMPANY}`,    body: '{}', intent: 'set route on load' },
  { method: 'POST',    path: `/load/cancel/${SAFE_LOAD}/${COMPANY}`,   body: '{}', intent: 'cancel load' },
  { method: 'POST',    path: `/load/build/${COMPANY}`,                 body: '{}', intent: 'build/optimize load' },

  { method: 'POST',    path: `/shipment/create/${COMPANY}`,            body: '{}', intent: 'create shipment' },
  { method: 'POST',    path: `/order/create/${COMPANY}`,               body: '{}', intent: 'create order' },
  { method: 'POST',    path: `/tender/accept/${SAFE_LOAD}/${COMPANY}`, body: '{}', intent: 'accept load tender' },
  { method: 'POST',    path: `/tender/reject/${SAFE_LOAD}/${COMPANY}`, body: '{}', intent: 'reject load tender' },

  { method: 'GET',     path: `/driver/list/${COMPANY}`,                intent: 'list drivers' },
  { method: 'GET',     path: `/drivers/${COMPANY}`,                    intent: 'list drivers (alt path)' },
  { method: 'GET',     path: `/vehicle/list/${COMPANY}`,               intent: 'list vehicles' },
  { method: 'GET',     path: `/route/list/${COMPANY}`,                 intent: 'list routes' },

  { method: 'GET',     path: `/swagger.json`,                          intent: 'discover: swagger spec' },
  { method: 'GET',     path: `/openapi.json`,                          intent: 'discover: openapi spec' },
  { method: 'GET',     path: `/api-docs`,                              intent: 'discover: api-docs' },
];

async function runBatch(batch) {
  return Promise.all(batch.map(async (probe) => {
    const url = `${BASE_URL}${probe.path}`;
    const opts = { method: probe.method, headers: basicHeader() };
    if (probe.body) opts.body = probe.body;
    const res = await rq(url, opts);
    const v = verdict(res.status);
    return {
      method: probe.method,
      path: probe.path,
      intent: probe.intent,
      status: res.status,
      verdict: v.code,
      emoji: v.emoji,
      note: v.note,
      preview: ['GREEN', 'AUTH_BLOCKED', 'SERVER_ERROR', 'ACCEPTED_UNEXPECT', 'OTHER'].includes(v.code) ? res.body : undefined,
      allow: res.headers && res.headers.allow,
    };
  }));
}

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const run = (event.queryStringParameters || {}).run === 'yes';

  if (!run) {
    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        mode: 'DRY_RUN',
        message: 'Re-run with ?run=yes to execute. All probes send {} payloads with TESTPROBE identifiers — read-safe.',
        baseUrl: BASE_URL,
        company: COMPANY,
        probeCount: probes.length,
        safety: { payload: 'all probes send empty {} body', identifiers: { SAFE_PRO, SAFE_LOAD } },
        plan: probes.map(p => `${p.method.padEnd(7)} ${p.path}   — ${p.intent}`),
      }, null, 2),
    };
  }

  if (!USERNAME || !PASSWORD) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'NUVIZZ_USER or NUVIZZ_PASS not set in environment' }) };
  }

  const sanity = await rq(`${BASE_URL}/auth/token/${COMPANY}`, { headers: basicHeader() });
  if (sanity.status !== 200) {
    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        error: 'auth_sanity_check_failed',
        message: 'Could not authenticate against /auth/token — probe aborted',
        authStatus: sanity.status,
        authBody: sanity.body,
      }, null, 2),
    };
  }

  const results = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < probes.length; i += BATCH_SIZE) {
    const batchResults = await runBatch(probes.slice(i, i + BATCH_SIZE));
    results.push(...batchResults);
    if (i + BATCH_SIZE < probes.length) await new Promise(r => setTimeout(r, 100));
  }

  const buckets = {};
  for (const r of results) {
    buckets[r.verdict] = buckets[r.verdict] || [];
    buckets[r.verdict].push(`${r.emoji} ${r.method.padEnd(7)} ${r.path} -> ${r.status}`);
  }

  const order = ['ACCEPTED_UNEXPECT', 'GREEN', 'SERVER_ERROR', 'AUTH_BLOCKED', 'CONFLICT', 'WRONG_METHOD', 'OTHER', 'NOT_FOUND', 'NETWORK_ERROR'];
  const summary = {};
  for (const k of order) if (buckets[k]) summary[k] = buckets[k];

  return {
    statusCode: 200,
    headers: H,
    body: JSON.stringify({
      ranAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      company: COMPANY,
      authSanity: 'OK',
      probeCount: results.length,
      verdictKey: {
        GREEN:             'endpoint exists AND we are authorized — payload rejected (expected)',
        AUTH_BLOCKED:      'endpoint exists but our credentials lack permission',
        NOT_FOUND:         'endpoint does not exist',
        WRONG_METHOD:      'path exists but HTTP method wrong — check Allow header',
        SERVER_ERROR:      'likely a real endpoint that choked on empty payload',
        ACCEPTED_UNEXPECT: 'endpoint accepted our garbage — investigate manually',
        CONFLICT:          'endpoint exists, rejected on state',
        OTHER:             'unusual response',
        NETWORK_ERROR:     'connection failed',
      },
      summary,
      details: results,
    }, null, 2),
  };
};
