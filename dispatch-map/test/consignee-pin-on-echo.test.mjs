// test/consignee-pin-on-echo.test.mjs
//
// ── THE 2026-08-18 RE-ADDRESSING, WHICH WAS THE SECOND ONE ──────────────────
//
// On 2026-08-17 two orders had their delivery addresses replaced with our own
// terminal after a date change. The diagnosis was correct and the fix — stamping
// the consignee addressType ANY — went onto the CREATION paths. The repair for
// orders that ALREADY existed, pinEchoAddress, was written, tested, exported,
// and then deliberately left UNWIRED, on the reasoning that changing a value we
// did not read breaks this module's "invent nothing" rule and deserved one
// supervised write first.
//
// It happened again the next day, and that reasoning is what allowed it.
// ESTES-2958929164, RENE M CONNELL, after nothing but a phone-number NOTE:
//
//     to.address.addr1: "1977 BEN HIGGINS RD" -> "943 GAINESVILLE HIGHWAY"
//     to.address.city:  "DAHLONEGA"           -> "BUFORD"
//     to.address.zip:   "30533"               -> "30518"
//     to.address.name:  "RENE M CONNELL"      -> "DAVIS DELIVERY"
//
// The order came off an ESTES import, so the creation-path fix never touched it.
// Every imported order, and every order older than v0.54.75, was in the same
// state: a company-book lookup key waiting for the next note.
//
// These tests pin the wiring, because the cost of it being unwired is now known
// twice over and measured in freight delivered to the wrong building.
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

test('THE INCIDENT: the echoed consignee goes out as literal data, not a lookup key', () => {
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

test('a NOTE write — the exact operation that did the damage — carries the pinned address', () => {
  const body = buildNoteWriteStop(READ, [{ comments: 'UPDATED PHONE # 706-555-0100' }]);
  assert.equal(body.to.address.addressType, 'ANY');
  assert.equal(body.to.address.addr1, '1977 BEN HIGGINS RD');
  assert.equal(body.comments.length, 1, 'and the note still lands');
});

test('a DATE write goes through the same choke point', () => {
  // buildPartialUpdateStop is where every note, date and contact write converges,
  // which is why the pin lives there and not in one caller.
  const body = buildPartialUpdateStop(READ, { to: { ...READ.to, scheduledFrom: '2026-07-28T09:00' } });
  assert.equal(body.to.address.addressType, 'ANY');
  assert.equal(body.to.scheduledFrom, '2026-07-28T09:00');
});

test('a label is a lookup key too, and it must not survive the write', () => {
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
