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
  control3dSpec, paint3dControl, shouldEnter3dOnKey, shouldExit3dOnKey, map3dHint,
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
  assert.match(map3dHint(far), /zoom the board in/i);

  const close = cameraFor2dView({ center: FORest_PARK, zoom: 19, heightPx: 900 });
  assert.equal(close.detailed, true);
  assert.equal(map3dHint(close), null, 'a usable view prints nothing');
  assert.ok(close.range <= MAP3D_DETAIL_RANGE);
  assert.equal(map3dHint(null), null);
});

// ── THE KEY ──────────────────────────────────────────────────────────────────
test('a bare Ctrl opens it; ⌘ does too, because Ctrl is not the modifier a Mac reaches for', () => {
  assert.equal(shouldEnter3dOnKey({ key: 'Control' }), true);
  assert.equal(shouldEnter3dOnKey({ key: 'Meta' }), true);
  assert.equal(shouldEnter3dOnKey({ key: 'Shift' }), false);
  assert.equal(shouldEnter3dOnKey({ key: 'a' }), false);
});

test('HOLDING A KEY FIRES KEYDOWN ~30 TIMES A SECOND — a repeat is not a new press', () => {
  // Without this the handler runs for as long as Chad holds Ctrl, every frame he holds it.
  assert.equal(shouldEnter3dOnKey({ key: 'Control', repeat: true }), false);
});

test('CTRL+R MUST NOT FLASH A 3D VIEW ON THE WAY TO A RELOAD — Ctrl with anything else is a shortcut', () => {
  assert.equal(shouldEnter3dOnKey({ key: 'Control', shiftKey: true }), false);
  assert.equal(shouldEnter3dOnKey({ key: 'Control', altKey: true }), false);
  // The letter key of a Ctrl+R arrives as key:'r', which is not a modifier and so is ignored.
  assert.equal(shouldEnter3dOnKey({ key: 'r', ctrlKey: true }), false);
});

test('Ctrl inside the board search box belongs to the search box — it is the start of a paste', () => {
  assert.equal(shouldEnter3dOnKey({ key: 'Control' }, { inTextField: true }), false);
});

test('letting go closes the peek — a peek that outlives its key is a mode nobody asked to be in', () => {
  assert.equal(shouldExit3dOnKey({ key: 'Control' }), true);
  assert.equal(shouldExit3dOnKey({ key: 'Meta' }), true);
  assert.equal(shouldExit3dOnKey({ key: 'Shift' }), false);
});

// ── THE BUTTON ───────────────────────────────────────────────────────────────
test('the button says WHICH WAY IT WILL GO, and names the Ctrl gesture nobody would otherwise find', () => {
  const off = control3dSpec(false);
  assert.match(off.label, /hold Ctrl/i);
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
    const creations = src.match(/new\s+\w+\.Map3DElement\(|new\s+Map3DElement\(/g) || [];
    assert.equal(creations.length, 1, 'exactly one construction site, guarded by a ref');
    // Guarded BOTH before the await and again after it: the library load is async, so two
    // quick Ctrl presses can both reach the constructor otherwise — two elements, two bills,
    // two WebGL canvases stacked on the board.
    const guards = src.match(/if\s*\(\s*!\s*map3dElRef\.current\s*\)/g) || [];
    assert.ok(guards.length >= 2, `the construction must be guarded on both sides of the await, found ${guards.length}`);
    // And the close path must NOT destroy it — hiding is the whole cost design.
    assert.ok(!/map3dElRef\.current\s*=\s*null/.test(src),
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

test('A REFUSED KEY IS READ, NOT JUST RECORDED — the error opens the layer, and opens it pinned', () => {
  return readFile(APP, 'utf8').then((src) => {
    // Writing the refusal onto a layer that stays display:none is an error nobody can see,
    // which is the exact failure the error exists to prevent. And a PEEK would vanish the
    // moment Chad let go of the key he is holding in order to read it.
    const block = src.slice(src.indexOf('setMap3dError(e?.message'));
    const upto = block.slice(0, block.indexOf('return;'));
    assert.ok(/setMap3dOn\(true\)/.test(upto), 'the error path must open the layer');
    assert.ok(/setMap3dPinned\(true\)/.test(upto), 'and pin it, so releasing Ctrl does not hide the message');
  });
});

test('CROSSING THE PHONE/DESKTOP BREAKPOINT RE-ATTACHES THE ELEMENT — an orphan looks like failed imagery', () => {
  return readFile(APP, 'utf8').then((src) => {
    assert.ok(/el\.parentNode\s*!==\s*map3dDiv\.current\s*\)\s*map3dDiv\.current\.appendChild\(el\)/.test(src),
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
  const open = src.slice(src.indexOf('if (!map3dElRef.current) {'));
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

test('the raster check is wired to the REAL asked-for-vector rule, not a guess', async () => {
  const src = await readFile(APP, 'utf8');
  assert.ok(/vectorFellBack\(\{\s*askedForVector:\s*usesMapId\(mapIdForView,\s*mapFilters\.hideLabels\)/.test(src),
    'it must reuse usesMapId — the same function map-base-options decides the base with');
});

test('THE "ZOOM IN" HINT IS NOT SHOWN BESIDE AN ERROR — it is wrong advice, not just clutter', async () => {
  // Watched on the deploy preview: "Too high to read doors — zoom the board in" came up
  // next to "this browser cannot draw the 3D map". Zooming cannot fix a browser, and
  // following the hint teaches a dispatcher the feature is broken in a way they can fix.
  const src = await readFile(APP, 'utf8');
  assert.ok(/\{!error && hint && <span/.test(src),
    'the hint must be suppressed while an error is on the layer');
});
