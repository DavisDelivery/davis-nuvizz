// lib/geocode.mts
//
// Address → {lat,lng} via Google Geocoding, cached permanently in Firestore
// (nuvizz_geocode/<hash>) so each unique address is geocoded ONCE. This is what
// lets the list-discovery scan place map pins without the NuVizz-provided
// coordinates we used to get from /load/info & /stop/info.
//
// Cost control: the caller seeds with coordinates already known (carried forward
// from the existing stop index — your repeat customers), so only brand-new
// addresses ever hit Google, and even those are cached forever (incl. a negative
// cache for un-geocodable addresses, so we never retry them every scan).
//
// Key: reuses the Google Maps key the app already has. Geocoding is a server-side
// web-service call, so the key must have the Geocoding API enabled (env override
// GOOGLE_GEOCODE_API_KEY if a dedicated server key is preferred).

import crypto from 'node:crypto';
import { getDoc, setDoc } from './firestore.mts';
import { normalizePlaceKey } from '../../../src/lib/matchKey.js';

const GEOCODE_KEY =
  process.env.GOOGLE_GEOCODE_API_KEY ||
  process.env.VITE_GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_ROUTES_API_KEY ||
  '';
const CACHE = 'nuvizz_geocode';

export interface GeoPoint { lat: number; lng: number }
export interface AddrParts { addr1?: string | null; city?: string | null; state?: string | null; zip?: string | null }

// THE OLD KEY — an exact hash of the address STRING, case- and space-insensitive and
// nothing more. Kept because every entry written before this change is filed under it, and
// resolveCoords reads it as a fallback so the fix costs ZERO new Google calls.
export function legacyAddrKey(p: AddrParts): string | null {
  if (!p || !String(p.addr1 || '').trim()) return null;
  const norm = [p.addr1, p.city, p.state, p.zip].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).join(', ');
  return norm ? crypto.createHash('sha1').update(norm).digest('hex').slice(0, 24) : null;
}

/**
 * ONE DOCK, ONE GEOCODE, ONE PIN.
 *
 * Chad, on two orders at one Alpharetta address: "They are same address and geocode. Nuvizz
 * had them together in same spot on map. Dispatch map did not."
 *
 * CHECKED, NOT REASONED. Nothing in the app moves a marker — every one is drawn at exactly
 * s.lat/s.lng, and there is no jitter or spider anywhere. The split was made upstream, here:
 * this key was a hash of the RAW address string, so "5640 LOGISTICS DRIVE" and "5640
 * LOGISTICS DR" were two different addresses, geocoded separately by Google and pinned
 * separately on the board. Measured across five realistic variations, FOUR of them keyed
 * apart — the suffix (DRIVE/DR, PARKWAY/PKWY), a ZIP+4 against a ZIP5, and a missing state.
 *
 * THE APP ALREADY HAD THE RIGHT ANSWER AND WAS NOT USING IT HERE. normalizePlaceKey — the
 * street+zip5 rule written for the FedEx twin that got left on the floor (see matchKey.js) —
 * says "same dock" for every one of those pairs, and it is what the selection grouping, the
 * same-address twin guard and the board-flags trailer rule already ask. Two notions of "same
 * address" in one codebase is one too many: this key now defers to that one, so the screen
 * that groups two orders as one place also draws them in one place.
 *
 * Falls back to the legacy exact-string key when there is no usable street+zip (a stop with
 * an address line but no ZIP still gets a key, exactly as before) — the coverage does not
 * shrink, only the false splits.
 */
export function addrKey(p: AddrParts): string | null {
  if (!p || !String(p.addr1 || '').trim()) return null;
  const place = normalizePlaceKey(p.addr1, p.zip);
  if (place) return crypto.createHash('sha1').update(`place:${place}`).digest('hex').slice(0, 24);
  return legacyAddrKey(p);
}

function addrString(p: AddrParts): string {
  return [p.addr1, p.city, p.state, p.zip].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
}

export function isGeocodeConfigured(): boolean { return !!GEOCODE_KEY; }

// Three outcomes, not two. 'found' and 'none' are ANSWERS from Google about the address and
// are cached forever (a negative marker for 'none' is what stops an un-geocodable address
// being retried every scan). 'error' is not an answer about the address at all — a non-2xx
// HTTP, OVER_QUERY_LIMIT, REQUEST_DENIED, UNKNOWN_ERROR, a network failure — and it used to
// be written to the cache as `failed: true` exactly like ZERO_RESULTS, so one throttled or
// mis-keyed scan pinned every new address on the board with no coordinates PERMANENTLY.
// Nothing is written for 'error'; the next scan simply asks again.
export type GeocodeOutcome = { status: 'found'; pt: GeoPoint } | { status: 'none' } | { status: 'error'; reason: string };
export function classifyGeocodeResponse(ok: boolean, httpStatus: number, j: any): GeocodeOutcome {
  if (!ok) return { status: 'error', reason: `http_${httpStatus}` };
  const loc = j?.results?.[0]?.geometry?.location;
  if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') return { status: 'found', pt: { lat: loc.lat, lng: loc.lng } };
  if (j?.status === 'ZERO_RESULTS') return { status: 'none' };
  return { status: 'error', reason: String(j?.status || 'no_result') };
}

async function geocodeOne(addr: string): Promise<GeocodeOutcome> {
  if (!GEOCODE_KEY) return { status: 'error', reason: 'no_key' };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${GEOCODE_KEY}`;
  try {
    const r = await fetch(url);
    let j: any = null;
    try { j = await r.json(); } catch { /* non-JSON body → classified below on r.ok/status */ }
    return classifyGeocodeResponse(r.ok, r.status, j);
  } catch (e: any) {
    return { status: 'error', reason: e?.message || 'network' };
  }
}

/**
 * Resolve coords for a batch of addresses → Map<addrKey, GeoPoint>.
 * Order of resolution per unique address: seed (carried-forward known coords) →
 * Firestore cache (incl. negative cache) → Google geocode (then cached). Best-effort:
 * any failure just leaves that address without coords (pin omitted), never throws.
 */
export async function resolveCoords(items: AddrParts[], seed?: Map<string, GeoPoint>): Promise<Map<string, GeoPoint>> {
  const out = new Map<string, GeoPoint>();
  const misses: Array<{ key: string; str: string }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    const k = addrKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (seed && seed.has(k)) { out.set(k, seed.get(k)!); continue; }
    let cached: any = null;
    try { cached = await getDoc(`${CACHE}/${k}`); } catch { /* treat as miss */ }
    // MISS UNDER THE NEW KEY IS NOT A MISS. Every address geocoded before addrKey started
    // normalising is filed under the exact-string hash, so without this the key change would
    // re-geocode the entire book of addresses at Google's price for answers we already own.
    // Read the legacy entry and carry it forward under the new key; the legacy doc is left
    // where it is (harmless, and it keeps this reversible).
    if (!cached) {
      const lk = legacyAddrKey(it);
      if (lk && lk !== k) {
        try { cached = await getDoc(`${CACHE}/${lk}`); } catch { /* treat as miss */ }
        if (cached) {
          try { await setDoc(`${CACHE}/${k}`, { ...cached, migratedFrom: lk, ts: new Date().toISOString() }); } catch { /* best-effort */ }
        }
      }
    }
    if (cached) {
      if (typeof cached.lat === 'number' && typeof cached.lng === 'number') out.set(k, { lat: cached.lat, lng: cached.lng });
      continue; // present (positive or negative) → don't re-geocode
    }
    misses.push({ key: k, str: addrString(it) });
  }
  // Geocode the misses with bounded concurrency, writing each ANSWER (coords, or a negative
  // marker for ZERO_RESULTS) back to the cache so it's a one-time cost. An error writes
  // nothing — see geocodeOne — so the address is retried by the next scan.
  const conc = 5;
  let idx = 0;
  const worker = async () => {
    while (idx < misses.length) {
      const { key, str } = misses[idx++];
      const res = await geocodeOne(str);
      if (res.status === 'error') { console.warn(`[geocode] ${str}: ${res.reason} — not cached, will retry next scan`); continue; }
      try {
        await setDoc(`${CACHE}/${key}`, res.status === 'found'
          ? { lat: res.pt.lat, lng: res.pt.lng, addr: str, ts: new Date().toISOString() }
          : { failed: true, addr: str, ts: new Date().toISOString() });
      } catch { /* cache write best-effort */ }
      if (res.status === 'found') out.set(key, res.pt);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}
