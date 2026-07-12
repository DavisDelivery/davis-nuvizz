// lib/zones.mts
//
// ZONE LAYER for the learned routing engine. Amazon's challenge data shipped
// with human zone IDs; Davis data has none, so we manufacture zones from
// geohash prefixes — a pure function of the coordinate. Zones are COMPUTED,
// never stored per stop, so re-zoning is a config change, not a migration.
//
//   zoneId  — geohash precision 6 (~0.7 km cell): stops that share one are
//             forced consecutive by the solver (HARD constraint).
//   superId — precision 5: the mid hierarchy level (soft contiguity penalty).
//   topId   — precision 4: the coarse level.
//
// The prefix property (zone startsWith super startsWith top) is what makes the
// hierarchy free: super/top of a zone are just slices of the zone string.
// Precisions live in routing_engine_config (env fallback), not at call sites.
//
// Geohash is implemented inline (the standard base32 interleaved bisection) —
// ~30 lines, no new dependency. Pure and shared: the client can import these
// helpers or mirror them; nothing here touches I/O.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

// PURE: standard geohash encoding of a WGS84 coordinate at `precision` chars.
export function geohashEncode(lat: number, lng: number, precision: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || precision < 1) return '';
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0, ch = 0, evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch = ch * 2 + 1; lngMin = mid; } else { ch = ch * 2; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = ch * 2 + 1; latMin = mid; } else { ch = ch * 2; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { hash += BASE32.charAt(ch); bit = 0; ch = 0; }
  }
  return hash;
}

export interface ZonePrecisions {
  zone_precision: number;
  super_precision: number;
  top_precision: number;
}

export const DEFAULT_ZONE_PRECISIONS: ZonePrecisions = {
  zone_precision: 6, super_precision: 5, top_precision: 4,
};

export function zoneId(lat: number, lng: number, p: ZonePrecisions = DEFAULT_ZONE_PRECISIONS): string {
  return geohashEncode(lat, lng, p.zone_precision);
}
export function superId(lat: number, lng: number, p: ZonePrecisions = DEFAULT_ZONE_PRECISIONS): string {
  return geohashEncode(lat, lng, p.super_precision);
}
export function topId(lat: number, lng: number, p: ZonePrecisions = DEFAULT_ZONE_PRECISIONS): string {
  return geohashEncode(lat, lng, p.top_precision);
}

// PURE: hierarchy levels straight off a zone id (the prefix property). When the
// configured precisions overlap oddly (super ≥ zone), the slice degrades to the
// full zone id rather than inventing characters.
export function superOfZone(zone: string, p: ZonePrecisions = DEFAULT_ZONE_PRECISIONS): string {
  return zone.slice(0, Math.min(p.super_precision, zone.length));
}
export function topOfZone(zone: string, p: ZonePrecisions = DEFAULT_ZONE_PRECISIONS): string {
  return zone.slice(0, Math.min(p.top_precision, zone.length));
}

// PURE: collapse consecutive duplicates — [a,a,b,a,c,c] → [a,b,a,c]. Used for
// zone visit sequences (a route "visits" a zone once per contiguous run).
export function collapseConsecutive(seq: string[]): string[] {
  const out: string[] = [];
  for (const z of seq || []) {
    if (!z) continue;
    if (out.length === 0 || out[out.length - 1] !== z) out.push(z);
  }
  return out;
}
