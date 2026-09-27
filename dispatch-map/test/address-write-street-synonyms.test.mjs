// test/address-write-street-synonyms.test.mjs — NUVIZZ SPELLING "RD" AS "ROAD" IS NOT A
// FAILED CORRECTION.
//
// THE DEFECT (review 2026-09-03, A4-S20-1; still open at the 2026-09-27 recheck). The read-back
// check addressMatchesTyped compares what the dispatcher typed with what NuVizz stored, token
// by token, prefix-tolerant: "ST"/"STREET" and "GA"/"GEORGIA" agree because one is a prefix of
// the other. "RD"/"ROAD", "HWY"/"HIGHWAY", "BLVD"/"BOULEVARD", "LN"/"LANE", "CT"/"COURT",
// "DR"/"DRIVE", "PKWY"/"PARKWAY" and "NW"/"NORTHWEST" are not prefixes of each other — and the
// module's own comment records NuVizz rewriting "RD" to "ROAD" (confirmed against the live
// vendor; the v1.29.0 changelog row names RD→ROAD on a real correction). So a correction that
// LANDED was reported "NuVizz did not take it — fix the order in the portal", and logged
// nuvizz:false in the address history.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressMatchesTyped, addressLanded, addressMoved, buildLiteralAddress,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';

const WAS = { addressType: 'ANY', name: 'ACME TILE', addr1: '100 OLD PEACHTREE RD', city: 'SUWANEE', state: 'GEORGIA', zip: '30024' };

/** The exact expression runSetStopAddress evaluates (lib/nuvizz-write.mts). */
function verdict(wasAddr, readAddr, typed) {
  const merged = buildLiteralAddress(wasAddr, typed);
  const alreadyRight = addressMatchesTyped(wasAddr, typed);
  return addressLanded(readAddr, merged)
    && addressMatchesTyped(readAddr, typed)
    && (alreadyRight || addressMoved(wasAddr, readAddr));
}

const SPELLINGS = [
  ['Rd', 'ROAD'], ['Hwy', 'HIGHWAY'], ['Blvd', 'BOULEVARD'], ['Ln', 'LANE'], ['Ct', 'COURT'],
  ['Dr', 'DRIVE'], ['Pkwy', 'PARKWAY'], ['Trl', 'TRAIL'], ['Xing', 'CROSSING'], ['Expy', 'EXPRESSWAY'],
  ['Fwy', 'FREEWAY'], ['Ctr', 'CENTER'],
];

for (const [typedWord, storedWord] of SPELLINGS) {
  test(`a correction typed "${typedWord}" that NuVizz stored as "${storedWord}" is reported as landed`, () => {
    const typed = { addr1: `250 Buford ${typedWord}` };
    const stored = { ...WAS, addr1: `250 BUFORD ${storedWord}` };
    assert.equal(addressMatchesTyped(stored, typed), true);
    assert.equal(verdict(WAS, stored, typed), true, 'the dispatcher must not be sent to the portal to re-type an address that is already there');
  });
}

test('a directional NuVizz spelled out ("NW" → "NORTHWEST") is the same street', () => {
  assert.equal(addressMatchesTyped({ addr1: '2611 SPRINGDALE ROAD SOUTHWEST' }, { addr1: '2611 Springdale Rd SW' }), true);
  assert.equal(addressMatchesTyped({ addr1: '10 PEACHTREE STREET NORTHEAST' }, { addr1: '10 Peachtree St NE' }), true);
  assert.equal(addressMatchesTyped({ addr1: '10 SATELLITE BLVD NW' }, { addr1: '10 Satellite Boulevard Northwest' }), true, 'either direction');
  assert.equal(addressMatchesTyped({ addr1: '5 MAIN ST', addr2: 'SUITE 200' }, { addr2: 'Ste 200' }), true, 'a suite spelled out');
});

test('a correction NuVizz accepted and ignored is still caught — synonyms never make a different street agree', () => {
  // Accepted and ignored: the read-back is the record from before the write.
  assert.equal(verdict(WAS, WAS, { addr1: '250 Buford Hwy' }), false);
  // A genuinely different street or street type still disagrees.
  assert.equal(addressMatchesTyped({ addr1: '250 BUFORD ROAD' }, { addr1: '250 Buford Hwy' }), false);
  assert.equal(addressMatchesTyped({ addr1: '250 BUFORD DRIVE' }, { addr1: '250 Buford Ct' }), false);
  assert.equal(addressMatchesTyped({ addr1: '250 BUFORD HIGHWAY NORTHWEST' }, { addr1: '250 Buford Hwy NE' }), false);
  assert.equal(addressMatchesTyped({ addr1: '251 BUFORD HIGHWAY' }, { addr1: '250 Buford Hwy' }), false);
  assert.equal(addressMatchesTyped({ addr1: '250 SMITH HIGHWAY' }, { addr1: '250 Buford Hwy' }), false);
});
