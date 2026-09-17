// test/tv-static-map.test.mjs — the wall display's basemap, and where every pin lands on it.
//
// Chad, after two rounds of a TV that could not draw a JS map: "i'm thinking i like the idea
// of of making a static image lets write it merge it and just a switch to take it back."
// Then, looking at the result: "map doesn't look like it should i want the thing to be
// identical with all the same icons", and "i don't liek the black space on either end of the
// map we aren't using the full frame there are black bars on either side of the map."
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tvStaticMapEnabled, boundsOf, snapBounds, tvImageSize, fitView,
  projectToPixel, projectToPercent, buildTvStaticMapUrl, tvImageFailure,
  TV_IMAGE_MAX, TV_PIN_PAD_PX, TV_BOUNDS_SNAP_DEG,
} from '../src/lib/tv-static-map.js';

const P = (lat, lng) => ({ lat, lng });
// Roughly the real board: metro Atlanta out to Gainesville and Athens.
const BOARD = [P(33.75, -84.39), P(34.30, -83.82), P(33.95, -83.38), P(34.10, -84.52)];
// The pane the television actually hands us: 1920 wide less the 400px flag rail, less the
// status bar. Measured shapes, not the "~1520x990" guess that put the black bars there.
const PANE = { paneWidth: 1520, paneHeight: 987 };

// ── the switch ─────────────────────────────────────────────────────────────
test('the static map is ON by default — that is the point of the change', () => {
  assert.equal(tvStaticMapEnabled({}), true);
  assert.equal(tvStaticMapEnabled({ VITE_TV_STATIC_MAP: '' }), true);
  assert.equal(tvStaticMapEnabled(), true);
});

test('VITE_TV_STATIC_MAP=off puts the wall back on the live JS map', () => {
  for (const v of ['off', 'OFF', ' off ', '0', 'false', 'no', 'No']) {
    assert.equal(tvStaticMapEnabled({ VITE_TV_STATIC_MAP: v }), false, `"${v}" should disable`);
  }
});

test('A TYPO LEAVES IT ON, because a silently-reverted wall looks like a broken one', () => {
  // The failure this guards: someone means "off", writes "offf", and the television goes back
  // to the map that could not draw — with nothing anywhere saying why.
  for (const v of ['offf', 'yes', 'on', 'true', 'disabled', '1', 'nope']) {
    assert.equal(tvStaticMapEnabled({ VITE_TV_STATIC_MAP: v }), true, `"${v}" must not disable`);
  }
});

// ── framing ────────────────────────────────────────────────────────────────
test('the bounds hold every stop on the board', () => {
  const b = boundsOf(BOARD);
  assert.equal(b.north, 34.30);
  assert.equal(b.south, 33.75);
  assert.equal(b.east, -83.38);
  assert.equal(b.west, -84.52);
});

test('nothing to draw is null, not a box around the Gulf of Guinea', () => {
  // (0,0) is where a bad coordinate lands, and it is in the ocean off Africa.
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf(null), null);
  assert.equal(boundsOf([{ lat: null, lng: null }, { lat: 'x', lng: 3 }]), null);
  // Number(null) is 0 and 0 is finite — the trap this repo has been bitten by before. Here it
  // would put a phantom pin in the Atlantic and zoom the whole board out to fit it.
  assert.equal(boundsOf([{ lat: null, lng: -84 }]), null, 'a blank latitude is not the equator');
  assert.equal(boundsOf([{ lat: undefined, lng: undefined }]), null);
  assert.equal(boundsOf([{ lat: '', lng: '' }]), null);
  assert.equal(boundsOf([{ lat: true, lng: true }]), null, 'Number(true) is 1, and that is not a place');
  assert.equal(boundsOf([{ lat: 999, lng: -84 }]), null, 'a latitude off the planet is not a point');
  // and one real stop beside a broken one still frames the real one
  const mixed = boundsOf([{ lat: null, lng: null }, { lat: 34.1, lng: -84.1 }]);
  assert.deepEqual(mixed, { north: 34.1, south: 34.1, east: -84.1, west: -84.1 });
  assert.equal(fitView([]), null);
});

test('the whole board is framed, and the camera sits in the middle of it', () => {
  const v = fitView(BOARD, { width: 640, height: 416, snapDeg: 0 });
  assert.ok(v.zoom >= 3 && v.zoom <= 12, `zoom ${v.zoom} is off the scale`);
  assert.ok(Math.abs(v.center.lat - (34.30 + 33.75) / 2) < 1e-9);
  assert.ok(Math.abs(v.center.lng - (-83.38 + -84.52) / 2) < 1e-9);
});

test('A SPREAD-OUT BOARD ZOOMS OUT FURTHER THAN A TIGHT ONE', () => {
  const tight = fitView([P(34.00, -84.00), P(34.05, -83.95)], { width: 640, height: 416 });
  const wide = fitView([P(30.00, -88.00), P(36.00, -80.00)], { width: 640, height: 416 });
  assert.ok(wide.zoom < tight.zoom, `wide ${wide.zoom} should be lower than tight ${tight.zoom}`);
});

test('ONE STOP DOES NOT FRAME SOMEBODY\'S DRIVEWAY', () => {
  // A zero span sends the fit maths to infinity. Unclamped this would pick max zoom on a
  // single point and show a board of one parking lot.
  const v = fitView([P(34.1, -84.1)], { width: 640, height: 416, maxZoom: 12 });
  assert.equal(v.zoom, 12);
  assert.ok(Number.isFinite(v.zoom));
});

test('A KEEP-OUT MARGIN NEVER ZOOMS IN, AND NEVER RETURNS NaN', () => {
  // Padding costs frame, so it can only hold the zoom the same or push it out. And a pane
  // narrower than two margins must not hand Math.log a negative number.
  const bare = fitView(BOARD, { width: 640, height: 416, padPx: 0 });
  const padded = fitView(BOARD, { width: 640, height: 416, padPx: 40 });
  assert.ok(padded.zoom <= bare.zoom, `padded ${padded.zoom} zoomed IN past bare ${bare.zoom}`);
  const silly = fitView(BOARD, { width: 20, height: 12, padPx: 500 });
  assert.ok(Number.isFinite(silly.zoom), 'a huge margin produced a NaN zoom');
});

// ── the grid the camera moves on ───────────────────────────────────────────
test('SNAPPING ROUNDS OUTWARD — the freight that set the edge stays inside it', () => {
  const raw = { north: 34.301, south: 33.749, east: -83.371, west: -84.521 };
  const s = snapBounds(raw, 0.02);
  assert.ok(s.north >= raw.north - 1e-9, `north ${s.north} cut off ${raw.north}`);
  assert.ok(s.south <= raw.south + 1e-9, `south ${s.south} cut off ${raw.south}`);
  assert.ok(s.east >= raw.east - 1e-9, `east ${s.east} cut off ${raw.east}`);
  assert.ok(s.west <= raw.west + 1e-9, `west ${s.west} cut off ${raw.west}`);
});

test('SNAPPING IS A FIXED POINT — a box already on the grid comes back unchanged', () => {
  // THE INVARIANT THAT ACTUALLY KEEPS THE URL STILL, and IEEE doubles break it without care:
  // 34.02 / 0.02 is 1701.0000000000002, so a bare Math.ceil answers 1702 and the north edge
  // jumps a whole 2.2 km cell; 33.76 / 0.02 is 1687.9999999999998 and Math.floor drops the
  // south edge the same way. Every snapped box lands on the grid BY CONSTRUCTION, so a snap
  // that moves one is a snap that can move it again — and each move buys another picture.
  // Swept rather than hand-picked, because the first version of this test chose two values
  // that happened to divide cleanly and passed with the guard taken out.
  // Each edge built off the grid index, not by subtracting from another edge: 33.62 - 0.6 is
  // 33.019999999999996, which is not a grid value, so that fixture would be testing the
  // fixture's own arithmetic rather than the snap's.
  const on = (n) => Number((n * 0.02).toFixed(6));
  for (let i = 1680; i <= 1725; i += 1) {
    const v = on(i);
    const box = { north: v, south: on(i - 30), east: on(i - 5850), west: on(i - 5910) };
    const once = snapBounds(box, 0.02);
    assert.deepEqual(once, box, `${v} did not survive the grid`);
    assert.deepEqual(snapBounds(once, 0.02), once, `${v} is not idempotent`);
  }
});

test('AND ANY BOX IS STILL ON THE GRID AFTER ONE SNAP — twice is the same as once', () => {
  const raw = { north: 34.3013, south: 33.7491, east: -83.3717, west: -84.5209 };
  const once = snapBounds(raw, 0.02);
  assert.deepEqual(snapBounds(once, 0.02), once, 'the camera would keep stepping every render');
});

test('A TRUCK CREEPING ALONG DOES NOT MOVE THE CAMERA — that is what this costs money for', () => {
  // The fit includes the drivers. Fitted exactly, 30 feet of movement shifts the centre in
  // the fourth decimal, mints a new URL and buys another image — on every driver poll.
  const still = buildTvStaticMapUrl({ points: [...BOARD, P(33.9, -84.0)], key: 'K', ...PANE });
  const crept = buildTvStaticMapUrl({ points: [...BOARD, P(33.9002, -84.0002)], key: 'K', ...PANE });
  assert.equal(crept.url, still.url, 'a truck rolling 20 metres bought a new picture');
});

test('a malformed snap step leaves the box alone rather than clipping the board', () => {
  const raw = { north: 34.3, south: 33.7, east: -83.3, west: -84.5 };
  for (const bad of [0, -1, NaN, null, 'lots']) {
    assert.deepEqual(snapBounds(raw, bad), raw, `step ${String(bad)} altered the box`);
  }
  assert.equal(snapBounds(null), null);
});

// ── the black bars ─────────────────────────────────────────────────────────
test('THE IMAGE IS ASKED FOR IN THE PANE\'S OWN SHAPE — this is the black-bar fix', () => {
  // Chad: "there are black bars on either side of the map." The old URL asked for a fixed
  // 640x416 because a COMMENT said the pane was "~1520x990". A ratio that is guessed comes
  // out as dead space; a ratio that is measured cannot.
  for (const [w, h] of [[1520, 987], [1280, 720], [1920, 1080], [880, 620], [1000, 1000]]) {
    const s = tvImageSize(w, h);
    const want = w / h;
    const got = s.width / s.height;
    assert.ok(Math.abs(got - want) / want < 0.005, `${w}x${h} → ${s.width}x${s.height} is off by more than 0.5%`);
    assert.ok(s.width <= TV_IMAGE_MAX && s.height <= TV_IMAGE_MAX, 'Static Maps refuses a side over 640');
    assert.ok(Number.isInteger(s.width) && Number.isInteger(s.height));
  }
});

test('a portrait pane puts the 640 on the TALL side, not the wide one', () => {
  assert.deepEqual(tvImageSize(720, 1280), { width: 360, height: 640 });
  assert.deepEqual(tvImageSize(1280, 720), { width: 640, height: 360 });
});

test('an unmeasured pane is null — no URL is better than a billed picture in the wrong shape', () => {
  for (const [w, h] of [[0, 0], [1520, 0], [NaN, 400], [null, null], [-5, 400], ['x', 'y']]) {
    assert.equal(tvImageSize(w, h), null, `${String(w)}x${String(h)} should not produce a size`);
  }
});

test('a freakishly thin pane still asks for at least one pixel', () => {
  const s = tvImageSize(4000, 3);
  assert.ok(s.height >= 1, 'a 0-pixel side is a refused request');
});

// ── where a pin lands ──────────────────────────────────────────────────────
const VIEW = { center: P(34.0, -84.0), zoom: 10, width: 640, height: 416 };

test('THE CENTRE OF THE VIEW IS THE CENTRE OF THE PICTURE', () => {
  const at = projectToPixel(P(34.0, -84.0), VIEW);
  assert.ok(Math.abs(at.x - 320) < 1e-6, `x ${at.x}`);
  assert.ok(Math.abs(at.y - 208) < 1e-6, `y ${at.y}`);
});

test('north is up and east is right — a map with the pins mirrored still looks like a map', () => {
  // The worst failure available here: every stop quietly in the wrong place, on a screen that
  // still reads as a working board.
  const north = projectToPixel(P(34.5, -84.0), VIEW);
  const south = projectToPixel(P(33.5, -84.0), VIEW);
  const east = projectToPixel(P(34.0, -83.5), VIEW);
  const west = projectToPixel(P(34.0, -84.5), VIEW);
  assert.ok(north.y < 208, 'north drew below the centre');
  assert.ok(south.y > 208, 'south drew above the centre');
  assert.ok(east.x > 320, 'east drew left of the centre');
  assert.ok(west.x < 320, 'west drew right of the centre');
});

test('THE SCALE IS GOOGLE\'S OWN: 256 tile pixels per 360° at zoom 0', () => {
  // One degree of longitude east of centre at zoom 10 = 256 * 2^10 / 360 = 728.18 px.
  const at = projectToPixel(P(34.0, -83.0), VIEW);
  assert.ok(Math.abs((at.x - 320) - (256 * 1024 / 360)) < 1e-6, `moved ${at.x - 320} px`);
});

test('DOUBLING THE ZOOM DOUBLES THE PIXELS — the two halves of the picture agree', () => {
  const a = projectToPixel(P(34.0, -83.5), { ...VIEW, zoom: 9 });
  const b = projectToPixel(P(34.0, -83.5), { ...VIEW, zoom: 10 });
  assert.ok(Math.abs((b.x - 320) - 2 * (a.x - 320)) < 1e-6);
});

test('an un-positioned stop is NOT DRAWN, never a pin in the top-left corner', () => {
  assert.equal(projectToPixel({ lat: null, lng: null }, VIEW), null);
  assert.equal(projectToPixel({ lat: 34, lng: -84 }, null), null);
  assert.equal(projectToPixel({ lat: 34, lng: -84 }, { ...VIEW, zoom: 'x' }), null);
  assert.equal(projectToPixel(null, VIEW), null);
  assert.equal(projectToPixel({ lat: true, lng: true }, VIEW), null, 'Number(true) is 1, and that is not a place');
});

test('EVERY STOP ON THE BOARD LANDS INSIDE THE FRAME, clear of the edge', () => {
  // The whole contract in one assertion: fit a real board, project it back, and nothing is
  // off the picture or sliced by its edge.
  const out = buildTvStaticMapUrl({ points: BOARD, key: 'K', ...PANE });
  const padImage = TV_PIN_PAD_PX * (out.width / PANE.paneWidth);
  // 1px of tolerance on an 8.5px margin. The claim here is "no stop is sliced by the edge of
  // the frame", and integer image dimensions cannot express the fit to better than half a
  // pixel — which is under 2px on the pane. A real regression moves a pin by tens of pixels.
  for (const s of BOARD) {
    const at = projectToPixel(s, out.view);
    assert.ok(at, 'a board stop failed to project');
    assert.ok(at.x >= padImage - 1 && at.x <= out.width - padImage + 1, `x ${at.x} is in the margin`);
    assert.ok(at.y >= padImage - 1 && at.y <= out.height - padImage + 1, `y ${at.y} is in the margin`);
  }
});

test('AND THE BOARD FILLS THE FRAME — a floored zoom throws away up to half the screen', () => {
  // THE BUG THIS EXISTS FOR, in Chad's words: "there is a bunch of wasted space above where my
  // stops end and below them." Measured on the live wall at 1920x1080, the pins used 79% of the
  // height and 55% of the width, because the fit wanted zoom 8.25 and a whole-number zoom gave
  // it 8 — a zoom step is a factor of two, so flooring one can waste HALF the frame.
  //
  // The test the old suite was missing: it checked that nothing fell OUT of the frame, which a
  // map zoomed far too far out passes perfectly.
  const out = buildTvStaticMapUrl({ points: BOARD, key: 'K', ...PANE });
  let n = Infinity; let s2 = -Infinity; let w = Infinity; let e = -Infinity;
  for (const p of BOARD) {
    const at = projectToPixel(p, out.view);
    n = Math.min(n, at.y); s2 = Math.max(s2, at.y);
    w = Math.min(w, at.x); e = Math.max(e, at.x);
  }
  const padImage = TV_PIN_PAD_PX * (out.width / PANE.paneWidth);
  const usedH = (s2 - n) / (out.height - 2 * padImage);
  const usedW = (e - w) / (out.width - 2 * padImage);
  // ONE of the two must be filled — whichever the board's own shape makes the limiting one.
  // Demanding both would be demanding a board shaped like the television.
  assert.ok(Math.max(usedH, usedW) > 0.98, `the board fills only ${(usedH * 100).toFixed(0)}% of the height and ${(usedW * 100).toFixed(0)}% of the width`);
  assert.ok(usedH <= 1.02 && usedW <= 1.02, 'the board overflows the frame');
});

test('THE PICTURE SHRINKS INSTEAD OF THE ZOOM DROPPING A WHOLE STEP', () => {
  // Google will not take a fractional zoom — tested against the live API, it reads one as ZOOM
  // ZERO and returns a valid picture of the entire planet. So the leftover fraction of a step
  // comes off the requested SIZE, which is [320, 640] wide rather than always 640.
  const out = buildTvStaticMapUrl({ points: BOARD, key: 'K', ...PANE });
  assert.ok(Number.isInteger(out.zoom), `zoom ${out.zoom} is not an integer — Google reads that as the whole world`);
  assert.ok(out.width > TV_IMAGE_MAX / 2 && out.width <= TV_IMAGE_MAX, `width ${out.width} is outside (320, 640]`);
  assert.match(out.url, new RegExp(`size=${out.width}x${out.height}(&|$)`), 'the URL asks for a different rectangle than the pins are projected through');
});

test('per-cent placement survives a resize the way pixel placement does not', () => {
  const pct = projectToPercent(P(34.0, -84.0), VIEW);
  assert.ok(Math.abs(pct.left - 50) < 1e-6);
  assert.ok(Math.abs(pct.top - 50) < 1e-6);
});

test('A PIN OFF THE PICTURE IS NOT RENDERED AT ALL', () => {
  // Seven hundred invisible DOM nodes on a 2020 television is a cost with nothing bought.
  assert.equal(projectToPercent(P(20.0, -84.0), VIEW, 10), null, 'a stop in Mexico was kept');
  assert.ok(projectToPercent(P(34.0, -84.0), VIEW, 10), 'a stop dead centre was culled');
});

// ── the whole URL ──────────────────────────────────────────────────────────
test('the URL carries the view and the measured size — and NO markers', () => {
  const out = buildTvStaticMapUrl({ points: BOARD, key: 'TESTKEY', ...PANE });
  assert.match(out.url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/);
  // The SHAPE, not a literal size: the frame shrinks to absorb the fraction of a zoom step
  // Google will not take, so pinning 640x416 pinned the bug rather than the rule.
  const want = PANE.paneWidth / PANE.paneHeight;
  assert.ok(Math.abs(out.width / out.height - want) / want < 0.005, `${out.width}x${out.height} is not the pane's shape`);
  assert.match(out.url, /scale=2/);
  assert.match(out.url, /maptype=roadmap/);
  assert.match(out.url, /key=TESTKEY$/);
  assert.ok(!out.url.includes('markers'), 'Google is drawing the roads; this app draws the freight');
});

test('THE CAMERA COMES BACK WITH THE PICTURE — one view, not two', () => {
  // If the picture is drawn with one camera and the pins placed with another, every stop is
  // in the wrong place and nothing on screen says so.
  const out = buildTvStaticMapUrl({ points: BOARD, key: 'K', ...PANE });
  assert.match(out.url, new RegExp(`center=${out.view.center.lat.toFixed(4)},${out.view.center.lng.toFixed(4)}`));
  assert.match(out.url, new RegExp(`zoom=${out.view.zoom}(&|$)`));
  assert.equal(out.view.width, out.width);
  assert.equal(out.view.height, out.height);
});

test('no key, no points and an unmeasured pane each produce NO URL', () => {
  assert.equal(buildTvStaticMapUrl({ points: BOARD, key: '', ...PANE }), null);
  assert.equal(buildTvStaticMapUrl({ points: [], key: 'K', ...PANE }), null);
  assert.equal(buildTvStaticMapUrl({ key: 'K', ...PANE }), null);
  assert.equal(buildTvStaticMapUrl({ points: BOARD, key: 'K' }), null, 'a pane nobody has measured yet');
  assert.equal(buildTvStaticMapUrl(), null);
});

test('A SEVEN-HUNDRED-STOP DAY COSTS THE URL NOTHING — no pin is ever dropped again', () => {
  // The old URL carried the pins and died past 8192 characters, so a bad day lost freight off
  // the wall and had to print "showing 401 of 640 pins" to stay honest about it.
  const many = Array.from({ length: 730 }, (_, i) => P(33.6 + (i % 27) * 0.03, -84.6 + Math.floor(i / 27) * 0.03));
  const out = buildTvStaticMapUrl({ points: many, key: 'A'.repeat(40), ...PANE });
  assert.ok(out.url.length < 300, `url is ${out.url.length} chars for 730 stops`);
  let drawn = 0;
  for (const s of many) if (projectToPercent(s, out.view)) drawn += 1;
  assert.equal(drawn, 730, 'a stop fell off the wall');
});

test('the snap default is the one the header quotes', () => {
  assert.equal(TV_BOUNDS_SNAP_DEG, 0.02);
  assert.equal(TV_IMAGE_MAX, 640);
});

// ── why the picture did not draw ───────────────────────────────────────────
// Chad, twice: "the static api key thing is back." The screen used to answer that with one
// sentence for every possible failure, because an <img> onError carries no reason at all.
test('THE API-NOT-ENABLED CASE STILL GETS ITS ANSWER, and names the console setting', () => {
  const why = tvImageFailure({ status: 403, text: 'The Google Maps Platform server rejected your request. This API project is not authorized to use this API. Please ensure that this API is activated' });
  assert.match(why.headline, /Maps Static API is not enabled/);
  assert.match(why.headline, /SEPARATE API/);
  assert.match(why.detail, /not authorized to use this API/, 'Google\'s own sentence is carried through');
});

test('A REFERRER REFUSAL IS NOT AN API REFUSAL — different console page, different fix', () => {
  // The old message would have sent somebody to enable an API that was already on.
  const why = tvImageFailure({ status: 403, text: 'API keys with referer restrictions cannot be used with this API.' });
  assert.match(why.headline, /refused THIS PAGE/);
  assert.doesNotMatch(why.headline, /not enabled/);
});

test('an invalid key is named as an invalid key', () => {
  const why = tvImageFailure({ status: 403, text: 'The Google Maps Platform server rejected your request. The provided API key is invalid.' });
  assert.match(why.headline, /rejected the key itself/);
});

test('A RATE LIMIT AND A GOOGLE OUTAGE ARE NOT SOMEBODY\'S MISTAKE, and say so', () => {
  assert.match(tvImageFailure({ status: 429, text: '' }).headline, /rate-limiting/);
  assert.match(tvImageFailure({ status: 429, text: '' }).headline, /nothing is wrong with the key/);
  assert.match(tvImageFailure({ status: 503, text: '' }).headline, /their end/);
});

test('A DEAD NETWORK IS NOT A DEAD KEY — the worst possible wrong answer on a television', () => {
  // Telling somebody to go and edit a Google console because the set's wifi dropped sends
  // them to the one place that cannot be the problem.
  const why = tvImageFailure({ network: true, text: 'Failed to fetch' });
  assert.match(why.headline, /could not reach Google/);
  assert.match(why.headline, /network/);
  assert.doesNotMatch(why.headline, /console/);
  // and a probe with no status at all is the same case, never a confident 403 story
  assert.match(tvImageFailure({}).headline, /could not reach Google/);
  assert.match(tvImageFailure({ status: 'x' }).headline, /could not reach Google/);
});

test('THE CONFUSING ONE IS NAMED PRECISELY: Google answered fine, the browser could not draw it', () => {
  // This is the case Chad's television is most likely to produce, and the one the old
  // message was most wrong about.
  const why = tvImageFailure({ status: 200, text: '' });
  assert.match(why.headline, /key and the API are fine/);
  assert.match(why.headline, /this browser that could not draw/);
});

test('an unrecognised status is reported as itself, not as a story about it', () => {
  const why = tvImageFailure({ status: 418, text: '' });
  assert.match(why.headline, /HTTP 418/);
});
