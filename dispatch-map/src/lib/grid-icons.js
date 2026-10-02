// src/lib/grid-icons.js — the bottom grid's Restrictions cell wears its icons (v1.100.1).
//
// Chad, 2026-10-01, on the board grid's Restrictions column: "under restrictions can we put icons
// as well in there if they have any special icons". The cell listed the customer's restriction
// codes and the order's handling flags as words, while the same stop's map pin, sidebar chips and
// Legend already drew an icon for each restriction. The cell now shows that same icon beside each
// code (App.jsx RestrictionIcon — the one artwork the map uses, so a dispatcher who knows the pin
// knows the cell), and a handling flag shows its own mark where it has one (the stacker's yellow
// H). DO NOT DOUBLE STACK has no icon anywhere in the app and stays a word.
//
// THE WAY BACK: VITE_GRID_RESTRICTION_ICONS=off puts back the words-only cell (house shape:
// default on, an off-word turns it off, anything malformed leaves it on). Build-time, so a
// redeploy. Read HERE rather than in App.jsx, like FORKLIFT_RED_RING_ON, so App.jsx code the unit
// suite lifts and runs carries no import.meta.

export function gridRestrictionIconsEnabled(env) {
  const v = String(env?.VITE_GRID_RESTRICTION_ICONS ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The switch as this build reads it. Vite injects import.meta.env at build time; in Node (the
 *  unit suite) it is absent and the switch reads on, as the house shape says. */
export const GRID_RESTRICTION_ICONS_ON = (() => {
  try { return gridRestrictionIconsEnabled(import.meta.env); } catch { return true; }
})();
