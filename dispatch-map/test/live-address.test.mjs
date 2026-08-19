// test/live-address.test.mjs
//
// THE ADDRESS IS LIVE. Chad, holding our card beside the NuVizz portal for
// ESTES-1283081681: "Why are these not the same[?] nuvizz is showing different than what we
// are showing[,] a new scan should have fixed this problem."
//
// It could not. The address was not a live field, so it came from the ONE first-sight
// enrichment and was carried forward for ever — while the NOTE saying the address had
// changed came through on every scan, because notes ARE live. The card showed
// "UPDATED ADDY PER ESTES" directly above the old address.
//
// The real order, as the two screenshots showed it:
//   NuVizz  — MR LARRY WOELFL, 2385 HO HUM HOLLOW ROAD, MONROE 30655
//   our app — DAVIS DELIVERY,  943 GAINESVILLE HIGHWAY,  BUFORD 30518   (our own terminal)
//
// These pin the properties that make a re-address actually reach the board, and the ones
// that stop the fix being worse than the bug:
//
//   • the list's address wins over a stored/enriched copy
//   • a BLANK list column never wipes a good stored address
//   • enrichment still fills what the list left blank
//   • the fix survives the re-enrichment it triggers (else it undoes itself same-scan)
//   • a move drops the old coordinates — a right address under a wrong pin is worse
//   • formatting drift is NOT a move, or every scan would re-enrich the whole board
//
// PURE — no Firestore, no network, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeEnrich, LIVE_IF_PRESENT_FIELDS, hasListValue } from '../netlify/functions/lib/nuvizz-list.mts';
import { addrListSig, reconsignedByListSig } from '../netlify/functions/lib/refresh-stops-core.mts';

// The fresh saved-search row: real address, no state, no coordinates (toBoardStop pins
// both to null — which is why a card reading "GEORGIA" proves it came from enrichment).
const listRow = () => ({
  stopNbr: '1283081681', businessName: 'MR LARRY WOELFL',
  addr1: '2385 HO HUM HOLLOW ROAD', addr2: null, city: 'MONROE', state: null, zip: '30655',
  lat: null, lng: null, status: 'Planned', normalizedStatus: 'SCHEDULED',
});

// What we had stored: the address as first enriched, plus detail only /stop/info carries.
const stored = () => ({
  stopNbr: '1283081681', businessName: 'DAVIS DELIVERY',
  addr1: '943 GAINESVILLE HIGHWAY', addr2: null, city: 'BUFORD', state: 'GEORGIA', zip: '30518',
  lat: 34.12, lng: -83.99, enriched: true,
  pallets: 1, contact: { name: 'MR.LARRY WOELFL', phone: '404-555-0100' },
});

// ── THE BUG ──────────────────────────────────────────────────────────────────

test('THE BUG: the list address now beats the carried-forward one', () => {
  const s = listRow();
  mergeEnrich(s, stored());
  assert.equal(s.addr1, '2385 HO HUM HOLLOW ROAD', 'the re-addressed street must reach the board');
  assert.equal(s.city, 'MONROE');
  assert.equal(s.zip, '30655');
  assert.equal(s.businessName, 'MR LARRY WOELFL', 'the consignee name is part of the address');
});

test('detail the list does NOT carry still comes from enrichment', () => {
  const s = listRow();
  mergeEnrich(s, stored());
  assert.equal(s.pallets, 1, 'line items are static detail — still merged');
  assert.equal(s.contact.phone, '404-555-0100');
  assert.equal(s.state, 'GEORGIA', 'the list has no state column, so enrichment supplies it');
});

// ── THE GUARDS THAT STOP THIS BEING WORSE THAN THE BUG ───────────────────────

test('a BLANK list column must never wipe a good stored address', () => {
  // A saved-search row can arrive with the address columns empty. Treating the address as
  // plainly LIVE would blank it board-wide.
  for (const blank of [null, undefined, '', '   ']) {
    const s = { ...listRow(), addr1: blank, city: blank, zip: blank, businessName: blank };
    mergeEnrich(s, stored());
    assert.equal(s.addr1, '943 GAINESVILLE HIGHWAY', `addr1 wiped by ${JSON.stringify(blank)}`);
    assert.equal(s.city, 'BUFORD');
    assert.equal(s.zip, '30518');
    assert.equal(s.businessName, 'DAVIS DELIVERY');
  }
});

test('a partially-blank list row takes only the fields it actually carried', () => {
  const s = { ...listRow(), city: null, zip: null };
  mergeEnrich(s, stored());
  assert.equal(s.addr1, '2385 HO HUM HOLLOW ROAD', 'the street it DID carry wins');
  assert.equal(s.city, 'BUFORD', 'the ones it did not are filled from the stored copy');
  assert.equal(s.zip, '30518');
});

test('THE SELF-UNDO: the fix survives the re-enrichment a move triggers', () => {
  // A move clears `enriched`, so the stop is re-enriched IN THE SAME SCAN and that result
  // is merged back. /stop/info answers with its own address; if these fields were ordinary
  // non-live ones, this second merge would restore the old address a few lines after the
  // first merge fixed it, and the board would never change.
  const s = listRow();
  mergeEnrich(s, stored());                                   // carry-forward
  mergeEnrich(s, { ...stored(), lat: 33.79, lng: -83.71 });    // the re-enrichment
  assert.equal(s.addr1, '2385 HO HUM HOLLOW ROAD', 'the list address must still stand');
  assert.equal(s.city, 'MONROE');
  assert.equal(s.lat, 33.79, 'but fresh coordinates are still allowed in');
});

test('every field the address rule covers is one the list actually supplies', () => {
  const s = listRow();
  for (const f of LIVE_IF_PRESENT_FIELDS) {
    assert.ok(f in s, `LIVE_IF_PRESENT_FIELDS names ${f}, which toBoardStop does not set`);
  }
  assert.ok(!LIVE_IF_PRESENT_FIELDS.includes('state'), 'the list has NO state column — live would blank it');
  assert.ok(!LIVE_IF_PRESENT_FIELDS.includes('lat'), 'coordinates are geocoded, never listed');
  assert.ok(!LIVE_IF_PRESENT_FIELDS.includes('lng'));
});

test('hasListValue treats a blank column as absent, and 0 as present', () => {
  for (const v of [null, undefined, '', '  ']) assert.equal(hasListValue(v), false, JSON.stringify(v));
  for (const v of ['x', 0, '0']) assert.equal(hasListValue(v), true, JSON.stringify(v));
});

// ── WHAT COUNTS AS A MOVE ────────────────────────────────────────────────────

test('a real re-address is a move; formatting drift is not', () => {
  const shown = addrListSig(stored());          // 30518|943
  const moved = addrListSig(listRow());         // 30655|2385
  assert.notEqual(shown, moved, 'Buford → Monroe must register');
  assert.equal(reconsignedByListSig(shown, listRow()), true);

  // Same place, spelled differently by the other endpoint. If this counted, EVERY scan
  // would re-enrich the whole board — the cost blow-up addrListSig exists to avoid.
  for (const drift of ['943 Gainesville Hwy', '943 GAINESVILLE HIGHWAY', '943 gainesville highway']) {
    const same = { ...listRow(), addr1: drift, city: 'BUFORD', zip: '30518-1234' };
    assert.equal(reconsignedByListSig(shown, same), false, `treated as a move: ${drift}`);
  }
});

test('a move is only claimed when BOTH sides have an address to compare', () => {
  const shown = addrListSig(stored());
  assert.equal(reconsignedByListSig(shown, { addr1: null, zip: null }), false,
    'an address-less list row is not evidence of a move');
  assert.equal(reconsignedByListSig('', listRow()), false,
    'no stored baseline — a first sighting is not a move');
});

test('the signature is stable across the ZIP+4 the vendor stores', () => {
  assert.equal(addrListSig({ addr1: '2385 HO HUM HOLLOW ROAD', zip: '30655' }),
               addrListSig({ addr1: '2385 HO HUM HOLLOW ROAD', zip: '30655-4412' }));
});
