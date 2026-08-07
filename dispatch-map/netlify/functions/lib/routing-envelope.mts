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

import { superOfZone, topOfZone, type ZonePrecisions } from './zones.mts';
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
    weight_max: number | null;   // heaviest single trip ever observed — the never-split floor
    // SKID POSITIONS PER TRIP — what actually fills this driver's truck. The
    // flat class cap (box p95=22) is a FLEET statistic: it let every box driver
    // load to the 95th percentile of all box trips when the same study puts the
    // median box trip at 14. Most box drivers run 12-15; a few take 17-18. These
    // are that driver's OWN numbers, so the cap can finally be theirs.
    // NULL when no observed trip carried a skid/loose breakdown (pre-capture
    // history) — never 0, which would read as a zero-capacity truck.
    skid_equiv_p85: number | null;
    skid_equiv_max: number | null;  // most ever carried in one trip — the never-split floor
  };
  trips_per_day_propensity: number;      // share of observed days with 2+ trips
  start_minute_typical: number | null;   // median first-touch minute-of-day
  shift_hours_typical: number | null;    // median (end - start) hours
  day_weight_p85: number | null;
  // DAILY CAPACITY by the real freight dimensions (skids = NuVizz "cartons",
  // loose = NuVizz "volume") — what actually fills a truck-day. p85 of the driver's
  // observed day totals: the "you're getting full" threshold the seed repels past.
  // Null until skid/loose history exists (post-capture / backfill); the seed then
  // falls back to day_weight_p85 so behavior degrades gracefully.
  day_skids_p85: number | null;
  day_loose_p85: number | null;
}

function envelopeFromDays(days: DriverDayDoc[], loosePerSkid: number): Omit<DriverEnvelope, 'driver_key' | 'source' | 'truck_class'> {
  const trips = days.flatMap((d) => (d.trips || []));
  const stops = trips.map((t) => t.stops);
  const pallets = trips.map((t) => t.pallets);
  const weight = trips.map((t) => t.weight);
  // Per-trip SKID-EQUIVALENT, the same arithmetic the solver's stopSkidEquiv
  // uses (loose pieces share a skid position at loose_per_skid apiece), so a
  // learned cap and the load it is measured against are in the same units.
  // Only trips that actually CARRY a breakdown count: a pre-capture trip reads
  // 0/0 and would otherwise drag a real driver's cap toward zero.
  const div = Math.max(1, loosePerSkid);
  const skidEquiv = trips
    .filter((t) => (t.skids || 0) > 0 || (t.loose || 0) > 0)
    .map((t) => (t.skids || 0) + (t.loose || 0) / div);
  const starts = days.map((d) => wallMinuteOfDay(d.start_time)).filter((v): v is number => v != null);
  const shiftHours = days.map((d) => minutesBetween(d.start_time, d.end_time)).filter((v): v is number => v != null && v > 0).map((m) => m / 60);
  const dayWeights = days.map((d) => d.day_totals?.weight ?? 0);
  const daySkids = days.map((d) => d.day_totals?.skids ?? 0);
  const dayLoose = days.map((d) => d.day_totals?.loose ?? 0);
  // A dimension is only "learned" if SOME day carried it — an all-zero column
  // (skids/loose not captured for these days yet) yields null, not a false 0 cap.
  const anySkids = daySkids.some((v) => v > 0);
  const anyLoose = dayLoose.some((v) => v > 0);
  const multiTripDays = days.filter((d) => orderedTrips(d).length >= 2).length;
  return {
    observed_days: days.length,
    per_trip: {
      stops_median: median(stops), stops_p85: quantile(stops, 0.85),
      pallets_median: median(pallets), pallets_p85: quantile(pallets, 0.85),
      weight_median: median(weight), weight_p85: quantile(weight, 0.85),
      // The heaviest single trip this driver (or class) has ACTUALLY run. Dispatch
      // has proven this weight fits on one truck, so the solver must never be
      // forced to split below it — p85×factor alone chops the real top-15% tail
      // and manufactures phantom trips.
      weight_max: weight.length ? Math.max(...weight) : null,
      // Both null when NO observed trip carried a breakdown — the caller then
      // keeps the class cap rather than inventing a zero-capacity truck.
      skid_equiv_p85: skidEquiv.length ? quantile(skidEquiv, 0.85) : null,
      skid_equiv_max: skidEquiv.length ? Math.max(...skidEquiv) : null,
    },
    trips_per_day_propensity: days.length ? multiTripDays / days.length : 0,
    start_minute_typical: median(starts),
    shift_hours_typical: median(shiftHours),
    day_weight_p85: quantile(dayWeights, 0.85),
    day_skids_p85: anySkids ? quantile(daySkids, 0.85) : null,
    day_loose_p85: anyLoose ? quantile(dayLoose, 0.85) : null,
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
    return { driver_key: driverKey, source: 'driver', truck_class: truckClass, ...envelopeFromDays(mine, cfg.loose_per_skid) };
  }
  // class fallback (same truck_class; if class unknown, the whole fleet)
  const classDays = truckClass
    ? before.filter((d) => d.truck_class === truckClass)
    : before;
  if (classDays.length) {
    return { driver_key: driverKey, source: 'class', truck_class: truckClass, ...envelopeFromDays(classDays, cfg.loose_per_skid) };
  }
  return {
    driver_key: driverKey, source: 'none', truck_class: truckClass, observed_days: 0,
    per_trip: { stops_median: null, stops_p85: null, pallets_median: null, pallets_p85: null, weight_median: null, weight_p85: null, weight_max: null, skid_equiv_p85: null, skid_equiv_max: null },
    trips_per_day_propensity: 0, start_minute_typical: null, shift_hours_typical: null, day_weight_p85: null,
    day_skids_p85: null, day_loose_p85: null,
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

// ── Phase 2.3: learned territory ownership ───────────────────────────────────
// zoneOwnersAsOf: for each TOP zone (gh4, ~a named area like "Dalton"), the set
// of drivers who historically carry a real share of its stops — mined from the
// reference routes strictly < D. This is dispatch's territory knowledge made
// explicit ("Dalton is Scott and Victor's, period"): a zone whose history shows
// near-exclusive owners gets a learned owner set; a zone served by everybody
// (Atlanta) never concentrates past the share floor and stays open. The solver
// only consults this for FAR stops, so the depot's own mega-zone is never
// affected. Thin history (< min_obs stops) yields no entry — no lock-in from
// noise.
export interface ZoneOwners {
  owners: Set<string>;   // driver_user_name (UPPERCASED) with share ≥ zone_owner_min_share
  n: number;             // observed stops in this top zone (< D)
}
export function zoneOwnersAsOf(
  references: ReferenceRouteDoc[], asOfDate: string, precisions: ZonePrecisions, cfg: EngineConfig,
): Map<string, ZoneOwners> {
  const byZone = new Map<string, Map<string, number>>();
  for (const r of references || []) {
    if (String(r.date) >= asOfDate) continue;
    const drv = r.driver_user_name ? String(r.driver_user_name).toUpperCase() : null;
    if (!drv) continue;
    for (const s of r.stops || []) {
      const top = topOfZone(String(s.zone || ''), precisions);
      if (!top) continue;
      let m = byZone.get(top);
      if (!m) { m = new Map(); byZone.set(top, m); }
      m.set(drv, (m.get(drv) || 0) + 1);
    }
  }
  const out = new Map<string, ZoneOwners>();
  for (const [top, m] of byZone) {
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    if (n < cfg.zone_owner_min_obs) continue;
    const owners = new Set<string>();
    for (const [drv, c] of m) if (c / n >= cfg.zone_owner_min_share) owners.add(drv);
    if (owners.size) out.set(top, { owners, n });
  }
  return out;
}

// ── Phase 2.7: territory candidate sets ──────────────────────────────────────
// The strongest predictor of dispatch's driver choice is GEOGRAPHY: a stop's
// ~0.05° zone (≈3.5 mi) is run by a stable 2-3 driver cast. Restricting each stop
// to its zone's trailing top drivers (∪ the customer's habitual driver, ∪ the
// coarser 0.2° area for cold zones) contains dispatch's actual pick ~62% of the
// time and ~doubles agreement vs the old open N-driver search. Validated on 15
// board days, leave-one-day-out: top-1 ≈ 37%, top-3 containment ≈ 62%.
const ZONE_G = 0.05, AREA_G = 0.2;
function cellKey(lat: number, lng: number, g: number): string {
  return `${Math.round(lat / g)}:${Math.round(lng / g)}`;   // integer cell indices — no float-key drift
}
// Canonical driver key from a reference route — mirrors history-derive.driverKeyFor
// (driver_user_name first, uppercased/underscored; else a folded driver_name) so it
// matches the roster's driver_key exactly.
function refDriverKey(r: ReferenceRouteDoc): string | null {
  const u = String(r.driver_user_name ?? '').trim();
  if (u) return u.toUpperCase().replace(/\s+/g, '_');
  const n = String(r.driver_name ?? '').trim();
  if (n) return 'name_' + n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return null;
}

export interface TerritoryMaps {
  zone: Map<string, Map<string, number>>;   // 0.05° cell → driver_key → visit count
  area: Map<string, Map<string, number>>;   // 0.2° cell  → driver_key → visit count
}
export function territoryMapsAsOf(references: ReferenceRouteDoc[], asOfDate: string): TerritoryMaps {
  const zone = new Map<string, Map<string, number>>();
  const area = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, key: string, drv: string) => {
    let d = m.get(key); if (!d) { d = new Map(); m.set(key, d); }
    d.set(drv, (d.get(drv) || 0) + 1);
  };
  for (const r of references || []) {
    if (String(r.date) >= asOfDate) continue;   // leakage guard (re-checked here)
    const drv = refDriverKey(r);
    if (!drv) continue;
    for (const s of r.stops || []) {
      const lat = Number(s.lat), lng = Number(s.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      bump(zone, cellKey(lat, lng, ZONE_G), drv);
      bump(area, cellKey(lat, lng, AREA_G), drv);
    }
  }
  return { zone, area };
}

function topDriversInCell(cell: Map<string, number> | undefined, roster: Set<string>, k: number): string[] {
  if (!cell) return [];
  return [...cell.entries()].filter(([d]) => roster.has(d))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([d]) => d);
}
// Ordered candidate driver_keys for a stop: the customer's habitual driver (if on
// the roster) first, then the zone's trailing top-K, then the coarser area's top
// drivers as a cold-zone fallback — roster-filtered, de-duped, order-preserving.
// Empty ⇒ truly unseen geography, and the solver falls back to any driver.
export function candidateDriversFor(
  lat: number, lng: number, habitKey: string | null, maps: TerritoryMaps, roster: Set<string>,
  opts: { zoneK?: number; areaK?: number } = {},
): string[] {
  const z = topDriversInCell(maps.zone.get(cellKey(lat, lng, ZONE_G)), roster, opts.zoneK ?? 5);
  const a = topDriversInCell(maps.area.get(cellKey(lat, lng, AREA_G)), roster, opts.areaK ?? 3);
  const out: string[] = [];
  const add = (d: string | null) => { if (d && roster.has(d) && !out.includes(d)) out.push(d); };
  add(habitKey);
  for (const d of z) add(d);
  for (const d of a) add(d);
  return out;
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
