// lib/load-types.mts — THE LOAD'S OWN EQUIPMENT, FETCHED ONCE AND KEPT.
//
// Chad, 2026-09-02: "Loads should not be classed as tractor trailer or box truck only by the
// driver who ends up assigned to them." Agreed, and route-classes.mts now enforces it — but a
// rule that only accepts what the LOAD says is silent unless something actually asks the load.
// Measured that day: 56 of 61 routes were classed from the driver roster and ZERO from a load,
// so the no-trailer text would have gone completely quiet. This module is what closes that.
//
// WHERE THE TYPE LIVES. nuVizz documents it on GET /load/info/{loadNbr}/{companyCode} as
// `Load.loadHeader.vehicleType`, and this tenant has been observed returning real values there
// — the fleet index captured TRACTOR TRAILER / TRAILER / STRAIGHT TRUCK on 100 of 100 loads the
// last time it was written (2026-04-29). It stopped only because the list-discovery schedule
// never runs the number-probe path that filled it. The hourly Loads grid gives us every load's
// NUMBER (rteNbr) at no extra cost, which is exactly the key /load/info wants.
//
// ── WHAT IT COSTS, STATED PLAINLY ────────────────────────────────────────────
// One call per load, ONCE. A load's equipment is set when the load is created and does not
// change through the day, so a type is cached under its load NUMBER and never re-fetched:
// later sweeps on the same board pay nothing. A normal board is ~63 loads carrying stops, so
// the steady-state cost is ~63 calls a day against a 12,000 ceiling (2026-09-02 used 409).
//
// OFF BY DEFAULT. NUVIZZ_LOAD_TYPE_FETCH=on is the whole switch. Until it is flipped this
// module fetches nothing, returns whatever is already cached, and reports `enabled: false` so
// a quiet no-trailer rule is legible as a switch position rather than a bug.
import { getDoc, setDoc } from './firestore.mts';
import { getNuvizzRequester } from './nuvizz-request.mts';
import { getCreds, basicAuthHeader, scansEnabled } from './nuvizz-scan.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
/** Never more than this many /load/info calls in one pass, however many loads are unknown.
 *  A board is ~63 loads; the cap is the backstop against a feed that starts inventing them. */
export const MAX_LOAD_TYPE_FETCH = 120;

export const loadTypesPath = (tenant: string, date: string) => `nuvizz_load_types/${tenant}__${date}`;

export function loadTypeFetchEnabled(env: any = process.env): boolean {
  return ['on', '1', 'true', 'yes'].includes(String(env?.NUVIZZ_LOAD_TYPE_FETCH ?? '').trim().toLowerCase());
}

export interface LoadTypeResult {
  types: Record<string, string>;      // loadNbr -> vehicleType, as NuVizz states it
  enabled: boolean;
  cached: number;                     // types already on file before this pass
  fetched: number;                    // /load/info calls actually made
  failed: number;
  wanted: number;                     // loads with stops whose type we did not know
  capped: boolean;
}

/**
 * PURE. Which load NUMBERS this board needs a type for — the loads that actually carry stops,
 * minus the ones already cached.
 *
 * Route keys are matched to load numbers through the roster's own name/number pairing, because
 * a board stop carries the route NAME ("BRENT") and /load/info wants the NUMBER
 * ("DAVIS000203100"). A load with no stops on this board is never fetched: nothing is routed to
 * it, so nothing about it can be flagged, and paying for it would be paying for silence.
 */
export function loadNbrsNeeded(rosterLoads: any[], stops: any[], known: Record<string, string> = {}): string[] {
  const onBoard = new Set<string>();
  for (const s of stops || []) {
    const k = String(s?.loadNbr || s?.routeName || '').trim();
    if (k) onBoard.add(k.toUpperCase());
  }
  const out: string[] = [];
  for (const l of rosterLoads || []) {
    const nbr = String(l?.loadNbr || '').trim();
    if (!nbr || known[nbr]) continue;
    // The roster row's own name is how a board route is recognised; the number is what we fetch.
    const name = String(l?.name || l?.routeName || '').trim().toUpperCase();
    if (!(onBoard.has(name) || onBoard.has(nbr.toUpperCase()))) continue;
    if (!out.includes(nbr)) out.push(nbr);
  }
  return out;
}

/** PURE. loadNbr -> routeName pairs from the roster, so a fetched type can be filed against the
 *  key the board actually uses. Both spellings are emitted; the class builder reads either. */
export function loadRowsFromTypes(rosterLoads: any[], types: Record<string, string>): any[] {
  const out: any[] = [];
  for (const l of rosterLoads || []) {
    const nbr = String(l?.loadNbr || '').trim();
    const vt = nbr ? types[nbr] : null;
    if (!vt) continue;
    out.push({ loadNbr: nbr, routeName: String(l?.name || l?.routeName || '').trim() || null, vehicleType: vt });
  }
  return out;
}

/** One /load/info read → the load's stated vehicle type, or null. Never throws. */
async function fetchOne(loadNbr: string): Promise<string | null> {
  try {
    const { companyCode } = getCreds();
    const url = `${NUVIZZ_BASE}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`;
    const resp = await getNuvizzRequester().request(
      url,
      { headers: { Authorization: basicAuthHeader(), Accept: 'application/json' }, maxRetries: 1 },
      { route: '/load/info(type)', tenant: companyCode, source: 'load-types' },
    );
    if (!resp.ok) return null;
    const d: any = await resp.json();
    const vt = d?.Load?.loadHeader?.vehicleType;
    return vt == null || String(vt).trim() === '' ? null : String(vt).trim();
  } catch {
    return null;
  }
}

/**
 * The cached load→type map for a board, topped up with at most MAX_LOAD_TYPE_FETCH new reads.
 *
 * NEVER THROWS and never blocks a sweep: a failed read leaves that load unclassed, which the
 * no-trailer rule already reports by name. The cache is written even on a partial pass, so the
 * next sweep starts from what this one learned rather than paying again.
 */
export async function ensureLoadTypes(
  tenant: string, date: string, rosterLoads: any[], stops: any[],
): Promise<LoadTypeResult> {
  let types: Record<string, string> = {};
  try {
    const doc = await getDoc(loadTypesPath(tenant, date));
    if (doc?.types && typeof doc.types === 'object') types = { ...doc.types };
  } catch { /* a missing cache is the ordinary first pass */ }
  const cached = Object.keys(types).length;
  const wantedAll = loadNbrsNeeded(rosterLoads, stops, types);
  const enabled = loadTypeFetchEnabled() && scansEnabled();
  if (!enabled || !wantedAll.length) {
    return { types, enabled, cached, fetched: 0, failed: 0, wanted: wantedAll.length, capped: false };
  }
  const want = wantedAll.slice(0, MAX_LOAD_TYPE_FETCH);
  let fetched = 0; let failed = 0;
  // Serial on purpose: this is a background sweep with no deadline, and a burst of parallel
  // reads against a vendor that rate-limits buys nothing but a 429.
  for (const nbr of want) {
    const vt = await fetchOne(nbr);
    if (vt) { types[nbr] = vt; fetched++; } else { failed++; }
  }
  if (fetched) {
    try {
      await setDoc(loadTypesPath(tenant, date), { tenant, date, types, at: new Date().toISOString() });
    } catch (e: any) {
      console.error('load-type cache write failed (this pass will be re-paid next sweep):', e?.message);
    }
  }
  return { types, enabled, cached, fetched, failed, wanted: wantedAll.length, capped: wantedAll.length > want.length };
}
