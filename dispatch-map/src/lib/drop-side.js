// src/lib/drop-side.js — which edge a dropdown hangs from so it stays on screen. (PURE)
//
// Chad, on an iPad: a Status menu hanging off the LEFT edge of the screen, showing only the
// tails of its own options — "nned / d / sit / eted / ed".
//
// The panel was `absolute right-0 w-40`: aligned to its trigger's RIGHT edge, so it extends
// 160px LEFTWARD. That is correct while the trigger sits to the right of 160px and wrong the
// instant it does not — and on a tablet the bottom toolbar wraps, which put Status at x≈77.
//
// SWAPPING IT TO left-0 IS NOT A FIX, IT IS THE SAME BUG MIRRORED. I made that change, and
// the new tablet guard caught it on the Map screen within one run: there the same control
// sits near the right edge, so a left-anchored panel ran off to x=1156 on a 1080px screen.
// Neither edge is right, because the correct edge depends on where the trigger ended up.
//
// The codebase's existing answer for the vertical axis is a `dropUp` PROP — the call site
// declares which way it opens. That works where a call site can know (a gear pinned to the
// bottom of a panel always opens upward) and cannot work here, because what moved the button
// was the toolbar wrapping at a width nobody enumerated. So this measures instead of asking.
//
// Kept pure and separate so it is testable without a browser, and so the next dropdown that
// needs it does not reinvent the arithmetic.

/**
 * dropSide({ left, right }, panelW, viewportW, pad) → 'left' | 'right'
 *
 * 'left'  → the panel's LEFT edge sits at the trigger's left  (Tailwind `left-0`)
 * 'right' → the panel's RIGHT edge sits at the trigger's right (Tailwind `right-0`)
 *
 * Prefers hanging LEFT (reading order), and flips only when that would overflow the right
 * edge — and then only if hanging right actually fits, because a panel wider than the
 * viewport overflows whichever way it goes and flipping it just moves which end is lost.
 */
export function dropSide(trigger, panelW, viewportW, pad = 8) {
  const l = Number(trigger?.left);
  const r = Number(trigger?.right);
  const w = Number(panelW);
  const vw = Number(viewportW);
  // Anything unmeasurable keeps the reading-order default rather than guessing.
  if (!Number.isFinite(l) || !Number.isFinite(r) || !Number.isFinite(w) || !Number.isFinite(vw)) return 'left';
  const fitsLeftAnchored = l + w <= vw - pad;
  if (fitsLeftAnchored) return 'left';
  // Would the flip actually help? r - w is the panel's left edge when right-anchored.
  const fitsRightAnchored = r - w >= pad;
  return fitsRightAnchored ? 'right' : 'left';
}

/** The Tailwind class for a side. Kept here so a call site cannot pair 'left' with right-0. */
export function dropSideClass(side) {
  return side === 'right' ? 'right-0' : 'left-0';
}
