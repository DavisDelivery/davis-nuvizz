// routing-cleanup.mts
//
// END-OF-NIGHT CLEANUP endpoint. POST a date and the load shells to fill; the
// learned engine routes the day's LEFTOVER UNPLANNED stops onto them and returns
// the proposal. Writes NOTHING and makes ZERO NuVizz calls — reads are the
// Firestore board cache plus the same as-of learning collections the nightly
// shadow uses. Pushing stays where it has always been: the Compare workbench's
// Save, an explicit dispatcher action on the metered write path.
//
//   POST { date: 'YYYY-MM-DD',
//          trucks: [{ key: 'SUW 2', name, loadNbr, loadId,
//                     truck_class: 'box_truck'|'tractor',
//                     max_skids, max_weight_lb, driver_user_name? }, ...],
//          exclude_stop_nbrs: ['123', ...],   // stops already staged on open cards
//          // Read only under the Build rules (FILL_MY_LOADS_BUILD_RULES, default on):
//          tractor_only_green: bool, window_mode: 'strict'|'advisory',   // step 3's toggles
//          trucks[].capabilities: { tractor, liftgate, lengthClassFt, overheadClearance },
//          trucks[].existing_stop_nbrs: ['123', ...],    // what the load already carries, in order
//          trucks[].existing_stops: [{ stopNbr, cartons, volume, pallets, weight, lat, lng, ... }] }
//     → 200 CleanupResult (see routing-cleanup-core.mts)
//     → 400 no trucks / too many / duplicate key / the pool is a whole board
//     → 404 no board data for that date yet
//
// Deterministic for (date, pool, trucks) at the sizes cleanup is for: the RNG is
// seeded from the date, and on a leftover-sized pool both solvers converge well
// inside their caps. It is NOT deterministic in the limit — solveAssignment's
// local search and solveRoute both terminate on wall clock, so on a pool large
// enough to still be improving at the cap, a cold container or a slow Firestore
// read can change how far the search got and therefore the plan. Do not read a
// diff between two runs of a near-max pool as a change in the inputs.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { runCleanup, type CleanupTruckInput } from './lib/routing-cleanup-core.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST { date, trucks: [...] }' }), { status: 405, headers });
  }
  // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  let body: any = null;
  try { body = await req.json(); } catch { /* handled below */ }
  const date = String(body?.date || '');
  if (!DATE_RE.test(date)) {
    return new Response(JSON.stringify({ ok: false, error: 'bad or missing date (YYYY-MM-DD)' }), { status: 400, headers });
  }
  if (!Array.isArray(body?.trucks)) {
    return new Response(JSON.stringify({ ok: false, error: 'trucks: pick at least one load to route onto' }), { status: 400, headers });
  }
  // Normalise at the edge so the core only ever sees clean shapes.
  const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const trucks: CleanupTruckInput[] = body.trucks.map((t: any) => ({
    key: String(t?.key ?? '').trim(),
    name: t?.name != null ? String(t.name) : null,
    loadNbr: t?.loadNbr != null ? String(t.loadNbr) : null,
    loadId: t?.loadId != null ? String(t.loadId) : null,
    truck_class: String(t?.truck_class || '') === 'tractor' ? 'tractor' : 'box_truck',
    max_skids: num(t?.max_skids),
    max_weight_lb: num(t?.max_weight_lb),
    // Absent reads as NO liftgate. Assuming one we cannot see is the expensive
    // direction: the driver finds out at a residential door.
    liftgate: t?.liftgate === true,
    driver_user_name: t?.driver_user_name ? String(t.driver_user_name) : null,
    // The profile's capabilities, only the four fields the Build rule reads, typed here.
    capabilities: t?.capabilities && typeof t.capabilities === 'object' ? {
      ...(typeof t.capabilities.tractor === 'boolean' ? { tractor: t.capabilities.tractor } : {}),
      ...(typeof t.capabilities.liftgate === 'boolean' ? { liftgate: t.capabilities.liftgate } : {}),
      ...(num(t.capabilities.lengthClassFt) ? { lengthClassFt: num(t.capabilities.lengthClassFt)! } : {}),
      ...(typeof t.capabilities.overheadClearance === 'boolean' ? { overheadClearance: t.capabilities.overheadClearance } : {}),
    } : null,
    existing_stop_nbrs: Array.isArray(t?.existing_stop_nbrs) ? t.existing_stop_nbrs.slice(0, 300).map((x: any) => String(x)) : null,
    // What the browser sees on the load — only the fields the fill reads, typed here. Used only
    // for a stop the server's board does not have (a carry-over from another day on the card).
    existing_stops: Array.isArray(t?.existing_stops) ? t.existing_stops.slice(0, 300).map((x: any) => {
      const n = (v: any) => { const k = Number(v); return Number.isFinite(k) ? k : null; };
      const str = (v: any) => (v == null ? null : String(v).slice(0, 200));
      return {
        stopNbr: str(x?.stopNbr), cartons: n(x?.cartons), volume: n(x?.volume), pallets: n(x?.pallets), weight: n(x?.weight),
        lat: n(x?.lat), lng: n(x?.lng), businessName: str(x?.businessName), addr1: str(x?.addr1), city: str(x?.city), zip: str(x?.zip),
        scheduledFrom: str(x?.scheduledFrom), scheduledTo: str(x?.scheduledTo),
      };
    }).filter((x: any) => x.stopNbr) : null,
  }));
  // Bounded like every other input — an unbounded list is the one field a caller
  // could use to make this endpoint do unbounded work.
  const exclude = Array.isArray(body?.exclude_stop_nbrs) ? body.exclude_stop_nbrs.slice(0, 2000).map((x: any) => String(x)) : [];

  try {
    const res = await runCleanup(TENANT, date, trucks, exclude, {
      tractorOnlyGreen: body?.tractor_only_green === true,
      windowMode: body?.window_mode === 'strict' ? 'strict' : 'advisory',
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: res.error }), { status: res.status, headers });
    }
    return new Response(JSON.stringify(res.plan), { status: 200, headers });
  } catch (e: any) {
    console.error('[routing-cleanup] failed:', e?.message || e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'cleanup failed' }), { status: 500, headers });
  }
};
