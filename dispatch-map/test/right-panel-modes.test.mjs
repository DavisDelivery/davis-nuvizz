// The Routing rail's three views — Chad, Aug 25, on the first cut that put Loads behind its own
// gear mode: "I want them to be tabs just like the routes and drivers are so you can switch the
// view."
//
// These pin the things that decide whether the strip works on a dispatch board, none of which
// is visible by looking at it: whether a stored value can leave the panel blank, whether the
// mode declares that it needs the live driver-assignment roster, and whether the value the
// previous release wrote still lands somewhere sane.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHT_PANEL_MODES,
  DEFAULT_RIGHT_PANEL_MODE,
  normalizeRightPanelMode,
  isRoutesPanelMode,
  ROUTES_RAIL_TABS,
  DEFAULT_ROUTES_RAIL_TAB,
  normalizeRoutesRailTab,
} from '../src/lib/right-panel.js';

// ── The strip ────────────────────────────────────────────────────────────────
test('all three views are tabs on one strip — none of them is behind the gear', () => {
  assert.deepEqual(ROUTES_RAIL_TABS, ['routes', 'drivers', 'loads']);
  // The gear chooses the RAIL, not which of the three views is open. A mode per view is the
  // shape Chad rejected: a settings trip to switch something you switch dozens of times a day.
  assert.deepEqual(RIGHT_PANEL_MODES.map((m) => m.value), ['tabs', 'routes']);
  assert.equal(RIGHT_PANEL_MODES[1].label, 'Routes / Drivers / Loads');
});

test('Drivers keeps its place in the middle — the strip it already had still reads the same', () => {
  // Anyone already using the rail has muscle memory for Routes-then-Drivers. Loads joins on the
  // end rather than pushing Drivers along.
  assert.equal(ROUTES_RAIL_TABS[0], 'routes');
  assert.equal(ROUTES_RAIL_TABS[1], 'drivers');
});

test('the rail opens on Routes when nothing has been chosen', () => {
  assert.equal(DEFAULT_ROUTES_RAIL_TAB, 'routes');
  assert.equal(normalizeRoutesRailTab(null), 'routes');
});

test('every tab survives a round trip through storage', () => {
  for (const t of ROUTES_RAIL_TABS) assert.equal(normalizeRoutesRailTab(t), t);
});

test('a tab this build cannot render opens Routes, never nothing', () => {
  for (const raw of ['stops', 'Loads', 'LOADS', '', ' ', 'undefined', '{}']) {
    assert.equal(normalizeRoutesRailTab(raw), 'routes', `for ${JSON.stringify(raw)}`);
  }
  assert.equal(normalizeRoutesRailTab(undefined), 'routes');
  assert.equal(normalizeRoutesRailTab(0), 'routes');
  assert.equal(normalizeRoutesRailTab({}), 'routes');
});

// ── The stored mode is not ours ──────────────────────────────────────────────
test('the mode the PREVIOUS shape wrote still lands on the rail that has those panels', () => {
  // v0.79.0 shipped a 'routesLoads' mode for one release. Anyone whose browser stored it must
  // land on the strip that now contains both of its panels — not be silently dropped back to
  // the tabs rail, which is a different screen and would read as the setting being ignored.
  assert.equal(normalizeRightPanelMode('routesLoads'), 'routes');
});

test('a stored mode this build cannot render falls back to the tabs rail, never to a blank one', () => {
  for (const raw of ['drivers', 'routesloads', 'ROUTES', '', ' ', 'undefined', '{}']) {
    assert.equal(normalizeRightPanelMode(raw), DEFAULT_RIGHT_PANEL_MODE, `for ${JSON.stringify(raw)}`);
  }
});

test('absent, null and non-string storage reads do not throw and land on the default', () => {
  assert.equal(normalizeRightPanelMode(null), 'tabs');
  assert.equal(normalizeRightPanelMode(undefined), 'tabs');
  assert.equal(normalizeRightPanelMode(0), 'tabs');
  assert.equal(normalizeRightPanelMode({}), 'tabs');
});

test('every real mode survives a round trip through storage', () => {
  for (const m of RIGHT_PANEL_MODES) assert.equal(normalizeRightPanelMode(String(m.value)), m.value);
});

// ── The one that would have looked like a NuVizz outage ──────────────────────
test('the Routes rail declares that it renders route cards, so the assign roster is fetched', () => {
  // The route cards' driver dropdown is filled from the live assignment roster, and that fetch
  // is gated on this. A rail that renders the cards without it shows an empty dropdown on a
  // dispatch board — indistinguishable from the vendor being down.
  assert.equal(isRoutesPanelMode('routes'), true);
  assert.equal(isRoutesPanelMode('tabs'), false);
});

test('every mode that renders route cards says so on its own descriptor', () => {
  // The declaration is the contract: adding a mode that shows route cards without setting
  // routesPanel is the same bug again, and this is where it gets caught.
  for (const m of RIGHT_PANEL_MODES) {
    assert.equal(typeof m.routesPanel, 'boolean', `${m.value} must declare routesPanel`);
    assert.equal(isRoutesPanelMode(m.value), m.routesPanel);
  }
});

test('the migrated legacy mode renders route cards too, so it pulls the roster like any other', () => {
  // A migration that lands on the right rail but skips the roster fetch is the empty-dropdown
  // bug wearing a redirect.
  assert.equal(isRoutesPanelMode('routesLoads'), true);
});
