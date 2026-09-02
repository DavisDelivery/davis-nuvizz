// routing-reference-backfill-background.mts
//
// Backfill routing_reference_routes FROM the immutable history warehouse
// (history_days) + the MarginIQ employee roster (driver → truck class). Reads
// only our own Firestore — NEVER calls NuVizz. Mirrors
// tractor-flags-rebuild-background.
//
// Idempotent by construction: every reference route doc is recomputed fresh
// from its day partition and written as a full overwrite. Ignores the
// ROUTING_ENGINE kill switch — invoking this by hand IS the intent.
//
// Background fn (15-min budget). No schedule — run on demand:
//   POST /.netlify/functions/routing-reference-backfill-background   → ALL captured days
//     ?date=YYYY-MM-DD                → single day
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → inclusive range
import { isFirestoreEnabled, listDocs } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { HISTORY_COLLECTION, listStops, capturedDatesFromManifests } from './lib/history-store.mts';
import { loadEngineConfig } from './lib/routing-engine-config.mts';
import { extractReferenceRoutes, writeReferenceRoutes } from './lib/routing-reference.mts';
import { loadVehicleRoster, vehicleTypeForStop } from './lib/tractor-flags.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every captured date = the day partitions present in history_days (manifest
// doc ids are `{tenant}__{date}`), including healed days. Firestore-only, no NuVizz.
async function listCapturedDates(): Promise<string[]> {
  return capturedDatesFromManifests(await listDocs(HISTORY_COLLECTION), TENANT);
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  // GATED AT admin. This rewrites routing_reference_routes — the library every engine score is
  // measured against — over the whole warehouse. Netlify already answered 202 and discarded
  // our status (lib/background-gate.mts); run by hand, no doc a screen polls, so the refusal
  // lands in nuvizz_ops/background_refusals.
  const gate = await requireUserForBackground(req, 'routing-reference-backfill-background', { role: 'admin' });
  if (!gate.ok) return gate.response;
  const t0 = Date.now();
  const url = new URL(req.url);
  const one = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  let dates = await listCapturedDates();
  if (one && DATE_RE.test(one)) dates = dates.filter((d) => d === one);
  else if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
    const lo = from < to ? from : to, hi = from < to ? to : from;
    dates = dates.filter((d) => d >= lo && d <= hi);
  }

  const cfg = await loadEngineConfig(TENANT);
  let truckClassOf: ((s: any) => string | null) | undefined;
  let rosterSize = 0;
  try {
    const roster = await loadVehicleRoster(true);
    rosterSize = roster.aliasToVehicle.size;
    truckClassOf = (s) => vehicleTypeForStop(s, roster);
  } catch (e: any) {
    console.error('[reference-backfill] roster load failed (truck_class will be null):', e?.message);
  }
  console.log(`[reference-backfill] ${dates.length} date partition(s) to mine; roster aliases: ${rosterSize}`);

  let mined = 0, written = 0, stopsScanned = 0;
  const skippedByReason: Record<string, number> = {};
  const perDate: Array<{ date: string; mined: number; skipped: number }> = [];
  for (const date of dates) {
    const stops = await listStops(TENANT, date);
    stopsScanned += stops.length;
    const { routes, skipped } = extractReferenceRoutes(stops, { tenant: TENANT, date, cfg, truckClassOf });
    written += await writeReferenceRoutes(routes);
    mined += routes.length;
    for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] || 0) + 1;
    perDate.push({ date, mined: routes.length, skipped: skipped.length });
    console.log(`[reference-backfill] ${date}: ${stops.length} stops → ${routes.length} reference route(s), ${skipped.length} skipped`);
  }

  const summary = {
    ok: true,
    tenant: TENANT,
    datePartitionsScanned: dates.length,
    stopsEvaluated: stopsScanned,
    referenceRoutesMined: mined,
    docsWritten: written,
    skippedByReason,
    perDate,
    ms: Date.now() - t0,
  };
  console.log('[reference-backfill] done:', JSON.stringify({ ...summary, perDate: undefined }));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
