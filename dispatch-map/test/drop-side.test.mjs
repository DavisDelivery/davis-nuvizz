// A MENU THAT HANGS OFF THE SCREEN.
//
// Chad, on an iPad: "FORMATTING ISSUES ON IPAD" — with a Status dropdown showing only the
// tails of its own options, "nned / d / sit / eted / ed", because the panel was off the LEFT
// edge of the display.
//
// The panel was `absolute right-0 w-40`: aligned to its trigger's RIGHT edge, extending 160px
// leftward. Correct while the trigger sits right of 160px; off-screen the moment the bottom
// toolbar wraps and Status lands at x≈77, which is what a tablet width does to that bar.
//
// SWAPPING TO left-0 IS THE SAME BUG MIRRORED, and that is not a hypothetical — I made that
// change and the new tablet guard failed on the Map screen inside one run, where the same
// control sits near the right edge and the panel ran to x=1156 on a 1080px screen. Both
// numbers below are from those two runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSide, dropSideClass, dropRight } from '../src/lib/drop-side.js';

const W = 160;          // w-40, the Status panel
const IPAD = 1080;      // iPad 10.2 landscape — the width both defects were measured at

test('CHAD’S CASE: a trigger at the left edge hangs the panel to the RIGHT of it', () => {
  // x≈77 is where the wrapped toolbar actually put it. right-0 sent the panel to x=-83.
  assert.equal(dropSide({ left: 77, right: 130 }, W, IPAD), 'left');
  assert.equal(dropSideClass(dropSide({ left: 77, right: 130 }, W, IPAD)), 'left-0');
});

test('THE MIRROR: a trigger at the right edge hangs the panel to the LEFT of it', () => {
  // The Map screen, from the guard run that caught my own fix: left-0 put it at x=1156.
  assert.equal(dropSide({ left: 996, right: 1060 }, W, IPAD), 'right');
  assert.equal(dropSideClass(dropSide({ left: 996, right: 1060 }, W, IPAD)), 'right-0');
});

test('a panel that fits either way prefers reading order', () => {
  assert.equal(dropSide({ left: 400, right: 460 }, W, IPAD), 'left');
});

test('the flip only happens when flipping actually helps', () => {
  // A panel wider than the space on BOTH sides overflows whichever way it goes. Flipping
  // then just changes which end of the menu is lost, so it keeps the default rather than
  // pretending it solved something.
  assert.equal(dropSide({ left: 500, right: 560 }, 2000, IPAD), 'left');
  // Narrow viewport, trigger dead centre, panel almost as wide as the screen.
  assert.equal(dropSide({ left: 180, right: 220 }, 380, 400), 'left');
});

test('the boundary is exact, and the padding is respected', () => {
  // pad = 8 by default. A panel that ends exactly on the padding line still fits.
  assert.equal(dropSide({ left: 912, right: 1000 }, W, IPAD), 'left', '912+160 = 1072 = 1080-8');
  // One pixel further and it does not.
  assert.equal(dropSide({ left: 913, right: 1000 }, W, IPAD), 'right');
});

test('an unmeasurable trigger keeps the default rather than guessing', () => {
  // getBoundingClientRect on a detached node returns zeros; a ref that has not attached yet
  // returns nothing at all. Neither should produce a confident placement.
  for (const bad of [null, undefined, {}, { left: NaN, right: NaN }, { left: '77', right: 'x' }]) {
    assert.equal(dropSide(bad, W, IPAD), 'left', JSON.stringify(bad));
  }
  assert.equal(dropSide({ left: 77, right: 130 }, NaN, IPAD), 'left');
  assert.equal(dropSide({ left: 77, right: 130 }, W, undefined), 'left');
  // THE CASE THAT MAKES THE GUARD LOAD-BEARING. A half-measured rect — one edge readable,
  // the other not — would otherwise fall through to the flip arithmetic and come back
  // 'right' with real confidence, from a number that does not exist. Found by deleting the
  // guard and watching every other assertion in this file still pass.
  assert.equal(dropSide({ left: NaN, right: 1000 }, W, IPAD), 'left',
    'a rect with an unreadable left edge must not produce a confident flip');
  assert.equal(dropSide({ left: 900, right: NaN }, W, IPAD), 'left');
});

test('the class helper cannot pair a side with the wrong Tailwind class', () => {
  // The bug this whole file is about was a hard-coded class. Deriving it removes the chance
  // of a call site measuring one side and rendering the other.
  assert.equal(dropSideClass('left'), 'left-0');
  assert.equal(dropSideClass('right'), 'right-0');
  assert.equal(dropSideClass('nonsense'), 'left-0');
  assert.equal(dropSideClass(undefined), 'left-0');
});

test('a phone still places it sensibly — this is not a tablet-only rule', () => {
  // 390px screen, the same 160px panel. A trigger past the midpoint has to flip.
  assert.equal(dropSide({ left: 20, right: 80 }, W, 390), 'left');
  assert.equal(dropSide({ left: 300, right: 370 }, W, 390), 'right');
});

// ── dropRight: WHEN NEITHER SIDE FITS, THE MENU SLIDES (v1.71.3) ─────────────────────────────
//
// Chad, v1.71.2, a phone photo of the Routing gear's menu reading "…m data grid / …ispatch
// (assign driver +". Every number below was measured in a real browser on that build, with a
// second dispatcher online — the presence chip is what moved the gear to x 149..193.

const MENU = 240;       // w-60, the Routing gear's menu

test('CHAD’S PHOTO: the gear at x 149..193 — the menu slides right until its left edge is on screen', () => {
  // right-0 put it at x -47..193. dropRight returns the CSS `right` from the gear's right
  // edge: -55 → the menu's right edge at 193+55 = 248, its left edge at 8 — the gutter.
  assert.equal(dropRight({ left: 149, right: 193 }, MENU, 390), -55);
  assert.equal(dropRight({ left: 149, right: 193 }, MENU, 360), -55);
});

test('WHY dropSide COULD NOT DO THIS: at 360px the menu fits on neither side of that gear', () => {
  // right-0 → x -47; left-0 → x 149..389 on a 360px screen. A side only picks which end is lost.
  assert.ok(193 - MENU < 8 && 149 + MENU > 360 - 8, 'both edges fail at 360');
  const r = dropRight({ left: 149, right: 193 }, MENU, 360);
  const left = 193 - r - MENU;
  assert.ok(left >= 8 && left + MENU <= 360 - 8, `the whole menu is inside the gutters (x ${left}..${left + MENU})`);
});

test('A MENU THAT ALREADY FITS DOES NOT MOVE A PIXEL — every placement that was right stays right', () => {
  // Measured on the same build with nobody else on: the gear at 243..287 (390px) and
  // 213..257 (360px). And a desktop gear, where the menu has always fitted.
  assert.equal(dropRight({ left: 243, right: 287 }, MENU, 390), 0);
  assert.equal(dropRight({ left: 213, right: 257 }, MENU, 360), 0);
  assert.equal(dropRight({ left: 300, right: 330 }, MENU, 1440), 0);
  assert.ok(Object.is(dropRight({ left: 243, right: 287 }, MENU, 390), 0), 'a plain 0, never -0');
});

test('THE MIRROR: a trigger hard against the right edge slides the menu LEFT, never past it', () => {
  // right-0 from a trigger whose right edge sits past the gutter would end off the screen.
  const r = dropRight({ left: 1400, right: 1450 }, MENU, 1440);
  assert.equal(r, 18);
  assert.equal(1450 - r, 1432, 'its right edge on the gutter line, 1440 - 8');
});

test('the gutter boundary is exact', () => {
  // Left edge exactly on the 8px line: fits, stays. One pixel less: slides by that pixel.
  assert.equal(dropRight({ left: 200, right: 248 }, MENU, 390), 0);
  assert.equal(dropRight({ left: 199, right: 247 }, MENU, 390), -1);
  // Real rects are fractional. A left edge 0.3px inside the gutter rounds to a slide of 0 — and
  // that 0 must be a plain 0: Math.round(-0.3) is -0, and -0 is what a strict test compares by.
  assert.ok(Object.is(dropRight({ left: 199.7, right: 247.7 }, MENU, 390), 0));
});

test('a menu wider than the screen keeps its LEFT edge on screen — that is where every label starts', () => {
  const r = dropRight({ left: 150, right: 200 }, 400, 390);
  assert.equal(200 - r - 400, 8);
});

test('an unmeasurable trigger or panel keeps right-0 rather than guessing', () => {
  // A ref that has not attached, a detached node, a menu not laid out yet (offsetWidth 0).
  // Number(null) is 0 and 0 is finite: { right: null } must NOT read as "the screen's left edge".
  for (const bad of [null, undefined, {}, { right: null }, { right: NaN }, { right: '193' }]) {
    assert.equal(dropRight(bad, MENU, 390), 0, JSON.stringify(bad));
  }
  assert.equal(dropRight({ right: 193 }, 0, 390), 0);
  assert.equal(dropRight({ right: 193 }, undefined, 390), 0);
  assert.equal(dropRight({ right: 193 }, MENU, 0), 0);
  assert.equal(dropRight({ right: 193 }, MENU, undefined), 0);
  assert.equal(dropRight({ right: 193 }, MENU, 390, NaN), 0);
});
