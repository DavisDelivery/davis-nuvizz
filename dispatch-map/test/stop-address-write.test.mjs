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

// ── THE HOLE AN ADVERSARIAL REVIEW FOUND, BEFORE THIS SHIPPED ───────────────
//
// The first draft verified a correction with addressLanded ALONE — and handed it
// the MERGED block (typed fields spread over the ones that were read). So on a
// partial correction the three fields it checked (house number, zip, name) were
// precisely the three the caller had NOT changed, and they verified themselves
// against the pre-write record. A write NuVizz accepted and ignored came back
// ok:true with "Order X is now addressed to <what we typed>".
//
// That is worse than not having the feature. Today a dispatcher knows NuVizz may
// be wrong; that version would have told them it was right.
//
// The regression test that was supposed to catch this passed only because its
// fixture moved BOTH the house number and the zip — the one shape addressLanded
// happens to cover. These cases are the shapes it did not.
import {
  addressMatchesTyped, addressMoved,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';

const STORED = { addressType: 'ANY', name: 'ACME TILE', addr1: '100 MAIN ST', city: 'BUFORD', state: 'GEORGIA', zip: '30518' };

/** The exact expression runSetStopAddress evaluates. */
function verdict(wasAddr, readAddr, typed) {
  const merged = buildLiteralAddress(wasAddr, typed);
  const alreadyRight = addressMatchesTyped(wasAddr, typed);
  return addressLanded(readAddr, merged)
    && addressMatchesTyped(readAddr, typed)
    && (alreadyRight || addressMoved(wasAddr, readAddr));
}

const SHAPES = [
  ['a city-only correction', { city: 'SUGAR HILL' }],
  ['a suite-only correction', { addr2: 'STE 400' }],
  ['a street name on the same house number', { addr1: '100 OAK ST' }],
  ['a directional prefix', { addr1: '100 N MAIN ST' }],
  ['a state-only correction', { state: 'SC' }],
  ['a PO box renumber (no street number at all)', { addr1: 'PO BOX 2299' }],
];

for (const [label, typed] of SHAPES) {
  test(`ACCEPTED-AND-IGNORED is caught for ${label}`, () => {
    // NuVizz answers 200 and stores nothing: the read-back is the pre-write record.
    assert.equal(verdict(STORED, STORED, typed), false,
      'reporting this as saved would tell a dispatcher an address is fixed when it is not');
  });

  test(`a real save still passes for ${label}, in the vendor's own spelling`, () => {
    const merged = buildLiteralAddress(STORED, typed);
    const stored = { ...merged,
      state: merged.state === 'SC' ? 'SOUTH CAROLINA' : 'GEORGIA',   // NuVizz expands codes
      addr1: String(merged.addr1).replace(/\bST$/, 'STREET').replace(/\bN\b/, 'NORTH'),
      zip: `${merged.zip}-1234` };                                    // and returns ZIP+4
    assert.equal(verdict(STORED, stored, typed), true,
      'a check that fails every good write is the cry-wolf failure this module already paid for');
  });
}

test('"SC" → "SOUTH CAROLINA" passes — one token becoming two', () => {
  // GA → GEORGIA is 1→1 and passed a naive token compare; SC → SOUTH CAROLINA is
  // 1→2 and did not. A state-only correction would have failed forever.
  assert.equal(addressMatchesTyped({ ...STORED, state: 'SOUTH CAROLINA' }, { state: 'SC' }), true);
  assert.equal(addressMatchesTyped({ ...STORED, state: 'GEORGIA' }, { state: 'GA' }), true);
  assert.equal(addressMatchesTyped({ ...STORED, state: 'GEORGIA' }, { state: 'SC' }), false);
});

test('a field the caller never typed cannot vote that the write landed', () => {
  // The root cause: verifying against the merged block let inherited fields agree
  // with themselves. addressMatchesTyped is always checked against what was TYPED.
  assert.equal(addressMatchesTyped(STORED, { city: 'SUGAR HILL' }), false, 'the city did not change');
  assert.equal(addressMatchesTyped(STORED, {}), true, 'nothing typed, nothing to disprove');
});

test('an explicitly CLEARED field must read back empty', () => {
  const withSuite = { ...STORED, addr2: 'APT999' };
  assert.equal(addressMatchesTyped(withSuite, { addr2: '' }), false, 'the suite is still there');
  assert.equal(addressMatchesTyped(STORED, { addr2: '' }), true, 'and gone means gone');
});

test('addressMoved compares two vendor reads, so vendor spelling cancels out', () => {
  // Both sides come from NuVizz, so this layer cannot false-fail on normalisation.
  assert.equal(addressMoved(STORED, STORED), false);
  assert.equal(addressMoved(STORED, { ...STORED, city: 'SUGAR HILL' }), true);
  assert.equal(addressMoved(STORED, { ...STORED, addr2: 'STE 400' }), true, 'a suite is a move');
});

test('re-saving an address that is ALREADY right is not reported as a failure', () => {
  // Nothing moves, and nothing should — the correction was a no-op on purpose.
  assert.equal(verdict(STORED, STORED, { city: 'BUFORD' }), true);
});
