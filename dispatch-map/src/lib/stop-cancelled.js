// stop-cancelled.js — A CANCELLED STOP IS NOT FREIGHT, AND DOES NOT BELONG ON THE BOARD.
//
// PURE. No network, no Firestore, no clock — it reads one record off a stop and answers.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS EXISTS FOR, MEASURED.
//
// Chad, with a photograph of the office television showing the whole UNITED STATES and his
// day's freight as a speck over Atlanta: "This stop is what is making the map messed up its
// been canceled and shouldn't be on my map anymore so handle that and it should self heal."
//
// He was right, and the row is worth reading in full because nothing about it is subtle.
// GRENZEBACH131732373, on the 2026-09-21 board, one of 642:
//
//     raw.stop.from.address  addr1 "5" · city "0.00" · state "CUBIC FEET" · zip "POUNDS"
//     lat 38.7946, lng -106.53484                       ← central COLORADO
//     raw.stopExecutionInfo.cancellation                reasonCode "CANCELLED"
//                                                       cancelDTTM 2026-09-20T21:00:55
//
// NuVizz had written the shipment's UNITS into the address fields, the geocoder did what a
// geocoder does with "5, 5, 0.00, Cubic Feet Pounds", and the result landed in Colorado. The
// wall frames every stop on the board, so ONE cancelled row 1,200 miles away stretched the
// camera from the Rockies to Georgia — and the midpoint of Colorado and Atlanta is Kansas,
// which is exactly where his photograph was centred.
//
// THE POINT IS NOT THE BAD GEOCODE. A garbage address is NuVizz's to fix and will happen
// again. The point is that the stop was CANCELLED at 5pm the evening before, by a named
// person, with NuVizz's own cancellation record attached — and the board was still carrying
// it the next morning. Nobody was ever going to deliver it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY CANCELLED IS NOT "EXCEPTION", which is where it was landing.
//
// nuvizz-scan.mts classifies a stop with a cancelDTTM as EXCEPTION, alongside "unable to
// deliver", a refusal, a damaged pallet. Those are the same word and two completely different
// mornings: an EXCEPTION is still freight and still somebody's job — it gets a phone call, a
// re-delivery, a conversation with the customer. A CANCELLED stop is not freight at all. It
// has no destination, no driver, and nothing anybody can do about it.
//
// Leaving it on the board is not merely clutter. It is a row a dispatcher can select, route,
// count and call about, and on this particular morning it was also dragging a wall display
// across three time zones.
//
// THE COST OF BEING WRONG, IN BOTH DIRECTIONS, because they are not symmetrical: dropping a
// live delivery would hide real freight, which is the expensive mistake — so the signal has
// to be NuVizz's own explicit cancellation record and nothing softer. Free text is not
// enough: this row's `orderInstructions` also reads "Cancelled", and a board that drops
// stops on a word in a comment field is a board that will one day drop a real one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SWITCH, in the house shape: default ON, an explicit off-word turns it off, and anything
 * MALFORMED LEAVES IT ON. Server-side (process.env), so putting it back is an env change and
 * a function restart rather than a redeploy — which matters for a rule that removes rows from
 * a dispatcher's board.
 *
 * BOARD_DROP_CANCELLED=off puts cancelled stops back on the board.
 */
export function dropCancelledEnabled(env = {}) {
  const v = String(env.BOARD_DROP_CANCELLED ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/**
 * PURE. NuVizz's own cancellation record for this stop, or null.
 *
 * Read off `raw.stopExecutionInfo.cancellation` — the path verified against the live board,
 * and `raw.stopExecutionInfo` is in LEAN_STOP_FIELDS so it survives the board's field mask.
 * (It is not at the top level and it is not under `raw.stop`; both were checked.)
 *
 * AN EMPTY `cancellation: {}` IS NOT A CANCELLATION. NuVizz ships that shape on ordinary
 * stops, and treating "the key exists" as the signal would empty the board. A real one
 * carries a cancelDTTM or an explicit CANCELLED reason code, and this requires one of them.
 */
export function stopCancellation(stop) {
  const c = stop?.raw?.stopExecutionInfo?.cancellation;
  if (!c || typeof c !== 'object') return null;
  const at = typeof c.cancelDTTM === 'string' && c.cancelDTTM.trim() ? c.cancelDTTM.trim() : null;
  const code = typeof c.reasonCode === 'string' ? c.reasonCode.trim().toUpperCase() : '';
  if (!at && code !== 'CANCELLED') return null;
  const desc = typeof c.reasonDesc === 'string' && c.reasonDesc.trim() ? c.reasonDesc.trim() : null;
  return { at, reasonCode: code || null, reasonDesc: desc };
}

/** PURE. Convenience predicate — the same rule, asked as a yes/no. */
export function isCancelledStop(stop) {
  return stopCancellation(stop) !== null;
}

/**
 * PURE. The board without its cancelled rows, and a NAMED LIST of what came off.
 *
 * The list is returned rather than swallowed for the reason every other count in this repo is
 * printed: a board that quietly holds back rows reports a different day from the one being
 * worked, and the first question when a stop is missing is "did we drop it?". The caller puts
 * the count on the feed so that question has an answer without a redeploy.
 *
 * SELF-HEALING BY CONSTRUCTION. This runs at SERVE time, not at scan time, which is what Chad
 * asked for ("it should self heal"): rows already written to Firestore stop appearing on the
 * very next 2-minute poll, with no scan, no NuVizz call and nobody pressing anything.
 */
export function dropCancelledStops(stops, enabled = true) {
  const rows = Array.isArray(stops) ? stops : [];
  if (!enabled) return { stops: rows, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const s of rows) {
    const c = stopCancellation(s);
    if (c) dropped.push({ stopNbr: s?.stopNbr ?? null, at: c.at, reasonCode: c.reasonCode });
    else kept.push(s);
  }
  return { stops: kept, dropped };
}
