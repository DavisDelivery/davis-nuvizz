// src/lib/card-manifest.js — what a Compare card's "Print manifest" puts on paper (PURE).
//
// Chad, 2026-09-29: "why my print manifest doesn't match the order my deliveries are in in route
// work bench until a nuvizz save has occurred — to me it should always match even if a save
// hasn't occurred." Then: "I want my manifest to always match what is in dispatch map."
//
// THE CAUSE. The card handed its stops over in its own order, and buildManifestHtml threw that
// order away: it re-sorted by NuVizz's stop sequence (routeSeq). Before a Save every stop still
// carries the sequence of the load it came OFF, so the paper came out in the old order. After a
// confirmed Save the plan overlay stamps routeSeq 1..N in the card's order (recordPlanOverlay),
// and the same re-sort then happened to agree with the screen — which is why saving looked like
// it "fixed" the manifest. On a brand-new route no stop has a sequence at all, and the re-sort
// fell through to nearestNeighborOrder: a chain from the most north-west stop that was written
// to keep a map polyline from crisscrossing, not to sequence freight. Nobody chose that order.
//
// THE NUMBER IN THE CIRCLE. NuVizz numbers PHYSICAL stops — two orders at one dock share a
// number (routeSeqOf's contract, and the dock's load-scan groups the trailer by it) — and that is
// what the driver's handheld shows once the route is saved. So a re-ordered page is numbered the
// way NuVizz will number it: by position in the card's order, consecutive orders at the same dock
// (placeKeyOfStop — the repo's one "same dock?" rule) sharing a number. The card's own rows count
// orders (3, 4 for two orders at one dock); the paper follows the handheld (3, 3), because a paper
// that runs one ahead of the handheld after every shared dock sends a "stop 3" call to the wrong
// customer. A stop the board can no longer resolve still takes its number, so the gap is real:
// the card is still carrying it and the print handler says so.

import { placeKeyOfStop } from './matchKey.js';

/**
 * @param {Array}  order   the card's route.order — stop numbers, in the order shown
 * @param {Map}    lookup  stopNbr → board stop (the same index the card renders its rows from)
 * @returns {{ stops: object[], labels: number[], missing: number }}
 *   stops   the resolvable stops, in card order
 *   labels  the stop number each would carry in that order, parallel to `stops`
 *   missing how many ids in the order the board could not resolve (not printable)
 */
export function cardManifestPages(order, lookup) {
  const ids = Array.isArray(order) ? order : [];
  const get = lookup && typeof lookup.get === 'function' ? (id) => lookup.get(String(id)) : () => undefined;
  const stops = [];
  const labels = [];
  let n = 0;
  let prevDock = null;
  for (const id of ids) {
    const s = get(id);
    const dock = s ? placeKeyOfStop(s) : null;          // an unresolved id is a stop of its own
    if (!(dock && dock === prevDock)) n += 1;
    prevDock = dock;
    if (!s) continue;
    stops.push(s);
    labels.push(n);
  }
  return { stops, labels, missing: ids.length - stops.length };
}

/**
 * PURE: are these two stop lists the same stops in the same order?
 *
 * The manifest asks it of the card's page order against NuVizz's own order. When they agree the
 * page IS NuVizz's route, and it prints exactly what it always printed — NuVizz's numbers and its
 * per-stop ETA. When they do not, NuVizz's numbers and ETAs belong to a different route.
 */
export function stopOrdersAgree(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((s, i) => String(s?.stopNbr ?? '') === String(b[i]?.stopNbr ?? ''));
}
