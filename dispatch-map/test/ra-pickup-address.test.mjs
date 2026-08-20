// test/ra-pickup-address.test.mjs
//
// AN RA PICKUP WAS SHOWING THE WAREHOUSE IT WAS COMING BACK TO.
//
// Chad, on an RA row sitting at stop 12 of route DUL 2: "RA pickups need to show the address
// where they are picking up as they are all coming back to the warehouse. The map is right
// but the address is not."
//
// The 2026-08-20 board carried fourteen RA rows. Every one of them read
// "DAVIS DELIVERY, 943 GAINESVILLE HIGHWAY, BUFORD 30518" — our own terminal — and every one
// of them had a DIFFERENT pin, spread across metro Atlanta. That split is the whole diagnosis:
// the saved search reports SHIP-TO columns and the ship-to on a return is the warehouse, while
// enrichment reads a pickup off stop.from and got the real address. Coordinates are not in
// LIVE_IF_PRESENT_FIELDS so the pin survived the merge; the five address fields are, so the
// correct address was discarded on every scan.
//
// These tests pin the rule and the three ways fixing it could have been worse than the bug:
//   * a DELIVERY still takes the list's address (the ESTES re-address fix must not regress)
//   * a sparse /stop/info must not blank a card that at least had something on it
//   * the reconsignment detector must not read a pickup's two different addresses as a move,
//     or every RA row re-enriches and loses its pin on every scan, for ever
//
// PURE — no Firestore, no network, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeEnrich, isPickupRow, LIVE_IF_PRESENT_FIELDS } from '../netlify/functions/lib/nuvizz-list.mts';
import { addrListSig, PICKUP_ADDR_HEAL } from '../netlify/functions/lib/refresh-stops-core.mts';
import { stopCustomerKey } from '../netlify/functions/lib/customer-key.mts';
import { computeBoardFlags } from '../src/lib/board-flags.js';

// The saved-search row exactly as toBoardStop builds it for RA56821707: typed PU off the RA
// prefix, ship-to columns, no state and no coordinates.
const listRow = (over = {}) => ({
  stopNbr: 'RA56821707', stopType: 'PU', routeName: 'DUL 2', loadNbr: 'DUL 2', routeSeq: 12,
  businessName: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', addr2: null,
  city: 'BUFORD', state: null, zip: '30518', lat: null, lng: null,
  orderInstructions: '$59.99 JANICE 678-502-8017', ...over,
});

// What /stop/info returns once normalizeStop has resolved a PU off stop.from — the house we
// are actually collecting from, with the coordinates that were already reaching the map.
const enrichedPickup = (over = {}) => ({
  stopNbr: 'RA56821707', stopType: 'PU', enriched: true,
  businessName: 'JANICE HOLLOWAY', addr1: '4120 PLEASANT HILL ROAD', addr2: 'APT 3108',
  city: 'DULUTH', state: 'GA', zip: '30096', lat: 33.99383, lng: -84.08251,
  isTerminal: false, pallets: 1, ...over,
});

// ── the bug ──────────────────────────────────────────────────────────────────

test('THE RA CASE: the pickup address reaches the board instead of the warehouse', () => {
  const s = listRow();
  mergeEnrich(s, enrichedPickup());
  assert.equal(s.addr1, '4120 PLEASANT HILL ROAD', 'the driver is told where to collect');
  assert.equal(s.addr2, 'APT 3108');
  assert.equal(s.city, 'DULUTH');
  assert.equal(s.zip, '30096');
  assert.equal(s.businessName, 'JANICE HOLLOWAY');
});

test('the address and the pin now describe the SAME place', () => {
  // The symptom Chad reported was the two disagreeing. Fourteen rows shared one address and
  // had fourteen pins; after the merge the address moves to where the pin already was.
  const s = listRow();
  mergeEnrich(s, enrichedPickup());
  assert.equal(s.lat, 33.99383);
  assert.equal(s.lng, -84.08251);
  assert.equal(s.zip, '30096', 'the zip belongs to the pin, not to Buford');
});

test('a pickup stops borrowing the terminal\'s customer identity — and its receiving hours', () => {
  // customer_notes is keyed off businessName/addr1/city/zip, so a pickup wearing the
  // warehouse address read the WAREHOUSE's notes document: that is where the 6:00a-11:00a
  // "customer notes hours" on Chad's screenshot came from, seven days a week, on a house.
  // It also means a dispatcher typing hours onto that card was editing our terminal's hours.
  const before = stopCustomerKey(listRow());
  const s = listRow();
  mergeEnrich(s, enrichedPickup());
  const after = stopCustomerKey(s);
  assert.ok(before && after, 'both are real keys');
  assert.notEqual(after, before, 'the pickup no longer resolves to the terminal');
  assert.equal(after, stopCustomerKey(enrichedPickup()), 'it resolves to where we collect');
});

// ── the ways the fix could have been worse than the bug ───────────────────────

test('a DELIVERY still takes the list address — the ESTES re-address fix is untouched', () => {
  // ESTES-1283081681: the order was re-addressed, the list carried the new address every
  // scan, and the board kept showing the old enriched one. That fix is the reason
  // LIVE_IF_PRESENT_FIELDS exists and it must survive this change intact.
  const s = {
    stopNbr: '1283081681', stopType: 'DO', businessName: 'MR LARRY WOELFL',
    addr1: '2385 HO HUM HOLLOW ROAD', city: 'MONROE', state: null, zip: '30655',
  };
  mergeEnrich(s, {
    stopNbr: '1283081681', stopType: 'DO', enriched: true, businessName: 'DAVIS DELIVERY',
    addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518',
  });
  assert.equal(s.addr1, '2385 HO HUM HOLLOW ROAD', 'the list still wins a delivery');
  assert.equal(s.businessName, 'MR LARRY WOELFL');
  assert.equal(s.state, 'GEORGIA', 'and enrichment still fills what the list has no column for');
});

test('a sparse /stop/info leaves the ship-to standing rather than blanking the card', () => {
  // The merge already refuses to write a null over a real value. That rule is what keeps a
  // detail record with no address from turning a wrong address into no address at all.
  const s = listRow();
  mergeEnrich(s, { stopNbr: 'RA56821707', stopType: 'PU', enriched: true, addr1: null, city: '', businessName: undefined, pallets: 2 });
  assert.equal(s.addr1, '943 GAINESVILLE HIGHWAY');
  assert.equal(s.city, 'BUFORD');
  assert.equal(s.businessName, 'DAVIS DELIVERY');
  assert.equal(s.pallets, 2, 'what the record DID carry still merges');
});

test('THE LOOP THAT WOULD HAVE COST A CALL A SCAN: a pickup\'s two addresses are not a move', () => {
  // The scanner re-enriches a stop when the address it is SHOWING disagrees with the address
  // the list reported — that is how a reconsignment is caught. On a pickup those two are
  // different places by design and can never converge, so without the isPickupRow exemption
  // in refresh-stops-core every RA row would re-enrich, and blank its pin, on every scan.
  const s = listRow();
  const listSig = addrListSig(s);
  mergeEnrich(s, enrichedPickup());
  const shownSig = addrListSig(s);
  assert.notEqual(shownSig, listSig, 'the signatures genuinely disagree — the exemption is load-bearing');
  assert.equal(isPickupRow(s), true, 'and it is a pickup that the exemption keys on');
});

test('the one-time repair is versioned, so it can never become a per-scan habit', () => {
  assert.ok(Number.isInteger(PICKUP_ADDR_HEAL) && PICKUP_ADDR_HEAL >= 1);
  // A row already repaired reads as done; a row from before the fix does not.
  assert.ok(Number(enrichedPickup({ pickupAddrHeal: PICKUP_ADDR_HEAL }).pickupAddrHeal ?? 0) >= PICKUP_ADDR_HEAL);
  assert.ok(Number(enrichedPickup().pickupAddrHeal ?? 0) < PICKUP_ADDR_HEAL);
});

// ── isPickupRow ──────────────────────────────────────────────────────────────

test('isPickupRow: the type wins, and the RA prefix only speaks when nothing else does', () => {
  assert.equal(isPickupRow({ stopType: 'PU' }), true);
  assert.equal(isPickupRow({ stopType: 'pu ' }), true);
  // Enrichment is the authority on stop type: an explicit DO is taken at its word even on
  // an RA number, so a mis-numbered delivery keeps the live-address behaviour.
  assert.equal(isPickupRow({ stopType: 'DO', stopNbr: 'RA56821707' }), false);
  // A stored row from before toBoardStop typed the prefix has no stopType at all.
  assert.equal(isPickupRow({ stopNbr: 'RA56821707' }), true);
  assert.equal(isPickupRow({ stopNbr: '007162998' }), false);
  assert.equal(isPickupRow(null), false);
  assert.equal(isPickupRow({}), false);
});

test('the five live-if-present fields are exactly the address, so the exemption covers it', () => {
  for (const f of ['businessName', 'addr1', 'addr2', 'city', 'zip']) {
    assert.ok(LIVE_IF_PRESENT_FIELDS.includes(f), `${f} must be part of the address rule`);
  }
  assert.ok(!LIVE_IF_PRESENT_FIELDS.includes('lat'), 'the pin was never live — that is why it was right');
  assert.ok(!LIVE_IF_PRESENT_FIELDS.includes('lng'));
});

// ── receiving hours are for deliveries ───────────────────────────────────────

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const FLAG_OPTS = { depot: DEPOT, departMin: 8 * 60, nowMin: 10 * 60 };
const flagStop = (over = {}) => ({
  stopNbr: '1001', businessName: 'ACME', addr1: '1 Main', city: 'Buford',
  lat: 34.10, lng: -84.00, matchKey: 'acme|1 main|buford|30518',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'DUL 2', routeName: 'DUL 2', routeSeq: 1, stopType: 'DO',
  driverName: null, driverUserName: null, ...over,
});
const judge = (stops, notesObj) => computeBoardFlags({
  stops, notes: new Map(Object.entries(notesObj)), servedDate: '2026-08-10', dayKey: 'mon',
  rosterRows: [], opts: FLAG_OPTS,
});

test('a driverless route is not accused over a PICKUP\'s borrowed receiving hours', () => {
  // v0.59.2, on the finished-day sheet: "Receiving hours describe when a dock will take
  // freight IN. A pickup is us collecting freight OUT." The ETA walk already judged
  // deliveries only; the driverless-route card read the whole route group and did not.
  const hours = { 'term|k': { receiving_hours: { mon: { open: '06:00', close: '11:00' } } } };
  const pickupOnly = [
    flagStop({ stopNbr: '1', routeSeq: 1 }),
    flagStop({ stopNbr: 'RA56821707', stopType: 'PU', routeSeq: null, matchKey: 'term|k', businessName: 'DAVIS DELIVERY' }),
  ];
  assert.equal(judge(pickupOnly, hours).rows.filter((r) => r.rule === 'no_driver_hours').length, 0,
    'a pickup carries no dock deadline, so there is nothing to be driverless against');

  // The control: the SAME route, the same hours, on a delivery — still flags.
  const delivery = [
    flagStop({ stopNbr: '1', routeSeq: 1 }),
    flagStop({ stopNbr: '2', routeSeq: 2, matchKey: 'term|k', businessName: 'LUND INTERNATIONAL' }),
  ];
  assert.equal(judge(delivery, hours).rows.filter((r) => r.rule === 'no_driver_hours').length, 1,
    'the LVILLE rule the card exists for is untouched');
});
