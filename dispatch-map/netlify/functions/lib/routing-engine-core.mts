// lib/routing-engine-core.mts
//
// SHADOW-MODE core for the learned routing engine: for one warehouse date,
// take the routes dispatch actually built, have the solver re-sequence each
// one from learned constraints, score the engine's sequence against the
// dispatcher's with the official challenge metric, and persist proposals + a
// daily rollup. The engine proposes and scores — it changes NOTHING. All
// writes land in route_proposals / route_proposals_daily; history_days and
// every live board collection are read-only here. ZERO NuVizz calls, ZERO
// Google Route Matrix calls.
//
//   route_proposals/{tenant}__{date}__{loadKey}
//     tenant, date, load_key, driver_name, truck_class, stop_count,
//     zones_count, unguided (bool), reference_route_id,
//     actual_seq: [pro…], proposed_seq: [pro…],
//     stops: [{pro, businessName, lat, lng, zone, actual_pos, proposed_pos}…],
//     score, travel_min_actual_est, travel_min_proposed_est,
//     engine_version, computed_at
//   route_proposals_daily/{tenant}__{date}
//     routes_scored, routes_skipped, mean_score, median_score,
//     mean_travel_delta_min, unguided_count, engine_version, computed_at
//
// Reference lookups use dates STRICTLY BEFORE the target date — enforced here
// even when a replay hands in a pre-loaded reference list, so leakage is
// impossible by construction (tested).

import { getDoc, setDoc, runQuery } from './firestore.mts';
import { listStops } from './history-store.mts';
import { DEPOT } from './history-derive.mts';
import { ENGINE_VERSION, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';
import {
  REFERENCE_ROUTES_COLLECTION, extractReferenceRoutes, pickReferences,
  referenceRouteId, type ReferenceRouteDoc,
} from './routing-reference.mts';
import { loadVehicleRoster, vehicleTypeForStop } from './tractor-flags.mts';
import {
  DEPOT_ID, buildTravelMatrix, solveRoute, travelMinutesForOrder, type EngineStop,
} from './routing-engine-solver.mts';
import { scoreRoute, toScoreList } from './score.mts';

export const PROPOSALS_COLLECTION = 'route_proposals';
export const PROPOSALS_DAILY_COLLECTION = 'route_proposals_daily';

export function proposalId(tenant: string, date: string, loadKey: string): string {
  return referenceRouteId(tenant, date, loadKey); // same {tenant}__{date}__{loadKey} shape
}
export function proposalPath(tenant: string, date: string, loadKey: string): string {
  return `${PROPOSALS_COLLECTION}/${proposalId(tenant, date, loadKey)}`;
}
export function dailyRollupPath(tenant: string, date: string): string {
  return `${PROPOSALS_DAILY_COLLECTION}/${tenant}__${date}`;
}

// All references mined before `date` (STRICT), same tenant. Single-field range
// on `date` rides Firestore's automatic index; tenant is filtered client-side
// (single-tenant deployment, ids are prefixed anyway).
export async function listReferencesBefore(tenant: string, date: string): Promise<ReferenceRouteDoc[]> {
  const rows = await runQuery({
    from: [{ collectionId: REFERENCE_ROUTES_COLLECTION }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'date' },
        op: 'LESS_THAN',
        value: { stringValue: date },
      },
    },
  });
  return rows.filter((r: any) => r?.tenant === tenant);
}

// PURE: median of a numeric list.
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface ShadowRouteResult {
  proposal: any;
  unguided: boolean;
  score: number;
}

// PURE: solve + score ONE dispatched route against the reference library.
// `references` may contain any dates — the strict `< date` guard is applied
// HERE, not trusted from the caller (replay leakage guard).
export function shadowScoreRoute(
  route: ReferenceRouteDoc,
  references: ReferenceRouteDoc[],
  cfg: EngineConfig,
  nowIso?: string,
): ShadowRouteResult {
  const zones = new Set(route.stops.map((s) => s.zone));
  // Phase 2.1: TOP-K weighted references (audit finding 2) — precedence is
  // learned from an aggregate consensus graph, not a single best neighbor. The
  // strict < date leakage filter is applied both here and inside pickReferences.
  const picked = pickReferences(
    references.filter((r) => String(r.date) < String(route.date)),
    {
      date: route.date,
      zones,
      driverUserName: route.driver_user_name,
      truckClass: route.truck_class,
      warehouse: route.warehouse,
      minOverlap: cfg.min_reference_zone_overlap,
    },
    {
      topK: cfg.reference_top_k,
      halfLifeDays: cfg.reference_half_life_days,
      sameDriverMultiplier: cfg.same_driver_multiplier,
    },
  );

  const engineStops: EngineStop[] = route.stops.map((s) => ({ id: s.pro, lat: s.lat, lng: s.lng, zone: s.zone }));
  const solved = solveRoute({
    loadKey: route.load_key,
    stops: engineStops,
    depot: { lat: DEPOT.lat, lng: DEPOT.lng },
    referenceZoneSeq: null,
    references: picked.length
      ? picked.map((p) => ({ zone_seq: p.ref.zone_seq, weight: p.weight }))
      : null,
    cfg,
  });

  const points = [{ id: DEPOT_ID, lat: DEPOT.lat, lng: DEPOT.lng }, ...engineStops];
  const matrix = buildTravelMatrix(points, cfg);
  const actualIds = route.stops.map((s) => s.pro);
  const proposedIds = solved.order.map((s) => s.id);
  const score = scoreRoute(toScoreList(DEPOT_ID, actualIds), toScoreList(DEPOT_ID, proposedIds), matrix);

  const actualOrder = route.stops.map((s) => ({ id: s.pro, lat: s.lat, lng: s.lng, zone: s.zone }));
  const travelActual = travelMinutesForOrder(actualOrder, matrix);
  const travelProposed = travelMinutesForOrder(solved.order, matrix);

  const proposedPos = new Map<string, number>();
  proposedIds.forEach((id, i) => proposedPos.set(id, i + 1));

  const top = picked.length ? picked[0] : null;
  const refDoc = top ? (top.ref as any) : null;
  const proposal = {
    tenant: route.tenant,
    date: route.date,
    load_key: route.load_key,
    driver_name: route.driver_name,
    driver_user_name: route.driver_user_name,
    truck_class: route.truck_class,
    warehouse: route.warehouse,
    stop_count: route.stop_count,
    zones_count: zones.size,
    unguided: !top,
    // Top-weighted reference kept in the legacy fields (UI/back-compat); the
    // full consensus set is summarized alongside.
    reference_route_id: refDoc
      ? (refDoc._id || referenceRouteId(route.tenant, refDoc.date, refDoc.load_key))
      : null,
    reference_date: refDoc ? refDoc.date : null,
    reference_shared_zones: top ? top.shared : 0,
    references_used: picked.length,
    reference_ids: picked.map((p) => (p.ref as any)._id || referenceRouteId(route.tenant, p.ref.date, p.ref.load_key)),
    actual_seq: actualIds,
    proposed_seq: proposedIds,
    stops: route.stops.map((s, i) => ({
      pro: s.pro,
      businessName: s.businessName ?? null,
      lat: s.lat,
      lng: s.lng,
      zone: s.zone,
      actual_pos: i + 1,
      proposed_pos: proposedPos.get(s.pro) ?? null,
    })),
    score,
    travel_min_actual_est: Math.round(travelActual * 10) / 10,
    travel_min_proposed_est: Math.round(travelProposed * 10) / 10,
    source_seq: route.source_seq,
    engine_version: ENGINE_VERSION,
    computed_at: nowIso || new Date().toISOString(),
  };
  return { proposal, unguided: !top, score };
}

export interface ShadowDaySummary {
  ok: boolean;
  tenant: string;
  date: string;
  skipped_existing?: boolean;
  routes_scored: number;
  routes_skipped: number;
  unguided_count: number;
  mean_score: number | null;
  median_score: number | null;
  mean_travel_delta_min: number | null;
  references_available: number;
  ms: number;
}

// Run the full shadow pass for one date. `opts.references` lets the replay
// hand in a pre-loaded library (still date-filtered per route above);
// `opts.force` recomputes over an existing rollup for the same engine version.
export async function runShadowForDate(
  tenant: string,
  date: string,
  opts: { references?: ReferenceRouteDoc[]; force?: boolean; cfg?: EngineConfig } = {},
): Promise<ShadowDaySummary> {
  const t0 = Date.now();
  const cfg = opts.cfg || await loadEngineConfig(tenant);

  if (!opts.force) {
    const existing = await getDoc(dailyRollupPath(tenant, date));
    if (existing && existing.engine_version === ENGINE_VERSION) {
      return {
        ok: true, tenant, date, skipped_existing: true,
        routes_scored: Number(existing.routes_scored) || 0,
        routes_skipped: Number(existing.routes_skipped) || 0,
        unguided_count: Number(existing.unguided_count) || 0,
        mean_score: existing.mean_score ?? null,
        median_score: existing.median_score ?? null,
        mean_travel_delta_min: existing.mean_travel_delta_min ?? null,
        references_available: -1,
        ms: Date.now() - t0,
      };
    }
  }

  const stops = await listStops(tenant, date);
  let truckClassOf: ((s: any) => string | null) | undefined;
  try {
    const roster = await loadVehicleRoster();
    truckClassOf = (s) => vehicleTypeForStop(s, roster);
  } catch (e: any) {
    console.error('[routing-engine] roster load failed (truck_class null):', e?.message);
  }
  const { routes, skipped } = extractReferenceRoutes(stops, { tenant, date, cfg, truckClassOf });
  const references = opts.references ?? await listReferencesBefore(tenant, date);

  const nowIso = new Date().toISOString();
  const results: ShadowRouteResult[] = routes.map((r) => shadowScoreRoute(r, references, cfg, nowIso));

  // bounded-concurrency proposal writes
  let i = 0;
  const worker = async () => {
    while (i < results.length) {
      const r = results[i++];
      await setDoc(proposalPath(tenant, date, r.proposal.load_key), r.proposal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, results.length || 1) }, worker));

  const scores = results.map((r) => r.score);
  const deltas = results.map((r) => r.proposal.travel_min_proposed_est - r.proposal.travel_min_actual_est);
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const unguidedCount = results.filter((r) => r.unguided).length;
  // Segmented means (audit finding 4): an unguided route had no teacher, so its
  // score measures a different thing — never let it dilute the guided headline.
  const guidedScores = results.filter((r) => !r.unguided).map((r) => r.score);
  const unguidedScores = results.filter((r) => r.unguided).map((r) => r.score);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  await setDoc(dailyRollupPath(tenant, date), {
    tenant,
    date,
    routes_scored: results.length,
    routes_skipped: skipped.length,
    unguided_count: unguidedCount,
    mean_score: meanScore,
    median_score: median(scores),
    mean_score_guided: mean(guidedScores),
    median_score_guided: median(guidedScores),
    mean_score_unguided: mean(unguidedScores),
    mean_travel_delta_min: meanDelta === null ? null : Math.round(meanDelta * 10) / 10,
    engine_version: ENGINE_VERSION,
    computed_at: nowIso,
  });

  return {
    ok: true, tenant, date,
    routes_scored: results.length,
    routes_skipped: skipped.length,
    unguided_count: unguidedCount,
    mean_score: meanScore,
    median_score: median(scores),
    mean_travel_delta_min: meanDelta === null ? null : Math.round(meanDelta * 10) / 10,
    references_available: references.length,
    ms: Date.now() - t0,
  };
}
