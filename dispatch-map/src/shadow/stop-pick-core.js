// stop-pick-core.js — PICKING A SECTION'S STOPS ON THE MAP: the rules, pure (v1.78.0).
//
// Chad, 2026-09-27: "i would like the choice to do it in sections where i have a map in a drawer and can
// select the stops i want you to put the stops on." The map (StopPicker.jsx) draws every open delivery
// the plan would read; these functions say which may be picked, what a tap, a box or "every stop in
// view" does to the picks, and what the picks add up to. No map, no fetch: tested on their own.

/**
 * May this stop be picked for a section? Not one an earlier section already placed (it is on its truck),
 * and — planning unplanned stops only — not one already on a load in NuVizz (it stays where it is).
 */
export function pickable(s, scope) {
  if (!s || s.earlier) return false;
  return scope === 'open' || !s.onLoad;
}

/**
 * What a stop is on the map: picked, free to pick (and whether an earlier section left it off), on a load
 * in NuVizz, or placed by an earlier section.
 */
export function stopState(s, sel, scope) {
  if (s.earlier) return 'earlier';
  if (sel.has(s.n) && pickable(s, scope)) return 'picked';
  if (s.onLoad && scope !== 'open') return 'onload';
  return s.leftOff ? 'leftoff' : 'free';
}

/** A tap: picks a pickable stop, or takes it off again. Anything else is left as it is. */
export function toggleStop(sel, s, scope) {
  if (!pickable(s, scope)) return sel;
  const next = new Set(sel);
  if (next.has(s.n)) next.delete(s.n); else next.add(s.n);
  return next;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** A box from two corners, whichever way it was dragged; null when a corner is not a place. */
export function boxFrom(a, b) {
  if (!a || !b || ![a.lat, a.lng, b.lat, b.lng].every(fin)) return null;
  return { north: Math.max(a.lat, b.lat), south: Math.min(a.lat, b.lat), east: Math.max(a.lng, b.lng), west: Math.min(a.lng, b.lng) };
}

export function inBox(s, b) {
  return !!b && fin(s?.lat) && fin(s?.lng) && s.lat <= b.north && s.lat >= b.south && s.lng <= b.east && s.lng >= b.west;
}

/** Every pickable stop inside the box, added to the picks. `added` is how many were new. */
export function addInBox(sel, stops, b, scope) {
  const next = new Set(sel);
  let added = 0;
  for (const s of stops || []) if (inBox(s, b) && pickable(s, scope) && !next.has(s.n)) { next.add(s.n); added++; }
  return { next, added };
}

/**
 * The picks, held to the stops now offered: when the board is read again, or the scope or the earlier
 * section changes, a pick that is no longer offered comes off — and the caller says how many did.
 */
export function pruneSel(sel, stops, scope) {
  const ok = new Set((stops || []).filter((s) => pickable(s, scope)).map((s) => s.n));
  const next = new Set([...sel].filter((n) => ok.has(n)));
  return { next, dropped: sel.size - next.size };
}

/** What the picks add up to: stops, skid spots, pounds, and how many cannot go on a tractor. */
export function selTotals(stops, sel) {
  let n = 0, spots = 0, lbs = 0, noTractor = 0;
  for (const s of stops || []) {
    if (!sel.has(s.n)) continue;
    n++; spots += fin(s.spots) ? s.spots : 0; lbs += fin(s.lbs) ? s.lbs : 0; if (s.noTractor) noTractor++;
  }
  return { stops: n, spots: Math.round(spots * 10) / 10, lbs: Math.round(lbs), noTractor };
}

/** The frame that holds every stop; null when there is none to frame. */
export function boundsOf(stops) {
  let b = null;
  for (const s of stops || []) {
    if (!fin(s?.lat) || !fin(s?.lng)) continue;
    b = b ? { north: Math.max(b.north, s.lat), south: Math.min(b.south, s.lat), east: Math.max(b.east, s.lng), west: Math.min(b.west, s.lng) }
      : { north: s.lat, south: s.lat, east: s.lng, west: s.lng };
  }
  return b;
}

/** The stops as map features (one point each, keyed by stop number); the style is drawn from the picks. */
export function pickGeo(stops) {
  return {
    type: 'FeatureCollection',
    features: (stops || []).filter((s) => fin(s?.lat) && fin(s?.lng)).map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: { kind: 'pick', n: s.n, title: `${s.name || s.n}${s.city ? `, ${s.city}` : ''} · ${s.spots ?? '—'} spots · ${Number(s.lbs || 0).toLocaleString('en-US')} lb${s.onLoad ? ` · on ${s.onLoad} in NuVizz` : ''}${s.earlier ? ` · placed on ${s.earlier.route} by the earlier section` : ''}${s.leftOff ? ` · left off by an earlier section: ${s.leftOff}` : ''}` },
    })),
  };
}
