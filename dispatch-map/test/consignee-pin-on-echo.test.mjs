// test/consignee-pin-on-echo.test.mjs
//
// ── THE RE-ADDRESSING THAT WAS NOT ──────────────────────────────────────────
//
// Three write banners across two days reported that a note or date change had
// replaced an order's delivery address with our own terminal. The drift report
// renders `sent -> readBack` and read:
//
//     to.address.addr1: "800 N COMMERCE ST" -> "943 GAINESVILLE HIGHWAY"
//     to.address.name:  "MR.LARRY WOELFL"   -> "DAVIS DELIVERY"
//
// That was taken as proof the vendor was overwriting stored addresses, and
// pinEchoedConsignee was wired into every partialUpdate write to stop it.
//
// THEN THE PORTAL WAS CHECKED. NuVizz's own Stop Details for that order:
//     Ship From: DAVIS DELIVERY SERVICE - 943 Gainesville Highway, Buford, GA
//     Ship To:   MR.LARRY WOELFL       - 800 N Commerce St, Monroe, GA 30655
// The delivery address is CORRECT and always was. The values the banner called
// "stored" are the SHIP FROM block — the pickup origin, legitimately ours.
//
// So these tests now pin two things at once:
//   1. the write path echoes the consignee VERBATIM (the pin is NOT wired), and
//   2. the pure helper still behaves correctly if it is ever genuinely needed.
//
// Do not re-wire it without portal evidence that a stored Ship To actually
// changed. `sent -> readBack` is not that evidence: readBack is only ever
// whatever the read-back comparison picked up, which is the actual defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pinEchoedConsignee, buildNoteWriteStop, buildPartialUpdateStop,
  addressIsResolvable,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';

// The order from the incident, as the read would have handed it back.
const READ = {
  stopId: 'abc', stopNbr: 'ESTES-2958929164',
  to: {
    address: {
      addressType: 'COM', name: 'RENE M CONNELL', addr1: '1977 BEN HIGGINS RD',
      city: 'DAHLONEGA', state: 'GA', zip: '30533', country: 'USA',
    },
    contact: { name: 'RENE M CONNELL', phone: '706-555-0100' },
  },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY SERVICE', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GA', zip: '30518' } },
  comments: [],
};

test('the PURE helper still pins correctly, for the day it is genuinely needed', () => {
  const out = pinEchoedConsignee(READ);
  assert.equal(out.to.address.addressType, 'ANY', 'ANY is the one type that means "these fields ARE the address"');
  assert.equal(addressIsResolvable(out.to.address), false, 'and NuVizz may no longer resolve it away');
  // Every real value is preserved EXACTLY. This is the whole claim: we are not
  // inventing an address, we are refusing to send a key instead of one.
  assert.equal(out.to.address.addr1, '1977 BEN HIGGINS RD');
  assert.equal(out.to.address.city, 'DAHLONEGA');
  assert.equal(out.to.address.state, 'GA');
  assert.equal(out.to.address.zip, '30533');
  assert.equal(out.to.address.name, 'RENE M CONNELL');
  assert.equal(out.to.address.country, 'USA');
});

test('THE WRITE PATH IS UNCHANGED: a note echoes the consignee VERBATIM', () => {
  // The pin is NOT wired. This module's standing rule — invent nothing the read
  // did not provide — holds, because the thing it was bent for never happened.
  const body = buildNoteWriteStop(READ, [{ comments: 'UPDATED PHONE # 706-555-0100' }]);
  assert.equal(body.to.address.addressType, 'COM', 'exactly what the read gave us');
  assert.ok(!('label' in body.to.address) || body.to.address.label === READ.to.address.label);
  assert.equal(body.to.address.addr1, '1977 BEN HIGGINS RD');
  assert.equal(body.comments.length, 1, 'and the note still lands');
});

test('a DATE write echoes verbatim too — the choke point pins nothing', () => {
  const body = buildPartialUpdateStop(READ, { to: { ...READ.to, scheduledFrom: '2026-07-28T09:00' } });
  assert.equal(body.to.address.addressType, 'COM');
  assert.equal(body.to.scheduledFrom, '2026-07-28T09:00');
});

test('the helper drops a label, which is a lookup key of its own', () => {
  const withLabel = { ...READ, to: { ...READ.to, address: { ...READ.to.address, addressType: 'ANY', label: 'DAVIS-HQ' } } };
  const out = pinEchoedConsignee(withLabel);
  assert.ok(!('label' in out.to.address), 'label repopulates every other field from the book entry');
  assert.equal(out.to.address.addr1, '1977 BEN HIGGINS RD');
});

test('THE PICKUP IS LEFT ALONE — our terminal really is the company address', () => {
  const out = pinEchoedConsignee(READ);
  assert.equal(out.from.address.addressType, 'COM', 'resolving this one is correct, not a bug');
  assert.deepEqual(out.from.address, READ.from.address);
});

test('an ALREADY-LITERAL consignee is untouched — the common case must be a no-op', () => {
  // Orders created after v0.54.75 are already ANY. Narrowing the pin to resolvable
  // addresses keeps the blast radius to exactly the orders actually in danger.
  const safe = { ...READ, to: { ...READ.to, address: { ...READ.to.address, addressType: 'ANY' } } };
  const out = pinEchoedConsignee(safe);
  assert.equal(out, safe, 'same object back — nothing rewritten at all');
});

test('it REFUSES rather than send a half-pinned address', () => {
  // ANY makes name mandatory. Without a name there is nothing to pin the address
  // to, and sending the block resolvable is how this incident happens. A refused
  // note is a far smaller problem than freight routed to the wrong building.
  const nameless = { ...READ, to: { ...READ.to, address: { addressType: 'COM', addr1: '1 MAIN ST' } } };
  assert.throws(() => pinEchoedConsignee(nameless), /delivery address/i);
  const streetless = { ...READ, to: { ...READ.to, address: { addressType: 'COM', name: 'X' } } };
  assert.throws(() => pinEchoedConsignee(streetless), /pinned|delivery address/i);
});

test('it does not mutate the read it was given', () => {
  const raw = JSON.parse(JSON.stringify(READ));
  pinEchoedConsignee(raw);
  assert.equal(raw.to.address.addressType, 'COM', 'the before-image every drift check compares against stays intact');
});

test('a stop with no consignee block at all is passed straight through', () => {
  for (const junk of [{}, { to: null }, { to: {} }, { to: { address: null } }, { to: { address: 'nope' } }]) {
    assert.doesNotThrow(() => pinEchoedConsignee(junk));
  }
});
