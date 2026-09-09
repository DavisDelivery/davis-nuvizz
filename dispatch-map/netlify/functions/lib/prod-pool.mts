// lib/prod-pool.mts
//
// ── THE UAT BOARD'S DAILY POOL OF UNPLANNED ORDERS ───────────────────────────
//
// Chad, on the UAT site: "what i want to happen in UAT is it reads the firestore for
// unplanned orders however it doesnt plan them i want them daily left unplanned and
// isolated to this enviroment for testing."
//
// WHY THE UAT BOARD IS EMPTY WITHOUT THIS, and it is not a bug. isMirrorDeploy() keys on
// FIRESTORE_DATABASE, and scansEnabled() returns false for any mirror — the cutoff Chad
// asked for on 2026-09-03 ("I do not want uat running scans cut it off") after the mirror
// spent 109 NuVizz calls a day nobody had authorised. So nothing ever writes
// nuvizz_stop_index/{tenant}__{date} into the uat-mirror database, the board reads an
// empty index, and the map says "No stops match the current filters." The right fix is
// NOT to let UAT scan again — that reopens the bill — but to let it READ the day
// production has already paid for.
//
// ── WHAT THIS MODULE MAY DO, AND WHY IT CANNOT DO ANYTHING ELSE ──────────────
//
//  1. IT HAS NO WRITER. Not a disabled one, not a guarded one — there is no function in
//     this file that issues anything but a GET. A read-only reader that COULD be made to
//     write is one careless refactor away from the test board editing the live one, and
//     the whole point of the mirror is that production cannot be reached from here.
//  2. IT ONLY EVER ADDRESSES databases/(default). Deliberately hard-coded rather than
//     passed in: a parameter is a thing a future caller can get wrong, and the only
//     database this module has any business reading is production's.
//  3. IT REFUSES UNLESS isMirrorDeploy(). On production this would be a pointless
//     self-read, and a bug that made production take this path would be reading its own
//     data through a code path nobody tests. Refuse rather than no-op.
//  4. IT SERVES UNPLANNED ORDERS ONLY, and it STRIPS the plan fields off every row it
//     returns. Two different jobs: the filter decides WHICH orders reach the test board,
//     the strip guarantees that none of them arrives wearing a production route name, a
//     production driver or a production sequence. "Left unplanned" has to be true of the
//     row, not just of the query that found it.
//
// The pool refreshes itself: production scans all day, so tomorrow's UAT board is
// tomorrow's freight with no job to run and no NuVizz call to pay for.

import { getAccessToken, loadServiceAccount, assertSafePath, docToObject } from './firestore.mts';
import { isMirrorDeploy } from './mirror-guard.mts';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const PROD_DATABASE = '(default)';   // see (2) above — never a parameter
const COLLECTION = 'nuvizz_stop_index';

/** Which orders the test board is given. 'unplanned' (default) is Chad's ask read
 *  literally. 'all' exists because production plans its board through the morning: by
 *  mid-afternoon the unplanned pool can be empty, and an empty test board is not a test
 *  board. In BOTH modes every row is served unplanned — the mode only decides how many. */
export type PoolMode = 'unplanned' | 'all';
export function poolMode(env: Record<string, any> = process.env): PoolMode {
  return String(env.UAT_POOL_MODE || '').trim().toLowerCase() === 'all' ? 'all' : 'unplanned';
}

/** Is the UAT board allowed to source its day from production? Mirror-only, and switchable
 *  off (UAT_PROD_POOL=off) so a mirror can be put back to its own empty database. */
export function prodPoolEnabled(env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env)) return false;
  return !/^(0|false|off|no)$/i.test(String(env.UAT_PROD_POOL ?? '').trim());
}

// Tenant is case-normalized exactly as firestore.mts does it — the scanner writes lower,
// some callers pass upper, and a mismatched parent id reads as an empty day rather than
// an error, which is the most expensive way for this to be wrong.
function parentId(tenant: string, dateStr: string): string {
  return `${String(tenant || '').trim().toLowerCase()}__${dateStr}`;
}

/** PURE. Is this stored row unplanned in production? `isUnplanned` is the scanner's own
 *  field; `isPlanned === false` is the fallback for a row written before it existed. A row
 *  that says neither is NOT assumed unplanned — an unknown row reaching a test board as
 *  "free to route" is the wrong direction to guess in. */
export function isUnplannedRow(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  if (row.isUnplanned === true) return true;
  if (row.isPlanned === false && row.isUnplanned !== false) return true;
  return false;
}

// Everything that makes a row look ROUTED. Cleared on the way out so the test board can
// never show production's plan — not the load it is on, not the driver, not the sequence,
// not the planned ETA that was computed for a truck this board will never dispatch.
export const PLAN_FIELDS = [
  'loadNbr', 'loadId', 'routeName', 'routeSeq', 'loadStopSeq', 'driverName', 'driverId',
  'driverUserName', 'plannedEtaDTTM', 'plannedDistanceToNextStop', 'plannedDurationToNextStop',
  'board_write_at', 'board_write_planned', 'boardDate',
] as const;

/** PURE. One production row, presented as an unplanned order on the test board. */
export function asUnplannedRow(row: any): any {
  const out: any = { ...(row || {}) };
  for (const k of PLAN_FIELDS) out[k] = null;
  out.isPlanned = false;
  out.isUnplanned = true;
  // The status the board colours by. 10 is the scanner's unplanned code and what
  // normalizedStatus 'UNPLANNED' is derived from; keeping both consistent stops a row
  // rendering as SCHEDULED on a board that has just been told it is unplanned.
  out.normalizedStatus = 'UNPLANNED';
  out.status = '10';
  // Provenance, so nothing downstream (or on screen) has to guess where this came from.
  out.uatPoolSource = 'production';
  return out;
}

/** One paged, read-only GET of production's stops for a day. The ONLY request this file makes. */
async function listProdStops(tenant: string, dateStr: string, mask?: string[]): Promise<any[]> {
  const collectionPath = `${COLLECTION}/${parentId(tenant, dateStr)}/stops`;
  assertSafePath(collectionPath);
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const out: any[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${PROD_DATABASE}/documents/${collectionPath}`);
    url.searchParams.set('pageSize', '300');
    if (mask && mask.length) for (const f of mask) url.searchParams.append('mask.fieldPaths', f);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`prod-pool list failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const body: any = await resp.json();
    for (const d of body.documents || []) {
      const obj = docToObject(d);
      if (obj) out.push(obj);
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return out;
}

export interface ProdPoolRead {
  stops: any[];
  mode: PoolMode;
  /** Every row production had for the day, before the unplanned filter. */
  dayTotal: number;
  /** How many of those were unplanned in production. */
  unplannedTotal: number;
  /** Set when the board is empty and it is worth saying WHY on screen. */
  note: string | null;
}

/**
 * The UAT board's day. Refuses (rather than silently returning nothing) when called from
 * production or with the pool switched off — the caller decides what to do about it.
 */
export async function readProdUnplanned(tenant: string, dateStr: string, opts: { mask?: string[]; env?: Record<string, any> } = {}): Promise<ProdPoolRead> {
  const env = opts.env || process.env;
  if (!prodPoolEnabled(env)) throw new Error('prod-pool: refused — this is not a mirror deploy, or UAT_PROD_POOL is off');
  const rows = await listProdStops(tenant, dateStr, opts.mask);
  const unplanned = rows.filter(isUnplannedRow);
  const mode = poolMode(env);
  const chosen = mode === 'all' ? rows : unplanned;
  const stops = chosen.map(asUnplannedRow);
  let note: string | null = null;
  if (!rows.length) {
    note = `The UAT board reads production's board for ${dateStr}, and production has no stops on file for that date yet.`;
  } else if (!stops.length) {
    note = `Production has ${rows.length} stop(s) for ${dateStr} and none of them is unplanned — it has routed the whole day. `
      + 'Set UAT_POOL_MODE=all on this site to test against the full day instead (every row still arrives unplanned).';
  }
  return { stops, mode, dayTotal: rows.length, unplannedTotal: unplanned.length, note };
}
