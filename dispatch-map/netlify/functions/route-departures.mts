// route-departures.mts — read, and on demand REFIT, the measured per-route departures.
//
// The nightly ledger job fits this table as a by-product of the travel calibration, which
// is the right home for it: same sealed days, same window, one write. But that job carries
// a cron and a cron'd Netlify function is not reachable over plain HTTP, so on the day the
// fit ships there is no way to populate the table before the next 4:00a ET run — and the
// sweeps that most need it run TONIGHT. This endpoint closes that gap and stays useful
// afterwards as the inspectable face of the fit.
//
//   GET  ?days=21                 read the current table (default; writes nothing)
//   GET  ?refit=1&days=21         recompute from sealed history and PUBLISH the result
//   GET  ?refit=1&dry=1&days=21   recompute and show what WOULD be published
//
// A dry refit is the honest default for a number that silences alerts: publishing a
// departure table quiets flags, so being able to see the table before it takes effect is
// part of the feature rather than a nicety. Sealed history only — Firestore reads, ZERO
// NuVizz calls, and nothing here ever sends anything.
import { isFirestoreEnabled, getDoc, setDoc, etDayString } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';
import { arrivalAnchor } from '../../src/lib/board-flags.js';
import { DEFAULT_CURVE } from '../../src/lib/travel-model.js';
import {
  impliedDeparture, departureTable, routeDeparturePath, readDepartureTable, DEPARTURE_VERSION, MIN_SAMPLES,
} from './lib/route-departure.mts';

const TENANT = 'davis';
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const MAX_DAYS = 30;
const isApptRoute = (k: string) => /\b(?:APPTS?|APPOINTMENTS?)\b/i.test(k);

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const posOf = (s: any) => {
  const ov = s?.note?.location_override ?? s?.location_override;
  const oLat = Number(ov?.lat), oLng = Number(ov?.lng);
  if (Number.isFinite(oLat) && Number.isFinite(oLng)) return { lat: oLat, lng: oLng };
  const lat = Number(s?.lat), lng = Number(s?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

/** One sealed day's implied departures, keyed by route. Mirrors the nightly sampler. */
function departuresForDay(stops: any[], date: string): Record<string, number> {
  const routes = new Map<string, any[]>();
  for (const s of stops || []) {
    const k = String(s?.loadNbr || s?.routeName || '').trim();
    if (!k || isApptRoute(k)) continue;
    if (String(s?.stopType || '').toUpperCase() === 'PU') continue;
    const a = arrivalAnchor(s, date);
    if (!routes.has(k)) routes.set(k, []);
    routes.get(k)!.push({
      pos: posOf(s),
      stampMin: a ? a.min : null,
      // WHICH stamp it was, not just when. A delivered stamp has the dwell already spent —
      // impliedDeparture has to take it back out, and it cannot if the source is dropped here.
      stampSource: a ? a.source : null,
      seq: typeof s?.routeSeq === 'number' ? s.routeSeq : null,
    });
  }
  const out: Record<string, number> = {};
  for (const [k, entries] of routes) {
    const dep = impliedDeparture(entries, DEPOT, DEFAULT_CURVE);
    if (dep != null) out[k] = dep;
  }
  return out;
}

const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const refit = url.searchParams.get('refit') === '1';
    const dry = url.searchParams.get('dry') === '1';
    const days = Math.max(1, Math.min(MAX_DAYS, Number(url.searchParams.get('days') || 21)));
    const through = url.searchParams.get('through') || addDays(etDayString(), -1);

    if (!refit) {
      const doc = await getDoc(routeDeparturePath(TENANT)).catch(() => null);
      return J({
        ok: true, published: !!doc, minSamples: MIN_SAMPLES,
        ...(doc ? { through: doc.through, days: doc.days, routes: doc.routes, fitted_at: doc.fitted_at } : {}),
        // PUBLISHED IS NOT THE SAME AS IN USE. A table stored under an older version is
        // still on disk and still shown here — and the board ignores it, because the values
        // mean something different (v1 never removed the dwell from a delivered stamp). This
        // endpoint exists to answer "what is the board actually doing", so it must not let a
        // stale doc read as a live one.
        version: doc?.version ?? null, expectsVersion: DEPARTURE_VERSION,
        usedByBoard: !!readDepartureTable(doc),
        table: doc?.table || null,
        readable: doc?.table
          ? Object.fromEntries(Object.entries<any>(doc.table).map(([k, v]) => [k, `${fmt(v.departMin)} (n=${v.n})`]))
          : null,
      });
    }

    const daySamples: Array<{ date: string; byRoute: Record<string, number> }> = [];
    const scanned: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(through, -i);
      try {
        const stops = await listStops(TENANT, d);
        if (!stops?.length) continue;
        const byRoute = departuresForDay(stops, d);
        scanned.push(d);
        if (Object.keys(byRoute).length) daySamples.push({ date: d, byRoute });
      } catch { /* uncaptured day — fine */ }
    }

    const table = departureTable(daySamples);
    const payload = {
      tenant: TENANT, version: DEPARTURE_VERSION, through,
      days: daySamples.length, routes: Object.keys(table).length,
      table, fitted_at: new Date().toISOString(), source: 'route-departures endpoint',
    };
    if (!dry) await setDoc(routeDeparturePath(TENANT), payload);

    return J({
      ok: true, refit: true, dry, through,
      daysScanned: scanned.length, daysWithSamples: daySamples.length,
      routesPublished: Object.keys(table).length, minSamples: MIN_SAMPLES,
      readable: Object.fromEntries(
        Object.entries(table).sort((a, b) => a[1].departMin - b[1].departMin)
          .map(([k, v]) => [k, `${fmt(v.departMin)} (n=${v.n}, spread ${v.spreadMin}m)`]),
      ),
      note: dry ? 'DRY — nothing published' : 'published to route_departures',
    });
  } catch (err: any) {
    return J({ ok: false, error: String(err?.message || err) }, 500);
  }
};
