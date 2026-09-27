// test/address-change-zip-lost.test.mjs — A ZIP THAT DISAPPEARS IS NOT A DIFFERENT BUILDING.
//
// THE DEFECT (audit 2026-09-27, firestore-history-address-7). classifyChange returned `moved`
// — the top, act-now class, sorted above every real move — whenever the 5-digit zips
// differed, and a LOST zip ('30071' → '') differs. The comment right above it says "a zip is
// only a move when BOTH sides have one". Same house number, same street, same city is the same
// building with a field missing: the module files a lost city or state as `region`, and a
// lost zip now files the same way. It is still recorded — losing data is worth a row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyChange, buildAddressChangeRow, selectAddressChanges } from '../netlify/functions/lib/address-history.mts';

const HERE = { addr1: '5965 PEACHTREE CORS E STE B3', addr2: '', city: 'NORCROSS', state: 'GA', zip: '30071' };

test('a dispatcher clearing the zip on an address is recorded as a region change, not as the freight moving', () => {
  assert.equal(classifyChange(HERE, { ...HERE, zip: '' }), 'region');
  assert.equal(classifyChange(HERE, { ...HERE, zip: null }), 'region');
});

test('a lost zip ranks with a lost city or state, below a real move on the history screen', () => {
  assert.equal(classifyChange(HERE, { ...HERE, city: '' }), 'region', 'the rule a lost zip now matches');
  const at = '2026-09-10T11:00:00.000Z';
  const lost = buildAddressChangeRow({ at, date: '2026-09-10', stopNbr: '1', source: 'override', before: HERE, after: { ...HERE, zip: '' } });
  const moved = buildAddressChangeRow({ at, date: '2026-09-10', stopNbr: '2', source: 'override', before: HERE, after: { ...HERE, addr1: '5975 PEACHTREE CORS E STE B3' } });
  assert.deepEqual(lost.fields, ['zip'], 'still recorded, naming the field that went');
  assert.deepEqual(selectAddressChanges([lost, moved]).map((r) => r.kind), ['moved', 'region']);
});

test('what already worked is unchanged: a different zip is moved, a gained zip is nothing', () => {
  assert.equal(classifyChange(HERE, { ...HERE, zip: '30092' }), 'moved');
  assert.equal(classifyChange({ ...HERE, zip: '' }, HERE), null);
  assert.equal(classifyChange(HERE, { ...HERE, zip: '30071-1234' }), null);
  // A lost zip beside a real street move is still the move.
  assert.equal(classifyChange(HERE, { ...HERE, addr1: '5975 PEACHTREE CORS E STE B3', zip: '' }), 'moved');
});

test('the history screen says what a City/State row can now mean, so a lost zip is not a mystery', () => {
  const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(APP, /key: 'region', label: 'City\/State', hint: 'City or state changed, or the zip went missing, with the street intact'/);
});
