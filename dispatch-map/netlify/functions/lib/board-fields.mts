// lib/board-fields.mts — WHICH FIELDS OF A BOARD STOP A SCREEN ACTUALLY NEEDS.
//
// One list, two readers. It was defined inside nuvizz-pull-today-stops for the Map feed, and
// the Routing date window (nuvizz-stop-explorer) read the SAME per-day documents with no mask
// at all — so the window paid full freight, `raw` included, for every stop in a fourteen-day
// range. Two readers of one fact, and only one of them had been told.
//
// Moved here so the answer is in one place and both endpoints ask it. Nothing about the Map
// feed's behaviour changes: it imports the identical array it used to declare.

// LEAN MAP FEED (issue: cold load blocked ~5-6s on a 6.9 MB payload; 747 stops × 67 fields).
// The map + bottom grid only read ~15-20 fields; ~55% of the payload is the raw NuVizz object
// (`raw`, 3.8 MB) plus a few fields nothing in the client reads (markfor/origin/billTo/the
// top-level orderInstructions dup). We serve ONLY the field paths below (a Firestore field
// mask on the read — so the bytes never leave Firestore), which halves the payload and the
// server time with ZERO client change: everything the markers, status, grid, selection,
// detail panel, print, texting, and auto-scanner touch is kept. The three `raw.*` slices
// preserve the only load-bearing bits of `raw` (status fallback, route/load id, print origin).
// The stored docs are untouched — history/engine/freight still read every field directly.
// KILL SWITCH: `?full=1` on the request OR env MAP_FEED_FULL=1 returns the ORIGINAL full
// payload (no mask), so this is instantly reversible without a code change.
// Derived from normalizeStop's schema (nuvizz-scan.mts) ∪ the enrichment/list-path fields, so
// a field that's null/absent on a given day is still served on days it appears. Keep in sync
// if the stored stop shape gains a NEW field the client needs (or just flip the kill switch).
export const LEAN_STOP_FIELDS = [
  'addr1', 'addr2', 'allComments', 'boardDate', 'board_write_at', 'board_write_planned', 'board_write_from',
  'bol', 'businessName', 'carryover', 'cartons', 'city', 'contact',
  'custRef', 'customerAccount', 'deliveredDTTM', 'driverId', 'driverName', 'driverUserName',
  'enriched', 'enriched_at', 'estimatedDurationMin', 'isAttempt', 'isPlanned', 'isTerminal',
  'isUnplanned', 'itemsSummary', 'lat', 'listUpdatedDTTM', 'lng', 'loadId',
  'loadNbr', 'loadStopSeq', 'normalizedStatus', 'orderNbr', 'pallets', 'plannedDistanceToNextStop',
  'plannedDurationToNextStop', 'plannedEtaDTTM', 'poRef', 'podDocs', 'primaryPro', 'pro',
  'proCount', 'proNbr', 'pros', 'requestedDate', 'routeName', 'routeSeq',
  'orderInstructions', 'notes_refreshed_at',
  'scheduledDate', 'scheduledFrom', 'scheduledTo', 'shipmentNbr', 'signalSources', 'source',
  'state', 'status', 'stopDetails', 'stopDistance', 'stopId', 'stopNbr',
  'stopType', 'terms', 'timeConstraint', 'volume', 'warehouse', 'weight',
  'zip', 'raw.stopExecutionInfo', 'raw.load', 'raw.stop.from',
];

/**
 * THE PROBLEM-ADDRESS QUEUE'S PROJECTION — narrower than lean, on purpose.
 *
 * The queue judges three things: is there a pin, is the saved pin older than the saved
 * address, and does addr1 look mis-split. That needs the address, the coordinates and enough
 * identity to push the order and to name it on screen — and nothing else. LEAN_STOP_FIELDS
 * is ~70 fields and this file's own header records what a fat board payload cost once: a cold
 * load blocked for seconds on a multi-megabyte response. A queue that ships three whole boards
 * to a phone to find twenty rows repeats it.
 *
 * `stopId` is not optional furniture: without it the server's twin guard is disarmed
 * (nuvizz-write-ops.mts:823) and a push can re-address the wrong order sharing that number.
 * `normalizedStatus` is what lets the queue skip delivered freight for free instead of
 * spending a vendor call to be refused.
 */
export const QUEUE_STOP_FIELDS = [
  'addr1', 'addr2', 'boardDate', 'businessName', 'city', 'isPlanned',
  'lat', 'lng', 'loadNbr', 'normalizedStatus', 'primaryPro', 'pro',
  'routeName', 'scheduledDate', 'state', 'status', 'stopId', 'stopNbr', 'zip',
];

/** The customer_notes fields the queue joins against — the override, the pin, and the two
 *  stamps that decide whether the pin is older than the address. Read server-side, where
 *  these come back as RFC3339 strings (firestore.mts:157), never Firestore Timestamps. */
export const QUEUE_NOTE_FIELDS = [
  'match_key', 'address_override', 'address_override_at', 'location_override', 'location_override_at',
];
