// src/lib/stop-sort.js
//
// ORDERING THE PHONE'S STOPS LIST. Chad: "also want to be able to sort this screen by skids."
//
// The list arrives in board order — the order the filters and the scan produced — and that
// stays the default, because it is the order every other surface agrees with. A sort is an
// overlay on top of it, not a new source of truth.
//
// NuVizz MISLABELS ITS FREIGHT FIELDS, and this is the one thing to get right here: NuVizz
// "cartons" are real skids/pallets, and NuVizz "volume" is loose pieces. That is how the card
// prints "1 skid · 1 loose" (MobileStopCard) and how the New Order form writes them. So
// sorting by skids means sorting by `cartons`, and reading `pallets` here — the field with the
// obvious name — would sort by the total piece count and quietly disagree with the number
// printed on the row.

/** Skids on a stop — NuVizz `cartons`. Missing/garbage counts as 0, never NaN: a stop with no
 *  freight recorded belongs at the "fewest" end, not in an undefined position. */
export const skidsOf = (s) => {
  const n = Number(s?.cartons);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Loose pieces — NuVizz `volume`. Same rule. */
export const looseOf = (s) => {
  const n = Number(s?.volume);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// The orders the phone list offers. `board` carries no comparator: it IS the incoming order,
// and the list is returned untouched so the array identity survives (no needless re-render).
export const STOP_SORTS = [
  { key: 'board', label: 'Board order' },
  { key: 'skids', label: 'Skids', value: skidsOf, defaultDir: 'desc' },
];

export const stopSort = (key) => STOP_SORTS.find((s) => s.key === key) || STOP_SORTS[0];

/**
 * PURE: `stops` in the requested order. Never mutates the input.
 *
 * Ties keep BOARD ORDER. That matters more than it sounds on a 728-stop board: most stops
 * carry 1 skid, so a naive sort would reshuffle hundreds of equal rows on every render and
 * the list would appear to jitter under your thumb. Array.prototype.sort is stable, and the
 * direction is applied as a multiplier rather than by reversing the array — a `.reverse()`
 * flips the ties too, which is exactly the stability this relies on being thrown away.
 */
export function sortStops(stops, key, dir) {
  const list = Array.isArray(stops) ? stops : [];
  const spec = stopSort(key);
  if (!spec.value) return list;
  const mult = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => (spec.value(a) - spec.value(b)) * mult);
}

/** The next state of the sort control when its chip is tapped: a fresh key starts at its own
 *  natural direction (skids: most first — that is what you are looking for on a phone), and
 *  tapping the active one flips it. */
export function nextStopSort(current, key) {
  const spec = stopSort(key);
  if (!spec.value) return { key: 'board', dir: 'desc' };
  if (current?.key !== key) return { key, dir: spec.defaultDir || 'desc' };
  return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
}
