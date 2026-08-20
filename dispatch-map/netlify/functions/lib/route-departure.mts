// lib/route-departure.mts
//
// WHEN DOES THIS ROUTE ACTUALLY LEAVE? — replacing a number we made up with one we measured.
//
// The arrival walk starts every route at an assumed 8:00a. On the night of 2026-08-19 that
// assumption sent three texts, and at least two were wrong in the same direction: BHW SHEET
// METAL was predicted for 1:58p against a 1:30p close and was DELIVERED AT 5:04a, because
// route WILLIAM had rolled at 3:42a. FABLE HOMEGOODS read 117 minutes late at 2:00a and
// cleared itself at 6:18a the moment route JEAN's first real stamp re-anchored the chain.
//
// Measured over sealed history, the fleet departs at a median of 08:23 — so 8:00 is a fair
// guess for the MIDDLE and badly wrong in the tails (p10 05:46, p90 13:50). Overnight is
// exactly when there are no stamps to correct it, so the tails are where the texts come
// from. Routes here are named for the driver who runs them and recur daily, which is what
// makes a per-route habit learnable at all.
//
// WHAT IS MEASURED, and the honesty rules around it:
//   * Only routes whose FIRST SEQUENCED STOP carries a real same-day stamp are sampled.
//     Backing a departure out of a later stop would have to assume the service time and
//     every leg before it — three guesses stacked to correct one. One clean subtraction
//     (first arrival minus the depot leg) or no sample at all.
//   * A route needs MIN_SAMPLES independent days before its learned time is used. Below
//     that the shipped 8:00a default stands, because a habit measured once is an anecdote.
//   * Learned values are clamped to a plausible operating window. A corrupt stamp must not
//     be able to tell the board a truck left at 11pm.
//   * The median, not the mean: one 2pm re-dispatch should not drag a 4am route's habit.
import { DEFAULT_CURVE, legMinutesFromMeters } from '../../../src/lib/travel-model.js';

/** A route needs this many clean days before its measured departure outranks the default. */
export const MIN_SAMPLES = 3;
/** Plausible operating window for a departure, ET minutes past midnight: 2:00a - 4:00p. */
export const MIN_DEPART_MIN = 120;
export const MAX_DEPART_MIN = 16 * 60;
export const DEPARTURE_COLLECTION = 'route_departures';
export const DEPARTURE_VERSION = 1;

export function routeDeparturePath(tenant: string): string {
  return `${DEPARTURE_COLLECTION}/${tenant}`;
}

const R_EARTH = 6371000;
function haversineMeters(a: any, b: any): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export interface RouteEntry { pos: { lat: number; lng: number } | null; stampMin: number | null; seq: number | null }

/**
 * PURE. One day's implied departure for one route, or null when it cannot be read cleanly.
 * `entries` is the same shape the nightly calibration already builds per route.
 */
export function impliedDeparture(
  entries: RouteEntry[],
  depot: { lat: number; lng: number },
  curve?: any,
): number | null {
  const sequenced = (entries || []).filter((e) => Number.isFinite(e?.seq as any) && e?.pos);
  if (!sequenced.length) return null;
  sequenced.sort((a, b) => (a.seq as number) - (b.seq as number));
  const first = sequenced[0];
  // The first stop of the route must be the one that reported, or the subtraction below
  // would be correcting for legs and service we would have to invent.
  if (!Number.isFinite(first.stampMin as any)) return null;
  const legMin = legMinutesFromMeters(haversineMeters(depot, first.pos), curve || DEFAULT_CURVE);
  if (!Number.isFinite(legMin)) return null;
  const dep = Math.round((first.stampMin as number) - legMin);
  return dep >= MIN_DEPART_MIN && dep <= MAX_DEPART_MIN ? dep : null;
}

/** PURE. Lower median — deterministic, and never invents a value between two samples. */
export function medianOf(xs: number[]): number | null {
  if (!xs || !xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) / 2)];
}

/**
 * PURE. Fold a window of per-day samples into the table the board reads.
 * `daySamples` is [{ date, byRoute: { routeKey: departMin } }, ...] in any order.
 * Routes below MIN_SAMPLES are OMITTED rather than published with a weak number — the
 * caller then falls back to the shipped default, which is the honest behaviour.
 */
export function departureTable(
  daySamples: Array<{ date?: string; byRoute?: Record<string, number> }>,
  { minSamples = MIN_SAMPLES }: { minSamples?: number } = {},
): Record<string, { departMin: number; n: number; spreadMin: number | null }> {
  const acc = new Map<string, number[]>();
  for (const d of daySamples || []) {
    for (const [k, v] of Object.entries(d?.byRoute || {})) {
      if (!Number.isFinite(v)) continue;
      if (v < MIN_DEPART_MIN || v > MAX_DEPART_MIN) continue;
      if (!acc.has(k)) acc.set(k, []);
      acc.get(k)!.push(v as number);
    }
  }
  const out: Record<string, { departMin: number; n: number; spreadMin: number | null }> = {};
  for (const [k, xs] of acc) {
    if (xs.length < minSamples) continue;
    const med = medianOf(xs);
    if (med == null) continue;
    const sorted = [...xs].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))];
    const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
    out[k] = { departMin: med, n: xs.length, spreadMin: Number.isFinite(p90 - p10) ? p90 - p10 : null };
  }
  return out;
}

/**
 * PURE. The lookup the engine uses: a route's learned departure, else null so the caller
 * keeps its own default. Route keys are matched case-insensitively and trimmed, because a
 * board key is a human-typed load name and "JEAN " and "jean" are the same truck.
 */
export function departureLookup(table: Record<string, any> | null | undefined): (routeKey: string) => number | null {
  const norm = (k: any) => String(k ?? '').trim().toLowerCase();
  const byKey = new Map<string, number>();
  for (const [k, v] of Object.entries(table || {})) {
    const m = Number(v?.departMin ?? v);
    if (Number.isFinite(m) && m >= MIN_DEPART_MIN && m <= MAX_DEPART_MIN) byKey.set(norm(k), m);
  }
  return (routeKey: string) => {
    const hit = byKey.get(norm(routeKey));
    return Number.isFinite(hit as any) ? (hit as number) : null;
  };
}
