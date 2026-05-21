// motive-driver-positions.mts
//
// Returns live driver positions from Motive. Used by the M4 "Show Live Drivers"
// toggle on the dispatch map. Refreshed every 60s by the client while toggle is on.
//
// Motive API: GET /v1/vehicle_locations returns the most recent location per vehicle.
// Docs: https://developer.gomotive.com/reference/list-vehicle-locations
// Auth: X-API-KEY header.

const MOTIVE_BASE = process.env.MOTIVE_BASE_URL || 'https://api.gomotive.com/v1';

interface DriverPosition {
  vehicleId: number | string;
  vehicleNumber: string | null;
  driverName: string | null;
  driverId: number | string | null;
  lat: number | null;
  lng: number | null;
  speedMph: number | null;
  heading: number | null;
  locatedAt: string | null;
  address: string | null;
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const key = process.env.MOTIVE_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'MOTIVE_API_KEY not set' }), {
      status: 500, headers: cors,
    });
  }

  try {
    const url = `${MOTIVE_BASE}/vehicle_locations`;
    const resp = await fetch(url, {
      headers: { 'X-API-KEY': key, Accept: 'application/json' },
    });
    const text = await resp.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok) {
      return new Response(JSON.stringify({
        ok: false, error: `Motive HTTP ${resp.status}`, body: text.slice(0, 400),
      }), { status: resp.status, headers: cors });
    }

    // Motive shape: { vehicles: [ { vehicle: {...}, current_location: {...} } ] }
    const raw = data?.vehicles || [];
    const drivers: DriverPosition[] = raw.map((entry: any) => {
      const v = entry.vehicle || entry;
      const loc = v.current_location || entry.current_location || {};
      const driver = v.current_driver || v.driver || {};
      return {
        vehicleId: v.id ?? null,
        vehicleNumber: v.number || v.name || null,
        driverName: driver.full_name || (driver.first_name && driver.last_name ? `${driver.first_name} ${driver.last_name}` : null),
        driverId: driver.id ?? null,
        lat: loc.lat != null ? Number(loc.lat) : null,
        lng: loc.lon != null ? Number(loc.lon) : (loc.lng != null ? Number(loc.lng) : null),
        speedMph: loc.speed != null ? Number(loc.speed) : null,
        heading: loc.bearing != null ? Number(loc.bearing) : null,
        locatedAt: loc.located_at || null,
        address: loc.description || null,
      };
    }).filter((d: DriverPosition) => d.lat != null && d.lng != null);

    return new Response(JSON.stringify({
      ok: true,
      generated: new Date().toISOString(),
      count: drivers.length,
      drivers,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: cors,
    });
  }
};
