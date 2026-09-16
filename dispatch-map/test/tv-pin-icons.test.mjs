// test/tv-pin-icons.test.mjs — THE WALL DISPLAY DRAWS THE BOARD'S OWN PINS.
//
// Chad, on a photograph of the office television: "map doesn't look like it should i want the
// thing to be identical with all the same icons."
//
// The picture from Google carries the ROADS; every stop on top of it is this app's own
// stopMarkerIcon artwork, built on a page where the Maps JavaScript API is never loaded. The
// only thing that stood in the way was six `new google.maps.Size` and six
// `new google.maps.Point` — numbers, not behaviour — so the TV hands in PLAIN_GEOMETRY and
// gets the same SVG back.
//
// WHAT THESE PIN, and both halves matter:
//   · the artwork is IDENTICAL, byte for byte, to what the desktop map draws;
//   · the two are never mixed up. The icon cache is shared, and a cached Size built for the
//     television must never be handed to a real google.maps.Marker — which happens the moment
//     somebody presses Exit on the wall display and the JS map loads into the same page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStopMarkerIcon, googleStub, markerSvg } from './helpers/app-markers.mjs';

const stop = (stopNbr, normalizedStatus = 'SCHEDULED', extra = {}) => ({
  stopNbr, normalizedStatus, isPlanned: normalizedStatus !== 'UNPLANNED', ...extra,
});
// One of each shape the board actually draws, so this is not one lucky branch.
const CASES = [
  ['a resting unplanned dot', stop('007100001', 'UNPLANNED'), null, {}],
  ['a scheduled pin', stop('007100002', 'SCHEDULED'), null, {}],
  ['a delivered pin', stop('007100003', 'DELIVERED'), null, {}],
  ['a pickup', stop('007100004', 'SCHEDULED', { stopType: 'PU' }), null, {}],
  ['a do-not-send ✕', stop('007100005', 'SCHEDULED'), { do_not_send: true }, {}],
  ['a numbered route pin', stop('007100006', 'SCHEDULED'), null, { inRoute: true, seq: 7 }],
  ['an Estes order', stop('ESTES-0538243875', 'UNPLANNED'), null, {}],
  ['a co-located pair', stop('007100007', 'SCHEDULED'), null, { sameLocCount: 3 }],
  ['a restriction cluster', stop('007100008', 'SCHEDULED'), { no_tractor_trailer: true }, {}],
  ['an AM window', stop('007100009', 'SCHEDULED'), { delivery_window: 'AM' }, {}],
];

test('THE TELEVISION GETS THE SAME ARTWORK, byte for byte, with no google.maps on the page', async () => {
  const icon = await loadStopMarkerIcon();
  for (const [what, s, note, opts] of CASES) {
    const onMap = icon.raw(googleStub, s, note, opts);
    const onWall = icon.raw(icon.plainGeometry, s, note, opts);
    assert.equal(onWall.url, onMap.url, `${what} draws differently on the wall`);
    assert.equal(onWall.scaledSize.width, onMap.scaledSize.width, `${what}: different width`);
    assert.equal(onWall.scaledSize.height, onMap.scaledSize.height, `${what}: different height`);
    assert.equal(onWall.anchor.x, onMap.anchor.x, `${what}: different anchor x`);
    assert.equal(onWall.anchor.y, onMap.anchor.y, `${what}: different anchor y`);
    // And it is real artwork, not an empty string that would compare equal to itself.
    assert.ok(markerSvg(onWall).includes('<svg'), `${what}: no SVG came back`);
  }
});

test('A PIN BUILT FOR THE WALL IS NEVER HANDED TO A REAL MARKER, in either order', async () => {
  // The shared icon cache is the trap. Press Exit on the wall display and the JS map loads
  // into the SAME page, reading the SAME cache — so without a namespace the second screen
  // gets the first screen's Size and Point objects, which are not google.maps types. That
  // fails as one screen quietly not drawing, a week later, with nothing saying why.
  const icon = await loadStopMarkerIcon();
  for (const [what, s, note, opts] of CASES) {
    // wall first, then map
    icon.raw(icon.plainGeometry, s, note, opts);
    const afterWall = icon.raw(googleStub, s, note, opts);
    assert.ok(afterWall.scaledSize instanceof googleStub.maps.Size, `${what}: the map got the wall's Size`);
    assert.ok(afterWall.anchor instanceof googleStub.maps.Point, `${what}: the map got the wall's Point`);
    // map first, then wall
    const afterMap = icon.raw(icon.plainGeometry, s, note, opts);
    assert.ok(!(afterMap.scaledSize instanceof googleStub.maps.Size), `${what}: the wall got the map's Size`);
    assert.ok(afterMap.scaledSize instanceof icon.plainGeometry.maps.Size, `${what}: the wall's Size is not its own`);
  }
});

test('the cache still does its job on each side — the same stop twice is the same object', async () => {
  // Namespacing must not turn the memo off: this runs for ~700 stops, ~3 times a cold load.
  const icon = await loadStopMarkerIcon();
  const s = stop('007100042', 'SCHEDULED');
  assert.equal(icon.raw(googleStub, s, null, {}), icon.raw(googleStub, s, null, {}));
  assert.equal(icon.raw(icon.plainGeometry, s, null, {}), icon.raw(icon.plainGeometry, s, null, {}));
  assert.notEqual(icon.raw(googleStub, s, null, {}), icon.raw(icon.plainGeometry, s, null, {}),
    'the two namespaces must not share one object');
});
