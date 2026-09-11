// lib/uat-seed.mts — WRITE JUST THE ORDERS A TEST NEEDS INTO THE UAT TENANT (PURE core).
//
// Chad, 2026-09-10: "we need to use firestore to see what data/orders are put into system
// daily so we are not running scans. Then we can design a way to test using that information
// so we need to test something we will write just the orders we need to test whatever
// scenario we are testing into the uat."
//
// THE MODEL, and it is the opposite of discovery. Production already pays for the day: every
// order it scanned is sitting in nuvizz_stop_index in the (default) Firestore database, with
// its address, its coordinates, its window and its freight. That is the CATALOGUE. UAT is a
// STAGE: for a given scenario we pick the handful of orders it needs, write ONLY those into
// the DAVISV5 tenant, run the scenario, and strike the set. Nothing is discovered, nothing is
// scanned, and nothing is in UAT that somebody did not deliberately put there.
//
// WHAT IT COSTS. Reading the catalogue is a Firestore read — ZERO NuVizz calls. Seeding N
// orders is N creates against the UAT tenant and nothing at all against production. A 14-stop
// route test is ~14 calls on a tenant nobody ships from; the same test against production
// would be unthinkable.
//
// ── WHY THIS FILE IS PURE, AND WHAT THE ENDPOINT KEEPS ───────────────────────
//
// Every decision that can be got wrong is a function here with a test: what the UAT order
// number is, which production fields carry over, which are deliberately dropped, and which
// rows may be cancelled on a clear. The endpoint (netlify/functions/uat-seed.mts) does the
// I/O and the gating; it decides nothing.
//
// THE FOUR RULES THIS FILE EXISTS TO HOLD:
//
//  1. A SEEDED ORDER IS ALWAYS IDENTIFIABLE AS ONE. Its number carries the UT- prefix, its
//     record carries the production number it was copied from, and the seed ledger records
//     it. A clear requires the prefix AND the ledger — two independent checks, because
//     cancelling is destructive and "cancel everything that looks like a test" is exactly
//     the phrasing you cannot undo.
//  2. THE NUMBER IS DERIVED, NEVER MINTED. UT- plus the production number means re-seeding
//     the same order lands on the same UAT number, and stop/sync/update is an UPSERT — so a
//     second seed updates rather than duplicating. Idempotence for free, and traceability:
//     any order on the UAT board can be read straight back to the production order it stands
//     for.
//  3. THE SCENARIO IS THE WINDOW. A test for "a stop that closes at 2pm" is worthless if the
//     copy arrives with the builder's default 12–5. The production row's own delivery window
//     rides across, and when it has none we say so rather than inventing one.
//  4. NOTHING ABOUT PRODUCTION'S PLAN COMES WITH IT. Not the load, not the driver, not the
//     sequence, not the planned ETA. The point of the stage is that it starts empty.

import type { StopRow } from './nuvizz-write-ops.mts';

/** NuVizz caps stopNbr at 20 characters (v7 Stop schema). */
export const UAT_STOP_NBR_MAX = 20;
/** Every seeded order carries this. It is half of what makes a clear safe. */
export const UAT_PREFIX = 'UT-';

/**
 * PURE. The UAT order number for a production order number.
 *
 * Derived, never minted (rule 2). When the combined length would exceed NuVizz's cap the
 * TAIL is kept, not the head: production numbers are prefix-heavy ("ESTES-0538243875",
 * "AVRT-0060189919") and the digits at the end are what tells two of them apart. Cutting the
 * front would collapse distinct orders onto one number, which on an UPSERT endpoint means
 * silently overwriting the previous test's order.
 */
export function uatStopNbr(prodStopNbr: any): string {
  const src = String(prodStopNbr ?? '').trim();
  if (!src) return '';
  const room = UAT_STOP_NBR_MAX - UAT_PREFIX.length;
  return UAT_PREFIX + (src.length <= room ? src : src.slice(src.length - room));
}

/** PURE. Was this order put here by the seeder? The NUMBER half of the clear check. */
export function isUatSeededNbr(stopNbr: any): boolean {
  return String(stopNbr ?? '').trim().toUpperCase().startsWith(UAT_PREFIX);
}

/** The production stop-index fields a seeded copy carries. Anything not named here does not
 *  cross: production's plan (rule 4) and every scan-keeping field (stamps, enrichment flags,
 *  freshness) belong to the board that produced them. */
export const CARRIED_FIELDS = [
  'businessName', 'addr1', 'addr2', 'city', 'state', 'zip', 'lat', 'lng',
  'scheduledFrom', 'scheduledTo', 'timeConstraint',
  'cartons', 'pallets', 'volume', 'weight',
  'contact', 'signalSources', 'itemsSummary', 'custRef', 'poRef',
] as const;

/** Everything that would make a copy look ROUTED, or look like production's own row. Listed
 *  explicitly (rather than implied by CARRIED_FIELDS) so the intent is readable and testable:
 *  these are DROPPED on purpose, and a reviewer can see which. */
export const DROPPED_FIELDS = [
  'loadNbr', 'loadId', 'routeName', 'routeSeq', 'loadStopSeq',
  'driverName', 'driverId', 'driverUserName', 'plannedEtaDTTM',
  'plannedDistanceToNextStop', 'plannedDurationToNextStop',
  'board_write_at', 'board_write_planned', 'boardDate', 'last_scanned_at',
  'enriched', 'stopId', 'raw',
] as const;

export interface SeedPlanRow {
  /** The production order this copy stands for. */
  prodStopNbr: string;
  /** The number it will carry in UAT. */
  uatStopNbr: string;
  /** The payload row for buildStopPayload. */
  row: StopRow;
  /** The delivery window carried across, or null when the production row had none. */
  window: { from: string | null; to: string | null };
  /** Anything the caller should be told before spending a call on this one. */
  warnings: string[];
}

const str = (v: any): string => (v == null ? '' : String(v).trim());
const num = (v: any): number | null => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * PURE. One production board row → the order to create in UAT.
 *
 * Returns null when the row cannot make a valid order (rule: never send NuVizz a half
 * address — it accepts one and geocodes it to somewhere nobody chose). The caller surfaces
 * the skip; this never silently drops a row the user ticked.
 */
export function buildSeedRow(prodRow: any, opts: { label?: string | null } = {}): SeedPlanRow | null {
  const prodStopNbr = str(prodRow?.stopNbr);
  if (!prodStopNbr) return null;
  const name = str(prodRow?.businessName);
  const addr1 = str(prodRow?.addr1);
  const city = str(prodRow?.city);
  const state = str(prodRow?.state);
  const zip = str(prodRow?.zip);
  if (!name || !addr1 || !city || !zip) return null;

  const warnings: string[] = [];
  const nbr = uatStopNbr(prodStopNbr);
  if (nbr.length < UAT_PREFIX.length + prodStopNbr.length) {
    warnings.push(`${prodStopNbr} is longer than NuVizz allows with the UT- prefix — the copy is numbered ${nbr} (tail kept).`);
  }

  // Rule 3: the scenario IS the window. Carried verbatim when the production row has one;
  // NEVER synthesized when it does not — a fabricated 12–5 would quietly turn a test for a
  // 2pm close into a test for nothing, and the point of the copy is the scenario.
  const from = str(prodRow?.scheduledFrom) || null;
  const to = str(prodRow?.scheduledTo) || null;
  if (!from && !to) warnings.push(`${prodStopNbr} has no delivery window on the board — the copy gets the builder's default, so it cannot test a deadline.`);

  // Freight, in the same Davis terms the New Order form uses (buildStopPayload maps them onto
  // NuVizz's mislabeled fields — pallets→totalCartons, loose→volume). `cartons` on a board row
  // IS pallets and `volume` IS loose: the normalizer already relabelled them (nuvizz-scan.mts),
  // so reading them back under the Davis names here keeps one meaning end to end.
  const row: StopRow = {
    stopNbr: nbr,
    name, addr1, city, state, zip,
    addr2: str(prodRow?.addr2) || null,
    pallets: num(prodRow?.cartons),
    loose: num(prodRow?.volume),
    weight: num(prodRow?.weight),
    itemDesc: str(prodRow?.itemsSummary) && prodRow.itemsSummary !== '—' ? str(prodRow.itemsSummary) : null,
    phone: str(prodRow?.contact?.phone) || null,
    email: str(prodRow?.contact?.email) || null,
    // The dispatch note is where a scenario's real-world condition usually lives ("closes
    // 2pm", "call before delivery"), so it crosses — with a line saying what this copy is, so
    // nobody reading it in the UAT portal mistakes it for freight anybody is shipping.
    dispatchNotes: [
      `TEST COPY of production order ${prodStopNbr}${opts.label ? ` · ${opts.label}` : ''}`,
      str(prodRow?.signalSources?.orderInstructions) || null,
    ].filter(Boolean).join(' — ') || null,
  };
  return { prodStopNbr, uatStopNbr: nbr, row, window: { from, to }, warnings };
}

/**
 * PURE. The board-index row for a seeded order, once NuVizz has confirmed the create.
 *
 * This is the step that makes the UAT board usable WITHOUT a scan: the seeder already knows
 * what it created, so it writes the row itself. Production's geometry (the geocoded pin, the
 * address, the freight) carries over — it is the same physical delivery — while the identity
 * becomes the UAT order's and every plan field is cleared.
 *
 * `created` is the confirmed result: the UAT stopId NuVizz minted and the number it answered
 * with. Without a stopId this returns null rather than writing a row for an order we cannot
 * prove exists — a board row for a phantom order is the one thing worse than an empty board.
 */
export function seedIndexRow(prodRow: any, plan: SeedPlanRow, created: { stopId?: any; stopNbr?: any }): any | null {
  const stopId = str(created?.stopId);
  if (!stopId) return null;
  const nbr = str(created?.stopNbr) || plan.uatStopNbr;
  const out: any = {};
  for (const k of CARRIED_FIELDS) if (prodRow?.[k] !== undefined) out[k] = prodRow[k];
  for (const k of DROPPED_FIELDS) delete out[k];

  out.stopNbr = nbr;
  out.stopId = stopId;
  out.pro = nbr;
  out.pros = [nbr];
  out.primaryPro = nbr;
  out.proCount = 1;
  out.stopType = 'DO';
  // Unplanned, and consistent about it: `status` 10 is the scanner's unplanned code and
  // normalizedStatus is what the board colours by. A row that says one and not the other
  // renders as SCHEDULED on a board that was just told it is unplanned.
  out.status = '10';
  out.normalizedStatus = 'UNPLANNED';
  out.isPlanned = false;
  out.isUnplanned = true;
  out.loadNbr = null;
  out.routeName = null;
  out.driverName = null;
  out.driverUserName = null;
  // Provenance — the LEDGER half of the clear check, on the row itself, so a board row can
  // answer "where did you come from" without a second lookup.
  out.uatSeed = { prodStopNbr: plan.prodStopNbr, at: null, label: null };
  return out;
}

/**
 * PURE. May this board row be cancelled by a clear?
 *
 * BOTH halves must hold: the number carries the UT- prefix AND the row is in the seed ledger.
 * Either alone is a way to destroy something nobody meant to destroy — a hand-made UT- order
 * somebody typed in the portal, or a ledger that has drifted. Destructive paths get two keys.
 */
export function clearableRow(row: any, ledgerNbrs: Set<string> | ReadonlySet<string>): boolean {
  const nbr = str(row?.stopNbr);
  if (!nbr || !isUatSeededNbr(nbr)) return false;
  return ledgerNbrs.has(nbr);
}

/** PURE. The whole plan for a seed request, with everything the caller must be told BEFORE a
 *  call is spent: what will be created, what cannot be, and what is odd about what will. */
export function planSeed(prodRows: any[], stopNbrs: string[], opts: { label?: string | null } = {}): {
  plan: SeedPlanRow[]; skipped: Array<{ stopNbr: string; why: string }>; warnings: string[];
} {
  const byNbr = new Map<string, any>();
  for (const r of Array.isArray(prodRows) ? prodRows : []) {
    const k = str(r?.stopNbr);
    if (k && !byNbr.has(k)) byNbr.set(k, r);
  }
  const plan: SeedPlanRow[] = [];
  const skipped: Array<{ stopNbr: string; why: string }> = [];
  const warnings: string[] = [];
  const seenUat = new Set<string>();
  for (const raw of Array.isArray(stopNbrs) ? stopNbrs : []) {
    const nbr = str(raw);
    if (!nbr) continue;
    const prod = byNbr.get(nbr);
    if (!prod) { skipped.push({ stopNbr: nbr, why: 'not on the production board for that day' }); continue; }
    const p = buildSeedRow(prod, opts);
    if (!p) { skipped.push({ stopNbr: nbr, why: 'no usable delivery address on the production row (name, street, city and zip are all required)' }); continue; }
    // Two production numbers whose tails collide would land on ONE UAT number and the second
    // create would UPSERT over the first — a silently smaller test than the one asked for.
    if (seenUat.has(p.uatStopNbr)) { skipped.push({ stopNbr: nbr, why: `its UAT number ${p.uatStopNbr} collides with another order in this batch` }); continue; }
    seenUat.add(p.uatStopNbr);
    plan.push(p);
    warnings.push(...p.warnings);
  }
  return { plan, skipped, warnings };
}
