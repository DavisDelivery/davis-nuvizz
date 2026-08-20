// lib/travel-store.mts — the server half of the travel model: cached real drive times and
// the nightly-calibrated speed curve.
//
// Chad: "we shouldn't be using straight line distances surely we can come up with a better
// way. That is also not going to be expensive to do." The cost discipline is the design:
//
//   • ONE Firestore doc holds every cached leg. A leg is fetched from Google ONCE and then
//     reused across sweeps, across days, and across the recurring customers who make up
//     most of this board. Steady state is a handful of new legs a day.
//   • Google is asked per-pair (1×1 = one billed element each), NEVER as an N×N matrix —
//     the flag walk needs consecutive legs only, and a 150-stop board is ~150 elements on
//     a cold day, comfortably inside the Routes API free tier. A per-sweep cap bounds the
//     worst case; anything past the cap rides the curve this sweep and is cached the next.
//   • No key → no calls, no errors: everything degrades to the calibrated curve.
//
// ZERO NuVizz calls anywhere in this file.
import { getDoc, setDoc } from './firestore.mts';
import { fetchWithTimeout } from './async-util.mts';
import { curveFromDoc } from '../../../src/lib/travel-model.js';

export const TRAVEL_LEGS_COLLECTION = 'travel_legs';
export const TRAVEL_CAL_COLLECTION = 'travel_calibration';

export function travelLegsPath(tenant: string): string {
  return `${TRAVEL_LEGS_COLLECTION}/${tenant}__current`;
}
export function travelCalDayPath(tenant: string, date: string): string {
  return `${TRAVEL_CAL_COLLECTION}/${tenant}__${date}`;
}
export function travelCalCurrentPath(tenant: string): string {
  return `${TRAVEL_CAL_COLLECTION}/${tenant}__current`;
}

// Cache limits. ~60 bytes/leg keeps 3000 legs near 200 KB — far under the 1 MB doc cap,
// far over a season of distinct legs on this board.
export const MAX_CACHED_LEGS = 3000;
export const LEG_TTL_DAYS = 45;
// A leg Google could not answer is cached too — as sec 0 — so the same unroutable pair
// (a geocode in a lake, a coordinate Google has no road to) does not eat a billed fetch
// out of the cap on EVERY sweep for ever. Failures age out fast so a transient API blip
// gets retried tomorrow rather than never.
export const FAILED_LEG_TTL_DAYS = 1;
export const MAX_GOOGLE_FETCH_PER_SWEEP = 60;

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const GOOGLE_TIMEOUT_MS = 6000;

export function isGoogleRoutesEnabled(): boolean {
  return !!process.env.GOOGLE_ROUTES_API_KEY;
}

function parseDuration(s: any): number {
  if (typeof s === 'number') return s;
  const m = String(s ?? '').match(/^(\d+(?:\.\d+)?)s$/);
  return m ? Math.round(Number(m[1])) : 0;
}

/** One real drive time, a→b. Returns seconds, or null on any failure — a leg the API
 *  cannot answer is a leg the curve answers, never an error the sweep has to survive. */
export async function fetchLegSeconds(a: { lat: number; lng: number }, b: { lat: number; lng: number }, apiKey: string): Promise<number | null> {
  try {
    const wp = (p: any) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const resp = await fetchWithTimeout(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition',
      },
      body: JSON.stringify({ origins: [wp(a)], destinations: [wp(b)], travelMode: 'DRIVE' }),
    }, GOOGLE_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const rows = Array.isArray(data) ? data : (data?.elements || []);
    const sec = parseDuration(rows?.[0]?.duration);
    return sec > 0 && sec < 6 * 3600 ? sec : null;
  } catch {
    return null;
  }
}

export interface LegEntry { sec: number; at: string }
export interface LegDoc { tenant?: string; legs?: Record<string, LegEntry>; updated_at?: string }

/**
 * PURE. Merge freshly fetched legs into the cache doc and prune it. Pruning is by age
 * first (a 45-day-old drive time is stale road data), then oldest-first down to the cap —
 * so a route that stopped existing ages out instead of squatting on the doc for ever.
 */
export function mergeLegCache(prev: LegDoc | null, fetched: Record<string, number>, nowISO: string): LegDoc {
  const legs: Record<string, LegEntry> = { ...(prev?.legs || {}) };
  for (const [k, sec] of Object.entries(fetched)) {
    // sec 0 is the failure tombstone; anything non-finite or negative is refused outright.
    if (Number.isFinite(sec) && sec >= 0) legs[k] = { sec: Math.round(sec), at: nowISO };
  }
  const cutoff = new Date(new Date(nowISO).getTime() - LEG_TTL_DAYS * 86400000).toISOString();
  const failedCutoff = new Date(new Date(nowISO).getTime() - FAILED_LEG_TTL_DAYS * 86400000).toISOString();
  for (const [k, v] of Object.entries(legs)) {
    const ttlCutoff = Number.isFinite(v?.sec) && v.sec > 0 ? cutoff : failedCutoff;
    if (!v?.at || v.at < ttlCutoff) delete legs[k];
  }
  const keys = Object.keys(legs);
  if (keys.length > MAX_CACHED_LEGS) {
    keys.sort((x, y) => String(legs[x].at).localeCompare(String(legs[y].at)));
    for (const k of keys.slice(0, keys.length - MAX_CACHED_LEGS)) delete legs[k];
  }
  return { legs, updated_at: nowISO };
}

/** The compact {key: seconds} map the engine and the browser consume. */
export function legSecondsMap(doc: LegDoc | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(doc?.legs || {})) {
    if (Number.isFinite(v?.sec) && v.sec > 0) out[k] = v.sec;
  }
  return out;
}

/**
 * Fill the cache for the legs a board walk said it wants. Reads the doc, fetches at most
 * `cap` missing legs from Google (when the key exists), writes the doc back if anything
 * changed. Returns the up-to-date {key: seconds} map either way.
 */
export async function ensureLegs(
  tenant: string,
  wanted: Array<{ key: string; a: { lat: number; lng: number }; b: { lat: number; lng: number } }>,
  { cap = MAX_GOOGLE_FETCH_PER_SWEEP, now = new Date() }: { cap?: number; now?: Date } = {},
): Promise<{ legs: Record<string, number>; fetched: number; missing: number; googleEnabled: boolean; readFailed?: boolean }> {
  // ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS. getDoc returns null for a doc that does
  // not exist and THROWS on a 503/auth blip — and treating the throw as "empty cache"
  // would re-bill up to a whole cap of Google fetches and then REPLACE the doc with only
  // those, silently discarding every leg ever cached. On a failed read this sweep rides
  // the curve, touches nothing, and the next sweep finds the cache intact.
  let doc: LegDoc | null = null;
  try {
    doc = await getDoc(travelLegsPath(tenant));
  } catch {
    return { legs: {}, fetched: 0, missing: 0, googleEnabled: isGoogleRoutesEnabled(), readFailed: true };
  }
  const have = legSecondsMap(doc);
  const googleEnabled = isGoogleRoutesEnabled();
  // "Attempted" includes the failure tombstones — a leg that failed yesterday is not
  // fetched again today just because the engine cannot use it.
  const attempted = new Set(Object.keys(doc?.legs || {}));
  const missing = (wanted || []).filter((w) => w?.key && !attempted.has(w.key));

  if (!googleEnabled || !missing.length) {
    return { legs: have, fetched: 0, missing: missing.length, googleEnabled };
  }

  const key = process.env.GOOGLE_ROUTES_API_KEY as string;
  const toFetch = missing.slice(0, cap);
  const fetched: Record<string, number> = {};
  const CONC = 8;
  for (let i = 0; i < toFetch.length; i += CONC) {
    await Promise.all(toFetch.slice(i, i + CONC).map(async (w) => {
      const sec = await fetchLegSeconds(w.a, w.b, key);
      fetched[w.key] = sec != null ? sec : 0;   // 0 = tombstone, see FAILED_LEG_TTL_DAYS
    }));
  }

  if (Object.keys(fetched).length) {
    const merged = mergeLegCache(doc, fetched, now.toISOString());
    // setDoc REPLACES, and that is correct here: this job is the doc's only writer and
    // the merge above already carried every surviving entry forward.
    await setDoc(travelLegsPath(tenant), { tenant, ...merged }).catch(() => { /* cache write is best-effort */ });
    return { legs: legSecondsMap(merged), fetched: Object.values(fetched).filter((v) => v > 0).length, missing: missing.length, googleEnabled };
  }
  return { legs: have, fetched: 0, missing: missing.length, googleEnabled };
}

/** The calibrated curve for the engine: { curve (as [at,mph] PAIRS), serviceMin } or null.
 *  The doc stores the curve as an array of maps — Firestore forbids nested arrays — so
 *  the translation back to pairs happens HERE, once, before any consumer sees it. */
export async function readTravelCalibration(tenant: string): Promise<any | null> {
  try {
    const doc = await getDoc(travelCalCurrentPath(tenant));
    const curve = curveFromDoc(doc?.curve);
    return curve ? { ...doc, curve } : null;
  } catch {
    return null;
  }
}
