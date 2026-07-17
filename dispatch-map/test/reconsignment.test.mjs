// test/reconsignment.test.mjs
//
// Unit tests for listAddressChanged (lib/refresh-stops-core.mts) — the reconsignment
// detector that lets the board catch a delivery-address change. It compares only the
// format-stable parts (5-digit ZIP + street number) so ordinary formatting drift can
// never trigger a spurious (call-costing) re-enrich, while a real move is always caught.
// Run with: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { listAddressChanged } from '../netlify/functions/lib/refresh-stops-core.mts';

test('listAddressChanged: a new ZIP is a reconsignment', () => {
  assert.equal(
    listAddressChanged({ addr1: '2535 Royal Place', city: 'Tucker', zip: '30084' },
                       { addr1: '100 Peachtree St', city: 'Atlanta', zip: '30303' }),
    true,
  );
});

test('listAddressChanged: a new street number (same ZIP) is a reconsignment', () => {
  assert.equal(
    listAddressChanged({ addr1: '814 Livingston Court', city: 'Marietta', zip: '30067' },
                       { addr1: '500 Livingston Court', city: 'Marietta', zip: '30067' }),
    true,
  );
});

test('listAddressChanged: pure formatting drift (St vs Street, casing) is NOT a change', () => {
  assert.equal(
    listAddressChanged({ addr1: '100 Peachtree Street', city: 'ATLANTA', zip: '30303' },
                       { addr1: '100 Peachtree St', city: 'Atlanta', zip: '30303-1234' }),
    false, // same 5-digit ZIP + same house number → no spurious re-enrich
  );
});

test('listAddressChanged: ZIP+4 on one side compares on the first 5 digits only', () => {
  assert.equal(
    listAddressChanged({ addr1: '1 A St', zip: '30084-9999' }, { addr1: '1 A St', zip: '30084' }),
    false,
  );
});

test('listAddressChanged: when the list carried no usable address, never a change (can\'t tell)', () => {
  assert.equal(listAddressChanged({ addr1: '', zip: '' }, { addr1: '100 Main St', zip: '30303' }), false);
  assert.equal(listAddressChanged({}, { addr1: '100 Main St', zip: '30303' }), false);
});

test('listAddressChanged: missing prior parts do not false-positive', () => {
  // Prior has no ZIP and no parseable street number → the guarded comparisons are skipped.
  assert.equal(listAddressChanged({ addr1: '100 Main St', zip: '30303' }, { addr1: 'Suite C', zip: '' }), false);
});

test('listAddressChanged: identical address → no change', () => {
  const a = { addr1: '2535 Royal Place', city: 'Tucker', zip: '30084' };
  assert.equal(listAddressChanged({ ...a }, { ...a }), false);
});

test('listAddressChanged: null/undefined inputs are safe', () => {
  assert.equal(listAddressChanged(null, { addr1: '1 A', zip: '30303' }), false);
  assert.equal(listAddressChanged({ addr1: '1 A', zip: '30303' }, null), false);
});
