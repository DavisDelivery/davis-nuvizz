// address-queue.mts — THE PURE CORE OF THE PROBLEM-ADDRESS QUEUE.
//
// Chad: "list by board day every stop that the system has flagged as a problem address, let
// us correct it there, and push individuals or the group to NuVizz."
//
// WHY THIS IS NOT BUILT ON THE ADDRESS-CHANGE LOG. The obvious substrate was the log the
// Address History screen already reads — it is per board day and costs nothing. The repo's
// own measurement says it would render EMPTY: firestore.mts:1427-1430 records a scan-over-scan
// run on two real board days (2026-09-10 and -11, 90 stops carried across both) that produced
// ZERO rows. The log answers "did this address CHANGE"; the queue has to answer "is this
// address WRONG", which is a different question and a different data source. So the rows are
// RECOMPUTED from the board, by the same pure rules the board itself judges with.
//
// ONE DEFINITION, TWO CALLERS. `addressLooksOff` and `stopPosition` are imported from src/lib
// rather than restated — the pattern lib/flag-replay-core.mts:29 already uses for
// computeBoardFlags. A second copy of these rules is how the queue and the board come to
// disagree about which stops are broken, which is the drift matchKey.js:25-28 warns about
// arriving from a new direction.
//
// THE THIRD SIGNAL IS NEW, AND IT IS THE ONE NOBODY COULD SEE. `corrected_not_pinned` catches
// an address that was corrected while its geocode failed. autoFixAddress saves the text and
// skips the pin (App.jsx:12004, `if (geo)`), and `stopPosition` then falls through to the
// FEED coordinates — which were geocoded from the OLD, WRONG address (board-flags.js:411). So
// the card reads the right street, the pin sits on the wrong building, `no_location` stays
// silent because a position does exist, and nothing anywhere flags it. A truck routed off that
// pin goes to the old address while the paperwork says the new one. Chad, on being shown it:
// "WE should flag this if it happens."

import { addressLooksOff, suggestAddressFix } from '../../../src/lib/address-fix.js';
import { stopPosition } from '../../../src/lib/board-flags.js';
import { shownAddress, vendorAddress } from '../../../src/lib/address-log.js';
import { normStreetOf } from '../../../src/lib/matchKey.js';

export type QueueSignal = 'no_pin' | 'corrected_not_pinned' | 'mis_split';

/** Newest-first severity, and the order the queue sorts by. A stop with no pin at all cannot
 *  be routed or lasso-selected; a stale pin sends a truck somewhere specific and wrong; a
 *  mis-split is wrong text that may still have geocoded close enough. */
export const SIGNAL_RANK: Record<QueueSignal, number> = {
  no_pin: 0, corrected_not_pinned: 1, mis_split: 2,
};

/**
 * THE SWITCH. Copied byte-for-byte from addressHistoryEnabled (lib/address-history.mts:375)
 * and deliberately its OWN env var: sharing ADDRESS_HISTORY would mean switching off the log
 * silently takes the queue with it — "a switch that reverts the wrong thing", which CLAUDE.md
 * names directly. Default ON; an explicit off-word turns it off; anything malformed leaves it
 * ON, because a typo must never silently stop a queue nobody would notice had stopped.
 */
export function addressQueueEnabled(env: any = process.env): boolean {
  const v = String(env?.ADDRESS_QUEUE ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

const s = (v: any) => (v == null ? '' : String(v).trim());
// `Number(null)` is 0 and 0 is FINITE — the burn CLAUDE.md names by name, and the reason this
// is parseFloat and not Number. Copied from board-flags.js:402 so `hasPin` and `stopPosition`
// can never disagree about whether a coordinate exists; a second recipe here is how a pin
// reads as present to one and absent to the other.
const numOr = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };

/** PURE: does this note carry a usable pin? BOTH coordinates required — a half-written
 *  override (lat saved, lng lost) is not a location, and treating it as one puts a pin on the
 *  equator. See numOr above for why this is not `Number()`. */
export function hasPin(loc: any): boolean {
  return numOr(loc?.lat) != null && numOr(loc?.lng) != null;
}

/**
 * PURE: is the saved pin older than the saved address — i.e. was the address corrected and
 * the pin left behind?
 *
 * BOTH ARMS ARE LOAD-BEARING and each catches what the other misses:
 *   • the PIN arm (`!hasPin`) catches autoFixAddress saving text with no pin at all, AND
 *     resetStopLocation (App.jsx:12038) which clears `location_override` but leaves
 *     `location_override_at` stamped — a timestamp that outlives its own pin.
 *   • the TIMESTAMP arm catches a pin that exists but predates the correction: dragged first,
 *     address fixed after, so it still points at the old building.
 * Dropping either one makes the queue quietly show fewer rows, and a queue that under-fires
 * looks exactly like a clean board. That is the v0.56.3 shape.
 *
 * Server-side these stamps read back as RFC3339 STRINGS (firestore.mts:157 —
 * `if ('timestampValue' in v) return v.timestampValue;`), never Firestore Timestamp objects.
 */
export function pinIsStale(note: any): boolean {
  const addrAt = Date.parse(s(note?.address_override_at));
  if (!Number.isFinite(addrAt)) return false;         // no correction recorded → nothing stale
  if (!hasPin(note?.location_override)) return true;  // corrected, never pinned
  const pinAt = Date.parse(s(note?.location_override_at));
  if (!Number.isFinite(pinAt)) return true;           // pinned, but we cannot prove when
  return pinAt < addrAt;                              // pinned BEFORE the correction
}

/**
 * PURE: which single signal puts this stop on the queue, or null.
 *
 * ONE ROW PER STOP, and the precedence is fixed rather than incidental:
 *   1. `no_pin` first, because it is the signal the BOARD already raises (board-flags.js:833).
 *      The queue and the board must never disagree about which stops cannot be routed.
 *   2. `corrected_not_pinned` next — reached only when a position does exist, which is exactly
 *      the silent case: the position is there and it is the wrong one.
 *   3. `mis_split` last. It is mutually exclusive with 1 and 2 BY CONSTRUCTION, not by
 *      ordering: addressLooksOff returns false the moment an address_override exists
 *      (address-fix.js:28), and both of the first two require one.
 */
export function classifyQueueRow(stop: any, note: any): QueueSignal | null {
  if (!stop) return null;
  if (stopPosition(stop, note) === null) return 'no_pin';
  if (note?.address_override && pinIsStale(note)) return 'corrected_not_pinned';
  if (addressLooksOff(stop, note)) return 'mis_split';
  return null;
}

/**
 * PURE: a fingerprint of WHAT WAS DISMISSED, so a dismissal expires when the thing changes.
 *
 * A dismissal keyed only by stop number would swallow a NEW problem at the same stop for ever
 * — somebody waves off a mis-split, the carrier re-addresses the order to something worse, and
 * the row never comes back. The board already dismisses `no_location` this way
 * (board-flags.js:838, `fingerprint: noloc|${matchKey}|${addr1}`), so the queue matching that
 * discipline is what keeps the two screens agreeing about when a correction counts.
 *
 * `shownAddress` — not the raw stop — because that is the precedence the CARD renders with
 * (address-log.js:26-32: reading anywhere else fingerprints "an address nobody was looking
 * at"). `normStreetOf` rather than a second normaliser, for the reason matchKey.js:25-28 gives.
 *
 * NO TIMESTAMPS IN IT. The pin's source and coordinates carry the same information, and
 * `location_override_at` is provably orphanable by both reset paths. A `source` moving
 * feed → override at identical coordinates still changes the fingerprint — which IS the
 * corrected-not-pinned case being resolved, so the dismissal correctly expires.
 *
 * The `v1|` prefix invalidates every stored dismissal at once if this recipe ever changes,
 * rather than silently matching the wrong thing.
 */
export function queueRowFingerprint(stop: any, note: any): string {
  const a = shownAddress(stop, note);
  const pos = stopPosition(stop, note);
  const pin = pos ? `${pos.source}:${pos.lat.toFixed(5)},${pos.lng.toFixed(5)}` : 'nopin';
  return ['v1', normStreetOf(a.addr1), normStreetOf(a.addr2), s(a.city), s(a.state), s(a.zip), pin].join('|');
}

/** PURE: sanitise one path-ish token. The recipe already used at App.jsx:17041. */
const sanitize = (v: any) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

/**
 * PURE: the dismissal's map key, or null when we cannot name the row safely.
 *
 * KEYED ON THE STOP, NOT THE CUSTOMER. `addressLooksOff` reads addr1/addr2 off the ORDER
 * (address-fix.js:29-30) and those vary per order, so two PROs at one dock are two separate
 * decisions. Keying on matchKey would let waving off one order hide another that a dispatcher
 * has never seen.
 *
 * REFUSES rather than colliding: with neither a stop number nor a customer key, every such row
 * would share the bare key `${signal}__` and dismissing one would hide them all. A null
 * stopNbr is a real shape here — address-log.js:74 already tolerates it.
 */
export function dismissalKey(signal: QueueSignal, stop: any): string | null {
  const id = sanitize(s(stop?.stopNbr) || s(stop?.pro) || s(stop?.matchKey));
  return id ? `${signal}__${id}` : null;
}

/** PURE: the whole row the endpoint serves, or null when this stop is not a problem. */
export function buildQueueRow(stop: any, note: any, date: string): Record<string, any> | null {
  const signal = classifyQueueRow(stop, note);
  if (!signal) return null;
  const pos = stopPosition(stop, note);
  return {
    signal,
    rank: SIGNAL_RANK[signal],
    date,
    stopNbr: s(stop?.stopNbr) || null,
    // stopId PINS A PUSH TO THE RECORD ON SCREEN. Without it the server's twin guard is
    // disarmed (nuvizz-write-ops.mts:823 returns null when either id is unshaped), and
    // re-addressing the wrong twin sends freight where nobody chose — the Estes-0828068215
    // lesson. The UI excludes id-less rows from select-all and says why.
    stopId: s(stop?.stopId) || null,
    pro: s(stop?.pro) || s(stop?.primaryPro) || null,
    matchKey: s(stop?.matchKey) || null,
    businessName: s(stop?.businessName) || null,
    routeName: s(stop?.routeName) || null,
    loadNbr: s(stop?.loadNbr) || null,
    status: s(stop?.normalizedStatus) || s(stop?.status) || null,
    // What the card is SHOWING (override applied) and what NuVizz holds, kept apart: a
    // dispatcher deciding whether to push needs to see both sides of the disagreement.
    shown: shownAddress(stop, note),
    vendor: vendorAddress(stop),
    corrected: !!note?.address_override,
    pinSource: pos ? pos.source : null,
    // Only meaningful for mis_split; null elsewhere, never a fabricated suggestion.
    suggestion: signal === 'mis_split' ? suggestAddressFix(stop) : null,
    fp: queueRowFingerprint(stop, note),
    key: dismissalKey(signal, stop),
  };
}

/** PURE: order the day's rows — worst signal first, then by the name a dispatcher reads. */
export function sortQueueRows(rows: any[]): any[] {
  return [...(rows || [])].sort((a, b) =>
    (a.rank - b.rank) || s(a.businessName).localeCompare(s(b.businessName)) || s(a.stopNbr).localeCompare(s(b.stopNbr)));
}

/** PURE: is this row currently waved off? A stored dismissal only counts while the address
 *  and pin it was recorded against are unchanged — see queueRowFingerprint. */
export function isDismissed(row: any, items: any): boolean {
  const rec = row?.key ? (items || {})[row.key] : null;
  return !!rec && s(rec.fp) === s(row.fp);
}
