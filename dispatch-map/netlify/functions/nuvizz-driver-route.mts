// nuvizz-driver-route.mts
//
// Returns a driver day-snapshot: route assignment + per-stop status + Motive
// HOS + daily miles, all bundled. Called by the M4.1 right-sidebar when the
// dispatcher clicks a driver marker.
//
// Approach: NuVizz v7 does not expose a list-loads-by-driver endpoint, so we
// reuse the load-number scan that already powers nuvizz-pull-today-stops, and
// filter by driver. Matching prefers loadAssignment.driverUserName (a stable
// short code like "VINCENT") over loadAssignment.driverName (a full name like
// "VINCENT  BONZO" that NuVizz returns with inconsistent internal whitespace).
// This mirrors how netlify/functions/nuvizz.cjs:__driver in the parent app
// matches drivers, which is the only proven pattern across the codebase.
//
// Query params:
//   driver=<name>     driver full name from Motive (passed by client)
//   truck=<number>    Motive vehicle number (passed by client)
//   userName=<code>   optional stable driver code (e.g. "VINCENT") — preferred
//                     match field. Resolved from `driver` via DAVIS_DRIVERS
//                     when omitted.
//   date=YYYY-MM-DD   optional, defaults to today UTC
//
// Response shape (consumed by App.jsx's useDriverSnapshot + DriverSnapshotSidebar):
// {
//   ok: true,
//   route: { id, totalStops, completed, remaining } | null,
//   stops: [{ pro, pros, primaryPro, proCount, businessName, addr1, city, state,
//             lat, lng, scheduledTime, actualArrival, actualCompletion, status,
//             lateMinutes, loadNbr }, ...],
//   hos: { loggedInAt, onDutySeconds } | null,
//   dailyMiles: number | null,
//   matchedBy: 'userName' | 'driverName' | null,   // diagnostic
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

// DAVIS_DRIVERS — full registry mirrored from the parent app
// (src/lib/api.js:99-134). Used to resolve a Motive full name into a NuVizz
// userName, which is the stable matching key. Keep in sync with parent.
const DAVIS_DRIVERS: Array<{ userName: string; name: string }> = [
  { userName: 'AARON',   name: 'Aaron Mitchell' },
  { userName: 'ALLEN',   name: 'Allen Council' },
  { userName: 'BEN',     name: 'Ben Paintsil' },
  { userName: 'BILL',    name: 'Bill Tillery' },
  { userName: 'BRAD',    name: 'Brad Goodroe' },
  { userName: 'BRETT',   name: 'Brett Spradley' },
  { userName: 'BRIAN',   name: 'Brian Worley' },
  { userName: 'CHAD',    name: 'Chad Davis' },
  { userName: 'COLIN',   name: 'Colin Calhoun' },
  { userName: 'FRANK',   name: 'Frank Okine' },
  { userName: 'GARRY',   name: 'Garry Pitts' },
  { userName: 'GEORGE',  name: 'George Leonard' },
  { userName: 'JACK',    name: 'Jack Johnson' },
  { userName: 'JEAN',    name: 'Jean Delsoin' },
  { userName: 'JERALD',  name: 'Jerald Buckley' },
  { userName: 'JIM',     name: 'Jim Pallette' },
  { userName: 'JOE',     name: 'Joe Gibbs' },
  { userName: 'JOHN',    name: 'John Thompson' },
  { userName: 'KEN',     name: 'Ken Watkins' },
  { userName: 'LEROY',   name: 'Leroy Smith' },
  { userName: 'MARCUS',  name: 'Marcus Young' },
  { userName: 'MARTIN',  name: 'Martin Wyatt' },
  { userName: 'MIKE',    name: 'Mike Kirkeby' },
  { userName: 'NELSON',  name: 'Oyieke Nelson' },
  { userName: 'RICHARD', name: 'Richard Mawuenyega' },
  { userName: 'ROBERT',  name: 'Robert Best' },
  { userName: 'RONALD',  name: 'Ronald Gates' },
  { userName: 'RYAN',    name: 'Ryan Freeland' },
  { userName: 'SAMUEL',  name: 'Samuel Osei' },
  { userName: 'SCOTT',   name: 'Scott Hart' },
  { userName: 'STEVEN',  name: 'Steven Adjetey' },
  { userName: 'TERRY',   name: 'Terry Gambrell' },
  { userName: 'VICTOR',  name: 'Victor Fernandez' },
  { userName: 'VINCENT', name: 'Vincent Bonzo' },
  { userName: 'WILLIAM', name: 'William Kidd' },
];

// NuVizz returns driverName with inconsistent spacing ("VINCENT  BONZO" with
// two spaces). Normalize: lowercase, collapse all whitespace runs to single
// space, trim. Use everywhere a name comparison is done.
function normName(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Resolve a Motive-supplied driver full name to the NuVizz userName via the
// DAVIS_DRIVERS registry. Returns null if no match — caller should fall back
// to normalized-name matching.
function resolveUserName(driverFullName: string): string | null {
  const target = normName(driverFullName);
  if (!target) return null;
  const exact = DAVIS_DRIVERS.find((d) => normName(d.name) === target);
  if (exact) return exact.userName;
  // Loose fallback: first token (first name) match. Helps when Motive sends
  // "Vincent" but registry has "Vincent Bonzo".
  const firstToken = target.split(' ')[0];
  const byFirst = DAVIS_DRIVERS.filter((d) => normName(d.name).split(' ')[0] === firstToken);
  if (byFirst.length === 1) return byFirst[0].userName;
  return null;
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
// assigned to the given driver. Returns a route object + a stop list + a
// diagnostic field saying which match strategy succeeded (or null).
async function buildRouteFromLoadScan(
  date: string,
  driverFullName: string,
  userName: string | null,
): Promise<{ route: any; stops: any[]; matchedBy: 'userName' | 'driverName' | null }> {
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

  const targetName = normName(driverFullName);
  const targetUser = (userName || '').toUpperCase().trim();

  const matchingLoads: any[] = [];
  let matchedBy: 'userName' | 'driverName' | null = null;
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
        const loadUser: string = (a.driverUserName || '').toUpperCase().trim();
        const loadDriver: string = normName(a.driverName);
        if (!loadUser && !loadDriver) continue;
        // Prefer stable userName match; fall back to whitespace-normalized name.
        if (targetUser && loadUser === targetUser) {
          matchingLoads.push({ load: d.Load, loadHeader: h, assignment: a });
          matchedBy = matchedBy || 'userName';
        } else if (targetName && loadDriver === targetName) {
          matchingLoads.push({ load: d.Load, loadHeader: h, assignment: a });
          matchedBy = matchedBy || 'driverName';
        }
      } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: 25 }, runOne));

  // Flatten stops across all matching loads, sort by scheduled time.
  // NuVizz wraps each stop in { stop, stopExecutionInfo, ... } — unwrap to
  // get to the actual stop fields. Mirrors nuvizz-pull-today-stops.mts.
  const stops: any[] = [];
  for (const ml of matchingLoads) {
    const stopsRaw = ml.load?.stops || [];
    for (const raw of stopsRaw) {
      const s = raw.stop || raw;
      const exec = raw.stopExecutionInfo || {};
      const primary = s.stopType === 'PU' ? (s.from || {}) : (s.to || s.from || {});
      const addr = primary.address || s.address || {};
      const schedule = primary.schedule || {};
      // PRO = stopNbr (see nuvizz-pull-today-stops.mts for the rationale —
      // NuVizz `proNumber` is a code like "G1", not a number).
      const stopNbr: string | null = s.stopNbr ?? null;
      const pros: string[] = stopNbr ? [stopNbr] : [];
      stops.push({
        pro: stopNbr,
        pros,
        primaryPro: pros[0] ?? null,
        proCount: pros.length,
        stopNbr,
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

  if (!stops.length) return { route: null, stops: [], matchedBy: null };

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
    matchedBy,
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
  const userNameParam = url.searchParams.get('userName') || '';
  const date = url.searchParams.get('date') || todayUTC();
  const bypassCache = url.searchParams.get('nocache') === '1';

  // Resolve userName: explicit param wins; otherwise look up by name in the
  // DAVIS_DRIVERS registry. Registry hit dramatically improves match rate
  // because NuVizz returns driverName with inconsistent whitespace.
  const userName = userNameParam || resolveUserName(driver);

  const cacheKey = `${truck}|${userName || driver}|${date}`;
  if (!bypassCache) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ...hit.data, cached: true }), { status: 200, headers: cors });
    }
  }

  try {
    let route: any = null;
    let stops: any[] = [];
    let matchedBy: 'userName' | 'driverName' | null = null;
    if (driver || userName) {
      try {
        const r = await buildRouteFromLoadScan(date, driver, userName);
        route = r.route;
        stops = r.stops;
        matchedBy = r.matchedBy;
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
      userName,
      date,
      route,
      stops,
      hos,
      dailyMiles,
      matchedBy,
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
      userName,
      route: null,
      stops: [],
      hos: null,
      dailyMiles: null,
      matchedBy: null,
    }), { status: 500, headers: cors });
  }
};
