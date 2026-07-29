// lib/routing-reference.mts
//
// REFERENCE ROUTE MINER ("route DNA") for the learned routing engine. Distills
// each historical route in the history warehouse into the structure the solver
// learns from: the ordered stop list and its zone visit sequence.
//
//   routing_reference_routes/{tenant}__{date}__{loadKey}
//     tenant, date, load_key, driver_name, driver_user_name,
//     truck_class (MarginIQ vehicleType via the roster join, null if unknown),
//     warehouse, stop_count, source_seq ('planned'|'executed'),
//     zone_seq: [zoneId…] (order visited, consecutive dupes collapsed),
//     stops: [{pro, matchKey, businessName, lat, lng, zone, seq}…] (ordered),
//     updated_at
//
// Extraction rules (PURE — extractReferenceRoutes takes warehouse stop records
// already in memory; zero NuVizz calls, zero warehouse writes):
//   • A historical route = the stops in one history_days partition sharing a
//     load identity. loadKey = loadNbr when present, else
//     routeName__driverUserName.
//   • Only planned stops with a numeric routeSeq qualify; isTerminal,
//     unplanned, and attempt-only (ATT shipment) rows are excluded. Order =
//     routeSeq ascending (source_seq='planned').
//   • If a load lacks usable routeSeq but has deliveredDTTM on most stops, the
//     delivered-timestamp order stands in (source_seq='executed').
//   • Routes with fewer than min_route_stops stops, or missing lat/lng on more
//     than max_missing_coord_frac of their stops, are skipped (counted).
//
// The same extraction feeds three consumers: the backfill function, the
// nightly incremental pass (hooked where the day's stops are already in
// memory, next to the tractor daily pass), and the shadow scorer's "what did
// dispatch actually build" view — one set of rules, no drift.

import { setDoc } from './firestore.mts';
import { zoneId, collapseConsecutive, type ZonePrecisions } from './zones.mts';
import { routingEngineDisabled, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';
import { loadVehicleRoster, vehicleTypeForStop, type VehicleRoster } from './tractor-flags.mts';

export const REFERENCE_ROUTES_COLLECTION = 'routing_reference_routes';

export interface ReferenceStop {
  pro: string;                 // unique stop id within the route (pro, else stopNbr)
  matchKey: string | null;
  businessName: string | null;
  lat: number;
  lng: number;
  zone: string;
  seq: number;                 // 1..N position in the mined order
}

export interface ReferenceRouteDoc {
  tenant: string;
  date: string;
  load_key: string;
  driver_name: string | null;
  driver_user_name: string | null;
  truck_class: string | null;
  warehouse: string | null;
  stop_count: number;
  source_seq: 'planned' | 'executed';
  zone_seq: string[];
  stops: ReferenceStop[];
  updated_at: string;
}

export interface ExtractionSkip {
  load_key: string;
  reason: 'too_few_stops' | 'missing_coords';
  stop_count: number;
  missing_coords: number;
}

export interface ExtractionResult {
  routes: ReferenceRouteDoc[];
  skipped: ExtractionSkip[];
  /** Rows dropped by the execution-evidence gate (planned but never stamped on this day). */
  unexecuted_excluded: number;
}

// PURE: load identity — loadNbr when present, else routeName__driverUserName.
export function loadKeyForStop(s: any): string | null {
  const loadNbr = String(s?.loadNbr ?? '').trim();
  if (loadNbr) return loadNbr;
  const routeName = String(s?.routeName ?? '').trim();
  const driverUser = String(s?.driverUserName ?? '').trim();
  if (routeName && driverUser) return `${routeName}__${driverUser}`;
  return null;
}

// Firestore doc ids can't take slashes (and spaces make ugly URLs) — sanitize
// the loadKey for the id only; the raw load_key field keeps the real value.
export function sanitizeLoadKey(loadKey: string): string {
  return String(loadKey).replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function referenceRouteId(tenant: string, date: string, loadKey: string): string {
  return `${tenant}__${date}__${sanitizeLoadKey(loadKey)}`;
}

export function referenceRoutePath(tenant: string, date: string, loadKey: string): string {
  return `${REFERENCE_ROUTES_COLLECTION}/${referenceRouteId(tenant, date, loadKey)}`;
}

// Careful with Number() coercion: Number(null) and Number('') are 0, which
// would pass isFinite — require a real value first.
function finiteNum(v: any): boolean {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function hasCoords(s: any): boolean {
  return finiteNum(s?.lat) && finiteNum(s?.lng);
}

// Route-eligible warehouse rows: planned, not terminal, not unplanned, not a
// re-delivery attempt.
function routeEligible(s: any): boolean {
  return !!s && s.isPlanned === true && s.isTerminal !== true && s.isUnplanned !== true && s.isAttempt !== true;
}

// ── Execution evidence (Jul 29, DAWSONVILLE/CRUMPTON) ────────────────────────
//
// "Planned on day D's board" is NOT "ran on day D", and the difference is not noise. The
// engine's replay of 2026-07-28 charged Leroy Smith with 19-21 stops / ~4,900 lb and Marcus
// Crumpton with 20 / 7,966 lb, when NuVizz's own load records closed at 14 stops / 2,799 lb
// and 13 / 3,716 lb. Chad (who knows his drivers): "marcus and leroy have never taken 20
// stops on one trip ever." He was right — reading the stored day back, each load's DELIVERED
// rows matched NuVizz to the stop and TO THE POUND, and everything above that was ESTES-*
// orders sitting SCHEDULED with no delivery stamp: the NEXT day's freight, planned onto the
// next day's same-named run during the evening, filed onto D's board because an Estes import
// carries no Estimated Arrival (boardDayFor files a dateless open row on TODAY, by design),
// and then sealed into D's history at capture. The same door admits every stale carried-
// forward plan (the KAI WONG class) and patchBoardPlan's prior-day rescue stamps.
//
// So the replay now demands EVIDENCE: a row only counts toward "what dispatch ran on D" if
// its delivery stamp lands on D. That one test excludes tomorrow's pre-built freight, zombie
// plans, and rescue stamps in a single move — and a stop that ROLLS overnight stops being
// double-counted, because it counts on the day its stamp says it was actually driven.
export function executedOnDate(s: any, date: string): boolean {
  return String(s?.deliveredDTTM ?? '').slice(0, 10) === String(date);
}

/**
 * Drop the rows a day's replay must not count: route-eligible, load-keyed rows with NO
 * delivery stamp on that day. Everything else (unplanned pool, attempts, keyless rows)
 * passes through untouched — the callers' own filters already handle those.
 *
 * SELF-DISABLING on days without evidence: if fewer than half the eligible rows carry a
 * same-day stamp, the day's stamps can't be trusted as a census (sparse legacy capture, a
 * feed that dropped the delivered column) and filtering would erase real work — so nothing
 * is dropped and `applied: false` says so. 2026-07-28 itself: 715 of 831 rows stamped.
 */
export function dropUnexecuted(stops: any[], date: string): { stops: any[]; excluded: number; applied: boolean } {
  const all = Array.isArray(stops) ? stops : [];
  const eligible = all.filter((s) => routeEligible(s) && !!loadKeyForStop(s));
  const executed = eligible.filter((s) => executedOnDate(s, date));
  if (!eligible.length || executed.length < eligible.length * 0.5) {
    return { stops: all, excluded: 0, applied: false };
  }
  const kept = all.filter((s) => !(routeEligible(s) && !!loadKeyForStop(s) && !executedOnDate(s, date)));
  return { stops: kept, excluded: all.length - kept.length, applied: true };
}

// Unique per-route stop id: the PRO when it's unique within the route, else
// the stopNbr (always unique — it's the warehouse doc key).
function assignStopIds(stops: any[]): string[] {
  const proCount = new Map<string, number>();
  for (const s of stops) {
    const pro = String(s?.pro ?? '').trim();
    if (pro) proCount.set(pro, (proCount.get(pro) || 0) + 1);
  }
  return stops.map((s) => {
    const pro = String(s?.pro ?? '').trim();
    if (pro && proCount.get(pro) === 1) return pro;
    return String(s?.stopNbr ?? '').trim() || pro || 'unknown';
  });
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best: string | null = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

// PURE: mine one day's warehouse stop records into reference route docs.
export function extractReferenceRoutes(
  stops: any[],
  opts: {
    tenant: string;
    date: string;
    cfg: EngineConfig;
    truckClassOf?: (stop: any) => string | null;   // roster join, injectable for tests
    nowIso?: string;
  },
): ExtractionResult {
  const { tenant, date, cfg } = opts;
  const truckClassOf = opts.truckClassOf || (() => null);
  const precisions: ZonePrecisions = {
    zone_precision: cfg.zone_precision,
    super_precision: cfg.super_precision,
    top_precision: cfg.top_precision,
  };

  // Evidence gate first: a reference route mined from day D must be the route D actually
  // RAN — next-day freight pre-planned under the same recurring name (see dropUnexecuted)
  // otherwise rides in with its own routeSeq and poisons the mined shape.
  const { stops: dayStops, excluded: unexecutedExcluded } = dropUnexecuted(stops || [], date);

  const groups = new Map<string, any[]>();
  for (const s of dayStops) {
    if (!routeEligible(s)) continue;
    const key = loadKeyForStop(s);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(s); else groups.set(key, [s]);
  }

  const routes: ReferenceRouteDoc[] = [];
  const skipped: ExtractionSkip[] = [];

  for (const [loadKey, group] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const planned = group.filter((s) => finiteNum(s?.routeSeq));
    let ordered: any[];
    let source: 'planned' | 'executed';
    if (planned.length >= cfg.min_route_stops) {
      ordered = [...planned].sort((a, b) =>
        (Number(a.routeSeq) - Number(b.routeSeq)) ||
        String(a.stopNbr ?? '').localeCompare(String(b.stopNbr ?? '')));
      source = 'planned';
    } else {
      const delivered = group.filter((s) => String(s?.deliveredDTTM ?? '').trim());
      if (delivered.length >= cfg.min_route_stops && delivered.length > cfg.executed_fallback_min_frac * group.length) {
        ordered = [...delivered].sort((a, b) =>
          String(a.deliveredDTTM).localeCompare(String(b.deliveredDTTM)) ||
          String(a.stopNbr ?? '').localeCompare(String(b.stopNbr ?? '')));
        source = 'executed';
      } else {
        skipped.push({ load_key: loadKey, reason: 'too_few_stops', stop_count: group.length, missing_coords: group.filter((s) => !hasCoords(s)).length });
        continue;
      }
    }

    const missing = ordered.filter((s) => !hasCoords(s)).length;
    if (missing / ordered.length > cfg.max_missing_coord_frac) {
      skipped.push({ load_key: loadKey, reason: 'missing_coords', stop_count: ordered.length, missing_coords: missing });
      continue;
    }
    const usable = ordered.filter(hasCoords);
    if (usable.length < cfg.min_route_stops) {
      skipped.push({ load_key: loadKey, reason: 'too_few_stops', stop_count: usable.length, missing_coords: missing });
      continue;
    }

    const ids = assignStopIds(usable);
    const refStops: ReferenceStop[] = usable.map((s, i) => ({
      pro: ids[i],
      matchKey: s?.customerMatchKey ?? null,
      businessName: s?.businessName ?? null,
      lat: Number(s.lat),
      lng: Number(s.lng),
      zone: zoneId(Number(s.lat), Number(s.lng), precisions),
      seq: i + 1,
    }));

    routes.push({
      tenant,
      date,
      load_key: loadKey,
      driver_name: mostCommon(usable.map((s) => s?.driverName ?? null)),
      driver_user_name: mostCommon(usable.map((s) => s?.driverUserName ?? null)),
      truck_class: truckClassOf(usable[0]),
      warehouse: mostCommon(usable.map((s) => s?.warehouse ?? null)),
      stop_count: refStops.length,
      source_seq: source,
      zone_seq: collapseConsecutive(refStops.map((r) => r.zone)),
      stops: refStops,
      updated_at: opts.nowIso || new Date().toISOString(),
    });
  }

  return { routes, skipped, unexecuted_excluded: unexecutedExcluded };
}

// PURE: pick the reference route for a target route — candidates must be
// strictly BEFORE the target date and share the warehouse; prefer the same
// driver, then the same truck class, ranked by (shared zone count, recency).
// Candidates sharing fewer than minOverlap zones never guide (→ UNGUIDED).
export function pickReference(
  candidates: Array<Pick<ReferenceRouteDoc, 'date' | 'load_key' | 'zone_seq' | 'driver_user_name' | 'truck_class' | 'warehouse'> & { _id?: string }>,
  target: {
    date: string;
    zones: Set<string>;
    driverUserName: string | null;
    truckClass: string | null;
    warehouse: string | null;
    minOverlap: number;
  },
): { ref: (typeof candidates)[number]; shared: number } | null {
  let best: { ref: (typeof candidates)[number]; shared: number } | null = null;
  // rank = [sameDriver, sameTruckClass, sharedZones, date, loadKey(desc-stable)]
  let bestRank: [number, number, number, string, string] | null = null;
  const beats = (a: [number, number, number, string, string], b: [number, number, number, string, string]): boolean => {
    if (a[0] !== b[0]) return a[0] > b[0];
    if (a[1] !== b[1]) return a[1] > b[1];
    if (a[2] !== b[2]) return a[2] > b[2];
    if (a[3] !== b[3]) return a[3] > b[3];
    return a[4] < b[4]; // deterministic final tiebreak: lowest load_key wins
  };
  for (const c of candidates || []) {
    if (!c || String(c.date) >= target.date) continue; // STRICTLY before — the leakage guard
    if (String(c.warehouse ?? '') !== String(target.warehouse ?? '')) continue;
    // zone_seq can revisit a zone (non-consecutively) — count DISTINCT shared zones
    const shared = new Set((c.zone_seq || []).filter((z) => target.zones.has(z))).size;
    if (shared < target.minOverlap) continue;
    const sameDriver = target.driverUserName && c.driver_user_name === target.driverUserName ? 1 : 0;
    const sameClass = target.truckClass && c.truck_class === target.truckClass ? 1 : 0;
    const rank: [number, number, number, string, string] = [sameDriver, sameClass, shared, String(c.date), String(c.load_key ?? '')];
    if (!bestRank || beats(rank, bestRank)) { best = { ref: c, shared }; bestRank = rank; }
  }
  return best;
}

// ── Phase 2.1: top-k reference selection (audit finding 2) ────────────────────
// The winners aggregated zone-order evidence across MANY historical routes,
// weighted by Amazon's route-quality labels. We have no quality labels; the
// stand-ins are RECENCY (half-life decay) and the SAME-DRIVER multiplier —
// which doubles as the mechanism that encodes each driver's own habitual
// ordering (see routing-customer-drivers.mts for the WHO; this is the IN WHAT
// ORDER half of the driver-habit ask).
//
// weight = sharedZones × 0.5^(ageDays / half_life) × (sameDriver ? multiplier : 1)
//
// Candidates: same warehouse, date STRICTLY < target (leakage guard re-applied
// here), sharing ≥ minOverlap distinct zones. Deterministic: ties broken by
// date desc then load_key asc.

export interface RankedReference {
  ref: ReferenceRouteDoc & { _id?: string };
  shared: number;
  weight: number;
}

function ageDays(candidateDate: string, targetDate: string): number {
  const a = Date.parse(candidateDate + 'T00:00:00Z');
  const b = Date.parse(targetDate + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 3650;
  return Math.max(0, (b - a) / 86_400_000);
}

export function pickReferences(
  candidates: Array<ReferenceRouteDoc & { _id?: string }>,
  target: {
    date: string;
    zones: Set<string>;
    driverUserName: string | null;
    truckClass: string | null;
    warehouse: string | null;
    minOverlap: number;
  },
  opts: { topK: number; halfLifeDays: number; sameDriverMultiplier: number },
): RankedReference[] {
  const ranked: RankedReference[] = [];
  for (const c of candidates || []) {
    if (!c || String(c.date) >= target.date) continue; // STRICTLY before — the leakage guard
    if (String(c.warehouse ?? '') !== String(target.warehouse ?? '')) continue;
    const shared = new Set((c.zone_seq || []).filter((z) => target.zones.has(z))).size;
    if (shared < target.minOverlap) continue;
    const decay = Math.pow(0.5, ageDays(String(c.date), target.date) / Math.max(1, opts.halfLifeDays));
    const driverBoost = target.driverUserName && c.driver_user_name === target.driverUserName
      ? opts.sameDriverMultiplier : 1;
    ranked.push({ ref: c, shared, weight: shared * decay * driverBoost });
  }
  ranked.sort((x, y) =>
    (y.weight - x.weight) ||
    String(y.ref.date).localeCompare(String(x.ref.date)) ||
    String(x.ref.load_key ?? '').localeCompare(String(y.ref.load_key ?? '')));
  return ranked.slice(0, Math.max(1, opts.topK));
}

// Write mined reference docs — full recompute per route doc, so OVERWRITE is
// the idempotency story (same inputs → same doc). Bounded concurrency.
export async function writeReferenceRoutes(docs: ReferenceRouteDoc[], conc = 8): Promise<number> {
  let i = 0, written = 0;
  const worker = async () => {
    while (i < docs.length) {
      const doc = docs[i++];
      await setDoc(referenceRoutePath(doc.tenant, doc.date, doc.load_key), doc);
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, docs.length || 1) }, worker));
  return written;
}

// INCREMENTAL day pass — called from the nightly history capture with that
// day's warehouse stop records already in memory (same hook point as the
// tractor daily pass; zero extra warehouse reads, zero NuVizz calls).
// ROUTING_ENGINE=off silences it; the manual backfill ignores that switch.
export async function updateRoutingReferencesForDay(
  tenant: string, date: string, stops: any[],
): Promise<{ mined: number; skipped: number; written: number; disabled?: boolean }> {
  if (routingEngineDisabled()) {
    console.log('[routing-engine] ROUTING_ENGINE=off — nightly reference pass skipped');
    return { mined: 0, skipped: 0, written: 0, disabled: true };
  }
  const cfg = await loadEngineConfig(tenant);
  let roster: VehicleRoster | null = null;
  try { roster = await loadVehicleRoster(); } catch (e: any) {
    console.error('[routing-engine] vehicle roster load failed (truck_class will be null):', e?.message);
  }
  const { routes, skipped } = extractReferenceRoutes(stops, {
    tenant, date, cfg,
    truckClassOf: roster ? (s) => vehicleTypeForStop(s, roster!) : undefined,
  });
  const written = await writeReferenceRoutes(routes);
  console.log(`[routing-engine] ${date}: mined ${routes.length} reference route(s), skipped ${skipped.length}, wrote ${written}`);
  return { mined: routes.length, skipped: skipped.length, written };
}
