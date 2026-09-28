// lib/uat-planning-mode.mts — UAT PLANNING MODE: EVERY DAY'S ORDERS SHOWN UNPLANNED, EVERY LOAD EMPTY.
//
// Chad, 2026-09-28: "i want you to make everything from today's deliveries back to unplanned so i
// can test of some of the planning changes we have made this making everything unplanned has
// nothing to do with production and should change nothing in productions database" — and minutes
// later, the shape: "maybe we have a planning mode in the uat where it makes the days orders all
// unplanned so you have a live version essentially of uat and then have a planning mode where
// everything on any given day is in unplanned."
//
// TWO MODES ON THE UAT SITE, ONE SWITCH:
//   LIVE      — UAT is production's board, copied in every 10 minutes (lib/uat-live-sync.mts).
//   PLANNING  — the same board, served as if nobody had planned anything yet: every order on any
//               day you open reads unplanned, and every load on that day's roster reads as an
//               empty truck with its driver still on it. Start from scratch, plan it, compare.
//
// WHY A VIEW, AND NOT A REWRITE OF THE STORED BOARD. Rewriting today's rows as unplanned was the
// first plan, and it fails on its own terms: production rescans its stops all day, the live sync
// copies every row production changed onto UAT within ten minutes, and the rewrite would quietly
// undo itself mid-test. Holding the day back from the sync would make it stop being production's.
// A VIEW needs neither: the stored rows stay exactly production's copy and the sync keeps running
// underneath, so switching back to Live is instant and current, and there is nothing to put back.
//
// WHAT IT CHANGES — only what these four planning surfaces SERVE, on the UAT site:
//   nuvizz-pull-today-stops   the board: the map, Build Panel step 1, the Routes rail, the grid
//   nuvizz-loads-roster       the day's loads: `trips` reads 0, so "Plan onto" offers every load as
//                             empty (the Build Panel counts a load's stops off the board rows,
//                             which read unplanned too)
//   routing-draft-core        the draft solver's unplanned pool
//   routing-cleanup-core      the end-of-night solver's pool and what the trucks already carry
//
// WHAT IT DOES NOT CHANGE: production (off a mirror every function here answers "off" without a
// read); any stored document; the order record (stop lookup, a driver's week, history — those are
// the record and keep saying what happened); the Claude shadow tab, which has its own "every stop"
// scope and whose isolation CI pins.
//
// THE SWITCH IS A DOCUMENT IN THE MIRROR'S OWN DATABASE (uat_mode/davis), set by
// uat-planning-mode.mts and shown on every UAT screen by the mode bar — so everyone on UAT sees
// the same mode and the bar says who set it and when. UAT_PLANNING_MODE=off removes the feature
// outright: every surface serves the stored board whatever the document says. Default on; only an
// off-word turns it off; malformed leaves it on (house shape).

import { isMirrorDeploy } from './mirror-guard.mts';
import { getDoc, readStops } from './firestore.mts';
import { isCancelledStop } from '../../../src/lib/stop-cancelled.js';

const OFF = /^(0|false|off|no)$/i;
export const PLANNING_MODE_COLLECTION = 'uat_mode';

export function planningModePath(tenant: string): string {
  return `${PLANNING_MODE_COLLECTION}/${String(tenant || '').trim().toLowerCase()}`;
}

/** PURE. Can this deploy have a planning mode at all? Only a mirror, and only unless switched off. */
export function planningModeAvailable(env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env)) return false;
  return !OFF.test(String(env.UAT_PLANNING_MODE ?? '').trim());
}

// ── THE VIEW ─────────────────────────────────────────────────────────────────────────────────
//
// Which fields make a row read PLANNED. Taken from the readers, not guessed: isPlannedStop
// (src/lib/routing-select.js) reads isUnplanned, isPlanned, routeName and loadNbr; the board's pin
// status (App.jsx classifyStopStatus) reads normalizedStatus first; the solvers read isUnplanned
// and isPlanned; the load grouping reads loadNbr / raw.load.loadId; nuvizzLoadNbr is the load
// NUMBER every routed row has carried since 2026-09-28. The rest are the plan's own detail
// (sequence, driver, planned ETA and legs) and the Save write-through stamps — a row that kept any
// of them would be an unplanned order still wearing a route.
export const PLAN_FIELDS = [
  'loadNbr', 'nuvizzLoadNbr', 'loadId', 'routeName', 'routeSeq', 'loadStopSeq',
  'driverName', 'driverId', 'driverUserName',
  'plannedEtaDTTM', 'plannedDistanceToNextStop', 'plannedDurationToNextStop',
  'board_write_at', 'board_write_planned',
] as const;

// What the delivery has already DONE today: an order out for delivery or delivered by noon would
// otherwise still paint green or blue, and "everything unplanned" means everything.
export const EXECUTION_FIELDS = ['arrivalDTTM', 'deliveredDTTM', 'executed'] as const;

/**
 * PURE. One board row as planning mode serves it: unplanned, off every load, nothing executed.
 *
 * NEVER invents a field. A plan field the row does not carry (the board's lean projection masks
 * many) stays absent; one it does carry reads null. Identity, address, freight, time windows,
 * restrictions and the order's own raw record all stay — the planner needs every one of them.
 *
 * A CANCELLED order is returned untouched: it is not freight, and the board drops it before this
 * ever runs (lib/stop-cancelled.js). The cancellation record inside raw is kept on every row,
 * because that is where the board looks for it.
 */
export function planningView(stop: any): any {
  if (!stop || typeof stop !== 'object') return stop;
  if (isCancelledStop(stop)) return stop;
  const out: any = { ...stop };
  for (const k of PLAN_FIELDS) if (k in out) out[k] = null;
  for (const k of EXECUTION_FIELDS) if (k in out) out[k] = null;
  if ('podDocs' in out) out.podDocs = [];
  out.isPlanned = false;
  out.isUnplanned = true;
  out.status = '10';                    // the scanner's unplanned code (lib/uat-seed.mts seedIndexRow)
  out.normalizedStatus = 'UNPLANNED';
  if (out.raw && typeof out.raw === 'object') {
    const raw: any = { ...out.raw };
    if ('load' in raw) raw.load = null;
    if (raw.stopExecutionInfo && typeof raw.stopExecutionInfo === 'object') {
      const cancellation = raw.stopExecutionInfo.cancellation;
      raw.stopExecutionInfo = cancellation !== undefined ? { cancellation } : {};
    }
    out.raw = raw;
  }
  out.planning_view = true;             // so a row can say which board it came from
  return out;
}

/** PURE. The day's loads as planning mode serves them: every load an empty truck, driver kept. */
export function planningRosterLoads(loads: any[]): any[] {
  return (Array.isArray(loads) ? loads : []).map((l) => (l && typeof l === 'object' ? { ...l, trips: 0 } : l));
}

/** PURE. A roster endpoint answer as planning mode serves it. Anything without a loads list
 *  (an error, the ?explain=1 diagnostic) is passed through untouched — the diagnostic reports
 *  what is STORED, which is what it is for. */
export function planningRosterBody(body: any): any {
  if (!body || body.ok !== true || !Array.isArray(body.loads)) return body;
  return { ...body, loads: planningRosterLoads(body.loads), planning_mode: true };
}

// ── READING THE SWITCH ───────────────────────────────────────────────────────────────────────

export interface PlanningModeState {
  on: boolean;
  available: boolean;
  set_at: string | null;
  set_by: string | null;
  error: string | null;
}

/**
 * Is planning mode on for this request? Off a mirror, or with UAT_PLANNING_MODE=off, the answer
 * is "off" WITHOUT a read — production never pays for this and never sees it. A read that fails
 * answers "off" with the error attached: the stored board is the real one, and the mode bar says
 * the switch could not be read rather than showing a mode nobody observed.
 */
export async function readPlanningMode(
  opts: { tenant?: string; env?: Record<string, any>; getDoc?: (path: string) => Promise<any> } = {},
): Promise<PlanningModeState> {
  const env = opts.env || process.env;
  if (!planningModeAvailable(env)) return { on: false, available: false, set_at: null, set_by: null, error: null };
  const read = opts.getDoc || getDoc;
  try {
    const doc = await read(planningModePath(opts.tenant || 'davis'));
    return {
      on: doc?.planning === true,
      available: true,
      set_at: doc?.set_at ?? null,
      set_by: doc?.set_by ?? null,
      error: null,
    };
  } catch (e: any) {
    return { on: false, available: true, set_at: null, set_by: null, error: String(e?.message || e).slice(0, 300) };
  }
}

/** The board for a day as a planning surface should see it: the stored rows, viewed through
 *  planning mode when it is on. The meta's planned/unplanned tallies follow the rows. */
export async function readStopsForPlanning(
  tenant: string, date: string, opts?: { mask?: string[] },
): Promise<{ meta: any; stops: any[]; planning: PlanningModeState }> {
  const [board, planning] = await Promise.all([readStops(tenant, date, opts), readPlanningMode({ tenant })]);
  if (!planning.on) return { meta: board.meta, stops: board.stops, planning };
  const stops = board.stops.map(planningView);
  const meta = board.meta ? { ...board.meta, plannedCount: 0, unplannedCount: stops.length } : board.meta;
  return { meta, stops, planning };
}
