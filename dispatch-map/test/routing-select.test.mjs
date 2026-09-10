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

test('resequence closest/farthest on a straight line still walk the line in order', () => {
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


// ── Farthest first / Closest first are a SWEEP, not a sort (Chad, 2026-09-10) ──────────────
// "it should be pretty linear from furthest point out to the last but this is jumping all
// around." The picker sorted by radius from the depot; a radius says nothing about direction,
// so towns at one radius in three directions interleaved and the route crossed itself.
import { farthestFirst, closestFirst, improvePinnedPath, pinnedPathCost, townsOf, SWEEP_MODE, TOWN_RADIUS_METERS } from '../src/lib/routing-select.js';

const BUFORD = { lat: 34.147791, lng: -83.960911 };
// The JEFF route from the report — the card read "14 stops · 15 orders" — placed by the towns
// on the card (public geography; the card's real pins are NuVizz data and are not in the repo).
// 15 rows: the two BOWSTONE orders share one address, as they did on the card.
const JEFF = [
  { id: 'TAG CITY (Ellijay)',           lat: 34.6948, lng: -84.4822 },
  { id: 'UPS STORE (Jasper)',           lat: 34.4679, lng: -84.4291 },
  { id: 'PREFERRED MACHINE (Jasper)',   lat: 34.4500, lng: -84.4200 },
  { id: 'ROYSTON (Jasper)',             lat: 34.4700, lng: -84.4000 },
  { id: 'BLACK EAGLE (Canton)',         lat: 34.2500, lng: -84.4900 },
  { id: 'ELEVATE (Tate)',               lat: 34.4200, lng: -84.3800 },
  { id: 'COMPASS (Ball Ground)',        lat: 34.3400, lng: -84.3800 },
  { id: 'GO PLASTICS (Ball Ground)',    lat: 34.3350, lng: -84.3750 },
  { id: 'CHART (Ball Ground)',          lat: 34.3300, lng: -84.3700 },
  { id: 'BOWSTONE A (Ball Ground)',     lat: 34.3200, lng: -84.3600 },
  { id: 'BOWSTONE B (Ball Ground)',     lat: 34.3200, lng: -84.3600 },
  { id: 'RAYDEO (Ball Ground)',         lat: 34.3100, lng: -84.3500 },
  { id: 'STOP 13 (Nelson)',             lat: 34.3700, lng: -84.3700 },
  { id: 'STOP 14 (Hwy 53)',             lat: 34.4300, lng: -84.2500 },
  { id: 'STOP 15 (Ball Ground)',        lat: 34.3500, lng: -84.3400 },
];
const townOf = (s) => s.id.replace(/^.*\((.*)\)$/, '$1');

// Do segments p1-p2 and p3-p4 properly cross (share an interior point)?
function segmentsCross(p1, p2, p3, p4) {
  const orient = (a, b, c) => Math.sign((b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng));
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}
// How many times the drawn route (depot → … → depot) crosses itself.
function selfCrossings(order, depot) {
  const pts = [depot, ...order, depot];
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pts[i].lat === pts[i + 1].lat && pts[i].lng === pts[i + 1].lng) continue;   // same address twice
    segs.push([pts[i], pts[i + 1]]);
  }
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) {
      if (i === 0 && j === segs.length - 1) continue;   // the two depot legs share the depot
      if (segmentsCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) n++;
    }
  }
  return n;
}
// Number of times the order switches from one group to another (a group visited in one run
// contributes no switches beyond its entry).
const groupSwitches = (order, groupOf) => order.filter((s, i) => i > 0 && groupOf(s) !== groupOf(order[i - 1])).length;

// The far-end-first path, measured the way the strategy is defined: first stop → … → the yard.
const homewardMeters = (order, depot) => {
  let total = 0;
  for (let i = 1; i < order.length; i++) total += haversineMeters(order[i - 1], order[i]);
  return total + haversineMeters(order[order.length - 1], depot);
};
const byId = (list, ...names) => names.map((n) => list.find((s) => s.id.startsWith(n)));

// Nelson is one stop two miles north of the Ball Ground cluster; by the 2.5-mile rule it is the
// same town, so the card's labels are read as areas.
const areaOf = (s) => (townOf(s) === 'Nelson' ? 'Ball Ground' : townOf(s));
const areaRuns = (order) => order.filter((s, i) => i === 0 || areaOf(s) !== areaOf(order[i - 1])).map(areaOf);

test('farthest first — JEFF, 2026-09-10: out to Ellijay, then home one town at a time, never crossing itself', () => {
  const out = farthestFirst(JEFF, BUFORD);
  assert.deepEqual([...ids(out)].sort(), [...ids(JEFF)].sort());          // every stop, once
  assert.equal(out[0].id, 'TAG CITY (Ellijay)');                            // the far end comes first
  assert.equal(selfCrossings(out, BUFORD), 0, `route crosses itself: ${ids(out).join(' → ')}`);
  // THE RULE CHAD CHOSE: a town is worked in one visit. Every area on the card is one run —
  // no town appears twice in the sequence of areas.
  const runs = areaRuns(out);
  assert.equal(new Set(runs).size, runs.length, `a town is visited twice: ${runs.join(' → ')}`);
  // The old logic, on the same stops, is the card in the report: Jasper, then Canton, then Tate,
  // then Ball Ground, then back out toward Tate — and it drives materially farther.
  const radial = depotSort(JEFF, BUFORD, 'desc');
  assert.deepEqual(radial.slice(0, 6).map(townOf), ['Ellijay', 'Jasper', 'Jasper', 'Jasper', 'Canton', 'Tate']);
  assert.ok(homewardMeters(out, BUFORD) < 0.85 * homewardMeters(radial, BUFORD));
  // Keeping towns whole costs paper miles against the pure shortest path; Chad accepted "a few
  // percent". On this geography it is under two.
  const pure = farthestFirst(JEFF, BUFORD, 'pure');
  assert.ok(homewardMeters(out, BUFORD) <= 1.05 * homewardMeters(pure, BUFORD), 'towns cost more than 5% over the pure sweep');
  // And it is no longer than either order a dispatcher would draw by hand for this route:
  // down the east side and finish with Canton, or down the west side and finish out on 53.
  const eastThenCanton = byId(JEFF, 'TAG', 'ROYSTON', 'UPS', 'PREFERRED', 'ELEVATE', 'STOP 14', 'STOP 13', 'COMPASS', 'GO PLASTICS', 'CHART', 'STOP 15', 'BOWSTONE A', 'BOWSTONE B', 'RAYDEO', 'BLACK');
  const westThen53 = byId(JEFF, 'TAG', 'ROYSTON', 'UPS', 'PREFERRED', 'BLACK', 'RAYDEO', 'BOWSTONE A', 'BOWSTONE B', 'STOP 15', 'CHART', 'GO PLASTICS', 'COMPASS', 'STOP 13', 'ELEVATE', 'STOP 14');
  for (const hand of [eastThenCanton, westThen53]) {
    assert.equal(hand.length, JEFF.length);
    assert.ok(hand.every(Boolean));
    assert.ok(homewardMeters(out, BUFORD) <= homewardMeters(hand, BUFORD) + 1, `a hand-drawn order beat it: ${ids(out).join(' → ')}`);
  }
  // The two Bowstone orders at one address stay back to back.
  const bow = out.map((s, i) => (/^BOWSTONE/.test(s.id) ? i : -1)).filter((i) => i >= 0);
  assert.equal(bow[1] - bow[0], 1);
});

test('the switch: SWEEP_MODE is "towns"; "pure" is one word away and brings the mid-town spur back', () => {
  assert.equal(SWEEP_MODE, 'towns');
  assert.equal(TOWN_RADIUS_METERS, 4000);
  // The pure shortest pinned path pays for Canton as a spur from the middle of Ball Ground
  // (Chart → Canton → Raydeo): verified exact with a Held-Karp solve during review. That is
  // what Chad was shown and chose against, and what "put it back the way it was" returns to.
  const pure = farthestFirst(JEFF, BUFORD, 'pure');
  const canton = pure.findIndex((s) => townOf(s) === 'Canton');
  assert.equal(townOf(pure[canton - 1]), 'Ball Ground');
  assert.equal(townOf(pure[canton + 1]), 'Ball Ground');
  assert.ok(new Set(areaRuns(pure)).size < areaRuns(pure).length, 'pure mode should visit Ball Ground twice');
  // The picker follows the switch.
  assert.deepEqual(ids(resequence(JEFF, BUFORD, 'farthest')), ids(farthestFirst(JEFF, BUFORD, 'towns')));
  assert.deepEqual(ids(resequence(JEFF, BUFORD, 'closest')), ids(closestFirst(JEFF, BUFORD, 'towns')));
  assert.notDeepEqual(ids(pure), ids(farthestFirst(JEFF, BUFORD)));
});

test('closest first — JEFF: the nearest stop first, Ellijay last, towns whole on the way out', () => {
  const out = closestFirst(JEFF, BUFORD);
  assert.deepEqual([...ids(out)].sort(), [...ids(JEFF)].sort());
  assert.equal(out[0].id, 'RAYDEO (Ball Ground)');                     // nearest to Buford
  assert.equal(out[out.length - 1].id, 'TAG CITY (Ellijay)');            // farthest is last
  const runs = areaRuns(out);
  assert.equal(new Set(runs).size, runs.length, `a town is visited twice: ${runs.join(' → ')}`);
});

test('towns: stops chain into one town within 2.5 miles of a neighbour; a lone stop is its own', () => {
  // Node 0 is the depot. A–B–C sit 3 km apart in a line (each within 4 km of the next, A and C
  // 6 km apart); D is 10 km from everything. Single linkage: {A,B,C} and {D}.
  const km = (a, b) => Math.abs(a - b) * 1000;
  const pos = [0, 20, 23, 26, 40];                       // depot, A, B, C, D on one axis, km
  const cost = pos.map((p) => pos.map((q) => km(p, q)));
  assert.deepEqual(townsOf([1, 2, 3, 4], cost, 4000), [[1, 2, 3], [4]]);
  assert.deepEqual(townsOf([4, 3, 2, 1], cost, 4000), [[1, 2, 3], [4]]);   // input order does not matter
  assert.deepEqual(townsOf([1, 2, 3, 4], cost, 2000), [[1], [2], [3], [4]]);
  // Asymmetric: within radius EITHER way shares a town.
  const asym = pos.map((p) => pos.map((q) => km(p, q)));
  asym[1][2] = 9000;                                      // A→B is a long way round; B→A is 3 km
  assert.deepEqual(townsOf([1, 2, 3, 4], asym, 4000), [[1, 2, 3], [4]]);
});

// Two arms of stops leaving the depot in different directions, at nearly the same radii — the
// geometry that broke the sort: it alternated arms on every stop.
const armY = () => [
  { id: 'A1', lat: 1, lng: 0 }, { id: 'B1', lat: 0, lng: 1.05 },
  { id: 'A2', lat: 2, lng: 0 }, { id: 'B2', lat: 0, lng: 2.05 },
  { id: 'A3', lat: 3, lng: 0 }, { id: 'B3', lat: 0, lng: 3.05 },
  { id: 'A4', lat: 4, lng: 0 }, { id: 'B4', lat: 0, lng: 4.05 },
];
const arm = (s) => s.id[0];

test('farthest first — two arms at one radius: the far end first, then one arm, then the other', () => {
  const out = farthestFirst(armY(), depot0);
  assert.deepEqual([...ids(out)].sort(), ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
  assert.equal(out[0].id, 'B4');
  assert.equal(groupSwitches(depotSort(armY(), depot0, 'desc'), arm), 7, 'the old sort alternated arms every stop');
  assert.equal(groupSwitches(out, arm), 1, `arms interleaved: ${ids(out).join(' → ')}`);
  assert.equal(selfCrossings(out, depot0), 0);
});

test('closest first — the mirror: nearest stop first, farthest stop last, one arm then the other', () => {
  const out = closestFirst(armY(), depot0);
  assert.deepEqual([...ids(out)].sort(), ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
  assert.equal(out[0].id, 'A1');                       // 1.0 from the depot; B1 is 1.05
  assert.equal(out[out.length - 1].id, 'B4');          // the far end is where this one finishes
  assert.equal(groupSwitches(out, arm), 1, `arms interleaved: ${ids(out).join(' → ')}`);
  // Both strategies reach the picker through resequence.
  assert.deepEqual(ids(resequence(armY(), depot0, 'closest')), ids(out));
  assert.deepEqual(ids(resequence(armY(), depot0, 'farthest')), ids(farthestFirst(armY(), depot0)));
});

test('sweep: a stop with no map position rides at the end in its own order — never dropped, never in the math', () => {
  const stops = [
    { id: 'ghost1', lat: null, lng: null },
    ...armY(),
    { id: 'ghost2', lat: NaN, lng: -84 },
    { id: 'ghost3', lat: 34 },
  ];
  for (const fn of [farthestFirst, closestFirst]) {
    const out = fn(stops, depot0);
    assert.equal(out.length, stops.length);
    assert.deepEqual(ids(out).slice(-3), ['ghost1', 'ghost2', 'ghost3']);
    assert.deepEqual([...ids(out).slice(0, 8)].sort(), ids(armY()).sort());
    assert.equal(groupSwitches(out.slice(0, 8), arm), 1);
  }
});

test('sweep: two stops, one address twice, every stop at one radius, and non-array input', () => {
  const two = [{ id: 'near', lat: 0, lng: 1 }, { id: 'far', lat: 0, lng: 2 }];
  assert.deepEqual(ids(farthestFirst(two, depot0)), ['far', 'near']);
  assert.deepEqual(ids(closestFirst(two, depot0)), ['near', 'far']);
  // Same address twice (two orders, one dock): both present, back to back.
  const dup = [{ id: 'x1', lat: 1, lng: 1 }, { id: 'y', lat: 3, lng: 0 }, { id: 'x2', lat: 1, lng: 1 }];
  const d = ids(farthestFirst(dup, depot0));
  assert.deepEqual([...d].sort(), ['x1', 'x2', 'y']);
  assert.equal(Math.abs(d.indexOf('x1') - d.indexOf('x2')), 1);
  // Every stop EXACTLY the same distance out — one degree of arc along the equator or up the
  // meridian, which haversine scores identically (a hexagon of sin/cos points does not: the
  // sphere is not a plane). Nothing to pin at the far end of "closest first" that is not also
  // the near end — it must still return every stop exactly once, nearest-tied stop first.
  const tied = [{ id: 'E', lat: 0, lng: 1 }, { id: 'W', lat: 0, lng: -1 }, { id: 'N', lat: 1, lng: 0 }];
  assert.equal(new Set(tied.map((s) => haversineMeters(depot0, s).toFixed(3))).size, 1, 'fixture must tie exactly');
  assert.deepEqual([...ids(closestFirst(tied, depot0))].sort(), ['E', 'N', 'W']);
  assert.deepEqual([...ids(farthestFirst(tied, depot0))].sort(), ['E', 'N', 'W']);
  assert.equal(closestFirst(tied, depot0).length, 3);
  // And a near-tie hexagon still comes back whole and uncrossed.
  const ring = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, lat: Math.sin((i * Math.PI) / 3), lng: Math.cos((i * Math.PI) / 3) }));
  assert.deepEqual([...ids(closestFirst(ring, depot0))].sort(), ids(ring).sort());
  assert.equal(selfCrossings(farthestFirst(ring, depot0), depot0), 0);
  // Single stop / nothing / not an array.
  assert.deepEqual(ids(farthestFirst([two[0]], depot0)), ['near']);
  assert.deepEqual(farthestFirst([], depot0), []);
  assert.deepEqual(resequence(null, depot0, 'farthest'), []);
});

test('sweep: the same stops in any order give the same answer — a drag then a re-pick does not "change its mind"', () => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (const n of [12, 30, 60]) {
    const set = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, lat: 34.0 + rnd() * 0.8, lng: -84.6 + rnd() * 0.8 }));
    const base = ids(farthestFirst(set, BUFORD)), baseC = ids(closestFirst(set, BUFORD));
    for (let k = 0; k < 5; k++) {
      const shuffled = [...set].sort(() => rnd() - 0.5);
      assert.deepEqual(ids(farthestFirst(shuffled, BUFORD)), base, `farthest differs on a reordered ${n}-stop set`);
      assert.deepEqual(ids(closestFirst(shuffled, BUFORD)), baseC, `closest differs on a reordered ${n}-stop set`);
    }
  }
});

test('sweep: deterministic, strictly shorter than the old radial sort, and fast at the 150-stop selection cap', () => {
  // Seeded LCG so the fixture is the same on every run (no Math.random in a test that pins a bound).
  let seed = 20260910;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, lat: 34.0 + rnd() * 0.8, lng: -84.6 + rnd() * 0.8 }));
  // About 10 ms here (60 ms cold). The bound is loose on purpose: a shared CI runner under a
  // parallel suite is many times slower than a laptop, and a wall-clock bound that fails only
  // there is a red build with nothing to fix. It exists to catch the algorithm going back to
  // re-summing the whole path per candidate, which took 1.5 s and would blow through it anywhere.
  const t0 = performance.now();
  const a = farthestFirst(many, BUFORD);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `150 stops took ${ms.toFixed(0)} ms`);
  assert.deepEqual([...ids(a)].sort(), [...ids(many)].sort());
  assert.deepEqual(ids(farthestFirst(many, BUFORD)), ids(a));                 // same stops, same answer
  const radial = depotSort(many, BUFORD, 'desc');
  // Strict, and by a wide margin: the old logic IS the radial sort, so `<=` would pass a revert.
  assert.ok(homewardMeters(a, BUFORD) < 0.5 * homewardMeters(radial, BUFORD));
  assert.equal(a[0].id, radial[0].id);                                        // still the farthest first
  // A regular three-lane lattice is the worst seed geometry the review found (the radius-order
  // seed had not converged at the pass cap); it must still come back quickly and shorter.
  const lattice = Array.from({ length: 150 }, (_, i) => ({ id: `l${i}`, lat: 34.2 + i * 0.01, lng: -84 + (i % 3) * 0.05 }));
  const t1 = performance.now();
  const b = farthestFirst(lattice, BUFORD);
  const ms2 = performance.now() - t1;
  assert.ok(ms2 < 1500, `150-stop lattice took ${ms2.toFixed(0)} ms`);
  assert.deepEqual([...ids(b)].sort(), [...ids(lattice)].sort());
  assert.ok(homewardMeters(b, BUFORD) < homewardMeters(depotSort(lattice, BUFORD, 'desc'), BUFORD));
  const c = closestFirst(many, BUFORD);
  assert.equal(c[0].id, depotSort(many, BUFORD, 'asc')[0].id);
  assert.equal(c[c.length - 1].id, radial[0].id);
});

test('improvePinnedPath never lengthens a path and never moves either pinned end', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pts = Array.from({ length: 25 }, () => ({ lat: rnd() * 10, lng: rnd() * 10 }));
  const cost = pts.map((p) => pts.map((q) => Math.hypot(p.lat - q.lat, p.lng - q.lng)));
  const interior = Array.from({ length: 23 }, (_, i) => i + 1);      // node 0 = start, node 24 = end
  const before = pinnedPathCost(interior, 0, 24, cost);
  const out = improvePinnedPath(interior, 0, 24, cost);
  assert.deepEqual([...out].sort((x, y) => x - y), interior);
  assert.ok(pinnedPathCost(out, 0, 24, cost) < before);
  assert.deepEqual(improvePinnedPath([], 0, 24, cost), []);
  assert.deepEqual(improvePinnedPath([5], 0, 24, cost), [5]);
});
