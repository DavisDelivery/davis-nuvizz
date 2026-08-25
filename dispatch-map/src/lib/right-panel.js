// src/lib/right-panel.js — what the Routing screen's right rail shows (PURE).
//
// ── WHAT CHAD ASKED FOR, AND THE WRONG TURN IN THE MIDDLE ───────────────────
// Chad, with the rail on Routes/Drivers and the day's loads down in the bottom grid: "I want
// the loads that is on the bottom panel to replace the drivers tab in the right panel but also
// leave the loads on the bottom panel make it a 3rd option in the settings for the right
// panel." Asked whether Drivers should therefore go, he was explicit that it should not:
// "I just want a 3rd right panel option that is routes and loads."
//
// That is THREE gear options, and v0.79.0 shipped exactly that. Then he said "I want them to
// be tabs just like the routes and drivers are so you can switch the view" and v0.79.1 read it
// as "collapse the modes into one strip of three tabs" — which DELETED the third option he had
// just spelled out twice. He was not asking for that. He was talking about the SUB-TABS: the
// new mode's two panels should flip like Routes/Drivers already do, which is what they did.
// His verdict on the result: "there should be 3 right panel views not 2 i didn't want to touch
// either one as they were I wanted a 3rd option."
//
// So: three modes, and the two that existed before are untouched — same labels, same panels,
// and Routes/Drivers keeps its sub-tab UNPERSISTED exactly as it always was, because "as they
// were" includes behaviour nobody asked to change.
//
// ── WHY THE MODES DECLARE `routesPanel` ─────────────────────────────────────
// The rail's mode is read in seven places, and one of them is the effect that fetches the live
// driver-assignment roster. It used to test the mode BY NAME, so a mode added without it
// renders route cards whose driver dropdown is empty — "I cannot assign this load" on a
// dispatch board, indistinguishable from the vendor being down. A mode declares what it needs;
// the effect asks the declaration.

export const RIGHT_PANEL_MODES = [
  { value: 'tabs', label: 'Tabs (Stops / Loads / Result)', routesPanel: false },
  { value: 'routes', label: 'Routes / Drivers', routesPanel: true },
  { value: 'routesLoads', label: 'Routes / Loads', routesPanel: true },
];

export const DEFAULT_RIGHT_PANEL_MODE = 'tabs';

/**
 * normalizeRightPanelMode(raw) → a mode this app can actually render.
 *
 * The stored value is not ours: an older build's, a hand-edited one, or nothing. Anything
 * unrecognised falls back to the tabs rail rather than rendering an empty panel — a blank
 * right rail on a dispatch board reads as "the app is broken" and there is no control on
 * screen to get out of it.
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

// ── The sub-tabs, one vocabulary per mode ───────────────────────────────────
// Deliberately NOT one shared three-valued tab. Sharing would make "drivers selected inside
// the Routes/Loads mode" representable, and a state nothing can render is a blank panel
// waiting to happen. Each mode can only ever hold a value it has a panel for.

export const ROUTES_DRIVERS_TABS = ['routes', 'drivers'];
export const ROUTES_LOADS_TABS = ['routes', 'loads'];
export const DEFAULT_SUB_TAB = 'routes';

/** Routes / Drivers sub-tab. NOT persisted — that mode is left exactly as it was. */
export function normalizeRoutesDriversTab(raw) {
  const v = String(raw ?? '');
  return ROUTES_DRIVERS_TABS.includes(v) ? v : DEFAULT_SUB_TAB;
}

/**
 * Routes / Loads sub-tab. This one IS persisted: it is a new mode with no "how it was" to
 * preserve, and a dispatcher who picks Routes / Loads out of the gear because he wants Loads
 * should not re-pick Loads every morning.
 */
export function normalizeRoutesLoadsTab(raw) {
  const v = String(raw ?? '');
  return ROUTES_LOADS_TABS.includes(v) ? v : DEFAULT_SUB_TAB;
}
