// test/consignee-address-type.test.mjs
//
// ── THE 2026-08-17 RE-ADDRESSING INCIDENT ────────────────────────────────────
//
// Brandi moved ESTES-1381710345 from 8/17 to 8/19. The date landed — and NuVizz
// also replaced the delivery address with 943 GAINESVILLE HIGHWAY, BUFORD,
// GEORGIA 30518: our own terminal. Same thing happened to ESTES-2251987281 three
// hours earlier. Freight addressed to our own yard does not reach the customer.
//
// The write journal settles who did it. `driftDetail(sent, readBack, …)` renders
// `sent → readBack`, and it recorded:
//     to.address.addr1: "4554 ANNISTWN ROAD CHURCH" → "943 GAINESVILLE HIGHWAY"
// We SENT the customer's real address. NuVizz STORED the terminal. So this was
// never our payload composing the wrong address, and never the "twin record"
// reporting artifact v0.54.72/73 concluded — the vendor resolved the address away.
//
// WHY IT WAS ALLOWED TO. Per NuVizz's own v7 spec (reference/nuvizz-openapi-v7.json):
//   addressType COM = "Company address"
//   "other than address type ANY, name will be chosen from address"
//   label = "other address fields like line1, line2, city, state, zip, country,
//            latitude and longitude will be populated from the corresponding
//            address of the label"
// We stamped the CONSIGNEE — the customer — as COM at creation. That tells NuVizz
// the delivery address belongs to the company's own address book, so on the next
// whole-stop write it is entitled to resolve it to the company's record. The
// drifted field set in the journal matches that spec sentence field for field.
//
// These tests pin the type on every path that creates an order, because the cost
// of getting it wrong is freight delivered to the wrong building.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStopPayload, addressIsResolvable, pinEchoAddress, ADDRESS_BOOK_TYPES,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';

const SETTINGS = {
  origin: { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' },
  serviceDate: '2026-08-19',
};
const CUSTOMER = { name: 'YEMI YIKEALO', addr1: '4554 ANNISTWN ROAD CHURCH', city: 'SNELLVILLE', state: 'GA', zip: '30039' };

test('THE FIX: the consignee is ANY — a literal address, not a company-book lookup', () => {
  const p = buildStopPayload(CUSTOMER, SETTINGS);
  assert.equal(p.to.address.addressType, 'ANY');
  assert.notEqual(p.to.address.addressType, 'COM', 'COM is what let NuVizz re-address two live orders');
  // ANY makes the name mandatory AND honoured — so the consignee name must ride along.
  assert.equal(p.to.address.name, 'YEMI YIKEALO');
  // The address itself is unchanged; only its TYPE was ever wrong.
  assert.equal(p.to.address.addr1, '4554 ANNISTWN ROAD CHURCH');
  assert.equal(p.to.address.city, 'SNELLVILLE');
  assert.equal(p.to.address.zip, '30039');
});

test('the PICKUP stays COM — that one really is the company address', () => {
  // The fix is about the consignee only. Our terminal legitimately IS a company
  // address, and letting NuVizz canonicalise its name is harmless.
  const p = buildStopPayload(CUSTOMER, SETTINGS);
  assert.equal(p.from.address.addressType, 'COM');
});

test('a consignee is never typed as a company address on ANY creation path', () => {
  // Guards the whole file rather than one function: if a new order-building path
  // is added and stamps a consignee COM, this fails.
  const p = buildStopPayload(CUSTOMER, SETTINGS);
  assert.equal(addressIsResolvable(p.to.address), false, 'the consignee must not be vendor-resolvable');
  assert.equal(addressIsResolvable(p.from.address), true, 'the pickup deliberately still is');
});

// ── the helpers that would fix ALREADY-CREATED orders ────────────────────────
// Every order created before this release still carries COM on its consignee, so
// any note / date / contact write can still re-address it. These two are the
// tested building blocks for that fix; wiring them needs one supervised write
// against one real order first (see the note on pinEchoAddress).

test('addressIsResolvable spots exactly what the vendor may overwrite', () => {
  for (const type of ADDRESS_BOOK_TYPES) {
    assert.equal(addressIsResolvable({ addressType: type, name: 'X', addr1: '1 Main' }), true, type);
  }
  // A label is a lookup key too, whatever the type says.
  assert.equal(addressIsResolvable({ addressType: 'ANY', label: 'DAVIS-HQ', name: 'X', addr1: '1' }), true);
  // Literal addresses are safe.
  assert.equal(addressIsResolvable({ addressType: 'ANY', name: 'X', addr1: '1 Main' }), false);
  assert.equal(addressIsResolvable({ addressType: 'any', name: 'X', addr1: '1 Main' }), false, 'case-insensitive');
  for (const junk of [null, undefined, 'nope', 42, []]) assert.equal(addressIsResolvable(junk), false);
});

test('pinEchoAddress turns a lookup key back into data', () => {
  const corrupted = {
    addressType: 'COM', label: 'DAVIS-HQ', name: 'YEMI YIKEALO',
    addr1: '4554 ANNISTWN ROAD CHURCH', city: 'SNELLVILLE', state: 'GA', zip: '30039', country: 'USA',
  };
  const pinned = pinEchoAddress(corrupted);
  assert.equal(pinned.addressType, 'ANY');
  assert.ok(!('label' in pinned), 'the label must go — it repopulates every other field');
  // Everything the order actually says is preserved, untouched.
  assert.equal(pinned.addr1, '4554 ANNISTWN ROAD CHURCH');
  assert.equal(pinned.city, 'SNELLVILLE');
  assert.equal(pinned.state, 'GA');
  assert.equal(pinned.zip, '30039');
  assert.equal(pinned.country, 'USA');
  assert.equal(addressIsResolvable(pinned), false, 'and it is no longer resolvable');
});

test('pinEchoAddress REFUSES rather than send something half-pinned', () => {
  // ANY makes name mandatory. Without a name — or without a street to stand on —
  // there is nothing to pin the address to, and sending it typed ANY would be a
  // guess. The caller must refuse the write instead; a blocked date change is a
  // far smaller problem than freight routed to the wrong building.
  assert.equal(pinEchoAddress({ addressType: 'COM', addr1: '1 Main' }), null, 'no name');
  assert.equal(pinEchoAddress({ addressType: 'COM', name: 'X' }), null, 'no street');
  assert.equal(pinEchoAddress({ addressType: 'COM', name: '   ', addr1: '  ' }), null, 'whitespace is not a value');
  for (const junk of [null, undefined, 'nope', 42, []]) assert.equal(pinEchoAddress(junk), null);
});

test('pinEchoAddress does not mutate the read it was given', () => {
  // The raw read is the before-image every data-loss check compares against.
  const raw = { addressType: 'COM', label: 'L', name: 'X', addr1: '1 Main' };
  pinEchoAddress(raw);
  assert.equal(raw.addressType, 'COM');
  assert.equal(raw.label, 'L');
});
