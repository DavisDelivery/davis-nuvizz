// test/forklift-red-ring.test.mjs — THE RED RING (v1.87.4).
//
// Chad, 2026-09-28, beside a Shiplify forklift pin in its lime ring: "on a stop that i mark no
// tractor trailer but the shiplfy data says they have a forklift just make the green ring red
// instead." Until now his mark made the pin vanish — the stated no vetoes the lime and becomes
// the stop's no-trailer mark — so the map stopped saying there is a forklift at exactly the stop
// where a box truck is now the plan and the forklift is how the freight comes off.
//
// These build real markers and read the SVG back (helpers/app-markers.mjs), and pin the rule
// one suppression at a time: the red ring answers the trailer question and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shiplifyPinKind, forkliftRedRingEnabled, FORKLIFT_RED_RING_ON } from '../src/lib/place-mark.js';
import { loadStopMarkerIcon, loadStopMarkerIconWith, markerSvg } from './helpers/app-markers.mjs';

const RED = '#dc2626';      // ELIG_BOX_COLOR — the Box-only red the map already uses for "no trailer"
const LIME = '#32CD32';     // TRACTOR_DELIVERED_COLOR — the green ring Chad is replacing

// ── the rule ─────────────────────────────────────────────────────────────────

const facts = (o = {}) => ({ candidate: 'forklift', shiplifyOn: true, statusKind: 'UNPLANNED', paintAllowed: false, redRing: true, ...o });

test('a forklift on a stop marked no tractor trailer is the red ring — Box-only, or a confirmed no-trailer mark', () => {
  assert.equal(shiplifyPinKind(facts({ eligibility: 'box_only' })), 'forklift_blocked', 'Box truck only, no restriction');
  assert.equal(shiplifyPinKind(facts({ restrictionCount: 1, onlyBlockers: true })), 'forklift_blocked', 'a confirmed No tractor trailer');
  assert.equal(shiplifyPinKind(facts({ restrictionCount: 2, onlyBlockers: true })), 'forklift_blocked', 'two trailer blockers are still one question');
  assert.equal(shiplifyPinKind(facts({ statusKind: 'SCHEDULED', restrictionCount: 1, onlyBlockers: true })), 'forklift_blocked');
});

test('a tractor that once delivered there does not hide it — the stated no already outranks the lime', () => {
  assert.equal(shiplifyPinKind(facts({ tractorSeen: true, restrictionCount: 1, onlyBlockers: true })), 'forklift_blocked');
});

test('the red ring answers the trailer question ONLY — every other mark keeps its place', () => {
  const off = {
    'switch off (VITE_MAP_FORKLIFT_RED_RING=off)': { redRing: false },
    'Shiplify off on this tab': { shiplifyOn: false },
    'a dock, not a forklift': { candidate: 'dock' },
    'no Shiplify pin at all': { candidate: null },
    'a clock or a liftgate beside the no-trailer mark': { restrictionCount: 2, onlyBlockers: false },
    'Tractor-trailer OK (contradicts itself — no ring)': { eligibility: 'tractor', restrictionCount: 1, onlyBlockers: true },
    'nobody said no (an advisory blocker leaves paint allowed)': { paintAllowed: true, restrictionCount: 1, onlyBlockers: true },
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
  };
  for (const [why, o] of Object.entries(off)) assert.equal(shiplifyPinKind(facts({ eligibility: 'box_only', ...o })), null, why);
});

test('the lime pins are exactly as they were', () => {
  const lime = { candidate: 'forklift', shiplifyOn: true, statusKind: 'UNPLANNED', redRing: true };
  assert.equal(shiplifyPinKind(lime), 'forklift');
  assert.equal(shiplifyPinKind({ ...lime, candidate: 'dock' }), 'dock');
  assert.equal(shiplifyPinKind({ ...lime, tractorSeen: true }), null);
  assert.equal(shiplifyPinKind({ ...lime, restrictionCount: 1 }), null);
  assert.equal(shiplifyPinKind({ ...lime, eligibility: 'tractor' }), null);
});

test('VITE_MAP_FORKLIFT_RED_RING: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(forkliftRedRingEnabled({}), true);
  assert.equal(forkliftRedRingEnabled(undefined), true);
  for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(forkliftRedRingEnabled({ VITE_MAP_FORKLIFT_RED_RING: off }), false, off);
  assert.equal(forkliftRedRingEnabled({ VITE_MAP_FORKLIFT_RED_RING: 'of' }), true);
  assert.equal(FORKLIFT_RED_RING_ON, true, 'this build (no env) reads on');
});

// ── the marker, drawn ────────────────────────────────────────────────────────

const FORK = { dock_access: 'no', forklift: 'yes', location_types: [], tariff_items: [] };
const DOCK = { dock_access: 'yes', forklift: '', location_types: [], tariff_items: [] };
let n = 0;
const stop = (o = {}) => ({ stopNbr: String(9100000 + (++n)), stopType: 'DO', lat: 34, lng: -84, addr1: `${n} Fake St`, zip: '30000', matchKey: `rr${n}`, normalizedStatus: 'UNPLANNED', ...o });
const shiplify = (rec) => ({ shiplifyRec: rec, shiplifyOn: true, tractorSeen: false, tractorKnown: true });
const NO_TRAILER = { equipment_restrictions: ['no_tractor_trailer'] };   // no auto_sources → confirmed
const ringOf = (svg) => /<circle cx="14" cy="14" r="12.5" fill="#ffffff" stroke="(#[0-9a-fA-F]{6})" stroke-width="3"\/>/.exec(svg)?.[1] ?? null;
const hasForklift = (svg) => /data-glyph="forklift"/.test(svg);

test('THE ASK: a forklift stop marked No tractor trailer draws the forklift pin in a RED ring', async () => {
  const icon = await loadStopMarkerIcon();
  const svg = markerSvg(icon(stop(), NO_TRAILER, shiplify(FORK)));
  assert.equal(ringOf(svg), RED, 'the ring is the Box-only red');
  assert.ok(hasForklift(svg), 'the forklift is still on it');
  // Before the mark: the same stop wore the lime ring.
  const before = markerSvg(icon(stop(), null, shiplify(FORK)));
  assert.equal(ringOf(before), LIME);
  assert.ok(hasForklift(before));
});

test('Box truck only draws the red ring too, on an unplanned and a scheduled stop alike, at the forklift pin\'s size', async () => {
  const icon = await loadStopMarkerIcon();
  for (const normalizedStatus of ['UNPLANNED', 'SCHEDULED']) {
    const spec = icon(stop({ normalizedStatus }), { vehicle_eligibility: 'box_only' }, shiplify(FORK));
    const svg = markerSvg(spec);
    assert.equal(ringOf(svg), RED, normalizedStatus);
    assert.ok(hasForklift(svg), normalizedStatus);
    assert.equal(spec.scaledSize.width, 22, `${normalizedStatus}: the forklift pin's tier, not the 16px resting dot`);
  }
});

test('a pickup keeps its PU in the middle and the forklift moves to a RED corner badge, never a lime one', async () => {
  const icon = await loadStopMarkerIcon();
  const svg = markerSvg(icon(stop({ stopType: 'PU' }), NO_TRAILER, shiplify(FORK)));
  assert.equal(ringOf(svg), RED);
  assert.match(svg, />PU</);
  assert.ok(hasForklift(svg));
  assert.ok(!svg.includes(LIME), 'no lime anywhere on a no-trailer pin');
});

test('what does NOT turn red: a dock, a second mark, an advisory no, and a stop Shiplify never saw', async () => {
  const icon = await loadStopMarkerIcon();
  const dock = markerSvg(icon(stop(), NO_TRAILER, shiplify(DOCK)));
  assert.equal(hasForklift(dock), false, 'a dock pin is not asked about — unchanged: no pin');
  // A liftgate beside the no-trailer mark keeps the CLUSTER, so the liftgate is not lost — and since
  // v1.90.1 the forklift rides it as a disc of its own, in the red ring (test/forklift-with-clock.test.mjs).
  const withLiftgate = markerSvg(icon(stop(), { ...NO_TRAILER, liftgate_required: true }, shiplify(FORK)));
  assert.doesNotMatch(withLiftgate, /data-form="center"/, 'no State A pin: the cluster stays');
  assert.match(withLiftgate, /data-glyph="forklift" data-form="slot"/, 'the forklift is beside the cluster, not instead of it');
  const advisory = markerSvg(icon(stop(), { equipment_restrictions: ['no_tractor_trailer'], auto_sources: { no_tractor_trailer: ['orderInstructions'] } }, shiplify(FORK)));
  // Nobody has checked an advisory no, so it is NOT the red ring: it keeps its split icon, and since
  // v1.90.1 the forklift rides beside it as a LIME disc (an unconfirmed no does not turn the ring red).
  assert.match(advisory, /data-glyph="forklift" data-form="slot">\s*<circle [^>]*stroke="#32CD32"/, 'lime forklift disc beside the split icon');
  assert.doesNotMatch(advisory, /data-form="slot">\s*<circle [^>]*stroke="#dc2626"/, 'never the red ring on an unconfirmed no');
  const noRecord = markerSvg(icon(stop(), NO_TRAILER, shiplify(null)));
  assert.equal(hasForklift(noRecord), false);
});

test('SWITCH OFF: the no-trailer stop draws exactly what it drew before this release', async () => {
  const on = await loadStopMarkerIcon();
  const off = await loadStopMarkerIconWith({ FORKLIFT_RED_RING_ON: false });
  const s = stop();
  const offSvg = markerSvg(off(s, NO_TRAILER, shiplify(FORK)));
  assert.equal(hasForklift(offSvg), false, 'no forklift pin, as before');
  assert.equal(offSvg, markerSvg(on(s, NO_TRAILER, shiplify(null))), 'byte-identical to the same stop with no Shiplify record — its no-trailer mark');
  const boxOff = markerSvg(off(stop(), { vehicle_eligibility: 'box_only' }, shiplify(FORK)));
  assert.equal(ringOf(boxOff), null, 'Box-only: the solid red disc, not a ring');
  assert.equal(hasForklift(boxOff), false);
});
