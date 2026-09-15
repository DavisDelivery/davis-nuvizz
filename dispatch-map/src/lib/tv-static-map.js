// tv-static-map.js — THE WALL DISPLAY'S MAP AS A PICTURE.
//
// PURE. No React, no Google Maps JS, no window, no fetch. Everything here is arithmetic over
// a list of points plus a character budget, so the whole thing runs in a test instead of
// being judged from a photograph of a television.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PICTURE AT ALL.
//
// The office TV is a 2020 Samsung TU8000. The Maps JavaScript API on it has been, in order:
// a white rectangle with a vector map, and still trouble after falling back to raster. Chad,
// after two rounds of it: "i'm thinking i like the idea of of making a static image".
//
// He is right, and the reason is stronger than the symptom. A wall display is the one screen
// in the building that CANNOT BE INTERACTED WITH — nobody pans it, nobody zooms it, nobody
// clicks a pin. Every single thing the JS map buys over an image is an interaction, and the
// price is a WebGL-capable, modern-JS browser sitting on a wall for twelve hours. An <img> is
// a picture: it draws on anything that can draw a picture, it cannot leak a canvas, it cannot
// half-initialise, and when it fails it fails in one obvious way instead of silently painting
// nothing. For a screen with no pointer that is not a downgrade, it is the right instrument.
//
// WHAT IT COSTS, SAID OUT LOUD because this repo counts calls: every refresh is one billed
// Maps Static API request. At the board's own 2-minute cadence over a 4am–2pm day that is
// ~300 requests a day, ~9,000 a month. See TV_STATIC_REFRESH_MS for the knob.
// ─────────────────────────────────────────────────────────────────────────────

/** Static Maps refuses URLs past 8192 characters. Budget under it, with room for the key. */
export const TV_STATIC_URL_BUDGET = 7800;

/** Google's tile size — the unit the zoom maths is expressed in. */
const TILE = 256;

/**
 * THE SWITCH, in the house shape (see attEnabled): default ON, an explicit off-word turns it
 * off, and ANYTHING MALFORMED LEAVES IT ON. A typo in an env var must never silently put the
 * wall back on the JS map that could not draw — that failure is invisible, and a TV showing
 * a white rectangle looks exactly like a TV that has not loaded yet.
 *
 * VITE_TV_STATIC_MAP=off (or 0 / false / no) puts the wall display back on the live JS map.
 */
export function tvStaticMapEnabled(env = {}) {
  const v = String(env.VITE_TV_STATIC_MAP ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** Mercator y, normalised to -π/2..π/2, clamped so a bad latitude cannot produce Infinity. */
function latRad(lat) {
  const sin = Math.sin((Number(lat) || 0) * Math.PI / 180);
  const rad = Math.log((1 + sin) / (1 - sin)) / 2;
  return Math.max(Math.min(rad, Math.PI), -Math.PI) / 2;
}

/**
 * IS THIS POINT REAL? And `Number(null)` IS 0, AND 0 IS FINITE — which is the trap CLAUDE.md
 * names by name, because it has already shipped once here (a customer-service email announcing
 * a midnight deadline for a stop that had no deadline at all).
 *
 * On THIS screen it lands differently and worse: a stop with no coordinates would pass a bare
 * isFinite check as (0, 0), which is in the Atlantic off west Africa. One of those in the list
 * drags the bounds across an ocean, and the fit maths dutifully zooms out until Georgia is a
 * speck — so a single stop missing a lat/lng empties the whole wall. Blanks are rejected
 * BEFORE any coercion, booleans are refused (Number(true) is 1), and the ranges are checked so
 * a garbage latitude cannot survive either.
 */
const usable = (p) => {
  if (!p) return false;
  const ok = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  if (!ok(p.lat) || !ok(p.lng)) return false;
  const la = Number(p.lat); const ln = Number(p.lng);
  return la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
};

/** PURE. The tightest box containing every usable point, or null when there are none. */
export function boundsOf(points) {
  const pts = (Array.isArray(points) ? points : []).filter(usable);
  if (!pts.length) return null;
  let n = -90, s = 90, e = -180, w = 180;
  for (const p of pts) {
    const la = Number(p.lat); const ln = Number(p.lng);
    if (la > n) n = la; if (la < s) s = la;
    if (ln > e) e = ln; if (ln < w) w = ln;
  }
  return { north: n, south: s, east: e, west: w };
}

/**
 * PURE. WHERE TO POINT THE CAMERA so every stop is in frame.
 *
 * The JS map did this itself with fitBounds; a picture has to be told. This is the standard
 * Mercator fit — the zoom at which the point span fills the image — floored, because a zoom
 * half a step too far cuts freight off the edge and nobody on a wall can pan it back.
 *
 * A SINGLE POINT IS NOT ZOOM 21. With one stop the span is zero and the maths goes to
 * infinity; that would frame a whole day's board on somebody's driveway. Capped at maxZoom.
 */
export function fitView(points, { width = 640, height = 416, maxZoom = 12, minZoom = 3 } = {}) {
  const b = boundsOf(points);
  if (!b) return null;
  const center = { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
  const latFraction = (latRad(b.north) - latRad(b.south)) / Math.PI;
  const lngDiff = b.east - b.west;
  const lngFraction = (lngDiff < 0 ? lngDiff + 360 : lngDiff) / 360;
  const zoomFor = (px, fraction) => (fraction <= 0 ? maxZoom : Math.floor(Math.log(px / TILE / fraction) / Math.LN2));
  const z = Math.min(zoomFor(height, latFraction), zoomFor(width, lngFraction), maxZoom);
  return { center, zoom: Math.max(minZoom, Number.isFinite(z) ? z : minZoom) };
}

/** 4 decimal places is ~11 metres — past what a 6px dot on a television can express, and it
 *  halves the characters each pin costs, which is what decides how many fit. */
const coord = (p) => `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`;

/**
 * THE DRAWING ORDER, WHICH IS ALSO THE SURVIVAL ORDER.
 *
 * A URL holds a few hundred pins and a bad day holds seven hundred stops, so something has to
 * be dropped — and WHICH is a logistics decision, not a technical one. Trucks first: where the
 * fleet is, is the thing a room looks up at. Then the stops somebody still has to save. Then
 * open freight. Delivered stops go last because they are the only ones on the board that
 * cannot generate another phone call.
 */
export const TV_MARKER_GROUPS = [
  { key: 'driver', color: '0x0f172a', size: 'small' },
  { key: 'flagged', color: '0xdc2626', size: 'small' },
  { key: 'open', color: '0x4285F4', size: 'tiny' },
  { key: 'done', color: '0x16a34a', size: 'tiny' },
];

/**
 * PURE. Fit as many pins as the budget allows, in that order, and REPORT WHAT DID NOT FIT.
 *
 * The count is returned rather than swallowed for the same reason the flag rail prints its
 * overflow: a map showing 400 of 700 stops, with nothing saying so, is a map that quietly
 * reports a lighter day than the one being worked.
 *
 * @param groups  {driver: point[], flagged: point[], open: point[], done: point[]}
 * @returns {{params: string[], shown: number, total: number}}
 */
export function packMarkers(groups = {}, budget = TV_STATIC_URL_BUDGET) {
  const cap = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : TV_STATIC_URL_BUDGET;
  const params = [];
  let used = 0;
  let shown = 0;
  let total = 0;
  for (const g of TV_MARKER_GROUPS) {
    const pts = (groups[g.key] || []).filter(usable);
    total += pts.length;
    if (!pts.length) continue;
    const prefix = `markers=color:${g.color}%7Csize:${g.size}`;
    const taken = [];
    let cost = prefix.length + 1; // the joining '&'
    for (const p of pts) {
      const piece = `%7C${coord(p)}`;
      if (used + cost + piece.length > cap) break;
      taken.push(piece);
      cost += piece.length;
    }
    if (taken.length) {
      params.push(prefix + taken.join(''));
      used += cost;
      shown += taken.length;
    }
  }
  return { params, shown, total };
}

/**
 * PURE. The whole image URL, or null when there is nothing to draw.
 *
 * `key` is the browser Maps key — the same one already in this bundle for the JS map, so this
 * exposes nothing new. NOTE FOR WHOEVER DEBUGS A BROKEN IMAGE: the Static Maps API is a
 * SEPARATE API in the Google console. A key restricted to "Maps JavaScript API" will answer
 * this with a 403 and the wall will show a broken picture, which is why the caller reports the
 * image's own load failure rather than leaving an empty frame.
 */
export function buildTvStaticMapUrl({ groups = {}, width = 640, height = 416, scale = 2, key = '', maxZoom = 12, budget = TV_STATIC_URL_BUDGET } = {}) {
  const all = TV_MARKER_GROUPS.flatMap((g) => (groups[g.key] || []).filter(usable));
  const view = fitView(all, { width, height, maxZoom });
  if (!view || !key) return null;
  const base = [
    `center=${view.center.lat.toFixed(4)},${view.center.lng.toFixed(4)}`,
    `zoom=${view.zoom}`,
    `size=${Math.round(width)}x${Math.round(height)}`,
    `scale=${scale}`,
    'maptype=roadmap',
  ];
  const head = `https://maps.googleapis.com/maps/api/staticmap?${base.join('&')}`;
  // The key rides at the END so the marker budget is measured against what is already spent.
  const tail = `&key=${encodeURIComponent(key)}`;
  const { params, shown, total } = packMarkers(groups, Math.max(0, budget - head.length - tail.length));
  return {
    url: `${head}${params.length ? '&' + params.join('&') : ''}${tail}`,
    shown,
    total,
    zoom: view.zoom,
    center: view.center,
  };
}
