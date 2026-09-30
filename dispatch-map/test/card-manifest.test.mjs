// test/card-manifest.test.mjs
//
// A COMPARE CARD'S PRINTED MANIFEST FOLLOWS THE CARD, SAVED OR NOT.
//
// Chad, 2026-09-29: "why my print manifest doesn't match the order my deliveries are in in route
// work bench until a nuvizz save has occurred — to me it should always match even if a save
// hasn't occurred." Then: "I want my manifest to always match what is in dispatch map."
//
// The card handed its stops to buildManifestHtml in its own order and the builder re-sorted them
// by NuVizz's sequence (routeSeq) — the OLD route's numbers until a Save stamped new ones. These
// tests RUN the real builder, sliced out of App.jsx with its real sort helpers, because the
// defect was one call inside a function no regex over the source would have exercised: a
// manifest has to be built and read back page by page to know what order it prints in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cardManifestPages } from '../src/lib/card-manifest.js';
import { isHashLikeId, looksLikeLoadNbr } from '../src/lib/route-identity.js';
import { houseSwitchOn } from '../src/lib/routing-select.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** A top-level `function name(…) { … }` from App.jsx, cut at its matching close brace. */
function fnSource(name) {
  const start = APP.indexOf(`\nfunction ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const open = APP.indexOf('{', APP.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < APP.length; i++) {
    const c = APP[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return APP.slice(start + 1, i + 1);
  }
  throw new Error(`${name}: no matching close brace`);
}
/** A one-statement top-level `const name = …;` (template literals included). */
function constSource(name, terminator) {
  const start = APP.indexOf(`\nconst ${name} = `);
  assert.ok(start > 0, `const ${name} not found in App.jsx`);
  const end = APP.indexOf(terminator, start);
  assert.ok(end > start, `const ${name}: terminator not found`);
  return APP.slice(start + 1, end + terminator.length);
}

// The builder and everything it calls, as shipped — no copies of the rules under test.
const SRC = [
  constSource('bolEsc', ';\n'),
  constSource('TICKET_STYLE', '`;\n'),
  ...['loadDisplayName', 'routeSeqOf', 'compareByPlannedEta', 'hasRealRouteSequence', 'nearestNeighborOrder',
    'orderRouteStops', 'tktReqTime', 'tktReqClock', 'tktDayOffset', 'tktNextStop', 'tktCommentTime',
    'ticketData', 'ticketBody', 'manifestOrigin', 'buildManifestHtml'].map(fnSource),
].join('\n');
const { buildManifestHtml, buildTicketBody } = new Function('isHashLikeId', 'looksLikeLoadNbr',
  `"use strict";\n${SRC}\nreturn { buildManifestHtml, buildTicketBody: ticketBody };`,
)(isHashLikeId, looksLikeLoadNbr);

// ── fixtures: a load as the board holds it ────────────────────────────────────
// routeSeq is NuVizz's sequence off the scan. lat/lng spread so the geographic fallback has a
// real, deterministic chain to follow when no stop carries a sequence.
function stop(stopNbr, { routeSeq = null, lat = 34, lng = -84, name } = {}) {
  return { stopNbr, routeSeq, lat, lng, businessName: name || `CUST ${stopNbr}`, city: 'BUFORD', state: 'GA', zip: '30518' };
}
/** Page order and circled numbers, read back off the printed HTML. */
function printed(html) {
  const pages = html.split('<section class="tkt">').slice(1);
  return pages.map((p) => ({
    pro: /<span class="pro">([^<]*)<\/span>/.exec(p)?.[1],
    seq: /<span class="seq">([^<]*)<\/span>/.exec(p)?.[1],
  }));
}
const LOGO = 'https://example.test/davis-logo.jpg';

// A load NuVizz holds as A(1) B(2) C(3) D(4), which the dispatcher has dragged into D A C B on
// the card and not yet saved.
const A = stop('007100001', { routeSeq: 1, lat: 34.10, lng: -84.00 });
const B = stop('007100002', { routeSeq: 2, lat: 34.20, lng: -84.10 });
const C = stop('007100003', { routeSeq: 3, lat: 34.30, lng: -84.20 });
const D = stop('007100004', { routeSeq: 4, lat: 34.40, lng: -84.30 });
const BOARD = new Map([A, B, C, D].map((s) => [s.stopNbr, s]));

test('a re-sequenced card, not yet saved, prints in the CARD order with the card\'s row numbers', () => {
  const { stops, labels } = cardManifestPages([D, A, C, B].map((s) => s.stopNbr), BOARD);
  const out = printed(buildManifestHtml(stops, LOGO, 'SUW', { asGiven: true, labels }));
  assert.deepEqual(out.map((p) => p.pro), [D.stopNbr, A.stopNbr, C.stopNbr, B.stopNbr]);
  assert.deepEqual(out.map((p) => p.seq), ['1', '2', '3', '4']);
});

test('THE REPORTED BUG, pinned: the old call printed NuVizz\'s order, wearing NuVizz\'s numbers', () => {
  // What shipped until now, and what VITE_MANIFEST_IN_CARD_ORDER=off puts back.
  const { stops } = cardManifestPages([D, A, C, B].map((s) => s.stopNbr), BOARD);
  const out = printed(buildManifestHtml(stops, LOGO, 'SUW'));
  assert.deepEqual(out.map((p) => p.pro), [A.stopNbr, B.stopNbr, C.stopNbr, D.stopNbr]);
  assert.deepEqual(out.map((p) => p.seq), ['1', '2', '3', '4']);
});

test('a brand-new route (no stop has a NuVizz sequence) prints the card order, not a map guess', () => {
  const n1 = stop('007200001', { lat: 34.00, lng: -84.00 });
  const n2 = stop('007200002', { lat: 34.90, lng: -84.90 });   // the most north-west
  const n3 = stop('007200003', { lat: 34.05, lng: -84.05 });
  const n4 = stop('007200004', { lat: 34.50, lng: -84.50 });
  const board = new Map([n1, n2, n3, n4].map((s) => [s.stopNbr, s]));
  const order = [n1, n3, n4, n2].map((s) => s.stopNbr);
  const { stops, labels } = cardManifestPages(order, board);
  const fixed = printed(buildManifestHtml(stops, LOGO, 'NEW ROUTE', { asGiven: true, labels }));
  assert.deepEqual(fixed.map((p) => p.pro), order);
  assert.deepEqual(fixed.map((p) => p.seq), ['1', '2', '3', '4'], 'every circle numbered — they printed blank before');
  // And the old path really did reorder it, starting from the north-west corner: this is the
  // failure the fix removes, measured rather than asserted.
  const old = printed(buildManifestHtml(stops, LOGO, 'NEW ROUTE'));
  assert.equal(old[0].pro, n2.stopNbr);
  assert.notDeepEqual(old.map((p) => p.pro), order);
  assert.deepEqual(old.map((p) => p.seq), ['', '', '', '']);
});

test('a card mixing stops from two loads prints the card order', () => {
  const other = stop('007300009', { routeSeq: 1, lat: 34.6, lng: -84.6 });   // off another load
  const fresh = stop('007300010', { lat: 34.7, lng: -84.7 });                // unplanned
  const board = new Map([...BOARD, [other.stopNbr, other], [fresh.stopNbr, fresh]]);
  const order = [C.stopNbr, fresh.stopNbr, other.stopNbr, A.stopNbr];
  const { stops, labels } = cardManifestPages(order, board);
  assert.deepEqual(printed(buildManifestHtml(stops, LOGO, 'MIX', { asGiven: true, labels })).map((p) => p.pro), order);
});

test('a stop the board can no longer resolve keeps its place in the count, as it does on the card', () => {
  // The card shows it as a stub row numbered 2; it cannot be printed (no address), and the print
  // handler says so. The pages must still read 1, 3 — never renumber the rest into a lie.
  const { stops, labels, missing } = cardManifestPages([A.stopNbr, '009999999', B.stopNbr], BOARD);
  assert.equal(missing, 1);
  assert.deepEqual(labels, [1, 3]);
  const out = printed(buildManifestHtml(stops, LOGO, 'SUW', { asGiven: true, labels }));
  assert.deepEqual(out.map((p) => [p.pro, p.seq]), [[A.stopNbr, '1'], [B.stopNbr, '3']]);
});

test('the route detail panel\'s manifest is untouched: no options, NuVizz order and numbers as before', () => {
  // RouteDetailBody passes its own orderRouteStops list and no options. Handing the builder the
  // stops shuffled proves it still sorts them itself on that path.
  const out = printed(buildManifestHtml([C, A, D, B], LOGO));
  assert.deepEqual(out.map((p) => p.pro), [A.stopNbr, B.stopNbr, C.stopNbr, D.stopNbr]);
  assert.deepEqual(out.map((p) => p.seq), ['1', '2', '3', '4']);
  assert.match(APP, /buildManifestHtml\(sorted, \(typeof window !== 'undefined' \? window\.location\.origin : ''\) \+ '\/davis-logo\.jpg'\)/,
    'the route detail call must stay exactly as it was');
});

test('labels are never applied to a re-sorted list — one stop\'s number on another stop\'s page', () => {
  const out = printed(buildManifestHtml([C, A, D, B], LOGO, null, { labels: [9, 8, 7, 6] }));
  assert.deepEqual(out.map((p) => p.seq), ['1', '2', '3', '4']);
});

test('a label list that does not line up with the stops is ignored rather than shifted', () => {
  const out = printed(buildManifestHtml([B, A], LOGO, null, { asGiven: true, labels: [1] }));
  assert.deepEqual(out.map((p) => p.pro), [B.stopNbr, A.stopNbr]);
  assert.deepEqual(out.map((p) => p.seq), ['2', '1'], 'falls back to each stop\'s own number, never a neighbour\'s');
});

test('the cover page counts every printed stop on the card path', () => {
  const { stops, labels } = cardManifestPages([D, A].map((s) => s.stopNbr), BOARD);
  const html = buildManifestHtml(stops, LOGO, 'SUW', { asGiven: true, labels });
  assert.match(html, /<div class="k">Stops<\/div><div>2 Stops<\/div>/);
  assert.match(html, /<div class="mf-route">SUW<\/div>/);
});

test('a single delivery ticket (no label) still prints NuVizz\'s number, exactly as before', () => {
  assert.match(buildTicketBody(C, LOGO), /<span class="seq">3<\/span>/);
  assert.match(buildTicketBody(C, LOGO, 'Delivery Ticket', null), /<span class="seq">3<\/span>/);
  assert.match(buildTicketBody(C, LOGO, 'Delivery Ticket', 7), /<span class="seq">7<\/span>/);
});

// ── cardManifestPages on its own ─────────────────────────────────────────────
test('cardManifestPages: empty, missing and malformed inputs return an empty manifest, never throw', () => {
  for (const [order, lookup] of [[[], BOARD], [null, BOARD], [undefined, undefined], [[A.stopNbr], null], [[A.stopNbr], {}]]) {
    const r = cardManifestPages(order, lookup);
    assert.ok(Array.isArray(r.stops) && Array.isArray(r.labels));
    assert.equal(r.stops.length, r.labels.length);
  }
  assert.deepEqual(cardManifestPages([A.stopNbr], {}), { stops: [], labels: [], missing: 1 });
});

test('cardManifestPages: numeric ids resolve the same as string ids (the board is keyed by string)', () => {
  const board = new Map([['7100001', stop('7100001')]]);
  assert.equal(cardManifestPages([7100001], board).stops.length, 1);
});

// ── the wiring and the switch ────────────────────────────────────────────────
test('the Compare card prints through cardManifestPages, in its own order, behind the named switch', () => {
  const start = APP.indexOf('const printWbManifest = useCallback(');
  assert.ok(start > 0);
  const body = APP.slice(start, APP.indexOf('}, [wbRoutes, boardStopById]);', start));
  assert.match(body, /cardManifestPages\(route\.order, boardStopById\)/);
  assert.match(body, /MANIFEST_IN_CARD_ORDER\s*\n?\s*\? buildManifestHtml\(stops, logo, displayName, \{ asGiven: true, labels \}\)\s*\n?\s*: buildManifestHtml\(stops, logo, displayName\)/);
  assert.match(APP, /const MANIFEST_IN_CARD_ORDER = \(\(\) => \{\s*try \{ return houseSwitchOn\(import\.meta\.env\.VITE_MANIFEST_IN_CARD_ORDER\); \} catch \{ return true; \}/);
});

test('the switch has the house shape: on by default, an explicit off-word puts it back, a typo leaves it on', () => {
  for (const v of [undefined, '', 'on', 'true', '1', 'yes', 'of', 'offf', 'disable']) assert.equal(houseSwitchOn(v), true, String(v));
  for (const v of ['off', 'OFF', ' off ', '0', 'false', 'no']) assert.equal(houseSwitchOn(v), false, v);
});
