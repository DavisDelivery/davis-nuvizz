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
  // When the scan FIRST saw this order, and NuVizz's own stamp frozen at that moment.
  // Both write-once (firestore.mts writeStops); the order-arrivals curve is built on them.
  'first_seen_at', 'arrived_list_dttm',
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

/**
 * The customer_notes fields the Uline straight-truck review joins against. Everything the card
 * shows and everything the decision is judged by, and nothing else — the collection is read
 * whole on every open (the same listDocs the queue does), so an unmasked read would ship every
 * dock note and receiving-hours map on the board to answer a question about five of them.
 *
 * `manual_overrides` and `auto_sources` are here because `ulineDecision` reads provenance through
 * confirmedBlockerKeys, and the two fail in OPPOSITE directions:
 *   • drop `manual_overrides` and a location whose restriction list a dispatcher LOCKED — keeping
 *     Uline's flag in it — reads as undecided, and the tab offers a one-tap "Tractor OK" that
 *     overrules the person who locked it. The dangerous direction.
 *   • drop `auto_sources` and every scanner-found blocker reads as a person's (unknown provenance
 *     counts as confirmed). Cautious, but it files the legacy "Uline's text wearing our key" case
 *     under "a dispatcher already said no", where nobody can clear it from this tab.
 * The test fake returns whole documents whatever the mask says, so ONLY the explicit mask
 * assertion in test/uline-review-endpoint.test.mjs can catch either one being dropped.
 */
export const ULINE_NOTE_FIELDS = [
  'match_key', 'raw_name', 'equipment_restrictions', 'manual_overrides', 'auto_sources', 'auto_matches',
  'vehicle_eligibility', 'vehicle_eligibility_at', 'vehicle_eligibility_by',
  'location_override', 'location_override_at', 'address_override', 'address_override_at', 'building_type',
];

/**
 * THE CUSTOMER VIEW'S PROJECTION — what "how many deliveries for this customer today, and
 * who delivered them" actually needs off a board day.
 *
 * Narrower than LEAN on purpose, and the reason is the read shape: this sweeps a WHOLE day's
 * stops (~700 docs) for every day in the window and keeps the handful that match one name.
 * LEAN carries `raw` slices, stopDetails, allComments and the comms/geometry fields, none of
 * which a customer day view reads — and this file's own header records what a fat board
 * payload cost once. Serving them here would ship a multi-megabyte board per day to answer a
 * question about six stops.
 *
 * `raw.stopExecutionInfo` earns its place alone: `arrivalDTTM` is not always populated on the
 * stop itself and the execution block is where the app's own accessor falls back to (see
 * execArrivalTs in App.jsx). "Arrived at" missing in silence, on the screen whose job is
 * telling a customer when we were there, is the failure worth one nested field.
 *
 * The address fields are not optional furniture either: board rows carry NO customerMatchKey
 * (routing-cleanup-core.mts says so), so name + addr1 + city + zip is how a stop is joined to
 * its customer_notes document at all.
 */
/**
 * THE LABELS SCREEN'S PROJECTION (labels-by-shipper.mts) — narrower than lean, on purpose.
 *
 * What labelOrderFromStop prints (ship-to, items, skid/loose/weight, the delivery window's day),
 * the phone the stop card would dial (`contact`), what the shipper and pickup rules read
 * (`stopNbr`, `stopType`), what the list shows beside each order (status, route, driver), and the
 * cancellation record dropCancelledStops reads (`raw.stopExecutionInfo`). A whole day's board is
 * read every time a shipper is picked, so nothing rides along that a label does not print.
 * test/labels-by-shipper.test.mjs pins that every field the label reads is here.
 */
export const LABEL_STOP_FIELDS = [
  'addr1', 'addr2', 'businessName', 'cartons', 'city', 'contact', 'driverName', 'loadNbr',
  'normalizedStatus', 'pro', 'routeName', 'scheduledFrom', 'state', 'status', 'stopDetails',
  'stopNbr', 'stopType', 'volume', 'weight', 'zip', 'raw.stopExecutionInfo',
];

export const CUSTOMER_STOP_FIELDS = [
  'addr1', 'addr2', 'arrivalDTTM', 'bol', 'boardDate', 'businessName', 'cartons', 'city',
  'custRef', 'deliveredDTTM', 'driverName', 'driverUserName', 'isAttempt', 'isPlanned',
  'loadNbr', 'loadStopSeq', 'normalizedStatus', 'orderNbr', 'pallets', 'plannedEtaDTTM',
  'poRef', 'podDocs', 'primaryPro', 'pro', 'proCount', 'pros', 'requestedDate', 'routeName',
  'routeSeq', 'scheduledDate', 'scheduledFrom', 'scheduledTo', 'shipmentNbr', 'state',
  'status', 'stopNbr', 'volume', 'weight', 'zip', 'raw.stopExecutionInfo',
];

/**
 * THE LOAD LOOKUP'S PROJECTION (driver-loads.mts) — a driver's week, read a whole day at a time.
 *
 * Who ran it (driver + load), where each order went and when it was finished (the pin, the stop
 * sequence, the delivery stamp from wherever the record keeps it), the freight, and the two places
 * an order's price lives: the order instructions Uline writes TOTAL-AMOUNT into, and NuVizz's
 * Seal # (`raw.stop.sealNbr`), where Davis records a shipment's price. The cancellation record is
 * the board's own drop rule. Nothing else rides along — seven whole days are read per question,
 * and `raw` unmasked is ~5KB a stop. test/driver-loads.test.mjs pins that every field
 * src/lib/load-lookup.js reads is here.
 */
export const LOAD_STOP_FIELDS = [
  'stopNbr', 'stopType', 'businessName', 'city', 'zip', 'lat', 'lng',
  'driverName', 'driverUserName', 'routeName', 'loadNbr', 'normalizedStatus',
  'deliveredDTTM', 'executed.deliveredDTTM', 'raw.stopExecutionInfo.to.deliveredDTTM',
  'routeSeq', 'loadStopSeq', 'plannedEtaDTTM', 'cartons', 'volume', 'weight', 'isAttempt',
  'orderInstructions', 'signalSources.orderInstructions', 'raw.stop.sealNbr',
  'raw.stopExecutionInfo.cancellation',
];
