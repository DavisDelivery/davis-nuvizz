// test/plan-ahead.test.mjs — WHICH SHELLS THE SCREEN OFFERS, GIVEN WHAT IT ALREADY SHOWS.
//
// The endpoint sends the standard route names for a day NuVizz has not created; the screen
// subtracts what it already has — roster rows, board groups, open route cards — so a shell is
// only ever offered for a name that would otherwise have nowhere to be planned onto.
import test from 'node:test';
import assert from 'node:assert/strict';

import { planAheadNames, shellRowKey, SHELL_ROW_PREFIX } from '../src/lib/plan-ahead.js';

const SHELLS = { names: ['ATL', 'DIXON', 'SUW 2', 'SUW 3'], from: ['2026-09-04', '2026-09-03', '2026-09-02'] };

test("Chad's Sunday on Tue Sep 8: an empty roster and an empty board offer every standard shell, in the endpoint's order", () => {
  assert.deepEqual(planAheadNames({ shells: SHELLS }), ['ATL', 'DIXON', 'SUW 2', 'SUW 3']);
});

test('a name the ROSTER already holds is a real load, not a shell', () => {
  assert.deepEqual(planAheadNames({ shells: SHELLS, rosterLoads: [{ name: 'suw 2' }] }), ['ATL', 'DIXON', 'SUW 3']);
});

test('a name already on the BOARD (a route group built out of stops) is not offered twice', () => {
  assert.deepEqual(planAheadNames({ shells: SHELLS, boardNames: ['DIXON', ' atl '] }), ['SUW 2', 'SUW 3']);
});

test('a name with an open route CARD is not offered — tapping it again must not open a second card', () => {
  assert.deepEqual(planAheadNames({ shells: SHELLS, pendingNames: ['SUW 3'] }), ['ATL', 'DIXON', 'SUW 2']);
});

test('after he has built onto all of them there is nothing left to offer', () => {
  assert.deepEqual(planAheadNames({ shells: SHELLS, rosterLoads: [{ name: 'ATL' }, { name: 'DIXON' }], boardNames: ['SUW 2'], pendingNames: ['SUW 3'] }), []);
});

test('no shells from the endpoint → nothing, never null', () => {
  assert.deepEqual(planAheadNames({}), []);
  assert.deepEqual(planAheadNames({ shells: null }), []);
  assert.deepEqual(planAheadNames({ shells: { names: [] } }), []);
  assert.deepEqual(planAheadNames({ shells: { names: 'ATL' } }), [], 'a malformed names field is not a list');
  assert.deepEqual(planAheadNames(), []);
});

test('blank and duplicate names in the list are dropped; the first spelling wins', () => {
  assert.deepEqual(planAheadNames({ shells: { names: ['SUW 2', '', null, 'suw 2', ' ATL'] } }), ['SUW 2', 'ATL']);
});

test('garbage in the subtraction lists never throws', () => {
  assert.deepEqual(planAheadNames({ shells: SHELLS, rosterLoads: [null, {}, { name: 5 }], boardNames: [undefined, 7], pendingNames: null }), ['ATL', 'DIXON', 'SUW 2', 'SUW 3']);
});

test('a shell row key can never collide with a NuVizz load number', () => {
  assert.equal(shellRowKey('SUW 2'), `${SHELL_ROW_PREFIX}SUW 2`);
  assert.ok(!/^[A-Za-z]{2,}\d{5,}$/.test(shellRowKey('DAVIS000200601')), 'even a number-shaped name gets the prefix');
});

test('a name longer than NuVizz\'s route-name cap is never offered — Save would refuse it on every tap', () => {
  assert.deepEqual(planAheadNames({ shells: { names: ['BRETT SPRADLEY TRAILER', 'SUW 2', 'ABCDEFGHIJKLMNOPQRST'] } }), ['SUW 2', 'ABCDEFGHIJKLMNOPQRST']);
});
