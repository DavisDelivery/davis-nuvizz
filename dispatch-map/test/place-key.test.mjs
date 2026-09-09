// test/place-key.test.mjs — "is this the same dock?" must not be answered by the customer's name.
//
// THE ORDER THIS EXISTS FOR. Chad, 2026-09-09: "i pulled all these stops in a grab but there
// was a pick up and delivery going to same place — it did not grab the delivery on the initial
// pull, so when i assigned the orders to the route the delivery was left unplanned on the map."
//
// Both orders, read from the live board that morning:
//   delivery 007173389  "FEDEX OFFICE 10043FK04301103"  3190 REPS MILLER RD STE 200  NORCROSS   30071
//   pickup   RA59223377 "FEDEX OFFICE"                  3190 REPS MILLER RD STE 200  NIORCROSS  30071
// Same building. Pins 6.5 metres apart. The app already had a guard for exactly this case
// (the same-address twin guard, v0.45.2) and it did not fire, because "same place" was keyed
// on normalizeMatchKey — which begins with the business name. Two independent mismatches on
// one dock: NuVizz puts the FedEx reference inside the delivery's NAME, and the pickup's CITY
// is misspelled in the vendor's own data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMatchKey, normalizePlaceKey } from '../src/lib/matchKey.js';

// Verbatim from nuvizz_stop_index/davis__2026-09-09.
const DELIVERY = { name: 'FEDEX OFFICE 10043FK04301103', addr1: '3190 REPS MILLER RD STE 200', city: 'NORCROSS', zip: '30071' };
const PICKUP   = { name: 'FEDEX OFFICE',                 addr1: '3190 REPS MILLER RD STE 200', city: 'NIORCROSS', zip: '30071' };
const place = (s) => normalizePlaceKey(s.addr1, s.zip);

test('THE LOST DELIVERY: the pickup and the delivery are one place', () => {
  assert.equal(place(DELIVERY), place(PICKUP), 'the twin guard cannot fire unless these match');
});

test('...and the key that used to answer that question still says they are not', () => {
  // Pinned so nobody "simplifies" the guard back onto matchKey. This is the actual bug.
  const mk = (s) => normalizeMatchKey(s.name, s.addr1, s.city, s.zip);
  assert.notEqual(mk(DELIVERY), mk(PICKUP));
});

test('each of the two mismatches alone is enough to break a name-based key', () => {
  const mk = (s) => normalizeMatchKey(s.name, s.addr1, s.city, s.zip);
  assert.notEqual(mk(DELIVERY), mk({ ...DELIVERY, name: 'FEDEX OFFICE' }), 'the order reference inside the name');
  assert.notEqual(mk(PICKUP), mk({ ...PICKUP, city: 'NORCROSS' }), "the vendor's misspelled city");
  // The place key is immune to both, which is the whole point.
  assert.equal(place(DELIVERY), place({ ...DELIVERY, name: 'ANYTHING AT ALL', city: 'NIORCROSS' }));
});

test('a different suite in the same building is a DIFFERENT place', () => {
  // Freight sense: STE 200 and STE 400 are two stops and a driver walks between them. Grouping
  // them would ride an order onto a truck the dispatcher never picked.
  assert.notEqual(place(DELIVERY), place({ ...DELIVERY, addr1: '3190 REPS MILLER RD STE 400' }));
});

test('a different zip on the same street name is a different place', () => {
  assert.notEqual(place(DELIVERY), place({ ...DELIVERY, zip: '30093' }));
});

test('the same dock written two ways still keys the same', () => {
  // The street normaliser is shared with matchKey, so the abbreviations it already folds
  // (Suite/Ste, Road/Rd) keep working here.
  assert.equal(normalizePlaceKey('3190 Reps Miller Road, Suite 200', '30071-1234'), place(DELIVERY));
});

test('not enough to identify a place returns EMPTY, never a shared bucket', () => {
  // A blank key that grouped would put every address-less order at one imaginary dock and
  // ride them all onto the first route touched — far worse than the bug being fixed.
  for (const [a, z] of [['', '30071'], ['3190 REPS MILLER RD', ''], [null, null], [undefined, '30071'], ['   ', '30071']]) {
    assert.equal(normalizePlaceKey(a, z), '', `("${a}","${z}") produced a groupable key`);
  }
});

test('normalizeMatchKey itself is unchanged — customer notes join on it', () => {
  assert.equal(normalizeMatchKey('ACME LLC', '100 Peachtree St', 'Atlanta', '30301'), 'acme___100_peachtree_st__atlanta__30301');
  assert.equal(normalizeMatchKey('Acme, Inc.', '100 PEACHTREE STREET', 'ATLANTA', '30301-9999'),
    normalizeMatchKey('ACME LLC', '100 Peachtree St', 'Atlanta', '30301'));
});

// ── END TO END: the guard, the two real orders, and the grab that lost one ─────────────
//
// The tests above pin the KEY. This one pins the PAYOFF: feed the actual guard the actual
// records and check that grabbing the pickup now brings the delivery, loudly. Keyed the old
// way it silently sends one stop, which is exactly what happened on the truck.
import { planSendSelection } from '../src/lib/send-selection.js';

const STOPS = [
  { ...DELIVERY, stopNbr: '007173389', businessName: DELIVERY.name, isUnplanned: true },
  { ...PICKUP, stopNbr: 'RA59223377', businessName: PICKUP.name, isUnplanned: true },
];
const twinsBy = (keyOf) => {
  const by = new Map();
  for (const t of STOPS) {
    const k = keyOf(t);
    if (!k || !t.isUnplanned) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  return (id) => {
    const s = STOPS.find((x) => x.stopNbr === String(id));
    return ((s ? by.get(keyOf(s)) : null) || []).map((t) => ({ id: t.stopNbr, label: `${t.stopNbr} (${t.businessName})` }));
  };
};
const sendPickupToRoute = (keyOf) => planSendSelection({
  ids: ['RA59223377'],                        // the pin that was on top — what he grabbed
  targetKey: 'NOR', cards: [{ key: 'NOR', order: [], strategy: 'manual' }], max: 6,
  holderOf: () => null, twinsOf: twinsBy(keyOf), displayName: (k) => k,
});

test('E2E: grabbing the pickup now brings the delivery onto the route', () => {
  const plan = sendPickupToRoute((s) => normalizePlaceKey(s.addr1, s.zip));
  const onRoute = plan.cards.find((c) => c.key === 'NOR').order.map(String);
  assert.deepEqual(onRoute, ['RA59223377', '007173389']);
});

test('E2E: and it SAYS so — a silent add would be the same bug pointing the other way', () => {
  const plan = sendPickupToRoute((s) => normalizePlaceKey(s.addr1, s.zip));
  assert.match(plan.message, /also added 1 co-located order/);
  assert.match(plan.message, /007173389/, 'the added order must name itself');
  assert.match(plan.message, /remove from the card if you meant to split/);
});

test('E2E: keyed the OLD way the delivery is left behind, silently', () => {
  // The regression this whole change exists to prevent, reproduced from the real records.
  const plan = sendPickupToRoute((s) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip));
  assert.deepEqual(plan.cards.find((c) => c.key === 'NOR').order.map(String), ['RA59223377']);
  assert.doesNotMatch(plan.message, /co-located/, 'nothing warned him — that is why it reached the truck');
});
