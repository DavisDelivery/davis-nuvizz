// The Shiplify trial's switches, Legend rows, stop panel block and Building type picker — the
// real components out of App.jsx (helpers/app-lift.mjs), rendered with react-dom/server. And the
// one rule the brief is strictest about: the Legend's counts equal what the map drew, checked by
// building every pin through stopMarkerIcon and reading the SVG back.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';
import { loadStopMarkerIcon, markerSvg } from './helpers/app-markers.mjs';
import { buildShiplifyLookup } from '../src/lib/place-mark.js';

// ── a browser's localStorage, before anything is lifted (the stores read it at load) ──────────
const store = new Map();
// defineProperty, not assignment: Node 22 has its own localStorage accessor on globalThis.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
});
const SAMPLE_INV = { stops: 2, withIcons: 0, tints: { plain: 2 }, tractorDelivered: 0, estes: 0, pickups: 1, iconCounts: {}, shapes: {}, hiddenByPin: 0,
  shiplifyDock: 1, shiplifyForklift: 1, placeMarks: { residential: 1, school: 1, church: 1, government: 1 } };
const SAMPLE_STOPS = [
  { stopNbr: '1', stopType: 'DO', lat: 34, lng: -84, addr1: '1 A St', zip: '30000', matchKey: 'a', isPlanned: false, status: '' },
  { stopNbr: '2', stopType: 'PU', lat: 34, lng: -84, addr1: '2 A St', zip: '30000', matchKey: 'b', isPlanned: true, status: '' },
];

// Every onClick React is handed, recorded by the element's data-building-type, so a test can
// press a button of the picker it just rendered. Delegates to the real createElement.
const clicks = new Map();
const ReactSpy = {
  ...React,
  createElement(type, props, ...kids) {
    if (props && props['data-building-type'] !== undefined && typeof props.onClick === 'function') {
      clicks.set(props['data-building-type'], props.onClick);
    }
    return React.createElement(type, props, ...kids);
  },
};

const libs = await libExports([
  'map-legend.js', 'time-marks.js', 'carrier-mark.js', 'address-fix.js', 'time-restrictions.js',
  'place-mark.js', 'place-glyphs.js', 'shiplify-import.js', 'matchKey.js',
]);
// Only the icons App.jsx itself imports — lucide also exports an icon called `Map`, and handing
// every export in would shadow the Map constructor.
const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const inject = {
  ...Object.fromEntries(lucideNames), ...libs,
  React: ReactSpy,
  useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
  useRef: React.useRef, useCallback: React.useCallback, useLayoutEffect: React.useLayoutEffect,
  db: null,
};

const L = liftFromApp({
  targets: [
    'useLegendInventory', 'MapLegendBody', 'StopShiplifySection', 'StopShiplifyTest', 'BuildingTypePicker',
    'ShiplifyTabContext', 'setShiplifyOn', '__shiplifyOn', '__publishShiplify', '__publishTractorLocs',
    'setLimeAsOfOn', 'LimeAsOfNotice',
    // Read only inside try { } in the stores, so a ReferenceError there would be swallowed rather
    // than surfacing to the lifter — named explicitly.
    'LS_SHIPLIFY', 'LS_LIME_AS_OF',
  ],
  inject,
  exercise: (l) => {
    // Every component rendered once, so call-time references are lifted too.
    renderToStaticMarkup(React.createElement(l.MapLegendBody, { inventory: null, showAll: true, onShowAll: () => {}, shiplifySwitch: true, limeAsOfSwitch: true }));
    renderToStaticMarkup(React.createElement(l.MapLegendBody, { inventory: SAMPLE_INV, showAll: false, onShowAll: () => {}, tab: 'routing' }));
    renderToStaticMarkup(React.createElement(l.StopShiplifySection, { stop: { matchKey: 'x', addr1: '1 A St', zip: '30000' }, note: { building_type: 'school' } }));
    renderToStaticMarkup(React.createElement(l.StopShiplifyTest, { stop: { matchKey: 'x', addr1: '1 A St', zip: '30000' }, note: null }));
    renderToStaticMarkup(React.createElement(l.BuildingTypePicker, { draft: { match_key: 'x' }, setD: () => {}, pad: '', tap: undefined, stop: null }));
    renderToStaticMarkup(React.createElement(l.LimeAsOfNotice));
    l.setShiplifyOn('map', true);
    l.setLimeAsOfOn(false);
    l.__publishShiplify({});
    l.__publishTractorLocs({});
  },
});
// What the exercise above wrote is not a test's starting state.
store.clear();
// useLegendInventory is a hook around useMemo; lift a copy where useMemo just runs the function.
const { useLegendInventory: legendInventoryOf } = liftFromApp({
  targets: ['useLegendInventory'],
  inject: { ...inject, useMemo: (f) => f() },
  exercise: (l) => {
    const shiplify = { markerOpts: () => ({ shiplifyRec: { dock_access: 'yes' }, shiplifyOn: true, tractorSeen: false, tractorKnown: true }) };
    l.useLegendInventory({ stops: SAMPLE_STOPS, notes: new Map([['a', { building_type: 'school' }]]), dayKey: 'tue', tractorLocs: new Map(), shiplify });
    l.useLegendInventory({ stops: SAMPLE_STOPS, notes: new Map(), dayKey: 'tue', tractorLocs: new Map(), plannedMuted: true, isPlanned: (x) => x.isPlanned, shiplify });
  },
});

// ── the switches ──────────────────────────────────────────────────────────────

test('the Map\'s Shiplify switch leaves Routing\'s untouched, and the reverse', () => {
  assert.equal(L.__shiplifyOn.map, true, 'default ON');
  assert.equal(L.__shiplifyOn.routing, true, 'default ON');
  L.setShiplifyOn('map', false);
  assert.equal(L.__shiplifyOn.map, false);
  assert.equal(L.__shiplifyOn.routing, true, 'Routing unmoved');
  assert.equal(store.get('dispatchMap.shiplifyOn'), 'off');
  assert.equal(store.has('routing.shiplify'), false, 'Routing\'s key never written');
  L.setShiplifyOn('map', true);
  L.setShiplifyOn('routing', false);
  assert.equal(L.__shiplifyOn.map, true, 'Map unmoved');
  assert.equal(store.get('routing.shiplify'), 'off');
  L.setShiplifyOn('routing', true);
});

// ── the stop panel block ──────────────────────────────────────────────────────

const SCHOOL_REC = {
  match_key: 'k_school', place_key: '1_fake_st__30000', dock_access: 'no', forklift: 'yes', gated_access: 'partial',
  security_hut: 'no', call_box: 'yes', lumper: '', location_types: ['School'], tariff_items: ['LIM'],
};
L.__publishShiplify({ status: 'ready', lookup: buildShiplifyLookup([SCHOOL_REC]), head: { generation: 'g1' }, error: null });
L.__publishTractorLocs({ status: 'ready', map: new Map(), error: null });

const panel = (tab, stop, note, limeHere = false) => renderToStaticMarkup(
  React.createElement(L.ShiplifyTabContext.Provider, { value: { tab, boardDate: null } },
    React.createElement(L.StopShiplifySection, { stop, note, limeHere })),
);
const schoolStop = { matchKey: 'k_school', addr1: '1 Fake St', zip: '30000' };
const elsewhere = { matchKey: 'k_other', addr1: '9 Other Rd', zip: '30000' };

test('the stop panel names the place mark and its source, and says the no-tractor rule while it applies', () => {
  const html = panel('routing', schoolStop, null);
  assert.match(html, /data-place-mark="school"/);
  assert.match(html, /From Shiplify/);
  assert.match(html, /No tractor trailer: School\. Set Vehicle to Tractor-trailer OK if a trailer fits\./);
  const mine = panel('routing', elsewhere, { building_type: 'church' });
  assert.match(mine, /Set by dispatcher/);
  assert.match(mine, /No tractor trailer: Church\./);
  const ok = panel('routing', schoolStop, { vehicle_eligibility: 'tractor' });
  assert.doesNotMatch(ok, /No tractor trailer:/, 'lifted by Tractor-trailer OK');
});

test('the Shiplify block says every fact in words, and "Not in the Shiplify test" when there is no record', () => {
  const html = panel('map', schoolStop, null);
  assert.match(html, /Shiplify test, Sep 18, 2026/);
  for (const w of ['Dock', 'Forklift', 'Gated', 'Security hut', 'Call box', 'Lumper', 'Location types', 'Tariffs', 'Partial', 'Limited access']) {
    assert.ok(html.includes(w), `says ${w}`);
  }
  assert.match(panel('map', elsewhere, null), /Not in the Shiplify test/);
});

test('each tab\'s switch hides its own stop panel block and Shiplify place mark — and only its own', () => {
  L.setShiplifyOn('map', false);
  const mapOff = panel('map', schoolStop, null);
  assert.doesNotMatch(mapOff, /data-shiplify-block/, 'Map: no Shiplify block');
  assert.doesNotMatch(mapOff, /data-place-mark/, 'Map: no Shiplify place mark');
  const routingStill = panel('routing', schoolStop, null);
  assert.match(routingStill, /data-shiplify-block/, 'Routing untouched');
  assert.match(routingStill, /data-place-mark="school"/);
  // A dispatcher's own type shows with the switch off.
  assert.match(panel('map', schoolStop, { building_type: 'government' }), /data-place-mark="government"[\s\S]*Set by dispatcher/);
  L.setShiplifyOn('map', true);
  L.setShiplifyOn('routing', false);
  assert.doesNotMatch(panel('routing', schoolStop, null), /data-shiplify-block/);
  assert.match(panel('map', schoolStop, null), /data-shiplify-block/, 'Map untouched');
  L.setShiplifyOn('routing', true);
});

test('a lime location where Shiplify says no dock gets one grey line saying so', () => {
  assert.match(panel('map', schoolStop, null, true), /A tractor has delivered here, though Shiplify lists no dock\./);
  assert.doesNotMatch(panel('map', schoolStop, null, false), /though Shiplify lists no dock/);
});

// ── the Building type picker ──────────────────────────────────────────────────

const picker = (draft, tab = 'map') => {
  clicks.clear();
  const patches = [];
  const html = renderToStaticMarkup(
    React.createElement(L.ShiplifyTabContext.Provider, { value: { tab, boardDate: null } },
      React.createElement(L.BuildingTypePicker, { draft, setD: (p) => patches.push(p), pad: '', tap: undefined, stop: schoolStop })),
  );
  return { html, patches, press: (v) => clicks.get(v)() };
};
const pressed = (html) => [...html.matchAll(/data-building-type="([a-z]+)" aria-pressed="true"/g)].map((m) => m[1]);

test('Building type: Auto, Residential, School, Church, Government, None — each with its glyph, Shiplify beside Auto', () => {
  const { html } = picker({ match_key: 'k_school' });
  for (const v of ['auto', 'residential', 'school', 'church', 'government', 'none']) assert.match(html, new RegExp(`data-building-type="${v}"`));
  assert.deepEqual(pressed(html), ['auto'], 'nothing set is Auto');
  assert.match(html, /Shiplify: School/, 'what Shiplify says, beside Auto');
  L.setShiplifyOn('map', false);
  assert.doesNotMatch(picker({ match_key: 'k_school' }).html, /Shiplify: School/, 'not with this tab\'s switch off');
  L.setShiplifyOn('map', true);
});

test('Building type: set, change and clear', () => {
  let draft = { match_key: 'k_school' };
  const apply = (v) => { const p = picker(draft); p.press(v); draft = { ...draft, ...p.patches.at(-1) }; return draft; };
  assert.equal(apply('church').building_type, 'church', 'set');
  assert.deepEqual(pressed(picker(draft).html), ['church']);
  assert.equal(apply('none').building_type, 'none', 'change');
  assert.deepEqual(pressed(picker(draft).html), ['none']);
  assert.equal(apply('auto').building_type, null, 'clear back to Auto');
  assert.deepEqual(pressed(picker(draft).html), ['auto']);
});

// ── the Legend ────────────────────────────────────────────────────────────────

test('the Legend rows show only for marks on the board, and a tab\'s switch hides its own Shiplify rows', () => {
  const inv = { stops: 3, withIcons: 0, tints: {}, tractorDelivered: 0, estes: 0, pickups: 0, iconCounts: {}, shapes: {}, hiddenByPin: 0,
    shiplifyDock: 2, shiplifyForklift: 1, placeMarks: { residential: 0, school: 1, church: 0, government: 0 } };
  const body = (tab) => renderToStaticMarkup(React.createElement(L.MapLegendBody, { inventory: inv, showAll: false, onShowAll: () => {}, tab }));
  const html = body('routing');
  assert.match(html, /Shiplify: dock, no tractor yet/);
  assert.match(html, /Shiplify: forklift, no dock, no tractor yet/);
  assert.match(html, /data-legend-row="place-school"/);
  assert.doesNotMatch(html, /data-legend-row="place-church"/, 'a mark not on the board is not listed');
  L.setShiplifyOn('routing', false);
  assert.doesNotMatch(body('routing'), /Shiplify: dock/, 'Routing off: no Shiplify rows');
  assert.match(body('map'), /Shiplify: dock/, 'the Map legend is not Routing\'s switch');
  L.setShiplifyOn('routing', true);
  const all = renderToStaticMarkup(React.createElement(L.MapLegendBody, { inventory: null, showAll: true, onShowAll: () => {}, tab: 'map', shiplifySwitch: true, limeAsOfSwitch: true }));
  for (const w of ['Residential', 'School', 'Church', 'Government', 'Shiplify data', 'Lime as of board date']) assert.ok(all.includes(w), w);
});

test('the Routing notice reads "Lime as of board date"', () => {
  assert.match(renderToStaticMarkup(React.createElement(L.LimeAsOfNotice)), /Lime as of board date/);
});

test('LEGEND COUNTS EQUAL WHAT THE MAP DREW — Map and Routing semantics, every combination', async () => {
  const icon = await loadStopMarkerIcon();
  const recs = {
    dock: { dock_access: 'yes', forklift: '', location_types: [], tariff_items: [] },
    fork: { dock_access: 'no', forklift: 'yes', location_types: [], tariff_items: ['RES'] },
    school: { dock_access: 'yes', forklift: '', location_types: ['School'], tariff_items: [] },
    church: { dock_access: 'no', forklift: 'no', location_types: ['Place of Worship'], tariff_items: [] },
    none: null,
  };
  const notes = new Map();
  const stops = [];
  const recOf = new Map();
  let i = 0;
  for (const [rk, rec] of Object.entries(recs)) {
    for (const note of [null, { building_type: 'government' }, { building_type: 'none' }, { priority_flag: 'red' }, { liftgate_required: true }, { do_not_send: true }, { vehicle_eligibility: 'tractor' }]) {
      for (const planned of [false, true]) {
        for (const stopType of ['DO', 'PU']) {
          i += 1;
          const s = { stopNbr: String(8100000 + i), stopType, lat: 34, lng: -84, addr1: `${i} Fake St`, zip: '30000', matchKey: `m${i}`, isPlanned: planned, status: '' };
          stops.push(s);
          if (note) notes.set(s.matchKey, note);
          recOf.set(s.matchKey, rec);
        }
      }
    }
  }
  const shiplify = { markerOpts: (s) => ({ shiplifyRec: recOf.get(s.matchKey) || null, shiplifyOn: true, tractorSeen: false, tractorKnown: true }) };
  const drew = (svg) => {
    const hollow = /stroke="#32CD32" stroke-width="3"/.test(svg) || /<circle cx="12" cy="12" r="11" fill="#32CD32"/.test(svg);
    const fork = hollow && /data-glyph="forklift"/.test(svg);
    const place = /data-glyph="(residential|school|church|government)"/.exec(svg)?.[1] || null;
    return { dock: hollow && !fork, fork, place };
  };
  const tally = (entries) => {
    const t = { dock: 0, fork: 0, residential: 0, school: 0, church: 0, government: 0 };
    for (const d of entries) { if (d.dock) t.dock += 1; if (d.fork) t.fork += 1; if (d.place) t[d.place] += 1; }
    return t;
  };
  const selected = new Set(stops.filter((_, k) => k % 11 === 0).map((s) => s.stopNbr));
  const routed = new Set(stops.filter((_, k) => k % 13 === 0).map((s) => s.stopNbr));
  const expectFrom = (inv) => ({ dock: inv.shiplifyDock, fork: inv.shiplifyForklift, ...inv.placeMarks });

  // THE MAP: a selected stop is amber, a stop on the open route a numbered pin.
  const mapDrawn = tally(stops.map((s) => drew(markerSvg(icon(s, notes.get(s.matchKey) || null, {
    matched: selected.has(s.stopNbr), inRoute: routed.has(s.stopNbr), seq: routed.has(s.stopNbr) ? 1 : undefined, ...shiplify.markerOpts(s),
  })))));
  const mapInv = legendInventoryOf({ stops, notes, dayKey: 'tue', tractorLocs: new Map(), routeStopNbrs: routed, selectedIds: selected, shiplify });
  assert.deepEqual(expectFrom(mapInv), mapDrawn);
  assert.ok(mapDrawn.dock > 0 && mapDrawn.fork > 0 && mapDrawn.school > 0 && mapDrawn.government > 0, 'the board exercises every row');

  // ROUTING: planned stops without an open card are muted; a search hit is burnt orange.
  const isPlanned = (s) => !!s.isPlanned;
  const search = new Set(stops.filter((_, k) => k % 7 === 0).map((s) => s.stopNbr));
  const routingDrawn = tally(stops.map((s) => drew(markerSvg(icon(s, notes.get(s.matchKey) || null, {
    matched: selected.has(s.stopNbr), searchMatched: search.has(s.stopNbr), inRoute: routed.has(s.stopNbr),
    seq: routed.has(s.stopNbr) ? 1 : undefined, routeColor: routed.has(s.stopNbr) ? '#123456' : undefined,
    plannedMuted: !routed.has(s.stopNbr) && isPlanned(s), ...shiplify.markerOpts(s),
  })))));
  const routingInv = legendInventoryOf({
    stops, notes, dayKey: 'tue', tractorLocs: new Map(), routeStopNbrs: routed, plannedMuted: true, isPlanned,
    selectedIds: selected, searchMatchIds: search, shiplify,
  });
  assert.deepEqual(expectFrom(routingInv), routingDrawn);
});

// ── the Shiplify box reads LAST (Chad, 2026-09-24: "move this to the very bottom of an order profile") ──

const part = (tab, stop, note, p, wrap = null) => renderToStaticMarkup(
  React.createElement(L.ShiplifyTabContext.Provider, { value: { tab, boardDate: null } },
    React.createElement(L.StopShiplifySection, { stop, note, part: p, wrap })),
);

test('the section splits: "place" keeps the building type and no-tractor line, "test" is only the Shiplify box', () => {
  const place = part('routing', schoolStop, null, 'place');
  assert.match(place, /data-place-mark="school"/);
  assert.match(place, /No tractor trailer: School\./);
  assert.doesNotMatch(place, /data-shiplify-block/, 'the box is no longer up with the address');
  const box = part('routing', schoolStop, null, 'test');
  assert.match(box, /data-shiplify-block/);
  assert.match(box, /Shiplify test, Sep 18, 2026/);
  assert.doesNotMatch(box, /data-place-mark|No tractor trailer:/, 'the box does not repeat the place lines');
});

test('the box\'s own section wrapper is drawn only when there is a box — no empty strip with the switch off', () => {
  assert.match(part('map', elsewhere, null, 'test', 'px-4 py-3 border-t text-sm'), /class="px-4 py-3 border-t text-sm"[\s\S]*Not in the Shiplify test/);
  L.setShiplifyOn('map', false);
  assert.equal(part('map', elsewhere, null, 'test', 'px-4 py-3 border-t text-sm'), '', 'nothing at all, not an empty bordered div');
  L.setShiplifyOn('map', true);
});

test('StopShiplifyTest is the box in its own bottom section', () => {
  const html = renderToStaticMarkup(React.createElement(L.ShiplifyTabContext.Provider, { value: { tab: 'map', boardDate: null } },
    React.createElement(L.StopShiplifyTest, { stop: schoolStop, note: null })));
  assert.match(html, /^<div class="px-4 py-3 border-t text-sm">[\s\S]*data-shiplify-block/);
  assert.doesNotMatch(html, /data-place-mark/);
});

test('in the desktop sidebar and the phone drawer the box comes AFTER Recent deliveries, and is not drawn twice', () => {
  // Read off the real source: both hosts stack Data → PROs → Customer notes → Recent deliveries,
  // and the box must follow the last of them. StopDataSections must not ALSO draw it there.
  const hosts = [...APP_SRC.matchAll(/<StopRecentDeliveries stop=\{stop\} note=\{note\} \/>\s*\n\s*<StopShiplifyTest stop=\{live\} note=\{note\} \/>/g)];
  assert.equal(hosts.length, 2, 'sidebar and drawer each end with the Shiplify box');
  const full = [...APP_SRC.matchAll(/<StopDataSections [^>]*onSaveContacts=\{saveContacts\}[^>]*\/>/g)].map((m) => m[0]);
  assert.equal(full.length, 2);
  for (const tag of full) assert.match(tag, /shiplifyTestHere=\{false\}/, 'the host that draws it last tells StopDataSections not to');
  // The stop lookup shows StopDataSections alone, so there the box is the last thing it draws.
  const body = APP_SRC.slice(APP_SRC.indexOf('function StopDataSections('), APP_SRC.indexOf('function StopShiplifyTest('));
  assert.ok(body.indexOf('part="test"') > body.indexOf('Updated {fmtClockShort(live.listUpdatedDTTM)}'), 'after the last line of the panel');
  assert.ok(body.indexOf('part="place"') > 0 && body.indexOf('part="place"') < body.indexOf('part="test"'));
});
