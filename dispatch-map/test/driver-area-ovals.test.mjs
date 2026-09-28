// test/driver-area-ovals.test.mjs — AN OVAL WHERE THE WORK RUNS ALONG A ROAD, AND ONLY THERE.
//
// Chad asked at the very start for "circles or ovals of where their general work area is", and on
// 2026-09-27, with the rings on the live map: "if for some drivers an oval would be a better shape
// than a circle, use that instead."
//
// What is pinned here:
//   1. "Better" is a measurement: an oval replaces a circle only when it holds the same share of
//      the driver's stops on plainly less ground. Work strung along a road gets one; a round town
//      keeps its circle; too little work to show a direction keeps its circle.
//   2. ONLY THE OUTLINE CHANGES. Who gets a ring, where it is centred and the circle it was earned
//      on are exactly what they were with ovals switched off.
//   3. The map and the paper draw the SAME oval, and the map's names are laid out against it.
//   4. Nothing about a customer rides along: an oval is three numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitOval, ovalOf, ovalPath, ovalEnds, OVAL_RULE, driverCircles, territoryLayer, haversineKm, RING_PALETTE,
} from '../src/lib/driver-territory.js';
import { territorySheetHtml } from '../src/lib/territory-sheet-html.js';
import { placeRingLabels, ringReach, NAME_H, makeDriverAreaOverlayClass } from '../src/lib/driver-area-overlay.js';

// ── deterministic made-up work around Buford ────────────────────────────────
const KY = 110.574;
const kx = (lat) => 111.320 * Math.cos((lat * Math.PI) / 180);
let seed = 97;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const DAYS = ['2026-08-31', '2026-09-01', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10',
  '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22',
  '2026-09-23', '2026-09-24', '2026-09-25'];
/** `n` stops round each town (Gaussian, `sigKm`), each customer taking one to three of them. */
function work(name, towns, n, sigKm) {
  const out = [];
  let k = 0;
  for (const [lat, lng] of towns) {
    let left = n;
    while (left > 0) {
      const p = { lat: lat + (gauss() * sigKm) / KY, lng: lng + (gauss() * sigKm) / kx(lat) };
      for (let r = 1 + Math.floor(rnd() * 3); r > 0 && left > 0; r--, left--) {
        out.push({
          stopNbr: `${name}-${k}`, driverUserName: name, driverName: name,
          zip: String(30500 + (k % 7)), city: 'TOWN', lat: p.lat, lng: p.lng, boardDate: DAYS[k % DAYS.length],
        });
        k++;
      }
    }
  }
  return out;
}
// Buford → Flowery Branch → Oakwood → Gainesville: the I-985 run, about 25km, 50° north of east.
const I985 = [[34.121, -84.000], [34.185, -83.925], [34.227, -83.884], [34.298, -83.824]];
const corridor = () => work('Ray Corridor', I985, 70, 2);
const town = () => work('Lou Roundtown', [[33.956, -83.988]], 260, 5);            // Lawrenceville
const mean = (pts) => ({ lat: pts.reduce((t, p) => t + p.lat, 0) / pts.length, lng: pts.reduce((t, p) => t + p.lng, 0) / pts.length });
/** Is the stop inside the oval — in the same flat km the oval is drawn in. */
function insideOval(ring, p) {
  const x = (p.lng - ring.lng) * kx(ring.lat), y = (p.lat - ring.lat) * KY;
  const t = (ring.oval.angleDeg * Math.PI) / 180;
  const u = x * Math.cos(t) + y * Math.sin(t), v = y * Math.cos(t) - x * Math.sin(t);
  return (u / ring.oval.majorKm) ** 2 + (v / ring.oval.minorKm) ** 2 <= 1 + 1e-9;
}

// ── 1. BETTER IS A MEASUREMENT ──────────────────────────────────────────────

test('WORK STRUNG ALONG A ROAD GETS AN OVAL, lying the way the road runs', () => {
  const stops = corridor();
  const f = fitOval(stops, mean(stops));
  assert.ok(f, 'there is enough work to fit');
  assert.equal(f.better, true, `an oval should win here (aspect ${f.aspect.toFixed(2)}, ground ${f.areaRatio.toFixed(2)} of the circle's)`);
  assert.ok(Math.abs(f.angleDeg - 50) < 8, `the long way should follow the road, ~50° north of east — got ${f.angleDeg.toFixed(0)}°`);
  assert.ok(f.aspect >= 2.5, `a 25km run of towns a few km wide is long and thin, not ${f.aspect.toFixed(2)}:1`);
  assert.ok(f.areaRatio <= 0.6, `and it covers far less ground than the circle, not ${f.areaRatio.toFixed(2)} of it`);
});

test('A ROUND TOWN KEEPS ITS CIRCLE — a nearly-round oval says nothing a circle does not', () => {
  const stops = town();
  const f = fitOval(stops, mean(stops));
  assert.ok(f, 'there is enough work to fit');
  assert.equal(f.better, false, `Lawrenceville-shaped work stays round (aspect ${f.aspect.toFixed(2)}, ground ${f.areaRatio.toFixed(2)})`);
});

test('THE OVAL HOLDS THE SAME SHARE AS THE CIRCLE, on less ground — that is what "better" means', () => {
  const stops = corridor();
  const [d] = driverCircles(stops);
  assert.equal(d.circles.length, 1);
  const ring = d.circles[0];
  assert.ok(ring.oval, 'drawn as an oval');
  const inOval = stops.filter((p) => insideOval(ring, p)).length / stops.length;
  const inCircle = stops.filter((p) => haversineKm(ring, p) <= ring.radiusKm).length / stops.length;
  assert.ok(inOval >= 0.69, `the oval holds ${Math.round(inOval * 100)}% of his stops — the circle's 70% rule`);
  assert.ok(inCircle >= 0.69, `the circle holds ${Math.round(inCircle * 100)}%`);
  const ground = (ring.oval.majorKm * ring.oval.minorKm) / (ring.radiusKm * ring.radiusKm);
  const limit = ring.stops < OVAL_RULE.fewStops ? OVAL_RULE.maxGroundFew : OVAL_RULE.maxGround;
  assert.ok(ground <= limit + 0.01, `on ${Math.round(ground * 100)}% of the circle's ground`);
});

test('TOO LITTLE WORK TO SHOW A DIRECTION KEEPS THE CIRCLE — the stops, and the places', () => {
  const stops = corridor();
  const few = stops.slice(0, OVAL_RULE.minStops - 1);
  assert.equal(fitOval(few, mean(few)), null, `${few.length} stops is under the ${OVAL_RULE.minStops} an oval needs`);
  const enough = stops.filter((_, i) => i % 4 === 0).slice(0, OVAL_RULE.minStops);
  assert.ok(fitOval(enough, mean(enough)), `${OVAL_RULE.minStops} stops is enough to fit`);
  // Eighty stops at eleven customers: the "direction" would be the line between a few addresses.
  // (Distinct PLACES, not stops — work() gives a customer up to three stops at one point.)
  const places = [...new Map(stops.map((p) => [`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`, p])).values()];
  const over = (k) => Array.from({ length: 80 }, (_, i) => ({ ...places[i % k] }));
  assert.equal(fitOval(over(OVAL_RULE.minPlaces - 1), mean(over(OVAL_RULE.minPlaces - 1))), null, `${OVAL_RULE.minPlaces - 1} places is too few to have a shape`);
  assert.ok(fitOval(over(OVAL_RULE.minPlaces), mean(over(OVAL_RULE.minPlaces))), `${OVAL_RULE.minPlaces} places is enough to fit`);
});

test('an oval is never narrower than the 2.5km a circle is never smaller than, and never inside-out', () => {
  // Stops along one straight street: without the floor the oval would be a line.
  const line = Array.from({ length: 90 }, (_, i) => ({ lat: 34.05 + (i % 30) * 0.004, lng: -83.95 }));
  const f = fitOval(line, mean(line));
  assert.ok(f.minorKm >= 2.5, `short radius ${f.minorKm.toFixed(2)}km`);
  assert.ok(f.majorKm >= f.minorKm);
  assert.ok(f.angleDeg >= 0 && f.angleDeg < 180);
  assert.ok(Math.abs(f.angleDeg - 90) < 1, `a north-south street lies north-south, got ${f.angleDeg}`);
});

test('the fit is deterministic: the same stops give the same oval, every time', () => {
  const stops = corridor();
  assert.deepEqual(fitOval(stops, mean(stops)), fitOval(stops, mean(stops)));
  // In another order the sums round differently in the last bits (1e-14) and in nothing else.
  const tidy = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'number' ? Number(v.toFixed(9)) : v]));
  assert.deepEqual(tidy(fitOval(stops, mean(stops))), tidy(fitOval([...stops].reverse(), mean(stops))), 'order does not matter');
});

// ── 2. ONLY THE OUTLINE CHANGES ─────────────────────────────────────────────

test('ONLY THE OUTLINE CHANGES — the same drivers, the same centres, the same circles, ovals on or off', () => {
  const stops = [...corridor(), ...town(), ...work('Two Town', [[34.0, -84.2], [33.6, -84.3]], 80, 2.5)];
  const on = driverCircles(stops);
  const off = driverCircles(stops, { ovals: false });
  assert.ok(on.some((d) => d.circles.some((c) => c.oval)), 'the fixture has an oval to compare');
  assert.equal(off.flatMap((d) => d.circles).filter((c) => c.oval).length, 0, 'switched off, nothing is an oval');
  const strip = (sets) => sets.map((d) => ({ ...d, circles: d.circles.map(({ oval, ...c }) => c), candidateCircles: d.candidateCircles.map(({ oval, ...c }) => c) }));
  assert.deepEqual(strip(on), strip(off), 'take the ovals away and every ring is exactly what it was');
});

// ── 3. THE MAP AND THE PAPER DRAW THE SAME OVAL ─────────────────────────────

test('THE LAYER CARRIES THE OVAL AS THREE NUMBERS — and the circle it was earned on', () => {
  const stops = [...corridor(), ...town()];
  const layer = territoryLayer(stops);
  const ray = layer.rings.find((r) => r.label === 'Ray Corridor');
  const lou = layer.rings.find((r) => r.label === 'Lou Roundtown');
  assert.deepEqual(Object.keys(ray.circles[0]).sort(), ['lat', 'lng', 'oval', 'radiusKm']);
  assert.deepEqual(Object.keys(ray.circles[0].oval).sort(), ['angleDeg', 'majorKm', 'minorKm']);
  assert.ok(Number.isInteger(ray.circles[0].oval.angleDeg) && ray.circles[0].oval.angleDeg < 180);
  assert.deepEqual(Object.keys(lou.circles[0]).sort(), ['lat', 'lng', 'radiusKm'], 'a round ring is exactly what it was');
  const json = JSON.stringify(layer);
  assert.ok(!/city|zip|addr|business/i.test(json), 'no address fields ride along with an oval');
});

test('PAPER AND SCREEN AGREE: page one prints the oval the map draws — same turn, same proportions', () => {
  const stops = [...corridor(), ...town()];
  const oval = territoryLayer(stops).rings.find((r) => r.label === 'Ray Corridor').circles[0].oval;
  const html = territorySheetHtml({ stops });
  const page1 = html.slice(0, html.indexOf('<div class="page">'));
  const printed = [...page1.matchAll(/<ellipse cx="[\d.-]+" cy="[\d.-]+" rx="([\d.]+)" ry="([\d.]+)" transform="rotate\(([\d.-]+) [\d.-]+ [\d.-]+\)"\s+fill="(#[0-9a-f]{6})" fill-opacity="0\.05"/g)];
  assert.equal(printed.length, 1, 'one oval on the big map — Ray\'s');
  const [, rx, ry, rot] = printed[0];
  assert.ok(Math.abs(-Number(rot) - oval.angleDeg) <= 1, `turned ${-rot}° on paper, ${oval.angleDeg}° on the map`);
  assert.ok(Math.abs(Number(rx) / Number(ry) - oval.majorKm / oval.minorKm) < 0.05, 'and the same shape');
  assert.equal((page1.match(/<circle [^>]*stroke-width="1\.6"/g) || []).length, 1, 'Lou\'s round ring is still a circle');
  assert.match(page1, /his ring is an oval/, 'and the caption says why one ring is not round');
});

test('HIS CARD SAYS HOW LONG AND HOW WIDE — one number would overstate the ground or hide the run', () => {
  const stops = [...corridor(), ...town()];
  const oval = territoryLayer(stops).rings.find((r) => r.label === 'Ray Corridor').circles[0].oval;
  const html = territorySheetHtml({ stops });
  const card = html.slice(html.indexOf('<h3>Ray Corridor'), html.indexOf('</section>', html.indexOf('<h3>Ray Corridor')));
  const long = Math.round(2 * oval.majorKm * 0.621371), wide = Math.round(2 * oval.minorKm * 0.621371);
  assert.ok(card.includes(`about ${long} miles long and ${wide} wide`), `card banner: ${card.match(/about [^<]*/)?.[0]}`);
  assert.equal((card.match(/<ellipse /g) || []).length, 2, 'the oval on his card, over its white halo');
  const lou = html.slice(html.indexOf('<h3>Lou Roundtown'), html.indexOf('</section>', html.indexOf('<h3>Lou Roundtown')));
  assert.match(lou, /about \d+ miles across/, 'a round ring still says how far across');
});

test('A MAN WITH SEVERAL RINGS KEEPS ONE NUMBER THAT BOUNDS THEM ALL — even when one is an oval', () => {
  // The I-985 run AND a round patch round Douglasville, 70km away: an oval and a circle. "20 long
  // and 4 wide" would tell the trainee his second area is smaller than it is.
  const stops = [...work('Ray Corridor', I985, 70, 2), ...work('Ray Corridor', [[33.752, -84.748]], 200, 7)];
  const ray = territoryLayer(stops).rings.find((r) => r.label === 'Ray Corridor');
  assert.equal(ray.circles.length, 2, 'two areas');
  assert.equal(ray.circles.filter((c) => c.oval).length, 1, 'one of them an oval');
  const reach = Math.max(...ray.circles.map((c) => (c.oval ? c.oval.majorKm : c.radiusKm)));
  const html = territorySheetHtml({ stops });
  const card = html.slice(html.indexOf('<h3>Ray Corridor'), html.indexOf('</section>', html.indexOf('<h3>Ray Corridor')));
  assert.ok(card.includes(`about ${Math.round(2 * reach * 0.621371)} miles across`), `card banner: ${card.match(/about [^<]*/)?.[0]}`);
  assert.ok(!card.includes('miles long'), 'no length-and-width for one ring when there are two');
  assert.ok(card.includes('works 2 separate areas'));
  assert.equal((card.match(/<ellipse /g) || []).length, 2, 'the oval over its halo');
  assert.equal((card.match(/<circle [^>]*stroke-width="2\.2"/g) || []).length, 1, 'and the circle');
});

test('A SHEET WITH NO OVAL DRAWS ITS RINGS AS IT ALWAYS HAS — no ellipse, no oval sentence, the same markup', () => {
  const html = territorySheetHtml({ stops: town() });
  assert.ok(!html.includes('<ellipse'), 'nothing is drawn as an oval');
  assert.ok(!html.includes('his ring is an oval'), 'and the caption does not mention one');
  // The circle markup exactly as the sheet printed it before ovals existed — attribute order,
  // precision and line breaks — on page one and on the card. (The whole page was also compared
  // byte for byte against the previous renderer on five fixtures when this was written.)
  const col = RING_PALETTE[0];                               // the only driver, so the first colour
  assert.match(html, new RegExp(`<circle cx="\\d+\\.\\d" cy="\\d+\\.\\d" r="\\d+\\.\\d"\n {6}fill="${col}" fill-opacity="0\\.05" stroke="${col}" stroke-width="1\\.6" stroke-opacity="0\\.95"\/>`));
  assert.match(html, /<circle cx="\d+\.\d" cy="\d+\.\d" r="\d+\.\d" fill="none" stroke="#fff" stroke-width="4\.2" stroke-opacity="0\.85"\/>\n {8}<circle cx="\d+\.\d" cy="\d+\.\d" r="\d+\.\d" fill="#1f4e79" fill-opacity="0\.09" stroke="#1f4e79" stroke-width="2\.2"\/>/);
  assert.match(html, /<span class="muted">· about \d+ miles across<\/span>/);
});

// ── the oval's geometry, for the map ────────────────────────────────────────

test('THE PATH IS THE OVAL — every point on it, the long radius the way it says', () => {
  const ring = { lat: 34.0, lng: -84.0, radiusKm: 9, oval: { majorKm: 12, minorKm: 4, angleDeg: 30 } };
  const path = ovalPath(ring);
  assert.equal(path.length, 72);
  for (const p of path) {
    const on = insideOval({ ...ring, oval: { ...ring.oval, majorKm: 12 * 1.000001, minorKm: 4 * 1.000001 } }, p)
      && !insideOval({ ...ring, oval: { ...ring.oval, majorKm: 12 * 0.999999, minorKm: 4 * 0.999999 } }, p);
    assert.ok(on, `(${p.lat}, ${p.lng}) is not on the oval`);
  }
  const { major, minor } = ovalEnds(ring);
  assert.ok(Math.abs(haversineKm(ring, major) - 12) < 0.12, 'the long radius is 12km on the ground');
  assert.ok(Math.abs(haversineKm(ring, minor) - 4) < 0.04, 'the short radius is 4km');
  const east = (major.lng - ring.lng) * kx(ring.lat), north = (major.lat - ring.lat) * KY;
  assert.ok(Math.abs((Math.atan2(north, east) * 180) / Math.PI - 30) < 0.01, 'and the long way is 30° north of east');
});

test('A RING WHOSE OVAL CANNOT BE READ IS DRAWN ROUND — never as nothing', () => {
  const base = { lat: 34, lng: -84, radiusKm: 9 };
  for (const oval of [undefined, null, {}, { majorKm: 12, minorKm: 0, angleDeg: 30 }, { majorKm: 3, minorKm: 4, angleDeg: 0 },
    { majorKm: NaN, minorKm: 4, angleDeg: 0 }, { majorKm: 12, minorKm: 4 }, { majorKm: '12', minorKm: 4, angleDeg: 0 }]) {
    assert.equal(ovalOf({ ...base, oval }), null, JSON.stringify(oval));
    assert.equal(ovalPath({ ...base, oval }), null);
  }
  assert.deepEqual(ovalOf({ ...base, oval: { majorKm: 12, minorKm: 4, angleDeg: 30 } }), { majorKm: 12, minorKm: 4, angleDeg: 30 });
});

// ── the names, against an oval's edge ───────────────────────────────────────

test('an oval\'s edge is where the oval is — the long way, the short way, and turned', () => {
  assert.equal(ringReach({ r: 50 }, 1.2), 50, 'a circle is its radius every way');
  const flat = { r: 50, rx: 100, ry: 25, rot: 0 };
  assert.ok(Math.abs(ringReach(flat, 0) - 100) < 1e-9);
  assert.ok(Math.abs(ringReach(flat, Math.PI / 2) - 25) < 1e-9);
  assert.ok(Math.abs(ringReach(flat, Math.PI) - 100) < 1e-9);
  const upright = { ...flat, rot: Math.PI / 2 };
  assert.ok(Math.abs(ringReach(upright, 0) - 25) < 1e-9);
  assert.ok(Math.abs(ringReach(upright, -Math.PI / 2) - 100) < 1e-9);
});

test('A LONG FLAT OVAL DOES NOT PUSH ITS NAME ABOVE ITSELF — it walks it along its own length', () => {
  // A tight ring holds the middle. The oval lying east-west has no room above its centre (it is
  // 15px tall there), so the name goes out along it — and stays inside it.
  const VIEW = { width: 800, height: 600 };
  const tight = { id: 'tight', x: 400, y: 300, r: 10, w: 60, h: NAME_H };
  const oval = { id: 'oval', x: 400, y: 300, r: Math.sqrt(300 * 15), rx: 300, ry: 15, rot: 0, w: 80, h: NAME_H };
  const out = placeRingLabels([oval, tight], VIEW);
  assert.deepEqual(out.get('tight'), { x: 400, y: 300 });
  const p = out.get('oval');
  assert.ok(p, 'the oval still gets its name');
  assert.ok(((p.x - 400) / 300) ** 2 + ((p.y - 300) / 15) ** 2 <= 1, `(${p.x}, ${p.y}) is inside the oval`);
});

test('an upright oval names itself inside its own length, not off its side', () => {
  // Three tight rings hold the middle and the spots just above and below it, so the name has to
  // go somewhere along the oval. Laid out as if it were a circle of the same ground, it would land
  // up and off to the side, outside a 40px-wide oval; laid out against the oval, it goes along it.
  const VIEW = { width: 800, height: 600 };
  const tight = (id, y) => ({ id, x: 400, y, r: 10, w: 60, h: NAME_H });
  const oval = { id: 'oval', x: 400, y: 300, r: Math.sqrt(250 * 20), rx: 250, ry: 20, rot: Math.PI / 2, w: 80, h: NAME_H };
  const out = placeRingLabels([oval, tight('mid', 300), tight('above', 283), tight('below', 317)], VIEW);
  const p = out.get('oval');
  assert.ok(p, 'named');
  const u = (p.y - 300), v = -(p.x - 400);                  // along and across the upright oval
  assert.ok((u / 250) ** 2 + (v / 20) ** 2 <= 1, `(${p.x}, ${p.y}) is inside the oval`);
  // …and the same crowd with the oval taken for a circle does put it outside — so the line above
  // is a test of the oval layout, not of a spot the circle layout would also have found.
  const asCircle = placeRingLabels([{ ...oval, rx: undefined, ry: undefined, rot: undefined }, tight('mid', 300), tight('above', 283), tight('below', 317)], VIEW).get('oval');
  assert.ok(asCircle && ((asCircle.y - 300) / 250) ** 2 + ((asCircle.x - 400) / 20) ** 2 > 1, 'a circle-shaped layout would have missed');
});

// ── the map objects ─────────────────────────────────────────────────────────

/** A stand-in google.maps that records every shape it is asked to draw. */
function fakeGoogle() {
  const made = [];
  class Shape { constructor(kind, o) { this.kind = kind; this.o = o; made.push(this); } setMap(m) { this.map = m; } }
  return {
    made,
    google: {
      maps: {
        Circle: class extends Shape { constructor(o) { super('Circle', o); } },
        Polygon: class extends Shape { constructor(o) { super('Polygon', o); } },
        OverlayView: class { setMap() {} },
        LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
        event: { addListener: () => ({ remove() {} }) },
      },
    },
  };
}
const LAYER = {
  rings: [
    { key: 'RAY', label: 'Ray Corridor', colour: '#a4462d', stops: 280, circles: [{ lat: 34.2, lng: -83.9, radiusKm: 12, oval: { majorKm: 14, minorKm: 4, angleDeg: 50 } }] },
    { key: 'LOU', label: 'Lou Roundtown', colour: '#1f4e79', stops: 260, circles: [{ lat: 33.95, lng: -83.99, radiusKm: 8 }] },
    { key: 'BAD', label: 'Bad Oval', colour: '#3f7d3f', stops: 90, circles: [{ lat: 34.0, lng: -84.1, radiusKm: 6, oval: { majorKm: 2, minorKm: 5, angleDeg: 0 } }] },
  ],
};

test('ON THE MAP AN OVAL IS A POLYGON ALONG ITS PATH; a round ring, and a bad oval, are Circles', () => {
  const { google, made } = fakeGoogle();
  const Overlay = makeDriverAreaOverlayClass(google);
  new Overlay(LAYER).attach({});
  assert.equal(made.length, 6, 'a halo and a ring for each of three');
  const kinds = made.map((s) => s.kind);
  assert.deepEqual(kinds, ['Polygon', 'Circle', 'Circle', 'Polygon', 'Circle', 'Circle'], 'all the halos, then all the rings');
  const poly = made[3].o;
  assert.equal(poly.paths.length, 72);
  assert.deepEqual(poly.paths, ovalPath(LAYER.rings[0].circles[0]), 'exactly the oval the layer describes');
  assert.equal(made[4].o.radius, 8000, 'the round ring is its circle, in metres');
  assert.equal(made[5].o.radius, 6000, 'and an oval that cannot be read is drawn as its circle');
});

test('PAINT ONLY, OVALS INCLUDED: nothing takes a click, nothing is filled, all under the routes', () => {
  const { google, made } = fakeGoogle();
  new (makeDriverAreaOverlayClass(google))(LAYER).attach({});
  for (const s of made) {
    assert.equal(s.o.clickable, false, `${s.kind} takes clicks`);
    assert.equal(s.o.zIndex, 0, `${s.kind} is not at zIndex 0`);
    assert.equal(s.o.fillOpacity, 0, `${s.kind} is filled`);
  }
  const halos = made.slice(0, 3), rings = made.slice(3);
  assert.ok(halos.every((s) => s.o.strokeColor === '#ffffff' && s.o.strokeWeight === 5));
  assert.deepEqual(rings.map((s) => s.o.strokeColor), ['#a4462d', '#1f4e79', '#3f7d3f'], 'each ring in its driver\'s colour');
});

test('a Maps build without Polygon draws the oval\'s circle rather than throwing', () => {
  const { google, made } = fakeGoogle();
  delete google.maps.Polygon;
  new (makeDriverAreaOverlayClass(google))(LAYER).attach({});
  assert.deepEqual(made.map((s) => s.kind), Array(6).fill('Circle'));
  assert.equal(made[3].o.radius, 12000, 'Ray\'s circle, the one his ring was earned on');
});
