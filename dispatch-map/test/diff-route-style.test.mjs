// test/diff-route-style.test.mjs — the Diff tab's two routes.
// Imports the SAME functions App.jsx ships (no copy), so these prove the real behaviour.
//
// Regression origin (Chad, Diff tab, Aaron Mitchell focused): "need an orginal line and new
// line." Both were already drawn — the original at weight 2.5 / opacity 0.50 / zIndex 4, the new
// at weight 4.0 / opacity 0.95 / zIndex 6 — so the original was thinner AND fainter AND under the
// line painted on top of it. Wherever the two plans agreed, which is most of a real route, it was
// invisible; the fragments that escaped read as a road, not as a route.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffRouteStyle, DIFF_ORIGINAL_COLOR, DIFF_CASING_RATIO, groupDispatchTrips,
} from '../src/lib/diff-route-style.js';

const original = () => diffRouteStyle('original');
const proposed = (color = '#c0392b') => diffRouteStyle('new', { color });

test('THE INVARIANT: the original is wider than the new, so it can never be hidden under it', () => {
  // This is the whole fix. Opacity and colour both lose to whatever is painted on top; width is
  // the only property that still shows when two routes are exactly coincident. If this ever
  // flips back, the Diff tab silently goes back to displaying one route.
  assert.ok(original().strokeWeight > proposed().strokeWeight,
    `original ${original().strokeWeight} must exceed new ${proposed().strokeWeight}`);
  const sleeve = (original().strokeWeight - proposed().strokeWeight) / 2;
  assert.ok(sleeve >= 1.5, `each side of the sleeve is ${sleeve}px — under ~1.5px it stops reading as a line`);
});

test('the original sits UNDER the new — the proposal is the foreground', () => {
  assert.ok(original().zIndex < proposed().zIndex);
});

test('the original is never a driver colour, whatever it is handed', () => {
  // Neutral by design: a coloured original could be mistaken for one of the engine's routes.
  assert.equal(original().strokeColor, DIFF_ORIGINAL_COLOR);
  assert.equal(diffRouteStyle('original', { color: '#c0392b' }).strokeColor, DIFF_ORIGINAL_COLOR);
});

test('the new route carries the driver colour, and is fully opaque', () => {
  assert.equal(proposed('#16a34a').strokeColor, '#16a34a');
  assert.equal(proposed().strokeOpacity, 1, 'the proposal is the answer — it should not look tentative');
});

test('the original is soft but still drawn — it is a sleeve, not a shadow', () => {
  const o = original();
  assert.ok(o.strokeOpacity > 0.3 && o.strokeOpacity < 0.7, `opacity ${o.strokeOpacity} must read as a line, not as map furniture`);
});

test('a new route with no driver colour still draws rather than vanishing', () => {
  assert.equal(diffRouteStyle('new').strokeColor, DIFF_ORIGINAL_COLOR);
  assert.equal(diffRouteStyle('new', {}).strokeWeight, proposed().strokeWeight);
});

test('every value Google Maps needs is present and finite on both sides', () => {
  for (const st of [original(), proposed()]) {
    for (const k of ['strokeColor', 'strokeOpacity', 'strokeWeight', 'zIndex']) {
      assert.ok(st[k] !== undefined, `${k} missing`);
    }
    assert.ok(Number.isFinite(st.strokeWeight) && st.strokeWeight > 0);
    assert.ok(Number.isFinite(st.zIndex));
    assert.match(st.strokeColor, /^#[0-9a-f]{6}$/i);
  }
});

test('the casing ratio is what produces the width gap — they cannot drift apart', () => {
  assert.equal(original().strokeWeight, Math.round(proposed().strokeWeight * DIFF_CASING_RATIO * 10) / 10);
});

test('the OLD styling would have failed the invariant — pinned so it cannot come back', () => {
  // The exact numbers from before the fix, as a reminder of what "both lines are drawn" looked
  // like on screen when one of them was thinner than the other.
  const before = { original: { strokeWeight: 2.5, zIndex: 4 }, next: { strokeWeight: 4, zIndex: 6 } };
  assert.ok(before.original.strokeWeight < before.next.strokeWeight, 'that is why only one line was visible');
  assert.ok(original().strokeWeight > proposed().strokeWeight, 'and why this assertion now holds');
});

// ── one line per TRIP, not per driver ───────────────────────────────────────
//
// Chad, on the same focused diff: "what is all the gray shadow lines?" — a bundle of wide grey
// bands crossing the whole metro on Nana Owusu (2 trips, 24 stops). actual_pos restarts at 1 on
// every load, so grouping a two-trip driver into ONE line and sorting by position interleaves
// the trips (trip1-stop, trip2-stop, trip1-stop…) and draws a route shuttling back and forth.
// Always wrong; only visible once the original became a casing.

// Owusu: trip 1 around Marietta, trip 2 up by the warehouse. Deliberately shuffled, and the
// two trips share positions 1..3 — the collision that produced the zig-zag.
const owusu = () => [
  { id: 'm2', actual_driver: 'NANA_OWUSU', actual_trip: 'TRIP_A', actual_pos: 2, lat: 33.95, lng: -84.55 },
  { id: 'b1', actual_driver: 'NANA_OWUSU', actual_trip: 'TRIP_B', actual_pos: 1, lat: 34.12, lng: -84.00 },
  { id: 'm1', actual_driver: 'NANA_OWUSU', actual_trip: 'TRIP_A', actual_pos: 1, lat: 33.94, lng: -84.54 },
  { id: 'b3', actual_driver: 'NANA_OWUSU', actual_trip: 'TRIP_B', actual_pos: 3, lat: 34.14, lng: -84.02 },
  { id: 'm3', actual_driver: 'NANA_OWUSU', actual_trip: 'TRIP_A', actual_pos: 3, lat: 33.96, lng: -84.56 },
  { id: 'b2', actual_driver: 'NANA_OWUSU', actual_trip: 'TRIP_B', actual_pos: 2, lat: 34.13, lng: -84.01 },
];

test('a two-trip driver draws TWO lines, not one line crossing town six times', () => {
  const groups = groupDispatchTrips(owusu());
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.drv), ['NANA_OWUSU', 'NANA_OWUSU']);
});

test('each trip is in its own delivery order — the trips never interleave', () => {
  const groups = groupDispatchTrips(owusu());
  const ids = groups.map((g) => g.stops.map((s) => s.id));
  assert.deepEqual(ids.find((a) => a[0] === 'm1'), ['m1', 'm2', 'm3']);
  assert.deepEqual(ids.find((a) => a[0] === 'b1'), ['b1', 'b2', 'b3']);
  // The old behaviour, for the record: one group sorted by a position two trips both use.
  const flat = [...owusu()].sort((a, b) => a.actual_pos - b.actual_pos).map((s) => s.id);
  assert.notDeepEqual(flat, ['m1', 'm2', 'm3', 'b1', 'b2', 'b3']);
  assert.equal(flat[0][0] !== flat[1][0], true, 'consecutive stops came off different trips — that is the zig-zag');
});

test('a plan with no actual_trip falls back to one line per driver (old stored plans)', () => {
  const legacy = owusu().map(({ actual_trip, ...s }) => s);
  const groups = groupDispatchTrips(legacy);
  assert.equal(groups.length, 1, 'unchanged behaviour rather than a broken map while plans catch up');
  assert.equal(groups[0].stops.length, 6);
});

test('two drivers stay two groups even when their trip keys match', () => {
  const groups = groupDispatchTrips([
    { id: 'a', actual_driver: 'LEROY_SMITH', actual_trip: 'T1', actual_pos: 1 },
    { id: 'b', actual_driver: 'MARCUS_CRUMPTON', actual_trip: 'T1', actual_pos: 1 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.drv).sort(), ['LEROY_SMITH', 'MARCUS_CRUMPTON']);
});

test('a driver id containing the separator does not split into phantom trips', () => {
  // The driver rides on the group rather than being parsed back out of the composite key.
  const groups = groupDispatchTrips([
    { id: 'a', actual_driver: 'A::B', actual_trip: 'T1', actual_pos: 1 },
    { id: 'b', actual_driver: 'A::B', actual_trip: 'T1', actual_pos: 2 },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].drv, 'A::B');
});

test('unassigned stops are not drawn, and junk input is survivable', () => {
  assert.deepEqual(groupDispatchTrips([{ id: 'x', actual_driver: null, actual_pos: 1 }]), []);
  assert.deepEqual(groupDispatchTrips([]), []);
  assert.deepEqual(groupDispatchTrips(null), []);
  assert.deepEqual(groupDispatchTrips([null, undefined]), []);
});

test('a stop with no position sorts LAST, never first', () => {
  // At the front it would drag the line out to a random corner before the route starts.
  const g = groupDispatchTrips([
    { id: 'none', actual_driver: 'D', actual_trip: 'T', actual_pos: null },
    { id: 'two', actual_driver: 'D', actual_trip: 'T', actual_pos: 2 },
    { id: 'one', actual_driver: 'D', actual_trip: 'T', actual_pos: 1 },
  ]);
  assert.deepEqual(g[0].stops.map((s) => s.id), ['one', 'two', 'none']);
});
