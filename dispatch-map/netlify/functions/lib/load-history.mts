// lib/load-history.mts — WHAT WE SENT TO NUVIZZ, WHAT CHANGED, AND WHETHER IT LANDED.
//
// Chad, 2026-09-16: "we have a new sent to nuvizz tab that records time we sent the loads to
// nuvizz can we design a history of those changes and what changed and everytime a load was
// updated so changes can be tracked and then we design a ui for it to interact with it."
//
// ── THE QUESTION THAT COULD NOT BE ANSWERED, READ OFF THE CODE ───────────────
//
// The card chip that recorded a send time (v1.33.0) was REVERTED the night before this was
// written (#946, v1.36.1) — `cardSendState`, `savedAtByKey` and `fmtClockMs` are gone from
// App.jsx. And even while it existed it recorded NOTHING DURABLE: savedAtByKey was React
// state, keyed by card, pruned the moment the card closed. Reload the page and the only
// evidence a load had ever been sent was gone.
//
// What DOES survive is the write ledger — nuvizz_write_ops, one row per Save (putOpRecord,
// nuvizz-write.mts) — and it has three gaps that make it unable to answer "what changed on
// ALPHA today":
//   1. it is keyed by clientOpId ALONE. nuvizz-write-log lists the whole collection and
//      filters in memory by op/status/since; there is no load index and no board day.
//   2. the per-load result carries no BEFORE list. The load's own stop list is read in
//      Phase 0 of every commit (`curNbrs`) and thrown away, so the diff was never derivable.
//   3. it has no UI at all — the only reader is curl.
//
// ── THE DIFF IS FREE, AND THAT IS THE WHOLE DESIGN ──────────────────────────
//
// Both sides of the comparison are ALREADY IN HAND inside the commit engines, paid for by
// calls the Save makes anyway:
//   before  the load's delivery order from the Phase-0 / PASS-A load read
//   after   on a confirmed RWB save, the post-save verify has just PROVED the load's
//           delivery order equals the requested order (rwbOrderMismatch returned null over a
//           fresh read) — so `after` is an observed fact, not the card's intention
// ZERO extra NuVizz calls. This module never calls anything; it is handed two lists.
//
// ── NEVER REPORT AN INTENT AS AN OUTCOME (CLAUDE.md) ────────────────────────
//
// `after` is nullable ON PURPOSE and `null` is NOT "unchanged". A save that failed before the
// verify read leaves us genuinely not knowing what the load holds, and a history that quietly
// printed the requested order there would be the v1.29.0 banner failure all over again: a
// screen telling a dispatcher the opposite of what the server observed. A row with no
// observed after says so in as many words and offers the load number to go look.
//
// A REFUSED SEND IS A ROW. "Nothing happened at 2:14" and "we tried at 2:14 and NuVizz
// refused it" are different facts, and the second is the one somebody has to act on.
//
// PURE. No Firestore, no network, no clock — callers pass `at`. Unit-tested directly by
// test/load-history.test.mjs.

/** What the send was trying to do — the write ops that change a LOAD, and only those. The
 *  single-stop ops (addStopNote / setStopDate / setStopContact / setStopAddress) change an
 *  ORDER and have their own logs; see LOAD_SEND_OPS in nuvizz-write.mts. */
export type LoadSendOp = 'commitBoard' | 'commitLoad' | 'commitImport' | 'newRoute';

/**
 * How the send ended, judged on what the SERVER observed and nothing else.
 *
 *   confirmed  the write returned ok — for an RWB save that means the post-save read-back
 *              proved membership AND sequence, which is the strongest claim this app makes.
 *   partial    the write reported a failure, but a read-back observed a load that no longer
 *              matches what it held before. Something landed. This is the state that used to
 *              be invisible (SCOTT/SHP29379: a false ✗ over freight that was physically on
 *              the route) and it is the most expensive one to mistake for either neighbour.
 *   refused    the write failed and nothing we read says the load moved.
 */
export type LoadSendVerdict = 'confirmed' | 'partial' | 'refused';

export interface LoadSendRow {
  /** ISO instant the send finished */
  at: string;
  /** the BOARD day the load belongs to — not the day the row was written. An 11pm save is
   *  building tomorrow's board, and filing it under today is how the roster bug of Sep 5
   *  hid a whole evening's work. */
  date: string;
  /** the load number NuVizz answered with (minted fresh every day's roster) */
  loadNbr: string | null;
  loadId: string | null;
  /** THE STABLE IDENTITY ACROSS DAYS. loadNbr/loadId are re-minted nightly, so a history
   *  keyed on either cannot answer "every time ALPHA changed this week". The route NAME is
   *  what a dispatcher calls the load and what survives. */
  routeName: string | null;
  op: LoadSendOp | string;
  verdict: LoadSendVerdict;
  /** who pressed Send: the signed-in username when there is one, else the client's
   *  `createdBy`, else null. Never invented. */
  by: string | null;
  clientOpId: string | null;
  /** the load's delivery order BEFORE the send (stop numbers, visit order). null = not read. */
  before: string[] | null;
  /** the delivery order OBSERVED after it. null = never read back — NOT "unchanged". */
  after: string[] | null;
  /** stop numbers this send put on the load / took off it */
  added: string[];
  removed: string[];
  /** the stops that stayed but moved position */
  resequenced: boolean;
  /** the driver this send ASSIGNED, when the assign step returned ok. There is no
   *  "driver before": load/info's normalized shape carries no driver field
   *  (nuvizz-write-ops.normalizeLoad), so claiming one would be inventing it. */
  driverSet: string | null;
  dispatched: boolean;
  /** this send CREATED the route in NuVizz (＋ New route's Save) */
  created: boolean;
  /** this send emptied the load, which cancels the route */
  cancelled: boolean;
  /** NuVizz's own complaint, verbatim-ish, on anything but a confirmed row */
  error: string | null;
}

const s = (v: any): string => (v == null ? '' : String(v).trim());
const nbrList = (v: any): string[] =>
  (Array.isArray(v) ? v : []).map((x) => s(x)).filter(Boolean);

/**
 * THE SWITCH THAT PUTS IT BACK (CLAUDE.md, *Ship it so it can be put back*). One env var
 * covers the WRITE, the READ and the ENDPOINT together, because a screen still asking for a
 * day nothing writes any more is a new bug wearing the old feature's name.
 *
 * House shape: default ON, an explicit off-word turns it off, and anything malformed leaves
 * it ON — a typo in an env var must never silently disable a record nobody is watching.
 */
export function loadHistoryEnabled(env: any = process.env): boolean {
  const v = String(env?.LOAD_HISTORY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * A load's DELIVERY order as stop numbers, in visit order.
 *
 * DO stops only, and sorted by stopSeq — the same projection the RWB verify uses to decide
 * whether a save's sequence landed (`rwbOrderMismatch`), so the history and the verdict can
 * never describe different orders. A pickup leg is not a delivery and never appears here.
 */
export function deliveryOrderOf(load: any): string[] {
  const stops = Array.isArray(load?.stops) ? load.stops : [];
  return stops
    .filter((st: any) => st?.stopNbr != null && String(st?.stopType ?? 'DO').toUpperCase() === 'DO')
    .slice()
    .sort((a: any, b: any) => Number(a?.stopSeq ?? Number.MAX_SAFE_INTEGER) - Number(b?.stopSeq ?? Number.MAX_SAFE_INTEGER))
    .map((st: any) => String(st.stopNbr));
}

export interface OrderDiff {
  added: string[];
  removed: string[];
  /** stops on both sides, in the AFTER order */
  kept: string[];
  /** a stop that stayed on the load changed its position relative to the others */
  resequenced: boolean;
  /** nothing at all moved: same members, same order */
  unchanged: boolean;
}

/**
 * WHAT THIS SEND DID TO THE LOAD.
 *
 * Resequencing is judged on the stops present BOTH SIDES, in their relative order — not on
 * the raw index. Drop stop #1 off a ten-stop load and every remaining stop's index shifts by
 * one; calling that "resequenced" would mark almost every removal as a reorder too, and a
 * history where nearly every row says the same thing says nothing.
 *
 * `before == null` (the load was never read) is NOT an empty load: it yields no adds, no
 * removals and unchanged:false, because we do not know. An absent read must never render as
 * "this send added all seventeen stops".
 */
export function diffStopOrder(before: string[] | null, after: string[] | null): OrderDiff {
  const none: OrderDiff = { added: [], removed: [], kept: [], resequenced: false, unchanged: false };
  if (!Array.isArray(before) || !Array.isArray(after)) return none;
  const b = nbrList(before);
  const a = nbrList(after);
  const bSet = new Set(b);
  const aSet = new Set(a);
  const added = a.filter((n) => !bSet.has(n));
  const removed = b.filter((n) => !aSet.has(n));
  const kept = a.filter((n) => bSet.has(n));
  const keptBefore = b.filter((n) => aSet.has(n));
  const resequenced = kept.length > 1 && kept.join('|') !== keptBefore.join('|');
  return { added, removed, kept, resequenced, unchanged: !added.length && !removed.length && !resequenced };
}

/** Did the send visibly move the load? Used to tell `partial` from `refused`. */
function movedAtAll(d: OrderDiff, driverSet: string | null, dispatched: boolean): boolean {
  return !!(d.added.length || d.removed.length || d.resequenced || driverSet || dispatched);
}

/** The steps a commit result carries, reduced to the two facts a history row needs. */
function stepOutcomes(steps: any): { driverStepOk: boolean; dispatchStepOk: boolean } {
  const list = Array.isArray(steps) ? steps : [];
  return {
    driverStepOk: list.some((st: any) => String(st?.op || '').includes('assignDriver') && st?.ok === true),
    dispatchStepOk: list.some((st: any) => String(st?.op || '').includes('dispatchLoad') && st?.ok === true),
  };
}

export interface BuildRowsInput {
  /** ISO instant the send finished */
  at: string;
  /** the board day the payload named, else the caller's ET day */
  date: string;
  op: LoadSendOp | string;
  by?: string | null;
  clientOpId?: string | null;
  /** payload.loads — what the card ASKED for (driver, dispatch, the card's own name) */
  payloadLoads?: any[];
  /** result.loads — what the server OBSERVED */
  resultLoads?: any[];
}

/**
 * ONE ROW PER LOAD IN THE SAVE — built from the result, joined back to the payload.
 *
 * The join is the same one the client uses and for the same reason (audit C8): a recurring
 * instance can be retargeted server-side, so the result's own loadNbr may be the twin's.
 * `requestedLoadNbr`/`requestedLoadId` echo what we SENT and always join. A result that
 * joins to nothing still produces a row — it is a change to a load either way, and dropping
 * it would make the history quietly incomplete, which is worse than a row with a thin name.
 */
export function buildLoadSendRows(input: BuildRowsInput): LoadSendRow[] {
  const at = s(input?.at) || new Date(0).toISOString();
  const date = s(input?.date);
  const op = s(input?.op);
  const by = s(input?.by) || null;
  const clientOpId = s(input?.clientOpId) || null;
  const payloadLoads = Array.isArray(input?.payloadLoads) ? input.payloadLoads : [];
  const resultLoads = Array.isArray(input?.resultLoads) ? input.resultLoads : [];

  const byNbr = new Map<string, any>();
  const byId = new Map<string, any>();
  for (const L of payloadLoads) {
    if (L?.loadNbr != null && s(L.loadNbr)) byNbr.set(s(L.loadNbr), L);
    if (L?.loadId != null && s(L.loadId)) byId.set(s(L.loadId), L);
  }
  const askOf = (r: any): any =>
    byNbr.get(s(r?.requestedLoadNbr)) ?? byId.get(s(r?.requestedLoadId))
    ?? byNbr.get(s(r?.loadNbr)) ?? byId.get(s(r?.loadId)) ?? {};

  const rows: LoadSendRow[] = [];
  for (const r of resultLoads) {
    if (!r || typeof r !== 'object') continue;
    const ask = askOf(r);
    const before = Array.isArray(r.before) ? nbrList(r.before) : null;
    const after = Array.isArray(r.after) ? nbrList(r.after)
      : Array.isArray(r.observedOrder) ? nbrList(r.observedOrder)
        : null;
    const d = diffStopOrder(before, after);
    const { driverStepOk, dispatchStepOk } = stepOutcomes(r.steps);
    // The driver is reported only when the assign STEP came back ok — the name is the card's,
    // the fact that it landed is the server's.
    const driverSet = driverStepOk ? (s(ask?.driverName) || s(ask?.driverId) || 'driver assigned') : null;
    const ok = r.ok === true;
    const verdict: LoadSendVerdict = ok ? 'confirmed'
      : (after !== null && movedAtAll(d, driverSet, dispatchStepOk)) ? 'partial'
        : 'refused';
    rows.push({
      at,
      date,
      loadNbr: s(r.loadNbr) || s(ask?.loadNbr) || null,
      loadId: s(r.loadId) || s(ask?.loadId) || null,
      routeName: s(ask?.routeName) || s(r.routeName) || null,
      op,
      verdict,
      by,
      clientOpId,
      before,
      after,
      added: d.added,
      removed: d.removed,
      resequenced: d.resequenced,
      driverSet,
      dispatched: dispatchStepOk,
      created: op === 'newRoute' || r.created === true,
      // An emptied load is a CANCELLED route — the card the dispatcher struck every order off.
      cancelled: ask?.emptyLoad === true
        || (Array.isArray(ask?.orderedStopNbrs) && ask.orderedStopNbrs.length === 0 && (before?.length ?? 0) > 0),
      error: ok ? null : (s(r.error) || 'the write failed and gave no reason'),
    });
  }
  return rows;
}

/**
 * ONE HUMAN LINE FOR THE ROW — what a dispatcher reads before deciding to open it.
 *
 * Ordered by what it costs to be wrong about: freight that moved first, then the truck, then
 * the paperwork. An un-read after-state says so rather than printing a reassuring nothing.
 */
export function changeLabel(row: LoadSendRow | null | undefined): string {
  if (!row) return '';
  const parts: string[] = [];
  if (row.cancelled) parts.push('route cancelled');
  else if (row.created) parts.push('route created');
  if (row.added.length) parts.push(`+${row.added.length} stop${row.added.length === 1 ? '' : 's'}`);
  if (row.removed.length) parts.push(`−${row.removed.length} stop${row.removed.length === 1 ? '' : 's'}`);
  if (row.resequenced) parts.push('resequenced');
  if (row.driverSet) parts.push(`driver → ${row.driverSet}`);
  if (row.dispatched) parts.push('dispatched');
  if (!parts.length) {
    if (row.after === null) return 'sent — the load was not read back, so what it holds now is unknown';
    if (row.before === null) return 'sent — what the load held before was not captured';
    return 'no change to the load';
  }
  return parts.join(' · ');
}

export interface LoadHistoryQuery {
  /** route name or load number, case-insensitive substring. Omit for every load. */
  load?: string | null;
  /** a stop number that must appear on either side of the row */
  stop?: string | null;
  /** exact verdict */
  verdict?: string | null;
  /** rows to return after filtering */
  limit?: number;
}

const eqi = (a: any, b: any) => s(a).toLowerCase() === s(b).toLowerCase();
const hasi = (hay: any, needle: any) => s(hay).toLowerCase().includes(s(needle).toLowerCase());

/**
 * Newest first, FILTERED BEFORE THE CUT.
 *
 * The cut-before-filter version of this is what made nuvizz-write-log unable to size the
 * 2026-08-17 address-corruption incident: it returned the last 25 rows of everything and 23
 * of them were an unrelated bulk push from the same afternoon. A history that routine
 * traffic can crowd out is not a history.
 *
 * A stop search matches BOTH SIDES — a stop that was REMOVED is exactly the one somebody is
 * hunting for when they ask "what happened to 007175992", and matching only the after-list
 * would answer that question with silence.
 */
export function selectLoadSends(all: any[], q: LoadHistoryQuery = {}): LoadSendRow[] {
  const rows = (Array.isArray(all) ? all : []).filter((r) => r && r.at);
  const filtered = rows.filter((r) => {
    if (q.load && !(hasi(r.routeName, q.load) || hasi(r.loadNbr, q.load))) return false;
    if (q.verdict && !eqi(r.verdict, q.verdict)) return false;
    if (q.stop) {
      const needle = s(q.stop);
      const onRow = [...nbrList(r.before), ...nbrList(r.after), ...nbrList(r.added), ...nbrList(r.removed)];
      // Zero-padding: the board and the portal disagree about leading zeros on the same
      // order, so 7175992 must find 007175992 (the stop-history lesson, v1.31.2).
      const bare = needle.replace(/^0+/, '');
      if (!onRow.some((n) => n === needle || n.replace(/^0+/, '') === bare)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => s(b.at).localeCompare(s(a.at)));
  const limit = Number(q.limit);
  return Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;
}

export interface LoadHistorySummary {
  rows: number;
  confirmed: number;
  partial: number;
  refused: number;
  loads: number;
  stopsAdded: number;
  stopsRemoved: number;
  /** rows whose after-state was never read back — the honesty counter */
  unobserved: number;
}

/** The header line over the list. Counts what is THERE, never what it assumes. */
export function summarizeLoadSends(rows: any[]): LoadHistorySummary {
  const list = Array.isArray(rows) ? rows : [];
  const loads = new Set<string>();
  let confirmed = 0, partial = 0, refused = 0, stopsAdded = 0, stopsRemoved = 0, unobserved = 0;
  for (const r of list) {
    const key = s(r?.routeName) || s(r?.loadNbr);
    if (key) loads.add(key.toLowerCase());
    if (r?.verdict === 'confirmed') confirmed++;
    else if (r?.verdict === 'partial') partial++;
    else refused++;
    stopsAdded += nbrList(r?.added).length;
    stopsRemoved += nbrList(r?.removed).length;
    if (r?.after == null) unobserved++;
  }
  return { rows: list.length, confirmed, partial, refused, loads: loads.size, stopsAdded, stopsRemoved, unobserved };
}
