// test/stop-search.test.mjs — THE RULES of address / city search (src/lib/stop-search.js).
//
// Chad, 2026-09-24: "need to be able to look up stops by address & city as there are times i
// may want to see every delivery done in that city so will need some date ranges as well as
// specific dates date ranges should default to all unless set"
//
// Every test here is named for the real-world event it prevents. The ones that matter most are
// the ones that fail SILENTLY in production: a house number that matches the wrong building, a
// city that quietly absorbs its neighbour, a digest that reads an empty cell as zero, and a date
// range that is not "all" when nobody set one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  placeQuery, placeQueryUsable, rowMatchesPlace, addressTokens, cityKey, zip5, stateKey,
  encodeSearchDigest, decodeSearchDigest, searchDigestRow, placeStopRow, utf8Bytes,
  placeRange, placeSelectionFromParams, placeParams, inPlaceRange, buildPlaceView,
  SEARCH_DIGEST_FIELDS,
} from '../src/lib/stop-search.js';
import { buildCustomerStopRow } from '../src/lib/stop-lookup.js';
import { normStreetOf } from '../src/lib/matchKey.js';
import { CUSTOMER_STOP_FIELDS } from '../netlify/functions/lib/board-fields.mts';
import { stopSearchEnabled, monthWindows, dateRangeQuery } from '../netlify/functions/lib/stop-search-store.mts';
import { rebuildPlan } from '../netlify/functions/history-search-rebuild.mts';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const LIB = readFileSync(new URL('../src/lib/stop-search.js', import.meta.url), 'utf8');

const stop = (addr1, city = 'ATLANTA', zip = '30318', extra = {}) => ({ stopNbr: `S${addr1.length}${city.length}`, addr1, city, state: 'GA', zip, normalizedStatus: 'DELIVERED', ...extra });
const matches = (q, st) => rowMatchesPlace(st, placeQuery(q));

// ── THE MATCH ────────────────────────────────────────────────────────────────

test('THE HOUSE NUMBER IS THE HOUSE NUMBER — 110 never finds 1100, and a suite number is not one', () => {
  // A false match here hands a rep the wrong building's proof of delivery.
  assert.equal(matches({ addr: '110 Northside Dr' }, stop('1100 NORTHSIDE DR NW')), false, '110 must not find 1100');
  assert.equal(matches({ addr: '1100 Northside Dr' }, stop('110 NORTHSIDE DR')), false, '1100 must not find 110');
  assert.equal(matches({ addr: '100 Main' }, stop('5100 MAIN ST STE 100')), false, 'the suite is not the house number');
  assert.equal(matches({ addr: '100 Main' }, stop('100 MAIN ST')), true);
});

test('SPELLING DOES NOT DECIDE A MATCH — Drive/Dr, Suite/Ste, Northwest/NW, Building/Bldg, case, a leading #', () => {
  const typed = { addr: '1100 Northside Drive Northwest Suite 210' };
  assert.equal(matches(typed, stop('1100 NORTHSIDE DR NW STE 210')), true);
  assert.equal(matches({ addr: '4200 wendell dr sw building c' }, stop('4200 WENDELL DR SW BLDG C')), true);
  assert.equal(matches({ addr: '1100 Northside Dr' }, stop('#1100 Northside Drive NW')), true, 'a leading # is not part of the number');
  // The words may come in any order after the number — "Suite 210, 1100 Northside" is how people read a label.
  assert.equal(matches({ addr: 'Suite 210' }, stop('1100 NORTHSIDE DR NW STE 210')), true);
});

test('THE LAST WORD MAY BE HALF-TYPED; A MIDDLE WORD MAY NOT', () => {
  assert.equal(matches({ addr: '1100 northsi' }, stop('1100 NORTHSIDE DR')), true, 'a rep still typing');
  assert.equal(matches({ addr: '1100 north dr' }, stop('1100 NORTHSIDE DR')), false, 'a whole middle word must be a whole word');
});

test('CITY IS EXACT, NEVER A PREFIX — "Peachtree" is two cities forty miles apart', () => {
  assert.equal(matches({ city: 'peachtree' }, stop('1 A ST', 'PEACHTREE CITY')), false);
  assert.equal(matches({ city: 'peachtree corners' }, stop('1 A ST', 'PEACHTREE CORNERS')), true);
  assert.equal(matches({ city: '  sandy   springs. ' }, stop('1 A ST', 'SANDY SPRINGS')), true, 'case, spacing and punctuation never decide');
  assert.equal(cityKey('Sandy-Springs'), 'SANDY SPRINGS');
});

test('ZIP COMPARES ON FIVE DIGITS, AND FIVE DIGITS ALONE IN THE ADDRESS BOX IS A ZIP', () => {
  assert.equal(matches({ zip: '30318' }, stop('1 A ST', 'ATLANTA', '30318-4411')), true);
  assert.equal(matches({ zip: '30318-9999' }, stop('1 A ST', 'ATLANTA', '30318')), true);
  assert.equal(zip5('3031'), '', 'four digits is not a ZIP');
  const q = placeQuery({ addr: '30318' });
  assert.equal(q.zip, '30318');
  assert.deepEqual(q.addrTokens, []);
  assert.equal(q.reading, 'zip-in-address', 'and the answer says it was read that way');
  assert.equal(placeQuery({ addr: '30318', zip: '30303' }).zip, '30303', 'a ZIP typed in its own box wins');
});

test('A WHOLE ADDRESS PASTED INTO THE FIRST BOX IS TAKEN APART — it is not a six-word street', () => {
  // The most natural paste there is. Read as a street it required "atlanta", "ga" and "30318" to be
  // in the street line, and answered "no stops at that address" about one we deliver to weekly.
  const stored = stop('1100 NORTHSIDE DR NW', 'ATLANTA', '30318');
  const q = placeQuery({ addr: '1100 Northside Dr, Atlanta, GA 30318' });
  assert.deepEqual([q.addrTokens.join(' '), q.city, q.state, q.zip, q.reading], ['1100 northside dr', 'ATLANTA', 'GA', '30318', 'split']);
  assert.equal(rowMatchesPlace(stored, q), true);
  // A unit segment stays in the street; a trailing ZIP (and a plain state) moves without commas.
  assert.equal(placeQuery({ addr: '1100 Northside Dr, Suite 210, Atlanta, GA' }).addrTokens.join(' '), '1100 northside dr ste 210');
  assert.equal(rowMatchesPlace(stored, placeQuery({ addr: '1100 Northside Dr GA 30318' })), true);
  // The City box too: "Atlanta, GA" is not a city called ATLANTA GA.
  assert.deepEqual([placeQuery({ city: 'Atlanta, GA 30318' }).city, placeQuery({ city: 'Atlanta, GA 30318' }).zip], ['ATLANTA', '30318']);
  assert.equal(placeQuery({ city: 'Atlanta GA' }).city, 'ATLANTA');
});

test('…BUT A WORD THAT BELONGS TO THE STREET NEVER MOVES — NE is north-east, Ct is Court', () => {
  assert.equal(placeQuery({ addr: '1100 Northside Dr NE 30318' }).addrTokens.join(' '), '1100 northside dr ne', 'NE stays a direction');
  assert.equal(placeQuery({ addr: '1 Oak Ct 30318' }).addrTokens.join(' '), '1 oak ct', 'Ct stays a Court');
  assert.equal(placeQuery({ addr: 'Main St' }).addrTokens.join(' '), 'main st', 'a short line is never eaten');
  assert.equal(placeQuery({ city: 'Peachtree City' }).city, 'PEACHTREE CITY');
  // What the rep typed in a box wins over what they pasted — and the pasted part is DROPPED, not
  // pushed into the street where it would break the match.
  const q = placeQuery({ addr: '1100 Northside Dr, Atlanta, GA 30318', city: 'Sandy Springs', zip: '30328' });
  assert.deepEqual([q.addrTokens.join(' '), q.city, q.zip], ['1100 northside dr', 'SANDY SPRINGS', '30328']);
});

test('A STATE ALONE IS NOT A SEARCH — it is every stop in Georgia', () => {
  assert.equal(placeQueryUsable(placeQuery({ state: 'GA' })), false);
  assert.equal(placeQueryUsable(placeQuery({})), false);
  for (const q of [{ addr: '1 Main St' }, { city: 'Atlanta' }, { zip: '30318' }]) assert.equal(placeQueryUsable(placeQuery(q)), true, JSON.stringify(q));
  assert.equal(stateKey('Georgia'), '', 'a state that is not two letters filters nothing rather than everything');
  assert.equal(matches({ city: 'atlanta', state: 'TN' }, stop('1 A ST')), false, 'a state that disagrees excludes');
});

test('the search-only abbreviations do not reach normStreetOf — no stored place key moves', () => {
  // addressTokens applies them AFTER normStreetOf, on both sides. normStreetOf itself — the place
  // key, the address log and every customer_notes id — must still spell them out in full.
  assert.equal(normStreetOf('1 Northwest Pkwy Building 2'), '1_northwest_pkwy_building_2');
  assert.deepEqual(addressTokens('1 Northwest Pkwy Building 2'), ['1', 'nw', 'pkwy', 'bldg', '2']);
});

// ── THE DIGEST ───────────────────────────────────────────────────────────────

const RICH = {
  stopNbr: '007174397', pro: '007174397', pros: ['007174397', '007174398', '007174399'],
  normalizedStatus: 'DELIVERED', shipmentNbr: 'ATT007174397', routeName: 'NOR 2', loadNbr: 'DAVIS000203707',
  loadStopSeq: 7, driverName: 'ENOCK AKYEA', driverUserName: 'ENOCK', isPlanned: true,
  deliveredDTTM: '2026-09-15T14:19', raw: { stopExecutionInfo: { to: { arrivalDTTM: '2026-09-15T14:02' } } },
  businessName: 'LED ENERGY PLUS', addr1: '5965 PEACHTREE CORS E STE B3', addr2: 'DOCK 2', city: 'NORCROSS', state: 'GA', zip: '30071',
  cartons: 4, volume: 9, pallets: 2, weight: 860, podDocs: [{}, {}], poRef: 'PO-99120',
  // Not carried by the digest — see the next test for the list.
  plannedEtaDTTM: '2026-09-15T13:00', scheduledFrom: '08:00', scheduledTo: '16:00', custRef: 'CR-1', bol: 'BOL-3', orderNbr: 'L-5',
};

test('A ROW REBUILT FROM THE DIGEST RENDERS AS THE SAME STOP DOES IN THE CUSTOMER VIEW', () => {
  // The address search reuses the customer view's day tables. If the digest dropped or bent a
  // column, the same delivery would read differently on two screens.
  const opts = { date: '2026-09-15', today: '2026-09-24', source: 'sealed' };
  const direct = buildCustomerStopRow(RICH, opts);
  const doc = encodeSearchDigest([RICH], { tenant: 'davis', date: '2026-09-15', builtAt: 'x' });
  const viaDigest = placeStopRow(decodeSearchDigest(doc).rows[0], opts);
  // THE SIX FIELDS THE DIGEST DOES NOT CARRY, named so a change to the list is a decision: a
  // sealed day's ETA and window are history nobody searches by, and the three refs other than
  // the PO are one tap away in the order panel.
  const OMITTED = ['etaAt', 'windowFrom', 'windowTo'];
  for (const k of Object.keys(direct)) {
    if (OMITTED.includes(k) || k === 'refs') continue;
    assert.deepEqual(viaDigest[k], direct[k], `row.${k}`);
  }
  assert.equal(viaDigest.refs.po, direct.refs.po);
  assert.equal(viaDigest.proCount, 3, 'three orders on one stop survives');
  assert.equal(viaDigest.pod, 2, 'the POD count survives even though the documents do not');
  assert.equal(viaDigest.arrivedAt, '2026-09-15T14:02', 'the raw execution block is the arrival fallback, as in the customer view');
});

test('AN EMPTY CELL IS NULL, NEVER ZERO — "stop 0 · 0 lb" is a fact nobody recorded', () => {
  const doc = encodeSearchDigest([{ stopNbr: 'X1', normalizedStatus: 'DELIVERED', addr1: '1 A ST', city: 'ATLANTA', zip: '30318', loadStopSeq: null, cartons: null, weight: null }], { tenant: 't', date: '2026-09-15' });
  const r = decodeSearchDigest(doc).rows[0];
  assert.equal(r.loadStopSeq, null);
  assert.equal(r.cartons, null);
  assert.equal(r.weight, null);
  const row = placeStopRow(r, { date: '2026-09-15', today: '2026-09-24' });
  assert.equal(row.seq, null, 'an unplanned stop shows no stop number');
  assert.equal(row.weight, null);
});

test('THE SHARED ROW BUILDER NO LONGER READS NULL AS ZERO — the customer view had it too', () => {
  // nuvizz-scan.mts writes explicit nulls for loadStopSeq, cartons and weight. Before v1.62.0 every
  // unplanned stop rendered "stop 0 · 0 pc · 0 plt · 0 lb" and sorted to the top of its day.
  const r = buildCustomerStopRow({ stopNbr: '1', loadStopSeq: null, cartons: null, volume: 4, pallets: null, weight: null }, { date: '2026-09-18', today: '2026-09-18' });
  assert.equal(r.seq, null);
  assert.equal(r.pieces, 4, 'null cartons falls through to volume, as the ?? always meant it to');
  assert.equal(r.pallets, null);
  assert.equal(r.weight, null);
  const z = buildCustomerStopRow({ stopNbr: '2', loadStopSeq: 0, cartons: 0, weight: 0 }, { date: '2026-09-18', today: '2026-09-18' });
  assert.deepEqual([z.seq, z.pieces, z.weight], [0, 0, 0], 'a real zero stays a zero');
});

test('A TAB OR A LINE BREAK IN A VALUE CANNOT SPLIT A ROW', () => {
  const doc = encodeSearchDigest([{ stopNbr: 'X1', businessName: 'A\tB\nC\r\nD', addr1: '1 A ST', city: 'ATLANTA', zip: '30318', normalizedStatus: 'DELIVERED' }], { tenant: 't', date: '2026-09-15' });
  const back = decodeSearchDigest(doc);
  assert.equal(back.count, 1);
  assert.equal(back.malformed, 0);
  assert.equal(back.rows[0].businessName, 'A B C D');
});

test('A DIGEST IT CANNOT READ IS REFUSED WHOLE — never read as a day with no stops', () => {
  const good = encodeSearchDigest([stop('1 A ST')], { tenant: 't', date: '2026-09-15' });
  assert.equal(decodeSearchDigest({ ...good, fields: good.fields.filter((f) => f !== 'addr1') }), null, 'a required column missing');
  assert.equal(decodeSearchDigest({ ...good, date: 'yesterday' }), null);
  assert.equal(decodeSearchDigest(null), null);
  // A row with the wrong cell count is dropped and COUNTED — the endpoint can say so.
  const bent = decodeSearchDigest({ ...good, rows: `${good.rows}\nonly\ttwo` });
  assert.equal(bent.count, 1);
  assert.equal(bent.malformed, 1);
  // Mapped BY NAME: a digest written with its columns in another order reads the same.
  const shuffled = [...good.fields].reverse();
  const cells = good.rows.split('\t');
  const reordered = decodeSearchDigest({ ...good, fields: shuffled, rows: [...cells].reverse().join('\t') });
  assert.equal(reordered.rows[0].addr1, '1 A ST');
});

test('a stop with neither a stop number nor a PRO is skipped, and counted', () => {
  const doc = encodeSearchDigest([{ addr1: '1 A ST', city: 'X', zip: '30318' }, stop('2 B ST')], { tenant: 't', date: '2026-09-15' });
  assert.equal(doc.count, 1);
  assert.equal(doc.skipped, 1);
});

test('THE SIZE CEILING IS IN BYTES, NOT CHARACTERS', () => {
  assert.equal(utf8Bytes('—'), 3);
  assert.equal(utf8Bytes('ab'), 2);
  const doc = encodeSearchDigest([{ ...stop('1 A ST'), businessName: '———' }], { tenant: 't', date: '2026-09-15' });
  assert.equal(doc.bytes, utf8Bytes(doc.rows));
});

test('THE NIGHTLY HOOK AND THE REBUILD WRITE THE SAME ROWS — every field the digest reads is in the rebuild\'s mask', () => {
  // The rebuild reads a day MASKED to CUSTOMER_STOP_FIELDS; the nightly hook is handed the full
  // records. If searchDigestRow read a field outside the mask, backfilled days would silently lack
  // a column that nightly days have.
  const body = LIB.slice(LIB.indexOf('export function searchDigestRow'), LIB.indexOf('export function encodeSearchDigest'));
  const read = [...new Set([...body.matchAll(/\bst\.([a-zA-Z0-9]+)/g)].map((m) => m[1]))];
  assert.ok(read.length > 15, 'the accessor scan found the fields');
  for (const f of read) {
    const covered = CUSTOMER_STOP_FIELDS.includes(f) || CUSTOMER_STOP_FIELDS.some((m) => m.startsWith(`${f}.`));
    assert.ok(covered, `searchDigestRow reads st.${f}, which the rebuild's mask does not fetch`);
  }
  assert.equal(SEARCH_DIGEST_FIELDS.length, searchDigestRow({}).length, 'one cell per declared column');
});

// ── THE DATES ────────────────────────────────────────────────────────────────

test('DATES DEFAULT TO ALL — nothing set is every date we hold, not a window', () => {
  // Chad: "date ranges should default to all unless set".
  const none = placeSelectionFromParams(() => null);
  assert.deepEqual(none, { kind: 'all' });
  const r = placeRange(none, '2026-09-24', 3);
  assert.equal(r.kind, 'all');
  assert.equal(r.from, null, 'from the first day we hold');
  assert.equal(r.to, '2026-09-27', 'through the board ahead');
  assert.equal(placeParams({ city: 'Atlanta' }, { kind: 'all' }), 'city=Atlanta', 'and ALL sends no dates at all');
});

test('one day and a range are exactly what was asked — swapped ends fixed, the future clamped, NO 60-day cap', () => {
  assert.deepEqual(placeRange({ kind: 'day', date: '2026-07-14' }, '2026-09-24', 3), { kind: 'day', from: '2026-07-14', to: '2026-07-14', clamped: null });
  const sw = placeRange({ kind: 'range', from: '2026-09-10', to: '2026-06-01' }, '2026-09-24', 3);
  assert.deepEqual([sw.from, sw.to, sw.clamped], ['2026-06-01', '2026-09-10', 'swapped']);
  const fut = placeRange({ kind: 'range', from: '2026-09-01', to: '2026-12-31' }, '2026-09-24', 3);
  assert.deepEqual([fut.to, fut.clamped], ['2026-09-27', 'future']);
  // history-range.js caps at 60 because those screens read a whole board per day. This reads one
  // small document per day, so a wide range must NOT be quietly shortened.
  const wide = placeRange({ kind: 'range', from: '2026-01-01', to: '2026-09-01' }, '2026-09-24', 3);
  assert.deepEqual([wide.from, wide.to, wide.clamped], ['2026-01-01', '2026-09-01', null]);
  assert.equal(placeRange({ kind: 'day', date: '2026-02-30' }, '2026-09-24', 3).kind, 'all', 'a bad date falls back to ALL, and says so');
  assert.equal(placeRange({ kind: 'day', date: '2026-02-30' }, '2026-09-24', 3).clamped, 'bad-date');
  assert.equal(placeSelectionFromParams((k) => ({ from: '2026-09-01' })[k] ?? null).to, '2026-09-01', 'one end given is a one-day range');
});

test('inPlaceRange: an open start is "from the first day we hold"', () => {
  assert.equal(inPlaceRange('2020-01-01', { from: null, to: '2026-09-27' }), true);
  assert.equal(inPlaceRange('2026-09-28', { from: null, to: '2026-09-27' }), false);
  assert.equal(inPlaceRange('nope', { from: null, to: null }), false);
});

// ── THE VIEW ─────────────────────────────────────────────────────────────────

const dayOf = (date, stops, source = 'sealed') => ({ date, source, stops });

test('EVERY COUNT IS OVER EVERY MATCH; ONLY THE LIST IS CUT, AND ONLY AT A DAY BOUNDARY', () => {
  const days = [];
  for (let d = 1; d <= 12; d++) {
    const date = `2026-08-${String(d).padStart(2, '0')}`;
    days.push(dayOf(date, Array.from({ length: 5 }, (_, i) => ({ ...stop('1 MAIN ST'), stopNbr: `${date}-${i}`, loadStopSeq: i }))));
  }
  const v = buildPlaceView({ query: placeQuery({ addr: '1 Main St' }), today: '2026-09-24', days, cap: 23 });
  assert.equal(v.matched, 60);
  assert.equal(v.totals.stops, 60, 'the tiles count everything');
  assert.equal(v.shown, 20, 'four whole days — a fifth would pass 23');
  assert.equal(v.hiddenDays, 8);
  for (const d of v.days) assert.equal(d.rows.length, 5, 'no day is cut in half');
  assert.equal(v.days[0].date, '2026-08-12', 'newest first');
  assert.deepEqual(v.span, { from: '2026-08-01', to: '2026-08-12' });
  // The first day is shown whatever its size — an empty list over a non-empty answer reads as none.
  const big = buildPlaceView({ query: placeQuery({ addr: '1 Main St' }), today: '2026-09-24', days: days.slice(0, 1), cap: 2 });
  assert.equal(big.shown, 5);
});

test('THE SAME ADDRESS FILED UNDER ANOTHER TOWN IS REPORTED, AND NOT COUNTED', () => {
  const days = [dayOf('2026-09-15', [stop('1100 NORTHSIDE DR NW', 'ATLANTA'), stop('1100 NORTHSIDE DR', 'SANDY SPRINGS'), stop('9 OTHER RD', 'SANDY SPRINGS')])];
  const v = buildPlaceView({ query: placeQuery({ addr: '1100 Northside Dr', city: 'Sandy Springs' }), today: '2026-09-24', days });
  assert.equal(v.matched, 1);
  assert.deepEqual(v.otherCities, [{ city: 'ATLANTA', state: 'GA', stops: 1 }]);
  // With only a CITY typed, "matches except the city" is every stop — so only the cities that
  // START with what was typed are offered, and never merged into the count.
  const c = buildPlaceView({
    query: placeQuery({ city: 'Peachtree' }), today: '2026-09-24',
    days: [dayOf('2026-09-15', [stop('1 A', 'PEACHTREE CITY'), stop('2 B', 'PEACHTREE CORNERS'), stop('3 C', 'ATLANTA')])],
  });
  assert.equal(c.matched, 0);
  assert.deepEqual(c.otherCities.map((x) => x.city).sort(), ['PEACHTREE CITY', 'PEACHTREE CORNERS']);
});

test('months run oldest to newest; addresses and cities busiest first; drivers carry delivered vs carried', () => {
  const days = [
    dayOf('2026-07-02', [stop('1 MAIN ST', 'X', '30318', { driverName: 'A' })]),
    dayOf('2026-09-02', [stop('1 MAIN ST', 'X', '30318', { driverName: 'A' }), stop('2 MAIN ST', 'X', '30318', { driverName: 'B', normalizedStatus: 'EXCEPTION' }), stop('1 MAIN ST', 'Y', '30318', { driverName: 'A' })]),
  ];
  const v = buildPlaceView({ query: placeQuery({ zip: '30318' }), today: '2026-09-24', days });
  assert.deepEqual(v.months.map((m) => [m.month, m.stops]), [['2026-07', 1], ['2026-09', 3]]);
  assert.equal(v.addresses[0].stops, 3, '1 MAIN ST, whichever city it was filed under');
  assert.equal(v.addressCount, 2);
  assert.deepEqual(v.cities.map((c) => [c.city, c.stops]), [['X', 3], ['Y', 1]]);
  assert.deepEqual(v.drivers.find((d) => d.driver === 'B'), { driver: 'B', stops: 1, delivered: 0 });
});

// ── THE STORE AND THE REBUILD ────────────────────────────────────────────────

test('STOP_SEARCH is the house switch: default ON, off-words off, anything malformed stays ON', () => {
  assert.equal(stopSearchEnabled({}), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' No ']) assert.equal(stopSearchEnabled({ STOP_SEARCH: v }), false, v);
  for (const v of ['on', '1', 'yes', 'of', 'nope', '']) assert.equal(stopSearchEnabled({ STOP_SEARCH: v }), true, `"${v}" must not switch it off`);
});

test('the digest is read a calendar month at a time — across a year end, and never an unbounded loop', () => {
  assert.deepEqual(monthWindows('2026-11-20', '2027-01-05'), [
    { from: '2026-11-20', to: '2026-11-30' }, { from: '2026-12-01', to: '2026-12-31' }, { from: '2027-01-01', to: '2027-01-05' },
  ]);
  assert.deepEqual(monthWindows('2026-09-10', '2026-09-10'), [{ from: '2026-09-10', to: '2026-09-10' }]);
  assert.deepEqual(monthWindows('2026-09-10', '2026-09-01'), []);
  assert.deepEqual(monthWindows('bad', '2026-09-01'), []);
  assert.ok(monthWindows('1900-01-01', '2100-01-01').length <= 240);
});

test('the date query is ONE field, >= from and < the day after — served by Firestore\'s automatic index', () => {
  const q = dateRangeQuery('history_search', '2026-09-01', '2026-09-30');
  const f = q.where.compositeFilter.filters;
  assert.deepEqual(f.map((x) => [x.fieldFilter.field.fieldPath, x.fieldFilter.op, x.fieldFilter.value.stringValue]), [
    ['date', 'GREATER_THAN_OR_EQUAL', '2026-09-01'], ['date', 'LESS_THAN', '2026-10-01'],
  ]);
  assert.equal(dateRangeQuery('history_search', null, null).where, undefined, 'no bounds is no filter');
  assert.deepEqual(dateRangeQuery('history_days', null, '2026-09-30', ['date']).select, { fields: [{ fieldPath: 'date' }] });
});

test('THE REBUILD PLAN: missing days oldest first, ten a call, and where to resume', () => {
  const sealed = ['2026-06-04', '2026-06-05', '2026-06-06', '2026-06-08', '2026-06-09'];
  const p = rebuildPlan({ mode: 'missing', sealed, indexed: ['2026-06-05'], max: 2 });
  assert.deepEqual(p.dates, ['2026-06-04', '2026-06-06'], 'oldest missing first, the indexed one skipped');
  assert.equal(p.remaining, 2);
  assert.equal(p.alreadyIndexed, 1);
  const span = rebuildPlan({ mode: 'span', sealed, indexed: ['2026-06-05'], max: 3 });
  assert.deepEqual(span.dates, ['2026-06-04', '2026-06-05', '2026-06-06'], 'a span is an explicit redo — indexed days included');
  assert.equal(span.next, '2026-06-08', 'and says where the next call starts');
  assert.equal(rebuildPlan({ mode: 'date', sealed, indexed: [], date: '2026-06-07' }).refusal !== null, true, 'an unsealed day is refused, not indexed half-captured');
  assert.deepEqual(rebuildPlan({ mode: 'date', sealed, indexed: [], date: '2026-06-06' }).dates, ['2026-06-06']);
});

// ── THE WIRING ───────────────────────────────────────────────────────────────

test('THE NIGHTLY HOOK IS REGISTERED, LAST, AND BEHIND ITS SWITCH', () => {
  const PS = readFileSync(new URL('../netlify/functions/lib/history-postseal.mts', import.meta.url), 'utf8');
  const hooks = PS.slice(PS.indexOf('const HOOKS'), PS.indexOf('];', PS.indexOf('const HOOKS')));
  const names = [...hooks.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(names[names.length - 1], 'stop-search', 'last — nothing else reads it, so it can delay nothing');
  const STORE = readFileSync(new URL('../netlify/functions/lib/stop-search-store.mts', import.meta.url), 'utf8');
  assert.match(STORE, /if \(!stopSearchEnabled\(\)\) return \{ skipped: 'STOP_SEARCH=off' \};/);
});

test('THE SCREEN: both searches on screen at once, ALL as the unremembered default, and the shared module to ask with', () => {
  // v1.63.0 — Chad, on v1.62.0's tabs: "why would you put on two tabs when there is tons of blank
  // screen". ONE panel holds both forms; nothing on this screen hides a search behind a tab.
  const screen = CODE.slice(CODE.indexOf('function StopLookupScreen'));
  const panel = CODE.slice(CODE.indexOf('function StopSearchPanel'), CODE.indexOf('function StopRecentLookups'));
  assert.doesNotMatch(screen.slice(0, screen.indexOf('\n}\n')), /role="tablist"/, 'no tabs on Stop lookup');
  assert.match(panel, /aria-label="Search by order or customer"/);
  assert.match(panel, /aria-label="Search by address, city or ZIP"/);
  // THREE since v1.69.0 — a driver's week runs across the bottom of the same panel.
  assert.match(panel, /aria-label="A driver's week of loads"/);
  assert.equal((panel.match(/<form /g) || []).length, 3, 'one form per search, so Enter runs the search the cursor is in');
  // The two submit buttons are named apart — the guards (and a screen reader) find each by name.
  assert.match(panel, /'Look up'/);
  assert.match(panel, /'Find stops'/);
  // Dates start on ALL and are NOT written to localStorage — a remembered day would narrow
  // tomorrow's search without anybody choosing to.
  // TODAY since v1.70.0 — Chad: "i want it to default to today". Still never remembered.
  assert.match(CODE, /const \[placeSel, setPlaceSel\] = useState\(\{ period: 'today' \}\);/);
  assert.doesNotMatch(CODE, /localStorage\.setItem\([^)]*placeSel/);
  assert.match(CODE, /apiFetch\(`\/\.netlify\/functions\/stop-lookup\?\$\{placeParams\(f, placeSelOf\(selNow, todayInET\(\)\)\)\}`\)/);
  // TWO VIEWS: the answer renders the phone cards and the desktop table, off one component.
  const results = CODE.slice(CODE.indexOf('function PlaceResults'), CODE.indexOf('const STOP_LOOKUP_PLACE'));
  assert.match(results, /<CustomerDayCards key=\{day\.date\}/);
  assert.match(results, /<CustomerDayTable key=\{day\.date\}/);
  // The unsearched days are named on screen, not only in the ledger.
  assert.match(results, /cov\.complete === false/);
  // And the answer is reachable from the order panel, like every other list on this screen.
  assert.match(CODE, /<PlaceResults data=\{data\} stacked=\{isMobile\} onOrder=\{openOrder\} renderDetail=\{renderOrderPanel\}/);
});

test('A SWITCHED-OFF SEARCH SAYS SO — it never renders as "no stops there"', () => {
  const results = CODE.slice(CODE.indexOf('function PlaceResults'), CODE.indexOf('const STOP_LOOKUP_PLACE'));
  assert.match(results, /if \(data\.switchedOff\) \{/);
  assert.match(results, /Nothing was searched/);
});

test('BOTH LAYOUT GUARDS DRIVE THE ADDRESS SEARCH, off a fixture the real view builder produced', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ PLACE_VIEW \} from '\.\/lib\/place-search-fixture\.mjs';/, f);
    assert.match(src, /\/\[\?&\]\(addr\|city\|zip\)=\/\.test\(u\) \? PLACE_VIEW/, `${f} must stub the place answer`);
    assert.match(src, /name: 'an address searched'/, `${f} must probe it`);
    assert.match(src, /name: 'an address searched over a range'/, `${f} must probe the range form`);
    assert.match(src, /every stop at/i, `${f} must PROVE the answer rendered`);
    // v1.63.0: the form is on screen beside the order box — no tab to pick — and its button is
    // named apart from the order box's, so the probe cannot press the wrong search.
    assert.doesNotMatch(src, /getByRole\('tab', \{ name: \/address or city\/i \}\)/, `${f} still looks for the old tab`);
    assert.match(src, /\/\^find stops\$\/i/, `${f} must press the address form's own button`);
    assert.match(src, /name: 'recent lookups listed'/, `${f} must measure the landing with its list`);
  }
  const fx = readFileSync(new URL('../scripts/lib/place-search-fixture.mjs', import.meta.url), 'utf8');
  assert.match(fx, /buildPlaceView\(/, 'built by the real view builder, not typed');
});

test('the rebuild has the 26 seconds its ten days need', () => {
  const TOML = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(TOML, /\[functions\."history-search-rebuild"\]\s*\n\s*timeout = 26/);
});
