// test/map-3d.test.mjs — HOLD CTRL AND SEE THE BUILDING (v1.38.0)
//
// Chad, Sep 16: "I want exactly what I showed you where I can be on map hold control and see
// map in 3d view like I showed you so I can see if buildings have docks."
//
// These pin the RULES, named for the real-world moment each one exists for. The element, the
// DOM and the key handler are the caller's; nothing here needs a Maps key, which is the only
// reason any of it is testable — CI has no key and never loads Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  map3dEnabled, isRealPoint, metersPerPixel, rangeForView, cameraFor2dView, map3dMode,
  control3dSpec, paint3dControl, map3dHint, hintForRange,
  isCtrlDragStart, dragCrossedThreshold, isEscape, readLatLng, zoomForRange, cameraMoved,
  twoDViewFor3dCamera, metresBetween, DRAG_THRESHOLD_PX, HANDOFF_MIN_ZOOM, HANDOFF_MAX_ZOOM,
  groundedCamera, cameraGroundPoint,
  MAP3D_TILT, MAP3D_MIN_RANGE, MAP3D_MAX_RANGE, MAP3D_DETAIL_RANGE,
} from '../src/lib/map-3d.js';

// Atlanta State Farmers Market — the produce terminal in Chad's screenshot. A real place
// with real docks, so the numbers below mean something.
const FORest_PARK = { lat: 33.6187, lng: -84.3733 };

// ── THE SWITCH ───────────────────────────────────────────────────────────────
test('unset means ON — the feature ships live, like every other house-shape switch', () => {
  assert.equal(map3dEnabled({}), true);
  assert.equal(map3dEnabled({ VITE_MAP_3D: '' }), true);
});

test('the documented off-words turn it off, in any case, with stray spaces', () => {
  for (const v of ['off', 'OFF', ' off ', '0', 'false', 'FALSE', 'no', 'No']) {
    assert.equal(map3dEnabled({ VITE_MAP_3D: v }), false, `${JSON.stringify(v)} should turn it off`);
  }
});

test('A TYPO LEAVES IT ON — a quiet feature looks exactly like a working one', () => {
  // Chad types "of" instead of "off" at 6am. The feature must stay on rather than vanish
  // with nothing on screen saying why: that failure is invisible, which is the worst kind.
  for (const v of ['of', 'offf', 'disabled', 'true', 'on', '1', 'yes', 'nope']) {
    assert.equal(map3dEnabled({ VITE_MAP_3D: v }), true, `${JSON.stringify(v)} should leave it on`);
  }
});

// ── THE POINT THAT ISN'T ─────────────────────────────────────────────────────
test('Number(null) is 0 and 0 is finite — a stop with no coordinates must not fly the camera to the Atlantic', () => {
  assert.equal(isRealPoint(null, null), false);
  assert.equal(isRealPoint(undefined, undefined), false);
  assert.equal(isRealPoint('', ''), false);
  assert.equal(isRealPoint(true, true), false);   // Number(true) is 1
  assert.equal(isRealPoint(NaN, 5), false);
  assert.equal(isRealPoint(91, 0), false);        // off the planet
  assert.equal(isRealPoint(0, -181), false);
  assert.equal(isRealPoint(FORest_PARK.lat, FORest_PARK.lng), true);
  assert.equal(isRealPoint('33.6187', '-84.3733'), true); // strings from a JSON feed still count
});

// ── THE CAMERA ───────────────────────────────────────────────────────────────
test('metres per pixel halves with every zoom level and shrinks with latitude', () => {
  const z10 = metersPerPixel(10, FORest_PARK.lat);
  const z11 = metersPerPixel(11, FORest_PARK.lat);
  assert.ok(Math.abs(z10 / z11 - 2) < 1e-9, 'one zoom level is a factor of two');
  assert.ok(metersPerPixel(12, 60) < metersPerPixel(12, 0), 'Mercator: further north, fewer metres per pixel');
  assert.equal(metersPerPixel('nonsense', 33), null);
});

test('zoomed onto a single dock at z18, the camera sits a few hundred metres back — not in orbit, not inside the roof', () => {
  const r = rangeForView({ zoom: 18, lat: FORest_PARK.lat, heightPx: 900 });
  assert.ok(r > MAP3D_MIN_RANGE && r < MAP3D_MAX_RANGE, `expected a working range, got ${r}`);
  assert.ok(r > 500 && r < 1000, `z18 on a 900px map should frame the block, got ${r}m`);
});

test('THE WHOLE-METRO CTRL: a board at z9 would put the camera 363km up, and the ceiling brings it back to the building', () => {
  // This is the case the ceiling exists for. Honest maths says orbit; a dispatcher asking
  // "does this building have a dock" is not asking for a photograph of Georgia.
  const honest = 156543.03392804097 * Math.cos(FORest_PARK.lat * Math.PI / 180) / Math.pow(2, 9) * 900 / (2 * Math.tan(35 * Math.PI / 360));
  assert.ok(honest > 300000, `sanity: the unclamped range really is enormous (${Math.round(honest)}m)`);
  assert.equal(rangeForView({ zoom: 9, lat: FORest_PARK.lat, heightPx: 900 }), MAP3D_MAX_RANGE);
});

test('zoomed in past the floor, the camera stops rather than clipping into the mesh', () => {
  assert.equal(rangeForView({ zoom: 23, lat: FORest_PARK.lat, heightPx: 900 }), MAP3D_MIN_RANGE);
});

test('a dead map or a zero-height container yields no range — and therefore no 3D', () => {
  assert.equal(rangeForView({ zoom: 18, lat: FORest_PARK.lat, heightPx: 0 }), null);
  assert.equal(rangeForView({ zoom: null, lat: FORest_PARK.lat, heightPx: 900 }), null);
  assert.equal(rangeForView({ zoom: 18, lat: 'x', heightPx: 900 }), null);
});

test('the camera lands on the spot you were looking at, at the oblique that shows a door', () => {
  const cam = cameraFor2dView({ center: FORest_PARK, zoom: 18, heading: 0, heightPx: 900 });
  assert.equal(cam.center.lat, FORest_PARK.lat);
  assert.equal(cam.center.lng, FORest_PARK.lng);
  assert.equal(cam.center.altitude, 0);
  assert.equal(cam.tilt, MAP3D_TILT);
  assert.equal(cam.mode, 'HYBRID');
});

test('HEADING CARRIES OVER — a yard spun to a heading nobody chose stops being recognisable', () => {
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heading: 125, heightPx: 900 }).heading, 125);
  // Google hands back negatives and >360 after a spin; both normalise rather than throwing
  // the camera somewhere arbitrary.
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heading: -90, heightPx: 900 }).heading, 270);
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heading: 455, heightPx: 900 }).heading, 95);
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heading: null, heightPx: 900 }).heading, 0);
});

test('AN UNREADABLE 2D VIEW OPENS NOTHING — a camera flown to a made-up default is worse than a gesture that did nothing', () => {
  // Because the dispatcher would BELIEVE the picture. Silence is the honest failure here.
  assert.equal(cameraFor2dView({ center: null, zoom: 18, heightPx: 900 }), null);
  assert.equal(cameraFor2dView({ center: { lat: null, lng: null }, zoom: 18, heightPx: 900 }), null);
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heightPx: 0 }), null);
});

test('HYBRID whichever way the board satellite toggle is set — the street name is how you confirm the right building', () => {
  assert.equal(map3dMode(), 'HYBRID');
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heightPx: 900, satellite: false }).mode, 'HYBRID');
  assert.equal(cameraFor2dView({ center: FORest_PARK, zoom: 18, heightPx: 900, satellite: true }).mode, 'HYBRID');
});

// ── THE HINT ─────────────────────────────────────────────────────────────────
test('a view too high to read doors SAYS SO, rather than letting the imagery take the blame', () => {
  const far = cameraFor2dView({ center: FORest_PARK, zoom: 12, heightPx: 900 });
  assert.equal(far.detailed, false);
  // In a MODE you zoom right there. "zoom the board in, then hold Ctrl again" was right for
  // a peek and is wrong advice now, so the sentence changed with the design.
  assert.match(map3dHint(far), /scroll in/i);
  assert.doesNotMatch(map3dHint(far), /hold Ctrl/i);

  const close = cameraFor2dView({ center: FORest_PARK, zoom: 19, heightPx: 900 });
  assert.equal(close.detailed, true);
  assert.equal(map3dHint(close), null, 'a usable view prints nothing');
  assert.ok(close.range <= MAP3D_DETAIL_RANGE);
  assert.equal(map3dHint(null), null);
});

// ── THE GESTURE ──────────────────────────────────────────────────────────────
// Chad, 2026-09-23: "It is kind of working but not like it does when you are on google maps
// and you put it in globe view and use the 3d view there … make mine work like that."
// In Google Maps 3D is a MODE, and Ctrl+drag is how you tilt INTO it and turn around in it.
test('CTRL+DRAG IS THE WAY IN — Google Maps\' own gesture, and ⌘ on a Mac', () => {
  assert.equal(isCtrlDragStart({ button: 0, ctrlKey: true }), true);
  assert.equal(isCtrlDragStart({ button: 0, metaKey: true }), true);
  assert.equal(isCtrlDragStart({ button: 0 }), false, 'a plain drag is a pan, always');
});

test('A BARE CTRL DOES NOTHING NOW — in a mode you stay in, Ctrl+C on a PRO would be a trap', () => {
  // As a peek, a Ctrl keydown that opened 3D and closed on release was a flicker. As a MODE it
  // would throw a dispatcher copying a PRO into full-screen 3D and LEAVE them there, with an
  // Immersive Maps load billed for it. There is no key path in any more — only a drag.
  const lib = { isCtrlDragStart, dragCrossedThreshold };
  assert.equal(typeof lib.isCtrlDragStart, 'function');
  return readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8').then((src) => {
    assert.ok(!/shouldEnter3dOnKey/.test(src), 'no keydown may open 3D');
    assert.ok(!/addEventListener\('keyup'/.test(src.slice(src.indexOf('function useMap3dPeek'), src.indexOf('function Cube3dIcon'))),
      'and nothing in the 3D hook may close it on a key RELEASE — that was the peek');
  });
});

test('A RIGHT-BUTTON DRAG IS GOOGLE\'S 2D ROTATE, AND SHIFT/ALT ARE OTHER CHORDS — none of them are ours', () => {
  assert.equal(isCtrlDragStart({ button: 2, ctrlKey: true }), false);
  assert.equal(isCtrlDragStart({ button: 0, ctrlKey: true, shiftKey: true }), false);
  assert.equal(isCtrlDragStart({ button: 0, ctrlKey: true, altKey: true }), false);
});

test('A CTRL+CLICK IS NEVER TAKEN — it has to MOVE before it counts as a drag', () => {
  const at = { x: 500, y: 300 };
  assert.equal(dragCrossedThreshold(at, { x: 500, y: 300 }), false, 'a click that never moved');
  assert.equal(dragCrossedThreshold(at, { x: 503, y: 302 }), false, 'a shaky click');
  assert.equal(dragCrossedThreshold(at, { x: 500 + DRAG_THRESHOLD_PX, y: 300 }), true, 'a drag');
  assert.equal(dragCrossedThreshold(null, at), false);
  assert.equal(dragCrossedThreshold(at, { x: 'x', y: 1 }), false);
});

test('Escape leaves — once a view outlives the key that opened it, a key has to close it', () => {
  assert.equal(isEscape({ key: 'Escape' }), true);
  assert.equal(isEscape({ key: 'Esc' }), true, 'older browsers spell it this way');
  assert.equal(isEscape({ key: 'Control' }), false, 'Ctrl is Google\'s turn-and-tilt inside 3D, not a way out');
});

// ── THE HANDOFF: YOU LAND WHERE YOU FLEW ─────────────────────────────────────
test('reads a point off every shape Google hands back — methods, numbers, and nothing', () => {
  assert.deepEqual(readLatLng({ lat: () => 33.6, lng: () => -84.3 }), { lat: 33.6, lng: -84.3 }, 'LatLng has methods');
  assert.deepEqual(readLatLng({ lat: 33.6, lng: -84.3, altitude: 0 }), { lat: 33.6, lng: -84.3 }, 'LatLngAltitude has numbers');
  assert.equal(readLatLng(null), null);
  assert.equal(readLatLng({ lat: null, lng: null }), null, 'Number(null) is 0 — not a point in the Atlantic');
  assert.equal(readLatLng({ lat: () => { throw new Error('dead'); }, lng: 1 }), null);
});

test('zoomForRange is the exact inverse of rangeForView — a round trip lands where it started', () => {
  for (const zoom of [14, 16, 18, 19.5]) {
    const range = rangeForView({ zoom, lat: FORest_PARK.lat, heightPx: 900 });
    if (range === MAP3D_MIN_RANGE || range === MAP3D_MAX_RANGE) continue; // the clamps are one-way on purpose
    const back = zoomForRange({ range, lat: FORest_PARK.lat, heightPx: 900 });
    assert.ok(Math.abs(back - zoom) < 1e-9, `z${zoom} → ${range}m → z${back}`);
  }
});

test('ZOOMING OUT IN 3D IS HONOURED ON THE WAY OUT — the entry ceiling is not applied twice', () => {
  // MAP3D_MAX_RANGE stops a whole-metro board dropping the camera 363km up on the way IN.
  // If the dispatcher then zooms OUT in 3D on purpose, the board must follow them out.
  // The property, not a guessed number: a camera the dispatcher pulled back PAST the entry
  // ceiling must land the board further out than the ceiling itself would. (60km over a 900px
  // map is ~z11.6 — checked by hand: ~42 m/px x 900px = ~38km of ground = ~60km of range.)
  const atCeiling = zoomForRange({ range: MAP3D_MAX_RANGE, lat: FORest_PARK.lat, heightPx: 900 });
  const pulledBack = zoomForRange({ range: 60000, lat: FORest_PARK.lat, heightPx: 900 });
  assert.ok(pulledBack < atCeiling - 3, `pulled back to 60km (z${pulledBack}) must land well beyond the ceiling (z${atCeiling})`);
  assert.equal(zoomForRange({ range: 1e9, lat: 0, heightPx: 900 }), HANDOFF_MIN_ZOOM, 'but never off the planet');
  assert.equal(zoomForRange({ range: 1, lat: 0, heightPx: 900 }), HANDOFF_MAX_ZOOM);
  assert.equal(zoomForRange({ range: null, lat: 33, heightPx: 900 }), null, 'Number(null) is 0 — no zoom from nothing');
  assert.equal(zoomForRange({ range: 800, lat: 33, heightPx: 0 }), null);
});

// ── AIMED AT THE GROUND — measured on production, 2026-09-23 ─────────────────
// Chad: "if i'm over a building and turn it on when it comes up and is working the position on
// the map has moved". Rendered, not argued: the Buford Terminal (ROUTING_DEPOT) at z18 on
// production v1.57.0. These are the numbers Google reported, and they are the fixtures below.
const TERMINAL = { lat: 34.147791, lng: -83.960911 };
const ENTRY = { center: { ...TERMINAL, altitude: 0 }, range: 572.895489942209, tilt: 67.5, heading: 0 };
// What Google reported AFTER the grounded teleport, nobody having touched anything:
const GOOGLE_AFTER = {
  camera: { lat: 34.14303145078566, lng: -83.96091099994534, altitude: 576.3353528979309 },
  center: { lat: 34.147558694996796, lng: -83.96091099994534, altitude: 367.77604498217767 },
  range: 544.9344256577751, heading: 0,
};

test('THE CAMERA IS AIMED AT THE GROUND, NOT AT SEA LEVEL — altitude 0 put it inside the hill', () => {
  // Google defines the centre's altitude as "meters above the mean sea level". v1.57.0 passed
  // 0, and Google put the camera at 219m above sea level over a site ~368m up: underground.
  const g = groundedCamera(ENTRY, 'RELATIVE_TO_GROUND');
  assert.equal(g.altitudeMode, 'RELATIVE_TO_GROUND', 'altitude read as metres above the TERRAIN');
  assert.deepEqual(g.center, { ...TERMINAL, altitude: 0 }, 'zero metres above the ground under the spot');
  assert.equal(g.range, ENTRY.range); assert.equal(g.tilt, 67.5); assert.equal(g.heading, 0);
  assert.equal(groundedCamera(null), null);
  assert.equal(groundedCamera({ center: { lat: null, lng: null } }), null, 'Number(null) is 0 — no camera from nothing');
});

test('MY CAMERA GEOMETRY AGREES WITH GOOGLE\'S TO SIX DECIMALS — the measured Buford Terminal', () => {
  const mine = cameraGroundPoint(ENTRY);
  assert.equal(mine.lat.toFixed(6), GOOGLE_AFTER.camera.lat.toFixed(6));
  assert.equal(mine.lng.toFixed(6), GOOGLE_AFTER.camera.lng.toFixed(6));
  assert.ok(metresBetween(mine, GOOGLE_AFTER.camera) < 1, 'within a metre of where Google put it');
  assert.equal(cameraGroundPoint({ center: null, range: 500, tilt: 60 }), null);
});

test('A LOOK-AND-LEAVE PUTS THE BOARD BACK EXACTLY — even though Google re-reports the centre 26m off', () => {
  // THE REGRESSION THE RENDER FOUND. After grounding, Google reports `center` where its line of
  // sight hits the ROOF (26m short) and `range` 573m -> 545m. Nobody moved. A centre comparison
  // called that a 26m flight and would have nudged the board on the way out.
  assert.ok(metresBetween(ENTRY.center, GOOGLE_AFTER.center) > 25, 'sanity: the centre really did move 26m');
  const entry = { camera: cameraGroundPoint(ENTRY), heading: ENTRY.heading };
  assert.equal(cameraMoved(entry, { camera: GOOGLE_AFTER.camera, heading: GOOGLE_AFTER.heading }), false);
});

test('A FLIGHT MOVES THE BOARD — pan, orbit round the back, or zoom in, and that is where you land', () => {
  const entry = { camera: cameraGroundPoint(ENTRY), heading: 0 };
  const panned = cameraGroundPoint({ ...ENTRY, center: { lat: TERMINAL.lat + 0.0008, lng: TERMINAL.lng } });
  assert.equal(cameraMoved(entry, { camera: panned, heading: 0 }), true, 'panned ~90m north');
  const orbited = cameraGroundPoint({ ...ENTRY, heading: 180 });
  assert.equal(cameraMoved(entry, { camera: orbited, heading: 180 }), true, 'round to the back of the building');
  const zoomed = cameraGroundPoint({ ...ENTRY, range: 300 });
  assert.equal(cameraMoved(entry, { camera: zoomed, heading: 0 }), true, 'zoomed in on the docks');
  assert.equal(cameraMoved(entry, { camera: entry.camera, heading: 359 }), false, '359° is 1° from 0°, not 359°');
});

test('an unreadable camera is not a flight — the board stays where it was, never moved to a guess', () => {
  const entry = { camera: cameraGroundPoint(ENTRY), heading: 0 };
  assert.equal(cameraMoved(entry, { camera: null, heading: 0 }), false);
  assert.equal(cameraMoved(entry, { camera: { lat: null, lng: null }, heading: 0 }), false);
  assert.equal(cameraMoved(null, { camera: GOOGLE_AFTER.camera }), false);
});

test('THE BOARD LANDS FLAT — tilt is never carried back, because tilted 2D is the grey-block view', () => {
  const v = twoDViewFor3dCamera({ center: { lat: 33.6195, lng: -84.3733, altitude: 0 }, range: 800, heading: 455, heightPx: 900 });
  assert.deepEqual(v.center, { lat: 33.6195, lng: -84.3733 });
  assert.equal(v.heading, 95, 'heading carries, normalised');
  assert.ok(!('tilt' in v), 'no tilt in the handoff at all');
  assert.equal(twoDViewFor3dCamera({ center: null, range: 800, heading: 0, heightPx: 900 }), null,
    'an unreadable camera leaves the board where it is — never a guess');
});

test('the hint is recomputed from the LIVE range, so it goes away once you are close enough', () => {
  assert.match(hintForRange(MAP3D_DETAIL_RANGE + 1), /scroll in/i);
  assert.equal(hintForRange(MAP3D_DETAIL_RANGE), null);
  assert.equal(hintForRange(null), null);
  assert.equal(hintForRange('x'), null);
});

// ── THE BUTTON ───────────────────────────────────────────────────────────────
test('the button says WHICH WAY IT WILL GO, and names the Ctrl gesture nobody would otherwise find', () => {
  const off = control3dSpec(false);
  assert.match(off.label, /Ctrl\+drag/i);
  assert.equal(off.ariaPressed, 'false');
  const on = control3dSpec(true);
  assert.match(on.label, /back to the flat map/i);
  assert.equal(on.ariaPressed, 'true');
  assert.notEqual(on.background, off.background, 'on and off must not look identical');
});

test('paint applies the identical treatment to a live element, and tolerates a null one', () => {
  const el = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  paint3dControl(el, true);
  assert.equal(el.attrs['aria-pressed'], 'true');
  assert.equal(el.style.background, control3dSpec(true).background);
  assert.ok(el.innerHTML.includes('<svg'));
  paint3dControl(el, false);
  assert.equal(el.attrs['aria-pressed'], 'false');
  assert.equal(el.style.background, control3dSpec(false).background);
  assert.equal(paint3dControl(null, true), null);
});

// ── THE WIRING ───────────────────────────────────────────────────────────────
// The rules above are worthless if the screen does not read them, and none of this can be
// exercised in CI (no Maps key, no WebGL). These assert the source, which is the only
// evidence available — the same approach the repo's other wiring tests take.
const APP = fileURLToPath(new URL('../src/App.jsx', import.meta.url));

test('ONE ELEMENT PER SESSION, NOT ONE PER LOOK — the Immersive Maps SKU bills per element created', () => {
  return readFile(APP, 'utf8').then((src) => {
    // TWO 3D SURFACES, each with exactly ONE construction site: the Map's Ctrl layer and the
    // Uline review's building view (v1.61.0), which re-points its one element per location.
    // A third is a new meter — it has to be added to this count on purpose, not arrive unseen.
    const sites = [...src.matchAll(/new\s+\w+\.Map3DElement\(|new\s+Map3DElement\(/g)].map((m) => m.index);
    assert.equal(sites.length, 2, 'exactly two construction sites — the Map and the Uline review');
    for (const at of sites) {
      const body = src.slice(src.lastIndexOf('\nfunction ', at), at);
      const name = (body.match(/^\nfunction (\w+)/) || [])[1] || '?';
      // Guarded BOTH before the await and again after it: the library load is async, so two
      // quick presses can both reach the constructor otherwise — two elements, two bills,
      // two WebGL canvases stacked on the board. Checked PER SITE: a count over the whole
      // file would let one well-guarded site vouch for an unguarded one.
      const awaitAt = body.lastIndexOf("await google.maps.importLibrary('maps3d')");
      assert.ok(awaitAt > 0, `${name}: the element is built after the library load`);
      assert.match(body.slice(0, awaitAt), /if\s*\(\s*!\s*elRef\.current\s*\)/, `${name}: guarded by the ref before the await`);
      assert.match(body.slice(awaitAt), /if\s*\(\s*!\s*elRef\.current[\s)&]/, `${name}: and re-checked after it`);
    }
    // And the close path must NOT destroy it — hiding is the whole cost design.
    assert.ok(!/elRef\.current\s*=\s*null/.test(src),
      'closing must hide the layer, never drop the element (the next open would re-bill)');
  });
});

test('THE TELEVISION NEVER BUILDS A 3D MAP — nobody holds Ctrl on a wall, and it would bill for it', () => {
  return readFile(APP, 'utf8').then((src) => {
    // TV mode already drops the vector map for a raster one it can actually draw; handing it
    // a WebGL 3D element would resurrect the exact white rectangle v1.31.4 removed.
    assert.ok(/map3dOn\s*&&\s*!tvMode|!tvMode\s*&&\s*map3dOn|tvMode\s*\?\s*false/.test(src)
      || /const\s+map3dAvailable\s*=\s*[^;]*!tvMode/.test(src),
      'TV mode must be excluded from the 3D path');
  });
});

test('the switch reverts EVERY side at once — no handler, no button, no element', () => {
  return readFile(APP, 'utf8').then((src) => {
    assert.ok(src.includes('map3dEnabled'), 'App.jsx must read the switch');
    assert.ok(/MAP_3D_ON\s*=\s*map3dEnabled\(import\.meta\.env\)/.test(src),
      'read once at module load, like every other build-time flag here');
  });
});

test('THE HEIGHT COMES FROM THE VISIBLE MAP, NOT THE HIDDEN LAYER — this one shipped as "Ctrl does nothing"', () => {
  return readFile(APP, 'utf8').then((src) => {
    // The layer is display:none until it opens, and a hidden element's clientHeight is 0.
    // A zero height makes rangeForView refuse (correctly), so measuring the layer means the
    // FIRST press computes no camera and opens nothing — for ever. Caught by the
    // how-does-this-fail-silently pass; pinned here so it cannot come back.
    assert.ok(/const\s+heightPx\s*=\s*mapDiv\.current\?\.clientHeight/.test(src),
      'the camera height must be measured from the always-visible 2D map div first');
  });
});

test('A REFUSED KEY IS READ, NOT JUST RECORDED — the error opens the layer so it can be read', () => {
  return readFile(APP, 'utf8').then((src) => {
    // Writing the refusal onto a layer that stays display:none is an error nobody can see,
    // which is the exact failure the error exists to prevent. And a PEEK would vanish the
    // moment Chad let go of the key he is holding in order to read it.
    // Anchored on the 3D refusal message itself: "setError(e?.message" also appears in the
    // debug-capture component 150 lines earlier, and anchoring there silently measured the
    // wrong function. A window that can land on the wrong code proves nothing.
    const at = src.indexOf("'Google refused the 3D map'");
    assert.ok(at > -1, 'the 3D refusal path must exist');
    const upto = src.slice(at, src.indexOf('return;', at));
    assert.ok(/setOn\(true\)/.test(upto), 'the error path must open the layer');
    assert.ok(/onRef\.current = true/.test(upto), 'and mark it open, so Escape and Back can take it away again');
  });
});

test('CROSSING THE PHONE/DESKTOP BREAKPOINT RE-ATTACHES THE ELEMENT — an orphan looks like failed imagery', () => {
  return readFile(APP, 'utf8').then((src) => {
    assert.ok(/el\.parentNode\s*!==\s*layerRef\.current\s*\)\s*layerRef\.current\.appendChild\(el\)/.test(src),
      'the re-use path must re-attach when the container was rebuilt under it');
  });
});

test('BOTH VIEWS GET IT — a Ctrl-only feature is a feature that does not exist on a phone', () => {
  return readFile(APP, 'utf8').then((src) => {
    // The 3D layer container must appear in the mobile render AND the desktop render, not
    // just whichever one was being looked at while it was built. Shipped wrong twice before.
    const layers = src.match(/<Map3DLayer\b/g) || [];
    assert.ok(layers.length >= 2, `the 3D layer must be rendered in both views, found ${layers.length}`);
    // The container is ALWAYS MOUNTED and only hidden — the element lives inside it, and an
    // unmount would destroy it and buy another on the next Ctrl.
    assert.ok(/display:\s*on\s*\?\s*'block'\s*:\s*'none'/.test(src),
      'the layer must toggle display, not mount/unmount');
  });
});

// ── THE BROWSER ITSELF ───────────────────────────────────────────────────────
// Added after WATCHING this happen on the real deploy preview: Ctrl opened the layer, the
// key answered every request, nothing threw, and Google rendered its own "Oops! Something
// went wrong" card inside it because the renderer was software (SwiftShader). A failure that
// arrives through a SUCCESSFUL construction cannot be caught; it has to be pre-empted.
test('a browser with no WebGL is told so, and is never billed for an element it cannot draw', async () => {
  const { webglUsable, MAP3D_NO_WEBGL } = await import('../src/lib/map-3d.js');
  const noGl = { document: { createElement: () => ({ getContext: () => null }) } };
  assert.equal(webglUsable(noGl), false);
  assert.match(MAP3D_NO_WEBGL, /WebGL/);
  assert.match(MAP3D_NO_WEBGL, /flat map still works/i, 'and says what still does work');
});

test('a browser WITH WebGL opens normally', async () => {
  const { webglUsable } = await import('../src/lib/map-3d.js');
  assert.equal(webglUsable({ document: { createElement: () => ({ getContext: (k) => (k === 'webgl2' ? {} : null) }) } }), true);
});

test('WHEN IT CANNOT TELL, IT LETS GOOGLE TRY — refusing on a false negative is the worse error', async () => {
  const { webglUsable } = await import('../src/lib/map-3d.js');
  assert.equal(webglUsable(undefined), true);
  assert.equal(webglUsable({}), true);
  assert.equal(webglUsable({ document: { createElement: () => { throw new Error('nope'); } } }), true);
});

test('the check runs BEFORE the element is constructed, not after', async () => {
  const src = await readFile(APP, 'utf8');
  const open = src.slice(src.indexOf('if (!elRef.current) {'));
  const gl = open.indexOf('webglUsable()');
  const build = open.indexOf('importLibrary');
  assert.ok(gl > -1 && build > -1 && gl < build, 'the WebGL check must precede the library load');
});

// ── THE FAILURE THAT WAS ACTUALLY WATCHED ────────────────────────────────────
// webglUsable() only catches a browser with NO context. The preview run that produced
// Google's blank "Oops" had a SOFTWARE context (SwiftShader) and sailed through it. What
// named the failure was Google's own 2D verdict: a map asked to be VECTOR reporting RASTER.
test('a vector map that fell back to raster has already failed this browser once — do not build a 3D one', async () => {
  const { vectorFellBack, MAP3D_NO_VECTOR } = await import('../src/lib/map-3d.js');
  assert.equal(vectorFellBack({ askedForVector: true, renderingType: 'RASTER' }), true);
  assert.equal(vectorFellBack({ askedForVector: true, renderingType: 'raster' }), true);
  assert.match(MAP3D_NO_VECTOR, /WebGL/);
  assert.match(MAP3D_NO_VECTOR, /flat map still works/i);
});

test('a working vector map is not a complaint, and UNINITIALIZED is not a verdict', async () => {
  const { vectorFellBack } = await import('../src/lib/map-3d.js');
  assert.equal(vectorFellBack({ askedForVector: true, renderingType: 'VECTOR' }), false);
  assert.equal(vectorFellBack({ askedForVector: true, renderingType: 'UNINITIALIZED' }), false);
  assert.equal(vectorFellBack({ askedForVector: true, renderingType: null }), false);
  assert.equal(vectorFellBack({}), false);
});

test('HIDE PLACE LABELS MAKES IT RASTER ON PURPOSE — blaming the machine there would be a confident lie', async () => {
  const { vectorFellBack } = await import('../src/lib/map-3d.js');
  // The toggle drops the mapId deliberately (see map-base-options.js). Raster is the
  // intended state, not a broken browser, and the dispatcher must not be told otherwise.
  assert.equal(vectorFellBack({ askedForVector: false, renderingType: 'RASTER' }), false);
});

test('the raster check is wired to the REAL asked-for-vector rule on BOTH screens, not a guess', async () => {
  const src = await readFile(APP, 'utf8');
  // The hook takes askedForVector from its caller, so the honesty of the check lives at the
  // two call sites. Each must hand it usesMapId() — the same function map-base-options
  // decides the base with — so neither screen can claim a broken browser on a map that is
  // raster ON PURPOSE because "Hide place labels" is on.
  assert.ok(/askedForVector:\s*usesMapId\(mapIdForView,\s*mapFilters\.hideLabels\)/.test(src),
    'the dispatch Map must pass usesMapId');
  assert.ok(/askedForVector:\s*usesMapId\(MAP_ID,\s*routeHideLabels\)/.test(src),
    'Routing must pass usesMapId too');
  assert.ok(/vectorFellBack\(\{\s*askedForVector,\s*renderingType\s*\}\)/.test(src),
    'and the hook must consult it');
});

test('ROUTING GETS IT TOO — Chad asked for it there, and one hook serves both so they cannot drift', async () => {
  const src = await readFile(APP, 'utf8');
  const hookCalls = src.match(/=\s*useMap3dPeek\(\{/g) || [];   // calls, not the definition
  assert.equal(hookCalls.length, 2, `expected the dispatch Map and Routing, found ${hookCalls.length}`);
  // Four layers: mobile + desktop on each screen. The television deliberately gets none.
  const layers = src.match(/<Map3DLayer\b/g) || [];
  assert.equal(layers.length, 4, `expected two views on each of two screens, found ${layers.length}`);
});

test('THE LAYER SITS ABOVE THE BOARD FURNITURE — at z-11 the data grid ate the drags', async () => {
  const src = await readFile(APP, 'utf8');
  // Chad: "i cant pan around the building". The layer was the LOWEST overlay on the map: the
  // bottom data grid (z-12), filters, status pill and flag rail (z-15/16/20/22) all drew on
  // top of it and swallowed pointer events. The highest in-map overlay is 30; real modals are
  // `fixed` at 60+, so anything in between is correct and 40 is what it uses.
  const m = src.match(/data-overlay-layer[\s\S]{0,900}?className="absolute inset-0 z-\[(\d+)\] bg-slate-900"/);
  assert.ok(m, 'the 3D layer must declare an explicit z-index');
  const z = Number(m[1]);
  assert.ok(z > 30, `the layer must clear every in-map overlay (max 30), got ${z}`);
  assert.ok(z < 60, `and stay below the modal band (60+), got ${z}`);
});

test('IT IS A MODE — Ctrl+drag inside 3D is Google\'s turn-and-tilt, never a re-entry that snaps you back', async () => {
  const src = await readFile(APP, 'utf8');
  const hook = src.slice(src.indexOf('function useMap3dPeek'), src.indexOf('function Cube3dIcon'));
  // v1.38.0's fight: Ctrl opened the view AND was the key the 3D map reads for rotate. Now an
  // open() while already open does nothing, so turning round a building never re-frames it.
  assert.ok(/if \(onRef\.current\) return;/.test(hook), 'open() must be a no-op while 3D is up');
  assert.ok(/isCtrlDragStart\(ev\)/.test(hook) && /dragCrossedThreshold\(/.test(hook), 'the way in is a Ctrl+DRAG');
  assert.ok(/isEscape\(ev\)/.test(hook), 'Escape must leave');
  // The listener only WATCHES: nothing may be prevented or stopped, so a Ctrl+click and every
  // other gesture on both maps (the Route Workbench's included) reach what they were meant for.
  assert.ok(!/preventDefault\(\)|stopPropagation\(\)|stopImmediatePropagation\(\)/.test(hook),
    'the 3D hook must never swallow an event');
});

test('GOOGLE\'S OWN CONTROLS ARE ASKED FOR, AND GOOGLE\'S OWN FAILURE IS HEARD', async () => {
  const src = await readFile(APP, 'utf8');
  // The compass / zoom / tilt / turn buttons are what make this feel like Google Maps; in
  // v1.38.0 they were there but buried under the board's grid and cards.
  assert.ok(/defaultUIHidden:\s*false/.test(src), 'Google\'s 3D controls must be requested explicitly');
  assert.ok(/addEventListener\('gmp-error'/.test(src), 'Google\'s init failure must be listened for, not left as a blank card');
  assert.ok(/addEventListener\('gmp-rangechange'/.test(src), 'the hint must follow the live camera');
});

test('LEAVING HANDS THE CAMERA BACK — a flight lands the board, a look puts it back exactly', async () => {
  const src = await readFile(APP, 'utf8');
  const hook = src.slice(src.indexOf('function useMap3dPeek'), src.indexOf('function Cube3dIcon'));
  assert.ok(/cameraMoved\(entryCamRef\.current, now\)/.test(hook), 'close must tell a flight from a look');
  assert.ok(/twoDViewFor3dCamera\(/.test(hook), 'a flight lands the board through the tested handoff');
  assert.ok(/board2dRef\.current/.test(hook), 'a look puts back the board as it was BEFORE the drag nudged it');
  // The layer is hidden, never unmounted — the element is the thing that costs money.
  assert.ok(!/elRef\.current\s*=\s*null/.test(hook));
});

test('THE "ZOOM IN" HINT IS NOT SHOWN BESIDE AN ERROR — it is wrong advice, not just clutter', async () => {
  // Watched on the deploy preview: "Too high to read doors — zoom the board in" came up
  // next to "this browser cannot draw the 3D map". Zooming cannot fix a browser, and
  // following the hint teaches a dispatcher the feature is broken in a way they can fix.
  const src = await readFile(APP, 'utf8');
  assert.ok(/\{!error && hint && <span/.test(src),
    'the hint must be suppressed while an error is on the layer');
});

test('THE HOOK GROUNDS THE CAMERA ON EVERY OPEN, PINS ON THE ROOF, AND BASELINES WHERE THE CAMERA STANDS', async () => {
  const src = await readFile(APP, 'utf8');
  const hook = src.slice(src.indexOf('function useMap3dPeek'), src.indexOf('function Cube3dIcon'));
  assert.ok(/flyCameraTo\(\{ endCamera, durationMillis: 0 \}\)/.test(hook), 'teleported, so it comes up already right');
  assert.ok(/groundedCamera\(cam, mode\)/.test(hook) && /RELATIVE_TO_GROUND/.test(hook), 'through the tested grounded camera');
  const calls = hook.match(/aimAtGround\(el, /g) || [];
  assert.ok(calls.length >= 2, `both the first open AND every re-open must be grounded, found ${calls.length}`);
  assert.ok(/RELATIVE_TO_MESH/.test(hook) && !/altitudeMode: 'CLAMP_TO_GROUND'/.test(hook),
    'the pin sits on the building, not on the ground under its roof');
  assert.ok(/entryCamRef\.current = \{ camera: cameraGroundPoint\(cam\)/.test(hook), 'baseline computed, not read before Google applies it');
  assert.ok(/camera: el\.cameraPosition/.test(hook), 'and compared against where the camera actually stands');
});

