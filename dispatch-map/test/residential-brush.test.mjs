// test/residential-brush.test.mjs — the Residential paint brush in the Routing gear (v1.90.0).
//
// Chad, 2026-09-28, with the gear open on "Mark vehicle eligibility": "the way i can paint tractor
// freindly or not i want to be able to paint residentials". The brush must write what the stop
// panel's Building type picker writes — the same field, who and when — so a house painted on the
// map and a house picked in the panel are one fact, and it must leave the vehicle mark alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextResidentialPaint, residentialBrushEnabled } from '../src/lib/place-mark.js';
import { buildingTypePayload } from '../src/lib/uline-review.js';

test('one click marks a location residential; a second puts it back to Auto', () => {
  for (const cur of [null, undefined, '', 'school', 'church', 'government', 'none', 'garbage']) {
    assert.equal(nextResidentialPaint(cur), 'residential', String(cur));
  }
  assert.equal(nextResidentialPaint('residential'), null);
  assert.equal(nextResidentialPaint(' Residential '), null, 'read the way the picker reads it');
});

test('the brush writes the Building type and NOTHING about the truck', () => {
  const on = buildingTypePayload('davis__1_fake_st__x__30000', nextResidentialPaint(null), 'STAMP');
  assert.deepEqual(on, { match_key: 'davis__1_fake_st__x__30000', building_type: 'residential', building_type_at: 'STAMP', building_type_by: 'dispatcher', last_updated: 'STAMP' });
  const off = buildingTypePayload('davis__1_fake_st__x__30000', nextResidentialPaint('residential'), 'STAMP');
  assert.equal(off.building_type, null, 'back to Auto — Shiplify decides again');
  for (const k of ['vehicle_eligibility', 'vehicle_eligibility_at', 'equipment_restrictions']) assert.equal(k in on, false, k);
});

test('VITE_MAP_RESIDENTIAL_BRUSH: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(residentialBrushEnabled({}), true);
  assert.equal(residentialBrushEnabled(undefined), true);
  for (const off of ['off', '0', 'false', 'no']) assert.equal(residentialBrushEnabled({ VITE_MAP_RESIDENTIAL_BRUSH: off }), false, off);
  assert.equal(residentialBrushEnabled({ VITE_MAP_RESIDENTIAL_BRUSH: 'of' }), true);
});

// ── the wiring, read off the source ─────────────────────────────────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('the click writes the picker\'s payload, merged, and returns before the vehicle-mark code', () => {
  const start = APP.indexOf("if (brush === 'residential') {");
  assert.ok(start > 0);
  const block = APP.slice(start, APP.indexOf('return;\n    }', start) + 14);
  assert.match(block, /nextResidentialPaint\(notes\.get\(mk\)\?\.building_type\)/);
  assert.match(block, /\.\.\.buildingTypePayload\(mk, nextType, serverTimestamp\(\)\)/);
  assert.match(block, /\{ merge: true \}/);
  assert.doesNotMatch(block, /vehicle_eligibility/);
});

test('the gear: its own "Mark building type" group, and "Off" in either group never disarms the other brush', () => {
  assert.match(APP, /label: 'Mark building type',/);
  assert.match(APP, /\.\.\.\(RESIDENTIAL_BRUSH_ON \? \[buildingView\] : \[\]\)/);
  assert.match(APP, /value: eligBrushOn \? eligPaint : 'off',/);
  assert.match(APP, /setValue: \(v\) => \(v === 'off' \? \(eligBrushOn \? setEligBrush\(null\) : null\) : setEligBrush\(v\)\),/);
  assert.match(APP, /setValue: \(v\) => \(v === 'off' \? \(eligPaint === 'residential' \? setEligBrush\(null\) : null\) : setEligBrush\('residential'\)\),/);
});
