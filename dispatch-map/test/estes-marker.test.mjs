// test/estes-marker.test.mjs — Estes orders draw BLACK with a YELLOW RING on the map.
//
// Chad: "make estes icons black with a yellow ring around them." Two kinds of pin here:
//   • the DISC BUILDERS (circleMarkerSvg / unplannedDotSvg) are run for real through the
//     helper and the SVG read back — the ring must be the disc's edge, the fill must stay the
//     caller's, and a disc built WITHOUT a ring must be byte-identical to before;
//   • the PRECEDENCE inside stopMarkerIcon (which states carry the ring, which keep their own
//     paint) is pinned as rules over the shipped source, the way the tractor-paint tests are —
//     stopMarkerIcon needs google.maps and the whole note pipeline, which node:test cannot mount.
// Plus the Legend: its Carrier row may only claim stops whose ring is actually on the map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDiscPipeline, markerSvg } from './helpers/app-markers.mjs';
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

// ── the precedence, pinned on the shipped source ──────────────────────────────

test('stopMarkerIcon reads the Estes fact off the stop NUMBER and folds it into the icon cache key', () => {
  assert.match(STOP_MARKER_ICON, /const estes = isEstesOrder\(s\?\.stopNbr\);/);
  assert.match(STOP_MARKER_ICON, /const ring = estes \? ESTES_RING : null;/);
  assert.match(STOP_MARKER_ICON, /\+ '\\x1f' \+ \(estes \? 'E' : ''\);/, 'an Estes order and a plain one must never share a cached icon');
});

test('the ring rides every disc — resting dot, scheduled pin, numbered route pin, muted ring', () => {
  assert.match(STOP_MARKER_ICON, /unplannedDotSvg\(color, \{ glyph, count, ring \}\)/);
  assert.match(STOP_MARKER_ICON, /circleMarkerSvg\(color, \{ hollow: hi \? false : meta\.hollow, glyph, tag, count, ring \}\)/);
  assert.match(STOP_MARKER_ICON, /circleMarkerSvg\(color, \{ label: String\(seq\), count, ring \}\)/);
  assert.match(STOP_MARKER_ICON, /circleMarkerSvg\(estes \? ESTES_FILL : PLANNED_MUTED_COLOR, \{ hollow: true, count, ring \}\)/);
});

test('black fills only the DEFAULT tint — every colour that already means something keeps the disc', () => {
  // The status/flag fallback is the last resort on both the plain pin and the numbered pin;
  // the Estes black replaces exactly that and nothing ahead of it in the chain.
  assert.match(flat(STOP_MARKER_ICON), /: eligColor \|\| flagHue \|\| \(addressOff \? ADDRESS_OFF_TINT : \(meta\.color \|\| \(estes \? ESTES_FILL : flagColor\(note\)\)\)\);/);
  assert.match(STOP_MARKER_ICON, /routeColor \|\| \(\(tractorDelivered && !noTractorOverride\) \? TRACTOR_DELIVERED_COLOR : \(meta\.color \|\| \(estes \? ESTES_FILL : flagColor\(note\)\)\)\)/);
  // Selection amber and the search orange are decided BEFORE the fallback is even reached.
  assert.match(flat(STOP_MARKER_ICON), /const color = matched \? '#f59e0b' : searchMatched \? SEARCH_MATCH_COLOR : noTractorOverride \? eligColor : tractorDelivered \? TRACTOR_DELIVERED_COLOR : eligColor/);
});

test('do-not-send stays the red ✕ and a restriction cluster keeps its marks — neither carries the ring', () => {
  assert.match(STOP_MARKER_ICON, /circleMarkerSvg\(DNS_COLOR, \{ glyph: 'dns' \}\)/, 'the DNS pin is built exactly as before');
  const cluster = flat(STOP_MARKER_ICON.slice(STOP_MARKER_ICON.indexOf('iconMarkerSvg(')));
  const call = cluster.slice(0, cluster.indexOf(');') + 2);
  assert.equal(/\bring\b|estes|ESTES/.test(call), false, 'the icon cluster call is untouched by the Estes paint');
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
