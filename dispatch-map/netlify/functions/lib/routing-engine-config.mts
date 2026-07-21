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

export const ENGINE_VERSION = '2.8.0';

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

  // ── Phase 2: assignment layer ──────────────────────────────────────────────
  service_min_clamp: number;           // service-time observations clamped to this band (min)
  service_max_clamp: number;           // …and this (max), before aggregating
  min_observation_days: number;        // driver envelope needs ≥ this many observed days, else class fallback
  hard_cap_factor: number;             // per-trip envelope p85 × this = the physical ceiling (hard)
  assignment_ms_cap: number;           // per-day assignment-solver wall-clock cap
  reload_gap_min: number;              // fleet reload-turn seed (median last-touch trip1 → first-touch trip2)
  typical_shift_hours: number;         // fallback shift length when a driver's history is thin
  far_first_adherence: number;         // fleet far-first seed (trip1 farther than trip2)
  trip2_radius_mi: number;             // fleet trip-2 close-in radius seed
  // soft-cost weights (assignment objective = Σ weight × normalized term)
  w_affinity: number;
  w_trips: number;
  w_shift_overflow: number;
  w_far_first: number;
  w_strict_window: number;
  w_compactness: number;

  // ── Phase 2.1: top-k weighted reference graph (audit finding 2) ────────────
  reference_top_k: number;          // aggregate this many references into the zone digraph
  reference_half_life_days: number; // recency decay half-life for candidate ranking
  same_driver_multiplier: number;   // rank boost for the SAME driver's own history — the
                                    // stand-in for the challenge's quality labels, and how
                                    // each driver's habitual ORDER is encoded (see Phase 4 note)
  reference_edge_floor: number;     // drop aggregate edges below this fraction of total ref weight
  // ── Phase 2.1: customer driver-habit soft cost ──────────────────────────────
  w_habit: number;                  // weight for "this stop's habitual driver" in the plan solver
  habit_shrink_n: number;           // strength = top_share × n/(n+shrink) — small n = weak signal

  // ── Phase 2.2: far-cluster consolidation (stop dragging spare trucks to a distant corner) ──
  // Dispatch prices a distant loop intuitively ("it's 60 mi out — give the whole
  // thing to one truck"); the per-stop assignment never did. These four give the
  // objective the missing concept of the marginal cost of an EXTRA truck reaching
  // a far cluster, all keyed on the already-computed stop.miles (no new data).
  far_deadhead_mi: number;    // stops beyond this depot-distance are "far"
  w_far_deadhead: number;     // per-shift charge for a driver reaching past far_deadhead_mi (per 10 mi beyond)
  habit_far_discount: number; // FAR stops count habit at this fraction — geography should win out there (0..1)
  w_zone_cohesion: number;    // per EXTRA distinct driver serving the same far gh5 zone (reward one owner)

  // ── Phase 2.3: learned territory ownership (Dalton belongs to its owners) ──
  // A far TOP zone (gh4 area) whose reference history shows drivers carrying a
  // real share becomes THEIRS: giving one of its stops to anyone else is charged
  // hard. Areas served by everybody (Atlanta) never concentrate past the share
  // floor, so no owner set forms and they stay open — the distinction is
  // learned, never hardcoded.
  w_zone_owner: number;        // per FAR stop assigned outside its zone's learned owner set
  zone_owner_min_share: number; // a driver owns a zone at ≥ this share of its historical stops (0..1)
  zone_owner_min_obs: number;   // a zone needs ≥ this many observed stops before ownership applies

  // ── Phase 2.8: per-CLASS skid caps (what a truck physically holds) ─────────
  // The freight study's core capacity fact: the binding dimension of a load is
  // SKID POSITIONS, not weight (dispatch cubes out, it doesn't weigh out — the
  // 2.1.1 weight ceiling manufactured phantom splits and 2.5.0's weight
  // balancing fought territory concentration). Caps are per truck CLASS, mined
  // from ~900 real dispatch trips: box p85=19/p95=22, tractor p85=31/p95=37.
  // Soft = where dispatch starts splitting a zone's work across its candidate
  // cast; hard = the splitter's physical bound. A cap is NOT a balancer: below
  // it, concentration is free — it only binds when a truck is genuinely full.
  skid_cap_box_soft: number;
  skid_cap_box_hard: number;
  skid_cap_tractor_soft: number;
  skid_cap_tractor_hard: number;
  loose_per_skid: number;      // loose pieces occupying one skid position (skid_equiv = skids + loose/this)
  w_skid_soft: number;         // per skid-equiv above the class SOFT cap on a trip

  // ── Phase 2.1: THE ROUTING CALENDAR ─────────────────────────────────────────
  // Encoded operating fact, not lore: dispatch builds routes OVERNIGHT
  // (~20:00 ET → ~07:00 ET next morning; Sunday night builds Monday, Thursday
  // night builds Friday). No Saturday/Sunday boards, no Friday- or
  // Saturday-night routing. Therefore board date D is FINAL by ~07:00 ET on D
  // and fully executed by D evening — which is why the 02:00 ET capture and
  // 03:30 ET engine run on D+1 always read a final, executed board.
  // DERIVED LAW for future phases (Assist): any job reading the CURRENT day's
  // plan must never run before 07:30 ET on D (see planReadEarliestOkET), and
  // Assist proposal generation must eventually run INSIDE 20:00–07:00.
  routing_calendar: RoutingCalendar;
}

export interface RoutingCalendar {
  board_days: number[];          // ISO weekday numbers with Sunday=0 … Saturday=6; default Mon–Fri
  window_start_local: string;    // "HH:MM" — overnight build window start (evening before D)
  window_end_local: string;      // "HH:MM" — build window end (morning of D; board final after this)
  timezone: string;              // IANA zone the window is anchored to
}

const NUMERIC_KEYS: Array<keyof EngineConfig> = [
  'zone_precision', 'super_precision', 'top_precision',
  'road_factor', 'speed_short_mph', 'speed_mid_mph', 'speed_long_mph',
  'short_break_mi', 'long_break_mi',
  'big_m_min', 'precedence_penalty', 'hierarchy_penalty', 'penalty_multiplier',
  'restarts', 'solver_ms_cap',
  'min_route_stops', 'max_missing_coord_frac', 'executed_fallback_min_frac',
  'min_reference_zone_overlap', 'min_prior_reference_days',
  'service_min_clamp', 'service_max_clamp', 'min_observation_days', 'hard_cap_factor',
  'assignment_ms_cap', 'reload_gap_min', 'typical_shift_hours', 'far_first_adherence',
  'trip2_radius_mi',
  'w_affinity', 'w_trips', 'w_shift_overflow',
  'w_far_first', 'w_strict_window', 'w_compactness',
  'reference_top_k', 'reference_half_life_days', 'same_driver_multiplier', 'reference_edge_floor',
  'w_habit', 'habit_shrink_n',
  'far_deadhead_mi', 'w_far_deadhead', 'habit_far_discount', 'w_zone_cohesion',
  'w_zone_owner', 'zone_owner_min_share', 'zone_owner_min_obs',
  'skid_cap_box_soft', 'skid_cap_box_hard', 'skid_cap_tractor_soft', 'skid_cap_tractor_hard',
  'loose_per_skid', 'w_skid_soft',
];

export const ENGINE_CONFIG_BOUNDS: Record<Exclude<keyof EngineConfig, 'routing_calendar'>, [number, number]> = {
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
  service_min_clamp: [0, 60],
  service_max_clamp: [10, 480],
  min_observation_days: [1, 120],
  hard_cap_factor: [1, 2],
  assignment_ms_cap: [1000, 300_000],
  reload_gap_min: [15, 480],
  typical_shift_hours: [4, 16],
  far_first_adherence: [0, 1],
  trip2_radius_mi: [1, 200],
  w_affinity: [0, 1000],
  w_trips: [0, 1000],
  w_shift_overflow: [0, 1000],
  w_far_first: [0, 1000],
  w_strict_window: [0, 1000],
  w_compactness: [0, 1000],
  reference_top_k: [1, 10],
  reference_half_life_days: [5, 365],
  same_driver_multiplier: [1, 10],
  reference_edge_floor: [0, 1],
  w_habit: [0, 1000],
  habit_shrink_n: [0, 50],
  far_deadhead_mi: [10, 200],
  w_far_deadhead: [0, 1000],
  habit_far_discount: [0, 1],
  w_zone_cohesion: [0, 1000],
  w_zone_owner: [0, 1000],
  zone_owner_min_share: [0.01, 1],
  zone_owner_min_obs: [1, 10_000],
  skid_cap_box_soft: [5, 60],
  skid_cap_box_hard: [5, 80],
  skid_cap_tractor_soft: [5, 100],
  skid_cap_tractor_hard: [5, 120],
  loose_per_skid: [1, 100],
  w_skid_soft: [0, 1000],
};

// NOTE: routing_calendar is NOT in ENGINE_CONFIG_BOUNDS — it is structured, not
// numeric, and is validated by clampRoutingCalendar below.

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
    // TUNING MEMORY (audit finding 6): 1500 / 10 / 1 are the winners' exact
    // constants — but they tuned 1500 against a travel term in SECONDS, and
    // ours is in MINUTES, so the penalty here is ~60× more order-dominant than
    // in LKH-AMZ. That is INTENTIONAL for a shadow-similarity objective (obey
    // the learned order; travel is the tie-breaker). If you ever retune,
    // convert units first or you will be comparing apples to seconds.
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
    // Phase 2 — defaults seeded from the verified OPERATING FACTS.
    service_min_clamp: num('SERVICE_MIN_CLAMP', 2),
    service_max_clamp: num('SERVICE_MAX_CLAMP', 120),
    min_observation_days: num('MIN_OBSERVATION_DAYS', 10),
    hard_cap_factor: num('HARD_CAP_FACTOR', 1.15),
    assignment_ms_cap: num('ASSIGNMENT_MS_CAP', 90_000),
    reload_gap_min: num('RELOAD_GAP_MIN', 132),
    typical_shift_hours: num('TYPICAL_SHIFT_HOURS', 10),
    far_first_adherence: num('FAR_FIRST_ADHERENCE', 0.82),
    trip2_radius_mi: num('TRIP2_RADIUS_MI', 20),
    w_affinity: num('W_AFFINITY', 2),
    w_trips: num('W_TRIPS', 12),  // strong vote: trip count must track the driver's real double-trip propensity (was 1.5, too weak to matter)
    w_shift_overflow: num('W_SHIFT_OVERFLOW', 4),
    w_far_first: num('W_FAR_FIRST', 1),
    w_strict_window: num('W_STRICT_WINDOW', 2),
    w_compactness: num('W_COMPACTNESS', 1),
    // Phase 2.1
    reference_top_k: num('REFERENCE_TOP_K', 5),
    reference_half_life_days: num('REFERENCE_HALF_LIFE_DAYS', 45),
    same_driver_multiplier: num('SAME_DRIVER_MULTIPLIER', 2.0),
    reference_edge_floor: num('REFERENCE_EDGE_FLOOR', 0.2),
    // w_habit > w_affinity by default: a strong CUSTOMER-level habit signal
    // outranks the ZONE-level affinity signal (the brief's ordering).
    w_habit: num('W_HABIT', 3),
    habit_shrink_n: num('HABIT_SHRINK_N', 4),
    // Phase 2.2 — far-cluster consolidation. 45 mi is comfortably past the mid
    // ring most drivers work; beyond it, dragging a fresh truck out is the thing
    // dispatch avoids. w_far_deadhead=6 makes a second truck's ~20-mi-past reach
    // (6 × 2 = 12) dwarf a single stop's habit pull (~w_habit × strength ≈ 1.5),
    // so the far loop coalesces onto whoever is already out there.
    far_deadhead_mi: num('FAR_DEADHEAD_MI', 45),
    w_far_deadhead: num('W_FAR_DEADHEAD', 6),
    habit_far_discount: num('HABIT_FAR_DISCOUNT', 0.35),
    // 2.4.0: raised 4→8 and distance-scaled in planCost (× maxMiles/threshold):
    // a straggler truck 60 mi out now pays ~11, decisively losing to the ~12-15
    // cost of folding its stop onto the zone's owner — one-stop far trucks die.
    w_zone_cohesion: num('W_ZONE_COHESION', 8),
    // Phase 2.3 — territory ownership. w_zone_owner=10 per misplaced far stop is
    // the strongest per-stop vote in the objective: it must beat the sum of habit
    // (≤3) + headroom pulls so a Dalton stop can never profitably land outside
    // Dalton's learned owners. min_share=0.10 admits real co-owners (Victor at
    // 28%, Che at 15%) while excluding one-off fill-ins; min_obs=25 stops keeps
    // noise zones from locking in.
    w_zone_owner: num('W_ZONE_OWNER', 10),
    zone_owner_min_share: num('ZONE_OWNER_MIN_SHARE', 0.10),
    zone_owner_min_obs: num('ZONE_OWNER_MIN_OBS', 25),
    // Phase 2.8 — per-class skid caps, mined from 912 dispatch trips (6/29-7/20):
    // box p50=14 p85=19 p95=22 max=38; tractor p50=26 p85=31 p95=37 max=67.
    // Soft=p85 rounded up (where the cast split starts), hard=p95 (the physical
    // split bound; the p99+ tail reads as data quirks, not truck capacity).
    // loose_per_skid=10: only 22/912 trips were loose-dominant — loose barely
    // moves the caps (p85 +0.2) but a 100-piece Uline day still occupies floor.
    // w_skid_soft=2/skid-eq over soft: redirecting a 2-skid overflow stop saves 4,
    // beating mild affinity misfit (≤2) but NOT a strong customer habit (3) —
    // dispatch keeps a strongly-habitual customer on a packed truck too.
    skid_cap_box_soft: num('SKID_CAP_BOX_SOFT', 20),
    skid_cap_box_hard: num('SKID_CAP_BOX_HARD', 22),
    skid_cap_tractor_soft: num('SKID_CAP_TRACTOR_SOFT', 31),
    skid_cap_tractor_hard: num('SKID_CAP_TRACTOR_HARD', 37),
    loose_per_skid: num('LOOSE_PER_SKID', 10),
    w_skid_soft: num('W_SKID_SOFT', 2),
    routing_calendar: routingCalendarDefaults(env),
  };
}

// ── routing calendar (structured config) ─────────────────────────────────────

export const DEFAULT_ROUTING_CALENDAR: RoutingCalendar = Object.freeze({
  board_days: [1, 2, 3, 4, 5],        // Mon–Fri (Sunday=0)
  window_start_local: '20:00',
  window_end_local: '07:00',
  timezone: 'America/New_York',
});

function routingCalendarDefaults(env: Record<string, string | undefined> = process.env): RoutingCalendar {
  // Env override is a JSON blob (rarely used; the Firestore doc is the normal path).
  try {
    const raw = env.ROUTING_ENGINE_CALENDAR;
    if (raw) return clampRoutingCalendar(JSON.parse(raw));
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_ROUTING_CALENDAR, board_days: [...DEFAULT_ROUTING_CALENDAR.board_days] };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// PURE: validate/clamp a stored calendar fragment; anything invalid falls back
// to the default field-by-field (same never-persist-garbage property as the
// numeric clamp).
export function clampRoutingCalendar(input: any): RoutingCalendar {
  const d = DEFAULT_ROUTING_CALENDAR;
  const out: RoutingCalendar = { board_days: [...d.board_days], window_start_local: d.window_start_local, window_end_local: d.window_end_local, timezone: d.timezone };
  if (!input || typeof input !== 'object') return out;
  if (Array.isArray(input.board_days)) {
    const days = [...new Set(input.board_days.map((v: any) => Number(v)).filter((v: number) => Number.isInteger(v) && v >= 0 && v <= 6))].sort();
    if (days.length) out.board_days = days as number[];
  }
  if (HHMM_RE.test(String(input.window_start_local ?? ''))) out.window_start_local = String(input.window_start_local);
  if (HHMM_RE.test(String(input.window_end_local ?? ''))) out.window_end_local = String(input.window_end_local);
  if (typeof input.timezone === 'string' && input.timezone.includes('/')) out.timezone = input.timezone;
  return out;
}

// PURE: is `dateStr` (YYYY-MM-DD) a board day? Weekday of a calendar date is
// timezone-independent (noon-UTC trick avoids DST edges). Sunday=0.
export function isBoardDay(dateStr: string, calendar: RoutingCalendar = DEFAULT_ROUTING_CALENDAR): boolean {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return calendar.board_days.includes(day);
}

// DERIVED LAW for future phases — see the routing_calendar comment above.
// A job that reads the CURRENT day's plan (Assist proposal runs, plan
// snapshots) must never run before the board is final: window_end_local
// (07:00) plus a 30-minute settle = 07:30 ET on D. Nothing calls this today —
// the nightly shadow reads D-1, which the calendar proves is always final —
// but Phase 3 Assist MUST route current-day reads through this gate.
export function planReadEarliestOkET(calendar: RoutingCalendar = DEFAULT_ROUTING_CALENDAR): string {
  const [h, m] = calendar.window_end_local.split(':').map(Number);
  const settled = h * 60 + m + 30;
  return `${String(Math.floor(settled / 60)).padStart(2, '0')}:${String(settled % 60).padStart(2, '0')}`;
}
export function assertCurrentDayReadAllowed(nowLocalHHMM: string, calendar: RoutingCalendar = DEFAULT_ROUTING_CALENDAR): void {
  const min = planReadEarliestOkET(calendar);
  if (nowLocalHHMM < min) {
    throw new Error(`current-day plan read before ${min} ${calendar.timezone} — the board is not final until ${calendar.window_end_local} (routing_calendar)`);
  }
}

// PURE: clamp a stored/user config fragment to bounds; drop unknown/NaN keys.
// routing_calendar (the one structured field) gets its own validator.
export function clampEngineConfig(input: any): Partial<EngineConfig> {
  const out: Partial<EngineConfig> = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of NUMERIC_KEYS) {
    const v = Number((input as any)[key]);
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = ENGINE_CONFIG_BOUNDS[key as keyof typeof ENGINE_CONFIG_BOUNDS];
    (out as any)[key] = Math.min(hi, Math.max(lo, v));
  }
  if ((input as any).routing_calendar !== undefined) {
    out.routing_calendar = clampRoutingCalendar((input as any).routing_calendar);
  }
  return out;
}

// PURE: effective config = env-aware defaults overlaid with the clamped stored doc.
export function effectiveEngineConfig(
  stored: any, env: Record<string, string | undefined> = process.env,
): EngineConfig {
  return { ...engineConfigDefaults(env), ...clampEngineConfig(stored) };
}

// PURE: merge a live edit into the stored overrides — clamped updates overlay
// the prior doc, reset keys drop back to the default (removed from the doc),
// and unknown/NaN keys never persist. This is the engine-tuning endpoint's
// write path; the solver re-clamps on read so nothing bad can stick either way.
export function mergeEngineConfigUpdate(
  prior: any, updates: any, resets: string[] = [],
): Partial<EngineConfig> {
  const base: any = { ...clampEngineConfig(prior) }; // includes routing_calendar when present
  for (const key of resets || []) delete base[String(key)];
  return { ...base, ...clampEngineConfig(updates) };
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
