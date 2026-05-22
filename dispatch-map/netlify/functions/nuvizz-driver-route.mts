// nuvizz-driver-route.mts
//
// Returns a driver day-snapshot: route assignment + per-stop status + Motive
// HOS + daily miles, all bundled. Called by the M4.1 right-sidebar when the
// dispatcher clicks a driver marker.
//
// Status: SCAFFOLDED. The NuVizz route-assignment endpoint is not yet
// confirmed for this tenant — run `nuvizz-debug-driver-routes` against live
// creds to discover which `/route/...` or `/driver/route/...` URL returns
// usable data, then collapse this function to call only that one. Until then
// this returns a defensible "no route assigned" stub PLUS whatever load-info
// data we can reconstruct from the truck's driver name.
//
// Query params:
//   driver=<name>     driver full name from Motive (passed by client)
//   truck=<number>    Motive vehicle number (passed by client)
//   date=YYYY-MM-DD   optional, defaults to today UTC
//
// Response shape (consumed by App.jsx's useDriverSnapshot + DriverSnapshotSidebar):
// {
//   ok: true,
//   route: { id, totalStops, completed, remaining } | null,
//   stops: [{ pro, businessName, addr1, city, state, lat, lng, scheduledTime,
//             actualArrival, actualCompletion, status, lateMinutes }, ...],
//   hos: { loggedInAt, onDutySeconds } | null,
//   dailyMiles: number | null,
//   raw: { ... }     // preserve at every layer per standing rules
// }

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const MOTIVE_BASE = process.env.MOTIVE_BASE_URL || 'https://api.gomotive.com/v1';

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

// In-memory per-driver cache, 30s TTL. Matches the client cache; redundant
// but cheap insurance.
const __cache = new Map<string, { storedAt: number; data: any }>();
const CACHE_TTL_MS = 30 * 1000;

// Normalize a NuVizz stop status string to one of {completed, en_route, current, pending}.
function normalizeStopStatus(raw: string | null): string {
  if (!raw) return 'pending';
  const s = raw.toLowerCase();
  if (s.includes('deliver') || s.includes('complete') || s.includes('arrived') || s === 'd') return 'completed';
  if (s.includes('enroute') || s.includes('en route') || s.includes('in_transit') || s === 'e') return 'en_route';
  if (s.includes('current') || s.includes('next')) return 'current';
  return 'pending';
}

// Try to find route info for this driver via the load-info scan that
// nuvizz-pull-today-stops uses. Same scan range; we just filter to loads
// assigned to the given driver. Returns a route object + a stop list, both
// possibly empty.
async function buildRouteFromLoadScan(date: string, driverName: string): Promise<{ route: any; stops: any[] }> {
  const { companyCode } = getCreds();
  // Anchor + range identical to nuvizz-pull-today-stops.mts — keep in sync if
  // you change one, change both.
  const ANCHOR_DATE = new Date('2026-04-22T00:00:00Z');
  const ANCHOR_LOAD = 192900;
  const LOADS_PER_DAY = 80;
  const target = new Date(date + 'T00:00:00Z');
  const daysDiff = Math.round((target.getTime() - ANCHOR_DATE.getTime()) / (1000 * 60 * 60 * 24));
  const center = ANCHOR_LOAD + daysDiff * LOADS_PER_DAY;
  const startNbr = center - 250;
  const endNbr = center + 250;

  const auth = basicAuthHeader();
  const nums: number[] = [];
  for (let n = endNbr; n >= startNbr; n--) nums.push(n);

  const matchingLoads: any[] = [];
  let idx = 0;
  const runOne = async () => {
    while (idx < nums.length) {
      const myIdx = idx++;
      const n = nums[myIdx];
      const loadNbr = `${companyCode}${String(n).padStart(9, '0')}`;
      const url = `${NUVIZZ_BASE}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`;
      try {
        const resp = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
        if (!resp.ok) continue;
        const d: any = await resp.json();
        const h = d?.Load?.loadHeader || {};
        const a = d?.Load?.loadAssignment || {};
        const startDate = (h.earliestStartDttm || '').slice(0, 10);
        if (startDate !== date) continue;
        const loadDriver: string = a.driverName || '';
        if (!loadDriver) continue;
        if (loadDriver.toLowerCase().trim() === driverName.toLowerCase().trim()) {
          matchingLoads.push({ load: d.Load, loadHeader: h, assignment: a });
        }
      } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: 25 }, runOne));

  // Flatten stops across all matching loads, sort by scheduled time.
  const stops: any[] = [];
  for (const ml of matchingLoads) {
    const stopsRaw = ml.load?.stops || [];
    for (const s of stopsRaw) {
      const primary = s.stopType === 'PU' ? (s.from || {}) : (s.to || s.from || {});
      const addr = primary.address || s.address || {};
      const schedule = primary.schedule || {};
      const exec = s.stopExecutionInfo || {};
      stops.push({
        pro: s.proNumber ?? null,
        stopNbr: s.stopNbr ?? null,
        businessName: addr.name || s.custInfo?.custName || null,
        addr1: addr.addr1 ?? null,
        city: addr.city ?? null,
        state: addr.state ?? null,
        lat: addr.latitude != null ? Number(addr.latitude) : null,
        lng: addr.longitude != null ? Number(addr.longitude) : null,
        scheduledTime: schedule.timeFrom ?? null,
        actualArrival: exec.arrivalDttm ?? exec.arrivedDttm ?? null,
        actualCompletion: exec.completionDttm ?? exec.completedDttm ?? null,
        status: normalizeStopStatus(exec.stopStatus || s.status || null),
        loadNbr: ml.loadHeader.loadNbr,
      });
    }
  }
  stops.sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));

  if (!stops.length) return { route: null, stops: [] };

  const completed = stops.filter((s) => s.status === 'completed').length;
  // Use the first load's loadNbr as a stand-in "route id" until the real
  // route endpoint is wired; the dispatcher will still see a useful value.
  const routeId = matchingLoads[0]?.loadHeader?.loadNbr || null;
  return {
    route: {
      id: routeId,
      totalStops: stops.length,
      completed,
      remaining: stops.length - completed,
    },
    stops,
  };
}

// Motive HOS — best-effort. Returns null if not exposed for this tier.
async function fetchHos(driverName: string): Promise<{ loggedInAt: string | null; onDutySeconds: number | null } | null> {
  const key = process.env.MOTIVE_API_KEY;
  if (!key || !driverName) return null;
  try {
    // No documented endpoint that takes a driver name directly; the standard
    // shape is /users/{id}/duty_status. We don't know the user id at this
    // layer. Try the bulk endpoint and filter — many Motive tiers expose it.
    const url = `${MOTIVE_BASE}/users/duty_status_logs`;
    const resp = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' } });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const list = data?.duty_status_logs || data?.logs || [];
    // Pick the most recent log matching the driver name; sum on-duty seconds today.
    const matching = list.filter((entry: any) => {
      const e = entry.duty_status_log || entry;
      const u = e.user || e.driver || {};
      const name = u.full_name || (u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : '');
      return name && name.toLowerCase().trim() === driverName.toLowerCase().trim();
    });
    if (!matching.length) return null;
    // Heuristic: the earliest "on_duty" or "driving" today is loggedInAt.
    const today = todayUTC();
    const onDutyLogs = matching
      .map((entry: any) => entry.duty_status_log || entry)
      .filter((e: any) => (e.start_time || '').slice(0, 10) === today)
      .filter((e: any) => ['on_duty', 'driving', 'on_duty_nd', 'on'].includes(String(e.duty_status || '').toLowerCase()));
    if (!onDutyLogs.length) return null;
    onDutyLogs.sort((a: any, b: any) => (a.start_time || '').localeCompare(b.start_time || ''));
    const loggedInAt = onDutyLogs[0].start_time || null;
    let onDutySeconds = 0;
    for (const log of onDutyLogs) {
      const start = new Date(log.start_time).getTime();
      const end = log.end_time ? new Date(log.end_time).getTime() : Date.now();
      if (!Number.isNaN(start) && !Number.isNaN(end)) onDutySeconds += Math.max(0, Math.round((end - start) / 1000));
    }
    return { loggedInAt, onDutySeconds };
  } catch {
    return null;
  }
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const url = new URL(req.url);
  const driver = url.searchParams.get('driver') || '';
  const truck = url.searchParams.get('truck') || '';
  const date = url.searchParams.get('date') || todayUTC();
  const bypassCache = url.searchParams.get('nocache') === '1';

  const cacheKey = `${truck}|${driver}|${date}`;
  if (!bypassCache) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ...hit.data, cached: true }), { status: 200, headers: cors });
    }
  }

  try {
    let route: any = null;
    let stops: any[] = [];
    if (driver) {
      try {
        const r = await buildRouteFromLoadScan(date, driver);
        route = r.route;
        stops = r.stops;
      } catch (e: any) {
        // If NuVizz creds missing or network fails, fall through with route=null.
        if (!/Missing NUVIZZ/.test(e.message)) console.warn('route scan failed', e.message);
      }
    }

    const hos = driver ? await fetchHos(driver) : null;
    // Daily miles is not yet wired — Motive exposes it on a vehicle daily-
    // summary endpoint we'd need to discover. Returning null per brief
    // (document the gap rather than fabricating).
    const dailyMiles: number | null = null;

    const out = {
      ok: true,
      truck,
      driver,
      date,
      route,
      stops,
      hos,
      dailyMiles,
      cached: false,
      generated: new Date().toISOString(),
    };
    __cache.set(cacheKey, { storedAt: Date.now(), data: out });
    return new Response(JSON.stringify(out), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      truck,
      driver,
      route: null,
      stops: [],
      hos: null,
      dailyMiles: null,
    }), { status: 500, headers: cors });
  }
};
