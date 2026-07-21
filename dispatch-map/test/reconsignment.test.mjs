// test/reconsignment.test.mjs
//
// Unit tests for the CONVERGENT reconsignment detector (lib/refresh-stops-core.mts).
// addrListSig() stamps a format-stable signature (5-digit ZIP + street number) from the
// saved-search LIST address; reconsignedByListSig() compares the current list signature to
// the one we stored last scan (list↔list, so it converges — the old list↔stored compare
// re-fired every scan and leaked a /stop/info per stop). Run with: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { addrListSig, reconsignedByListSig } from '../netlify/functions/lib/refresh-stops-core.mts';

test('addrListSig: ZIP5 + street number, format-stable', () => {
  assert.equal(addrListSig({ addr1: '2535 Royal Place', zip: '30084' }), '30084|2535');
  assert.equal(addrListSig({ addr1: '2535 ROYAL PL', zip: '30084-9999' }), '30084|2535'); // casing/suffix/ZIP+4 ignored
  assert.equal(addrListSig({ addr1: '', zip: '' }), '');                                   // no usable address → empty
  assert.equal(addrListSig({}), '');
  assert.equal(addrListSig(null), '');
});

test('reconsignedByListSig: a changed list signature (new ZIP or street #) is a reconsignment', () => {
  const prior = addrListSig({ addr1: '100 Peachtree St', zip: '30303' }); // '30303|100'
  assert.equal(reconsignedByListSig(prior, { addr1: '2535 Royal Place', zip: '30084' }), true);  // ZIP + number changed
  assert.equal(reconsignedByListSig(prior, { addr1: '500 Peachtree St', zip: '30303' }), true);  // street number changed
});

test('reconsignedByListSig: converges — the SAME list address never re-fires (no leak)', () => {
  const sig = addrListSig({ addr1: '80 Jesse Hill Jr Dr SE', zip: '30303' });
  // Same address, next scan → no change. This is the core fix: it must be false every time.
  assert.equal(reconsignedByListSig(sig, { addr1: '80 Jesse Hill Jr Dr SE', zip: '30303' }), false);
  // Even if the list reformats the street text, ZIP5 + number are unchanged → still false.
  assert.equal(reconsignedByListSig(sig, { addr1: '80 JESSE HILL JUNIOR DRIVE SOUTHEAST', zip: '30303-1234' }), false);
});

test('reconsignedByListSig: no stored baseline (first sighting) never triggers', () => {
  assert.equal(reconsignedByListSig(null, { addr1: '100 Main St', zip: '30303' }), false);
  assert.equal(reconsignedByListSig('', { addr1: '100 Main St', zip: '30303' }), false);
  assert.equal(reconsignedByListSig(undefined, { addr1: '100 Main St', zip: '30303' }), false);
});

test('reconsignedByListSig: an address-less list row this scan never triggers (keeps the baseline)', () => {
  const sig = addrListSig({ addr1: '100 Main St', zip: '30303' });
  assert.equal(reconsignedByListSig(sig, { addr1: '', zip: '' }), false);
  assert.equal(reconsignedByListSig(sig, {}), false);
});

test('reconsignedByListSig: partial signature still compares (street number only)', () => {
  const sig = addrListSig({ addr1: '100 Main St', zip: '' });   // '|100'
  assert.equal(sig, '|100');
  assert.equal(reconsignedByListSig(sig, { addr1: '200 Main St', zip: '' }), true);
  assert.equal(reconsignedByListSig(sig, { addr1: '100 Main St', zip: '' }), false);
});
