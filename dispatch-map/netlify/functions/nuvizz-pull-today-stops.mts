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

interface SignalSources {
  // Raw address line 2 string — Davis's existing "dumping ground" convention.
  addressLine2: string | null;
  // All order-instruction comments joined by '\n'. Filtered to cmtType ORD_IN or
  // commentDescription prefix 'SPL-INSTR-TEXT:'. Raw text preserved verbatim so
  // the scanner can do exact-pattern matching downstream.
  orderInstructions: string | null;
}

interface NormalizedStop {
  pro: string | null;          // primary PRO (= stopNbr in this tenant) — kept for back-compat
  pros: string[];              // all PROs for this stop (currently length-1; future-proof for grouping)
  primaryPro: string | null;   // pros[0] or null
  proCount: number;            // pros.length
  stopNbr: string | null;
  loadNbr: string | null;
  loadStopSeq: number | null;  // M4.4 — position within load's stops[] (0-based). Used by client to derive stem-out (first non-terminal stop in each load).
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
  driverUserName: string | null; // M4.4 — stable driver code from loadAssignment.driverUserName. Null = unplanned.
  isTerminal: boolean;           // M4.4 — Davis Buford terminal (943 Gainesville Hwy or "Davis Delivery" business name).
  isUnplanned: boolean;          // M4.4 — no driver assignment in loadAssignment.
  signalSources: SignalSources;
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

// Pull "SPL-INSTR-TEXT" order instructions out of stop.comments[].
// NuVizz tags these with cmtType === 'ORD_IN' and a 'SPL-INSTR-TEXT: ...' prefix
// on commentDescription. We keep the raw description (prefix included) joined by
// newline so downstream scanners and the UI can both work with it verbatim.
function extractOrderInstructions(stop: any): string | null {
  const comments = stop?.comments;
  if (!Array.isArray(comments) || !comments.length) return null;
  const lines: string[] = [];
  for (const c of comments) {
    if (!c) continue;
    const desc = typeof c.commentDescription === 'string' ? c.commentDescription : '';
    if (!desc) continue;
    const isOrderInstr = c.cmtType === 'ORD_IN' || desc.startsWith('SPL-INSTR-TEXT:');
    if (isOrderInstr) lines.push(desc);
  }
  return lines.length ? lines.join('\n') : null;
}


// M4.4 — Davis Buford terminal detection. Address heuristics: parent app's
// terminal address is "943 Gainesville Hwy, Buford, GA 30518". Business name
// occasionally shows as "Davis Delivery" / "Davis Delivery Service" on PU
// stops where the terminal acts as origin.
function detectTerminal(addr1: string | null, businessName: string | null): boolean {
  const a = (addr1 || '').toUpperCase();
  if (/\b943\b/.test(a) && /GAINESVILLE/.test(a)) return true;
  const b = (businessName || '').toUpperCase();
  if (/^DAVIS\s+DELIVERY(\s+SERVICE)?$/.test(b)) return true;
  return false;
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
  const addr2 = addr.addr2 ?? null;
  const orderInstructions = extractOrderInstructions(stop);
  const businessName = addr.name || stop.custInfo?.custName || null;
  const addr1 = addr.addr1 ?? null;
  const driverUserName = load.driverUserName ?? null;
  const driverName = load.driverName ?? null;
  return {
    pro: stopNbr,
    pros,
    primaryPro: pros[0] ?? null,
    proCount: pros.length,
    stopNbr,
    loadNbr: load.loadNbr || raw.loadNbr || null,
    loadStopSeq: typeof load.stopSeq === 'number' ? load.stopSeq : null,
    stopType,
    status: exec.stopStatus || stop.status || null,
    businessName,
    addr1,
    addr2,
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
    driverName,
    driverUserName,
    isTerminal: detectTerminal(addr1, businessName),
    isUnplanned: !driverUserName && !driverName,
    signalSources: { addressLine2: addr2, orderInstructions },
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

// ── M6 — Unplanned (status-10) board stops ──────────────────────────────────
// The load scan above only surfaces stops already routed onto a load. Dispatch
// also needs the day's *unplanned* stops: orders imported into NuVizz (stopStatus
// '10' = ready-to-plan) but not yet assigned to any load/driver. These never
// appear in /load/info, so we scan the /stop/info number space directly.
//
// Stop numbers are assigned sequentially as orders import and map almost linearly
// onto the expected-arrival date (to.schedule.timeFrom). Unplanned stops are the
// newest imports, so they cluster at the high end of the number space (the
// "frontier"); numbers above it return 400 (not yet assigned). We estimate the
// frontier from a calibrated anchor, scan a window biased downward from it, and
// keep stops whose stopStatus === '10' and whose expected-arrival date matches.
//
// Calibrated 2026-05-26 against live data: stop 007123931 was the top of the
// 5/26 block, 007124000+ did not yet exist. ~440 numbers/calendar-day (the wide
// scan window absorbs weekend bunching). Recalibrate STOP_ANCHOR_* if the
// estimate drifts off the live frontier (same maintenance posture as ANCHOR_LOAD).
const STOP_ANCHOR_NBR = 7124000;
const STOP_ANCHOR_DATE = new Date('2026-05-26T00:00:00Z');
const STOPS_PER_DAY = 440;
const UNPLANNED_STATUS = '10';
// Window relative to the estimated frontier. Biased downward because the slope
// tends to over-estimate the frontier for near-future dates (those days are only
// partially imported), so the target block sits at or below the estimate.
const UNPLANNED_WINDOW_BELOW = 700;
const UNPLANNED_WINDOW_ABOVE = 200;

function estimateStopFrontier(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00Z');
  const daysDiff = Math.round((target.getTime() - STOP_ANCHOR_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return STOP_ANCHOR_NBR + daysDiff * STOPS_PER_DAY;
}

// Scan the stop-number window for the date and return raw {stop, stopExecutionInfo}
// records (the shape normalizeStop already understands) for unplanned stops only.
async function scanUnplannedStops(dateStr: string, concurrency = 40) {
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const center = estimateStopFrontier(dateStr);
  const low = center - UNPLANNED_WINDOW_BELOW;
  const high = center + UNPLANNED_WINDOW_ABOVE;

  const probe = async (n: number) => {
    const stopNbr = String(n).padStart(9, '0');
    const url = `${NUVIZZ_BASE}/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(companyCode)}`;
    try {
      const resp = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      if (!resp.ok) return null;
      const d: any = await resp.json();
      const wrap = d?.Stop || d?.stop || d;
      const stop = wrap?.stop;
      const exec = wrap?.stopExecutionInfo || {};
      if (!stop?.stopNbr) return null;
      if (exec.stopStatus !== UNPLANNED_STATUS) return null;
      // Expected-arrival date == requested date. Unplanned stops aren't routed,
      // so there's no plannedEta yet; the scheduled delivery window is the date.
      const expected = (stop?.to?.schedule?.timeFrom || '').slice(0, 10);
      if (expected !== dateStr) return null;
      return { stop, stopExecutionInfo: exec };
    } catch {
      return null;
    }
  };

  const nums: number[] = [];
  for (let n = high; n >= low; n--) nums.push(n);

  const results: any[] = [];
  let idx = 0;
  const runOne = async () => {
    while (idx < nums.length) {
      const r = await probe(nums[idx++]);
      if (r) results.push(r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runOne));
  return results;
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
      // M4.4: also stamp the 0-based stop sequence and driverUserName so the
      // client can derive stem-out (first non-terminal stop in each load) and
      // unplanned status (no driverUserName).
      return stops.map((s: any, i: number) => ({
        ...s,
        load: {
          loadNbr: h.loadNbr,
          driverName: a.driverName,
          driverUserName: a.driverUserName,
          stopSeq: i,
        },
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

async function fetchFromNuvizz(date: string, overrideRange?: { from: number; to: number }, bypassCache = false, includeUnplanned = true) {
  const cacheKey = `${date}|${includeUnplanned ? 'u' : 'p'}`;
  if (!bypassCache && !overrideRange) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.data;
  }
  const { startNbr, endNbr } = overrideRange
    ? { startNbr: overrideRange.from, endNbr: overrideRange.to }
    : estimateLoadRange(date);

  // Load scan (planned stops) and unplanned-board scan run concurrently. The
  // unplanned scan is fail-soft: if it errors we still return the planned feed.
  const [loadStops, unplannedStops] = await Promise.all([
    scanLoadRangeForDate(date, startNbr, endNbr),
    includeUnplanned && !overrideRange ? scanUnplannedStops(date).catch(() => []) : Promise.resolve([]),
  ]);

  // Dedupe: a stop already surfaced via a load wins (it carries load context).
  const seen = new Set<string>(loadStops.map((s: any) => s.stopNbr).filter(Boolean));
  const extraUnplanned = unplannedStops.filter((u: any) => {
    const nbr = u?.stop?.stopNbr;
    return nbr && !seen.has(nbr);
  });
  const stops = [...loadStops, ...extraUnplanned];

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
  // Unplanned (status-10 board) stops are included by default; ?unplanned=0 opts out.
  const includeUnplanned = url.searchParams.get('unplanned') !== '0';
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
        rawStops = await fetchFromNuvizz(date, overrideRange, bypassCache, includeUnplanned);
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
    const unplannedCount = stops.filter((s) => s.isUnplanned).length;
    return new Response(JSON.stringify({
      ok: true,
      date,
      source,
      generated: new Date().toISOString(),
      count: stops.length,
      unplannedCount,
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
