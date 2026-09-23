// src/lib/map-3d.js
//
// HOLD CTRL AND SEE THE BUILDING — the photorealistic 3D look, on the dispatch Map.
//
// Chad, Sep 16, with a screenshot of consumer Google Maps tilted over a produce terminal:
// "I want exactly what I showed you where I can be on map hold control and see map in 3d
// view like I showed you so I can see if buildings have docks."
//
// THE ONE THING THAT COULD NOT BE DONE THE OBVIOUS WAY. That picture is Google's
// PHOTOREALISTIC 3D, and `google.maps.Map` — the map this whole app is built on — cannot
// render it at any tilt, on any base, with any option. It is a different element
// (`google.maps.maps3d.Map3DElement`, library `maps3d`) with its own camera and its own
// drawing classes. So Ctrl does not "turn the map 3D"; it brings a second map up over the
// first, pointed at the same spot. That is an implementation detail of the vendor's, not a
// change to what was asked for, and the dispatcher never sees the seam.
//
// WHAT THE OLD CTRL DID, AND WHY LOSING IT IS THE POINT. Ctrl+drag already tilted the
// vector map — but a tilted vector map draws GREY EXTRUDED BLOCKS, not photographs, and a
// grey block has no dock doors on it. That gesture is what this replaces, which makes this
// a change to behaviour that already worked, which is why it ships behind a named switch
// (VITE_MAP_3D=off puts the old Ctrl+drag tilt back, every side at once).
//
// THE SPEND, SAID OUT LOUD because this repo counts calls. A 3D map load bills Google's
// IMMERSIVE MAPS SKU (5,000 free/month, then $7.00/1,000) — a different, smaller-tiered
// meter than the DYNAMIC MAPS SKU the board runs on (10,000 free). Google's SKU page is
// explicit that "user interactions with the map don't generate additional map loads,
// including panning, zooming, or switching map layers", so the cost is per ELEMENT CREATED,
// not per look. The caller therefore builds ONE Map3DElement per page session, lazily on
// the first Ctrl, and afterwards only moves its camera and shows/hides it. A dispatcher who
// holds Ctrl two hundred times in a morning costs one load, not two hundred.
//
// NOT VERIFIED, AND SAID RATHER THAN ASSUMED: whether a PROGRAMMATIC camera move re-bills.
// Google documents the free case as "user interactions". Re-using one element is the
// cheapest shape available either way, so nothing here depends on the answer — but if the
// Immersive Maps line on the bill ever reads higher than one-per-session, that is where to
// look first.
//
// PURE → unit-tested in test/map-3d.test.mjs. The element, the DOM and the key handler live
// in the caller; nothing in this file touches Google or the document.

/** Camera pitch, degrees from straight down. 67.5 is Google's own oblique sample, and it is
 *  the angle that puts a dock door on the SIDE of a building in frame rather than its roof. */
export const MAP3D_TILT = 67.5;

/** Map3DElement's default vertical field of view, degrees. Documented on the element; the
 *  range maths below is derived from it, so the two must not drift apart. */
export const MAP3D_FOV = 35;

/** Camera distance floor, metres. Below this the camera starts clipping into the mesh it is
 *  supposed to be showing. */
export const MAP3D_MIN_RANGE = 150;

/**
 * Camera distance ceiling, metres.
 *
 * THIS IS A LOGISTICS DECISION, NOT A MATHS ONE, and it is the one number here most likely
 * to want changing. Matching the 2D view honestly is what the maths below does — but a
 * dispatcher holding Ctrl while looking at the whole metro would get a camera 363 KILOMETRES
 * up, which is a photograph of Georgia from orbit and answers nothing about a dock. The
 * question Ctrl is being asked is always "what does THIS building look like", so the camera
 * comes down to a height where a building is a building. The CENTRE never moves — you land
 * on the spot you were looking at, closer — so this is not a teleport, it is a floor under
 * usefulness. 4,000m frames roughly 2.5km of ground: a whole industrial park, with the
 * individual units still readable.
 */
export const MAP3D_MAX_RANGE = 4000;

/** Below this range the mesh is detailed enough to read a dock door; above it the view is
 *  for FINDING the building, and the overlay says so rather than letting a dispatcher
 *  conclude the imagery is broken. */
export const MAP3D_DETAIL_RANGE = 1200;

/** Metres per pixel at zoom 0 on the equator (Web Mercator, 256px tiles). */
const EQUATOR_METERS_PER_PIXEL = 156543.03392804097;

/**
 * THE SWITCH. House shape (CLAUDE.md): default ON, an explicit off-word turns it off, and
 * anything malformed leaves it ON — a typo in an env var must never silently disable a
 * feature, because a quiet feature looks exactly like a working one.
 *
 * VITE_MAP_3D=off restores the old behaviour on every side at once: no key handler, no
 * button, no element ever created, and Ctrl+drag goes back to tilting the vector map.
 */
export function map3dEnabled(env = {}) {
  const v = String(env.VITE_MAP_3D ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/**
 * Is this a real coordinate?
 *
 * `Number(null)` IS 0 AND 0 IS FINITE — the trap CLAUDE.md names by name, and on a map it
 * lands as a camera flown to the Atlantic off west Africa. Blanks are rejected BEFORE any
 * coercion, booleans are refused (`Number(true)` is 1), and both ranges are checked so a
 * garbage latitude cannot survive either.
 */
export function isRealPoint(lat, lng) {
  if (lat === null || lat === undefined || lat === '' || typeof lat === 'boolean') return false;
  if (lng === null || lng === undefined || lng === '' || typeof lng === 'boolean') return false;
  const a = Number(lat); const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a >= -90 && a <= 90 && b >= -180 && b <= 180;
}

/**
 * Ground metres per screen pixel at a given Web Mercator zoom and latitude.
 *
 * THE BLANK CHECK IS NOT BELT-AND-BRACES, AND THIS FILE'S OWN TEST CAUGHT IT MISSING.
 * `Number(null)` is 0 — and unlike a latitude, ZOOM 0 IS A PERFECTLY VALID VALUE (the whole
 * world). So a dead map handing back `getZoom() === undefined` sailed through a bare
 * isFinite check as "zoomed all the way out" and opened a 3D view at the ceiling range,
 * instead of declining to open one at all. A map that cannot say where it is must not get a
 * confident picture drawn from the answer it did not give.
 */
export function metersPerPixel(zoom, lat) {
  if (zoom === null || zoom === undefined || zoom === '' || typeof zoom === 'boolean') return null;
  if (lat === null || lat === undefined || lat === '' || typeof lat === 'boolean') return null;
  const z = Number(zoom);
  const phi = Number(lat);
  if (!Number.isFinite(z) || !Number.isFinite(phi)) return null;
  return EQUATOR_METERS_PER_PIXEL * Math.cos(phi * Math.PI / 180) / Math.pow(2, z);
}

/**
 * How far back the 3D camera has to sit to frame what the 2D map was framing.
 *
 * A camera `range` metres from its centre with vertical field of view `fov` sees
 * `2 · range · tan(fov/2)` metres across at that distance. Set that equal to the ground
 * height the 2D viewport was showing and solve for range. Exact at tilt 0 and a good
 * approximation at oblique tilt, where the ground foreshortens along the view direction —
 * it is aimed at landing in the right neighbourhood, not at matching pixel for pixel.
 *
 * Clamped to [MAP3D_MIN_RANGE, MAP3D_MAX_RANGE]; see MAP3D_MAX_RANGE for why the ceiling is
 * an operational call rather than a mathematical one.
 */
export function rangeForView({ zoom, lat, heightPx, fovDeg = MAP3D_FOV } = {}) {
  const mpp = metersPerPixel(zoom, lat);
  const h = Number(heightPx);
  const fov = Number(fovDeg);
  if (mpp === null || !Number.isFinite(h) || h <= 0 || !Number.isFinite(fov) || fov <= 0 || fov >= 180) return null;
  const groundHeight = mpp * h;
  const raw = groundHeight / (2 * Math.tan(fov * Math.PI / 360));
  if (!Number.isFinite(raw)) return null;
  return Math.min(MAP3D_MAX_RANGE, Math.max(MAP3D_MIN_RANGE, raw));
}

/**
 * The whole 3D camera, from whatever the 2D map is currently showing.
 *
 * HEADING CARRIES OVER so north stays where the dispatcher left it — arriving in 3D spun to
 * a heading nobody chose is how a familiar yard stops being recognisable.
 *
 * Returns null when the 2D view cannot be read (a dead map, a missing centre). A null here
 * means the caller does NOT open 3D, which is the honest outcome: a camera flown to a made-up
 * default is worse than a gesture that did nothing, because the dispatcher would believe the
 * picture.
 */
export function cameraFor2dView({ center, zoom, heading = 0, heightPx, satellite = true } = {}) {
  const lat = center ? center.lat : null;
  const lng = center ? center.lng : null;
  if (!isRealPoint(lat, lng)) return null;
  const range = rangeForView({ zoom, lat: Number(lat), heightPx });
  if (range === null) return null;
  const h = Number(heading);
  return {
    center: { lat: Number(lat), lng: Number(lng), altitude: 0 },
    range,
    tilt: MAP3D_TILT,
    heading: Number.isFinite(h) ? ((h % 360) + 360) % 360 : 0,
    mode: map3dMode(satellite),
    // The caller prints this; see MAP3D_DETAIL_RANGE. A view that cannot answer the dock
    // question should say so rather than let the imagery take the blame.
    detailed: range <= MAP3D_DETAIL_RANGE,
  };
}

/**
 * HYBRID, always — and that is a dispatch decision rather than a default.
 *
 * SATELLITE mode is the same photographs with no street labels on them. Over an industrial
 * park of near-identical tilt-wall units, the street name IS how you confirm you are looking
 * at the right building before you judge its doors, so the labels earn their clutter. The
 * argument holds whichever way the board's own satellite toggle is set, which is why that
 * toggle is taken as input and deliberately does not change the answer yet — the parameter
 * is here so a future "plain imagery" option has somewhere to live, and the test pins the
 * current behaviour so nobody changes it by accident.
 */
export function map3dMode() {
  return 'HYBRID';
}

/** Brand blue for the lit state — matched to the satellite control it stacks beside. */
export const MAP3D_ON_BG = '#1e5b92';
export const MAP3D_OFF_BG = '#ffffff';
export const MAP3D_ON_STROKE = '#ffffff';
export const MAP3D_OFF_STROKE = '#5f6368';

/**
 * PURE. Everything the on-map 3D button should render and announce.
 *
 * TWO VIEWS, AND THE BUTTON IS WHY THERE IS ONE AT ALL. Ctrl-hold is a keyboard gesture and
 * a phone has no Ctrl key, so a Ctrl-only feature is a feature that does not exist on mobile
 * — which this repo has shipped twice and CLAUDE.md names by name. The button is the mobile
 * half, and it stays on desktop too because an invisible gesture nobody is told about is a
 * feature nobody finds.
 *
 * The label says WHICH WAY IT WILL GO, not merely where it is — same rule as the satellite
 * control beside it.
 */
export function control3dSpec(on) {
  const lit = !!on;
  return {
    on: lit,
    label: lit ? '3D view on — back to the flat map' : '3D view off — see the buildings (or Ctrl+drag the map)',
    ariaPressed: lit ? 'true' : 'false',
    background: lit ? MAP3D_ON_BG : MAP3D_OFF_BG,
    stroke: lit ? MAP3D_ON_STROKE : MAP3D_OFF_STROKE,
    svg: cube3dSvg(lit ? MAP3D_ON_STROKE : MAP3D_OFF_STROKE),
  };
}

/** A box seen in perspective — the mark for "this is a building, from the side". */
export function cube3dSvg(stroke) {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 12l9-5"/><path d="M12 12v10"/><path d="M12 12L3 7"/></svg>`;
}

/** Paint an existing DOM button from the spec. Split from creation for the same reason the
 *  satellite control splits them: Google keeps the element for the life of the map, so the
 *  create path and the update path must apply an identical treatment. Tolerates null. */
export function paint3dControl(el, on) {
  if (!el) return null;
  const spec = control3dSpec(on);
  el.title = spec.label;
  el.setAttribute('aria-label', spec.label);
  el.setAttribute('aria-pressed', spec.ariaPressed);
  el.style.background = spec.background;
  el.innerHTML = spec.svg;
  return spec;
}

/** Matches the Recenter crosshair and satellite button it stacks with (Google's own control
 *  styling: 40px, 2px radius, the same shadow). */
export const MAP3D_BUTTON_CSS = 'border:none;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,0.3);width:40px;height:40px;margin:0 10px 10px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;';

/**
 * HOW YOU GET INTO 3D, AND WHY IT IS A DRAG NOW RATHER THAN A HOLD.
 *
 * Chad, 2026-09-23: "It is kind of working but not like it does when you are on google maps
 * and you put it in globe view and use the 3d view there … make mine work like that."
 *
 * In Google Maps, 3D is a MODE you stay in, and Ctrl+drag is how you tilt INTO it and turn
 * around once there. v1.38.0 made it a PEEK instead — open on Ctrl, gone the instant Ctrl was
 * released — and that is exactly why it did not feel like Google Maps: Ctrl is also the key
 * the 3D map reads for rotate and tilt, so the gesture that opened the view fought the
 * gesture that uses it.
 *
 * Once it is a mode, a BARE Ctrl cannot be the way in any more. Ctrl is the first key of
 * Ctrl+C, Ctrl+F and Ctrl+R — a dispatcher copying a PRO off the board would be thrown into
 * a full-screen 3D view and LEFT there, with an Immersive Maps load billed for it. As a peek
 * that was a flicker; as a mode it is a trap. So the way in is Google's own: hold Ctrl (or
 * ⌘) and DRAG the map. It is the same physical motion that tilts the board today — it just
 * lands on the photographs now instead of grey blocks.
 *
 * A DRAG, NOT A PRESS: the threshold means a Ctrl+CLICK is never taken. Nothing in this app
 * uses one today (checked: no ctrlKey/metaKey anywhere in src/), and the listener never
 * swallows an event either way — it only watches, so a click reaches whatever wants it.
 */
export const DRAG_THRESHOLD_PX = 6;

/** Is this pointer-down the start of a Ctrl+drag? Primary button only — a right-button drag
 *  is Google's own rotate on the 2D map and is not ours to take. Shift or Alt alongside is a
 *  different chord and is left alone. */
export function isCtrlDragStart(ev = {}) {
  if (ev.button !== undefined && ev.button !== 0) return false;
  if (ev.altKey || ev.shiftKey) return false;
  return !!(ev.ctrlKey || ev.metaKey);
}

/** Has a pointer moved far enough from where it went down to count as a drag? */
export function dragCrossedThreshold(start, now, px = DRAG_THRESHOLD_PX) {
  if (!start || !now) return false;
  const dx = Number(now.x) - Number(start.x);
  const dy = Number(now.y) - Number(start.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.hypot(dx, dy) >= px;
}

/** Escape leaves 3D. Once a view outlives the key that opened it, there has to be a key
 *  that closes it, and Escape is the one every dispatcher already tries first. */
export function isEscape(ev = {}) {
  return ev.key === 'Escape' || ev.key === 'Esc';
}

/**
 * Read a lat/lng off whatever Google hands back. LatLng exposes lat()/lng() METHODS;
 * LatLngAltitude and literals expose plain numbers. Reading the wrong shape gives a function
 * where a number should be, and `Number(fn)` is NaN — a camera handoff built on that would
 * fly the board to nowhere. Null when it cannot be read honestly.
 */
export function readLatLng(v) {
  if (!v) return null;
  let lat; let lng;
  try {
    lat = typeof v.lat === 'function' ? v.lat() : v.lat;
    lng = typeof v.lng === 'function' ? v.lng() : v.lng;
  } catch { return null; }
  return isRealPoint(lat, lng) ? { lat: Number(lat), lng: Number(lng) } : null;
}

/** Zoom bounds for the handoff back to the flat map — the dispatch board's own useful range. */
export const HANDOFF_MIN_ZOOM = 3;
export const HANDOFF_MAX_ZOOM = 21;

/**
 * The inverse of rangeForView: what 2D zoom frames what a 3D camera `range` metres back is
 * framing. Solved from the same two relations, so a round trip lands where it started (the
 * test proves it). Deliberately NOT clamped to MAP3D_MAX_RANGE — that ceiling is about where
 * a camera is dropped on the way IN; on the way OUT the dispatcher's own zoom-out is honoured.
 */
export function zoomForRange({ range, lat, heightPx, fovDeg = MAP3D_FOV } = {}) {
  if (range === null || range === undefined || range === '' || typeof range === 'boolean') return null;
  if (lat === null || lat === undefined || lat === '' || typeof lat === 'boolean') return null;
  const r = Number(range); const phi = Number(lat); const h = Number(heightPx); const fov = Number(fovDeg);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(phi) || !Number.isFinite(h) || h <= 0) return null;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) return null;
  const groundHeight = r * 2 * Math.tan(fov * Math.PI / 360);
  const mpp = groundHeight / h;
  const z = Math.log2(EQUATOR_METERS_PER_PIXEL * Math.cos(phi * Math.PI / 180) / mpp);
  if (!Number.isFinite(z)) return null;
  return Math.min(HANDOFF_MAX_ZOOM, Math.max(HANDOFF_MIN_ZOOM, z));
}

/** How far the 3D camera has to move before leaving 3D moves the board. */
export const HANDOFF_MIN_METRES = 25;
export const HANDOFF_MIN_RANGE_RATIO = 0.1;
export const HANDOFF_MIN_HEADING_DEG = 3;

/** Metres between two points — equirectangular, which is exact enough at yard scale. */
export function metresBetween(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371008.8;
  const x = (b.lng - a.lng) * Math.PI / 180 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const y = (b.lat - a.lat) * Math.PI / 180;
  return Math.hypot(x, y) * R;
}

/**
 * DID THE DISPATCHER GO ANYWHERE IN 3D?
 *
 * THE LOGISTICS CALL THIS ENCODES: Google Maps keeps you where you flew when you drop back to
 * 2D, and that is right for somebody who orbited round to the back of a building to find the
 * dock. But the ENTRY camera is clamped (see MAP3D_MAX_RANGE), so somebody who opened 3D over
 * the whole metro and left without touching anything would otherwise come back zoomed in to
 * building height — their board rearranged by a look. So the board only follows a camera the
 * dispatcher actually MOVED; a look-and-leave returns them to exactly the board they left.
 */
export function cameraMoved(entry, now) {
  if (!entry || !now) return false;
  const a = readLatLng(entry.center); const b = readLatLng(now.center);
  if (!a || !b) return false;
  if (metresBetween(a, b) >= HANDOFF_MIN_METRES) return true;
  const r0 = Number(entry.range); const r1 = Number(now.range);
  if (Number.isFinite(r0) && Number.isFinite(r1) && r0 > 0 && Math.abs(r1 - r0) / r0 >= HANDOFF_MIN_RANGE_RATIO) return true;
  const h0 = Number(entry.heading); const h1 = Number(now.heading);
  if (Number.isFinite(h0) && Number.isFinite(h1)) {
    const d = Math.abs((((h1 - h0) % 360) + 540) % 360 - 180);
    if (d >= HANDOFF_MIN_HEADING_DEG) return true;
  }
  return false;
}

/**
 * The flat-map view to land on after a 3D flight: centre, zoom and heading, FLAT. Tilt is not
 * carried back, and on purpose — a tilted vector map is the grey-block view Chad did not want,
 * and Google Maps drops back to flat too. Null when the 3D camera cannot be read, in which
 * case the board is left exactly where it was rather than moved to a guess.
 */
export function twoDViewFor3dCamera({ center, range, heading, heightPx } = {}) {
  const c = readLatLng(center);
  if (!c) return null;
  const zoom = zoomForRange({ range, lat: c.lat, heightPx });
  if (zoom === null) return null;
  const h = Number(heading);
  return { center: c, zoom, heading: Number.isFinite(h) ? ((h % 360) + 360) % 360 : 0 };
}

/**
 * CAN THIS BROWSER DRIVE A 3D MAP AT ALL?
 *
 * WHY THIS EXISTS, AND IT IS NOT HYPOTHETICAL — it was watched happening. Driving the real
 * deploy preview in a headless browser, Ctrl opened the layer correctly and Google rendered
 * its own "Oops! Something went wrong" card inside it, with NO failed request and NO
 * exception for the catch below to report: the key answered everything, and the renderer was
 * software (SwiftShader). The ordinary vector map fell back to raster in the same run for the
 * same reason.
 *
 * That failure arrives THROUGH a successful importLibrary and a successful construction, so
 * the error path cannot see it — and what the dispatcher gets is a generic card that blames
 * nothing and suggests nothing. This repo has been here twice already: a WebGL-less browser
 * painting silence is exactly the white rectangle v1.31.4 had to turn into a sentence.
 *
 * So the check happens BEFORE the element is built, which also means a browser that cannot
 * show it is never billed for one. Returns true when it cannot tell — refusing to open on a
 * false negative would be worse than letting Google try.
 */
export function webglUsable(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    const doc = win && win.document;
    if (!doc || typeof doc.createElement !== 'function') return true; // cannot tell — let it try
    const c = doc.createElement('canvas');
    if (!c || typeof c.getContext !== 'function') return true;
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    return !!gl;
  } catch {
    return true; // cannot tell — let Google try rather than refusing on a guess
  }
}

/** What to say when the browser itself is the reason. Names the cause, because "Oops" names
 *  nothing and sends the next person looking in the wrong place. */
export const MAP3D_NO_WEBGL =
  'This browser cannot draw a 3D map — it has no working WebGL. The flat map still works.';

/**
 * THE SHARPER SIGNAL, and the one that actually matches the failure that was WATCHED.
 *
 * webglUsable() above only catches a browser with NO WebGL context at all. The preview run
 * that produced Google's blank "Oops" card had a context — a SOFTWARE one (SwiftShader) —
 * so that check would have passed it straight through, and saying otherwise would have been
 * a fix claimed for a bug it does not cover.
 *
 * What DID name it, in Google's own words, was the console line "Attempted to load a Vector
 * Map, but failed. Falling back to Raster." That state is readable: `map.getRenderingType()`
 * returns RASTER on a map we asked to be VECTOR. A browser that cannot drive the 2D vector
 * renderer will not drive a 3D one either, so this is the cheapest reliable proof available
 * before anything is built or billed.
 *
 * THE FALSE POSITIVE THIS MUST NOT HAVE: "Hide place labels" DELIBERATELY drops the mapId to
 * make Google honour a style, which makes the map raster ON PURPOSE (see map-base-options.js).
 * Reporting a broken browser there would be a confident lie about the dispatcher's machine,
 * so the check only applies when a vector map was actually asked for. UNINITIALIZED is not a
 * verdict either — the map simply has not decided yet.
 */
export function vectorFellBack({ askedForVector, renderingType } = {}) {
  if (!askedForVector) return false;
  const t = String(renderingType ?? '').toUpperCase();
  return t === 'RASTER';
}

export const MAP3D_NO_VECTOR =
  'This browser could not draw the 3D map — it fell back to the flat map, which means its '
  + 'graphics (WebGL) cannot drive Google’s 3D renderer. The flat map still works.';

/**
 * The sentence printed over a 3D view that is too high to answer the question it was opened
 * to answer. Null when the view is close enough to read doors, so the caller renders nothing.
 */
export function map3dHint(camera) {
  if (!camera) return null;
  return hintForRange(camera.range);
}

/**
 * The same sentence, from a live range. In a MODE the advice changes: v1.38.0 said "zoom the
 * board in, then hold Ctrl again", which was right for a peek and is wrong now — you zoom
 * right there, with the wheel or Google's own + button. Recomputed on every gmp-rangechange,
 * so the line goes away the moment the camera is close enough, instead of nagging from the
 * entry frame for as long as the view is open.
 */
export function hintForRange(range) {
  const r = Number(range);
  if (range === null || range === undefined || !Number.isFinite(r)) return null;
  return r <= MAP3D_DETAIL_RANGE ? null : 'Too high to read doors — scroll in on the building';
}
