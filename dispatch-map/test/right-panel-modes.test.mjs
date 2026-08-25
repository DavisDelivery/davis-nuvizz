// The Routing rail's THREE right-panel options.
//
// Chad asked for this twice and I got it wrong in between, so the first test here is the one
// that would have caught it: "make it a 3rd option in the settings for the right panel", then
// "I just want a 3rd right panel option that is routes and loads", then — after v0.79.1
// collapsed the three modes into one strip — "there should be 3 right panel views not 2 i
// didn't want to touch either one as they were I wanted a 3rd option."
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHT_PANEL_MODES,
  DEFAULT_RIGHT_PANEL_MODE,
  normalizeRightPanelMode,
  isRoutesPanelMode,
  hasDriversTab,
  ROUTES_DRIVERS_TABS,
  ROUTES_LOADS_TABS,
  normalizeRoutesDriversTab,
  normalizeRoutesLoadsTab,
} from '../src/lib/right-panel.js';

// ── THE COUNT, AND THE TWO THAT WERE ALREADY THERE ───────────────────────────
test('the gear offers THREE right-panel options, not two', () => {
  assert.equal(RIGHT_PANEL_MODES.length, 3);
  assert.deepEqual(RIGHT_PANEL_MODES.map((m) => m.value), ['tabs', 'routes', 'routesLoads']);
});

test('the two that existed are untouched — same labels, same order, still first', () => {
  // "i didn't want to touch either one as they were." The label is what he picks them by.
  assert.equal(RIGHT_PANEL_MODES[0].label, 'Tabs (Stops / Loads / Result)');
  assert.equal(RIGHT_PANEL_MODES[1].label, 'Routes / Drivers');
});

test('the third one is Routes / Loads, and it is an ADDITION', () => {
  assert.equal(RIGHT_PANEL_MODES[2].label, 'Routes / Loads');
  // Drivers did not move into it and did not go away.
  assert.equal(hasDriversTab('routes'), true);
  assert.ok(ROUTES_DRIVERS_TABS.includes('drivers'));
});

// ── The sub-tabs, one vocabulary per mode ────────────────────────────────────
test('each mode flips between its own two panels, like Routes/Drivers always did', () => {
  assert.deepEqual(ROUTES_DRIVERS_TABS, ['routes', 'drivers']);
  assert.deepEqual(ROUTES_LOADS_TABS, ['routes', 'loads']);
});

test('no mode can hold a sub-tab it has no panel for', () => {
  // One shared three-valued tab would make "drivers inside the loads mode" representable, and
  // a state nothing can render is a blank panel waiting to happen.
  assert.equal(normalizeRoutesLoadsTab('drivers'), 'routes');
  assert.equal(normalizeRoutesDriversTab('loads'), 'routes');
});

test('Routes / Loads remembers which panel was open; both survive a round trip', () => {
  for (const t of ROUTES_LOADS_TABS) assert.equal(normalizeRoutesLoadsTab(t), t);
  for (const t of ROUTES_DRIVERS_TABS) assert.equal(normalizeRoutesDriversTab(t), t);
});

test('an unreadable stored sub-tab opens Routes rather than nothing', () => {
  for (const raw of ['Loads', 'LOADS', '', ' ', 'undefined', '{}', null, undefined, 0, {}]) {
    assert.equal(normalizeRoutesLoadsTab(raw), 'routes', `loads-mode, ${JSON.stringify(raw)}`);
    assert.equal(normalizeRoutesDriversTab(raw), 'routes', `drivers-mode, ${JSON.stringify(raw)}`);
  }
});

// ── The stored mode is not ours ──────────────────────────────────────────────
test('a stored mode this build cannot render falls back to the tabs rail, never to a blank one', () => {
  for (const raw of ['drivers', 'routesloads', 'ROUTES', '', ' ', 'undefined', '{}']) {
    assert.equal(normalizeRightPanelMode(raw), DEFAULT_RIGHT_PANEL_MODE, `for ${JSON.stringify(raw)}`);
  }
  assert.equal(normalizeRightPanelMode(null), 'tabs');
  assert.equal(normalizeRightPanelMode(undefined), 'tabs');
  assert.equal(normalizeRightPanelMode(0), 'tabs');
  assert.equal(normalizeRightPanelMode({}), 'tabs');
});

test('every real mode survives a round trip through storage', () => {
  for (const m of RIGHT_PANEL_MODES) assert.equal(normalizeRightPanelMode(String(m.value)), m.value);
});

// ── The one that would have looked like a NuVizz outage ──────────────────────
test('both route-card modes declare it, so the assign roster is fetched for each', () => {
  // The cards' driver dropdown is filled from the live assignment roster and that fetch is
  // gated on this. A mode rendering the cards without it shows an empty dropdown on a dispatch
  // board — indistinguishable from the vendor being down.
  assert.equal(isRoutesPanelMode('routes'), true);
  assert.equal(isRoutesPanelMode('routesLoads'), true);
  assert.equal(isRoutesPanelMode('tabs'), false);
});

test('every mode that renders route cards says so on its own descriptor', () => {
  for (const m of RIGHT_PANEL_MODES) {
    assert.equal(typeof m.routesPanel, 'boolean', `${m.value} must declare routesPanel`);
    assert.equal(isRoutesPanelMode(m.value), m.routesPanel);
  }
});

test('only the Routes / Drivers mode pulls the driver roster', () => {
  // Nothing in the loads mode can show it; fetching it there is a request nobody reads.
  assert.equal(hasDriversTab('routes'), true);
  assert.equal(hasDriversTab('routesLoads'), false);
  assert.equal(hasDriversTab('tabs'), false);
});
