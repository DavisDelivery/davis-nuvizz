// src/lib/card-manifest.js — what a Compare card's "Print manifest" puts on paper (PURE).
//
// Chad, 2026-09-29: "spell this out simply why my print manifest doesn't match the order my
// deliveries are in in route work bench until a nuvizz save has occurred — to me it should
// always match even if a save hasn't occurred." Then: "I want my manifest to always match
// what is in dispatch map."
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
// The ticket's circled number had the same fault on the same paper — it printed NuVizz's
// routeSeq — so fixing the page order alone would still hand a driver pages stamped 7, 3, 12.
//
// THE RULE HERE: the manifest prints the card's stops in the card's order, and each ticket wears
// the number that stop's row wears on the card. The card numbers its rows by position ({i + 1}
// over route.order, stub rows included), so a stop the board can no longer resolve keeps its
// place in the count: the paper reads 1, 2, 4 and the gap is real — the card is still carrying
// stop 3 and the print handler says out loud that it is not on this manifest.

/**
 * @param {Array}  order   the card's route.order — stop numbers, in the order shown
 * @param {Map}    lookup  stopNbr → board stop (the same index the card renders its rows from)
 * @returns {{ stops: object[], labels: number[], missing: number }}
 *   stops   the resolvable stops, in card order
 *   labels  the card row number of each, parallel to `stops`
 *   missing how many ids in the order the board could not resolve (not printable)
 */
export function cardManifestPages(order, lookup) {
  const ids = Array.isArray(order) ? order : [];
  const get = lookup && typeof lookup.get === 'function' ? (id) => lookup.get(String(id)) : () => undefined;
  const stops = [];
  const labels = [];
  ids.forEach((id, i) => {
    const s = get(id);
    if (!s) return;
    stops.push(s);
    labels.push(i + 1);
  });
  return { stops, labels, missing: ids.length - stops.length };
}
