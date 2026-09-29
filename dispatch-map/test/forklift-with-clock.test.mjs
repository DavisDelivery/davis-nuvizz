// test/forklift-with-clock.test.mjs — THE FORKLIFT BESIDE THE CLOCK (v1.90.1).
//
// Chad, 2026-09-28, on PRO 007183542 (EXPRESS CONTAINER SERVICES), a stop with a receiving clock and a
// Shiplify forklift: "this stop should have a double icons one for time and one for forklift." A
// restriction cluster used to veto the forklift pin outright, so the clock showed and the forklift —
// how the freight comes off — vanished. These build real markers and read the SVG back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shiplifyPinKind, forkliftWithClockEnabled, FORKLIFT_WITH_CLOCK_ON } from '../src/lib/place-mark.js';
import { loadStopMarkerIcon, loadStopMarkerIconWith, markerSvg } from './helpers/app-markers.mjs';

// ── the rule ─────────────────────────────────────────────────────────────────
const facts = (o = {}) => ({ candidate: 'forklift', shiplifyOn: true, statusKind: 'UNPLANNED', restrictionCount: 1, withClock: true, ...o });

test('a forklift stop with a restriction cluster is the SLOT, in either ring', () => {
  assert.equal(shiplifyPinKind(facts()), 'forklift_slot');
  assert.equal(shiplifyPinKind(facts({ restrictionCount: 3 })), 'forklift_slot');
  assert.equal(shiplifyPinKind(facts({ statusKind: 'SCHEDULED' })), 'forklift_slot');
  // A confirmed no-trailer mark beside a clock: the red-ring slot, on the same rule as the red-ring pin.
  assert.equal(shiplifyPinKind(facts({ paintAllowed: false, redRing: true, onlyBlockers: false })), 'forklift_slot_blocked');
  assert.equal(shiplifyPinKind(facts({ paintAllowed: false, redRing: true, onlyBlockers: true })), 'forklift_blocked', 'only blockers → the red-ring PIN, as before');
});

test('the dock is never a slot, and every other suppression still wins', () => {
  const off = {
    'a dock, not a forklift': { candidate: 'dock' },
    'switch off (VITE_MAP_FORKLIFT_WITH_CLOCK=off)': { withClock: false },
    'Shiplify off on this tab': { shiplifyOn: false },
    'tractor seen (lime history)': { tractorSeen: true },
    'a vehicle mark on the location': { eligibility: 'box_only' },
    school: { placeMark: 'school' },
    church: { placeMark: 'church' },
    government: { placeMark: 'government' },
    'out for delivery': { statusKind: 'OUT_FOR_DEL' },
    delivered: { statusKind: 'DELIVERED' },
    'do not send': { dns: true },
    selected: { matched: true },
    'search hit': { searchMatched: true },
    'open route card': { inRoute: true },
    'planned-muted': { plannedMuted: true },
    'priority flag': { priorityFlag: 'red' },
    'address off': { addressOff: true },
    Estes: { estes: true },
    'a no-trailer mark with the red-ring switch off': { paintAllowed: false, redRing: false },
  };
  for (const [why, o] of Object.entries(off)) assert.equal(shiplifyPinKind(facts(o)), null, why);
});

test('with no restriction cluster nothing changed: the lime pin, the dock pin, the red-ring pin', () => {
  assert.equal(shiplifyPinKind(facts({ restrictionCount: 0 })), 'forklift');
  assert.equal(shiplifyPinKind(facts({ restrictionCount: 0, candidate: 'dock' })), 'dock');
  assert.equal(shiplifyPinKind(facts({ restrictionCount: 0, paintAllowed: false, redRing: true })), 'forklift_blocked');
});

test('VITE_MAP_FORKLIFT_WITH_CLOCK: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(forkliftWithClockEnabled({}), true);
  assert.equal(forkliftWithClockEnabled(undefined), true);
  for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(forkliftWithClockEnabled({ VITE_MAP_FORKLIFT_WITH_CLOCK: off }), false, off);
  assert.equal(forkliftWithClockEnabled({ VITE_MAP_FORKLIFT_WITH_CLOCK: 'of' }), true);
  assert.equal(FORKLIFT_WITH_CLOCK_ON, true, 'this build (no env) reads on');
});

// ── the marker, drawn ────────────────────────────────────────────────────────
const FORK = { dock_access: 'no', forklift: 'yes', location_types: [], tariff_items: [] };
const DOCK = { dock_access: 'yes', forklift: '', location_types: [], tariff_items: [] };
let n = 0;
const stop = (o = {}) => ({ stopNbr: String(9300000 + (++n)), stopType: 'DO', lat: 34, lng: -84, addr1: `${n} Fake St`, zip: '30000', matchKey: `fc${n}`, normalizedStatus: 'UNPLANNED', ...o });
const shiplify = (rec) => ({ shiplifyRec: rec, shiplifyOn: true, tractorSeen: false, tractorKnown: true });
// 007183542's shape: a receiving-hours clock, hours typed by a dispatcher (Tuesday, the board's day).
const CLOCK = { receiving_hours: { tue: { open: '7:00', close: '11:00' } }, manual_overrides: { receiving_hours: true } };
const DAY = { selectedDayKey: 'tue' };
const slotOf = (svg) => /<g data-glyph="forklift" data-form="slot">\s*<circle cx="([\d.]+)" cy="[\d.]+" r="14" fill="white" fill-opacity="0.95" stroke="(#[0-9a-fA-F]{6})" stroke-width="3"\/>/.exec(svg);

test('THE ASK: a clock and a forklift are TWO icons — the clock, then the forklift disc in the lime ring', async () => {
  const icon = await loadStopMarkerIcon();
  const spec = icon(stop(), CLOCK, { ...DAY, ...shiplify(FORK) });
  const svg = markerSvg(spec);
  const slot = slotOf(svg);
  assert.ok(slot, 'the forklift disc is there');
  assert.equal(slot[2], '#32CD32', 'the pin\'s own lime ring');
  assert.ok(Number(slot[1]) > 16, 'AFTER the clock: it sits in the second slot, not the first');
  assert.match(svg, /width="66" height="40" viewBox="0 0 66 40"/, 'two slots side by side (32 + 2 + 32)');
  assert.match(svg, /data-glyph="forklift" data-form="slot"[\s\S]*fill="#1f2937"/, 'the dark forklift on the white disc');
  // Before this change the same stop was ONE clock and no forklift.
  const before = markerSvg((await loadStopMarkerIconWith({ FORKLIFT_WITH_CLOCK_ON: false }))(stop(), CLOCK, { ...DAY, ...shiplify(FORK) }));
  assert.equal(slotOf(before), null);
  assert.match(before, /width="40" height="44" viewBox="0 0 40 44"/, 'the single-clock footprint, unchanged');
});

test('a cluster of several restrictions keeps them all and adds the forklift last', async () => {
  const icon = await loadStopMarkerIcon();
  const note = { ...CLOCK, liftgate_required: true, appointment_required: true };
  const svg = markerSvg(icon(stop(), note, { ...DAY, ...shiplify(FORK) }));
  assert.ok(slotOf(svg));
  const withoutFork = markerSvg(icon(stop(), note, { ...DAY, ...shiplify(null) }));
  const wide = (x) => Number(/width="(\d+)" height="40"/.exec(x)[1]);
  assert.equal(wide(svg) - wide(withoutFork), 34, 'exactly one more slot (32 + 2 gap), nothing else moved');
});

test('a confirmed no-trailer mark beside the clock: the RED-ring forklift disc, cluster intact', async () => {
  const icon = await loadStopMarkerIcon();
  const note = { ...CLOCK, equipment_restrictions: ['no_tractor_trailer'] };   // no auto_sources → confirmed
  const svg = markerSvg(icon(stop(), note, { ...DAY, ...shiplify(FORK) }));
  const slot = slotOf(svg);
  assert.ok(slot);
  assert.equal(slot[2], '#dc2626', 'the Box-only red ring, not lime');
  assert.ok(!svg.includes('stroke="#32CD32"'), 'no lime anywhere on a no-trailer stop');
});

test('a place mark rides the last RESTRICTION disc, never on top of the forklift', async () => {
  const icon = await loadStopMarkerIcon();
  const svg = markerSvg(icon(stop(), { ...CLOCK, building_type: 'residential' }, { ...DAY, ...shiplify(FORK) }));
  const slot = slotOf(svg);
  const badge = /data-glyph="residential" data-form="cluster">\s*<circle cx="([\d.]+)"/.exec(svg);
  assert.ok(slot && badge);
  assert.ok(Number(badge[1]) < Number(slot[1]), 'the house badge sits on the first disc (the clock), left of the forklift');
});

test('a dock is unchanged: still no pin beside a clock', async () => {
  const icon = await loadStopMarkerIcon();
  const svg = markerSvg(icon(stop(), CLOCK, { ...DAY, ...shiplify(DOCK) }));
  assert.equal(slotOf(svg), null);
  assert.doesNotMatch(svg, /data-glyph="forklift"/);
});

test('SWITCH OFF: byte-identical to the marker before this release', async () => {
  const off = await loadStopMarkerIconWith({ FORKLIFT_WITH_CLOCK_ON: false });
  const on = await loadStopMarkerIcon();
  const s = stop();
  assert.equal(markerSvg(off(s, CLOCK, { ...DAY, ...shiplify(FORK) })), markerSvg(on(s, CLOCK, { ...DAY, ...shiplify(null) })),
    'the same stop with no Shiplify record: its clock alone');
});

// ── the Legend counts what the map drew ──────────────────────────────────────
import { buildLegendInventory } from '../src/lib/map-legend.js';

test('the Legend counts a forklift disc beside a clock as the forklift, and still counts the clock', () => {
  const inv = buildLegendInventory([
    { icons: ['receiving_hours'], note: null, tractorDelivered: false, hidden: false, shiplifyPin: 'forklift_slot' },
    { icons: ['receiving_hours', 'liftgate_required'], note: null, tractorDelivered: false, hidden: false, shiplifyPin: 'forklift_slot_blocked' },
    { icons: [], note: null, tractorDelivered: false, hidden: false, shiplifyPin: 'forklift' },
    { icons: ['receiving_hours'], note: null, tractorDelivered: false, hidden: false, shiplifyPin: null },
  ]);
  assert.equal(inv.shiplifyForklift, 2, 'the lime pin and the lime disc are the same forklift row');
  assert.equal(inv.shiplifyForkliftBlocked, 1, 'the red disc is counted with the red ring');
  assert.equal(inv.iconCounts.receiving_hours, 3, 'the clocks are all still counted — the forklift replaced nothing');
  assert.equal(inv.iconCounts.liftgate_required, 1);
});
