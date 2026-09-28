// test/driver-area-colours.test.mjs — COLOURS YOU CAN TELL APART, AND A NAME THAT LIGHTS UP ITS AREA.
//
// Chad, 2026-09-28: "Make drivers name match color of their circle and when you hover over there
// name there area gets a translucent background. and give circles a varied color pallette"
//
// Pinned here:
//   1. The palette is varied: twelve colours from different families, every pair visibly apart,
//      every one readable as a name on the map and none of them near-black.
//   2. Neighbours get different colours: drivers whose rings sit on top of each other are never
//      handed the same one while a free colour is left — the old rank order did exactly that.
//   3. Pointing at a name fills that driver's whole area (both rings, for a man who works two) in
//      his own colour, see-through, and nobody else's; pointing away puts it back.
// The name's colour IS the ring's colour — one value, `colour`, feeds both (checked in the browser
// guard, verify-driver-areas.mjs, along with the pointer itself).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RING_PALETTE, ringColours, territoryModel, territoryLayer } from '../src/lib/driver-territory.js';
import { nameAt, HOVER_FILL, makeDriverAreaOverlayClass } from '../src/lib/driver-area-overlay.js';

// ── colour science, done independently of the module under test ─────────────
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const rgb = (h) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
const luminance = (h) => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const onWhite = (h) => 1.05 / (luminance(h) + 0.05);
function lab(h) {
  const [r, g, b] = rgb(h);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const apart = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

// ── 1. A VARIED PALETTE ─────────────────────────────────────────────────────

test('TWELVE COLOURS, EVERY PAIR VISIBLY APART — the old ten had two blues a trainee could not tell apart', () => {
  assert.equal(RING_PALETTE.length, 12);
  assert.equal(new Set(RING_PALETTE).size, 12, 'no colour twice');
  let closest = Infinity, pair = '';
  for (let i = 0; i < RING_PALETTE.length; i++) for (let j = i + 1; j < RING_PALETTE.length; j++) {
    const d = apart(RING_PALETTE[i], RING_PALETTE[j]);
    if (d < closest) { closest = d; pair = `${RING_PALETTE[i]} / ${RING_PALETTE[j]}`; }
  }
  // The first palette's closest pair (#1f4e79 navy / #2f6f9e blue) was 13.7 apart.
  assert.ok(closest >= 18, `closest pair ${pair} is only ${closest.toFixed(1)} apart`);
});

test('EVERY COLOUR READS AS A NAME ON THE MAP, AND NONE READS AS BLACK', () => {
  for (const c of RING_PALETTE) {
    assert.ok(onWhite(c) >= 3.8, `${c} is too pale for bold 11px type (${onWhite(c).toFixed(1)}:1)`);
    const [L] = lab(c);
    assert.ok(L >= 30 && L <= 65, `${c} lightness ${L.toFixed(0)} — near-black or washed out`);
  }
});

// ── 2. NEIGHBOURS GET DIFFERENT COLOURS ─────────────────────────────────────

const ring = (lat, lng, radiusKm = 8) => ({ lat, lng, radiusKm });
const driver = (key, ...circles) => ({ key, circles });
const drivers = (sets) => sets.map((s) => ({ key: s.key }));

test('TWELVE RINGS ON TOP OF EACH OTHER GET TWELVE DIFFERENT COLOURS', () => {
  // The metro: every ring overlaps every other. By rank this was fine only by luck.
  const sets = Array.from({ length: 12 }, (_, i) => driver(`D${i}`, ring(34 + i * 0.01, -84 + i * 0.01)));
  const colours = ringColours(drivers(sets), sets);
  assert.equal(new Set(sets.map((s) => colours.get(s.key))).size, 12, [...colours.values()].join(' '));
});

test('A LATECOMER AVOIDS THE COLOURS OF THE RINGS HE TOUCHES, and only needs to avoid those', () => {
  // Twelve 8km rings in a row, 14km apart, so each touches only the ones either side of it. A
  // thirteenth sits almost on the first and reaches the second. He must wear neither colour.
  const sets = Array.from({ length: 12 }, (_, i) => driver(`D${i}`, ring(34, -84 + i * 0.15)));
  sets.push(driver('LATE', ring(34, -84.02)));
  const colours = ringColours(drivers(sets), sets);
  for (let i = 1; i < 12; i++) assert.notEqual(colours.get(`D${i}`), colours.get(`D${i - 1}`), `D${i} and D${i - 1} touch`);
  const late = colours.get('LATE');
  assert.notEqual(late, colours.get('D0'), 'not the colour of the ring he sits on');
  assert.notEqual(late, colours.get('D1'), 'nor of the one he reaches');
  // With only two to avoid, the row does not use up the palette the way a crowd would.
  assert.ok(new Set(sets.map((s) => colours.get(s.key))).size < 12, 'a colour can come round again where rings are apart');
});

test('FAR APART, NOTHING TO AVOID: colours go round the palette in order, and come round again', () => {
  const sets = Array.from({ length: 13 }, (_, i) => driver(`D${i}`, ring(30 + i, -84)));  // 110km apart
  const colours = ringColours(drivers(sets), sets);
  sets.forEach((s, i) => assert.equal(colours.get(s.key), RING_PALETTE[i % 12], s.key));
});

test('A MAN WHO WORKS TWO AREAS AVOIDS THE COLOURS AT BOTH', () => {
  const sets = [driver('A', ring(34, -84)), driver('B', ring(35, -83)), driver('TWO', ring(34.01, -84.01), ring(35.01, -83.01))];
  const colours = ringColours(drivers(sets), sets);
  assert.notEqual(colours.get('TWO'), colours.get('A'));
  assert.notEqual(colours.get('TWO'), colours.get('B'));
});

test('the same rings always get the same colours; a driver with no ring still gets one', () => {
  const sets = [driver('A', ring(34, -84)), driver('B', ring(34.02, -84.02)), { key: 'NONE', circles: [] }];
  const a = ringColours(drivers(sets), sets), b = ringColours(drivers(sets), sets);
  assert.deepEqual([...a], [...b]);
  assert.ok(RING_PALETTE.includes(a.get('NONE')));
});

test('an oval counts by its length — a long oval reaching a ring is its neighbour', () => {
  // Centres 20km apart: two 8km circles do not touch, but an oval 15km long pointing at the other does.
  const east = { lat: 34, lng: -84, radiusKm: 8, oval: { majorKm: 15, minorKm: 4, angleDeg: 0 } };
  const sets = [driver('RING', ring(34, -84 + 20 / 92.2)), driver('OVAL', east)];
  const colours = ringColours(drivers(sets), sets);
  assert.notEqual(colours.get('OVAL'), colours.get('RING'));
});

test('on the whole pipeline the map and the paper still take one colour per man, from the palette', () => {
  const stops = [];
  for (let d = 0; d < 6; d++) for (let k = 0; k < 40; k++) {
    stops.push({ stopNbr: `${d}-${k}`, driverUserName: `Driver ${'ABCDEF'[d]}x`, driverName: `Driver ${'ABCDEF'[d]}x`, zip: '30019', city: 'DACULA',
      lat: 34 + (k % 5) * 0.01 + d * 0.005, lng: -83.9 + Math.floor(k / 5) * 0.01, boardDate: `2026-09-${String(1 + (k % 20)).padStart(2, '0')}` });
  }
  const m = territoryModel(stops);
  const layer = territoryLayer(stops);
  assert.equal(layer.rings.length, 6);
  for (const r of layer.rings) assert.equal(r.colour, m.colourOf.get(r.key));
  assert.equal(new Set(layer.rings.map((r) => r.colour)).size, 6, 'six men on one patch, six colours');
});

// ── 3. POINT AT A NAME, HIS AREA FILLS IN ───────────────────────────────────

test('nameAt: which drawn name the pointer is on — edges count, hidden names do not', () => {
  const boxes = [{ left: 10, top: 10, right: 60, bottom: 24 }, null, { left: 100, top: 40, right: 180, bottom: 54 }];
  assert.equal(nameAt(boxes, 30, 17), 0);
  assert.equal(nameAt(boxes, 61, 17), 0, 'a pixel off the edge still counts');
  assert.equal(nameAt(boxes, 140, 47), 2, 'a hidden name (null) is stepped over, not matched');
  assert.equal(nameAt(boxes, 80, 30), -1, 'between names: nobody');
  assert.equal(nameAt(boxes, NaN, 17), -1);
  assert.equal(nameAt([], 1, 1), -1);
});

/** A recording google.maps: every shape keeps the options it was made with and every setOptions. */
function fakeGoogle() {
  const made = [];
  class Shape {
    constructor(kind, o) { this.kind = kind; this.o = { ...o }; made.push(this); }
    setMap(m) { this.map = m; }
    setOptions(o) { Object.assign(this.o, o); }
  }
  return {
    made,
    google: { maps: {
      Circle: class extends Shape { constructor(o) { super('Circle', o); } },
      Polygon: class extends Shape { constructor(o) { super('Polygon', o); } },
      OverlayView: class { setMap() {} },
      LatLng: class {},
      event: { addListener: () => ({ remove() {} }) },
    } },
  };
}
const LAYER = { rings: [
  { key: 'TWO', label: 'Two Areas', colour: '#d62728', stops: 300, circles: [{ lat: 34, lng: -84, radiusKm: 8 }, { lat: 34.5, lng: -83.5, radiusKm: 6, oval: { majorKm: 12, minorKm: 4, angleDeg: 30 } }] },
  { key: 'ONE', label: 'One Area', colour: '#1565c0', stops: 200, circles: [{ lat: 34.1, lng: -84.1, radiusKm: 9 }] },
] };
const ringsOf = (made) => made.slice(made.length / 2);        // halos first, then the coloured rings

test('POINTED AT, EVERY RING OF HIS FILLS IN HIS OWN COLOUR, SEE-THROUGH — and nobody else\'s', () => {
  const { google, made } = fakeGoogle();
  const o = new (makeDriverAreaOverlayClass(google))(LAYER);
  o.attach({});
  const rings = ringsOf(made);
  assert.ok(rings.every((s) => s.o.fillOpacity === 0), 'hollow to begin with');
  o.fill('TWO');
  const [a, b, other] = rings;
  for (const s of [a, b]) {
    assert.equal(s.o.fillOpacity, HOVER_FILL);
    assert.equal(s.o.fillColor, '#d62728', 'in his colour');
    assert.equal(s.o.strokeWeight, 3, 'and his line a touch heavier');
  }
  assert.ok(HOVER_FILL > 0 && HOVER_FILL < 0.35, 'see-through: the streets under it still read');
  assert.equal(other.o.fillOpacity, 0, 'the other driver stays hollow');
  assert.ok(made.slice(0, made.length / 2).every((s) => s.o.fillOpacity === 0), 'no halo is ever filled');
});

test('POINTING AWAY PUTS IT BACK; pointing at another moves the fill to him', () => {
  const { google, made } = fakeGoogle();
  const o = new (makeDriverAreaOverlayClass(google))(LAYER);
  o.attach({});
  const [a, b, other] = ringsOf(made);
  o.fill('TWO');
  o.fill('ONE');
  assert.equal(a.o.fillOpacity, 0); assert.equal(b.o.fillOpacity, 0);
  assert.equal(a.o.strokeWeight, 2, 'his line back to normal');
  assert.equal(other.o.fillOpacity, HOVER_FILL);
  o.fill(null);
  assert.ok(ringsOf(made).every((s) => s.o.fillOpacity === 0 && s.o.strokeWeight === 2), 'all hollow again');
});

test('taking the rings off the map drops the fill bookkeeping — nothing left to repaint later', () => {
  // The pointer wiring itself (listeners on, and off again when the rings go) runs in a real
  // browser: verify-driver-areas.mjs points at a name, switches the rings off and on, and checks
  // nothing comes back filled.
  const { google } = fakeGoogle();
  const o = new (makeDriverAreaOverlayClass(google))(LAYER);
  o.attach({});
  o.fill('TWO');
  o.detach();
  assert.equal(o.filled, null);
  assert.equal(o.byDriver.size, 0);
});
