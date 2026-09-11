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

/**
 * THE RAIL'S SEARCH BOX IS ONE VALUE ACROSS ITS SUB-TABS.
 *
 * Chad, Sep 10, with "frye" typed on Routes: "I want these two search bars to work together —
 * if I type something in the search bar for routes and swap to loads I want it to remain."
 * Both panels owned a local `q`, so switching tabs UNMOUNTED the box and took the text with it:
 * you retyped the same word to ask the same question of the other list, and the two counts on
 * the tabs — the whole reason the strip shows both — could never be read against one needle.
 *
 * The rail owns the value now. But the Routes panel is ALSO rendered on the dispatch Map, where
 * there is no second tab and no parent state to lift into, so the panels stay usable on their
 * own: a caller that passes a string CONTROLS the box, one that passes nothing keeps its own.
 * That rule is resolved here rather than written out twice, because two copies of a
 * controlled/uncontrolled fallback is two chances for the panels to disagree about who owns it.
 *
 * `onChange` is optional even when controlled — a read-only listing is a legitimate caller, and
 * a missing handler must make the box inert, never throw on the first keystroke.
 */
export function resolveRailQuery({ query, onChange, own, setOwn }) {
  const controlled = typeof query === 'string';
  return {
    controlled,
    q: controlled ? query : (own ?? ''),
    setQ: controlled ? (typeof onChange === 'function' ? onChange : () => {}) : setOwn,
  };
}

// ── WHAT FITS IN THE RAIL'S HEADER STRIP AT A GIVEN WIDTH ───────────────────
//
// Chad, with the Routing rail dragged to its narrowest: "When i squeeze the right panel down
// to the minimum i lose my collapse button, the other 2 buttons don't shrink like they should."
//
// MEASURED, NOT REASONED. At the 280px minimum the header has 255px of content box, and it
// was asking for 291px: the Routes/Loads toggle (162px, more with two-digit counts), ＋ New
// route (98px), the chevron (15px) and two 8px gaps. Every child carried `shrink-0`, so the
// row could not compress — it overflowed, and the chevron, last in the DOM and pushed right
// by ml-auto, ended up 56px PAST the panel's edge and off the screen entirely.
//
// WHY THAT PARTICULAR BUTTON IS THE ONE THAT MUST NOT GO. A router squeezes this rail because
// he wants map: on a 700-stop board the map is the work surface and the rail is reference. So
// the control the squeeze destroyed is the control that UNDOES the squeeze — the only way out
// was to drag the rail wide again first, and the collapsed 28px strip became unreachable from
// the one width a dispatcher is most likely to want it from. That is a trap, not a blemish.
//
// THE ORDER THINGS GIVE WAY IN, and why:
//   1. ＋ New route drops its LABEL first (the ＋ and its tooltip stay, and it stays a full
//      hit target). Creating a route is an occasional, deliberate act; you go looking for the
//      button. Worth 70 of the 98px it costs.
//   2. The tab COUNTS go next. "Loads (87)" is a real dispatch fact — how much of the day is
//      still unbuilt — so it is given up only when the label itself would otherwise be at
//      risk, and the counts are still on the panel below.
//   3. Nothing else. The tabs keep their words (no "Rout…"), and the chevron never moves.
//
// THE THRESHOLDS carry margin for three-digit counts, because 102 loads is an ordinary Davis
// day and "Loads (106)" is wider than the "Loads (87)" that was measured.
//
// THE HEADER ALSO CHANGED SHAPE, and the honest account of why: the chevron now sits in its
// own shrink-0 slot beside a min-w-0 group, so no content in that group can push it anywhere.
// That is insurance, not the fix — checked both ways, the browser guard passes on THIS RULE
// ALONE with the old flat row restored, and it passes under 125% and 150% browser zoom too
// (zoom scales the pixel budget with the text, so the ratio holds). I could not construct a
// width where the structure is load-bearing today.
//
// It stays anyway, because what it changes is the FAILURE MODE. Arithmetic about font metrics
// is exactly the kind of thing that quietly stops being true — a fourth control in the strip,
// a longer label, a font swap — and this repo has shipped four collision patches to one phone
// screen by reasoning about geometry. With the group, being wrong means a clipped button the
// guard's overflow check catches; without it, being wrong means the chevron leaves the screen
// and a dispatcher is trapped again.
export const RAIL_MIN_W = 280;          // useSidePanelWidth's floor for 'routing.rightW'
export const RAIL_DEFAULT_W = 380;      // and its default — the width the screen opens at

/**
 * railHeaderLayout(width) → what the Routes/Loads header strip may draw at this rail width.
 *
 * A malformed or missing width resolves to the DEFAULT, which shows everything. A width that
 * cannot be read must never silently strip labels off a dispatcher's controls: that failure
 * is invisible, and a quietly reduced header looks exactly like a working one.
 */
export function railHeaderLayout(width) {
  const w = Number(width);
  const px = Number.isFinite(w) && w > 0 ? w : RAIL_DEFAULT_W;
  return {
    newRouteLabel: px >= 370,
    tabCounts: px >= 300,
  };
}
