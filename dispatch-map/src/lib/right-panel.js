// src/lib/right-panel.js — what the Routing screen's right rail shows (PURE).
//
// Chad, on the Routing beta with the rail in Routes/Drivers and the day's loads down in the
// bottom grid: "I want the loads that is on the bottom panel to replace the drivers tab in the
// right panel but also leave the loads on the bottom panel make it a 3rd option in the settings
// for the right panel" — then, asked whether Drivers should go: "I just want a 3rd right panel
// option that is routes and loads."
//
// Built that way first: a third GEAR MODE whose strip was Routes | Loads. He looked at it and
// said the thing that settles it — "I want them to be tabs just like the routes and drivers
// are SO YOU CAN SWITCH THE VIEW."
//
// ── WHY THE GEAR MODE WAS THE WRONG SHAPE ───────────────────────────────────
// A gear mode is a SETTING: something you choose once and live with. A tab is a VIEW: something
// you flick between while working. Routes, Drivers and Loads are three views of the same day —
// what is on this truck, who is driving, and what is left to build — and a dispatcher moves
// between them dozens of times while building a board. Putting two of them in one mode and the
// third behind a settings menu makes the third one cost a trip into the gear every time, which
// is the friction he is describing. Worse, it hides it: a panel you reach through a settings
// menu is a panel most people never find.
//
// So there is ONE strip with THREE tabs, and no mode chooses between them.

/**
 * The rail's modes, in the order the gear lists them. `routesPanel` means this mode can render
 * RoutingRoutesPanel — which is what makes the live driver-assignment roster worth fetching.
 * That declaration exists because the roster fetch used to test the mode BY NAME, so a mode
 * added without it would render route cards whose driver dropdown is empty — "I cannot assign
 * this load" on a dispatch board, indistinguishable from the vendor being down.
 */
export const RIGHT_PANEL_MODES = [
  { value: 'tabs', label: 'Tabs (Stops / Loads / Result)', routesPanel: false },
  { value: 'routes', label: 'Routes / Drivers / Loads', routesPanel: true },
];

export const DEFAULT_RIGHT_PANEL_MODE = 'tabs';

/**
 * normalizeRightPanelMode(raw) → a mode this app can actually render.
 *
 * The stored value is not ours: an older build's value (this app has already shipped a
 * 'routesLoads' that no longer exists), a hand-edited one, or nothing at all. Anything
 * unrecognised falls back to the tabs rail rather than rendering an empty panel — a blank right
 * rail on a dispatch board reads as "the app is broken", and there is no control on screen to
 * get out of it.
 */
export function normalizeRightPanelMode(raw) {
  const v = String(raw ?? '');
  if (v === 'routesLoads') return 'routes';   // the shape that shipped for one release
  return RIGHT_PANEL_MODES.some((m) => m.value === v) ? v : DEFAULT_RIGHT_PANEL_MODE;
}

/** Does this mode put route cards in the rail? Gates the driver-assignment roster fetch. */
export function isRoutesPanelMode(mode) {
  const m = RIGHT_PANEL_MODES.find((x) => x.value === normalizeRightPanelMode(mode));
  return !!(m && m.routesPanel);
}

// The three views of the day, in strip order. Routes first because it is where a board gets
// built; Drivers keeps the position it has had since the strip existed, so the muscle memory
// of anyone already using it survives; Loads joins on the end.
export const ROUTES_RAIL_TABS = ['routes', 'drivers', 'loads'];
export const DEFAULT_ROUTES_RAIL_TAB = 'routes';

/**
 * normalizeRoutesRailTab(raw) → 'routes' | 'drivers' | 'loads'.
 *
 * Persisted, which the old two-way toggle was not: which of the three a dispatcher wants beside
 * the map is a working preference, and landing on Routes every morning is a click paid daily.
 * An unknown value lands on Routes rather than rendering nothing.
 */
export function normalizeRoutesRailTab(raw) {
  const v = String(raw ?? '');
  return ROUTES_RAIL_TABS.includes(v) ? v : DEFAULT_ROUTES_RAIL_TAB;
}
