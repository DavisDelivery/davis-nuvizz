// nuvizz-pull-today-stops.mts
//
// Pulls every Davis stop for a given date from NuVizz and returns a normalized
// shape the Dispatch Map UI can consume directly. Default date is today (UTC slice).
//
// Auth: HTTP Basic against NuVizz openapi v7 — same credential pattern as the
// existing davis-nuvizz repo's netlify/functions/nuvizz.cjs. We hit:
//   /stop/info/customer/{companyCode}?fromDTTM=...&toDTTM=...
// which returns every stop in the date window (no customer filter = all customers).
//
// Query params:
//   date=YYYY-MM-DD   optional, defaults to today UTC
//   mock=1            return the bundled fixture without calling NuVizz (handy when creds are missing)

import fixture from '../../test/fixtures/nuvizz-today-stops.json' with { type: 'json' };

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

interface NormalizedStop {
  pro: string | null;
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

function normalizePro(input: any): string | null {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^0+/, '');
  if (!cleaned) return '000000000';
  if (!/^\d+$/.test(cleaned)) return null;
  if (cleaned.length > 9) return cleaned;
  return cleaned.padStart(9, '0');
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
  return {
    pro: normalizePro(stop.proNumber),
    stopNbr: stop.stopNbr ?? null,
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

async function fetchFromNuvizz(date: string) {
  const { companyCode } = getCreds();
  const fromDTTM = `${date}T00:00:00.000Z`;
  const toDTTM = `${date}T23:59:59.999Z`;
  const url = `${NUVIZZ_BASE}/stop/info/customer/${encodeURIComponent(companyCode)}?fromDTTM=${encodeURIComponent(fromDTTM)}&toDTTM=${encodeURIComponent(toDTTM)}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = data?.message || data?.reasons?.[0]?.description || `HTTP ${resp.status}`;
    const err = new Error(msg) as any;
    err.status = resp.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  return data?.stops || data?.stopList || data?.Stops || [];
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayUTC();
  const useMock = url.searchParams.get('mock') === '1';
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
        rawStops = await fetchFromNuvizz(date);
      } catch (e: any) {
        // If NuVizz creds aren't set in this environment, fall back to the fixture
        // so the UI can still render. The HANDOFF flags this.
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
