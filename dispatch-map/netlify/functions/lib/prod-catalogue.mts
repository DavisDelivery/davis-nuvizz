// lib/prod-catalogue.mts — WHAT CAME IN TODAY, READ FROM PRODUCTION'S FIRESTORE.
//
// Chad, 2026-09-10: "we need to use firestore to see what data/orders are put into system
// daily so we are not running scans."
//
// Production scans all day and every order it found is already in Firestore — address,
// geocoded pin, delivery window, freight, notes. That is the catalogue the UAT board picks
// its test orders from (lib/uat-seed.mts). Reading it costs ZERO NuVizz calls, and the UAT
// site never scans anything: a mirror deploy cannot (isMirrorDeploy, nuvizz-scan.mts), and
// that stays true.
//
// ── WHAT THIS MODULE MAY DO, AND WHY IT CANNOT DO ANYTHING ELSE ──────────────
//
// It reaches ACROSS a database boundary, from the uat-mirror deploy into production's data.
// That is the most dangerous shape in this repo, so the constraints are structural rather
// than careful:
//
//  1. IT HAS NO WRITER. Not a disabled one, not a guarded one — there is no function in this
//     file that issues anything but a GET. A read-only reader that COULD be made to write is
//     one careless refactor away from the test board editing the live one, and a test asserts
//     this against the source text.
//  2. IT ONLY EVER ADDRESSES databases/(default). Hard-coded, deliberately not a parameter:
//     a parameter is a thing a future caller can get wrong, and the only database this module
//     has any business reading is production's.
//  3. IT REFUSES UNLESS isMirrorDeploy(). On production this would be a pointless self-read
//     through a code path nobody exercises. Refuse loudly rather than no-op.
//
// (Descended from lib/prod-pool.mts on the unmerged #862 branch, which fed production's
// unplanned day straight onto the UAT board. This does less on purpose: it hands back a
// CATALOGUE to choose from, and nothing reaches the UAT tenant until somebody picks.)

import { getAccessToken, loadServiceAccount, assertSafePath, docToObject } from './firestore.mts';
import { isMirrorDeploy } from './mirror-guard.mts';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const PROD_DATABASE = '(default)';   // see (2) above — never a parameter
const COLLECTION = 'nuvizz_stop_index';

/** Switchable off so a mirror can be put back to reading only its own database. */
export function catalogueEnabled(env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env)) return false;
  return !/^(0|false|off|no)$/i.test(String(env.UAT_PROD_CATALOGUE ?? '').trim());
}

// Tenant is case-normalized exactly as firestore.mts does it — the scanner writes lower, some
// callers pass upper, and a mismatched parent id reads as an EMPTY DAY rather than an error,
// which is the most expensive way for this to be wrong.
function parentId(tenant: string, dateStr: string): string {
  return `${String(tenant || '').trim().toLowerCase()}__${dateStr}`;
}

/** The fields the pick list needs. A mask keeps the payload to what the screen shows —
 *  production days run to 800 rows, and `raw` alone is most of the bytes. */
export const CATALOGUE_MASK = [
  'stopNbr', 'businessName', 'addr1', 'addr2', 'city', 'state', 'zip', 'lat', 'lng',
  'scheduledFrom', 'scheduledTo', 'timeConstraint', 'cartons', 'pallets', 'volume', 'weight',
  'itemsSummary', 'custRef', 'poRef', 'contact', 'signalSources',
  'isPlanned', 'isUnplanned', 'routeName', 'loadNbr', 'driverName', 'normalizedStatus', 'status',
];

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
    if (!resp.ok) throw new Error(`prod-catalogue list failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const body: any = await resp.json();
    for (const d of body.documents || []) {
      const obj = docToObject(d);
      if (obj) out.push(obj);
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return out;
}

export interface CatalogueRead {
  rows: any[];
  dayTotal: number;
  unplannedTotal: number;
  note: string | null;
}

/**
 * Production's day, to choose test orders from. Refuses (rather than silently returning
 * nothing) when called from production or with the catalogue switched off — the caller
 * decides what to say about that.
 *
 * Rows arrive AS PRODUCTION HAS THEM, plan and all: the pick list shows "already on TRAILER
 * 6" because that is often exactly the order a scenario wants. Stripping the plan is the
 * SEEDER's job (uat-seed.seedIndexRow), done on the copy, at the point the copy is made.
 */
export async function readProdDay(tenant: string, dateStr: string, opts: { mask?: string[]; env?: Record<string, any> } = {}): Promise<CatalogueRead> {
  const env = opts.env || process.env;
  if (!catalogueEnabled(env)) throw new Error('prod-catalogue: refused — this is not a mirror deploy, or UAT_PROD_CATALOGUE is off');
  const rows = await listProdStops(tenant, dateStr, opts.mask === undefined ? CATALOGUE_MASK : opts.mask);
  const unplannedTotal = rows.filter((r) => r?.isUnplanned === true || (r?.isPlanned === false && r?.isUnplanned !== false)).length;
  const note = rows.length
    ? null
    : `Production has no stops on file for ${dateStr} yet — its scan writes the day as orders arrive, so an early-morning or future date can be legitimately empty.`;
  return { rows, dayTotal: rows.length, unplannedTotal, note };
}
