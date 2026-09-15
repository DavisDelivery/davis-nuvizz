// src/lib/section-jump.js
//
// ── JUMPING BETWEEN THE SECTIONS OF A LONG SCREEN ────────────────────────────
//
// Chad, Sep 2026, on the Manifest check screen: "need a dropdown in the ui for all the
// different sections of this page."
//
// That screen is five stacked panels — the mailbox, tonight's check (which on a bad night runs
// to a 500-row suspects table), the arrival curve, the Uline forecast and the manifest history.
// Getting from the top to the history is a long scroll on a desktop and a very long one on a
// phone, which is exactly when somebody stops using the section at the bottom.
//
// PURE, because the two things that actually go wrong here are arithmetic and list-building,
// and neither needs a DOM to test:
//
//  1. THE OFFSET. The picker is sticky, so scrolling a section to the top of the container
//     puts it UNDER the picker — the heading you asked for is the one thing you cannot see.
//     scroll-margin would do it in CSS, but the value has to agree with the bar's real height
//     in two layouts, and a number that lives in two files drifts. One function, one place.
//  2. NEVER OFFER A SECTION THAT IS NOT THERE. Tonight's check is absent until a report has
//     been read. A dropdown entry that scrolls nowhere is indistinguishable from a broken one,
//     so the list is built from what is actually rendered rather than from a fixed menu.

/** Every section of the Manifest check screen, in the order they appear on it. */
export const MANIFEST_SECTIONS = [
  { key: 'mailbox', label: 'Mailbox' },
  { key: 'check', label: "Tonight's check" },
  { key: 'arrivals', label: 'Order arrivals' },
  { key: 'forecast', label: 'Uline forecast' },
  { key: 'history', label: 'Manifest history' },
];

/** How far above the section to stop, so a sticky picker never covers the heading it just
 *  jumped to. Desktop and phone place the picker differently and it is a different height in
 *  each; both are measured here rather than guessed at in CSS. */
export const JUMP_OFFSET_DESKTOP = 64;
export const JUMP_OFFSET_PHONE = 88;

/**
 * Where to scroll the CONTAINER so `elTop` lands just below the sticky picker.
 *
 * All four inputs are what the caller already has from two getBoundingClientRect() reads plus
 * scrollTop — no layout is done here. Clamped at zero: a section near the very top would
 * otherwise ask for a negative scroll, which some browsers honour by bouncing.
 */
export function sectionScrollTop({ elTop, containerTop, containerScrollTop, offset = JUMP_OFFSET_DESKTOP } = {}) {
  // Number(null) is 0 and 0 is FINITE — the trap this repo already has a scar from. A missing
  // measurement must be rejected before it is coerced, or a failed rect read becomes a
  // perfectly plausible instruction to scroll to the top.
  const raw = [elTop, containerTop, containerScrollTop];
  if (raw.some((v) => v === null || v === undefined || v === '' || typeof v === 'boolean')) return null;
  const n = raw.map(Number);
  if (!n.every(Number.isFinite)) return null;
  const [el, top, scrolled] = n;
  const off = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  return Math.max(0, el - top + scrolled - off);
}

/**
 * The menu, built from what is on the screen right now.
 *
 * `present` is the set (or array) of section keys actually rendered. Order always follows
 * MANIFEST_SECTIONS so the dropdown reads top-to-bottom like the page does, however the caller
 * happens to have collected the keys.
 */
export function visibleSections(present, all = MANIFEST_SECTIONS) {
  const have = present instanceof Set ? present : new Set(Array.isArray(present) ? present : []);
  return (Array.isArray(all) ? all : []).filter((s) => s && have.has(s.key));
}
