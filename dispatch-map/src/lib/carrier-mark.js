// ESTES ORDERS WEAR THEIR OWN PAINT ON THE MAP.
//
// Chad: "make estes icons black with a yellow ring around them." An Estes residential run
// is a different kind of work from the Uline freight around it — different customer, different
// paperwork, different phone call when it goes wrong — and on a 700-stop board it looked
// exactly like everything else. The order NUMBER already says which lane a stop belongs to
// (the board's ESTES-<digits> convention — the manifest intake writes it, the Stops grid shows
// it in full), so the map reads the same fact instead of inventing a second one.
//
// The RING is the identity and rides every disc the stop can draw; the BLACK fills the disc
// only where the stop would otherwise wear a default tint. A colour that already means
// something — a selection, a route, a flag, an eligibility mark, a delivered green — keeps
// saying it, inside the ring. See stopMarkerIcon in App.jsx for the precedence, and the
// Legend's Carrier row for the swatch.

export const ESTES_FILL = '#000000';
export const ESTES_RING = '#facc15';

// The number is the source of truth: "ESTES-0538243875", "Estes-0828068215", "ESTES 123" all
// qualify; "WESTES-1" and a bare 9-digit PRO do not. Anything that is not a string-ish number
// is simply not an Estes order — never a throw, a marker builder runs per stop per repaint.
const ESTES_PREFIX = /^\s*ESTES(?=$|[^A-Z])/i;
export function isEstesOrder(stopNbr) {
  if (stopNbr == null) return false;
  return ESTES_PREFIX.test(String(stopNbr));
}
