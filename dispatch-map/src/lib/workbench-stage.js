// src/lib/workbench-stage.js
//
// PURE: how a Compare workbench card is seeded when a build/draft is staged onto
// an EXISTING NuVizz load. Extracted from App.jsx's stagePlanOntoLoads because
// the rule it encodes is subtle, safety-critical, and was wrong:
//
// A Compare card carries three lists and the RWB save reads all three:
//   baseline — what the load holds in NuVizz RIGHT NOW. It is the TRUTH, and the
//              save is DECLARATIVE, so anything the load holds that the payload
//              neither orders nor removes is "unaccounted" and the whole load is
//              REFUSED (nuvizz-write.mts, the stale-board guard).
//   order    — what we want the load to hold after the save.
//   removed  — what is deliberately leaving it.
//
// THE BUG THIS FIXES. The old seed took the load's current stops from the
// COORD-ONLY board projection, while opening the same card by hand took them
// from the coord-INCLUSIVE one — even though its comment claimed the two rules
// were identical. A load holding a stop that has no geocode yet therefore built
// a baseline missing that stop, the payload never mentioned it, and the save
// came back "has 1 stop(s) the board isn't showing … Refresh and retry" — advice
// that cannot work, because refreshing does not geocode anything. Same shape for
// a stop staged onto ANOTHER open card: dropped from both lists, so the load was
// refused instead of the stop simply moving.
//
// The rule, stated once: the load's WHOLE current membership is the baseline; a
// stop staged elsewhere is not dropped, it is REMOVED (which is what a move is);
// everything else stays and the new work is appended.

/**
 * Seed a workbench card for `cardKey` from the load's current board membership.
 *
 * @param {string[]} boardStopNbrs  every stop number currently on the load, in board order,
 *                                  from the COORD-INCLUSIVE projection (an ungeocoded stop
 *                                  is still on the truck).
 * @param {string[]} addIds         stop numbers being staged onto it now, in engine order.
 * @param {Map<string,string>} heldBy  stopNbr → the card key already holding it.
 * @param {string} cardKey          this card's key (a stop held by THIS card is not "elsewhere").
 * @returns {{baseline: string[], order: string[], removed: string[], skippedHeld: string[]}}
 */
export function seedStagedCard(boardStopNbrs, addIds, heldBy, cardKey) {
  const held = heldBy instanceof Map ? heldBy : new Map();
  const baseline = [];
  const seen = new Set();
  for (const raw of boardStopNbrs || []) {
    const id = String(raw);
    if (!id || seen.has(id)) continue;   // a duplicated board row must not double-count
    seen.add(id);
    baseline.push(id);
  }
  // Elsewhere = held by a DIFFERENT card. Held by this card is simply already here.
  const elsewhere = (id) => held.has(id) && held.get(id) !== cardKey;
  const order = baseline.filter((id) => !elsewhere(id));
  const removed = baseline.filter((id) => elsewhere(id));

  const onCard = new Set(order);
  const skippedHeld = [];
  for (const raw of addIds || []) {
    const id = String(raw);
    if (!id || onCard.has(id)) continue;
    if (elsewhere(id)) { skippedHeld.push(id); continue; }
    onCard.add(id);
    order.push(id);
  }
  return { baseline, order, removed, skippedHeld };
}
