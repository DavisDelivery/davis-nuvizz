// The Routing rail's THIRD mode — Chad, Aug 25: "I just want a 3rd right panel option that is
// routes and loads."
//
// These pin the two things that decide whether the mode works on a dispatch board, neither of
// which is visible by looking at the rail: whether a stored value can leave the panel blank,
// and whether the mode declares that it needs the live driver-assignment roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHT_PANEL_MODES,
  DEFAULT_RIGHT_PANEL_MODE,
  normalizeRightPanelMode,
  isRoutesPanelMode,
  hasDriversTab,
  ROUTES_LOADS_TABS,
  normalizeRoutesLoadsTab,
} from '../src/lib/right-panel.js';

test('the gear offers Routes / Loads as a third choice, and the other two are untouched', () => {
  assert.deepEqual(
    RIGHT_PANEL_MODES.map((m) => m.value),
    ['tabs', 'routes', 'routesLoads'],
  );
  // Chad asked for the existing two to stay exactly as they are — including their wording,
  // which is what he picks them by.
  assert.equal(RIGHT_PANEL_MODES[0].label, 'Tabs (Stops / Loads / Result)');
  assert.equal(RIGHT_PANEL_MODES[1].label, 'Routes / Drivers');
  assert.equal(RIGHT_PANEL_MODES[2].label, 'Routes / Loads');
});

test('Drivers survives — it was not replaced, it was joined', () => {
  assert.ok(RIGHT_PANEL_MODES.some((m) => m.value === 'routes'));
  assert.equal(hasDriversTab('routes'), true);
});

// ── The stored value is not ours ─────────────────────────────────────────────
test('a stored mode this build cannot render falls back to the tabs rail, never to a blank one', () => {
  for (const raw of ['drivers', 'routesloads', 'ROUTESLOADS', '', ' ', 'undefined', '{}']) {
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
test('Routes / Loads declares that it renders route cards, so the assign roster is fetched', () => {
  // The route cards' driver dropdown is filled from the live assignment roster, and that fetch
  // is gated on this. A mode that renders the cards without it shows an empty dropdown on a
  // dispatch board — indistinguishable from the vendor being down.
  assert.equal(isRoutesPanelMode('routesLoads'), true);
  assert.equal(isRoutesPanelMode('routes'), true);
  assert.equal(isRoutesPanelMode('tabs'), false);
});

test('every mode that renders route cards says so on its own descriptor', () => {
  // The declaration is the contract: adding a fourth mode that shows route cards without
  // setting routesPanel is the same bug again, and this is where it gets caught.
  for (const m of RIGHT_PANEL_MODES) {
    assert.equal(typeof m.routesPanel, 'boolean', `${m.value} must declare routesPanel`);
    assert.equal(isRoutesPanelMode(m.value), m.routesPanel);
  }
});

test('Routes / Loads has no Drivers tab, so it does not pull the driver roster', () => {
  // Nothing in this mode can show it; fetching it would be a request nobody reads.
  assert.equal(hasDriversTab('routesLoads'), false);
  assert.equal(hasDriversTab('tabs'), false);
});

// ── The impossible state ─────────────────────────────────────────────────────
test('the Routes / Loads sub-tab cannot be “drivers” — there is no panel to render for it', () => {
  assert.equal(normalizeRoutesLoadsTab('drivers'), 'routes');
  assert.ok(!ROUTES_LOADS_TABS.includes('drivers'));
});

test('the Routes / Loads sub-tab persists both of its real values', () => {
  assert.equal(normalizeRoutesLoadsTab('loads'), 'loads');
  assert.equal(normalizeRoutesLoadsTab('routes'), 'routes');
  assert.equal(normalizeRoutesLoadsTab(null), 'routes');
  assert.equal(normalizeRoutesLoadsTab('Loads'), 'routes');   // case is not a near miss, it is a miss
});
