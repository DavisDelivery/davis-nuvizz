// The Shiplify trial file, read the way the import screen and the server both read it.
//
// SYNTHETIC FIXTURES ONLY. This repo is public and Davis is under NDA with Shiplify: no row,
// name or address from the real DavisfileResults.xls is ever committed. Every place below is
// invented; the shapes (Excel serial dates, pipe lists, the NBSP in an SHP PRO, a Shipper and
// a Consignee row per PRO) are the file's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  excelDateToIso, cleanPro, cleanText, splitPipe, triState, rowsFromAoa, normalizeShiplifyRow,
  skipReasonOf, mergeLocationRows, groupShiplifyRows, summarizeShiplify, shiplifyBatchId,
  groupChunks, encodeIndexLine, decodeIndexLine, bestTri, SHIPLIFY_COLUMNS,
} from '../src/lib/shiplify-import.js';
import { normalizeMatchKey, normalizePlaceKey } from '../src/lib/matchKey.js';

const NBSP = '\u00a0';

// One file row. Defaults describe an invented consignee with a dock.
function row(o = {}) {
  return {
    shipment_location_id: 1, pro_number: '1000001', pickup_date: 46251, entity: 'Consignee',
    name: 'Example Widget Co', street_address: '100 Sample Pkwy', city: 'Testville', state: 'GA',
    postal_code: '30000', provider_exemption_count: 0, visible_location_types: 'Commercial',
    all_location_types: 'Distribution Center', tariff_items: '', dock_access: 'yes', forklift: '',
    lumper: 'no', gated_access: 'no', security_hut: 'no', call_box: 'no', appointment_required: '',
    ...o,
  };
}
const shipper = (pro) => row({
  pro_number: pro, entity: 'Shipper', name: 'Invented Origin Terminal', street_address: '1 Depot Rd',
  city: 'Origintown', postal_code: '39999', all_location_types: 'Warehouse', dock_access: 'yes',
});
const toAoa = (rows) => [SHIPLIFY_COLUMNS, ...rows.map((r) => SHIPLIFY_COLUMNS.map((c) => r[c]))];

test('Excel serial 46251 is Aug 17, 2026, whichever way the cell arrives', () => {
  assert.equal(excelDateToIso(46251), '2026-08-17');
  assert.equal(excelDateToIso('46251'), '2026-08-17');
  assert.equal(excelDateToIso(46251.75), '2026-08-17', 'a time of day never moves the date');
  assert.equal(excelDateToIso('2026-08-17'), '2026-08-17');
  assert.equal(excelDateToIso('8/17/2026'), '2026-08-17');
  assert.equal(excelDateToIso('8/17/26'), '2026-08-17');
  assert.equal(excelDateToIso(new Date(Date.UTC(2026, 7, 17))), '2026-08-17');
});

test('a date cell that is not a date is blank, never a wrong date', () => {
  for (const v of ['', null, undefined, 'soon', '2/30/2026', 0, -5, NaN, '13/1/2026']) {
    assert.equal(excelDateToIso(v), '', `${String(v)} must read as no date`);
  }
});

test('the non-breaking space in an "SHP" PRO reads as an ordinary space', () => {
  assert.equal(cleanPro(`SHP${NBSP}00000.00`), 'SHP 00000.00');
  assert.equal(cleanPro('SHP 00000.00'), cleanPro(`SHP${NBSP}00000.00`), 'the two spellings are one PRO');
  assert.equal(cleanPro(1234567), '1234567', 'a 7-digit Uline PRO stored as a number keeps no ".0"');
  assert.equal(cleanPro('ESTES-0000000001'), 'ESTES-0000000001');
  assert.equal(cleanPro('AVRT-0000000002'), 'AVRT-0000000002');
  assert.equal(cleanPro('007000001-1'), '007000001-1');
  assert.equal(cleanText(`  Example${NBSP}${NBSP}Co `), 'Example Co');
});

test('pipe lists split, trim and de-duplicate; tariffs read upper-case', () => {
  assert.deepEqual(splitPipe('Place of Worship|School'), ['Place of Worship', 'School']);
  assert.deepEqual(splitPipe(' School | |School'), ['School']);
  assert.deepEqual(splitPipe(''), []);
  assert.deepEqual(splitPipe(null), []);
  assert.deepEqual(normalizeShiplifyRow(row({ tariff_items: 'res|LIM' })).tariff_items, ['RES', 'LIM']);
});

test('yes/no/blank stays three answers, and gated keeps "partial"', () => {
  assert.equal(triState('yes'), 'yes');
  assert.equal(triState('No'), 'no');
  assert.equal(triState(''), '');
  assert.equal(triState('maybe'), '', 'an unrecognised answer is blank, not a no');
  assert.equal(triState('partial'), '', 'only gated_access has a partial');
  assert.equal(triState('partial', { partial: true }), 'partial');
});

test('the header is found under a title row, and blank rows are not rows', () => {
  const aoa = [['Davis file results'], [], ...toAoa([row(), row({ pro_number: '1000002' })]), ['', '', ''], []];
  const { rows, missing, header } = rowsFromAoa(aoa);
  assert.equal(rows.length, 2);
  assert.deepEqual(missing, []);
  assert.equal(header[0], 'shipment_location_id');
  assert.equal(rows[0].pickup_date, 46251, 'the raw layer keeps the cell exactly as the sheet gave it');
});

test('a sheet without the required columns is refused, and says which', () => {
  const { missing } = rowsFromAoa([['pro_number', 'entity', 'name'], ['1', 'Consignee', 'X']]);
  assert.ok(missing.includes('street_address'));
  assert.ok(missing.includes('dock_access'));
  assert.deepEqual(rowsFromAoa([['a', 'b'], [1, 2]]).rows, [], 'no header at all → nothing read');
});

test('a header that names one of the file\'s columns TWICE is refused — the later column would silently replace the consignee\'s name', () => {
  // 20 Shiplify columns plus an extra "Name" (a contact person) in column U.
  const aoa = [[...SHIPLIFY_COLUMNS, 'Name'], [...SHIPLIFY_COLUMNS.map((c) => row()[c]), 'Contact Person']];
  const parsed = rowsFromAoa(aoa);
  assert.deepEqual(parsed.duplicate, [{ name: 'name', columns: ['E', 'U'] }]);
  assert.ok(parsed.missing.length > 0, 'the import screen refuses on `missing`, so an ambiguous column must land there');
  assert.match(parsed.missing.join(' '), /name.*E, U/);
  assert.equal(parsed.rows[0].name, 'Example Widget Co', 'and the later column never overwrote the first');
});

test('the raw layer keeps an unlabelled column and a cell past the header\'s width, under the column\'s letter', () => {
  const header = [...SHIPLIFY_COLUMNS, '', 'Notes', 'notes'];
  const cells = [...SHIPLIFY_COLUMNS.map((c) => row()[c]), 'unlabelled note', 'n1', 'n2', 'past the header'];
  const blankish = [...SHIPLIFY_COLUMNS.map((c) => row({ pro_number: '1000002' })[c]), '', '', '', ''];
  const { rows, missing, duplicate } = rowsFromAoa([header, cells, blankish]);
  assert.deepEqual(missing, []);
  assert.deepEqual(duplicate, [], 'a repeated column that is not one of Shiplify\'s is kept, not refused');
  assert.equal(rows[0].col_U, 'unlabelled note');
  assert.equal(rows[0].notes, 'n1');
  assert.equal(rows[0].col_W, 'n2', 'the second "notes" column is kept under its own letter');
  assert.equal(rows[0].col_X, 'past the header');
  assert.equal('col_U' in rows[1], false, 'an empty cell under a blank header adds nothing');
  assert.equal(rows[1].notes, '', 'a labelled column keeps its empty cells, as before');
});

test('keys are the app\'s own match key and place key over the file\'s own fields', () => {
  const n = normalizeShiplifyRow(row());
  assert.equal(n.match_key, normalizeMatchKey('Example Widget Co', '100 Sample Pkwy', 'Testville', '30000'));
  assert.equal(n.place_key, normalizePlaceKey('100 Sample Pkwy', '30000'));
  assert.equal(n.pickup_date, '2026-08-17');
});

test('Shipper rows stay in raw and never become a location', () => {
  const raw = [shipper('1000001'), row({ pro_number: '1000001' }), shipper('1000002'), row({ pro_number: '1000002' })];
  const g = groupShiplifyRows(raw);
  assert.equal(g.total, 4, 'every row is accounted for');
  assert.equal(g.byEntity.shipper, 2);
  assert.equal(g.byEntity.consignee, 2);
  assert.equal(g.skippedByReason.shipper_row, 2);
  assert.equal(g.groups.size, 1, 'two PROs to one consignee are one location');
  for (const list of g.groups.values()) for (const r of list) assert.equal(r.entity, 'consignee');
});

test('a consignee row that cannot be keyed is skipped with its reason', () => {
  assert.equal(skipReasonOf(normalizeShiplifyRow(row({ name: '' }))), 'no_name');
  assert.equal(skipReasonOf(normalizeShiplifyRow(row({ street_address: ' ' }))), 'no_street');
  assert.equal(skipReasonOf(normalizeShiplifyRow(row({ postal_code: '' }))), 'no_zip');
  assert.equal(skipReasonOf(normalizeShiplifyRow(row({ entity: 'Broker' }))), 'unknown_entity');
  assert.equal(skipReasonOf(normalizeShiplifyRow(row({ entity: '' }))), 'no_entity');
  assert.equal(skipReasonOf(normalizeShiplifyRow(row())), '');
});

test('dock: yes beats no beats blank, whatever order the PROs come in', () => {
  const at = (dock) => normalizeShiplifyRow(row({ dock_access: dock }));
  const perms = [['yes', 'no', ''], ['no', 'yes', ''], ['', 'no', 'yes'], ['no', '', 'yes']];
  for (const p of perms) assert.equal(mergeLocationRows(p.map(at)).dock_access, 'yes', p.join(','));
  assert.equal(mergeLocationRows(['', 'no'].map(at)).dock_access, 'no');
  assert.equal(mergeLocationRows(['', ''].map(at)).dock_access, '');
  assert.equal(bestTri(['no', 'partial']), 'partial');
});

test('forklift: yes beats no beats blank', () => {
  const at = (fk) => normalizeShiplifyRow(row({ dock_access: 'no', forklift: fk }));
  assert.equal(mergeLocationRows(['no', 'yes'].map(at)).forklift, 'yes');
  assert.equal(mergeLocationRows(['', 'no'].map(at)).forklift, 'no');
  assert.equal(mergeLocationRows(['', ''].map(at)).forklift, '');
});

test('a disagreement between PROs is recorded, not silently resolved', () => {
  const loc = mergeLocationRows([
    normalizeShiplifyRow(row({ dock_access: 'yes' })),
    normalizeShiplifyRow(row({ dock_access: 'no', forklift: 'yes' })),
  ]);
  assert.deepEqual(loc.conflicts.dock_access, ['no', 'yes']);
  assert.equal(loc.conflicts.forklift, undefined, 'one answer plus a blank is not a conflict');
  const agree = mergeLocationRows([normalizeShiplifyRow(row()), normalizeShiplifyRow(row())]);
  assert.deepEqual(agree.conflicts, {});
});

test('lists union, residential comes from RES, and an Apartment type makes it an apartment', () => {
  const loc = mergeLocationRows([
    normalizeShiplifyRow(row({ all_location_types: 'Residential', tariff_items: 'RES' })),
    normalizeShiplifyRow(row({ all_location_types: 'Apartment Complex|Residential', tariff_items: 'LIM' })),
  ]);
  assert.deepEqual(loc.location_types, ['Apartment Complex', 'Residential']);
  assert.deepEqual(loc.tariff_items, ['LIM', 'RES']);
  assert.equal(loc.residential, true);
  assert.equal(loc.residential_kind, 'apartment');
  const home = mergeLocationRows([normalizeShiplifyRow(row({ all_location_types: 'Residential', tariff_items: 'RES' }))]);
  assert.equal(home.residential_kind, 'home');
  const biz = mergeLocationRows([normalizeShiplifyRow(row())]);
  assert.equal(biz.residential, false);
  assert.equal(biz.residential_kind, null);
});

test('pros, stop count and the date span come from every row', () => {
  const loc = mergeLocationRows([
    normalizeShiplifyRow(row({ pro_number: '1000002', pickup_date: 46255 })),
    normalizeShiplifyRow(row({ pro_number: `SHP${NBSP}00000.00`, pickup_date: 46251 })),
    normalizeShiplifyRow(row({ pro_number: '1000002', pickup_date: 46253 })),
  ]);
  assert.deepEqual(loc.pros, ['1000002', 'SHP 00000.00']);
  assert.equal(loc.stop_count, 3);
  assert.equal(loc.first_date, '2026-08-17');
  assert.equal(loc.last_date, '2026-08-21');
});

test('re-importing the same file produces identical documents and the same batch id', () => {
  const raw = [
    shipper('1'), row({ pro_number: '1', dock_access: 'no' }),
    shipper('2'), row({ pro_number: '2', dock_access: 'yes', name: 'Example Widget Co.' }),
    shipper('3'), row({ pro_number: '3', name: 'Second Invented Place', street_address: '5 Fake St' }),
  ];
  const copy = JSON.parse(JSON.stringify(raw));
  assert.equal(shiplifyBatchId(raw), shiplifyBatchId(copy));
  const docs = (rows) => [...groupShiplifyRows(rows).groups.values()].map(mergeLocationRows)
    .map(({ match_key, ...rest }) => [match_key, JSON.stringify(rest)]).sort();
  assert.deepEqual(docs(raw), docs(copy));
  // Order does not decide anything either.
  assert.deepEqual(docs([...raw].reverse()), docs(raw));
  const changed = raw.map((r) => ({ ...r }));
  changed[1].dock_access = 'yes';
  assert.notEqual(shiplifyBatchId(changed), shiplifyBatchId(raw), 'a different file is a different batch');
});

test('two spellings of one place land on one key and are counted as a collision', () => {
  const s = summarizeShiplify([
    row({ pro_number: '1', name: 'Example Widget Co' }),
    row({ pro_number: '2', name: 'EXAMPLE WIDGET CO.' }),
  ]);
  assert.equal(s.locationsByMatchKey, 1);
  assert.equal(s.collisions, 1);
});

test('the summary counts consignee rows the way the brief lists them', () => {
  const raw = [
    shipper('1'), row({ pro_number: '1', tariff_items: 'RES', dock_access: 'yes' }),
    shipper('2'), row({ pro_number: '2', tariff_items: 'LIM|GROC', dock_access: 'no', forklift: 'yes', name: 'B Place', street_address: '2 Fake St' }),
    shipper('3'), row({ pro_number: '3', tariff_items: '', dock_access: '', name: 'C Place', street_address: '2 Fake St' }),
    shipper('4'), row({ pro_number: '4', dock_access: 'no', forklift: 'no', name: 'D Place', street_address: '9 Fake St' }),
  ];
  const s = summarizeShiplify(raw);
  assert.equal(s.rows, 8);
  assert.equal(s.consignee, 4);
  assert.equal(s.shipper, 4);
  assert.deepEqual(s.tariffs, { RES: 1, LIM: 1, GROC: 1 });
  assert.deepEqual(s.dock, { yes: 1, no: 2, blank: 1 });
  assert.equal(s.forkliftNoDock, 1);
  assert.equal(s.locationsByMatchKey, 4);
  assert.equal(s.locationsByPlaceKey, 3, 'B and C share one street + ZIP');
  assert.equal(s.dates.first, '2026-08-17');
});

test('a request never splits one location\'s rows', () => {
  const groups = new Map([
    ['a', [1, 2, 3]], ['b', [1]], ['c', [1, 2]], ['d', [1, 2, 3, 4]],
  ]);
  const chunks = groupChunks(groups, 4);
  const seen = chunks.flat().map((g) => g.match_key);
  assert.deepEqual(seen, ['a', 'b', 'c', 'd'], 'every key once, in key order');
  for (const c of chunks) {
    const n = c.reduce((t, g) => t + g.rows.length, 0);
    assert.ok(n <= 4 || c.length === 1, 'bounded unless a single location is bigger than the bound');
  }
});

test('the compact index line round-trips every fact the map reads', () => {
  const loc = {
    ...mergeLocationRows([normalizeShiplifyRow(row({
      dock_access: 'no', forklift: 'yes', gated_access: 'partial', call_box: 'yes',
      all_location_types: 'Place of Worship|School', tariff_items: 'RES',
    }))]),
    batch_id: 'shp_0123',
  };
  const back = decodeIndexLine(encodeIndexLine(loc));
  for (const f of ['match_key', 'place_key', 'dock_access', 'forklift', 'lumper', 'gated_access', 'security_hut', 'call_box', 'appointment_required', 'batch_id', 'last_date']) {
    assert.deepEqual(back[f], loc[f], f);
  }
  assert.deepEqual(back.location_types, loc.location_types);
  assert.deepEqual(back.tariff_items, ['RES']);
  assert.equal(back.residential, true);
  assert.equal(decodeIndexLine(''), null);
  assert.equal(decodeIndexLine('only\ttwo'), null);
});

test('upload chunks are bounded by rows AND by encoded size, and cover every row once, in order', async () => {
  const { chunkRowsBySize } = await import('../src/lib/shiplify-import.js');
  const rows = Array.from({ length: 2500 }, (_, i) => row({ pro_number: String(i) }));
  const byRows = chunkRowsBySize(rows);
  assert.deepEqual(byRows.map((c) => c.rows.length), [1000, 1000, 500]);
  assert.deepEqual(byRows.map((c) => c.row_start), [0, 1000, 2000]);
  const wide = Array.from({ length: 300 }, (_, i) => row({ pro_number: String(i), all_location_types: 'X'.repeat(5000) }));
  const bySize = chunkRowsBySize(wide, { maxBytes: 200 * 1024 });
  assert.ok(bySize.length > 1, 'wide rows split on size');
  for (const c of bySize) assert.ok(Buffer.byteLength(JSON.stringify(c.rows)) <= 200 * 1024, 'each chunk under the byte cap');
  assert.deepEqual(bySize.flatMap((c) => c.rows), wide, 'every row once, in order');
  let at = 0;
  for (const c of bySize) { assert.equal(c.row_start, at); at += c.rows.length; }
  assert.deepEqual(chunkRowsBySize([]), []);
});

test('the summary counts locations by the place mark the maps will give them, and keeps unknown tariffs', () => {
  const s = summarizeShiplify([
    row({ pro_number: '1', name: 'A School', street_address: '1 A St', all_location_types: 'Place of Worship|School' }),
    row({ pro_number: '2', name: 'A Church', street_address: '2 A St', all_location_types: 'Place of Worship' }),
    row({ pro_number: '3', name: 'A Court', street_address: '3 A St', all_location_types: 'Courthouse' }),
    row({ pro_number: '4', name: 'A Home', street_address: '4 A St', all_location_types: 'Residential', tariff_items: 'RES|HAZ' }),
    row({ pro_number: '5', name: 'A Home', street_address: '4 A St', all_location_types: 'Residential', tariff_items: 'RES' }),
  ]);
  assert.deepEqual(s.placeMarks, { school: 1, church: 1, government: 1, residential: 1 }, 'per LOCATION, not per row');
  assert.deepEqual(s.otherTariffs, { HAZ: 1 });
});
