// THE LOAD'S OWN EQUIPMENT — fetched once, cached, and OFF until somebody says otherwise.
//
// Chad, 2026-09-02: "Loads should not be classed as tractor trailer or box truck only by the
// driver who ends up assigned to them." Enforcing that leaves the no-trailer rule silent unless
// something asks the LOAD what it is. These tests pin what that costs and what it refuses to
// pay for: a load with no stops is never fetched, a known type is never re-fetched, and with
// the switch off nothing is spent at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNbrsNeeded, loadRowsFromTypes, loadTypeFetchEnabled, MAX_LOAD_TYPE_FETCH } from '../netlify/functions/lib/load-types.mts';

const roster = [
  { loadId: 'a', name: 'BRENT',     loadNbr: 'DAVIS000203100', trips: 18 },
  { loadId: 'b', name: 'TRAILER 1', loadNbr: 'DAVIS000203101', trips: 15 },
  { loadId: 'c', name: 'EMPTY',     loadNbr: 'DAVIS000203102', trips: 0 },
];
const stops = [
  { loadNbr: 'BRENT', routeName: 'BRENT' },
  { loadNbr: 'TRAILER 1', routeName: 'TRAILER 1' },
];

test('only loads that actually CARRY stops are fetched — an empty load is silence nobody pays for', () => {
  assert.deepEqual(loadNbrsNeeded(roster, stops), ['DAVIS000203100', 'DAVIS000203101']);
});

test('a type already on file is never re-fetched — equipment is set at load creation, not per sweep', () => {
  assert.deepEqual(loadNbrsNeeded(roster, stops, { DAVIS000203100: 'TRACTOR TRAILER' }), ['DAVIS000203101']);
  assert.deepEqual(loadNbrsNeeded(roster, stops, { DAVIS000203100: 'x', DAVIS000203101: 'y' }), [], 'a warm board costs nothing');
});

test('a board that names its route by NUMBER rather than name still matches', () => {
  assert.deepEqual(loadNbrsNeeded(roster, [{ loadNbr: 'DAVIS000203102' }]), ['DAVIS000203102']);
});

test('fetched types become load rows the class builder reads, under the name the board uses', () => {
  const rows = loadRowsFromTypes(roster, { DAVIS000203100: 'TRACTOR TRAILER', DAVIS000203102: 'STRAIGHT TRUCK' });
  assert.deepEqual(rows, [
    { loadNbr: 'DAVIS000203100', routeName: 'BRENT', vehicleType: 'TRACTOR TRAILER' },
    { loadNbr: 'DAVIS000203102', routeName: 'EMPTY', vehicleType: 'STRAIGHT TRUCK' },
  ]);
  assert.deepEqual(loadRowsFromTypes(roster, {}), [], 'nothing known, nothing claimed');
});

test('the switch is OFF unless explicitly turned on — a typo never starts spending', () => {
  assert.equal(loadTypeFetchEnabled({}), false);
  assert.equal(loadTypeFetchEnabled({ NUVIZZ_LOAD_TYPE_FETCH: 'on' }), true);
  assert.equal(loadTypeFetchEnabled({ NUVIZZ_LOAD_TYPE_FETCH: 'true' }), true);
  assert.equal(loadTypeFetchEnabled({ NUVIZZ_LOAD_TYPE_FETCH: 'yes please' }), false, 'unrecognised = off, the safe direction for a metered call');
  assert.equal(loadTypeFetchEnabled({ NUVIZZ_LOAD_TYPE_FETCH: 'off' }), false);
});

test('the per-pass ceiling sits above a real board but bounds a runaway feed', () => {
  assert.ok(MAX_LOAD_TYPE_FETCH >= 100 && MAX_LOAD_TYPE_FETCH <= 200, `a board is ~63 loads; cap is ${MAX_LOAD_TYPE_FETCH}`);
});

test('a malformed roster cannot produce a fetch — no number, no call', () => {
  assert.deepEqual(loadNbrsNeeded([{ name: 'BRENT' }, { loadNbr: '' }, null], stops), []);
  assert.deepEqual(loadNbrsNeeded(null, null), []);
});
