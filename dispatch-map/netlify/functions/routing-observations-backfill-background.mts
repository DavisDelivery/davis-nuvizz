// routing-observations-backfill-background.mts
//
// PHASE 2 backfill of both observation miners from the immutable warehouse:
//   • routing_driver_days  — per-date, idempotent full recompute (respects a
//     ?date / ?from&to window);
//   • routing_service_times — a cross-date aggregate, so it is ALWAYS recomputed
//     fresh over EVERY captured date (a windowed subset can't correctly rebuild
//     a dated reservoir), then written in one pass.
//
// Reads history_days + the roster only. ZERO NuVizz calls. Ignores the
// ROUTING_ENGINE kill switch — running it by hand IS the intent.
//
//   POST /.netlify/functions/routing-observations-backfill-background   → ALL days
//     ?date=YYYY-MM-DD                → driver-days for that day (service times still full)
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → driver-days for the range (service times still full)
import { isFirestoreEnabled, listDocs } from './lib/firestore.mts';
import { HISTORY_COLLECTION, listStops } from './lib/history-store.mts';
import { loadEngineConfig } from './lib/routing-engine-config.mts';
import { extractDriverDays, writeDriverDays } from './lib/routing-driver-days.mts';
import { serviceObservationsForDay, writeServiceTimesFresh, type PalletBucket } from './lib/routing-service-times.mts';
import { loadVehicleRoster, vehicleTypeForStop } from './lib/tractor-flags.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function listCapturedDates(): Promise<string[]> {
  const manifests = await listDocs(HISTORY_COLLECTION);
  return manifests
    .map((m) => String(m?._id || ''))
    .filter((id) => id.startsWith(`${TENANT}__`))
    .map((id) => id.slice(TENANT.length + 2))
    .filter((d) => DATE_RE.test(d))
    .sort();
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  const t0 = Date.now();
  const url = new URL(req.url);
  const one = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const cfg = await loadEngineConfig(TENANT);
  let truckClassOf: ((s: any) => string | null) | undefined;
  try { const roster = await loadVehicleRoster(true); truckClassOf = (s) => vehicleTypeForStop(s, roster); }
  catch (e: any) { console.error('[obs-backfill] roster load failed:', e?.message); }

  const allDates = await listCapturedDates();
  let ddDates = allDates;
  if (one && DATE_RE.test(one)) ddDates = allDates.filter((d) => d === one);
  else if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
    const lo = from < to ? from : to, hi = from < to ? to : from;
    ddDates = allDates.filter((d) => d >= lo && d <= hi);
  }

  // service-time reservoirs (dated) folded over ALL dates
  const byCustomer = new Map<string, Array<{ d: string; m: number }>>();
  const byBucket = new Map<PalletBucket, Array<{ d: string; m: number }>>();

  let driverDaysWritten = 0, driverDayDocs = 0, stopsScanned = 0;
  const perDate: Array<{ date: string; drivers: number }> = [];

  for (const date of allDates) {
    const stops = await listStops(TENANT, date);
    stopsScanned += stops.length;

    // service obs (always, every date)
    const day = serviceObservationsForDay(stops, cfg);
    for (const [mk, mins] of day.customer) {
      const arr = byCustomer.get(mk) ?? byCustomer.set(mk, []).get(mk)!;
      for (const m of mins) arr.push({ d: date, m });
    }
    for (const [b, mins] of day.fleet) {
      const arr = byBucket.get(b) ?? byBucket.set(b, []).get(b)!;
      for (const m of mins) arr.push({ d: date, m });
    }

    // driver-days (only for the requested window)
    if (ddDates.includes(date)) {
      const docs = extractDriverDays(stops, { tenant: TENANT, date, truckClassOf });
      driverDaysWritten += await writeDriverDays(docs);
      driverDayDocs += docs.length;
      perDate.push({ date, drivers: docs.length });
    }
  }

  const serviceDocsWritten = await writeServiceTimesFresh(TENANT, byCustomer, byBucket);

  const summary = {
    ok: true, tenant: TENANT,
    dates_scanned: allDates.length,
    driver_day_dates: ddDates.length,
    driver_day_docs: driverDayDocs,
    driver_days_written: driverDaysWritten,
    service_customers: byCustomer.size,
    service_docs_written: serviceDocsWritten,
    stops_scanned: stopsScanned,
    perDate,
    ms: Date.now() - t0,
  };
  console.log('[obs-backfill] done:', JSON.stringify({ ...summary, perDate: undefined }));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
