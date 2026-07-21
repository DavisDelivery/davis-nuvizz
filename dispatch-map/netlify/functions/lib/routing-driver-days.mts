// lib/routing-driver-days.mts
//
// PHASE 2 — DRIVER-DAY OBSERVATION MINER. Distills what each driver actually did
// on a board date into the shift shape the assignment engine learns from: the
// ordered chain of trips (each trip = one Buford load), the freight per trip,
// and the executed touch times that reveal reload turns and start times.
//
//   routing_driver_days/{tenant}__{date}__{driverKey}
//     tenant, date, driver_user_name, driver_name, truck_class,
//     trips: [{ load_key, seq_index, stops, pallets, weight, avg_mi, max_mi,
//               first_touch, last_touch }...]   (seq_index = executed time order)
//     day_totals: { stops, pallets, weight }, trips_count,
//     start_time (first touch of trip 1), end_time (last touch of last trip),
//     updated_at
//
// Rules (verified against the warehouse): planned stops with a load identity
// only; a driver's loads become trips ordered by earliest executed touch; a
// load with NO timestamps on any stop can't be time-ordered (seq_index null)
// but its freight still counts in day_totals. Capacity is per-DRIVER per-TRIP,
// so the trip is the unit — never a per-class assumption.
//
// PURE derivation + thin Firestore I/O. ZERO NuVizz calls. The nightly pass
// honors ROUTING_ENGINE=off; the backfill ignores it (running it by hand IS
// the intent).

import { getDoc, setDoc } from './firestore.mts';
import { histDocId } from './history-store.mts';
import { loadKeyForStop } from './routing-reference.mts';
import { driverKeyFor, DEPOT } from './history-derive.mts';
import { haversineMiles } from './routing-engine-solver.mts';
import { routingEngineDisabled } from './routing-engine-config.mts';
import { loadVehicleRoster, vehicleTypeForStop, type VehicleRoster } from './tractor-flags.mts';

export const DRIVER_DAYS_COLLECTION = 'routing_driver_days';

export function driverDayId(tenant: string, date: string, driverKey: string): string {
  // driverKey rides a Firestore doc-id path segment. A co-driver userName ("COLIN/DJ 1")
  // carries a slash, so sanitize it (histDocId is a no-op for clean keys) — the same
  // guard upsertDriverDayPointer already applies to the cross-day pointer path.
  return `${tenant}__${date}__${histDocId(String(driverKey))}`;
}
export function driverDayPath(tenant: string, date: string, driverKey: string): string {
  return `${DRIVER_DAYS_COLLECTION}/${driverDayId(tenant, date, driverKey)}`;
}

export interface DriverTrip {
  load_key: string;
  seq_index: number | null;   // 1..N executed time order; null when the load has no timestamps
  stops: number;
  // FREIGHT DIMENSIONS. NuVizz MISLABELS its fields (see freight-geometry.mts):
  //   skids  = NuVizz "cartons"  → real pallet/skid positions (what fills a truck's floor)
  //   loose  = NuVizz "volume"   → loose pieces
  //   pallets = NuVizz "pallets" → TOTAL pieces (skids + loose); kept for back-compat only.
  // Capacity should be judged on skids + loose, NOT weight (rarely the binding constraint).
  pallets: number;
  skids: number;
  loose: number;
  weight: number;
  avg_mi: number | null;      // mean stop distance-from-origin
  max_mi: number | null;      // farthest stop
  first_touch: string | null; // earliest executed touch across the trip's stops
  last_touch: string | null;  // latest executed touch
}

export interface DriverDayDoc {
  tenant: string;
  date: string;
  driver_key: string;
  driver_user_name: string | null;
  driver_name: string | null;
  truck_class: string | null;
  trips: DriverTrip[];
  day_totals: { stops: number; pallets: number; skids: number; loose: number; weight: number };
  trips_count: number;
  start_time: string | null;
  end_time: string | null;
  updated_at: string;
}

function finiteNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// A stop's executed touch bounds — arrival is the earliest, delivered the latest.
function touchFirst(s: any): string | null {
  const a = String(s?.arrivalDTTM ?? '').trim();
  const d = String(s?.deliveredDTTM ?? '').trim();
  if (a && d) return a < d ? a : d;
  return a || d || null;
}
function touchLast(s: any): string | null {
  const a = String(s?.arrivalDTTM ?? '').trim();
  const d = String(s?.deliveredDTTM ?? '').trim();
  if (a && d) return a > d ? a : d;
  return d || a || null;
}
// Distance-from-origin for a stop: NuVizz stopDistance when present, else a
// haversine estimate from the Buford depot (never a Route Matrix call).
function stopMiles(s: any): number | null {
  const sd = finiteNum(s?.stopDistance);
  if (sd != null) return sd;
  const lat = finiteNum(s?.lat), lng = finiteNum(s?.lng);
  if (lat == null || lng == null) return null;
  return haversineMiles(DEPOT.lat, DEPOT.lng, lat, lng);
}

// Same eligibility as the reference miner: planned, real delivery, has a load id.
function routeEligible(s: any): boolean {
  return !!s && s.isPlanned === true && s.isTerminal !== true && s.isUnplanned !== true && s.isAttempt !== true;
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) { const s = String(v ?? '').trim(); if (s) counts.set(s, (counts.get(s) || 0) + 1); }
  let best: string | null = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

// PURE: mine one day's warehouse stops into driver-day docs.
export function extractDriverDays(
  stops: any[],
  opts: { tenant: string; date: string; truckClassOf?: (s: any) => string | null; nowIso?: string },
): DriverDayDoc[] {
  const truckClassOf = opts.truckClassOf || (() => null);
  const byDriver = new Map<string, any[]>();
  for (const s of stops || []) {
    if (!routeEligible(s)) continue;
    if (!loadKeyForStop(s)) continue;
    const dk = driverKeyFor(s);
    (byDriver.get(dk) ?? byDriver.set(dk, []).get(dk)!).push(s);
  }

  const docs: DriverDayDoc[] = [];
  for (const [driverKey, dStops] of [...byDriver.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // group this driver's stops into trips by load identity
    const byLoad = new Map<string, any[]>();
    for (const s of dStops) {
      const k = loadKeyForStop(s)!;
      (byLoad.get(k) ?? byLoad.set(k, []).get(k)!).push(s);
    }

    const rawTrips = [...byLoad.entries()].map(([load_key, ls]) => {
      const firsts = ls.map(touchFirst).filter(Boolean) as string[];
      const lasts = ls.map(touchLast).filter(Boolean) as string[];
      const miles = ls.map(stopMiles).filter((m): m is number => m != null);
      const pallets = ls.reduce((a, s) => a + (finiteNum(s?.pallets) || 0), 0);
      // Real freight dimensions from the mislabeled NuVizz fields: skids = "cartons",
      // loose = "volume" (see DriverTrip). These are what actually fill a truck.
      const skids = ls.reduce((a, s) => a + (finiteNum(s?.cartons) || 0), 0);
      const loose = ls.reduce((a, s) => a + (finiteNum(s?.volume) || 0), 0);
      const weight = ls.reduce((a, s) => a + (finiteNum(s?.weight) || 0), 0);
      return {
        load_key,
        stops: ls.length,
        pallets,
        skids,
        loose,
        weight,
        avg_mi: miles.length ? Math.round((miles.reduce((a, b) => a + b, 0) / miles.length) * 10) / 10 : null,
        max_mi: miles.length ? Math.round(Math.max(...miles) * 10) / 10 : null,
        first_touch: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null,
        last_touch: lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
      };
    });

    // seq_index by earliest executed touch; timestamp-less loads keep null seq.
    const timed = rawTrips.filter((t) => t.first_touch).sort((a, b) => a.first_touch! < b.first_touch! ? -1 : a.first_touch! > b.first_touch! ? 1 : a.load_key.localeCompare(b.load_key));
    const untimed = rawTrips.filter((t) => !t.first_touch).sort((a, b) => a.load_key.localeCompare(b.load_key));
    const seqOf = new Map<string, number>();
    timed.forEach((t, i) => seqOf.set(t.load_key, i + 1));

    const trips: DriverTrip[] = [...timed, ...untimed].map((t) => ({
      load_key: t.load_key,
      seq_index: seqOf.get(t.load_key) ?? null,
      stops: t.stops,
      pallets: Math.round(t.pallets * 10) / 10,
      skids: Math.round(t.skids * 10) / 10,
      loose: Math.round(t.loose * 10) / 10,
      weight: Math.round(t.weight * 10) / 10,
      avg_mi: t.avg_mi,
      max_mi: t.max_mi,
      first_touch: t.first_touch,
      last_touch: t.last_touch,
    }));

    const day_totals = {
      stops: trips.reduce((a, t) => a + t.stops, 0),
      pallets: Math.round(trips.reduce((a, t) => a + t.pallets, 0) * 10) / 10,
      skids: Math.round(trips.reduce((a, t) => a + t.skids, 0) * 10) / 10,
      loose: Math.round(trips.reduce((a, t) => a + t.loose, 0) * 10) / 10,
      weight: Math.round(trips.reduce((a, t) => a + t.weight, 0) * 10) / 10,
    };
    const trip1 = timed[0] || null;
    const lastTimed = timed.length ? timed[timed.length - 1] : null;

    docs.push({
      tenant: opts.tenant,
      date: opts.date,
      driver_key: driverKey,
      driver_user_name: mostCommon(dStops.map((s) => s?.driverUserName ?? null)),
      driver_name: mostCommon(dStops.map((s) => s?.driverName ?? null)),
      truck_class: truckClassOf(dStops[0]),
      trips,
      day_totals,
      trips_count: timed.length + untimed.length,
      start_time: trip1?.first_touch ?? null,
      end_time: lastTimed?.last_touch ?? null,
      updated_at: opts.nowIso || new Date().toISOString(),
    });
  }
  return docs;
}

export async function writeDriverDays(docs: DriverDayDoc[], conc = 8): Promise<number> {
  let i = 0, written = 0;
  const worker = async () => {
    while (i < docs.length) {
      const d = docs[i++];
      await setDoc(driverDayPath(d.tenant, d.date, d.driver_key), d);
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, docs.length || 1) }, worker));
  return written;
}

// I/O: all driver-day docs for a date (small — a day is ~15-30 drivers).
export async function listDriverDays(tenant: string, date: string, allDocs?: DriverDayDoc[]): Promise<DriverDayDoc[]> {
  // Callers that pre-load the whole collection (replay) pass allDocs to avoid re-reads.
  if (allDocs) return allDocs.filter((d) => d.tenant === tenant && d.date === date);
  const { runQuery } = await import('./firestore.mts');
  const rows = await runQuery({
    from: [{ collectionId: DRIVER_DAYS_COLLECTION }],
    where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: date } } },
  });
  return rows.filter((r: any) => r?.tenant === tenant) as DriverDayDoc[];
}

// INCREMENTAL nightly pass — same hook point + failure policy as the reference
// miner. Honors ROUTING_ENGINE=off.
export async function updateDriverDaysForDay(
  tenant: string, date: string, stops: any[],
): Promise<{ drivers: number; written: number; disabled?: boolean }> {
  if (routingEngineDisabled()) {
    console.log('[routing-engine] ROUTING_ENGINE=off — nightly driver-day pass skipped');
    return { drivers: 0, written: 0, disabled: true };
  }
  let roster: VehicleRoster | null = null;
  try { roster = await loadVehicleRoster(); } catch (e: any) {
    console.error('[routing-engine] vehicle roster load failed (truck_class null):', e?.message);
  }
  const docs = extractDriverDays(stops, {
    tenant, date,
    truckClassOf: roster ? (s) => vehicleTypeForStop(s, roster!) : undefined,
  });
  const written = await writeDriverDays(docs);
  console.log(`[routing-engine] ${date}: mined ${docs.length} driver-day(s), wrote ${written}`);
  return { drivers: docs.length, written };
}
