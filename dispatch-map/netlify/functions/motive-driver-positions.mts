// motive-driver-positions.mts
//
// Returns live driver positions from Motive, enriched with the driver who is
// currently signed into each truck. Used by the dispatch map's "Show live
// drivers" toggle (60s client poll) and by the M4.1 driver day-snapshot
// sidebar (initial label render).
//
// Motive APIs we touch (key candidates per the brief — see HANDOFF.md for
// the confirmed working combination once tested against live creds):
//
//   GET /v1/vehicle_locations       — most recent position per vehicle. In
//                                     practice each entry already nests a
//                                     `current_driver` sub-object on this
//                                     account's tier, so this single call
//                                     covers truck #, driver, and lat/lng.
//   GET /v2/driver_vehicle_assignments — used as a fallback enrichment if a
//                                     vehicle entry has no current_driver
//                                     attached. Keyed by vehicle id.
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

// Fallback: pull current driver-vehicle assignments to fill in any vehicles
// that don't have current_driver embedded in /vehicle_locations. Best-effort.
async function fetchAssignments(key: string): Promise<Map<string | number, any>> {
  const map = new Map<string | number, any>();
  try {
    const url = `${MOTIVE_BASE.replace(/\/v1$/, '/v2')}/driver_vehicle_assignments`;
    const resp = await fetch(url, {
      headers: { 'X-API-KEY': key, Accept: 'application/json' },
    });
    if (!resp.ok) return map;
    const data: any = await resp.json();
    const list = data?.driver_vehicle_assignments || data?.assignments || data?.data || [];
    for (const entry of list) {
      const a = entry.driver_vehicle_assignment || entry;
      const vid = a.vehicle?.id ?? a.vehicle_id;
      const driver = a.driver || {};
      if (vid != null) {
        map.set(vid, {
          id: driver.id,
          full_name: driver.full_name || (driver.first_name && driver.last_name ? `${driver.first_name} ${driver.last_name}` : null),
          first_name: driver.first_name,
          last_name: driver.last_name,
        });
      }
    }
  } catch {
    // Swallow — assignments are a nicety, not a requirement.
  }
  return map;
}

export function normalizeEntry(entry: any, assignmentLookup: Map<string | number, any>): DriverPosition {
  const v = entry.vehicle || entry;
  const loc = v.current_location || entry.current_location || {};
  let driver = v.current_driver || v.driver || entry.current_driver || null;
  if (!driver && v.id != null && assignmentLookup.has(v.id)) {
    driver = assignmentLookup.get(v.id);
  }
  const driverName: string | null = driver
    ? (driver.full_name || (driver.first_name && driver.last_name ? `${driver.first_name} ${driver.last_name}` : null))
    : null;
  return {
    vehicleId: v.id ?? null,
    // Verbatim but TRIMMED — the live feed carries '0186T ' with a trailing space, and an
    // untrimmed number quietly breaks any equality join against a roster's clean '0186T'.
    vehicleNumber: (String(v.number ?? '').trim() || String(v.name ?? '').trim()) || null,
    driverId: driver?.id ?? null,
    driverName,
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
    // Decide whether we even need the assignment fallback — only if any entry
    // is missing current_driver.
    const needsAssignments = rawVehicles.some((entry: any) => {
      const v = entry.vehicle || entry;
      return !(v.current_driver || v.driver || entry.current_driver);
    });
    const assignments = needsAssignments ? await fetchAssignments(key) : new Map();

    const drivers = rawVehicles
      .map((entry: any) => normalizeEntry(entry, assignments))
      .filter((d: DriverPosition) => d.lat != null && d.lng != null);

    __cache.set(cacheKey, { storedAt: Date.now(), data: drivers });

    return new Response(JSON.stringify({
      ok: true,
      cached: false,
      generated: new Date().toISOString(),
      count: drivers.length,
      drivers,
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
