// test/restriction-icon-clipping.test.mjs
//
// THE BADGE MUST FIT INSIDE ITS OWN BOX.
//
// Chad, on the Legend: "its not showing the full icon in the legend some of it is cut off."
//
// badgeInnerSvg draws `<circle cx="7" cy="7" r="7" stroke="white" stroke-width="1.5"/>`, and an
// SVG stroke STRADDLES its path — 0.75 units inside the edge and 0.75 outside. The component
// rendered that into viewBox "0 0 14 14", so the outer half of the white ring had nowhere to go
// and was clipped on all four sides: every icon drew -0.75..14.75 into a 0..14 window, losing
// 5.4% off each edge. All twenty of them, identically.
//
// It is the kind of defect that hides in plain sight — the artwork is correct, the component is
// correct, and only the RELATIONSHIP between the two is wrong — so this pins the relationship
// arithmetically instead of trusting either side. No browser: the geometry is computable, and a
// guard that needs Chromium ends up in the eight-minute job instead of the fast one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** The viewBox RestrictionIcon renders every badge into. */
function iconViewBox() {
  const fn = APP.slice(APP.indexOf('function RestrictionIcon('), APP.indexOf('function stopMatchesSearch('));
  const m = /viewBox="([-\d. ]+)"/.exec(fn);
  assert.ok(m, 'RestrictionIcon no longer sets a literal viewBox');
  const [x, y, w, h] = m[1].trim().split(/\s+/).map(Number);
  return { x, y, w, h };
}

/** The disc badgeInnerSvg draws, as authored. */
function badgeDisc() {
  const fn = APP.slice(APP.indexOf('function badgeInnerSvg('));
  const m = /<circle cx="(\d+(?:\.\d+)?)" cy="(\d+(?:\.\d+)?)" r="(\d+(?:\.\d+)?)"[^>]*stroke-width="(\d+(?:\.\d+)?)"/.exec(fn);
  assert.ok(m, 'badgeInnerSvg no longer draws its disc in the shape this guard reads');
  return { cx: +m[1], cy: +m[2], r: +m[3], sw: +m[4] };
}

test('the white ring fits: nothing the badge draws falls outside the viewBox', () => {
  const vb = iconViewBox();
  const d = badgeDisc();
  // A stroke straddles its path, so the drawn edge is r + sw/2 — this is the whole bug.
  const half = d.r + d.sw / 2;
  const drawn = { left: d.cx - half, top: d.cy - half, right: d.cx + half, bottom: d.cy + half };
  assert.ok(drawn.left >= vb.x, `left edge ${drawn.left} is outside viewBox x=${vb.x}`);
  assert.ok(drawn.top >= vb.y, `top edge ${drawn.top} is outside viewBox y=${vb.y}`);
  assert.ok(drawn.right <= vb.x + vb.w, `right edge ${drawn.right} exceeds ${vb.x + vb.w}`);
  assert.ok(drawn.bottom <= vb.y + vb.h, `bottom edge ${drawn.bottom} exceeds ${vb.y + vb.h}`);
});

test('the old box really was too small — the guard is not vacuously true', () => {
  // Proving it fires. Against the shipped "0 0 14 14" this assertion has to fail, or the test
  // above is decoration: r=7 + 1.5/2 = 7.75 from a centre at 7 reaches 14.75.
  const d = badgeDisc();
  const half = d.r + d.sw / 2;
  assert.ok(d.cx + half > 14, `with the old 0..14 box the disc reached ${d.cx + half}`);
  assert.ok(d.cx - half < 0, `and started at ${d.cx - half}`);
});

test('the box is not oversized either — the icon must not float in padding', () => {
  // The fix is "grow by exactly the stroke", not "grow until it stops complaining". Slack here
  // shrinks every icon at every call site for nothing.
  const vb = iconViewBox();
  const d = badgeDisc();
  const half = d.r + d.sw / 2;
  assert.ok(vb.w - 2 * half < 0.01, `viewBox is ${vb.w} wide for a ${2 * half}-unit mark`);
});

test('the legend size compensates for the wider box, so the icon does not shrink', () => {
  // Chad asked for these to be BIGGER once already ("make the icon image bigger it's too hard
  // to read"). Un-clipping them must not quietly give that back: the same pixel box over a
  // wider viewBox draws a smaller disc, so the pixel box grows to match.
  const px = Number(/const LEGEND_ICON_PX = (\d+)/.exec(APP)[1]);
  const vb = iconViewBox();
  const discBefore = 22 / 14;          // units-to-px at the old box and the old size
  const discNow = px / vb.w;
  assert.ok(Math.abs(discNow - discBefore) / discBefore < 0.05,
    `the legend icon now draws at ${discNow.toFixed(3)} px/unit against ${discBefore.toFixed(3)} before`);
});
