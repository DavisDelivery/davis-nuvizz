// test/claude-shadow-core-bounds-small-day.test.mjs — A SMALL PLAN OPENS WITH EVERY STOP IN VIEW.
//
// Audit 2026-09-27 (shadow-frontend-5): the map's opening view promises the middle 94% of the stops on
// each axis — 3% trimmed at EACH end. The upper end's index was floored like the lower one, so on any
// day of 34 stops or fewer the northernmost and easternmost stop were always cut and the south-west
// end never was. A plan of a couple of loads around Gainesville and Athens, north-east of Buford,
// opened with two of its five stops off-screen and "2 stops lie beyond that view". Trimming 3% of five
// stops trims none; on a big day the same number comes off each end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreBounds } from '../src/shadow/backtest-map-core.js';

const BUFORD = { lat: 34.14838, lng: -83.95948 };   // the terminal (history-derive.mts DEPOT)

test('a five-stop plan north-east of Buford (Gainesville, Braselton, Commerce, Athens, Winder) opens with all five in view', () => {
  const stops = [
    { id: 1, lat: 34.2979, lng: -83.8241 },   // Gainesville — the northernmost
    { id: 2, lat: 34.1093, lng: -83.7627 },   // Braselton
    { id: 3, lat: 34.2040, lng: -83.4571 },   // Commerce
    { id: 4, lat: 33.9519, lng: -83.3576 },   // Athens — the easternmost
    { id: 5, lat: 33.9926, lng: -83.7202 },   // Winder
  ];
  const { bounds, outside } = coreBounds({ stops, depot: BUFORD });
  assert.equal(outside, 0, JSON.stringify(bounds));
  assert.ok(bounds.north >= 34.2979 && bounds.east >= -83.3576);
});

for (const n of [2, 3, 10, 34]) {
  test(`a day of ${n} stops in a line trims nothing at either end`, () => {
    const stops = Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: 33.5 + i * 0.01, lng: -84.5 + i * 0.01 }));
    // The terminal in the middle of the line, so it widens neither end.
    const mid = stops[Math.floor(n / 2)];
    assert.equal(coreBounds({ stops, depot: { lat: mid.lat, lng: mid.lng } }).outside, 0);
  });
}

test('a day of 100 stops trims the same number off the north/east end as off the south/west end', () => {
  const stops = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, lat: 33.0 + i * 0.01, lng: -85.0 + i * 0.01 }));
  const { bounds } = coreBounds({ stops, depot: { lat: stops[50].lat, lng: stops[50].lng } });
  const cutSouth = stops.filter((p) => p.lat < bounds.south).length;
  const cutNorth = stops.filter((p) => p.lat > bounds.north).length;
  const cutWest = stops.filter((p) => p.lng < bounds.west).length;
  const cutEast = stops.filter((p) => p.lng > bounds.east).length;
  assert.equal(cutNorth, cutSouth);
  assert.equal(cutEast, cutWest);
  assert.equal(cutSouth, 2, 'floor(3% of 99 gaps) = 2 stops off each end');
});
