// test/driver-area-overlay.test.mjs — THE TRAINEE'S RINGS ON THE LIVE MAP: names that can be
// read, a switch that always says what it is showing, and a board that behaves the same with it on.
//
// Chad, 2026-09-27: "we were going to build an overlay for the map that we could toggle on and off."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  placeRingLabels, driverAreasStatus, fmtDay, fmtWindow, NAME_H, DRIVER_AREAS_URL, DRIVER_AREAS_WEEKS,
} from '../src/lib/driver-area-overlay.js';
import { DEVICE_SWITCHES } from '../src/lib/device-switches.js';

const VIEW = { width: 800, height: 600 };
const item = (id, x, y, r, w = 80) => ({ id, x, y, r, w, h: NAME_H });
const overlaps = (a, b, wa, wb) => Math.abs(a.x - b.x) < (wa + wb) / 2 && Math.abs(a.y - b.y) < NAME_H;

// ── where the names go ──────────────────────────────────────────────────────

test('THE SMALLEST RING PLACES ITS NAME FIRST — a small ring is the most specific claim on the map', () => {
  // Two rings centred on the same spot: the tight one keeps the middle, the wide one's name moves
  // above or below its own centre — still inside its own ring.
  const out = placeRingLabels([item('wide', 400, 300, 200), item('tight', 400, 300, 20)], VIEW);
  assert.deepEqual(out.get('tight'), { x: 400, y: 300 });
  const wide = out.get('wide');
  assert.ok(wide, 'the wide ring still gets its name');
  assert.equal(wide.x, 400);
  assert.ok(Math.abs(wide.y - 300) < 200, 'and it is inside its own ring');
});

test('a name that would collide and has nowhere inside its ring to go is left off AT THIS ZOOM', () => {
  const out = placeRingLabels([item('a', 400, 300, 10), item('b', 405, 302, 12)], VIEW);
  assert.ok(out.has('a'));
  assert.ok(!out.has('b'), 'b waits for the reader to zoom in');
});

test('NO TWO NAMES EVER OVERLAP — fifty-odd rings over one metro, the real crowd', () => {
  const items = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 56; i++) items.push(item(i, 150 + rnd() * 500, 120 + rnd() * 360, 15 + rnd() * 120, 50 + Math.round(rnd() * 60)));
  const out = placeRingLabels(items, VIEW);
  const placed = [...out].map(([id, p]) => ({ ...p, w: items[id].w }));
  assert.ok(placed.length >= 10, `only ${placed.length} names fit — the placer is too timid`);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.ok(!overlaps(placed[i], placed[j], placed[i].w, placed[j].w), `names ${i} and ${j} overlap`);
    }
  }
  for (const p of placed) {
    assert.ok(p.x - p.w / 2 >= 0 && p.x + p.w / 2 <= VIEW.width && p.y - NAME_H / 2 >= 0 && p.y + NAME_H / 2 <= VIEW.height, 'every name is wholly on screen');
  }
});

test('A RING WHOSE MIDDLE IS OFF-SCREEN PUTS ITS NAME ON THE ARC YOU CAN SEE', () => {
  // Zoomed into one town the rings are arcs. Centre 300px left of the view, radius 500px: the arc
  // crosses the screen, and the name sits just inside it, toward the middle of the view.
  const it = item('arc', -300, 300, 500);
  const p = placeRingLabels([it], VIEW).get('arc');
  assert.ok(p, 'the arc is named');
  const d = Math.hypot(p.x - it.x, p.y - it.y);
  assert.ok(d < it.r && d > it.r - 3 * NAME_H, `on the ring, just inside it (distance ${d.toFixed(0)} of ${it.r})`);
  assert.ok(p.x >= 0 && p.x <= VIEW.width, 'and on screen');
});

test('A CROWDED OR EDGE-HUGGING CENTRE FALLS BACK TO ITS OWN ARC rather than going nameless', () => {
  // Centre 5px from the left edge, ring 400px wide: the centre cannot hold a whole name, the arc can.
  const it = item('edge', 5, 300, 400);
  const p = placeRingLabels([it], VIEW).get('edge');
  assert.ok(p, 'named on its arc');
  const d = Math.hypot(p.x - it.x, p.y - it.y);
  assert.ok(Math.abs(d - (it.r - NAME_H)) < 1, 'just inside the ring');
  // Two rings with one centre, the second too small to nudge above or below: it tries its arc.
  const out = placeRingLabels([item('small', 400, 300, 20), item('mid', 400, 300, 36)], VIEW);
  assert.ok(out.has('small') && out.has('mid'), 'both named');
});

test('an arc that only crosses a corner of the view is still tried from either side', () => {
  // Centre off the top-left corner; the point of the ring nearest the view's middle is off-screen
  // below-right, but the arc sweeps across the top-left corner where a name fits.
  const it = item('corner', -150, -150, 330);
  const p = placeRingLabels([it], VIEW).get('corner');
  assert.ok(p, 'named');
  assert.ok(p.x >= 0 && p.y >= 0);
});

test('a ring nowhere near the view gets no name — nothing is drawn off the edge', () => {
  assert.equal(placeRingLabels([item('far', -5000, -5000, 50)], VIEW).size, 0);
  assert.equal(placeRingLabels([item('edge', 2, 300, 40)], VIEW).size, 0, 'a name that would hang off the edge waits');
});

test('the same rings at the same view always lay out the same way', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(i, 100 + (i * 37) % 600, 100 + (i * 53) % 400, 10 + (i * 7) % 90));
  assert.deepEqual([...placeRingLabels(items, VIEW)], [...placeRingLabels([...items].reverse(), VIEW)]);
});

test('a map that has not laid out yet, and malformed rings, place nothing rather than throw', () => {
  assert.equal(placeRingLabels([item('a', 10, 10, 10)], { width: 0, height: 0 }).size, 0);
  assert.equal(placeRingLabels([{ id: 'x', x: NaN, y: 1, r: 1, w: 1, h: 1 }, null], VIEW).size, 0);
  assert.equal(placeRingLabels(undefined, VIEW).size, 0);
});

// ── what the switch says ─────────────────────────────────────────────────────

const LAYER = {
  ok: true,
  window: { from: '2026-08-31', to: '2026-09-25', weeks: 4, businessDays: 20 },
  rings: Array.from({ length: 51 }, (_, i) => ({ key: `D${i}`, label: `Driver ${i}`, colour: '#1f4e79', stops: 100, circles: [{ lat: 34, lng: -84, radiusKm: 10 }] })),
  noRing: [
    { key: 'RASKO_SULJIC', label: 'Rasko Suljic', why: 'spread out' },
    { key: 'SEYMOUR_WATTS', label: 'Seymour Watts', why: 'spread out' },
  ],
  readFailures: [],
};

test('OFF, it says what it would show — so the switch explains itself before anybody flips it', () => {
  const s = driverAreasStatus({ on: false });
  assert.equal(s.tone, 'muted');
  assert.match(s.lines[0], /Rings round where drivers usually deliver/);
  assert.match(s.lines[0], new RegExp(`last ${DRIVER_AREAS_WEEKS} weeks`));
});

test('ON AND LOADING says it is reading — an empty map is never left to mean "no drivers"', () => {
  assert.match(driverAreasStatus({ on: true, status: 'loading' }).lines[0], /Reading the last 4 weeks/);
  assert.match(driverAreasStatus({ on: true, status: 'idle' }).lines[0], /Reading/);
});

test('READY names the count and the dates in words — never an ISO date', () => {
  const s = driverAreasStatus({ on: true, status: 'ready', layer: LAYER });
  assert.equal(s.lines[0], '51 drivers · Aug 31 – Sep 25, 2026 — usual areas, not today\'s routes. Zoom in to see more names.');
  assert.ok(!s.lines.join(' ').match(/\d{4}-\d{2}-\d{2}/), 'no 2026-09-25 anywhere');
});

test('the dates are the days the rings are BUILT FROM — today has no history until tonight', () => {
  // The window runs to today, but the nightly capture files ET-yesterday, so the last day with
  // deliveries read is Friday the 25th on a Monday the 28th.
  const layer = { ...LAYER, window: { from: '2026-09-01', to: '2026-09-28' }, dataWindow: { from: '2026-09-01', to: '2026-09-25' } };
  assert.equal(driverAreasStatus({ on: true, status: 'ready', layer }).lines[0], '51 drivers · Sep 1 – Sep 25, 2026 — usual areas, not today\'s routes. Zoom in to see more names.');
});

test('who has NO ring is named, with the reason — Chad\'s own caveat about Rasko, said on screen', () => {
  const s = driverAreasStatus({ on: true, status: 'ready', layer: LAYER });
  assert.ok(s.lines.includes('No ring — work too spread out for one: Rasko Suljic, Seymour Watts.'));
  const many = { ...LAYER, noRing: ['A', 'B', 'C', 'D', 'E', 'F'].map((l) => ({ label: l, why: 'spread out' })) };
  assert.ok(driverAreasStatus({ on: true, status: 'ready', layer: many }).lines.some((l) => l.endsWith('A, B, C, D +2 more.')));
  const unplaced = { ...LAYER, noRing: [{ label: 'Nomap Driver', why: 'no coordinates' }, { label: 'Tight Guy', why: 'few coordinates', mapped: 2, stops: 40 }] };
  const u = driverAreasStatus({ on: true, status: 'ready', layer: unplaced }).lines;
  assert.ok(u.includes('No ring — no stops with a map position: Nomap Driver.'));
  assert.ok(u.includes('No ring — too few stops with a map position: Tight Guy (2 of 40).'), 'said as a count, never as "spread out"');
});

test('A FAILED READ IS RED AND SAYS HOW TO TRY AGAIN; a partial window is amber and says so', () => {
  const e = driverAreasStatus({ on: true, status: 'error', error: 'HTTP 502' });
  assert.equal(e.tone, 'error');
  assert.match(e.lines[0], /Couldn't load driver areas \(HTTP 502\)\. Turn it off and on to try again\./);
  const partial = driverAreasStatus({ on: true, status: 'ready', layer: { ...LAYER, readFailures: [{ date: '2026-09-07', error: 'x' }] } });
  assert.equal(partial.tone, 'warn');
  assert.ok(partial.lines.some((l) => /1 day of history could not be read/.test(l)));
});

test('ready with nothing to draw says THAT, in amber — not a quiet empty map', () => {
  const s = driverAreasStatus({ on: true, status: 'ready', layer: { ...LAYER, rings: [], noRing: [], coverage: { deliveries: 0 } } });
  assert.equal(s.tone, 'warn');
  assert.match(s.lines[0], /No delivery history came back/);
});

test('HISTORY THAT CAME BACK WITH NOBODY RINGED is not "no history" — it says how much came back', () => {
  const s = driverAreasStatus({ on: true, status: 'ready', layer: { ...LAYER, rings: [], coverage: { deliveries: 1234 } } });
  assert.equal(s.tone, 'warn');
  assert.equal(s.lines[0], '1,234 deliveries came back (Aug 31 – Sep 25, 2026), but no driver has a settled area to ring.');
  assert.ok(s.lines.some((l) => l.startsWith('No ring — work too spread out')), 'and who was looked at, and why');
});

test('WHO WAS LEFT OUT IS NAMED — stopped running or too few stops, never silently missing', () => {
  const layer = { ...LAYER, excluded: [{ label: 'Terry Gambrell', why: 'stopped running' }, { label: 'Brandi Bradberry', why: 'too few' }] };
  assert.ok(driverAreasStatus({ on: true, status: 'ready', layer }).lines
    .includes('Not shown — stopped running or too few stops: Terry Gambrell, Brandi Bradberry.'));
});

test('dates read "Mon D, YYYY", with the year on both ends when a window crosses New Year', () => {
  assert.equal(fmtDay('2026-09-25'), 'Sep 25');
  assert.equal(fmtDay('2026-09-25', true), 'Sep 25, 2026');
  assert.equal(fmtWindow({ from: '2025-12-29', to: '2026-01-23' }), 'Dec 29, 2025 – Jan 23, 2026');
  assert.equal(fmtDay('2026-13-01'), '');
  assert.equal(fmtWindow({ from: 'x', to: '2026-01-23' }), '');
});

// ── the wiring: both views, one store, and nothing that takes a click ────────

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const OVERLAY = readFileSync(new URL('../src/lib/driver-area-overlay.js', import.meta.url), 'utf8');
/** The source of one top-level function in App.jsx. */
function bodyOf(name) {
  const at = APP.indexOf(`\nfunction ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const next = APP.indexOf('\nfunction ', at + 10);
  return APP.slice(at, next > 0 ? next : undefined);
}

test('TWO VIEWS: the switch is in the desktop Filters card AND the phone\'s Filters → Map display', () => {
  assert.ok(bodyOf('FilterToolbar').includes('<DriverAreasControl'), 'desktop Filters card');
  assert.ok(bodyOf('MobileFiltersTab').includes('<DriverAreasControl'), 'phone Filters tab');
  assert.ok(bodyOf('MapScreen').includes('useDriverAreasOnMap('), 'and the Map tab draws it');
});

test('NOT ON THE WALL — its map cannot zoom, so the names that appear on zoom never would', () => {
  assert.match(bodyOf('FilterToolbar'), /\{!onWall && <DriverAreasControl \/>\}/);
  const map = bodyOf('MapScreen');
  assert.match(map, /useDriverAreasData\(driverAreasOn && !tvMode\)/, 'the wall does not even read the rings');
  assert.match(map, /on: driverAreasOn && !tvMode/, 'nor draw them');
  // The wall's own Filters card is the one that says so.
  assert.match(map, /setTvLiveMap=\{setTvLiveMap\}\s*\n\s*onWall\s*\n/);
});

test('PAINT ONLY: no ring takes a click and no name can sit between a finger and a pin', () => {
  const circles = [...OVERLAY.matchAll(/new google\.maps\.Circle\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.equal(circles.length, 2, 'the halo and the ring');
  assert.match(OVERLAY, /clickable: false/, 'rings are clickable:false');
  assert.match(OVERLAY, /pointer-events:none/, 'the names let clicks through');
  assert.ok(!/addListener\([^)]*'click'/.test(OVERLAY), 'and nothing here listens for a click');
});

test('the switch is registered for Diagnostics, default OFF, under the key the app reads', () => {
  const sw = DEVICE_SWITCHES.find((s) => s.key === 'dispatchMap.driverAreas');
  assert.ok(sw, 'registered');
  assert.equal(sw.dflt, false, 'default OFF — a reference for learning the board, not everybody\'s map');
  assert.ok(APP.includes("localStorage.getItem('dispatchMap.driverAreas') === 'on'"), 'only the explicit on turns it on');
});

test('the map asks for exactly four weeks of rings, and only the rings', () => {
  assert.equal(DRIVER_AREAS_URL, '/.netlify/functions/driver-territory?format=layer&weeks=4');
});
