// test/plan-target-profile.test.mjs — WHICH TRUCK A PICKED LOAD DEFAULTS TO.
//
// Chad, on the Plan-onto list: "why does the system not know victor is a tractor trailer, it
// should know this from the engine data." These pin the precedence the list now uses —
// dispatcher's pick, then the load's driver from the roster, then the name rule, then box —
// as freight rules named for the day they were written on, not as the shape of a dropdown.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planTargetProfile, driverHintForLoad, loadNamesToResolve, resolveKey,
  nameSuggestsTrailer, resolvedTruckClass, tractorProfileOf, boxProfileOf,
} from '../src/lib/plan-target-profile.js';

// The two shipped truck profiles (CLIENT_DEFAULT_TRUCKS / truck-profiles.mts), abridged.
const BOX = { id: 'box_26', label: '26ft Box', truckClass: 'BOX_26', maxSkids: 14, capabilities: { liftgate: true, tractor: false } };
const TRACTOR = { id: 'tractor_53', label: '53ft Trailer', truckClass: 'TRACTOR_53', maxSkids: 28, capabilities: { liftgate: false, tractor: true } };
const PROFILES = [BOX, TRACTOR];

const victor = (extra = {}) => ({
  name: 'VICTOR', query: 'VICTOR', driver_key: 'VICTOR', driver_user_name: 'VICTOR',
  driver_name: 'Victor Mendez', truck_class: 'tractor', observed_days: 41, ...extra,
});

// ── the precedence ───────────────────────────────────────────────────────────

test("Chad's VICTOR shell on Sep 8: the roster says Victor runs a tractor, so the load defaults to the 53ft trailer", () => {
  const r = planTargetProfile({ name: 'VICTOR', resolved: victor(), profiles: PROFILES });
  assert.equal(r.profile.id, 'tractor_53');
  assert.equal(r.source, 'driver');
});

test('before this fix the same load defaulted to the box — the name rule alone still does, so the driver answer is what changed', () => {
  const r = planTargetProfile({ name: 'VICTOR', resolved: null, profiles: PROFILES });
  assert.equal(r.profile.id, 'box_26');
  assert.equal(r.source, 'default');
});

test("the dispatcher's pick on the row beats the roster — Victor may be on a box today", () => {
  const r = planTargetProfile({ pickedId: 'box_26', name: 'VICTOR', resolved: victor(), profiles: PROFILES });
  assert.equal(r.profile.id, 'box_26');
  assert.equal(r.source, 'pick');
});

test('a pick of a profile that no longer exists is not a pick — the roster decides again', () => {
  const r = planTargetProfile({ pickedId: 'flatbed_48', name: 'VICTOR', resolved: victor(), profiles: PROFILES });
  assert.equal(r.profile.id, 'tractor_53');
  assert.equal(r.source, 'driver');
});

test('a box driver on a load whose NAME says trailer still gets the box — the driver is the fact, the name is the guess', () => {
  // "BEN TRL" named by habit; Ben drives a box truck. Capacity follows the truck, not the label.
  const ben = victor({ name: 'BEN TRL', driver_key: 'BEN', driver_name: 'Ben Ortiz', truck_class: 'box_truck' });
  const r = planTargetProfile({ name: 'BEN TRL', resolved: ben, profiles: PROFILES });
  assert.equal(r.profile.id, 'box_26');
  assert.equal(r.source, 'driver');
});

test('TRAILER 6 names nobody, so the name rule still makes it a trailer', () => {
  const r = planTargetProfile({ name: 'TRAILER 6', resolved: null, profiles: PROFILES });
  assert.equal(r.profile.id, 'tractor_53');
  assert.equal(r.source, 'name');
});

test('SUW 2 names nobody and says nothing — box, the fleet majority, and the cheap mistake if wrong', () => {
  const r = planTargetProfile({ name: 'SUW 2', resolved: null, profiles: PROFILES });
  assert.equal(r.profile.id, 'box_26');
  assert.equal(r.source, 'default');
});

test('a resolved driver with an unknown class is treated as unresolved — never silently a tractor', () => {
  const r = planTargetProfile({ name: 'VICTOR', resolved: victor({ truck_class: 'flatbed' }), profiles: PROFILES });
  assert.equal(r.profile.id, 'box_26');
  assert.equal(r.source, 'default');
});

test('with only a box profile on file, a tractor driver still gets a truck (the box) rather than nothing', () => {
  const r = planTargetProfile({ name: 'VICTOR', resolved: victor(), profiles: [BOX] });
  assert.equal(r.profile.id, 'box_26');
  assert.equal(r.source, 'default');
});

test('no profiles at all is no profile — the caller must not build onto undefined', () => {
  const r = planTargetProfile({ name: 'VICTOR', resolved: victor(), profiles: [] });
  assert.equal(r.profile, null);
  assert.equal(r.source, 'none');
});

test('profiles without a capabilities block are told apart by label, the way the old rule did it', () => {
  const list = [{ id: 'a', label: 'Box' }, { id: 'b', label: '53ft Trailer' }];
  assert.equal(tractorProfileOf(list).id, 'b');
  assert.equal(boxProfileOf(list).id, 'a');
  assert.equal(planTargetProfile({ name: 'VICTOR', resolved: victor(), profiles: list }).profile.id, 'b');
});

// ── the helpers ──────────────────────────────────────────────────────────────

test('the name rule is unchanged from what shipped: trailer / trl / 53 as whole words', () => {
  for (const n of ['TRAILER 6', 'SUW TRL', '53 ATL', 'trailer']) assert.ok(nameSuggestsTrailer(n), n);
  for (const n of ['VICTOR', 'SUW 2', 'ATL', '530', 'TRL53X', '']) assert.ok(!nameSuggestsTrailer(n), n);
});

test('resolvedTruckClass reads the engine vocabulary and the raw employee one, and nothing else', () => {
  assert.equal(resolvedTruckClass({ truck_class: 'tractor' }), 'tractor');
  assert.equal(resolvedTruckClass({ truck_class: 'box_truck' }), 'box_truck');
  assert.equal(resolvedTruckClass({ truck_class: 'BOX' }), 'box_truck');
  assert.equal(resolvedTruckClass({ truck_class: 'sprinter' }), null);
  assert.equal(resolvedTruckClass(null), null);
});

test('the row hint names the driver and its title says the truck came from the roster', () => {
  const h = driverHintForLoad(victor());
  assert.equal(h.text, 'Victor Mendez');
  assert.match(h.title, /driver roster/);
  assert.match(h.title, /Victor Mendez drives a tractor-trailer/);
  assert.match(h.title, /41 observed days/);
});

test('when the dispatcher has overridden the row, the title still tells them what Victor usually drives', () => {
  const h = driverHintForLoad(victor(), 'pick');
  assert.match(h.title, /your pick/);
  assert.match(h.title, /tractor-trailer/);
});

test('a history-only driver (no roster card) is named by the NuVizz key, and one observed day is singular', () => {
  const h = driverHintForLoad({ driver_key: 'VINCENT', driver_user_name: 'VINCENT', driver_name: null, truck_class: 'box_truck', observed_days: 1 });
  assert.equal(h.text, 'VINCENT');
  assert.match(h.title, /box truck/);
  assert.match(h.title, /1 observed day\b/);
});

test('no driver, no hint — ninety route codes must not each say "no driver"', () => {
  assert.equal(driverHintForLoad(null), null);
  assert.equal(driverHintForLoad({ driver_key: '' }), null);
});

test('the names sent to the endpoint are the distinct roster names, in roster order, blanks dropped', () => {
  const rows = [{ display: 'VICTOR' }, { display: 'victor' }, { display: '' }, { name: 'BEN 2' }, { display: 'SUW 2' }];
  assert.deepEqual(loadNamesToResolve(rows), ['VICTOR', 'BEN 2', 'SUW 2']);
  assert.deepEqual(loadNamesToResolve(null), []);
});

test('resolveKey is the endpoint key: trimmed, lower-cased, one definition on both sides', () => {
  assert.equal(resolveKey('  VICTOR '), 'victor');
  assert.equal(resolveKey(null), '');
});
