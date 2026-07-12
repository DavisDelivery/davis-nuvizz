// lib/routing-engine-config.mts
//
// Configuration + version constants for the LEARNED ROUTING ENGINE (Phase 1 —
// shadow mode). The engine feeds entirely off the Firestore history warehouse
// (history_days) and the MarginIQ employees roster: ZERO NuVizz calls, ZERO
// Google Route Matrix calls anywhere in the engine. Travel times are estimated
// with haversine distance × a road factor and a speed model — sequence
// similarity is driven by constraint structure, not travel-time precision.
//
// Storage mirrors the scan-config pattern (defaults from env → clamp stored →
// overlay): one Firestore doc routing_engine_config/{tenant}. An empty/missing
// doc reproduces env/default behavior exactly, and every knob is clamped by the
// same pure function on read and write so a bad value can never persist.
//
// ENGINE_VERSION is stamped on every proposal doc so score history can be
// segmented when the engine's brain changes. Bump it whenever the solver,
// scoring, zone layer, or reference selection changes behavior.

import { getDoc, setDoc } from './firestore.mts';

export const ENGINE_VERSION = '1.0.0';

export const ENGINE_CONFIG_COLLECTION = 'routing_engine_config';

export function engineConfigPath(tenant: string): string {
  return `${ENGINE_CONFIG_COLLECTION}/${tenant}`;
}

// Kill switch for the nightly shadow job + the nightly reference-miner pass.
// Manual backfill/replay functions ignore it — invoking those by hand IS the
// intent (same policy as TRACTOR_FLAGS=off vs the tractor rebuild).
export function routingEngineDisabled(): boolean {
  return String(process.env.ROUTING_ENGINE || 'on').toLowerCase() === 'off';
}

export interface EngineConfig {
  // Zone layer — geohash precisions (zone ⊂ super ⊂ top by prefix).
  zone_precision: number;      // ~0.7 km cell
  super_precision: number;
  top_precision: number;
  // Travel-time estimator: haversine miles × road_factor, tiered speed model.
  road_factor: number;
  speed_short_mph: number;     // under short_break_mi
  speed_mid_mph: number;       // short_break_mi .. long_break_mi
  speed_long_mph: number;      // over long_break_mi
  short_break_mi: number;
  long_break_mi: number;
  // Solver constants.
  big_m_min: number;           // HARD zone-clustering constant added to cross-zone edges
  precedence_penalty: number;  // per violated reference precedence pair
  hierarchy_penalty: number;   // per extra entry at each hierarchy level
  penalty_multiplier: number;  // objective = travel_min + penalty_multiplier × penalty
  restarts: number;            // randomized restarts (deterministic seed from loadKey)
  solver_ms_cap: number;       // hard wall-clock cap per route
  // Reference mining / eligibility.
  min_route_stops: number;             // skip routes with fewer stops
  max_missing_coord_frac: number;      // skip routes missing lat/lng on more than this fraction
  executed_fallback_min_frac: number;  // deliveredDTTM coverage needed for executed-order fallback
  // Reference selection / replay.
  min_reference_zone_overlap: number;  // shared zones required to be GUIDED
  min_prior_reference_days: number;    // replay: prior reference days required before scoring
}

const NUMERIC_KEYS: Array<keyof EngineConfig> = [
  'zone_precision', 'super_precision', 'top_precision',
  'road_factor', 'speed_short_mph', 'speed_mid_mph', 'speed_long_mph',
  'short_break_mi', 'long_break_mi',
  'big_m_min', 'precedence_penalty', 'hierarchy_penalty', 'penalty_multiplier',
  'restarts', 'solver_ms_cap',
  'min_route_stops', 'max_missing_coord_frac', 'executed_fallback_min_frac',
  'min_reference_zone_overlap', 'min_prior_reference_days',
];

export const ENGINE_CONFIG_BOUNDS: Record<keyof EngineConfig, [number, number]> = {
  zone_precision: [4, 8],
  super_precision: [3, 7],
  top_precision: [2, 6],
  road_factor: [1, 2.5],
  speed_short_mph: [5, 60],
  speed_mid_mph: [5, 70],
  speed_long_mph: [5, 80],
  short_break_mi: [0.5, 20],
  long_break_mi: [1, 100],
  big_m_min: [1000, 10_000_000],
  precedence_penalty: [0, 1000],
  hierarchy_penalty: [0, 1000],
  penalty_multiplier: [1, 1_000_000],
  restarts: [1, 64],
  solver_ms_cap: [50, 15_000],
  min_route_stops: [2, 100],
  max_missing_coord_frac: [0, 1],
  executed_fallback_min_frac: [0, 1],
  min_reference_zone_overlap: [1, 20],
  min_prior_reference_days: [0, 365],
};

// PURE: defaults, each overridable by env (ROUTING_ENGINE_<UPPER_SNAKE>).
export function engineConfigDefaults(env: Record<string, string | undefined> = process.env): EngineConfig {
  const num = (key: string, dflt: number): number => {
    const v = Number(env[`ROUTING_ENGINE_${key}`]);
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    zone_precision: num('ZONE_PRECISION', 6),
    super_precision: num('SUPER_PRECISION', 5),
    top_precision: num('TOP_PRECISION', 4),
    road_factor: num('ROAD_FACTOR', 1.35),
    speed_short_mph: num('SPEED_SHORT_MPH', 22),
    speed_mid_mph: num('SPEED_MID_MPH', 35),
    speed_long_mph: num('SPEED_LONG_MPH', 48),
    short_break_mi: num('SHORT_BREAK_MI', 3),
    long_break_mi: num('LONG_BREAK_MI', 10),
    big_m_min: num('BIG_M_MIN', 100_000),
    precedence_penalty: num('PRECEDENCE_PENALTY', 1),
    hierarchy_penalty: num('HIERARCHY_PENALTY', 10),
    penalty_multiplier: num('PENALTY_MULTIPLIER', 1500),
    restarts: num('RESTARTS', 8),
    solver_ms_cap: num('SOLVER_MS_CAP', 1000),
    min_route_stops: num('MIN_ROUTE_STOPS', 5),
    max_missing_coord_frac: num('MAX_MISSING_COORD_FRAC', 0.2),
    executed_fallback_min_frac: num('EXECUTED_FALLBACK_MIN_FRAC', 0.5),
    min_reference_zone_overlap: num('MIN_REFERENCE_ZONE_OVERLAP', 2),
    min_prior_reference_days: num('MIN_PRIOR_REFERENCE_DAYS', 14),
  };
}

// PURE: clamp a stored/user config fragment to bounds; drop unknown/NaN keys.
export function clampEngineConfig(input: any): Partial<EngineConfig> {
  const out: Partial<EngineConfig> = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of NUMERIC_KEYS) {
    const v = Number((input as any)[key]);
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = ENGINE_CONFIG_BOUNDS[key];
    (out as any)[key] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

// PURE: effective config = env-aware defaults overlaid with the clamped stored doc.
export function effectiveEngineConfig(
  stored: any, env: Record<string, string | undefined> = process.env,
): EngineConfig {
  return { ...engineConfigDefaults(env), ...clampEngineConfig(stored) };
}

// I/O: read the effective config for a tenant (missing doc → pure defaults).
export async function loadEngineConfig(tenant: string): Promise<EngineConfig> {
  let stored: any = null;
  try { stored = await getDoc(engineConfigPath(tenant)); } catch { /* defaults */ }
  return effectiveEngineConfig(stored);
}

export async function writeEngineConfig(tenant: string, cfg: Partial<EngineConfig>): Promise<boolean> {
  return setDoc(engineConfigPath(tenant), { ...clampEngineConfig(cfg), updated_at: new Date().toISOString() });
}
