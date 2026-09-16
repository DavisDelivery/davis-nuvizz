// tv-static-map.js — THE WALL DISPLAY'S BASEMAP, AND WHERE EVERY PIN LANDS ON IT.
//
// PURE. No React, no Google Maps JS, no window, no fetch. Everything here is arithmetic over
// a list of points plus a pane size, so the whole thing runs in a test instead of being
// judged from a photograph of a television.
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
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE PICTURE NO LONGER CARRIES THE PINS.
//
// Chad, looking at the first cut: "map doesn't look like it should i want the thing to be
// identical with all the same icons."
//
// The first cut asked Google to draw the stops too, with `markers=` in the URL. That is the
// obvious way and it is wrong on this screen for three separate reasons, each fatal on its
// own:
//
//   1. IT IS NOT THE SAME BOARD. Static Maps draws teardrops in one of a handful of colours.
//      This app's pins carry the whole morning on them — the AM/PM window, the ✓, the ➜, the
//      restriction clock, the no-tractor truck, the Estes yellow ring, the co-located count,
//      the "?" flag. A wall showing plain coloured dots is a DIFFERENT map of the same day,
//      and a room reading two different maps is worse than a room reading one.
//   2. IT COULD NOT FIT THE DAY. A Static Maps URL dies past 8192 characters — about 400 pins
//      — and a bad day here is seven hundred stops. The picture had to drop freight and print
//      "showing 401 of 640 pins" to stay honest about it.
//   3. IT BILLED FOR THE WRONG THING. With the pins in the URL, every pin that moved bought a
//      new image. Without them the URL holds a centre, a zoom and a size, so the picture is
//      re-fetched when the CAMERA moves and not when the board does — a handful of requests a
//      day instead of one every couple of minutes.
//
// So Google draws the ROADS and this app draws the FREIGHT, positioned over it by the maths
// below. The pins are the very same stopMarkerIcon artwork the desktop board paints, at the
// same sizes, with nothing dropped.
//
// THE SPEND, SAID OUT LOUD because this repo counts calls: one billed Maps Static API request
// per distinct URL. The URL changes only when the snapped bounds move the centre or the zoom
// (see TV_BOUNDS_SNAP_DEG) or when the pane is resized — not on the board's 2-minute refresh.
// ─────────────────────────────────────────────────────────────────────────────

/** Google's tile size — the unit the zoom maths is expressed in. */
const TILE = 256;

/**
 * The Maps Static API's ceiling for `size`. `scale=2` doubles the PIXELS returned without
 * changing the geographic extent (or the price), which is why the extent maths below is all
 * in these 640-ish units and never in the pixels the television actually lights up.
 */
export const TV_IMAGE_MAX = 640;

/**
 * Keep-out margin at the frame edge, in ON-SCREEN pixels, so a pin sitting exactly on the
 * bounding box is not sliced in half by the edge of the pane. The widest icon this board
 * draws is 30px anchored at its centre, so 30 clears the worst case with room to spare.
 */
export const TV_PIN_PAD_PX = 30;

/**
 * HOW COARSELY THE CAMERA IS ALLOWED TO MOVE, in degrees (~2.2 km).
 *
 * This is a BILLING rule wearing a geometry hat. The fit includes the trucks, and a truck is
 * a thing that moves: fitted exactly, a driver rolling 30 feet would shift the centre in the
 * fourth decimal place, mint a new URL and buy another image — on every driver poll, all day.
 * Snapping the bounds OUTWARD to a grid means an ordinary morning produces the same handful
 * of URLs over and over, and the camera only steps when the board genuinely spreads.
 *
 * OUTWARD, never inward: rounding a boundary the wrong way would push the freight that
 * defined it off the edge of the frame.
 */
export const TV_BOUNDS_SNAP_DEG = 0.02;

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
 * PURE. Round a box OUTWARD onto a grid, so a truck creeping along cannot re-buy the picture.
 * See TV_BOUNDS_SNAP_DEG. A step of 0 (or anything malformed) returns the box untouched —
 * a bad constant must not silently start clipping the board.
 */
export function snapBounds(b, step = TV_BOUNDS_SNAP_DEG) {
  if (!b) return null;
  const q = Number(step);
  if (!Number.isFinite(q) || q <= 0) return b;
  // A COORDINATE ALREADY ON THE GRID MUST NOT JUMP A WHOLE CELL. 34.30 / 0.02 is
  // 1715.0000000000002 in IEEE doubles, and a bare Math.ceil on that answers 1716 — the box
  // silently grows 2.2 km on a boundary that was already exact. That is not a rounding
  // curiosity here: the snap exists to keep the URL STILL, and a fit that lands on the grid
  // (which a snapped board does constantly) would flap between two cells and buy a picture
  // each time. Nine places is far finer than any coordinate this board carries and far
  // coarser than the noise.
  const cell = (v) => Number((Number(v) / q).toFixed(9));
  const out = {
    north: Math.min(90, Math.ceil(cell(b.north)) * q),
    south: Math.max(-90, Math.floor(cell(b.south)) * q),
    east: Math.min(180, Math.ceil(cell(b.east)) * q),
    west: Math.max(-180, Math.floor(cell(b.west)) * q),
  };
  // Multiplying back lands on 33.980000000000004; six places is ~0.1 m — past anything the
  // URL carries (it prints four) — so the noise is trimmed here rather than reaching the key.
  for (const k of ['north', 'south', 'east', 'west']) out[k] = Number(out[k].toFixed(6));
  return out;
}

/**
 * PURE. THE IMAGE TO ASK FOR, IN THE PANE'S OWN SHAPE.
 *
 * Chad: "i don't liek the black space on either end of the map we aren't using the full frame
 * there are black bars on either side of the map."
 *
 * He is describing letterboxing, and the cause was in the source as a COMMENT: the URL asked
 * for a fixed 640x416 because that was "the ratio of the map pane beside the flag rail
 * (~1520x990)". That tilde is the whole bug. The pane is whatever the television's browser
 * says it is, the picture was whatever we had guessed months earlier, and the difference came
 * out as dead space down both sides — this repo's own rule about guessing, rendered in black.
 *
 * So the ratio is MEASURED and the image is requested in it. The long side goes to the API's
 * 640 ceiling and the short side follows, which makes letterboxing impossible by construction
 * rather than by arithmetic that has to stay right.
 */
export function tvImageSize(paneWidth, paneHeight, max = TV_IMAGE_MAX) {
  const w = Number(paneWidth); const h = Number(paneHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : TV_IMAGE_MAX;
  if (w >= h) {
    return { width: cap, height: Math.max(1, Math.min(cap, Math.round(cap * h / w))) };
  }
  return { width: Math.max(1, Math.min(cap, Math.round(cap * w / h))), height: cap };
}

/**
 * PURE. WHERE TO POINT THE CAMERA so every stop is in frame.
 *
 * The JS map did this itself with fitBounds; a picture has to be told. This is the standard
 * Mercator fit — the zoom at which the point span fills the image — floored, because a zoom
 * half a step too far cuts freight off the edge and nobody on a wall can pan it back.
 *
 * `padPx` is IMAGE-space keep-out at the edge (see TV_PIN_PAD_PX for the on-screen figure and
 * buildTvStaticMapUrl for the conversion). Without it a pin on the bounding box lands exactly
 * on the frame edge and loses half its artwork to the crop.
 *
 * A SINGLE POINT IS NOT ZOOM 21. With one stop the span is zero and the maths goes to
 * infinity; that would frame a whole day's board on somebody's driveway. Capped at maxZoom.
 */
export function fitView(points, { width = 640, height = 416, maxZoom = 12, minZoom = 3, padPx = 0, snapDeg = TV_BOUNDS_SNAP_DEG } = {}) {
  const raw = boundsOf(points);
  if (!raw) return null;
  const b = snapBounds(raw, snapDeg);
  const center = { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
  // Never let the keep-out eat the whole frame: a pane narrower than two margins would give a
  // zero or negative usable span, and log(negative) is NaN — which fitView must not return.
  const pad = Number.isFinite(Number(padPx)) && Number(padPx) > 0 ? Number(padPx) : 0;
  const usableW = Math.max(1, width - 2 * Math.min(pad, (width - 1) / 2));
  const usableH = Math.max(1, height - 2 * Math.min(pad, (height - 1) / 2));
  const latFraction = (latRad(b.north) - latRad(b.south)) / Math.PI;
  const lngDiff = b.east - b.west;
  const lngFraction = (lngDiff < 0 ? lngDiff + 360 : lngDiff) / 360;
  const zoomFor = (px, fraction) => (fraction <= 0 ? maxZoom : Math.floor(Math.log(px / TILE / fraction) / Math.LN2));
  const z = Math.min(zoomFor(usableH, latFraction), zoomFor(usableW, lngFraction), maxZoom);
  return { center, zoom: Math.max(minZoom, Number.isFinite(z) ? z : minZoom), width, height };
}

/**
 * PURE. WHERE A STOP LANDS ON THE PICTURE, in image pixels from its top-left corner.
 *
 * This is the other half of drawing our own pins: Google has been told a centre, a zoom and a
 * size, and this is the same Web Mercator arithmetic run forwards so the app can put its own
 * artwork exactly where Google would have put a dot. Get this wrong by a few pixels and every
 * stop on the wall is quietly in the wrong place, which is the worst failure available on a
 * map — it still looks like a map.
 *
 * Returns null for a point the frame cannot express, never a NaN: an un-positioned stop is a
 * stop that is not drawn, not a pin in the top-left corner.
 */
export function projectToPixel(point, view) {
  if (!usable(point) || !view || !usable(view.center)) return null;
  const zoom = Number(view.zoom);
  const width = Number(view.width);
  const height = Number(view.height);
  if (!Number.isFinite(zoom) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const world = TILE * Math.pow(2, zoom);
  // The shortest way round. Atlanta freight will never need this, but a wrapped longitude
  // would otherwise project a stop a whole world away instead of declining to draw it.
  let dLng = Number(point.lng) - Number(view.center.lng);
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const x = width / 2 + world * (dLng / 360);
  const y = height / 2 - world * ((latRad(point.lat) - latRad(view.center.lat)) / Math.PI);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * PURE. The same position as a PERCENTAGE of the frame, which is what the overlay is styled
 * in — the picture is stretched to whatever the pane is, so a pin pinned in per-cent stays on
 * its building through a resize while a pin pinned in pixels does not.
 *
 * `marginPx` culls what is off-frame (image space). A pin outside the picture is not clipped
 * quietly, it is never rendered: seven hundred invisible DOM nodes on a 2020 television is a
 * cost with nothing bought for it.
 */
export function projectToPercent(point, view, marginPx = TV_IMAGE_MAX) {
  const at = projectToPixel(point, view);
  if (!at) return null;
  const m = Number.isFinite(Number(marginPx)) ? Number(marginPx) : 0;
  if (at.x < -m || at.y < -m || at.x > Number(view.width) + m || at.y > Number(view.height) + m) return null;
  return { left: (at.x / Number(view.width)) * 100, top: (at.y / Number(view.height)) * 100 };
}

/**
 * PURE. The basemap URL plus the view its pins must be projected through, or null when there
 * is nothing to draw (no points, no key, or a pane nobody has measured yet).
 *
 * `key` is the browser Maps key — the same one already in this bundle for the JS map, so this
 * exposes nothing new. NOTE FOR WHOEVER DEBUGS A BROKEN IMAGE: the Static Maps API is a
 * SEPARATE API in the Google console. A key restricted to "Maps JavaScript API" will answer
 * this with a 403 and the wall will show a broken picture, which is why the caller reports the
 * image's own load failure rather than leaving an empty frame.
 *
 * THE VIEW COMES BACK WITH THE URL ON PURPOSE. The camera the picture was drawn with and the
 * camera the pins are placed with must be the SAME object, or the two drift apart and nothing
 * on screen says so. One return value, one camera.
 */
export function buildTvStaticMapUrl({
  points = [],
  paneWidth = 0,
  paneHeight = 0,
  scale = 2,
  key = '',
  maxZoom = 12,
  padPx = TV_PIN_PAD_PX,
  snapDeg = TV_BOUNDS_SNAP_DEG,
} = {}) {
  const size = tvImageSize(paneWidth, paneHeight);
  if (!size || !key) return null;
  // The keep-out is quoted in ON-SCREEN pixels because that is where the icons are drawn, and
  // the picture is a smaller frame stretched over the pane — so it converts before it is used.
  const shrink = size.width / Number(paneWidth);
  const view = fitView(points, {
    width: size.width, height: size.height, maxZoom, padPx: padPx * shrink, snapDeg,
  });
  if (!view) return null;
  const base = [
    `center=${view.center.lat.toFixed(4)},${view.center.lng.toFixed(4)}`,
    `zoom=${view.zoom}`,
    `size=${size.width}x${size.height}`,
    `scale=${scale}`,
    'maptype=roadmap',
  ];
  return {
    url: `https://maps.googleapis.com/maps/api/staticmap?${base.join('&')}&key=${encodeURIComponent(key)}`,
    view,
    width: size.width,
    height: size.height,
    zoom: view.zoom,
    center: view.center,
  };
}
