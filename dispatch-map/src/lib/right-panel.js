// src/lib/right-panel.js — what the Routing screen's right rail shows (PURE).
//
// Chad, on the Routing beta with the rail in Routes/Drivers and 106 loads in the bottom grid:
// "I want the loads that is on the bottom panel to replace the drivers tab in the right panel
// but also leave the loads on the bottom panel make it a 3rd option in the settings for the
// right panel" — then, asked whether Drivers should go: "I just want a 3rd right panel option
// that is routes and loads." So Drivers is NOT replaced; a third mode is added beside it.
//
// ── WHY THIS IS A MODULE AND NOT THREE MORE === IN THE RENDER ────────────────
// The rail's mode was two-valued and its value was tested in SIX separate places: the
// localStorage read, the gear list, the collapsed-rail label, the desktop branch, the mobile
// sheet's tab label and the mobile sheet's body — plus one effect that decides whether to fetch
// the driver-assignment roster at all. A third value added by hand is a third value that gets
// missed at one of those seven, and the one that bites is the LAST one: the new mode renders
// the same route cards, and route cards without the assign roster have an empty driver
// dropdown. That is not a visual defect — it is "I cannot assign this load" on a dispatch
// board, and it would have looked exactly like a NuVizz outage.
//
// So a mode DECLARES what it needs (`routesPanel`) rather than the render inferring it from
// the mode's name, and every consumer asks this file.

/**
 * The rail's modes, in the order the gear lists them. `routesPanel` means this mode can render
 * RoutingRoutesPanel — which is what makes the live driver-assignment roster worth fetching.
 */
export const RIGHT_PANEL_MODES = [
  { value: 'tabs', label: 'Tabs (Stops / Loads / Result)', routesPanel: false },
  { value: 'routes', label: 'Routes / Drivers', routesPanel: true },
  { value: 'routesLoads', label: 'Routes / Loads', routesPanel: true },
];

export const DEFAULT_RIGHT_PANEL_MODE = 'tabs';

/**
 * normalizeRightPanelMode(raw) → a mode this app can actually render.
 *
 * The stored value is whatever is in localStorage, which is not ours: an older build's value, a
 * hand-edited one, a half-written one, or nothing at all. Anything unrecognised falls back to
 * the tabs rail rather than rendering an empty panel — a blank right rail on a dispatch board
 * reads as "the app is broken", and there is no control on screen to get out of it.
 */
export function normalizeRightPanelMode(raw) {
  const v = String(raw ?? '');
  return RIGHT_PANEL_MODES.some((m) => m.value === v) ? v : DEFAULT_RIGHT_PANEL_MODE;
}

/** Does this mode put route cards in the rail? Gates the driver-assignment roster fetch. */
export function isRoutesPanelMode(mode) {
  const m = RIGHT_PANEL_MODES.find((x) => x.value === normalizeRightPanelMode(mode));
  return !!(m && m.routesPanel);
}

/** Does this mode have a Drivers sub-tab? Gates the lazy driver-roster fetch. */
export function hasDriversTab(mode) {
  return normalizeRightPanelMode(mode) === 'routes';
}

// Sub-tab of the Routes / Loads mode. Deliberately its own state rather than a third value on
// the Routes/Drivers sub-tab: sharing one would make "drivers selected inside the loads mode"
// representable, and a state nothing can render is a blank panel waiting to happen.
export const ROUTES_LOADS_TABS = ['routes', 'loads'];
export const DEFAULT_ROUTES_LOADS_TAB = 'routes';

/**
 * normalizeRoutesLoadsTab(raw) → 'routes' | 'loads'.
 *
 * This one IS persisted, unlike the Routes/Drivers sub-tab. Picking "Routes / Loads" out of the
 * gear is a dispatcher saying which two things he wants beside the map; landing on Routes every
 * morning when Loads is the reason he switched is a click he pays every single day.
 */
export function normalizeRoutesLoadsTab(raw) {
  const v = String(raw ?? '');
  return ROUTES_LOADS_TABS.includes(v) ? v : DEFAULT_ROUTES_LOADS_TAB;
}
