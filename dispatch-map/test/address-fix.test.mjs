import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressLooksOff, suggestAddressFix } from '../src/lib/address-fix.js';

// Real NuVizz fields pulled live for the three reported stops.
const EQUIPMENTSHARE = { addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD', city: 'DOUGLASVILLE', state: 'GA', zip: '30134' };
const NCR = { addr1: 'PROPERTY MANAGER', addr2: '2611 SPRINGDALE RD SW', city: 'ATLANTA', state: 'GA', zip: '30315' };
const DOORWORX = { addr1: 'STE B GATE 15 16', addr2: '4326 AVERY DR', city: 'FLOWERY BRANCH', state: 'GA', zip: '30542' };

test('flags the three real mis-split stops', () => {
  assert.equal(addressLooksOff(EQUIPMENTSHARE, null), true);
  assert.equal(addressLooksOff(NCR, null), true);
  assert.equal(addressLooksOff(DOORWORX, null), true);
});

test('suggests the correct swap (unit token leads addr1, street in addr2)', () => {
  assert.deepEqual(suggestAddressFix(EQUIPMENTSHARE), { addr1: '4310 INDUSTRIAL ACCESS RD', addr2: 'BLDG 200', reason: 'street was in addr2 (swapped)' });
  assert.deepEqual(suggestAddressFix(DOORWORX), { addr1: '4326 AVERY DR', addr2: 'STE B GATE 15 16', reason: 'street was in addr2 (swapped)' });
});

test('suggests the correct swap (contact name in addr1, street in addr2)', () => {
  assert.deepEqual(suggestAddressFix(NCR), { addr1: '2611 SPRINGDALE RD SW', addr2: 'PROPERTY MANAGER', reason: 'street was in addr2 (swapped)' });
});

test('splits a unit+street packed into a single addr1 line', () => {
  const packed = { addr1: 'BLDG 200 4310 INDUSTRIAL ACCESS RD', addr2: '' };
  assert.equal(addressLooksOff(packed, null), true);
  assert.deepEqual(suggestAddressFix(packed), { addr1: '4310 INDUSTRIAL ACCESS RD', addr2: 'BLDG 200', reason: 'suite was in front of the street' });
});

test('the geocode query built from a fix uses the corrected street', () => {
  const fix = suggestAddressFix(EQUIPMENTSHARE);
  const q = [fix.addr1, EQUIPMENTSHARE.city, EQUIPMENTSHARE.state, EQUIPMENTSHARE.zip].filter(Boolean).join(', ');
  assert.equal(q, '4310 INDUSTRIAL ACCESS RD, DOUGLASVILLE, GA, 30134');
});

test('does NOT flag clean addresses', () => {
  assert.equal(addressLooksOff({ addr1: '2611 SPRINGDALE RD SW', addr2: 'PROPERTY MANAGER' }, null), false);
  assert.equal(addressLooksOff({ addr1: '123 Main St', addr2: 'Suite 5' }, null), false);
  assert.equal(addressLooksOff({ addr1: '123 Main St', addr2: '' }, null), false);
  assert.equal(suggestAddressFix({ addr1: '123 Main St', addr2: 'Suite 5' }), null);
});

test('never flags an already-corrected stop (has address_override)', () => {
  assert.equal(addressLooksOff(EQUIPMENTSHARE, { address_override: { addr1: '4310 INDUSTRIAL ACCESS RD' } }), false);
});

test('empty addr1 is left alone (different problem)', () => {
  assert.equal(addressLooksOff({ addr1: '', addr2: '123 Main St' }, null), false);
});
