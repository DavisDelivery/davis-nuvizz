// src/lib/travel-model.js — how long a leg between two stops actually takes.
//
// Chad, Aug 2026: "we shouldn't be using straight line distances surely we can come up
// with a better way. That is also not going to be expensive to do."
//
// WHAT WAS WRONG WITH THE OLD MODEL. Every leg was haversine × 1.3 at a flat ~30 mph —
// one speed for a 0.6-mile hop between two docks in Duluth and a 38-mile run out to
// Monroe. Real driving is not flat: short hops are dominated by lights, turns and lot
// entrances (effective speed over the crow-flies line ~12-16 mph), long legs ride the
// highway (~45+ mph). A flat 30 therefore UNDERSTATES urban legs (misses real risk in
// town) and OVERSTATES rural ones (cries wolf on exactly the far-out stops whose flags
// read "307 min late"). Both failure directions cost attention, in opposite ways.
//
// THE BETTER WAY, in two layers, cheapest-first:
//
//   1. A DISTANCE-TIERED SPEED CURVE — effective straight-line speed as a function of leg
//      length, piecewise-linear between control points. Costs nothing to run, works
//      offline, and is CALIBRATED nightly from Davis's own sealed history: consecutive
//      same-route arrival stamps give (distance, elapsed) pairs, thousands of them, from
//      the trucks that actually drive these roads. Literature-shaped defaults carry any
//      bucket the data cannot yet support.
//
//   2. REAL GOOGLE DRIVE TIMES PER LEG, where the server has cached one. The routing
//      engine already holds a Routes API key; the flag sweep asks for the handful of legs
//      on today's boards (~150/day, cached in Firestore and reused across sweeps, days and
//      recurring customers — comfortably inside the API free tier, and $0 marginal when
//      the key is absent: everything falls back to layer 1).
//
// PURE MATH ONLY. No fetch, no Firestore, no Date.now — callers inject data and clocks.
// Imported by the browser bundle AND by Netlify functions (same pattern as board-flags).

// ── THE CURVE ────────────────────────────────────────────────────────────────
//
// Control points: [straight-line miles, effective mph over that straight line]. The mph
// FOLDS CIRCUITY IN — it is crow-flies distance over door-to-door drive time, so there is
// no separate ×1.3 road factor to double-count. Piecewise-linear between points, clamped
// flat outside them.
//
// These defaults are literature-shaped (urban last-mile effective speeds at the short
// end, interstate at the long end) and exist to be OVERWRITTEN: the nightly calibration
// fits the real curve from Davis's own sealed stamps and the engine prefers that fit;
// eta-backtest ?fit=1 grades both against history on demand. The old flat model is
// ~23 mph effective straight-line (30 / 1.3) at every distance; this curve crosses that
// around 4–6 miles and diverges hard at both ends — which is the entire point.
export const DEFAULT_CURVE = [
  [0.35, 11],
  [0.75, 13],
  [1.5, 16],
  [3, 20],
  [6, 25],
  [11, 31],
  [22, 39],
  [40, 47],
];

export const MPH_MIN = 8;    // slower than this is a parking lot, not a road
export const MPH_MAX = 60;   // faster (crow-flies!) than this is a data error
const METERS_PER_MILE = 1609.344;

// ── SHAPE SAFETY ─────────────────────────────────────────────────────────────
//
// The curve crosses two trust boundaries — a Firestore doc and an HTTP payload — and a
// malformed point surviving either would put NaN into every route's clock, at which point
// `clockMin > closeMin` is false for every stop and the whole board goes silently blind
// while still reporting how many routes it "judged". The adversarial review produced that
// exact state with one mis-shaped doc. So: nothing reaches the interpolator unsanitized.

/** Accepts pairs [[at,mph],…] OR doc maps [{at,mph},…]; returns clean, sorted, clamped
 *  pairs — or null when nothing usable survives (callers then use DEFAULT_CURVE). */
export function sanitizeCurve(raw) {
  if (!Array.isArray(raw)) return null;
  const pts = [];
  for (const p of raw) {
    const at = Array.isArray(p) ? Number(p[0]) : Number(p?.at);
    const mph = Array.isArray(p) ? Number(p[1]) : Number(p?.mph);
    if (!Number.isFinite(at) || at <= 0 || at > 200) continue;
    if (!Number.isFinite(mph)) continue;
    pts.push([at, Math.min(MPH_MAX, Math.max(MPH_MIN, mph))]);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of pts) if (!out.length || p[0] > out[out.length - 1][0]) out.push(p);
  return out.length ? out : null;
}

// FIRESTORE CANNOT STORE AN ARRAY INSIDE AN ARRAY. [[0.35,11],…] written naively is a 400
// on every nightly run, caught, logged where nobody reads, and indistinguishable from
// "no data yet" — the calibration would have shipped dead. So the DOC shape is an array
// of maps, and these two are the only translation.
export function curveToDoc(curve) {
  const clean = sanitizeCurve(curve) || [];
  return clean.map(([at, mph]) => ({ at, mph }));
}
export function curveFromDoc(v) {
  return sanitizeCurve(v);
}

/** Effective straight-line mph for a leg of `meters`, on `curve` (default: shipped). */
export function curveMph(meters, curve = DEFAULT_CURVE) {
  const pts = sanitizeCurve(curve) || DEFAULT_CURVE;
  const mi = Number(meters) / METERS_PER_MILE;
  if (!Number.isFinite(mi) || mi <= 0) return pts[0][1];
  if (mi <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (mi <= pts[i][0]) {
      const [d0, v0] = pts[i - 1];
      const [d1, v1] = pts[i];
      const t = (mi - d0) / (d1 - d0);
      return v0 + t * (v1 - v0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Minutes to drive a straight-line leg of `meters`. 0 for a zero/absent leg. */
export function legMinutesFromMeters(meters, curve = DEFAULT_CURVE) {
  const mi = Number(meters) / METERS_PER_MILE;
  if (!Number.isFinite(mi) || mi <= 0) return 0;
  return (mi / curveMph(meters, curve)) * 60;
}

// ── GOOGLE LEG LOOKUP ────────────────────────────────────────────────────────
//
// Legs are keyed by DIRECTIONAL rounded coordinates — 3 decimals ≈ a 100 m grid, tight
// enough that two different docks get different legs, loose enough that geocode jitter
// does not miss the cache. Directional because divided highways and one-ways make A→B and
// B→A genuinely different drives.
export function legKey(a, b) {
  const f = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'x');
  return `${f(a?.lat)},${f(a?.lng)}|${f(b?.lat)},${f(b?.lng)}`;
}

/**
 * Minutes for the leg a→b: a cached real drive time when the map holds one, the curve
 * otherwise. `meters` is the caller's haversine (it already computed it).
 * travel = { legs?: {legKey: seconds}, curve?: control points } — both optional.
 */
export function resolveLegMinutes(a, b, meters, travel) {
  const sec = travel?.legs ? travel.legs[legKey(a, b)] : undefined;
  if (Number.isFinite(sec) && sec > 0 && sec < 6 * 3600) {
    return { min: sec / 60, source: 'google' };
  }
  return { min: legMinutesFromMeters(meters, travel?.curve), source: 'curve' };
}

// ── CALIBRATION ──────────────────────────────────────────────────────────────
//
// Input: consecutive same-route stamp pairs off a SEALED day — { meters, gapMin } where
// gapMin is arrival(B) − arrival(A). The gap contains stop A's service time plus the
// drive; the fit separates them by iterating: assume a service, fit speeds, re-measure
// service against the fitted curve, fit once more. Two passes, deterministic.

export const BUCKET_EDGES_MI = [0, 0.5, 1, 2, 4, 8, 15, 30, Infinity];
export const MIN_BUCKET_SAMPLES = 30;   // fewer than this and the default speaks instead
// Stamp gaps cannot RESOLVE speed on short legs: a sub-2-mile drive is 2-6 minutes inside
// a gap whose dwell component wanders by ±7-8, so whatever survives any noise filter is
// dwell residue wearing a speed costume. Tried and measured during review — a synthetic
// TRUE-12-mph town produced a "measured" 4-6 mph every time. Below this line the default
// speaks, honestly labelled, no matter how many samples pile up.
export const MIN_MEASURABLE_MI = 2;
export const MIN_MEASURABLE_TRAVEL_MIN = 4;
export const SERVICE_DEFAULT_MIN = 14;  // the shipped flag service block

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) / 2)];
};

/** One admissible sample under an assumed service time, or null if it is noise.
 *
 * THE NOISE FLOOR IS DISTANCE-AWARE, and this is load-bearing. A flat "travel must be at
 * least 3 minutes" floor sounds harmless and structurally CENSORS every short bucket: no
 * admissible sub-half-mile sample can read above 10 mph, so the fit would have measured
 * town speeds as "slow" no matter how the trucks actually drove, labelled it measured,
 * and drifted the board toward cry-wolf morning flags with no deploy and no failing test.
 * The floor is instead a fraction of what the default curve says the drive should take —
 * a genuine 90-second hop survives, a double-tap (near-zero gap) still does not. */
function admissibleSample(sample, serviceMin) {
  const mi = Number(sample?.meters) / METERS_PER_MILE;
  const travel = Number(sample?.gapMin) - serviceMin;
  if (!Number.isFinite(mi) || mi < 0.15 || mi > 90) return null;
  const expected = legMinutesFromMeters(mi * METERS_PER_MILE, DEFAULT_CURVE);
  const floor = Math.max(0.75, expected * 0.35);
  // A lunch break or a missed stamp shows up as a 3-hour "leg"; neither is a road.
  if (!Number.isFinite(travel) || travel < floor || travel > 150) return null;
  const mph = (mi / travel) * 60;
  if (mph < 3 || mph > 75) return null;
  return { mi, travel };
}

/**
 * Fit the curve from samples. Returns { curve, buckets, serviceMin, n } where `buckets`
 * is the per-bucket provenance the endpoint and the screen can show: what was measured,
 * what is actually being used, and why.
 */
export function fitCurve(samples, { defaults = DEFAULT_CURVE, serviceMin = SERVICE_DEFAULT_MIN } = {}) {
  const list = Array.isArray(samples) ? samples : [];

  const passBuckets = (svc) => {
    const buckets = BUCKET_EDGES_MI.slice(0, -1).map((lo, i) => ({
      lo, hi: BUCKET_EDGES_MI[i + 1], travels: [], mis: [],
    }));
    for (const s of list) {
      const v = admissibleSample(s, svc);
      if (!v) continue;
      const b = buckets.find((k) => v.mi >= k.lo && v.mi < k.hi);
      if (b) { b.travels.push(v.travel); b.mis.push(v.mi); }
    }
    return buckets;
  };

  const curveFrom = (buckets) => {
    const pts = [];
    for (const b of buckets) {
      const at = median(b.mis) ?? (Number.isFinite(b.hi) ? (b.lo + b.hi) / 2 : b.lo * 1.4);
      // RATIO OF MEDIANS, not median of ratios. mph = mi/travel is a 1/x transform, and
      // taking the median of transformed values skews slow exactly where travel is small
      // (the short buckets, again). Median distance over median travel is robust to the
      // same outliers without the skew.
      const medTravel = median(b.travels);
      const resolvable = at >= MIN_MEASURABLE_MI && medTravel != null && medTravel >= MIN_MEASURABLE_TRAVEL_MIN;
      const measured = b.travels.length >= MIN_BUCKET_SAMPLES && resolvable
        ? (at / medTravel) * 60
        : null;
      const mph = measured != null ? measured : curveMph(at * METERS_PER_MILE, defaults);
      pts.push({ at, mph, n: b.travels.length, measured, lo: b.lo, hi: b.hi });
    }
    // ISOTONIC: effective speed may not fall as legs get longer. A measured inversion is
    // noise (a bucket of 31 samples through one bad intersection), and shipping it would
    // make a 9-mile leg predict SLOWER than a 7-mile one — cummax flattens it upward.
    let run = 0;
    for (const p of pts) {
      run = Math.max(run, Math.min(MPH_MAX, Math.max(MPH_MIN, p.mph)));
      p.used = run;
    }
    return pts;
  };

  // Pass 1 on the assumed service; re-measure service against that curve; pass 2 final.
  const pts1 = curveFrom(passBuckets(serviceMin));
  const curve1 = pts1.map((p) => [p.at, p.used]);
  const svcSamples = [];
  for (const s of list) {
    const mi = Number(s?.meters) / METERS_PER_MILE;
    const gap = Number(s?.gapMin);
    if (!Number.isFinite(mi) || mi < 0.15 || mi > 90) continue;
    if (!Number.isFinite(gap) || gap <= 0 || gap > 240) continue;
    const svc = gap - legMinutesFromMeters(s.meters, curve1);
    if (svc > -30 && svc < 120) svcSamples.push(svc);
  }
  const measuredService = median(svcSamples);
  const finalService = measuredService != null
    ? Math.min(30, Math.max(5, measuredService))
    : serviceMin;

  const pts = curveFrom(passBuckets(finalService));
  return {
    curve: pts.map((p) => [Math.round(p.at * 100) / 100, Math.round(p.used * 10) / 10]),
    buckets: pts.map((p) => ({
      range: `${p.lo}–${Number.isFinite(p.hi) ? p.hi : '∞'} mi`,
      n: p.n,
      measuredMph: p.measured != null ? Math.round(p.measured * 10) / 10 : null,
      usedMph: Math.round(p.used * 10) / 10,
      source: p.measured != null ? 'measured' : 'default',
    })),
    serviceMin: Math.round(finalService * 10) / 10,
    serviceMeasured: measuredService != null,
    n: list.length,
  };
}

/**
 * Consecutive same-route stamp pairs from one sealed day's stops. Caller supplies
 * position and stamp extraction (they live in board-flags/backtest land — importing them
 * here would cycle); this orders by stamp and pairs neighbours.
 * routes = Map<routeKey, Array<{ pos: {lat,lng}|null, stampMin: number|null, seq?: number|null }>>.
 *
 * WHEN SEQUENCE IS SUPPLIED, only seq-ADJACENT pairs count. Two stamps with an unstamped
 * stop between them measure A→X→B's drive plus X's whole dwell against A→B's straight
 * line — a sample that is only ever wrong in the slow direction, and with enough of them
 * the "measured" curve drifts slower than any truck. Routes without sequence still pair
 * by stamp order alone; the admissibility filters carry the residual risk there.
 */
export function legSamplesFromRoutes(routes) {
  const out = [];
  for (const [, stops] of routes) {
    const stamped = stops
      .filter((s) => s?.pos && Number.isFinite(s?.stampMin))
      .sort((a, b) => a.stampMin - b.stampMin);
    for (let i = 1; i < stamped.length; i++) {
      const a = stamped[i - 1], b = stamped[i];
      const haveSeq = Number.isFinite(a.seq) && Number.isFinite(b.seq);
      if (haveSeq && Math.abs(b.seq - a.seq) !== 1) continue;
      const meters = haversineM(a.pos, b.pos);
      const gapMin = b.stampMin - a.stampMin;
      if (meters > 0 && gapMin > 0) out.push({ meters: Math.round(meters), gapMin: Math.round(gapMin * 10) / 10 });
    }
  }
  return out;
}

// A local haversine so this module stays dependency-free both directions (routing-select
// imports nothing from here; board-flags imports this). Same math, same Earth.
function haversineM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
