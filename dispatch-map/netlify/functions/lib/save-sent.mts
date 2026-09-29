// lib/save-sent.mts
//
// ── WHICH STOPS EACH SAVE SENT, kept on its write-journal row ────────────────
//
// Chad, 2026-09-28, 8:39 PM, BRIAN refused: "load has a non-DO stop in a delivery slot that this
// card is not sequencing". The journal (nuvizz_write_ops) could say the 8:37 Save of BRIAN
// worked and the 8:38 and 8:39 Saves were refused — and could NOT say which stops any of the
// three carried, because a row kept each Save's RESULT and never its payload. So "the 8:37 card
// listed the LOCKHEED MARTIN pickup and the 8:38 card did not" had to be argued out of a board
// stamp instead of read. Chad: "maybe the journal should save this information."
//
// So every Save's row now carries `sent`: per load, the stop numbers in the order the card sent
// them and the ones it struck off, with the load it was aimed at. Read back by nuvizz-write-log
// (?stop= / ?load=) and by nuvizz-stop-explain, which now says of each Save of the stop's route
// whether it carried the stop, and where.
//
// PURE and BOUNDED. A ledger row that grows past Firestore's 1 MiB is dropped whole (see
// trimOpRecord), and losing the receipt to its own forensics is the failure that function exists
// to stop — so every list here is capped, and a cap SAYS it cut (orderedTotal / removedTotal /
// loadsTotal), because "sent 40" and "sent 40 of 300" are different facts. Nothing here reads or
// writes anything; nothing here costs a NuVizz call.

/** Per-load cap. The biggest real board is well under 100 stops a load. */
export const SENT_MAX_NBRS = 300;
/** Loads per Save. The Compare workbench holds at most 6 cards; a bulk manifest build is 1. */
export const SENT_MAX_LOADS = 12;
const ID_MAX = 64;

export interface SentLoad {
  /** The Compare card key the Save was built from (joins the result back to the card). */
  card: string | null;
  loadNbr: string | null;
  loadId: string | null;
  routeName: string | null;
  /** Stop numbers in the order sent — null when this Save sent NO order for the load (a
   *  driver- or dispatch-only Save), [] when it emptied the load. */
  ordered: string[] | null;
  orderedTotal?: number;
  /** Stop numbers struck off the load (removeStopNbrs). */
  removed: string[];
  removedTotal?: number;
  emptyLoad?: true;
  createNew?: true;
  newStops?: number;
  driver?: string;
  dispatch?: true;
}

export interface SaveSent {
  /** The board day the Save was made against (payload.date), or null when it sent none. */
  date: string | null;
  /** Which save path the client asked for. */
  engine: 'rwb' | 'import' | null;
  /** Which screen built it, as the client names itself: 'dispatcher' (the Compare Save),
   *  'dispatcher-bulk' (the manifest / bulk path). */
  source: string | null;
  loads: SentLoad[];
  loadsTotal?: number;
}

const str = (v: any, max = ID_MAX): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** A capped list of non-empty stop numbers, and the full count when the cap cut it. */
function nbrList(v: any): { list: string[]; total: number } {
  const all = (Array.isArray(v) ? v : []).map((x) => str(x)).filter((x): x is string => !!x);
  return { list: all.slice(0, SENT_MAX_NBRS), total: all.length };
}

/**
 * PURE: what a Save sent, in the shape the journal keeps. Null when the payload carries no
 * `loads` (a single-stop op names its stop in its own result already) — never a half-empty
 * record that reads like "this Save sent nothing".
 */
export function saveSent(payload: any, meta: { createdBy?: string | null } = {}): SaveSent | null {
  const loadsIn = Array.isArray(payload?.loads) ? payload.loads.filter((l: any) => l && typeof l === 'object') : [];
  if (!loadsIn.length) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date ?? '')) ? String(payload.date) : null;
  const engine = payload?.useRwb === true ? 'rwb' : payload?.useImport === true ? 'import' : null;
  const loads = loadsIn.slice(0, SENT_MAX_LOADS).map((L: any): SentLoad => {
    const out: SentLoad = {
      card: str(L.__key),
      loadNbr: str(L.loadNbr),
      loadId: str(L.loadId),
      routeName: str(L.routeName),
      ordered: null,
      removed: [],
    };
    if (Array.isArray(L.orderedStopNbrs)) {
      const o = nbrList(L.orderedStopNbrs);
      out.ordered = o.list;
      if (o.total > o.list.length) out.orderedTotal = o.total;
    }
    const r = nbrList(L.removeStopNbrs);
    out.removed = r.list;
    if (r.total > r.list.length) out.removedTotal = r.total;
    if (L.emptyLoad === true) out.emptyLoad = true;
    if (L.createNew === true) out.createNew = true;
    if (Array.isArray(L.newStops)) out.newStops = L.newStops.length;
    const driver = str(L.driverName) || str(L.driverId);
    if (driver) out.driver = driver;
    if (L.dispatch === true) out.dispatch = true;
    return out;
  });
  const sent: SaveSent = { date, engine, source: str(meta.createdBy, 40), loads };
  if (loadsIn.length > loads.length) sent.loadsTotal = loadsIn.length;
  return sent;
}

/** PURE: the stops a board write-through (nuvizz-board-sync) carried, capped the same way. */
export function boardSyncSent(ordered: any, unplanned: any): { ordered: string[]; unplanned: string[]; orderedTotal?: number; unplannedTotal?: number } {
  const o = nbrList(ordered);
  const u = nbrList(unplanned);
  return {
    ordered: o.list,
    unplanned: u.list,
    ...(o.total > o.list.length ? { orderedTotal: o.total } : {}),
    ...(u.total > u.list.length ? { unplannedTotal: u.total } : {}),
  };
}

const up = (v: any) => String(v ?? '').trim().toUpperCase();

/** Where a stop sits in one sent list: 'at' is 1-based, null when absent. */
export function sentPlace(sent: { ordered?: string[] | null; removed?: string[]; unplanned?: string[] } | null | undefined, stops: string[]):
  { at: number | null; of: number | null; removed: boolean } {
  const want = new Set((stops || []).map(up).filter(Boolean));
  const ordered = Array.isArray(sent?.ordered) ? sent!.ordered : null;
  const idx = ordered ? ordered.findIndex((n) => want.has(up(n))) : -1;
  const struck = [...(sent?.removed || []), ...(sent?.unplanned || [])].some((n) => want.has(up(n)));
  return { at: idx >= 0 ? idx + 1 : null, of: ordered ? ordered.length : null, removed: struck };
}

/** True when a journal row's `sent` names any of these stops (ordered, removed or un-planned). */
export function sentNamesStop(rec: any, stops: string[]): boolean {
  const s = rec?.sent;
  if (!s) return false;
  const lists = Array.isArray(s.loads) ? s.loads : [s];
  return lists.some((l: any) => { const p = sentPlace(l, stops); return p.at != null || p.removed; });
}

/** True when a journal row is a Save of this load — by route name, load number, load id or
 *  card key, case-insensitive — whether or not it carried any particular stop. Rows journaled
 *  before `sent` existed are still found by the load numbers their result names. */
export function rowIsForLoad(rec: any, key: string): boolean {
  const k = up(key);
  if (!k) return false;
  const ids = (l: any) => [l?.routeName, l?.loadNbr, l?.loadId, l?.card, l?.requestedLoadNbr, l?.requestedLoadId].map(up);
  if (Array.isArray(rec?.sent?.loads) && rec.sent.loads.some((l: any) => ids(l).includes(k))) return true;
  if (Array.isArray(rec?.result?.loads) && rec.result.loads.some((l: any) => ids(l).includes(k))) return true;
  return rec?.op === 'boardSync' && up(rec?.result?.routeName) === k;
}
