// lib/osrm-matrix.mts
//
// TRUCK ROAD TIMES FROM OUR OWN ROUTING SERVICE — the third drive-time source for a Build, beside
// the free straight-line estimate (haversineMatrix: 1.3 x crow-flies at ~30 mph) and paid Google.
//
// The service is OSRM on Google Cloud Run (osrm-truck, us-east1, project davismarginiq): Georgia
// map only, tractor-trailer profile, private. Nothing in this repo deploys it. It is OFF until
// OSRM_TRUCK_URL is set on the site; with it unset nothing here makes a call.
//
// WHAT IT KNOWS, AND WHAT IT DOES NOT: real road miles and minutes on truck-legal roads, so a Build
// can see a lake, a river or a limited-access highway that a straight line cannot. No traffic, and
// only the truck restrictions someone has put on the map.
//
// ITS TABLE SERVICE, measured on the deployed version (v26.9.0) and checked against OSRM's docs:
//   GET {base}/table/v1/driving/{lng},{lat};{lng},{lat};...?annotations=duration,distance
//   - LONGITUDE FIRST. A swapped pair is still a valid point (somewhere else), so a swap gives
//     plausible numbers on the wrong roads; the order is pinned by a test.
//   - durations[i][j] seconds, distances[i][j] metres, decimals; the diagonal is 0; a pair with no
//     route is null.
//   - sources[i].distance: how far point i was moved to reach a road. OSRM NEVER refuses a far-away
//     point — one 19 km out to sea came back "Ok" with ordinary-looking times. So that number is
//     the only tell that a stop is off the map (outside Georgia, or nowhere near a truck road).
//   - more than 200 points: HTTP 400 "TooBig". A Build is capped at 150 stops + the depot.
//
// THE RULES THIS MODULE KEEPS, each so a bad answer can never pass for a good one:
//   - The answer to a matrix is whole seconds and metres (the Google path stores integers), depot
//     first. An answer that is not "Ok", not (stops + 1) square, or without a snap distance for
//     every point is a FAILED call — never a partial matrix.
//   - A null or non-finite pair takes the straight-line estimate for that pair, never 0: a free
//     leg is the cheapest leg on the board and the order gets built around a road that does not
//     exist (A5-S27-4, the same rule the Google path keeps).
//   - A stop moved more than OFF_MAP_SNAP_METERS to reach a road is OFF THE MAP: every pair
//     involving it takes the estimate. The depot off the map is a failed call.
//   - The result counts what it estimated, so the Build's readout can say so.
import { idTokenFor } from './google-id-token.mts';

export interface LatLng { lat: number; lng: number }
export interface Matrix { durationSec: number[][]; distanceMeters: number[][] }

/** A stop moved further than this to reach a road is off the truck map. */
export const OFF_MAP_SNAP_METERS = 1000;
/** One budget for the whole call — the ID token and the table together — inside the Build's 25 s watchdog. */
export const OSRM_TIMEOUT_MS = 15_000;

export interface OsrmDetail {
  /** Off-diagonal pairs that took the straight-line estimate, for any reason. */
  estimatedPairs: number;
  /** Of those, pairs between two on-map points that OSRM had no route for (null / non-finite). */
  noRoutePairs: number;
  /** Stops (0-based, in the order handed in) moved more than OFF_MAP_SNAP_METERS to reach a road. */
  offMapStops: Array<{ index: number; snapMeters: number }>;
}

export type OsrmFailure = 'off' | 'token' | 'timeout' | 'http' | 'malformed' | 'depot-off-map' | 'network';
export class OsrmError extends Error {
  kind: OsrmFailure;
  status: number | null;
  constructor(kind: OsrmFailure, message: string, status: number | null = null) { super(message); this.name = 'OsrmError'; this.kind = kind; this.status = status; }
}

/**
 * PURE. OSRM_TRUCK_URL as the base URL, or null when it is not configured.
 * Trimmed, trailing slashes removed, https only, no path, query, fragment or credentials.
 * Anything else is "not configured" — a path would make every table URL wrong, and the same
 * string is the ID token's audience, which Cloud Run compares exactly (a wrong one answers 401).
 */
export function osrmBaseUrl(env: any = process.env): string | null {
  const raw = String(env?.OSRM_TRUCK_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname && u.pathname !== '/') return null;
  if (raw.includes('?') || raw.includes('#')) return null;
  return u.origin;
}

const coord = (p: LatLng): string => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`;

/** PURE. The table URL: lng,lat to 6 decimals, joined by semicolons, depot first. */
export function osrmTableUrl(base: string, depot: LatLng, stops: LatLng[]): string {
  return `${base}/table/v1/driving/${[depot, ...stops].map(coord).join(';')}?annotations=duration,distance`;
}

const finiteNonNeg = (v: any): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * PURE. OSRM's table answer → a whole-number matrix, depot first, with what it had to estimate.
 * `estimate` is the straight-line matrix for the same nodes (haversineMatrix(depot, stops)).
 * Throws OsrmError on any answer that is not a whole, usable matrix.
 */
export function osrmMatrixFromAnswer(answer: any, stopCount: number, estimate: Matrix): { matrix: Matrix; detail: OsrmDetail } {
  const n = stopCount + 1;
  if (!answer || answer.code !== 'Ok') throw new OsrmError('malformed', `OSRM answered code ${JSON.stringify(answer?.code ?? null)}`);
  const { durations, distances, sources } = answer;
  const square = (m: any) => Array.isArray(m) && m.length === n && m.every((row: any) => Array.isArray(row) && row.length === n);
  if (!square(durations) || !square(distances)) throw new OsrmError('malformed', `OSRM answer is not ${n} x ${n}`);
  if (!Array.isArray(sources) || sources.length !== n || !sources.every((s: any) => finiteNonNeg(s?.distance))) {
    throw new OsrmError('malformed', 'OSRM answer has no snap distance for every point');
  }
  if (sources[0].distance > OFF_MAP_SNAP_METERS) {
    throw new OsrmError('depot-off-map', `the depot was moved ${Math.round(sources[0].distance)} m to reach a road`);
  }
  const offMap = new Set<number>();
  const offMapStops: OsrmDetail['offMapStops'] = [];
  for (let i = 1; i < n; i++) {
    if (sources[i].distance > OFF_MAP_SNAP_METERS) { offMap.add(i); offMapStops.push({ index: i - 1, snapMeters: Math.round(sources[i].distance) }); }
  }
  const durationSec = Array.from({ length: n }, () => new Array(n).fill(0));
  const distanceMeters = Array.from({ length: n }, () => new Array(n).fill(0));
  let estimatedPairs = 0, noRoutePairs = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const d = durations[i][j], m = distances[i][j];
    const off = offMap.has(i) || offMap.has(j);
    if (off || !finiteNonNeg(d) || !finiteNonNeg(m)) {
      durationSec[i][j] = estimate.durationSec[i][j];
      distanceMeters[i][j] = estimate.distanceMeters[i][j];
      estimatedPairs++;
      if (!off) noRoutePairs++;
      continue;
    }
    durationSec[i][j] = Math.round(d);
    distanceMeters[i][j] = Math.round(m);
  }
  return { matrix: { durationSec, distanceMeters }, detail: { estimatedPairs, noRoutePairs, offMapStops } };
}

const isAbort = (e: any) => e?.name === 'AbortError' || /aborted/i.test(String(e?.message || ''));

// The deadline covers the BODY too: fetchWithTimeout stops its clock when the headers arrive, and a
// body that stalls after them would hold the Build until its 25 s watchdog failed the whole build
// instead of falling back.
async function getWithin(url: string, headers: Record<string, string>, ms: number): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    return { status: resp.status, text: resp.status === 200 ? await resp.text() : '' };
  } finally { clearTimeout(t); }
}

/**
 * One table call: the ID token, then one GET with Authorization: Bearer, inside one
 * OSRM_TIMEOUT_MS budget (token, headers and body together). Throws OsrmError (kind says why) on
 * anything but a usable answer. Returns the raw answer and the HTTP status.
 */
export async function fetchOsrmTable(depot: LatLng, stops: LatLng[], opts: { env?: any; timeoutMs?: number } = {}): Promise<{ answer: any; httpStatus: number }> {
  const base = osrmBaseUrl(opts.env ?? process.env);
  if (!base) throw new OsrmError('off', 'OSRM_TRUCK_URL not set (or not an https address without a path)');
  const budget = opts.timeoutMs ?? OSRM_TIMEOUT_MS;
  const started = Date.now();
  let token: string;
  try { token = await idTokenFor(base, { timeoutMs: budget }); }
  catch (e: any) {
    // A slow token exchange is Google's token endpoint, not a cold Cloud Run instance: never 'timeout'.
    if (isAbort(e)) throw new OsrmError('token', `ID token exchange timed out after ${budget} ms`);
    throw new OsrmError('token', String(e?.message || e).slice(0, 160), e?.status ?? null);
  }
  const left = Math.max(1, budget - (Date.now() - started));
  let got: { status: number; text: string };
  try {
    got = await getWithin(osrmTableUrl(base, depot, stops), { Authorization: `Bearer ${token}` }, left);
  } catch (e: any) {
    if (isAbort(e)) throw new OsrmError('timeout', `OSRM did not answer within ${budget} ms`);
    throw new OsrmError('network', `OSRM request failed: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (got.status !== 200) throw new OsrmError('http', `OSRM answered HTTP ${got.status}`, got.status);
  let answer: any;
  try { answer = JSON.parse(got.text); } catch { throw new OsrmError('malformed', 'OSRM answer is not JSON', 200); }
  return { answer, httpStatus: got.status };
}

/** The full (depot + stops) truck-road matrix. Throws OsrmError rather than return a partial one. */
export async function buildMatrixViaOsrm(depot: LatLng, stops: LatLng[], estimate: Matrix, opts: { env?: any; timeoutMs?: number } = {}): Promise<{ matrix: Matrix; detail: OsrmDetail }> {
  const { answer } = await fetchOsrmTable(depot, stops, opts);
  const out = osrmMatrixFromAnswer(answer, stops.length, estimate);
  if (out.detail.estimatedPairs > 0) {
    console.warn(`osrm-matrix: ${out.detail.estimatedPairs} of ${(stops.length + 1) * stops.length} legs took the road estimate (${out.detail.offMapStops.length} stop(s) off the truck map, ${out.detail.noRoutePairs} leg(s) with no truck route)`);
  }
  return out;
}
