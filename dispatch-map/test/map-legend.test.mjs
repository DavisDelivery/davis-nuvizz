// The legend must describe THIS board and nothing else.
//
// Chad, on a 760-stop map: "only want it to display any icons that are currently on the map."
// The rules that make that true are not obvious — the marker layer hides marks in four
// different ways, and every one of them is a way for the legend to list something a
// dispatcher will never find out on the satellite. Each test below names the board condition
// it protects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawnRestrictionKeys,
  buildLegendInventory,
  emptyLegendInventory,
  iconClusterShape,
  pinTintKind,
  presentIconKeys,
  legendIsEmpty,
  TRAILER_BLOCKER_KEYS,
  tractorPaintAllowed,
} from '../src/lib/map-legend.js';
import { readFileSync } from 'node:fs';

// ── WHICH ICONS A STOP ACTUALLY DRAWS ────────────────────────────────────────

test('an AM/PM delivery window takes the pin from the clock, so the clock is not on the map', () => {
  // The window IS the receiving-time statement. stopMarkerIcon drops the time mark so the
  // AM/PM tag can show; a legend that still listed the clock would send somebody hunting.
  const keys = ['liftgate_required', 'hours_early_close'];
  assert.deepEqual(drawnRestrictionKeys(keys, { deliveryWindow: 'AM' }), ['liftgate_required']);
  assert.deepEqual(drawnRestrictionKeys(keys, { deliveryWindow: 'PM' }), ['liftgate_required']);
  assert.deepEqual(drawnRestrictionKeys(keys, { deliveryWindow: null }), keys);
});

test('a dispatcher marking a stop tractor-OK removes the trailer blockers from the map', () => {
  const keys = ['no_tractor_trailer', 'liftgate_required', 'no_overhead_clearance'];
  assert.deepEqual(drawnRestrictionKeys(keys, { eligibility: 'tractor' }), ['liftgate_required']);
  // box_only overrules nothing — it agrees with the blockers.
  assert.deepEqual(drawnRestrictionKeys(keys, { eligibility: 'box_only' }), keys);
});

test('the alias resolver is honoured, or straight_truck_only survives a tractor-OK', () => {
  const resolve = (k) => (k === 'straight_truck_only' ? 'box_truck_only' : k);
  assert.ok(TRAILER_BLOCKER_KEYS.has('straight_truck_only'));
  assert.deepEqual(
    drawnRestrictionKeys(['straight_truck_only'], { eligibility: 'tractor', resolve }),
    [],
  );
});

test('a stop wearing a pin instead of its icons contributes no icons at all', () => {
  // do-not-send, a numbered pin inside an open route, and the already-planned mute all
  // REPLACE the icon cluster. Those marks are not on the map while that is true.
  assert.deepEqual(drawnRestrictionKeys(['no_tractor_trailer'], { hidden: true }), []);
});

test('junk in does not crash and does not invent marks', () => {
  for (const bad of [null, undefined, 'no_tractor_trailer', 0, {}]) {
    assert.deepEqual(drawnRestrictionKeys(bad, {}), []);
  }
  assert.deepEqual(drawnRestrictionKeys([null, undefined, '', 'liftgate_required'], {}), ['liftgate_required']);
  assert.deepEqual(drawnRestrictionKeys(['x']), ['x'], 'no opts at all is the same as no suppression');
});

// ── THE CLUSTER THE MARKER ACTUALLY PAINTS ───────────────────────────────────

test('a stop with four restrictions paints two icons and a +N, so only those two are on the map', () => {
  // The whole reason this is not a naive tally: the marker collapses 4+ to "first 2 + overflow".
  // Listing restrictions three and four would put marks in the key that appear nowhere.
  const inv = buildLegendInventory([
    { icons: ['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'no_overhead_clearance'], note: null },
  ]);
  assert.deepEqual(Object.keys(inv.iconCounts).sort(), ['liftgate_required', 'no_tractor_trailer']);
  assert.equal(inv.shapes.overflow, 1);
  assert.equal(inv.shapes.single, 0);
});

test('cluster shapes match how the marker lays them out', () => {
  assert.equal(iconClusterShape(1), 'single');
  assert.equal(iconClusterShape(2), 'multi');
  assert.equal(iconClusterShape(3), 'multi');
  assert.equal(iconClusterShape(4), 'overflow');
  assert.equal(iconClusterShape(0), null);
  assert.equal(iconClusterShape(-1), null);
  assert.equal(iconClusterShape('nonsense'), null);
});

test('three restrictions all draw — the overflow starts at four', () => {
  const inv = buildLegendInventory([{ icons: ['a', 'b', 'c'], note: null }]);
  assert.deepEqual(Object.keys(inv.iconCounts).sort(), ['a', 'b', 'c']);
  assert.equal(inv.shapes.multi, 1);
});

// ── COUNTING A BOARD ─────────────────────────────────────────────────────────

test('a mark on one stop counts once, not once per restriction it shares a pin with', () => {
  const inv = buildLegendInventory([
    { icons: ['liftgate_required', 'liftgate_required'], note: null },
  ]);
  assert.equal(inv.iconCounts.liftgate_required, 1);
});

test('the three no-icon pin tints follow flagColor, so purple means the same on both', () => {
  assert.equal(pinTintKind({ priority_flag: 'red' }), 'red');
  assert.equal(pinTintKind({ equipment_restrictions: ['no_53ft'] }), 'restricted');
  assert.equal(pinTintKind({ liftgate_required: true }), 'restricted');
  assert.equal(pinTintKind({ appointment_required: true }), 'restricted');
  assert.equal(pinTintKind({ equipment_restrictions: [] }), 'plain');
  assert.equal(pinTintKind(null), 'plain');
  // A flag WINS over restrictions — same precedence as flagColor().
  assert.equal(pinTintKind({ priority_flag: 'yellow', liftgate_required: true }), 'yellow');
});

test('a pin-overridden stop still counts as a stop and still carries its flag colour', () => {
  // A do-not-send stop shows no restriction icons but its red flag is absolutely on the map.
  const inv = buildLegendInventory([
    { icons: [], note: { priority_flag: 'red', liftgate_required: true }, hidden: true },
  ]);
  assert.equal(inv.stops, 1);
  assert.equal(inv.hiddenByPin, 1);
  assert.equal(inv.withIcons, 0);
  assert.equal(inv.tints.red, 1);
  assert.deepEqual(inv.iconCounts, {});
});

test('an empty board is empty, and a board of plain stops is not', () => {
  assert.ok(legendIsEmpty(buildLegendInventory([])));
  assert.ok(legendIsEmpty(emptyLegendInventory()));
  assert.ok(legendIsEmpty(null));
  assert.ok(!legendIsEmpty(buildLegendInventory([{ icons: [], note: null }])));
});

test('the tractor-delivered tally counts stops, so the lime row can say whether any are lit', () => {
  const inv = buildLegendInventory([
    { icons: [], note: null, tractorDelivered: true },
    { icons: [], note: null, tractorDelivered: false },
    { icons: [], note: null },
  ]);
  assert.equal(inv.tractorDelivered, 1);
  assert.equal(inv.stops, 3);
});

test('rows that are not stops are skipped rather than counted as blank stops', () => {
  const inv = buildLegendInventory([null, undefined, 'x', 7, { icons: ['a'], note: null }]);
  assert.equal(inv.stops, 1);
  assert.deepEqual(buildLegendInventory(null), emptyLegendInventory());
});

// ── ORDERING ─────────────────────────────────────────────────────────────────

test('present icons keep the canonical display order, so filtering never reshuffles the key', () => {
  const order = ['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'closed_monday'];
  const inv = buildLegendInventory([
    { icons: ['closed_monday'], note: null },
    { icons: ['liftgate_required'], note: null },
  ]);
  assert.deepEqual(presentIconKeys(inv, order), ['liftgate_required', 'closed_monday']);
});

test('a mark the map drew but the order does not list is still shown — that is the one to explain', () => {
  const inv = buildLegendInventory([{ icons: ['something_new'], note: null }]);
  assert.deepEqual(presentIconKeys(inv, ['no_tractor_trailer']), ['something_new']);
  assert.deepEqual(presentIconKeys(emptyLegendInventory(), ['a']), []);
  assert.deepEqual(presentIconKeys(null, ['a']), []);
});

// ── THE TRACTOR-DELIVERED LIME PAINT MUST NEVER OUTRANK A CURRENT "NO" ──────
//
// Chad, from the stop panel, with "No tractor trailer" checked in Equipment
// restrictions: "need a no tractor trailer override button that will override
// the green auto paint." tractor_locations is a sticky, automatic "a tractor
// delivered here once, ever" record that never un-flags itself — a dispatcher's
// CURRENT mark has to outrank that old history, not the other way around.

test('a hand-set box-only stop is never painted the tractor-delivered lime', () => {
  assert.equal(tractorPaintAllowed('box_only', []), false);
  assert.equal(tractorPaintAllowed('box_only', ['liftgate_required']), false);
});

test('a checked "No tractor trailer" restriction is never painted the tractor-delivered lime', () => {
  // This is the exact case from the screenshot: the chip is checked, nothing else changed.
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer']), false);
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer', 'liftgate_required']), false, 'still blocked alongside other badges');
});

test('an unrestricted stop, or one marked tractor-OK, still gets the lime paint', () => {
  assert.equal(tractorPaintAllowed(null, []), true);
  assert.equal(tractorPaintAllowed('tractor', []), true);
  // A hand-set "tractor OK" already drops no_tractor_trailer from the DRAWN set upstream
  // (drawnRestrictionKeys), so by the time this function sees it, it is correctly absent —
  // this function must not re-derive the same suppression from raw data a second way.
  assert.equal(tractorPaintAllowed('tractor', drawnRestrictionKeys(['no_tractor_trailer'], { eligibility: 'tractor' })), true);
});

test('other restrictions alone (liftgate, appointment, a clock) do not block the lime paint', () => {
  // Only the two "do not send a 53-footer here" signals block it. A liftgate requirement
  // says nothing about tractor eligibility and must not silently steal the tint too.
  assert.equal(tractorPaintAllowed(null, ['liftgate_required']), true);
  assert.equal(tractorPaintAllowed(null, ['appointment_required', 'hours_early_close']), true);
});

test('box_only and a checked "No tractor trailer" agree — both block, together or alone', () => {
  assert.equal(tractorPaintAllowed('box_only', ['no_tractor_trailer']), false);
});

// ── ONE FUNCTION, THREE CALL SITES — the shape of the bug that was fixed ─────
//
// The bug was never "the rule is wrong" — box_only already worked, on the plain pin. It was
// three copies of a two-line ternary that only two of them remembered to write correctly.
// These read the SHIPPED App.jsx source, because a fixture proves the rule once; only the
// source proves the fix actually reached every place that paints a stop.

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const STOP_MARKER_ICON = APP.slice(
  APP.indexOf('function stopMarkerIcon('),
  APP.indexOf('\n// Live-driver truck marker size'),
);

test('tractorPaintAllowed is imported, and stopMarkerIcon computes it exactly once', () => {
  assert.match(APP.slice(0, APP.indexOf('function stopMarkerIcon(')), /tractorPaintAllowed/,
    'tractorPaintAllowed must be imported from map-legend.js');
  const hits = STOP_MARKER_ICON.match(/tractorPaintAllowed\(/g) || [];
  assert.equal(hits.length, 1, 'computed once and reused — a second call site is how this drifts again');
});

test('the numbered route pin honors the override', () => {
  assert.match(STOP_MARKER_ICON, /routeColor \|\| \(\(tractorDelivered && !noTractorOverride\) \? TRACTOR_DELIVERED_COLOR/);
});

test('the plain pin honors the override', () => {
  assert.match(STOP_MARKER_ICON, /noTractorOverride \? eligColor/);
});

test('the restriction-icon cluster honors the override — this was the actual bug', () => {
  // Before the fix this line read `tractorDelivered ? TRACTOR_DELIVERED_COLOR : ...` with
  // no override check at all, so a checked "No tractor trailer" chip rendered its own
  // restriction icon tinted lime — the auto-paint literally painting over the manual mark
  // that exists specifically to contradict it.
  assert.match(STOP_MARKER_ICON, /iconMarkerSvg\(restrictions, \(tractorDelivered && !noTractorOverride\) \? TRACTOR_DELIVERED_COLOR/);
});
