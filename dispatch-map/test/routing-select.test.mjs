// P2 (PR3) — unit tests for the Routing tab's selection geometry + per-stop
// display helpers. These import the SAME functions App.jsx ships (no copies),
// so they prove the core of Add-in-view (latLngInBounds), Box (boxFromCorners +
// latLngInBounds), Lasso (pointInPolygon), and the stop-detail formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon, latLngInBounds, boxFromCorners,
  fmtTime12, formatReceivingHours, lineItemDims,
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

// ── Receiving-hours formatting ──
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
