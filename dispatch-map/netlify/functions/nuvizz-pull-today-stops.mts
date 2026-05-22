// nuvizz-pull-today-stops.mts
//
// Pulls every Davis stop for a given date from NuVizz and returns a normalized
// shape the Dispatch Map UI can consume directly. Default date is today UTC.
//
// Approach: NuVizz's /stop/info/customer/{company} endpoint now requires a
// custAccNbr (it didn't when this was first written), and Davis has many Uline
// accounts so there's no single value to pass. We instead use the same pattern
// that powers tracking.davisdelivery.com's __fleetstops: probe a load-number
// range via /load/info/ in parallel, then flatten stops. Each /load/info call
// is per-load and doesn't require custAccNbr.
//
// Query params:
//   date=YYYY-MM-DD   optional, defaults to today UTC
//   mock=1            return the bundled fixture without calling NuVizz
//   from=N&to=N       override load-number range (debug)
//   nocache=1         bypass in-memory cache

import fixture from '../../test/fixtures/nuvizz-today-stops.json' with { type: 'json' };

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

interface NormalizedStop {
  pro: string | null;          // primary PRO (= stopNbr in this tenant) — kept for back-compat
  pros: string[];              // all PROs for this stop (currently length-1; future-proof for grouping)
  primaryPro: string | null;   // pros[0] or null
  proCount: number;            // pros.length
  stopNbr: string | null;
  loadNbr: string | null;
  stopType: string | null;
  status: string | null;
  businessName: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  cartons: number | null;
  pallets: number | null;
  weight: number | null;
  itemsSummary: string;
  customerAccount: string | null;
  driverName: string | null;
  raw: unknown;
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

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeStop(raw: any): NormalizedStop {
  const stop = raw.stop || raw;
  const exec = raw.stopExecutionInfo || {};
  const load = raw.load || {};
  const stopType = stop.stopType || raw.stopType || 'DO';
  const primary = stopType === 'PU' ? (stop.from || {}) : (stop.to || stop.from || {});
  const addr = primary.address || stop.address || {};
  const schedule = primary.schedule || {};
  const items = [];
  if (stop.totalPallets) items.push(`${stop.totalPallets} pallets`);
  if (stop.totalCartons) items.push(`${stop.totalCartons} cartons`);
  if (stop.weight) items.push(`${stop.weight} ${stop.weightUOM || 'lbs'}`);
  // PRO resolution: dispatchers call this the "PRO". In Davis/Uline live data,
  // `stop.proNumber` is a delivery-type code ("G1", "G6") — not what dispatchers
  // see in NuVizz. The 9-digit identifier they call a PRO lives in `stop.stopNbr`.
  // Parent app does the same: src/screens/StopDetail.jsx:152 displays `s.nbr`
  // (= stop.stopNbr) as the user-facing identifier.
  const stopNbr: string | null = stop.stopNbr ?? null;
  const pros: string[] = stopNbr ? [stopNbr] : [];
  return {
    pro: stopNbr,
    pros,
    primaryPro: pros[0] ?? null,
    proCount: pros.length,
    stopNbr,
    loadNbr: load.loadNbr || raw.loadNbr || null,
    stopType,
    status: exec.stopStatus || stop.status || null,
    businessName: addr.name || stop.custInfo?.custName || null,
    addr1: addr.addr1 ?? null,
    addr2: addr.addr2 ?? null,
    city: addr.city ?? null,
    state: addr.state ?? null,
    zip: addr.zip ?? null,
    lat: addr.latitude != null ? Number(addr.latitude) : null,
    lng: addr.longitude != null ? Number(addr.longitude) : null,
    scheduledFrom: schedule.timeFrom ?? null,
    scheduledTo: schedule.timeTo ?? null,
    cartons: stop.totalCartons ?? null,
    pallets: stop.totalPallets ?? null,
    weight: stop.weight ?? null,
    itemsSummary: items.join(' · ') || '—',
    customerAccount: stop.accountNumber || stop.custInfo?.custAccNbr || null,
    driverName: load.driverName ?? null,
    raw,
  };
}

// Load-number range estimator — Davis dispatches sequential DAVIS{9-digit} loads
// at ~70-100/day. We anchor on a known date+number and project. The window is
// wide (±250) to absorb drift; scanFleet filters out non-existent numbers fast.
const ANCHOR_DATE = new Date('2026-04-22T00:00:00Z');
const ANCHOR_LOAD = 192900;
const LOADS_PER_DAY = 80;

function estimateLoadRange(dateStr: string): { startNbr: number; endNbr: number } {
  const target = new Date(dateStr + 'T00:00:00Z');
  const daysDiff = Math.round((target.getTime() - ANCHOR_DATE.getTime()) / (1000 * 60 * 60 * 24));
  const center = ANCHOR_LOAD + daysDiff * LOADS_PER_DAY;
  return { startNbr: center - 250, endNbr: center + 250 };
}

// Probe a load-number range in parallel, return raw stops with load context stamped on each.
// Mirrors scanFleet from netlify/functions/nuvizz.cjs (the existing tracking site's working pattern).
async function scanLoadRangeForDate(dateStr: string, startNbr: number, endNbr: number, concurrency = 30) {
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const prefix = companyCode;

  const probe = async (n: number) => {
    const loadNbr = `${prefix}${String(n).padStart(9, '0')}`;
    const url = `${NUVIZZ_BASE}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`;
    try {
      const resp = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      if (!resp.ok) return null;
      const d: any = await resp.json();
      const h = d?.Load?.loadHeader || {};
      const a = d?.Load?.loadAssignment || {};
      const stops = d?.Load?.stops || [];
      const startDate = (h.earliestStartDttm || '').slice(0, 10);
      if (startDate !== dateStr) return null;
      // Stamp load context onto each raw stop so normalizeStop can pull loadNbr/driverName.
      return stops.map((s: any) => ({
        ...s,
        load: { loadNbr: h.loadNbr, driverName: a.driverName },
      }));
    } catch {
      return null;
    }
  };

  const nums: number[] = [];
  for (let n = endNbr; n >= startNbr; n--) nums.push(n);

  const results: any[][] = [];
  let idx = 0;
  const runOne = async () => {
    while (idx < nums.length) {
      const myIdx = idx++;
      const r = await probe(nums[myIdx]);
      if (r && r.length) results.push(r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runOne));

  return results.flat();
}

// In-memory cache (per-function-instance, 60s TTL) — repeated map refreshes
// within a minute share one scan. Cold start always re-scans.
const __cache = new Map<string, { storedAt: number; data: any[] }>();
const CACHE_TTL_MS = 60 * 1000;

async function fetchFromNuvizz(date: string, overrideRange?: { from: number; to: number }, bypassCache = false) {
  const cacheKey = `${date}`;
  if (!bypassCache && !overrideRange) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.data;
  }
  const { startNbr, endNbr } = overrideRange
    ? { startNbr: overrideRange.from, endNbr: overrideRange.to }
    : estimateLoadRange(date);
  const stops = await scanLoadRangeForDate(date, startNbr, endNbr);
  if (!overrideRange) __cache.set(cacheKey, { storedAt: Date.now(), data: stops });
  return stops;
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayUTC();
  const useMock = url.searchParams.get('mock') === '1';
  const bypassCache = url.searchParams.get('nocache') === '1';
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const overrideRange = fromParam && toParam ? { from: parseInt(fromParam, 10), to: parseInt(toParam, 10) } : undefined;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  try {
    let rawStops: any[];
    let source: 'nuvizz' | 'fixture' = 'nuvizz';

    if (useMock) {
      rawStops = (fixture as any).stops || [];
      source = 'fixture';
    } else {
      try {
        rawStops = await fetchFromNuvizz(date, overrideRange, bypassCache);
      } catch (e: any) {
        // Missing creds → fall back to fixture so the UI still renders in dev/preview.
        if (/Missing NUVIZZ/.test(e.message)) {
          rawStops = (fixture as any).stops || [];
          source = 'fixture';
        } else {
          throw e;
        }
      }
    }

    const stops = rawStops.map(normalizeStop);
    return new Response(JSON.stringify({
      ok: true,
      date,
      source,
      generated: new Date().toISOString(),
      count: stops.length,
      stops,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      status: e.status || 500,
      body: e.body,
    }), { status: e.status || 500, headers: cors });
  }
};
