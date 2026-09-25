// src/lib/drop-side.js — which edge a dropdown hangs from so it stays on screen, and how far
// it slides when neither edge will do (dropRight, below). (PURE)
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

// THE SAME DEFECT ON A MENU THIS FILE WAS NEVER WIRED TO — AND WHY A SIDE IS NOT ENOUGH THERE.
//
// Chad, v1.71.2, a phone photo of the Routing gear's menu reading "…m data grid / …ispatch
// (assign driver +": the Status menu's bug again, on the gear. MEASURED, not assumed: with a
// second dispatcher online the presence chip takes ~146px of the phone's app bar, the gear lands
// at x 149..193, and a 240px menu hung `right-0` from it runs to x=-47 at 390px AND at 360px.
// Nothing had caught it because no guard ever ran with anybody else on.
//
// dropSide could not have saved it. At 360px that menu fits on NEITHER side of its gear —
// right-0 ends at x=-47, left-0 at x=389 — so choosing an edge only chooses which end is lost.
// It has to SLIDE, and only as far as it must: a menu that already fits does not move a pixel.

/**
 * dropRight(trigger, panelW, viewportW, pad) → px for the CSS `right` of a panel that hangs from
 * its trigger's right edge (the trigger's box is the panel's containing block).
 *
 *   0         right-0 exactly: where it already hung. Returned whenever the panel fits there.
 *   negative  it slides RIGHT, because at right-0 its left edge would be off the screen's left
 *   positive  it slides LEFT, because its right edge would be past the screen's right
 *
 * A panel too wide for the screen and both gutters keeps its LEFT edge on screen, because that
 * is where every label starts; callers also cap the panel to the viewport, so a real screen
 * does not reach that case.
 */
export function dropRight(trigger, panelW, viewportW, pad = 8) {
  // Only real numbers. Number(null) is 0 and 0 is finite — a ref that has not attached yet
  // must not come back as a confident placement at the screen's left edge.
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  const r = trigger ? trigger.right : undefined;
  if (!ok(r) || !ok(panelW) || !ok(viewportW) || !ok(pad) || panelW <= 0 || viewportW <= 0) return 0;
  const want = r - panelW;              // the panel's left edge at right-0
  const lo = pad;                       // furthest LEFT its left edge may sit
  const hi = viewportW - pad - panelW;  // furthest RIGHT its left edge may sit
  if (want >= lo && want <= hi) return 0;
  const left = hi < lo ? lo : Math.min(Math.max(want, lo), hi);
  const right = Math.round(r - (left + panelW));
  return right === 0 ? 0 : right;       // never -0
}
