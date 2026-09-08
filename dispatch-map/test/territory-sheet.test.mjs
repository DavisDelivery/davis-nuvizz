// test/territory-sheet.test.mjs — THE PRINTED SHEET, PINNED AT REAL SCALE.
//
// The first sheet built from Davis's own history was thirty pages nobody could read: fifty-eight
// drivers' circles stacked on one map, names walked into a column down the middle, and a colour
// legend trying to tell 58 people apart with 8 swatches. Every test at the time passed, because
// every test was written against an invented sample of a dozen drivers.
//
// So these tests are written at the scale that broke it, and they pin the SHAPE of the sheet —
// what a reader can find and compare — rather than its markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { territorySheetHtml } from '../src/lib/territory-sheet-html.js';

// A fleet the size of the real one, each driver on his own patch, plus enough stops each to
// clear the minimum. Deterministic: no clock, no randomness.
const NAMES = Array.from({ length: 58 }, (_, i) =>
  // NOT "Driver 3": a trailing number is a LOAD INDEX (canonicalDriver strips it), so numbered
  // fixture names collapse into one man and the fixture stops testing anything.
  `Driver ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
function fleet(n = 58, perDriver = 40) {
  const stops = [];
  for (let d = 0; d < n; d++) {
    const lat = 33.7 + (d % 8) * 0.13;
    const lng = -84.6 + Math.floor(d / 8) * 0.16;
    for (let i = 0; i < perDriver; i++) {
      stops.push({
        driverUserName: NAMES[d], driverName: NAMES[d],
        zip: String(30000 + d), city: `TOWN${d}`,
        lat: lat + (i % 6) * 0.004, lng: lng + Math.floor(i / 6) * 0.004,
        boardDate: `2026-08-${String(10 + (i % 15)).padStart(2, '0')}`,
      });
    }
  }
  return stops;
}
const countOf = (html, needle) => html.split(needle).length - 1;

test('ONE CARD PER DRIVER — not one map with fifty-eight men on it', () => {
  const html = territorySheetHtml({ stops: fleet(), window: { from: '2026-08-10', to: '2026-09-04' } });
  assert.equal(countOf(html, 'class="card"'), 58, 'every active driver gets his own card');
  for (const d of [0, 17, 57]) assert.ok(html.includes(NAMES[d]), `${NAMES[d]} is on the sheet`);
  // The thing that made it unreadable, gone: no per-driver colour key to decode.
  assert.ok(!html.includes('class="legend"'), 'no colour legend to tell 58 people apart with 8 swatches');
});

test('EVERY CARD IS THE SAME MAP AT THE SAME SCALE, or the cards cannot be compared', () => {
  // Fit each map to its own driver and all fifty-eight look identical: one blob in one square.
  // A trainee learns nothing from that. The shared frame is the whole point of small maps.
  const html = territorySheetHtml({ stops: fleet() });
  const boxes = [...html.matchAll(/viewBox="0 0 (\d+) (\d+)"/g)].map((m) => `${m[1]}x${m[2]}`);
  assert.ok(boxes.length >= 59, 'the overview plus one map per driver');
  const cardBoxes = new Set(boxes.slice(1));
  assert.equal(cardBoxes.size, 1, `every card map shares one projection, saw ${[...cardBoxes].join(', ')}`);
});

test('A MAP IS GIVEN A HEIGHT BUDGET, because break-inside does not shrink — it MOVES', () => {
  // Sized by width alone the overview came out 195mm tall, would not fit under the header, and
  // page one printed as a title over 200mm of white paper with the map alone on page two.
  const html = territorySheetHtml({ stops: fleet() });
  const heights = [...html.matchAll(/height="([\d.]+)mm"/g)].map((m) => Number(m[1]));
  assert.ok(heights.length, 'maps declare their printed height');
  assert.ok(Math.max(...heights) <= 130, `tallest map is ${Math.max(...heights)}mm, which must fit a letter page with a header`);
});

test('a driver with no coordinates is SAID to have none, never drawn as an empty square', () => {
  const stops = fleet(3);
  for (const s of stops) if (s.driverUserName === NAMES[1]) { delete s.lat; delete s.lng; }
  const html = territorySheetHtml({ stops });
  assert.ok(html.includes('No coordinates for this driver'), 'the card says why it has no map');
  assert.equal(countOf(html, 'class="card"'), 3, 'and he still gets his card and his ZIP list');
});

test('a ring says how many miles across it is — a picture at fleet scale cannot', () => {
  const html = territorySheetHtml({ stops: fleet(4) });
  assert.match(html, /about \d+ miles across/, 'the size is printed, not left to the eye');
});

test('the sheet escapes what it prints — a driver name is vendor data, not markup', () => {
  const stops = fleet(2).map((s) => (s.driverUserName === NAMES[0]
    ? { ...s, driverUserName: '<script>x</script>', driverName: '<script>x</script>' } : s));
  const html = territorySheetHtml({ stops });
  assert.ok(!html.includes('<script>x</script>'), 'no raw markup from a driver name');
  assert.ok(html.includes('&lt;script&gt;'), 'it is shown, escaped');
});

test('no stops at all: a sheet that says so rather than one that draws an empty map', () => {
  const html = territorySheetHtml({ stops: [] });
  assert.ok(html.includes('No coordinates in this window'), 'the overview explains itself');
  assert.equal(countOf(html, 'class="card"'), 0);
  assert.ok(html.includes('<h1>'), 'and it is still a page, not a crash');
});

test('COLIN/DJ 1 reaches the TABLES too, not just the map', () => {
  // The sheet re-derived the driver key inline — uppercase, spaces to underscores — which is
  // what the key looks like for most names and is NOT what canonicalDriver does. "COLIN/DJ 1"
  // became COLIN/DJ_1, matched no active driver, and his second load dropped out of the town
  // table and his own card while driverCircles (which asks properly) still drew those stops.
  // Half the sheet disagreeing with the other half, and nothing on the page saying so.
  const base = fleet(2);
  const colin = [];
  for (let i = 0; i < 40; i++) colin.push({
    driverUserName: 'COLIN', driverName: 'COLIN', zip: '30518', city: 'BUFORD',
    lat: 34.12 + (i % 6) * 0.004, lng: -84.00 + Math.floor(i / 6) * 0.004, boardDate: '2026-08-20',
  });
  for (let i = 0; i < 20; i++) colin.push({
    driverUserName: 'COLIN/DJ 1', driverName: 'COLIN/DJ 1', zip: '30519', city: 'BUFORD',
    lat: 34.13 + (i % 5) * 0.004, lng: -84.01 + Math.floor(i / 5) * 0.004, boardDate: '2026-08-21',
  });
  const html = territorySheetHtml({ stops: [...base, ...colin] });
  assert.ok(html.includes('>30519<'), 'the second load\'s ZIP is on the sheet');
  assert.match(html, /<h3>COLIN [\s\S]{0,60}?60 stops · 2 ZIP codes/,
    'and both loads count as one man with sixty stops, not two men with half a territory each');
  assert.equal(html.split('<h3>COLIN').length - 1, 1, 'exactly one Colin, not one per load');
});
