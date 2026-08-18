// test/stop-address-write.test.mjs
//
// CORRECTING A DELIVERY ADDRESS IN NUVIZZ — the thing this app could never do.
//
// "Edit address" on the stop card writes customer_notes.address_override: OUR
// Firestore, for OUR pin and OUR routing. NuVizz never heard about it. So a card
// could read "ADDRESS corrected · 800 N COMMERCE ST" over the right street while
// the order the driver's manifest and the carrier work from still carried the
// wrong one — and nothing anywhere said the two disagreed.
//
// nuVizz v7 has no "update stop address" endpoint; the address lives on the stop,
// so this rides /stop/partialUpdate like notes and dates. The spec lines that
// shape the payload, verbatim from the Address schema:
//
//   name    "Name is mandatory for addressType ANY. Other than address type ANY,
//            name will be chosen from address."
//   label   "Label is mandatory for addressType other than COM and ANY."
//           "With valid given label, other address fields like line1, line2, city,
//            state, zip, country, latitude and longitude will be POPULATED FROM
//            THE CORRESPONDING ADDRESS OF THE LABEL."
//
// A label is therefore not data — it is a lookup key that throws away everything
// typed. These tests pin that it never goes out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiteralAddress, buildStopAddressOverride, addressLanded, primarySideKey,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';

const DELIVERY = {
  stopId: 'abc123', stopNbr: 'ESTES-1', stopType: 'DO',
  to: { address: { addressType: 'CUS', label: 'CUST-BOOK-42', name: 'MR.LARRY WOELFL',
                   addr1: '1 WRONG ST', city: 'BUFORD', state: 'GEORGIA', zip: '30518',
                   country: 'USA', latitude: 34.1, longitude: -84.0, fullAddress: '1 WRONG ST, BUFORD, GEORGIA 30518', id: 'addr_9' },
        contact: { name: 'MR.LARRY WOELFL', phone: '4043167378' } },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
};
const FIX = { name: 'MR.LARRY WOELFL', addr1: '800 N COMMERCE ST', city: 'MONROE', state: 'GA', zip: '30655' };

test('THE PAYLOAD: a correction goes out as a literal ANY address', () => {
  const a = buildLiteralAddress(DELIVERY.to.address, FIX);
  assert.equal(a.addressType, 'ANY', 'ANY is the one type meaning "these fields ARE the address"');
  assert.equal(a.name, 'MR.LARRY WOELFL', 'and ANY makes the name mandatory');
  assert.equal(a.addr1, '800 N COMMERCE ST');
  assert.equal(a.city, 'MONROE');
  assert.equal(a.zip, '30655');
});

test('THE LABEL NEVER GOES OUT — it would refill every field from the address book', () => {
  const a = buildLiteralAddress(DELIVERY.to.address, FIX);
  assert.ok(!('label' in a), 'a label is a lookup key, not data');
});

test('the OLD pin and fullAddress are dropped, not carried onto a new street', () => {
  // Sending yesterday's latitude beside today's street asserts a pin in the wrong
  // place, and a stale fullAddress silently disagrees with the corrected addr1.
  const a = buildLiteralAddress(DELIVERY.to.address, FIX);
  for (const k of ['latitude', 'longitude', 'fullAddress', 'id']) {
    assert.ok(!(k in a), `${k} must not survive an address change`);
  }
});

test('a caller that HAS geocoded the new address may send the pin with it', () => {
  const a = buildLiteralAddress(DELIVERY.to.address, { ...FIX, latitude: 33.79, longitude: -83.71 });
  assert.equal(a.latitude, 33.79);
  assert.equal(a.longitude, -83.71);
});

test('addr2 clears on an explicit empty string, and is left alone when absent', () => {
  const withSuite = { ...DELIVERY.to.address, addr2: 'APT999' };
  assert.equal(buildLiteralAddress(withSuite, FIX).addr2, 'APT999', 'absent = keep');
  assert.ok(!('addr2' in buildLiteralAddress(withSuite, { ...FIX, addr2: '' })), 'empty = clear');
  assert.equal(buildLiteralAddress(withSuite, { ...FIX, addr2: 'STE 5' }).addr2, 'STE 5');
});

test('it REFUSES rather than send an address NuVizz would fill in for us', () => {
  // No name under ANY means the vendor "chooses the name from address" — its own
  // book. That is the whole failure mode this type exists to avoid.
  assert.throws(() => buildLiteralAddress({}, { addr1: '800 N COMMERCE ST' }), /name is required/i);
  assert.throws(() => buildLiteralAddress({}, { name: 'X' }), /street line/i);
});

test('a DELIVERY corrects the TO side; a PICKUP corrects the FROM side', () => {
  const d = buildStopAddressOverride(DELIVERY, FIX);
  assert.equal(d.side, 'to');
  assert.equal(d.block.address.addr1, '800 N COMMERCE ST');
  assert.deepEqual(d.block.contact, DELIVERY.to.contact, 'and nothing else on that block moves');

  const pickup = { ...DELIVERY, stopType: 'PU' };
  assert.equal(primarySideKey(pickup), 'from');
  assert.equal(buildStopAddressOverride(pickup, FIX).side, 'from');
});

test('the override does not mutate the read it was given', () => {
  const raw = JSON.parse(JSON.stringify(DELIVERY));
  buildStopAddressOverride(raw, FIX);
  assert.equal(raw.to.address.addr1, '1 WRONG ST');
  assert.equal(raw.to.address.label, 'CUST-BOOK-42');
});

// ── DID IT LAND ─────────────────────────────────────────────────────────────
// NuVizz rewrites what it stores: it expands "GA" to "GEORGIA" and "RD" to
// "ROAD" on its own — both observed live on 2026-08-18. Byte equality would
// report every successful correction as a failure, which is how a real alarm
// gets ignored.

test('vendor normalisation still counts as landed', () => {
  assert.equal(addressLanded(
    { name: 'MR.LARRY WOELFL', addr1: '800 N COMMERCE STREET', city: 'MONROE', state: 'GEORGIA', zip: '30655-1234' },
    FIX), true, 'expanded street type, spelled-out state and ZIP+4 are all the same address');
});

test('a DIFFERENT address is not landed — this is the check that matters', () => {
  assert.equal(addressLanded({ name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' }, FIX), false);
  assert.equal(addressLanded({ ...FIX, addr1: '801 N COMMERCE ST' }, FIX), false, 'a different house number is a different building');
  assert.equal(addressLanded({ ...FIX, zip: '30518' }, FIX), false, 'a different zip is a different town');
  assert.equal(addressLanded(null, FIX), false);
  assert.equal(addressLanded({}, FIX), false);
});
