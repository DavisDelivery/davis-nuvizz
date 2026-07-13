// lib/routing-envelope.mts
//
// PHASE 3 — AS-OF ENVELOPES, ZONE AFFINITY, FLEET TRIP-CHAIN CONSTANTS. Pure
// functions that, given a target date D and PRELOADED observation docs already
// filtered to dates < D, describe how a driver tends to load and where they
// tend to go — the priors the assignment solver optimizes against.
//
// Everything here is PURE and takes its inputs as arguments (the caller does the
// date < D filtering AND is re-checked here), so leakage is impossible by
// construction and unit-testable without Firestore. ZERO NuVizz calls.
//
// Capacity is per-DRIVER per-TRIP (verified: within tractors, day totals ranged
// 9.1K–18.8K lbs across four boards). A driver with fewer than
// min_observation_days of history falls back to a truck-class envelope computed
// the SAME way. Fleet trip-chain constants (far-first adherence, reload gap,
// trip-2 radius) are mined when history is thick enough, else seeded from the
// verified OPERATING FACTS via config.

import { superOfZone, type ZonePrecisions } from './zones.mts';
import { quantile, median } from './routing-service-times.mts';
import type { EngineConfig } from './routing-engine-config.mts';
import type { DriverDayDoc, DriverTrip } from './routing-driver-days.mts';
import type { ReferenceRouteDoc } from './routing-reference.mts';

// Wall-clock minute-of-day straight off the stamp text (no timezone re-projection
// — the executed stamps are already ET wall time; parsing HH:MM keeps "~4:00 AM"
// meaning 4:00 AM regardless of how Date would localize it).
export function wallMinuteOfDay(stamp: any): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(String(stamp ?? ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesBetween(aIso: any, bIso: any): number | null {
  const a = Date.parse(String(aIso ?? '')); const b = Date.parse(String(bIso ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60000;
}

// Time-ordered trips of a driver-day (seq_index set), sorted by seq.
function orderedTrips(day: DriverDayDoc): DriverTrip[] {
  return (day.trips || []).filter((t) => t.seq_index != null).sort((a, b) => (a.seq_index! - b.seq_index!));
}

export interface DriverEnvelope {
  driver_key: string;
  source: 'driver' | 'class' | 'none';
  truck_class: string | null;
  observed_days: number;
  per_trip: {
    stops_median: number | null; stops_p85: number | null;
    pallets_median: number | null; pallets_p85: number | null;
    weight_median: number | null; weight_p85: number | null;
  };
  trips_per_day_propensity: number;      // share of observed days with 2+ trips
  start_minute_typical: number | null;   // median first-touch minute-of-day
  shift_hours_typical: number | null;    // median (end - start) hours
  day_weight_p85: number | null;
}

function envelopeFromDays(days: DriverDayDoc[]): Omit<DriverEnvelope, 'driver_key' | 'source' | 'truck_class'> {
  const trips = days.flatMap((d) => (d.trips || []));
  const stops = trips.map((t) => t.stops);
  const pallets = trips.map((t) => t.pallets);
  const weight = trips.map((t) => t.weight);
  const starts = days.map((d) => wallMinuteOfDay(d.start_time)).filter((v): v is number => v != null);
  const shiftHours = days.map((d) => minutesBetween(d.start_time, d.end_time)).filter((v): v is number => v != null && v > 0).map((m) => m / 60);
  const dayWeights = days.map((d) => d.day_totals?.weight ?? 0);
  const multiTripDays = days.filter((d) => orderedTrips(d).length >= 2).length;
  return {
    observed_days: days.length,
    per_trip: {
      stops_median: median(stops), stops_p85: quantile(stops, 0.85),
      pallets_median: median(pallets), pallets_p85: quantile(pallets, 0.85),
      weight_median: median(weight), weight_p85: quantile(weight, 0.85),
    },
    trips_per_day_propensity: days.length ? multiTripDays / days.length : 0,
    start_minute_typical: median(starts),
    shift_hours_typical: median(shiftHours),
    day_weight_p85: quantile(dayWeights, 0.85),
  };
}

// driverEnvelope: this driver's envelope as-of D, or a class-level fallback when
// the driver has fewer than min_observation_days of history.
export function driverEnvelope(
  driverKey: string, allDriverDays: DriverDayDoc[], asOfDate: string, cfg: EngineConfig,
): DriverEnvelope {
  const before = (allDriverDays || []).filter((d) => String(d.date) < asOfDate);
  const mine = before.filter((d) => d.driver_key === driverKey);
  const truckClass = mostCommon(mine.map((d) => d.truck_class ?? null));

  if (mine.length >= cfg.min_observation_days) {
    return { driver_key: driverKey, source: 'driver', truck_class: truckClass, ...envelopeFromDays(mine) };
  }
  // class fallback (same truck_class; if class unknown, the whole fleet)
  const classDays = truckClass
    ? before.filter((d) => d.truck_class === truckClass)
    : before;
  if (classDays.length) {
    return { driver_key: driverKey, source: 'class', truck_class: truckClass, ...envelopeFromDays(classDays) };
  }
  return {
    driver_key: driverKey, source: 'none', truck_class: truckClass, observed_days: 0,
    per_trip: { stops_median: null, stops_p85: null, pallets_median: null, pallets_p85: null, weight_median: null, weight_p85: null },
    trips_per_day_propensity: 0, start_minute_typical: null, shift_hours_typical: null, day_weight_p85: null,
  };
}

// driverZoneAffinity: normalized frequency map of gh5 zones this driver served,
// from reference routes with date < D. Matched by driver_user_name.
export function driverZoneAffinity(
  driverUserName: string | null, references: ReferenceRouteDoc[], asOfDate: string, precisions: ZonePrecisions,
): Map<string, number> {
  const freq = new Map<string, number>();
  if (!driverUserName) return freq;
  let total = 0;
  for (const r of references || []) {
    if (String(r.date) >= asOfDate) continue;
    if (r.driver_user_name !== driverUserName) continue;
    for (const s of r.stops || []) {
      const gh5 = superOfZone(String(s.zone || ''), precisions);
      if (!gh5) continue;
      freq.set(gh5, (freq.get(gh5) || 0) + 1);
      total++;
    }
  }
  if (total > 0) for (const [k, v] of freq) freq.set(k, v / total);
  return freq;
}

export interface FleetTripChain {
  source: 'mined' | 'seed';
  chains_observed: number;
  far_first_rate: number;          // share of chains whose trip 1 is farther than trip 2
  reload_gap_median_min: number;   // median last-touch(trip1) → first-touch(trip2)
  trip2_radius_p50: number;
  trip2_radius_p85: number;
}

// fleetTripChain: fleet-level v1 constants mined from multi-trip chains < D; if
// history is thin, seeded from config (which is seeded from the OPERATING FACTS).
export function fleetTripChain(allDriverDays: DriverDayDoc[], asOfDate: string, cfg: EngineConfig): FleetTripChain {
  const before = (allDriverDays || []).filter((d) => String(d.date) < asOfDate);
  const gaps: number[] = [];
  const trip2Radii: number[] = [];
  let chains = 0, farFirst = 0;
  for (const d of before) {
    const ot = orderedTrips(d);
    if (ot.length < 2) continue;
    chains++;
    const t1 = ot[0], t2 = ot[1];
    const r1 = t1.avg_mi, r2 = t2.avg_mi;
    if (r1 != null && r2 != null && r1 > r2) farFirst++;
    const gap = minutesBetween(t1.last_touch, t2.first_touch);
    if (gap != null && gap >= 0) gaps.push(gap);
    if (t2.avg_mi != null) trip2Radii.push(t2.avg_mi);
  }
  const MIN_CHAINS = 8;
  if (chains >= MIN_CHAINS) {
    return {
      source: 'mined', chains_observed: chains,
      far_first_rate: chains ? farFirst / chains : cfg.far_first_adherence,
      reload_gap_median_min: median(gaps) ?? cfg.reload_gap_min,
      trip2_radius_p50: median(trip2Radii) ?? cfg.trip2_radius_mi,
      trip2_radius_p85: quantile(trip2Radii, 0.85) ?? cfg.trip2_radius_mi,
    };
  }
  return {
    source: 'seed', chains_observed: chains,
    far_first_rate: cfg.far_first_adherence,
    reload_gap_median_min: cfg.reload_gap_min,
    trip2_radius_p50: cfg.trip2_radius_mi,
    trip2_radius_p85: cfg.trip2_radius_mi * 1.5,
  };
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) { const s = String(v ?? '').trim(); if (s) counts.set(s, (counts.get(s) || 0) + 1); }
  let best: string | null = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}
