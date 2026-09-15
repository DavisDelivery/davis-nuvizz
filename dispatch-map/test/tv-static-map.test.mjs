// test/tv-static-map.test.mjs — the wall display's map as a picture.
//
// Chad, after two rounds of a TV that could not draw a JS map: "i'm thinking i like the idea
// of of making a static image lets write it merge it and just a switch to take it back."
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tvStaticMapEnabled, boundsOf, fitView, packMarkers, buildTvStaticMapUrl,
  TV_STATIC_URL_BUDGET,
} from '../src/lib/tv-static-map.js';

const P = (lat, lng) => ({ lat, lng });
// Roughly the real board: metro Atlanta out to Gainesville and Athens.
const BOARD = [P(33.75, -84.39), P(34.30, -83.82), P(33.95, -83.38), P(34.10, -84.52)];

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
  const v = fitView(BOARD, { width: 640, height: 416 });
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

// ── the marker budget ──────────────────────────────────────────────────────
const many = (n, at = 34) => Array.from({ length: n }, (_, i) => P(at + i * 0.001, -84 + i * 0.001));

test('a normal board fits whole, and says so', () => {
  const out = packMarkers({ driver: many(12), flagged: many(4, 33.9), open: many(180, 33.8), done: many(90, 33.7) });
  assert.equal(out.total, 286);
  assert.equal(out.shown, 286, 'nothing dropped on a board this size');
});

test('A BIG DAY IS CAPPED, AND THE OVERFLOW IS REPORTED RATHER THAN SWALLOWED', () => {
  // 700 stops is a real day here. A map showing 400 of them with nothing saying so reports a
  // lighter morning than the one being worked.
  const out = packMarkers({ driver: many(20), flagged: many(10, 33.9), open: many(450, 33.8), done: many(250, 33.7) });
  assert.equal(out.total, 730);
  assert.ok(out.shown < out.total, 'a 730-pin board cannot fit in one URL');
  assert.ok(out.shown > 200, `only ${out.shown} pins survived — the budget is being wasted`);
});

test('TRUCKS AND FLAGGED STOPS SURVIVE THE CAP — they are what the room looks up at', () => {
  const drivers = many(20);
  const flagged = many(10, 33.9);
  const out = packMarkers({ driver: drivers, flagged, open: many(2000, 33.8), done: many(2000, 33.7) });
  const joined = out.params.join('&');
  // every truck and every red stop is in the URL, even against 4,000 competing pins
  for (const d of drivers) assert.ok(joined.includes(`${d.lat.toFixed(4)},${d.lng.toFixed(4)}`), 'a truck was dropped');
  for (const f of flagged) assert.ok(joined.includes(`${f.lat.toFixed(4)},${f.lng.toFixed(4)}`), 'a flagged stop was dropped');
});

test('the packed URL never exceeds its budget — Static Maps refuses past 8192', () => {
  const out = packMarkers({ driver: many(50), flagged: many(50, 33.9), open: many(3000, 33.8), done: many(3000, 33.7) });
  const len = out.params.join('&').length;
  assert.ok(len <= TV_STATIC_URL_BUDGET, `packed ${len} chars, over budget`);
});

test('a malformed budget falls back to the default rather than emptying the map', () => {
  for (const bad of [0, -1, NaN, null, undefined, 'lots']) {
    const out = packMarkers({ open: many(50) }, bad);
    assert.equal(out.shown, 50, `budget ${String(bad)} emptied the map`);
  }
});

// ── the whole URL ──────────────────────────────────────────────────────────
test('the URL carries the view, the size and the pins', () => {
  const out = buildTvStaticMapUrl({ groups: { open: BOARD }, key: 'TESTKEY', width: 640, height: 416 });
  assert.match(out.url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/);
  assert.match(out.url, /size=640x416/);
  assert.match(out.url, /scale=2/);
  assert.match(out.url, /maptype=roadmap/);
  assert.match(out.url, /markers=color:0x4285F4/);
  assert.match(out.url, /key=TESTKEY$/, 'the key rides last, after the markers');
  assert.equal(out.shown, 4);
});

test('no key and no points each produce NO URL rather than a broken picture', () => {
  assert.equal(buildTvStaticMapUrl({ groups: { open: BOARD }, key: '' }), null);
  assert.equal(buildTvStaticMapUrl({ groups: {}, key: 'K' }), null);
  assert.equal(buildTvStaticMapUrl({ key: 'K' }), null);
});

test('the finished URL stays under the hard 8192 limit on the worst day', () => {
  const out = buildTvStaticMapUrl({
    groups: { driver: many(40), flagged: many(40, 33.9), open: many(3000, 33.8), done: many(3000, 33.7) },
    key: 'A'.repeat(40),
  });
  assert.ok(out.url.length < 8192, `url is ${out.url.length} chars`);
  assert.ok(out.url.endsWith(`key=${'A'.repeat(40)}`), 'the key survived the packing');
});
