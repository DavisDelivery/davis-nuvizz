// lib/place-lift.mts — "HAS A TRACTOR ALREADY DELIVERED HERE?", asked by the server sweeps for
// exactly the stops whose board-flags R7b verdict turns on it, and for no others.
//
// R7b (board-flags.js) flags a school, church or government stop riding a tractor-trailer, and
// stands down where a tractor has already delivered (tractor_locations). The browser holds the
// whole tractor map; a sweep does not, and reading ~thousands of docs every five minutes to
// answer a question about three stops would be absurd. So the engine reports the match keys it
// would like an answer for (placeLiftWanted — the same two-pass shape as legsWanted), the sweep
// reads ONLY those docs by id, and judges again with the answer.
//
// WHAT THE SERVER CAN AND CANNOT SEE, SAID IN THE RECORD. tractor_locations is keyed by match
// key, and a doc-id read can only answer "by match key". The browser also lifts by street + ZIP
// (a tractor that delivered at this address under another customer name); the sweep cannot
// without listing the collection, so the run record says placeLift: 'match_key' and the count
// can be higher than the board's. These rows never text, email or reach flag history, so the
// only thing that difference can move is a number in a run record that names its own method.
//
// COST: zero NuVizz calls; one Firestore read per wanted key, bounded by PLACE_LIFT_READ_CAP,
// and none at all on a board with no school/church/government stop on a tractor. The bound is
// RECORDED when it bites (placeLiftCapped) — a silent cap is a count nobody can trust.
//
// WHO CALLS IT: the evening sweep (its status doc keeps the count) and eta-flag-check (its
// answer is read synchronously). NOT the day alert sweep, on purpose: nothing it keeps reads an
// R7b row (selectAlertable names ALERT_RULES, mergeSweep keeps hours_risk), and its run record
// is a *-background response Netlify throws away — so the reads, up to 50 a fire on a */5 cron,
// would buy nothing anyone could see.
import { tractorLocPath } from './tractor-flags.mts';

export const PLACE_LIFT_READ_CAP = 50;
const CHUNK = 25;

export interface PlaceLiftRecord {
  placeLift: 'match_key';
  placeLiftWanted: number;   // distinct match keys the engine asked about
  placeLiftRead: number;     // how many were actually read (≤ the cap)
  placeLiftSeen: number;     // how many of those have a tractor delivery on file
  placeLiftCapped: boolean;  // the cap bit: some keys were NOT read, and judge as not-seen
  placeLiftErrors: number;   // reads that failed: those keys judge as not-seen too
}

/**
 * Read the tractor_locations docs for `wanted` (board-flags placeLiftWanted) and return the
 * placeMarks option for the final engine pass plus the run-record fields that say what it did.
 * `readDoc` is lib/firestore getDoc in production; a test passes a Map-backed fake.
 */
export async function readPlaceLift(
  wanted: string[] | null | undefined,
  readDoc: (path: string) => Promise<any>,
  tenant: string,
  cap: number = PLACE_LIFT_READ_CAP,
): Promise<{ placeMarks: any; record: PlaceLiftRecord }> {
  // Sorted so which keys fall past the cap is the same every sweep, not feed order.
  const keys = [...new Set((wanted || []).map((k) => String(k ?? '')).filter((k) => /[a-z0-9]/i.test(k)))].sort();
  const bound = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  const take = keys.slice(0, bound);
  const seen = new Set<string>();
  let errors = 0;
  for (let i = 0; i < take.length; i += CHUNK) {
    await Promise.all(take.slice(i, i + CHUNK).map(async (k) => {
      try { if (await readDoc(tractorLocPath(tenant, k))) seen.add(k); } catch { errors += 1; }
    }));
  }
  return {
    placeMarks: {
      // The server never runs the Shiplify trial: only a dispatcher's Building type counts here.
      shiplifyOn: false,
      tractorSeenOf: (s: any) => seen.has(String(s?.matchKey ?? '')),
      // Known: every key the engine asked about was either read or is reported as capped/errored.
      tractorKnown: true,
    },
    record: {
      placeLift: 'match_key',
      placeLiftWanted: keys.length,
      placeLiftRead: take.length,
      placeLiftSeen: seen.size,
      placeLiftCapped: keys.length > take.length,
      placeLiftErrors: errors,
    },
  };
}

/** The run-record fields: how many docks R7b carded on the FINAL pass, and how it was lifted. */
export function placeRunFields(flags: any, lift: { record: PlaceLiftRecord } | null) {
  return {
    placeConflicts: flags?.checked?.placeConflicts ?? 0,
    // Folded into an R7 card on the same dock — not lost, and not counted twice.
    placeInTrailerCard: flags?.checked?.placeInTrailerCard ?? 0,
    // WHAT WAS COUNTED, named: the sweeps have no Shiplify switch, so only a dispatcher's own
    // Building type reaches R7b here. A board with its Shiplify switch on can show more cards than
    // this count, and the record says why rather than looking like a sweep that missed them.
    placeSources: 'dispatcher_only',
    ...(lift ? lift.record : { placeLift: flags?.checked?.placeLift ?? 'none' }),
  };
}
