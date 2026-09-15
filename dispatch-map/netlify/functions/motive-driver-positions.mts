// motive-driver-positions.mts
//
// Returns live driver positions from Motive, enriched with the driver who is
// currently signed into each truck. Used by the dispatch map's "Show live
// drivers" toggle (60s client poll) and by the M4.1 driver day-snapshot
// sidebar (initial label render).
//
// WHY A TRUCK WITH A DRIVER ASSIGNED SAID "(no driver)" — Chad, 2026-09-15: "when trucks are
// displayed on the map for motive, it's saying no driver assigned, which is not factual. A lot
// of the times there is a driver assigned."
//
// MOTIVE HAS TWO DRIVER FIELDS ON A VEHICLE, AND THIS FUNCTION READ ONE OF THEM. Checked against
// developer-docs.gomotive.com, not assumed:
//
//   current_driver    — who is LOGGED IN on the vehicle's ELD right now. Carried by
//                       GET /v1/vehicle_locations (the call below). Motive's own scope for
//                       that endpoint is named "Vehicle Current Location/Driver" — current.
//   permanent_driver  — the ADMINISTRATIVE assignment a fleet manager makes in Motive.
//                       Carried by GET /v1/vehicles, and NOT by any version of
//                       vehicle_locations (v1 and v2 expose current_driver only; v3
//                       exposes no driver at all).
//
// So a driver assigned to a truck who has not yet logged in on its tablet was, to this
// function, nobody — and the plate said "(no driver)" over a truck the dispatcher could see
// had a name on it in Motive. The fix reads BOTH: the logged-in driver wins, the assigned one
// fills in behind, and the record says which it was (driverSource) so the sidebar can be
// honest that a driver is assigned but not signed in.
//
// TWO SMALLER DEFECTS FOUND ON THE SAME READ, both fixed here:
//   • A name was composed only when BOTH first_name AND last_name were present, so a driver
//     with one name on file (Motive documents no full_name field) fell through to nobody.
//   • The old fallback called GET /v2/driver_vehicle_assignments. That endpoint appears
//     nowhere in Motive's documentation index, and every error from it was swallowed —
//     so for as long as it has existed it has contributed nothing. Retired.
//
// Motive APIs we touch:
//   GET /v1/vehicle_locations  — most recent position per vehicle + current_driver (paged).
//   GET /v1/vehicles           — the fleet + permanent_driver (paged). One extra call per
//                                cache miss for a fleet under 100 trucks.
//
// MOTIVE_PERMANENT_DRIVER=off puts the old logged-in-only behaviour back (default ON; a
// malformed value leaves it ON — a typo must never silently disable a rule).
//
// Auth: X-API-KEY header (env: MOTIVE_API_KEY).
//
// Caching: per-function-instance, 60s. The client polls every 60s anyway, but
// the in-memory cache protects against rapid re-renders (e.g. when the day-
// snapshot sidebar opens) hammering Motive.

import { requireUser } from './lib/require-user.mts';

const MOTIVE_BASE = process.env.MOTIVE_BASE_URL || 'https://api.gomotive.com/v1';

interface DriverPosition {
  vehicleId: number | string | null;
  vehicleNumber: string | null;
  driverId: number | string | null;
  driverName: string | null;
  // 'current' = logged in on the ELD; 'permanent' = assigned by a fleet manager but not
  // signed in; null = Motive names nobody either way.
  driverSource: 'current' | 'permanent' | null;
  driverFirstName: string | null;
  driverLastInitial: string | null;
  lat: number | null;
  lng: number | null;
  speedMph: number | null;
  heading: number | null;
  locatedAt: string | null;
  address: string | null;
  // M4.1 placeholders — populated by the day-snapshot sidebar's per-driver
  // call to nuvizz-driver-route, not by this endpoint. Included in the shape
  // for documentation / forward-compatibility.
  routeAssigned: boolean;
  routeId: string | null;
  routeTotalStops: number | null;
  routeProgress: { completed: number; total: number } | null;
  stoppedMinutes: number | null;
}

interface CacheEntry { storedAt: number; data: DriverPosition[]; }
const __cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000;

// Motive documents first_name and last_name and NO full_name. A driver with one name on file
// is still a driver; requiring both is how "Cher" became "(no driver)".
export function composeDriverName(d: any): string | null {
  if (!d) return null;
  if (typeof d.full_name === 'string' && d.full_name.trim()) return d.full_name.trim();
  const parts = [d.first_name, d.last_name].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

const OFF_WORDS = new Set(['off', '0', 'false', 'no']);
export function permanentDriverEnabled(env: Record<string, any> = process.env): boolean {
  return !OFF_WORDS.has(String(env.MOTIVE_PERMANENT_DRIVER ?? '').trim().toLowerCase());
}

function firstNameOf(name: string | null): string | null {
  if (!name) return null;
  return name.split(/\s+/)[0] || null;
}

function lastInitialOf(name: string | null): string | null {
  if (!name) return null;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1].charAt(0).toUpperCase();
}

// ── Pagination (Jul 29: "not matching what motive") ──────────────────────────
//
// This used to fetch /vehicle_locations ONCE, with no paging params — and Motive pages that
// endpoint (default ~25 per page). With the fleet past 25 vehicles, every truck past page 1
// simply did not exist on our map: Chad's Motive Fleet View showed 2618T·Rasko, 5042·Enock,
// 7521·Mone Watkins, 7750·Chris Head, and our layer showed none of them — while every truck
// we DID show was numerically below all four. Verified against the live endpoint: 22 served,
// all ≤ 2195, the four missing exactly. Nothing filtered them; they were never fetched.
//
// PURE page-walker, exported for tests. Trusts pagination.total when Motive sends it, stops
// on a short page otherwise, DEDUPES by vehicle id, and stops the moment a page contributes
// nothing new — so an API that ignored page_no could never loop or double-pin a truck. The
// page cap is a runaway bound (10 × 100 = a 1,000-vehicle fleet), not an expected limit.
export async function fetchAllVehiclePages(
  fetchPage: (pageNo: number) => Promise<any>,
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<any[]> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 10;
  const out: any[] = [];
  const seen = new Set<string>();
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const j: any = await fetchPage(pageNo);
    const batch: any[] = j?.vehicles || j?.data || [];
    let added = 0;
    for (const entry of batch) {
      const v = entry?.vehicle || entry || {};
      const id = String(v.id ?? v.number ?? v.name ?? JSON.stringify(entry));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
      added++;
    }
    const total = Number(j?.pagination?.total);
    if (Number.isFinite(total) && out.length >= total) break;
    if (batch.length < perPage) break;   // short page = the last page (covers unpaginated replies too)
    if (added === 0) break;              // page_no ignored / repeating — never loop
  }
  return out;
}

const VEHICLES_PER_PAGE = 100;

async function fetchVehicleLocations(key: string): Promise<any[]> {
  return fetchAllVehiclePages(async (pageNo) => {
    const url = `${MOTIVE_BASE}/vehicle_locations?per_page=${VEHICLES_PER_PAGE}&page_no=${pageNo}`;
    const resp = await fetch(url, {
      headers: { 'X-API-KEY': key, Accept: 'application/json' },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw Object.assign(new Error(`Motive HTTP ${resp.status}`), { status: resp.status, body: text.slice(0, 400) });
    }
    return resp.json();
  }, { perPage: VEHICLES_PER_PAGE });
}

// The ADMINISTRATIVE assignment lives on /v1/vehicles as permanent_driver, and nowhere on
// vehicle_locations. Same paged walker; keyed by vehicle id. Best-effort: a failure here
// degrades to the logged-in-only read, and is reported on the response rather than swallowed.
export async function fetchPermanentDrivers(
  fetchPage: (pageNo: number) => Promise<any>,
): Promise<Map<string | number, any>> {
  const map = new Map<string | number, any>();
  const entries = await fetchAllVehiclePages(fetchPage, { perPage: VEHICLES_PER_PAGE });
  for (const entry of entries) {
    const v = entry?.vehicle || entry || {};
    const pd = v.permanent_driver;
    if (v.id != null && pd && typeof pd === 'object' && composeDriverName(pd)) map.set(v.id, pd);
  }
  return map;
}

async function fetchVehiclesFromMotive(key: string): Promise<Map<string | number, any>> {
  return fetchPermanentDrivers(async (pageNo) => {
    const url = `${MOTIVE_BASE}/vehicles?per_page=${VEHICLES_PER_PAGE}&page_no=${pageNo}`;
    const resp = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw Object.assign(new Error(`Motive HTTP ${resp.status}`), { status: resp.status, body: text.slice(0, 400) });
    }
    return resp.json();
  });
}

export function normalizeEntry(entry: any, permanentLookup: Map<string | number, any>): DriverPosition {
  const v = entry.vehicle || entry;
  const loc = v.current_location || entry.current_location || {};
  let driver = v.current_driver || v.driver || entry.current_driver || null;
  let driverSource: 'current' | 'permanent' | null = driver && composeDriverName(driver) ? 'current' : null;
  if (!driverSource) {
    // Also honour a permanent_driver riding on the entry itself, for callers that already
    // merged the two reads, before consulting the lookup.
    const pd = v.permanent_driver || (v.id != null ? permanentLookup.get(v.id) : null) || null;
    if (pd && composeDriverName(pd)) { driver = pd; driverSource = 'permanent'; }
    else driver = null;
  }
  const driverName: string | null = composeDriverName(driver);
  return {
    vehicleId: v.id ?? null,
    // Verbatim but TRIMMED — the live feed carries '0186T ' with a trailing space, and an
    // untrimmed number quietly breaks any equality join against a roster's clean '0186T'.
    vehicleNumber: (String(v.number ?? '').trim() || String(v.name ?? '').trim()) || null,
    driverId: driver?.id ?? null,
    driverName,
    driverSource,
    driverFirstName: driver?.first_name || firstNameOf(driverName),
    driverLastInitial: driver?.last_name ? driver.last_name.charAt(0).toUpperCase() : lastInitialOf(driverName),
    lat: loc.lat != null ? Number(loc.lat) : null,
    lng: loc.lon != null ? Number(loc.lon) : (loc.lng != null ? Number(loc.lng) : null),
    speedMph: loc.speed != null ? Number(loc.speed) : null,
    heading: loc.bearing != null ? Number(loc.bearing) : null,
    locatedAt: loc.located_at || null,
    address: loc.description || null,
    routeAssigned: false,
    routeId: null,
    routeTotalStops: null,
    routeProgress: null,
    stoppedMinutes: null,
  };
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  // Gate at viewer BEFORE the Motive call: this is live GPS for every truck in the fleet,
  // and each hit spends a metered Motive request. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const key = process.env.MOTIVE_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'MOTIVE_API_KEY not set' }), {
      status: 500, headers: cors,
    });
  }

  const url = new URL(req.url);
  const bypassCache = url.searchParams.get('nocache') === '1';
  const cacheKey = 'default';

  if (!bypassCache) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      return new Response(JSON.stringify({
        ok: true,
        cached: true,
        generated: new Date(hit.storedAt).toISOString(),
        count: hit.data.length,
        drivers: hit.data,
      }), { status: 200, headers: cors });
    }
  }

  try {
    const rawVehicles = await fetchVehicleLocations(key);
    // Only spend the second call when somebody on the board has no logged-in driver.
    const anyUnattributed = rawVehicles.some((entry: any) => {
      const v = entry.vehicle || entry;
      return !composeDriverName(v.current_driver || v.driver || entry.current_driver);
    });
    let permanent = new Map<string | number, any>();
    let permanentError: string | null = null;
    if (anyUnattributed && permanentDriverEnabled()) {
      try { permanent = await fetchVehiclesFromMotive(key); }
      catch (e: any) { permanentError = e?.message || String(e); }   // degrade, and SAY so
    }

    const drivers = rawVehicles
      .map((entry: any) => normalizeEntry(entry, permanent))
      .filter((d: DriverPosition) => d.lat != null && d.lng != null);

    __cache.set(cacheKey, { storedAt: Date.now(), data: drivers });

    return new Response(JSON.stringify({
      ok: true,
      cached: false,
      generated: new Date().toISOString(),
      count: drivers.length,
      drivers,
      ...(permanentError ? { permanentDriverError: permanentError } : {}),
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
