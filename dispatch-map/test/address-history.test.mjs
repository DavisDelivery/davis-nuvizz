// test/address-history.test.mjs — the address-change log, pinned to the deliveries that
// exposed the gap rather than to invented strings.
//
// The governing case is delivery 007174397 (LED ENERGY PLUS, 2026-09-10). It arrived as
// "5965 PEACHTREE STREET" while our own sealed record for the same customer three months
// earlier read "5965 PEACHTREE CORS E STE B3". The scan's own detector cannot see that — both
// hash to addrListSig "30071|5965" — and nothing wrote the change down, so the question "did
// we change this address" had no answer anywhere in the system.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyChange, changedFields, streetBodyOf, unitTokensOf, buildAddressChangeRow,
  diffStopAddress, selectAddressChanges, summarizeAddressChanges, stopCandidates,
  addressHistoryEnabled, KIND_RANK,
} from '../netlify/functions/lib/address-history.mts';

const LED_JUNE = { addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: null, zip: '30071' };
const LED_SEPT = { addr1: '5965 PEACHTREE STREET', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' };

// ── the case this was built for ──────────────────────────────────────────────

test('007174397: the street line changed under the same house number and zip — a RENAME, which addrListSig cannot see', () => {
  assert.equal(classifyChange(LED_JUNE, LED_SEPT), 'renamed');
  // And prove the existing detector really is blind to it, so nobody "simplifies" this
  // module away into addrListSig later.
  const sig = (p) => `${String(p.zip).replace(/\D/g, '').slice(0, 5)}|${String(p.addr1).match(/\d+/)[0]}`;
  assert.equal(sig(LED_JUNE), sig(LED_SEPT));
});

test('007174397: the suite it lost is named in the row, so a dispatcher can see STE B3 went missing', () => {
  const row = buildAddressChangeRow({
    at: '2026-09-10T11:13:18.479Z', date: '2026-09-10', stopNbr: '007174397',
    businessName: 'LED ENERGY PLUS', source: 'scan', before: LED_JUNE, after: LED_SEPT,
    route: 'NOR 2', planned: true,
  });
  assert.equal(row.kind, 'renamed');
  assert.equal(row.before.addr1, '5965 PEACHTREE CORS E STE B3');
  assert.equal(row.after.addr1, '5965 PEACHTREE STREET');
  assert.equal(row.route, 'NOR 2');
  assert.equal(row.planned, true);
  // state went null -> 'GA' and is deliberately NOT listed: we learned it, nothing moved.
  assert.deepEqual(row.fields, ['addr1']);
});

// ── the ladder, rung by rung ─────────────────────────────────────────────────

test('a different house number is a different building — MOVED, the one that strands a loaded truck', () => {
  assert.equal(classifyChange(
    { addr1: '3190 REPS MILLER RD STE 200', city: 'NORCROSS', zip: '30071' },
    { addr1: '3200 REPS MILLER RD STE 200', city: 'NORCROSS', zip: '30071' },
  ), 'moved');
});

test('a different zip is MOVED even when the street text is identical', () => {
  assert.equal(classifyChange(
    { addr1: '943 GAINESVILLE HWY', city: 'BUFORD', zip: '30518' },
    { addr1: '943 GAINESVILLE HWY', city: 'BUFORD', zip: '30519' },
  ), 'moved');
});

test('only the suite moved — SUITE, because a dropped STE B3 is a driver in a lobby with five pallets', () => {
  assert.equal(classifyChange(
    { addr1: '3190 REPS MILLER RD STE 200', city: 'NORCROSS', zip: '30071' },
    { addr1: '3190 REPS MILLER RD STE 400', city: 'NORCROSS', zip: '30071' },
  ), 'suite');
});

test('the suite moving from addr1 to addr2 is FORMATTING — the text moved, the freight did not', () => {
  // This is the swap our own "Fix & move pin" performs (suggestAddressFix), so it has to be
  // recorded honestly and it must not read as a suite change: STE 200 is still STE 200.
  assert.equal(classifyChange(
    { addr1: '4310 INDUSTRIAL ACCESS RD STE 200', addr2: null, city: 'DORAVILLE', zip: '30360' },
    { addr1: '4310 INDUSTRIAL ACCESS RD', addr2: 'STE 200', city: 'DORAVILLE', zip: '30360' },
  ), 'formatting');
});

test('a BUILDING or DOCK number moving is SUITE, not a street rename', () => {
  // \b cannot find these: normStreetOf has already turned the spaces into underscores and
  // `_` is a word character, so the first cut of the matcher recognised suites and nothing
  // else — "BLDG 400" -> "BLDG 200" came out `renamed`, i.e. a different street.
  const z = { zip: '30360' };
  assert.equal(classifyChange({ addr1: '4310 INDUSTRIAL ACCESS RD BLDG 400', ...z }, { addr1: '4310 INDUSTRIAL ACCESS RD BLDG 200', ...z }), 'suite');
  assert.equal(classifyChange({ addr1: '100 MAIN ST DOCK 7', ...z }, { addr1: '100 MAIN ST DOCK 9', ...z }), 'suite');
  // A building number that DISAPPEARS is the same class — and the one that puts a driver at
  // the wrong door of a campus.
  assert.equal(classifyChange({ addr1: '4310 INDUSTRIAL ACCESS RD BLDG 400', ...z }, { addr1: '4310 INDUSTRIAL ACCESS RD', ...z }), 'suite');
});

test('a unit WORD inside a street name is not a unit — 100 GATE CITY BLVD keeps its street', () => {
  // Gate City Blvd is a real Atlanta street. A matcher that ate "gate" would strip the road
  // out of the comparison and call two different streets the same place.
  assert.equal(streetBodyOf('100 GATE CITY BLVD'), 'gate_city_blvd');
  assert.equal(unitTokensOf({ addr1: '100 GATE CITY BLVD' }), '');
  assert.equal(classifyChange(
    { addr1: '100 GATE CITY BLVD', zip: '30310' },
    { addr1: '100 PEACHTREE BLVD', zip: '30310' },
  ), 'renamed');
});

test('OUR OWN "Fix & move pin" swap is FORMATTING, never a red MOVED', () => {
  // suggestAddressFix swaps addr1/addr2 when NuVizz put a contact name where the street
  // belongs. Through the plain ladder that looks like a house number appearing from nowhere
  // and classified as `moved` — the most urgent class, on the action the app itself
  // encourages. A screen that cries wolf on its own fix button gets ignored, and the real
  // `moved` row gets ignored with it.
  const z = { city: 'ATLANTA', state: 'GA', zip: '30315' };
  assert.equal(classifyChange(
    { addr1: 'PROPERTY MANAGER', addr2: '2611 SPRINGDALE RD SW', ...z },
    { addr1: '2611 SPRINGDALE RD SW', addr2: 'PROPERTY MANAGER', ...z },
  ), 'formatting');
  assert.equal(classifyChange(
    { addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD', city: 'DORAVILLE', zip: '30360' },
    { addr1: '4310 INDUSTRIAL ACCESS RD', addr2: 'BLDG 200', city: 'DORAVILLE', zip: '30360' },
  ), 'formatting');
});

test('a swap that ALSO corrects the city is still reported as a region change', () => {
  assert.equal(classifyChange(
    { addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD', city: 'DORVILLE', zip: '30360' },
    { addr1: '4310 INDUSTRIAL ACCESS RD', addr2: 'BLDG 200', city: 'DORAVILLE', zip: '30360' },
  ), 'region');
});

test('the swap guard does not swallow a genuine move', () => {
  assert.equal(classifyChange(
    { addr1: '3190 REPS MILLER RD', city: 'NORCROSS', zip: '30071' },
    { addr1: '6725 JIMMY CARTER BLVD', city: 'PEACHTREE CORNERS', zip: '30092' },
  ), 'moved');
});

test('NIORCROSS -> NORCROSS with the street intact is REGION, the vendor correcting its own typo', () => {
  assert.equal(classifyChange(
    { addr1: '3190 REPS MILLER RD', city: 'NIORCROSS', zip: '30071' },
    { addr1: '3190 REPS MILLER RD', city: 'NORCROSS', zip: '30071' },
  ), 'region');
});

test('Blvd vs BOULEVARD with a +4 zip is the SAME address — no row at all', () => {
  // The list and /stop/info disagree like this across a large share of 700 stops every scan.
  // A row here would bury the handful that matter under hundreds that do not.
  assert.equal(classifyChange(
    { addr1: '1770 Satellite Blvd.', city: 'Buford', state: 'GA', zip: '30518' },
    { addr1: '1770 SATELLITE BOULEVARD', city: 'BUFORD', state: 'GA', zip: '30518-0000' },
  ), null);
});

test('a contact name we did not have before is LEARNED — addr2 filling in is not a change', () => {
  assert.equal(classifyChange(
    { addr1: '2611 SPRINGDALE RD SW', addr2: null, city: 'ATLANTA', zip: '30315' },
    { addr1: '2611 SPRINGDALE RD SW', addr2: 'PROPERTY MANAGER', city: 'ATLANTA', zip: '30315' },
  ), null);
});

test('one contact REPLACING another in addr2 is FORMATTING — real text, no freight moved', () => {
  assert.equal(classifyChange(
    { addr1: '2611 SPRINGDALE RD SW', addr2: 'PROPERTY MANAGER', city: 'ATLANTA', zip: '30315' },
    { addr1: '2611 SPRINGDALE RD SW', addr2: 'RECEIVING CLERK', city: 'ATLANTA', zip: '30315' },
  ), 'formatting');
});

test('a zip we simply did not have before is LEARNED, never a move', () => {
  assert.equal(classifyChange(
    { addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: null },
    { addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: '30071' },
  ), null);
});

test('a zip that DISAPPEARS is still reported — losing a field is not learning one', () => {
  assert.equal(classifyChange(
    { addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: '30071' },
    { addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: null },
  ), 'moved');
});

test('an empty street line that fills in is FILLED, not a move', () => {
  assert.equal(classifyChange({ addr1: '', city: 'NORCROSS', zip: '30071' }, LED_SEPT), 'filled');
});

test('a street line that disappears is CLEARED — nothing upstream should ever do this', () => {
  assert.equal(classifyChange(LED_SEPT, { addr1: '  ', city: 'NORCROSS', zip: '30071' }), 'cleared');
});

test('identical addresses produce no row at all', () => {
  assert.equal(classifyChange(LED_SEPT, { ...LED_SEPT }), null);
  assert.equal(buildAddressChangeRow({
    at: '2026-09-11T00:00:00.000Z', date: '2026-09-11', stopNbr: '007174397',
    source: 'scan', before: LED_SEPT, after: { ...LED_SEPT },
  }), null);
});

// ── the noise this must NOT generate ─────────────────────────────────────────

test('a state that appears from nowhere is not a change of state (our own 007138079 has state:null)', () => {
  // The June record really does carry state:null beside a good GA address. Reading that as a
  // region change would log a row for every such stop, every time — hundreds saying nothing.
  assert.equal(classifyChange(
    { addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', state: null, zip: '30071' },
    { addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', state: 'GA', zip: '30071' },
  ), null);
});

test('a row with no stop number is refused — a change nobody can tie to an order only adds doubt', () => {
  assert.equal(buildAddressChangeRow({
    at: '2026-09-10T11:13:18.479Z', date: '2026-09-10', stopNbr: '',
    source: 'scan', before: LED_JUNE, after: LED_SEPT,
  }), null);
});

test('null and undefined address parts are survivable, not a crash', () => {
  assert.equal(classifyChange(null, null), null);
  assert.equal(classifyChange({}, {}), null);
  assert.equal(classifyChange({ addr1: null }, { addr1: undefined }), null);
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('streetBodyOf strips the house number and the unit so only the road is compared', () => {
  assert.equal(streetBodyOf('5965 PEACHTREE STREET'), 'peachtree_st');
  assert.notEqual(streetBodyOf('5965 PEACHTREE CORS E STE B3'), streetBodyOf('5965 PEACHTREE STREET'));
  assert.equal(streetBodyOf('3190 REPS MILLER RD STE 200'), streetBodyOf('3190 REPS MILLER ROAD STE 400'));
});

test('unitTokensOf is order-independent across addr1 and addr2', () => {
  assert.equal(
    unitTokensOf({ addr1: '100 MAIN ST STE 4', addr2: null }),
    unitTokensOf({ addr1: '100 MAIN ST', addr2: 'SUITE 4' }),
  );
});

test('changedFields names every field that really differs', () => {
  assert.deepEqual(changedFields(
    { addr1: '1 A ST', city: 'BUFORD', state: 'GA', zip: '30518' },
    { addr1: '2 B RD', city: 'NORCROSS', state: 'GA', zip: '30071' },
  ), ['addr1', 'city', 'zip']);
});

test('diffStopAddress reads whole board stops without the caller unpacking them', () => {
  assert.equal(diffStopAddress(
    { stopNbr: '007174397', addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', zip: '30071', lat: 33.9 },
    { stopNbr: '007174397', addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: '30071', lat: 33.9 },
  ), 'renamed');
});

// ── selection + ordering ─────────────────────────────────────────────────────

const ROWS = [
  { at: '2026-09-11T10:00:00.000Z', stopNbr: '007174397', kind: 'formatting', source: 'scan' },
  { at: '2026-09-11T09:00:00.000Z', stopNbr: 'ESTES-0538243875', kind: 'moved', source: 'scan' },
  { at: '2026-09-11T08:00:00.000Z', stopNbr: '007174397', kind: 'renamed', source: 'scan' },
  { at: '2026-09-11T07:00:00.000Z', stopNbr: '007174397', kind: 'suite', source: 'override' },
];

test('a MOVED from an hour ago outranks a FORMATTING from ten minutes ago', () => {
  const out = selectAddressChanges(ROWS);
  assert.equal(out[0].kind, 'moved');
  assert.equal(out[out.length - 1].kind, 'formatting');
});

test('hideNoise drops formatting rows and nothing else', () => {
  const out = selectAddressChanges(ROWS, { hideNoise: true });
  assert.equal(out.length, 3);
  assert.ok(!out.some((r) => r.kind === 'formatting'));
});

test('a stop search matches the zero-padded form NuVizz files numeric PROs under', () => {
  assert.deepEqual(stopCandidates('7174397').includes('007174397'), true);
  assert.equal(selectAddressChanges(ROWS, { stop: '7174397' }).length, 3);
  assert.equal(selectAddressChanges(ROWS, { stop: '007174397' }).length, 3);
});

test('source filter separates what WE did from what the vendor did', () => {
  assert.equal(selectAddressChanges(ROWS, { source: 'override' }).length, 1);
  assert.equal(selectAddressChanges(ROWS, { source: 'scan' }).length, 3);
});

test('rows with no timestamp are dropped — an unorderable row in a forensic list is worse than an absent one', () => {
  assert.equal(selectAddressChanges([...ROWS, { stopNbr: 'X', kind: 'moved' }]).length, ROWS.length);
});

test('the summary counts each kind and the total', () => {
  const sum = summarizeAddressChanges(ROWS);
  assert.equal(sum.total, 4);
  assert.equal(sum.moved, 1);
  assert.equal(sum.renamed, 1);
  assert.equal(sum.formatting, 1);
});

test('every kind has a rank, so none can sort to an undefined position', () => {
  for (const k of ['moved', 'renamed', 'suite', 'region', 'filled', 'cleared', 'formatting']) {
    assert.equal(typeof KIND_RANK[k], 'number', `${k} has no rank`);
  }
});

// ── the switch ───────────────────────────────────────────────────────────────

test('ADDRESS_HISTORY defaults ON, an off-word turns it off, a typo leaves it ON', () => {
  assert.equal(addressHistoryEnabled({}), true);
  assert.equal(addressHistoryEnabled({ ADDRESS_HISTORY: '' }), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) {
    assert.equal(addressHistoryEnabled({ ADDRESS_HISTORY: v }), false, `${v} should disable`);
  }
  // The failure this shape exists to prevent: a quiet feature looks exactly like a working one.
  assert.equal(addressHistoryEnabled({ ADDRESS_HISTORY: 'offf' }), true);
  assert.equal(addressHistoryEnabled({ ADDRESS_HISTORY: 'disabled' }), true);
});
