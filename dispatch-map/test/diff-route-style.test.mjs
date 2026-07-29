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
  diffRouteStyle, DIFF_ORIGINAL_COLOR, DIFF_CASING_RATIO,
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
