// P2 (PR3) — unit tests for the Routing tab's selection geometry + per-stop
// display helpers. These import the SAME functions App.jsx ships (no copies),
// so they prove the core of Add-in-view (latLngInBounds), Box (boxFromCorners +
// latLngInBounds), Lasso (pointInPolygon), and the stop-detail formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon, latLngInBounds, boxFromCorners,
  fmtTime12, formatReceivingHours, lineItemDims,
  moveItem, recomputeRoute, haversineMeters, isPlannedStop
} from '../src/lib/routing-select.js';

// ── Lasso: ray-casting point-in-polygon ──
test('pointInPolygon: inside vs outside a square', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]]; // [lat,lng]
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(5, 15, square), false);
});

test('pointInPolygon: degenerate paths never select', () => {
  assert.equal(pointInPolygon(5, 5, [[0, 0], [0, 10]]), false); // <3 vertices
  assert.equal(pointInPolygon(null, 5, [[0, 0], [0, 10], [10, 10]]), false);
});

test('pointInPolygon: concave (lasso) polygon excludes the notch', () => {
  // A "C" shape: point in the notch must be excluded.
  const c = [[0, 0], [0, 10], [4, 10], [4, 4], [8, 4], [8, 10], [12, 10], [12, 0]];
  assert.equal(pointInPolygon(6, 8, c), false); // in the notch
  assert.equal(pointInPolygon(2, 5, c), true);  // in the solid part
});

// ── The tap-lasso: a stop you TAPPED is a stop you SELECTED ──
// The touch lasso places vertices by tap, and a tap on a pin is routed straight into the vertex
// placer with that marker's own position — so the vertex IS the stop's lat/lng, bit for bit. A
// half-open ray cast called those stops "outside" and dropped every pin the dispatcher aimed at.
test('tap-lasso: a stop tapped as a lasso vertex is selected, not dropped', () => {
  // Four north-Georgia consignees tapped as the corners, one in the middle of the cluster.
  const uline = [34.0515, -84.0712], buford = [34.1204, -83.9955];
  const lawrenceville = [33.9562, -83.9880], duluth = [34.0029, -84.1446];
  const poly = [uline, buford, lawrenceville, duluth];
  for (const [lat, lng] of poly) assert.equal(pointInPolygon(lat, lng, poly), true);
  assert.equal(pointInPolygon(34.03, -84.05, poly), true); // the untapped stop in the middle
});

test('tap-lasso and Box agree on the same four corners', () => {
  const stops = [
    { lat: 34.0515, lng: -84.0712 }, { lat: 34.1204, lng: -83.9955 },
    { lat: 33.9562, lng: -83.9880 }, { lat: 34.0029, lng: -84.1446 },
    { lat: 34.0300, lng: -84.0500 },
  ];
  const poly = stops.slice(0, 4).map((s) => [s.lat, s.lng]);
  const box = boxFromCorners({ lat: 34.1204, lng: -84.1446 }, { lat: 33.9562, lng: -83.9880 });
  const byLasso = stops.filter((s) => pointInPolygon(s.lat, s.lng, poly)).length;
  const byBox = stops.filter((s) => latLngInBounds(s.lat, s.lng, box)).length;
  assert.equal(byLasso, 5);
  assert.equal(byBox, byLasso); // Box was always inclusive; the lasso no longer disagrees
});

test('pointInPolygon: a stop on an EDGE (not just a vertex) is inside', () => {
  const square = [[34, -84], [34, -83], [33, -83], [33, -84]];
  assert.equal(pointInPolygon(34, -83.5, square), true);   // on the north edge
  assert.equal(pointInPolygon(33.5, -84, square), true);   // on the west edge
  assert.equal(pointInPolygon(33.5, -83, square), true);   // on the east edge
  assert.equal(pointInPolygon(33, -83.5, square), true);   // on the south edge
});

test('pointInPolygon: the edge rule cannot reach the warehouse next door', () => {
  // EDGE_EPS is ~0.1mm. A stop 10m off the drawn line stays out, or the lasso would leak.
  const square = [[34, -84], [34, -83], [33, -83], [33, -84]];
  assert.equal(pointInPolygon(34.0001, -83.5, square), false);  // ~11 m north of the edge
  assert.equal(pointInPolygon(34.000001, -83.5, square), false); // ~11 cm north of the edge
});

test('pointInPolygon: a double-tapped vertex does not break the shape', () => {
  // Two identical consecutive vertices — what a double-tap on one spot leaves behind.
  const dup = [[34, -84], [34, -84], [34, -83], [33, -83], [33, -84]];
  assert.equal(pointInPolygon(33.5, -83.5, dup), true);
  assert.equal(pointInPolygon(34, -84, dup), true);   // the double-tapped corner itself
  assert.equal(pointInPolygon(35, -83.5, dup), false);
});

test('pointInPolygon: NaN coordinates never select (they pass the map’s != null gate)', () => {
  const square = [[34, -84], [34, -83], [33, -83], [33, -84]];
  assert.equal(pointInPolygon(NaN, -83.5, square), false);
  assert.equal(pointInPolygon(33.5, NaN, square), false);
  assert.equal(pointInPolygon(33.5, -83.5, [[NaN, -84], [34, -83], [33, -83]]), false);
});

// ── Add-in-view / Box: bounding-box containment ──
test('latLngInBounds: inclusive of edges, excludes outside', () => {
  const box = { north: 10, south: 0, east: 10, west: 0 };
  assert.equal(latLngInBounds(5, 5, box), true);
  assert.equal(latLngInBounds(10, 0, box), true);   // corner
  assert.equal(latLngInBounds(11, 5, box), false);  // north of
  assert.equal(latLngInBounds(5, -1, box), false);  // west of
  assert.equal(latLngInBounds(null, 5, box), false);
});

test('boxFromCorners normalizes any two tapped corners', () => {
  // Corners tapped in any order produce the same normalized box.
  const a = boxFromCorners({ lat: 10, lng: 2 }, { lat: 1, lng: 9 });
  assert.deepEqual(a, { north: 10, south: 1, east: 9, west: 2 });
  const b = boxFromCorners({ lat: 1, lng: 9 }, { lat: 10, lng: 2 });
  assert.deepEqual(a, b);
});

test('Box end-to-end: corners → box → enclosed stops', () => {
  const stops = [
    { stopNbr: 'A', lat: 34.1, lng: -84.0 },  // inside
    { stopNbr: 'B', lat: 34.9, lng: -83.1 },  // inside
    { stopNbr: 'C', lat: 33.0, lng: -84.0 },  // south, out
    { stopNbr: 'D', lat: 34.5, lng: -82.0 },  // east, out
  ];
  const box = boxFromCorners({ lat: 34.0, lng: -84.5 }, { lat: 35.0, lng: -83.0 });
  const inside = stops.filter((s) => latLngInBounds(s.lat, s.lng, box)).map((s) => s.stopNbr);
  assert.deepEqual(inside, ['A', 'B']);
});

test('Desktop drag-box selects the same set regardless of drag direction', () => {
  // The desktop rubber-band drag can start from any corner; the two LatLng
  // corners it produces must normalize to one box and select the same stops.
  const stops = [
    { stopNbr: 'A', lat: 34.1, lng: -84.0 },  // inside
    { stopNbr: 'B', lat: 34.9, lng: -83.1 },  // inside
    { stopNbr: 'C', lat: 33.0, lng: -84.0 },  // out
  ];
  const tl = { lat: 35.0, lng: -84.5 }, br = { lat: 34.0, lng: -83.0 };
  const tr = { lat: 35.0, lng: -83.0 }, bl = { lat: 34.0, lng: -84.5 };
  const sel = (a, b) => stops.filter((s) => latLngInBounds(s.lat, s.lng, boxFromCorners(a, b))).map((s) => s.stopNbr);
  const expected = ['A', 'B'];
  assert.deepEqual(sel(tl, br), expected); // drag ↘
  assert.deepEqual(sel(br, tl), expected); // drag ↖
  assert.deepEqual(sel(tr, bl), expected); // drag ↙
  assert.deepEqual(sel(bl, tr), expected); // drag ↗
});

// ── Receiving-hours formatting ──
test('fmtTime12 reads a FULL TIMESTAMP — the appointment window is stored as one', () => {
  // The match was anchored at the start of the string, so an ISO stamp fell through to
  // "return s" untouched — and the routing panel's Appointment window row reads
  // scheduledFrom/To, which ARE stamps. It printed
  // "2026-08-24T08:00:00–2026-08-24T08:05:00" where it meant "8:00a–8:05a".
  assert.equal(fmtTime12('2026-08-24T08:00:00'), '8:00a');
  assert.equal(fmtTime12('2026-08-24T08:05:00'), '8:05a');
  assert.equal(fmtTime12('2026-08-24 17:30'), '5:30p');
  assert.equal(fmtTime12('2026-08-24T00:15:00.000Z'), '12:15a');
});

test('fmtTime12 reads the DIGITS of a stamp, never a Date — these carry no offset', () => {
  // The stamps are naive ET wall-clock. Handing one to Date + timeZone reads four hours
  // early and rolls a pre-dawn slot to the PREVIOUS DAY — the trap board-flags.stampMinutes
  // and time-restrictions.clockMinFromStamp both document.
  assert.equal(fmtTime12('2026-08-24T00:15:00'), '12:15a', 'a quarter past midnight, not 8:15p on the 23rd');
  assert.equal(fmtTime12('2026-08-24T23:45:00'), '11:45p');
});

test('fmtTime12 still refuses free text rather than inventing a clock', () => {
  assert.equal(fmtTime12('call first'), 'call first');
  assert.equal(fmtTime12('appt only'), 'appt only');
  assert.equal(fmtTime12(''), '');
  assert.equal(fmtTime12(null), '');
  assert.equal(fmtTime12('2026-08-24T99:99:00'), '2026-08-24T99:99:00', 'an impossible clock is not a clock');
});

test('fmtTime12 converts 24h to compact 12h, passes through am/pm', () => {
  assert.equal(fmtTime12('08:00'), '8:00a');
  assert.equal(fmtTime12('14:30'), '2:30p');
  assert.equal(fmtTime12('00:15'), '12:15a');
  assert.equal(fmtTime12('12:00'), '12:00p');
  assert.equal(fmtTime12('8AM'), '8a');       // already meridiem → normalized
  assert.equal(fmtTime12(''), '');
});

test('formatReceivingHours groups consecutive identical days into ranges', () => {
  const note = {
    receiving_hours: {
      mon: { open: '08:00', close: '15:00' },
      tue: { open: '08:00', close: '15:00' },
      wed: { open: '08:00', close: '15:00' },
      thu: { open: '08:00', close: '15:00' },
      fri: { open: '08:00', close: '15:00' },
      sat: { open: '', close: '' },
      sun: { open: '', close: '' },
    },
    closed_days: ['sat'],
  };
  assert.equal(formatReceivingHours(note), 'Mon–Fri 8:00a–3:00p · Sat Closed');
});

test('formatReceivingHours handles legacy strings and empty notes', () => {
  assert.equal(formatReceivingHours({ receiving_hours: { mon: '6AM-2PM' } }), 'Mon 6AM-2PM');
  assert.equal(formatReceivingHours(null), null);
  assert.equal(formatReceivingHours({}), null);
  assert.equal(formatReceivingHours({ receiving_hours: {} }), null);
});

// ── Line-item dimensions ──
test('lineItemDims renders L×W×H, falls back to critical dimension, else empty', () => {
  assert.equal(lineItemDims({ length: 96, width: 48, height: 40, lengthUOM: 'in' }), '96×48×40 in');
  assert.equal(lineItemDims({ length: 144, lengthUOM: 'IN' }), '144×–×– IN');
  assert.equal(lineItemDims({ criticalDimension: 144, criticalDimensionUOM: 'IN' }), '144 IN');
  assert.equal(lineItemDims({ criticalDimension: 120 }), '120 in');
  assert.equal(lineItemDims({}), '');
  assert.equal(lineItemDims(null), '');
});

// ── Manual route reorder helpers ──
test('moveItem reorders within the array and renumbers implicitly by position', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 0, 2), ['B', 'C', 'A', 'D']); // A down to index 2
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 3, 0), ['D', 'A', 'B', 'C']); // D to front
  assert.deepEqual(moveItem(['A', 'B', 'C'], 1, 1), ['A', 'B', 'C']);           // no-op
  assert.deepEqual(moveItem(['A', 'B', 'C'], 0, 9), ['A', 'B', 'C']);           // out of range → unchanged copy
});

test('recomputeRoute: order-dependent legs/ETAs, depot-anchored, service dwell applied', () => {
  const depot = { lat: 0, lng: 0 };
  const stops = [{ id: 'S1', lat: 0, lng: 1 }, { id: 'S2', lat: 0, lng: 2 }];
  const r = recomputeRoute(stops, depot, 0, 600); // depart at 0, 10min service
  assert.equal(r.legs.length, 2);
  assert.equal(r.etas.length, 2);
  assert.equal(r.legs[0].fromId, 'depot');
  assert.equal(r.legs[1].fromId, 'S1');
  // ETA(S2) = drive(depot->S1) + service + drive(S1->S2)
  assert.equal(r.etas[1], r.legs[0].durationSec + 600 + r.legs[1].durationSec);
  assert.ok(r.totalDistanceMeters > 0 && r.totalDurationSec > 0);
});

test('recomputeRoute: reversing the order changes the total distance', () => {
  const depot = { lat: 0, lng: 0 };
  const fwd = recomputeRoute([{ id: 'A', lat: 0, lng: 1 }, { id: 'B', lat: 0, lng: 5 }], depot, 0, 0);
  const rev = recomputeRoute([{ id: 'B', lat: 0, lng: 5 }, { id: 'A', lat: 0, lng: 1 }], depot, 0, 0);
  assert.notEqual(fwd.totalDistanceMeters, rev.totalDistanceMeters);
});

test('recomputeRoute: single-stop and empty routes are clean', () => {
  const depot = { lat: 34, lng: -84 };
  const one = recomputeRoute([{ id: 'X', lat: 34.1, lng: -84.1 }], depot, 1000, 600);
  assert.equal(one.legs.length, 1);
  assert.equal(one.etas.length, 1);
  assert.equal(one.etas[0], 1000 + one.legs[0].durationSec);
  const none = recomputeRoute([], depot, 0, 600);
  assert.deepEqual(none.legs, []);
  assert.deepEqual(none.etas, []);
  assert.equal(none.totalDistanceMeters, 0);
});

test('haversineMeters is ~0 for identical points and positive otherwise', () => {
  assert.equal(Math.round(haversineMeters({ lat: 34, lng: -84 }, { lat: 34, lng: -84 })), 0);
  assert.ok(haversineMeters({ lat: 34, lng: -84 }, { lat: 34.1, lng: -84 }) > 1000);
});

// ── Per-load re-sequence strategies ──
import { resequence, depotSort, nearestNeighbor, twoOpt } from '../src/lib/routing-select.js';

const depot0 = { lat: 0, lng: 0 };
// Stops at increasing distance east of the depot.
const pts = [
  { id: 'C', lat: 0, lng: 3 },
  { id: 'A', lat: 0, lng: 1 },
  { id: 'D', lat: 0, lng: 5 },
  { id: 'B', lat: 0, lng: 2 },
];
const ids = (arr) => arr.map((s) => s.id);

test('resequence reverse flips the current order', () => {
  assert.deepEqual(ids(resequence(pts, depot0, 'reverse')), ['B', 'D', 'A', 'C']);
});

test('resequence closest/farthest sort by depot distance', () => {
  assert.deepEqual(ids(resequence(pts, depot0, 'closest')), ['A', 'B', 'C', 'D']);
  assert.deepEqual(ids(resequence(pts, depot0, 'farthest')), ['D', 'C', 'B', 'A']);
});

test('resequence min returns a full permutation and is no worse than the input order', () => {
  const out = resequence(pts, depot0, 'min');
  assert.deepEqual([...ids(out)].sort(), ['A', 'B', 'C', 'D']); // permutation, all present
  // for these colinear points the optimal tour is A,B,C,D (nearest-neighbour + 2opt finds it)
  assert.deepEqual(ids(out), ['A', 'B', 'C', 'D']);
});

test('resequence is a no-op for <2 stops and unknown strategy', () => {
  assert.deepEqual(ids(resequence([pts[0]], depot0, 'min')), ['C']);
  assert.deepEqual(ids(resequence(pts, depot0, 'bogus')), ['C', 'A', 'D', 'B']);
});

test("resequence 'loop' makes a U-shape — down one side of the corridor and back the other", () => {
  const depot = { lat: 0, lng: 0 };
  // Highway runs east-west; stops sit on the south (lat -1) and north (lat +1) sides,
  // fed in a criss-crossing zigzag order (S,N,S,N,…) like the "Farthest first" complaint.
  const corridor = [
    { id: 'S1', lat: -1, lng: 1 }, { id: 'N1', lat: 1, lng: 1 },
    { id: 'S2', lat: -1, lng: 2 }, { id: 'N2', lat: 1, lng: 2 },
    { id: 'S3', lat: -1, lng: 3 }, { id: 'N3', lat: 1, lng: 3 },
  ];
  const out = resequence(corridor, depot, 'loop');
  assert.deepEqual([...ids(out)].sort(), ['N1', 'N2', 'N3', 'S1', 'S2', 'S3']); // permutation
  // U-shape signature: the order runs all the way out along one side, then back along the
  // other — exactly ONE switch between the south and north sides (no zigzag crossings).
  const sides = out.map((s) => (s.lat < 0 ? 'S' : 'N'));
  const switches = sides.filter((v, i) => i > 0 && v !== sides[i - 1]).length;
  assert.equal(switches, 1, `expected one side-switch (U-shape), got ${switches}: ${ids(out).join(',')}`);
});

// ── isPlannedStop ────────────────────────────────────────────────────────────
// Drives the Routing map's muted "already on a load" pin. Chad, 7/27: he saved a
// 13-stop MITCHELL route, closed the card, and every stop went back to looking
// like the unplanned pool around it. The board rows were correct (SCHEDULED,
// isPlanned, routeName MITCHELL) — planned simply had no pin of its own.

test('isPlannedStop: the board flag is the primary signal', () => {
  assert.equal(isPlannedStop({ isPlanned: true, routeName: 'MITCHELL' }), true);
  assert.equal(isPlannedStop({ isPlanned: false }), false);
});

test('isPlannedStop: isUnplanned wins outright over a stale route name', () => {
  // The write-through sets isUnplanned explicitly when a stop comes OFF a load, and a
  // stale routeName can still be sitting on the row. Trusting the name would keep the
  // stop muted after it was un-planned — invisible work.
  assert.equal(isPlannedStop({ isUnplanned: true, routeName: 'MITCHELL', isPlanned: true }), false);
  assert.equal(isPlannedStop({ isUnplanned: true, loadNbr: 'DAVIS000199806' }), false);
});

test('isPlannedStop: a route/load name alone counts (older cache rows carry no flag)', () => {
  assert.equal(isPlannedStop({ routeName: 'MITCHELL' }), true);
  assert.equal(isPlannedStop({ loadNbr: 'DAVIS000199806' }), true);
});

test('isPlannedStop: an unplanned pool stop is never planned', () => {
  assert.equal(isPlannedStop({ isUnplanned: true }), false);
  assert.equal(isPlannedStop({ stopNbr: '007152277' }), false);
  assert.equal(isPlannedStop({ routeName: '', loadNbr: null }), false);
});

test('isPlannedStop: junk input never throws', () => {
  for (const v of [null, undefined, {}, 0, '']) assert.equal(isPlannedStop(v), false);
});
