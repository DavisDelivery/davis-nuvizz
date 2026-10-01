// lib/att-holder.mts — WHO HAD THE ORDER WHEN IT FAILED (v1.99.0). PURE: no Firestore, no NuVizz.
//
// Chad, 2026-09-30: "Why are we freezing the snapshot at 8:30 when we have Firestore data all day
// long of scans that are being ran constantly?"
//
// THE GAP. The evening attempts scan names a driver by joining each ATT stop to the 8:30 freeze
// (att_plan), and the freeze keeps a stop ONLY if it had a driver at that moment:
// `s.isPlanned && (s.driverUserName || s.driverName)` in capturePlanSnapshot (attempts-core.mts).
// A route built overnight and dispatched to its driver after 8:30 has no driver at 8:30, so every
// stop on it is missing from the freeze, and every failure on it is written with no driver.
// Measured on 2026-09-25, order 007182021: planned onto CHRIS HEAD at 1:29 AM, dispatched to Chris
// Head at 12:43 PM, unplanned at 5:58 PM (its NuVizz activity timeline) — and written to that
// evening's attempts list with no driver, as were six more that day. A stop put on a route after
// 8:30 is missed the same way.
//
// WHY THE LIVE INDEX CANNOT ANSWER IT AT 8 PM. Every scan re-writes the stop's row, so by evening a
// failed stop reads unplanned (no driver) or already re-planned onto the NEXT driver. Checked against
// the attempts the 8:30 freeze DID attribute (09/09 → 09/29): where the order was redelivered on a
// later day, the driver the day's index finally held was the attempting driver 7 times in 36.
//
// THE RULE. Every */15 list scan already holds every stop on today's board. This keeps, per board
// day, the driver each stop was on the LAST time a scan saw it routed with a driver and NOT yet
// carrying the ATT marker — and freezes that record the first time a scan sees the marker. So:
//   • a route dispatched at 12:43 PM is recorded at the 12:45 scan;
//   • a stop moved between drivers before it failed keeps the LAST one, who had it at the door;
//   • once the marker lands, a same-day re-plan onto another driver cannot overwrite the answer;
//   • a stop first seen already ATT-marked (a "-N" copy, or an earlier day's failure on today's
//     board) gets NO record — whoever it is on by then is redelivering it, not who attempted it.
//
// USED ONLY WHERE THE 8:30 FREEZE HAS NO DRIVER. Every attempt the freeze attributes today keeps
// exactly that attribution; this fills the gaps. NUVIZZ_ATT_HOLDER=off stops both the recording
// and the fallback (house shape: off/0/false/no turns it off; anything else, typos included,
// leaves it on).
import { isAttemptShipment } from './nuvizz-scan.mts';
import { driverKeyFor } from './history-derive.mts';

export const HOLDER_VERSION = 1;

export function attHolderEnabled(env: Record<string, any> = process.env): boolean {
  return !['off', '0', 'false', 'no'].includes(String(env.NUVIZZ_ATT_HOLDER ?? '').trim().toLowerCase());
}

export interface HolderRec {
  driverName: string | null;
  driverUserName: string | null;
  driverKey: string;
  loadNbr: string | null;        // the route NAME, as the board stores it
  routeName: string | null;
  nuvizzLoadNbr: string | null;  // the load NUMBER (DAVIS000…), when the list carried it
  since: string;                 // the first scan that saw it on THIS driver and route
  frozenAt?: string;             // the first scan that saw the ATT marker; never changes after
}

const str = (v: any): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** The freeze's own test, word for word (capturePlanSnapshot): routed, with a driver. */
export function isRoutedWithDriver(s: any): boolean {
  return !!(s && s.stopNbr && s.isPlanned && (s.driverUserName || s.driverName));
}

const sameAssignment = (a: HolderRec, b: HolderRec) =>
  a.driverKey === b.driverKey && a.loadNbr === b.loadNbr && a.routeName === b.routeName;

function recordFrom(s: any, prev: HolderRec | undefined, at: string): HolderRec {
  const rec: HolderRec = {
    driverName: str(s.driverName),
    driverUserName: str(s.driverUserName),
    driverKey: driverKeyFor(s),
    loadNbr: str(s.loadNbr),
    routeName: str(s.routeName),
    nuvizzLoadNbr: str(s.nuvizzLoadNbr),
    since: at,
  };
  // A row the write grace holds on its route has no load number until the list catches up
  // (CLAUDE.md, THE ROSTER SCAN HAS THE LOAD NUMBERS). Same driver, same route: keep the number
  // we already read rather than churning the record between it and null every scan.
  if (prev && sameAssignment(prev, rec)) {
    rec.since = prev.since;
    if (!rec.nuvizzLoadNbr) rec.nuvizzLoadNbr = prev.nuvizzLoadNbr;
  }
  return rec;
}

export interface HolderStep {
  holders: Record<string, HolderRec>;
  changed: boolean;
  counts: { recorded: number; moved: number; frozen: number; held: number };
}

/**
 * PURE. The day's holder map after one scan of that day's board.
 *
 * `prior` is the stored map (or nothing, the first scan of the day). Stops the scan did not see are
 * left exactly as they were — absence from one pull is not evidence of anything. `changed` is false
 * when nothing moved, so an unchanged day costs no write.
 */
export function nextHolders(
  prior: Record<string, HolderRec> | null | undefined,
  stops: any[],
  at: string,
): HolderStep {
  const holders: Record<string, HolderRec> = { ...(prior || {}) };
  const counts = { recorded: 0, moved: 0, frozen: 0, held: 0 };
  let changed = false;
  for (const s of stops || []) {
    if (!s || !s.stopNbr) continue;
    const nbr = String(s.stopNbr);
    const prev = holders[nbr];
    if (prev?.frozenAt) { counts.held++; continue; }
    if (isAttemptShipment(s.shipmentNbr)) {
      // The marker is on. Whoever we last saw it routed to is who had it; nobody after them can be.
      if (prev) { holders[nbr] = { ...prev, frozenAt: at }; counts.frozen++; changed = true; }
      continue;
    }
    if (!isRoutedWithDriver(s)) continue; // unplanned or not yet dispatched: keep what we had
    const rec = recordFrom(s, prev, at);
    if (prev && sameAssignment(prev, rec) && prev.nuvizzLoadNbr === rec.nuvizzLoadNbr) continue;
    holders[nbr] = rec;
    changed = true;
    if (prev && !sameAssignment(prev, rec)) counts.moved++;
    else if (!prev) counts.recorded++;
  }
  return { holders, changed, counts };
}

/** "007174789-1" → "007174789". */
export const originalStopNbr = (stopNbr: any): string => String(stopNbr ?? '').trim().replace(/-\d+$/, '');

export interface HolderHit { rec: HolderRec; via: 'stop' | 'original'; stopNbr: string }

/**
 * PURE. Who had this stop, from the day's holder map.
 *
 * A "-N" copy carries its original's shipment number, and with it the ATT marker once the order
 * fails — the evening list then holds the original and its copy as two rows for one failure (25
 * such pairs in 08/25 → 09/23). A copy never seen routed before the marker has no record of its
 * own; its failure is the original stop's, so the answer is whoever had the original. Reported as
 * `via: 'original'` so it is never mistaken for a record of the copy itself.
 */
export function holderFor(holders: Record<string, HolderRec> | null | undefined, stopNbr: any): HolderHit | null {
  if (!holders) return null;
  const nbr = String(stopNbr ?? '').trim();
  if (!nbr) return null;
  if (holders[nbr]) return { rec: holders[nbr], via: 'stop', stopNbr: nbr };
  const orig = originalStopNbr(nbr);
  if (orig !== nbr && holders[orig]) return { rec: holders[orig], via: 'original', stopNbr: orig };
  return null;
}

/**
 * PURE. The plan-shaped record buildAttemptItem joins against, built from a holder hit — the same
 * driver/load/route fields a morning-plan record carries, and nothing it does not have.
 */
export function planRecordFromHolder(hit: HolderHit, stopNbr: string): any {
  return {
    stopNbr: String(stopNbr),
    driverName: hit.rec.driverName,
    driverUserName: hit.rec.driverUserName,
    driverKey: hit.rec.driverKey,
    loadNbr: hit.rec.loadNbr,
    routeName: hit.rec.routeName,
  };
}
