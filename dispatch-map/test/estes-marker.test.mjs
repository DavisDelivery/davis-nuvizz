// test/estes-marker.test.mjs — Estes orders draw BLACK with a YELLOW RING on the map.
//
// Chad: "make estes icons black with a yellow ring around them." Two kinds of pin here:
//   • the DISC BUILDERS (circleMarkerSvg / unplannedDotSvg) are run for real through the
//     helper and the SVG read back — the ring must be the disc's edge, the fill must stay the
//     caller's, and a disc built WITHOUT a ring must be byte-identical to before;
//   • the PRECEDENCE (which states take the black, which keep their own paint) is exercised by
//     BUILDING REAL MARKERS through the shipped stopMarkerIcon and reading the colour back out
//     of the SVG. It used to be pinned by reading App.jsx for the right words — and v0.97.2
//     shipped with every word present and the colour still wrong on half the board, because the
//     black sat at the END of the fill chain: an UNPLANNED stop carries its own purple and
//     answered first, while SCHEDULED (colour null) fell through to the black. Source text
//     cannot show the order a `||` chain answers in. A built marker can, so these build one.
// Plus the Legend: its Carrier row may only claim stops whose ring is actually on the map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDiscPipeline, loadStopMarkerIcon, markerSvg } from './helpers/app-markers.mjs';
import { buildLegendInventory, emptyLegendInventory } from '../src/lib/map-legend.js';
import { ESTES_FILL, ESTES_RING } from '../src/lib/carrier-mark.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const STOP_MARKER_ICON = APP.slice(
  APP.indexOf('function stopMarkerIcon('),
  APP.indexOf('\n// Live-driver truck marker size'),
);
// Comments are prose between the branches; the rule is the code. Strip them before flattening.
const flat = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');

// ── the discs themselves ──────────────────────────────────────────────────────

test('circleMarkerSvg: a ring takes the disc’s edge — black fill, yellow ring, drawn heavier', async () => {
  const { circleMarkerSvg } = await loadDiscPipeline();
  const svg = markerSvg({ url: circleMarkerSvg(ESTES_FILL, { ring: ESTES_RING }) });
  assert.match(svg, /<circle cx="14" cy="14" r="12\.5" fill="#000000" stroke="#facc15" stroke-width="3"\/>/);
  assert.match(svg, /<circle cx="14" cy="14" r="4\.5" fill="white"\/>/, 'the white core still reads on black');
});

test('circleMarkerSvg: the ring never changes the fill — a route-coloured numbered pin keeps its route colour', async () => {
  const { circleMarkerSvg } = await loadDiscPipeline();
  const svg = markerSvg({ url: circleMarkerSvg('#2563eb', { label: '7', ring: ESTES_RING }) });
  assert.match(svg, /fill="#2563eb" stroke="#facc15" stroke-width="3"/);
  assert.match(svg, />7<\/text>/, 'the sequence number is still on it');
});

test('circleMarkerSvg: without a ring the disc is exactly what it was (white edge, 2px; hollow keeps its colour edge)', async () => {
  const { circleMarkerSvg } = await loadDiscPipeline();
  const plain = markerSvg({ url: circleMarkerSvg('#4285F4') });
  assert.match(plain, /fill="#4285F4" stroke="#ffffff" stroke-width="2"\/>/);
  const hollow = markerSvg({ url: circleMarkerSvg('#64748b', { hollow: true }) });
  assert.match(hollow, /fill="#ffffff" stroke="#64748b" stroke-width="2\.5"\/>/);
  assert.equal(circleMarkerSvg('#4285F4'), circleMarkerSvg('#4285F4', { ring: null }), 'ring:null is the same disc');
});

test('unplannedDotSvg: the resting Estes dot is a black core in a yellow wrap; without a ring the wrap stays white', async () => {
  const { unplannedDotSvg } = await loadDiscPipeline();
  const estes = markerSvg({ url: unplannedDotSvg(ESTES_FILL, { ring: ESTES_RING }) });
  assert.match(estes, /<circle cx="12" cy="12" r="11" fill="#facc15" stroke="#0f172a"/);
  assert.match(estes, /<circle cx="12" cy="12" r="8" fill="#000000"\/>/);
  const plain = markerSvg({ url: unplannedDotSvg('#6d28d9') });
  assert.match(plain, /<circle cx="12" cy="12" r="11" fill="#ffffff" stroke="#0f172a" stroke-opacity="0\.28"/);
  assert.match(plain, /<circle cx="12" cy="12" r="8" fill="#6d28d9"\/>/);
});

test('unplannedDotSvg: the co-located count still sits inside an Estes dot, in white', async () => {
  const { unplannedDotSvg } = await loadDiscPipeline();
  const svg = markerSvg({ url: unplannedDotSvg(ESTES_FILL, { ring: ESTES_RING, count: 3 }) });
  assert.match(svg, /fill="#ffffff" text-anchor="middle" letter-spacing="-0\.5">3<\/text>/);
});

// ── the precedence, built for real ────────────────────────────────────────────

const stop = (stopNbr, normalizedStatus = 'UNPLANNED', extra = {}) => ({ stopNbr, normalizedStatus, isPlanned: normalizedStatus !== 'UNPLANNED', ...extra });
/** The disc's own fill: the unplanned dot's core, else the circle marker's body. */
const bodyFill = (svg) => (/r="8" fill="(#[0-9a-fA-F]{6})"/.exec(svg) || /r="12\.5" fill="(#[0-9a-fA-F]{6}|#ffffff)"/.exec(svg) || [])[1];
/** The ring: the dot's wrap colour, else the circle marker's stroke. */
const ringOf = (svg) => (/r="11" fill="(#[0-9a-fA-F]{6})"/.exec(svg) || /r="12\.5" fill="[^"]*" stroke="(#[0-9a-fA-F]{6})"/.exec(svg) || [])[1];
const YELLOW = ESTES_RING.toLowerCase();
const paint = (icon, s, note = null, opts = {}) => {
  const spec = icon(s, note, opts);
  const svg = markerSvg(spec);
  return { fill: (bodyFill(svg) || '').toLowerCase(), ring: (ringOf(svg) || '').toLowerCase(), size: spec.scaledSize.width, svg };
};

test('THE REPORTED BUG: an UNPLANNED Estes order draws a BLACK centre in the yellow ring, not the pool purple', async () => {
  const icon = await loadStopMarkerIcon();
  const p = paint(icon, stop('ESTES-0538243875', 'UNPLANNED'));
  assert.equal(p.fill, '#000000', 'the centre is black — this read #6d28d9 in v0.97.2');
  assert.equal(p.ring, YELLOW);
  assert.equal(p.size, 16, 'and it is still the small resting dot — the paint never changes the footprint');
});

test('a plain unplanned order is untouched: pool purple in the white wrap', async () => {
  const icon = await loadStopMarkerIcon();
  const p = paint(icon, stop('007172492', 'UNPLANNED'));
  assert.equal(p.fill, '#6d28d9');
  assert.equal(p.ring, '#ffffff');
});

test('the RESTING states take the black; the LIVE execution states keep their own colour — and every one of them wears the ring', async () => {
  const icon = await loadStopMarkerIcon();
  const want = {
    UNPLANNED: '#000000',    // resting — the pool
    SCHEDULED: '#000000',    // resting — planned, nothing has happened yet
    OUT_FOR_DEL: '#2563eb',  // live — where the order IS
    ARRIVED: '#d97706',
    DELIVERED: '#15803d',
    EXCEPTION: '#f97316',
  };
  for (const [status, fill] of Object.entries(want)) {
    const p = paint(icon, stop('ESTES-1', status));
    assert.equal(p.fill, fill, `${status} fill`);
    assert.equal(p.ring, YELLOW, `${status} keeps the identity ring`);
    // The same stop without the Estes number keeps the vanilla colour and no ring.
    const plain = paint(icon, stop('007172492', status));
    assert.equal(plain.ring, '#ffffff', `${status}: a non-Estes stop is unchanged`);
  }
});

test('a colour that already means something still wins the disc: selection, search hit, priority flag, eligibility', async () => {
  const icon = await loadStopMarkerIcon();
  const cases = [
    ['selected', {}, { matched: true }, '#f59e0b'],
    ['search hit', {}, { searchMatched: true }, '#c2410c'],
    ['red priority flag', { priority_flag: 'red' }, {}, '#dc2626'],
    ['tractor-OK', { vehicle_eligibility: 'tractor' }, {}, '#16a34a'],
    ['box-only', { vehicle_eligibility: 'box_only' }, {}, '#dc2626'],
  ];
  for (const [label, note, opts, fill] of cases) {
    const p = paint(icon, stop('ESTES-1', 'UNPLANNED'), note, opts);
    assert.equal(p.fill, fill, `${label} keeps its fill`);
    assert.equal(p.ring, YELLOW, `${label} still carries the ring`);
  }
});

test('a numbered route pin: black on the Map when nothing has happened yet, the ROUTE colour on Routing — ringed either way', async () => {
  const icon = await loadStopMarkerIcon();
  const map = paint(icon, stop('ESTES-1', 'SCHEDULED'), null, { inRoute: true, seq: 4 });
  assert.equal(map.fill, '#000000');
  assert.equal(map.ring, YELLOW);
  assert.match(map.svg, />4<\/text>/, 'the sequence number is still on it');
  const routing = paint(icon, stop('ESTES-1', 'SCHEDULED'), null, { inRoute: true, seq: 4, routeColor: '#2563eb' });
  assert.equal(routing.fill, '#2563eb', 'a route colour is the whole point of a numbered pin');
  assert.equal(routing.ring, YELLOW);
});

test('the already-planned muted pin goes quiet the Estes way: white disc, yellow ring, black core', async () => {
  const icon = await loadStopMarkerIcon();
  const p = paint(icon, stop('ESTES-1', 'SCHEDULED'), null, { plannedMuted: true });
  assert.equal(p.size, 14, 'still the quietest pin on the map');
  assert.equal(p.ring, YELLOW);
  assert.match(p.svg, /r="4\.5" fill="#000000"/, 'the core carries the black');
  const plain = paint(icon, stop('007172492', 'SCHEDULED'), null, { plannedMuted: true });
  assert.equal(plain.ring, '#64748b', 'a non-Estes muted pin is the slate ring it always was');
});

test('do-not-send stays the red ✕ — safety outranks identity, so no ring and no black', async () => {
  const icon = await loadStopMarkerIcon();
  const p = paint(icon, stop('ESTES-1', 'UNPLANNED'), { do_not_send: true });
  assert.equal(p.fill, '#dc2626');
  assert.equal(p.ring, '#ffffff');
  assert.match(p.svg, /M10 10l8 8M18 10l-8 8/, 'the ✕ is drawn');
});

test('a stop drawing restriction marks keeps them, pixel for pixel — the clock is the message there', async () => {
  const icon = await loadStopMarkerIcon();
  const note = { equipment_restrictions: ['no_tractor_trailer'] };
  const e = markerSvg(icon(stop('ESTES-1', 'UNPLANNED'), note));
  const plain = markerSvg(icon(stop('007172492', 'UNPLANNED'), note));
  assert.equal(e, plain, 'the Estes paint never reaches the icon cluster');
  assert.equal(/facc15/.test(e), false, 'and no ring is drawn around it');
});

test('the icon cache cannot hand an Estes order a plain stop’s pin — same inputs, different paint', async () => {
  const icon = await loadStopMarkerIcon();
  const plain = paint(icon, stop('007172492', 'UNPLANNED'));
  const estes = paint(icon, stop('ESTES-1', 'UNPLANNED'));
  assert.notEqual(plain.svg, estes.svg);
  assert.equal(paint(icon, stop('ESTES-2', 'UNPLANNED')).svg, estes.svg, 'two Estes orders in the same state DO share one cached icon');
});

test('the rule is read off the stop number and computed once, and the cache key carries it', () => {
  assert.match(STOP_MARKER_ICON, /const estes = isEstesOrder\(s\?\.stopNbr\);/);
  assert.equal((STOP_MARKER_ICON.match(/isEstesOrder\(/g) || []).length, 1, 'computed once — a second call site is how this drifts');
  assert.match(STOP_MARKER_ICON, /\+ '\\x1f' \+ \(estes \? 'E' : ''\);/);
  assert.match(STOP_MARKER_ICON, /const estesFill = estes && \(statusKind === 'UNPLANNED' \|\| statusKind === 'SCHEDULED'\) \? ESTES_FILL : null;/,
    'the resting-state rule lives in ONE place, not repeated per branch');
});

// ── the Legend’s Carrier row ──────────────────────────────────────────────────

test('the legend tallies the stops whose ring is on the map: plain, numbered and muted count; DNS and restriction clusters do not', () => {
  const inv = buildLegendInventory([
    { estes: true, dns: false, hidden: false, icons: [], note: null },                          // resting Estes dot — ring
    { estes: true, dns: false, hidden: true, icons: [], note: null },                           // numbered / muted — ring
    { estes: true, dns: true, hidden: true, icons: [], note: { do_not_send: true } },            // red ✕ — no ring
    { estes: true, dns: false, hidden: false, icons: ['no_tractor_trailer'], note: null },      // cluster — no ring
    { estes: false, dns: false, hidden: false, icons: [], note: null },                         // not Estes
  ]);
  assert.equal(inv.estes, 2);
  assert.equal(inv.stops, 5, 'every row is still a stop');
  assert.equal(emptyLegendInventory().estes, 0);
});

test('legacy entries without the new fields still count as before — nothing is invented', () => {
  const inv = buildLegendInventory([{ hidden: false, icons: [], note: null }, { hidden: true, icons: [], note: null }]);
  assert.equal(inv.estes, 0);
  assert.equal(inv.hiddenByPin, 1);
});

test('the marker layer hands the legend the same two facts the pin used (dns + the order number)', () => {
  const hook = APP.slice(APP.indexOf('function useLegendInventory('), APP.indexOf('function LegendMarkerExample('));
  assert.match(hook, /dns,\s*\n\s*estes: isEstesOrder\(s\.stopNbr\),/);
  const legend = APP.slice(APP.indexOf('function MapLegendBody('), APP.indexOf('function MapLegendBody(') + 12000);
  assert.match(legend, /has\(inv && inv\.estes\)/, 'the Carrier row is gated on the tally, like every other row');
  assert.match(legend, /Estes order — black, yellow ring/);
});
