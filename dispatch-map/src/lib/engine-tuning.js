// src/lib/engine-tuning.js — what the Engine tab's ⚙ Tuning panel SENDS (PURE).
//
// The panel keeps every edit as the string the box holds. Number('') is 0, and 0 is finite, so a
// box a dispatcher cleared to retype — and then walked away from — used to post 0, which the
// server clamps to the knob's MINIMUM bound (far_deadhead_mi: 10) and persists with a
// "customized" badge nobody asked for; the next nightly run then treated every stop past ten
// miles as "far". This repo has met that exact class before (routing-select.js: a blank Skids box
// became a 0-skid fleet profile). A cleared box is "no change", never 0.

/** True when any edit is blank — Save must stay disabled rather than post a no-op and say "Saved." */
export function hasBlankEdit(edits) {
  return Object.values(edits || {}).some((v) => String(v ?? '').trim() === '');
}

/**
 * The POST body for routing-engine-tuning: every numeric edit, trimmed; blanks and junk skipped.
 * @param {Record<string,string|number>} edits  key → the box's current text
 * @param {string[]} resets                     keys being reset to their default
 */
export function tuningSaveBody(edits, resets) {
  const body = { updatedBy: 'engine-tab', reset: Array.isArray(resets) ? resets : [] };
  for (const [k, v] of Object.entries(edits || {})) {
    const t = String(v ?? '').trim();
    if (t === '') continue;
    const n = Number(t);
    if (Number.isFinite(n)) body[k] = n;
  }
  return body;
}
