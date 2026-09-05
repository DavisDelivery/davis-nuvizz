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
import { dropSide, dropSideClass } from '../src/lib/drop-side.js';

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
