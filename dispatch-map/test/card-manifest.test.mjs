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
// manifest has to be built and read back page by page to know what it prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cardManifestPages, stopOrdersAgree } from '../src/lib/card-manifest.js';
import { isHashLikeId, looksLikeLoadNbr } from '../src/lib/route-identity.js';
import { houseSwitchOn } from '../src/lib/routing-select.js';
import { ticketNotes } from '../src/lib/stop-notes-freshness.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** A top-level `function name(…) { … }` from App.jsx, cut at its matching close brace. */
function fnSource(name) {
  const start = APP.indexOf(`\nfunction ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  assert.equal(APP.indexOf(`\nfunction ${name}(`, start + 1), -1, `${name} is defined twice — the slice could test the wrong one`);
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
const { buildManifestHtml, buildTicketBody } = new Function('isHashLikeId', 'looksLikeLoadNbr', 'stopOrdersAgree', 'ticketNotes',
  `"use strict";\n${SRC}\nreturn { buildManifestHtml, buildTicketBody: ticketBody };`,
)(isHashLikeId, looksLikeLoadNbr, stopOrdersAgree, ticketNotes);

// ── fixtures: a load as the board holds it ────────────────────────────────────
// routeSeq is NuVizz's sequence off the scan; plannedEtaDTTM its per-stop ETA for that order.
// lat/lng spread so the geographic fallback has a real chain to follow when no stop has a sequence.
function stop(stopNbr, { routeSeq = null, lat = 34, lng = -84, addr1, zip = '30518', eta = null, driverName = 'BOB', routeName = 'SUW' } = {}) {
  return {
    stopNbr, routeSeq, lat, lng, businessName: `CUST ${stopNbr}`, addr1: addr1 || `${stopNbr.slice(-3)} MAIN ST`,
    city: 'BUFORD', state: 'GA', zip, plannedEtaDTTM: eta, driverName, routeName,
  };
}
/** Page order, circled numbers and the ETA foot line, read back off the printed HTML. */
function printed(html) {
  return html.split('<section class="tkt">').slice(1).map((p) => ({
    pro: /<span class="pro">([^<]*)<\/span>/.exec(p)?.[1],
    seq: /<span class="seq">([^<]*)<\/span>/.exec(p)?.[1],
    eta: /<div class="next">Next Stop: ([^<]*)<\/div>/.exec(p)?.[1] ?? null,
  }));
}
const LOGO = 'https://example.test/davis-logo.jpg';
const pros = (out) => out.map((p) => p.pro);
const seqs = (out) => out.map((p) => p.seq);

// A load NuVizz holds as A(1) B(2) C(3) D(4), each with NuVizz's ETA for that order. The
// dispatcher has dragged it into D A C B on the card and not saved.
const A = stop('007100001', { routeSeq: 1, lat: 34.10, lng: -84.00, eta: '2026-09-30T08:10:00' });
const B = stop('007100002', { routeSeq: 2, lat: 34.20, lng: -84.10, eta: '2026-09-30T09:20:00' });
const C = stop('007100003', { routeSeq: 3, lat: 34.30, lng: -84.20, eta: '2026-09-30T10:30:00' });
const D = stop('007100004', { routeSeq: 4, lat: 34.40, lng: -84.30, eta: '2026-09-30T11:40:00' });
const BOARD = new Map([A, B, C, D].map((s) => [s.stopNbr, s]));
const ids = (...s) => s.map((x) => x.stopNbr);
const cardHtml = (order, board = BOARD, name = 'SUW') => {
  const { stops, labels } = cardManifestPages(order, board);
  return buildManifestHtml(stops, LOGO, name, { asGiven: true, labels });
};

test('a re-sequenced card, not yet saved, prints in the CARD order, numbered 1..N down the pages', () => {
  const out = printed(cardHtml(ids(D, A, C, B)));
  assert.deepEqual(pros(out), ids(D, A, C, B));
  assert.deepEqual(seqs(out), ['1', '2', '3', '4']);
});

test('THE REPORTED BUG, pinned: the old call printed NuVizz\'s order (what VITE_MANIFEST_IN_CARD_ORDER=off puts back)', () => {
  const { stops } = cardManifestPages(ids(D, A, C, B), BOARD);
  const out = printed(buildManifestHtml(stops, LOGO, 'SUW'));
  assert.deepEqual(pros(out), ids(A, B, C, D));
  assert.deepEqual(seqs(out), ['1', '2', '3', '4']);
});

test('a card nobody re-ordered prints byte for byte what it printed before this change', () => {
  // The seeded card IS NuVizz's order. Its paper must not move at all — numbers, ETAs, cover.
  const { stops } = cardManifestPages(ids(A, B, C, D), BOARD);
  assert.equal(cardHtml(ids(A, B, C, D)), buildManifestHtml(stops, LOGO, 'SUW'));
});

test('a re-ordered page drops NuVizz\'s ETA line — it is a time for a route that is not on the page', () => {
  // Reversed, the old times would read 11:40 on page 1 and 08:10 on page 4: a driver told to reach
  // his first stop last.
  assert.deepEqual(printed(cardHtml(ids(D, C, B, A))).map((p) => p.eta), [null, null, null, null]);
  // Untouched, every page keeps it, exactly as before.
  assert.ok(printed(cardHtml(ids(A, B, C, D))).every((p) => p.eta && /AM/.test(p.eta)));
});

test('a brand-new route (no NuVizz sequence) prints the card order with every circle numbered', () => {
  const n1 = stop('007200001', { lat: 34.00, lng: -84.00 });
  const n2 = stop('007200002', { lat: 34.90, lng: -84.90 });   // the most north-west
  const n3 = stop('007200003', { lat: 34.05, lng: -84.05 });
  const n4 = stop('007200004', { lat: 34.50, lng: -84.50 });
  const board = new Map([n1, n2, n3, n4].map((s) => [s.stopNbr, s]));
  const order = ids(n1, n3, n4, n2);
  const fixed = printed(cardHtml(order, board, 'NEW ROUTE'));
  assert.deepEqual(pros(fixed), order);
  assert.deepEqual(seqs(fixed), ['1', '2', '3', '4'], 'every circle numbered — they printed blank before');
  // The old path really did reorder it, from the north-west corner, with blank circles: the failure
  // the fix removes, measured rather than asserted.
  const { stops } = cardManifestPages(order, board);
  const old = printed(buildManifestHtml(stops, LOGO, 'NEW ROUTE'));
  assert.equal(old[0].pro, n2.stopNbr);
  assert.notDeepEqual(pros(old), order);
  assert.deepEqual(seqs(old), ['', '', '', '']);
});

test('a new route whose card order happens to equal the map chain still gets numbered circles', () => {
  const n1 = stop('007210001', { lat: 34.90, lng: -84.90 });
  const n2 = stop('007210002', { lat: 34.80, lng: -84.80 });
  const n3 = stop('007210003', { lat: 34.70, lng: -84.70 });
  const board = new Map([n1, n2, n3].map((s) => [s.stopNbr, s]));
  assert.deepEqual(seqs(printed(cardHtml(ids(n1, n2, n3), board))), ['1', '2', '3']);
});

test('two orders at one dock share a number, as NuVizz and the driver\'s handheld number them', () => {
  // The card rows read 1 2 3 4; NuVizz numbers the dock once, so the paper reads 1 2 2 3 — and the
  // stop after the shared dock is 3 on paper AND on the handheld, never one ahead of it.
  const dockA = stop('007400001', { routeSeq: 1, addr1: '10 DOCK RD', lat: 34.1, lng: -84.1 });
  const dockB1 = stop('007400002', { routeSeq: 2, addr1: '20 SHARED WAY', lat: 34.2, lng: -84.2 });
  const dockB2 = stop('007400003', { routeSeq: 2, addr1: '20 Shared Way', lat: 34.2, lng: -84.2 });
  const dockC = stop('007400004', { routeSeq: 3, addr1: '30 LAST LN', lat: 34.3, lng: -84.3 });
  const board = new Map([dockA, dockB1, dockB2, dockC].map((s) => [s.stopNbr, s]));
  // Re-ordered with the shared dock kept together.
  const out = printed(cardHtml(ids(dockC, dockB1, dockB2, dockA), board));
  assert.deepEqual(seqs(out), ['1', '2', '2', '3']);
  // The same dock split apart is two visits, and gets two numbers.
  assert.deepEqual(cardManifestPages(ids(dockB1, dockA, dockB2), board).labels, [1, 2, 3]);
  // And a saved load nobody touched prints NuVizz's own numbers, exactly as before.
  assert.deepEqual(seqs(printed(cardHtml(ids(dockA, dockB1, dockB2, dockC), board))), ['1', '2', '2', '3']);
});

test('a card mixing stops from two loads prints the card order', () => {
  const other = stop('007300009', { routeSeq: 1, lat: 34.6, lng: -84.6, driverName: 'ANN', routeName: 'JEAN' });
  const fresh = stop('007300010', { lat: 34.7, lng: -84.7, driverName: null, routeName: null });
  const board = new Map([...BOARD, [other.stopNbr, other], [fresh.stopNbr, fresh]]);
  const order = [C.stopNbr, fresh.stopNbr, other.stopNbr, A.stopNbr];
  assert.deepEqual(pros(printed(cardHtml(order, board))), order);
});

test('the cover is untouched by page order: a stop dragged in from another load cannot name its driver', () => {
  // SUW holds A B C (BOB). X comes off JEAN (ANN, NuVizz sequence 7) and is parked on row 1. The old
  // cover said BOB; re-ordering the pages must not make it say ANN.
  const X = stop('007300011', { routeSeq: 7, lat: 34.9, lng: -84.9, driverName: 'ANN', routeName: 'JEAN' });
  const board = new Map([...BOARD, [X.stopNbr, X]]);
  const order = ids(X, A, B, C);
  const { stops } = cardManifestPages(order, board);
  const cover = (html) => html.slice(0, html.indexOf('<section class="tkt">'));
  assert.equal(cover(cardHtml(order, board)), cover(buildManifestHtml(stops, LOGO, 'SUW')));
  assert.match(cover(cardHtml(order, board)), /<div class="k">Driver<\/div><div>BOB<\/div>/);
});

test('a stop the board can no longer resolve keeps its place in the count on a re-ordered card', () => {
  // The card shows it as a stub row; it cannot be printed (no address) and the print handler says
  // so. The numbers after it must not close up into a lie.
  const { stops, labels, missing } = cardManifestPages([B.stopNbr, '009999999', A.stopNbr], BOARD);
  assert.equal(missing, 1);
  assert.deepEqual(labels, [1, 3]);
  const out = printed(buildManifestHtml(stops, LOGO, 'SUW', { asGiven: true, labels }));
  assert.deepEqual(out.map((p) => [p.pro, p.seq]), [[B.stopNbr, '1'], [A.stopNbr, '3']]);
});

test('the route detail panel\'s manifest is untouched: no options, NuVizz order and numbers as before', () => {
  // RouteDetailBody passes its own orderRouteStops list and no options. Handing the builder the
  // stops shuffled proves it still sorts them itself on that path.
  const out = printed(buildManifestHtml([C, A, D, B], LOGO));
  assert.deepEqual(pros(out), ids(A, B, C, D));
  assert.deepEqual(seqs(out), ['1', '2', '3', '4']);
  assert.ok(out.every((p) => p.eta));
  assert.match(APP, /buildManifestHtml\(sorted, \(typeof window !== 'undefined' \? window\.location\.origin : ''\) \+ '\/davis-logo\.jpg'\)/,
    'the route detail call must stay exactly as it was');
});

test('labels are never applied to a re-sorted list — one stop\'s number on another stop\'s page', () => {
  assert.deepEqual(seqs(printed(buildManifestHtml([C, A, D, B], LOGO, null, { labels: [9, 8, 7, 6] }))), ['1', '2', '3', '4']);
});

test('a label list that does not line up with the stops is ignored rather than shifted', () => {
  const out = printed(buildManifestHtml([B, A], LOGO, null, { asGiven: true, labels: [1] }));
  assert.deepEqual(pros(out), ids(B, A));
  assert.deepEqual(seqs(out), ['2', '1'], 'falls back to each stop\'s own number, never a neighbour\'s');
});

test('the cover page counts every printed stop on the card path', () => {
  const html = cardHtml(ids(D, A));
  assert.match(html, /<div class="k">Stops<\/div><div>2 Stops<\/div>/);
  assert.match(html, /<div class="mf-route">SUW<\/div>/);
});

test('a single delivery ticket prints exactly as before: NuVizz\'s number and its ETA line', () => {
  assert.match(buildTicketBody(C, LOGO), /<span class="seq">3<\/span>/);
  assert.match(buildTicketBody(C, LOGO), /Next Stop: 09\/30\/2026 10:30:00 AM/);
  assert.match(buildTicketBody(C, LOGO, 'Delivery Ticket', { seqLabel: null }), /<span class="seq">3<\/span>/);
  assert.match(buildTicketBody(C, LOGO, 'Delivery Ticket', { seqLabel: 7 }), /<span class="seq">7<\/span>/);
  assert.doesNotMatch(buildTicketBody(C, LOGO, 'Delivery Ticket', { hideEta: true }), /Next Stop/);
});

// ── the pure helpers on their own ────────────────────────────────────────────
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

test('cardManifestPages: stops with no usable address are each their own stop, never merged', () => {
  const s1 = { stopNbr: '1', addr1: '   ', zip: '' };
  const s2 = { stopNbr: '2', addr1: '   ', zip: '' };
  assert.deepEqual(cardManifestPages(['1', '2'], new Map([['1', s1], ['2', s2]])).labels, [1, 2]);
});

test('stopOrdersAgree: same stops in the same order, nothing else', () => {
  assert.equal(stopOrdersAgree([A, B], [A, B]), true);
  assert.equal(stopOrdersAgree([A, B], [B, A]), false);
  assert.equal(stopOrdersAgree([A], [A, B]), false);
  assert.equal(stopOrdersAgree(null, []), false);
  assert.equal(stopOrdersAgree([], []), true);
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
