// nuvizz-debug-driver-routes.mts
//
// TEMPORARY discovery function for M4.1. Probes plausible NuVizz endpoints
// that might expose route assignments per driver, returns the raw response
// from each that returned 200 (and the error/body from the rest). The goal
// is to learn the correct endpoint + JSON path; document the result in
// HANDOFF.md, then wire `nuvizz-driver-route.mts` to it and DELETE this file.
//
// Query params:
//   date=YYYY-MM-DD      optional, defaults to today UTC
//   driver=name          optional, passed to endpoints that accept a driver name
//   truck=number         optional, passed to endpoints that accept a vehicle number
//
// Usage during discovery:
//   curl https://dd-dispatch-map.netlify.app/.netlify/functions/nuvizz-debug-driver-routes?driver=Trevor+S
//
// Once Chad confirms which endpoint produces a usable route shape, update
// `nuvizz-driver-route.mts` to call only that one and remove this file.

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCreds() {
  return {
    companyCode: (process.env.NUVIZZ_DAVIS_COMPANY_CODE || 'DAVIS').toUpperCase(),
    user: process.env.NUVIZZ_DAVIS_USER,
    pass: process.env.NUVIZZ_DAVIS_PASS,
  };
}

function basicAuthHeader() {
  const { user, pass } = getCreds();
  if (!user || !pass) throw new Error('Missing NUVIZZ_DAVIS_USER or NUVIZZ_DAVIS_PASS');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

interface ProbeResult {
  url: string;
  status: number;
  ok: boolean;
  bodyPreview: string;
  body?: unknown;
}

async function probe(url: string): Promise<ProbeResult> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: basicAuthHeader(), Accept: 'application/json' },
    });
    const text = await resp.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return {
      url,
      status: resp.status,
      ok: resp.ok,
      bodyPreview: text.slice(0, 600),
      body: resp.ok ? body : undefined,
    };
  } catch (e: any) {
    return { url, status: 0, ok: false, bodyPreview: e.message };
  }
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayUTC();
  const driver = url.searchParams.get('driver') || '';
  const truck = url.searchParams.get('truck') || '';
  const { companyCode } = getCreds();

  // Plausible endpoints (brief gave the first four; the last is a known list
  // endpoint copied from davis-nuvizz/netlify/functions/nuvizz.cjs that may
  // include per-driver fields). Keep this list explicit so Chad can scan the
  // raw responses and pick the right shape.
  const candidates = [
    `${NUVIZZ_BASE}/route/info/${encodeURIComponent(companyCode)}?date=${encodeURIComponent(date)}`,
    `${NUVIZZ_BASE}/route/info/${encodeURIComponent(companyCode)}/${encodeURIComponent(date)}`,
    `${NUVIZZ_BASE}/driver/route/${encodeURIComponent(companyCode)}?date=${encodeURIComponent(date)}`,
    driver ? `${NUVIZZ_BASE}/driver/route/${encodeURIComponent(companyCode)}/${encodeURIComponent(driver)}?date=${encodeURIComponent(date)}` : null,
    `${NUVIZZ_BASE}/dispatch/info/${encodeURIComponent(companyCode)}?date=${encodeURIComponent(date)}`,
    `${NUVIZZ_BASE}/route/list/${encodeURIComponent(companyCode)}?date=${encodeURIComponent(date)}`,
    truck ? `${NUVIZZ_BASE}/route/list/${encodeURIComponent(companyCode)}/${encodeURIComponent(truck)}?date=${encodeURIComponent(date)}` : null,
    // Trip / driver-trip endpoints sometimes used in NuVizz tenants:
    `${NUVIZZ_BASE}/trip/info/${encodeURIComponent(companyCode)}?date=${encodeURIComponent(date)}`,
    driver ? `${NUVIZZ_BASE}/driver/info/${encodeURIComponent(driver)}/${encodeURIComponent(companyCode)}` : null,
  ].filter((x): x is string => !!x);

  try {
    const probes: ProbeResult[] = [];
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probe(c);
      probes.push(r);
    }

    const winners = probes.filter((p) => p.ok);

    return new Response(JSON.stringify({
      ok: true,
      generated: new Date().toISOString(),
      date,
      driver,
      truck,
      probeCount: probes.length,
      winnerCount: winners.length,
      probes,
      next_step: winners.length
        ? 'Inspect each winning probe.body. Pick the endpoint that exposes route_id, stops with PRO + scheduled_time + status, and add it to nuvizz-driver-route.mts.'
        : 'No endpoint returned 200. Try with explicit ?driver= or ?truck= query params. If still no hits, STOP and report to Chad per brief rules of engagement.',
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: cors,
    });
  }
};
