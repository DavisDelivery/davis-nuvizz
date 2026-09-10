// test/nuvizz-loads.test.mjs — the load-list anchor (per-day loadId). Pure helpers only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLoads, looksLikeLoadNbr, dropForeignLoadStops, stopLoadId, buildLoadBody, cleanDriverName } from '../netlify/functions/lib/nuvizz-loads.mts';

// A response shaped like the portal HAR: filterData column-defs + values rows, with the
// loadId in KeyColumn and the route name link-wrapped. No load-number column here.
const SAMPLE = {
  filterData: [{ KeyColumn: 0, name: 1, status: 2, noOfTrips: 3 }],
  values: [
    ['6a3560cb_VINCENT', JSON.stringify({ columnValue: 'VINCENT' }), 'Dispatched', 21],
    ['6a3560cb_WILLIAM', JSON.stringify({ columnValue: 'WILLIAM' }), 'In-Progress', 15],
    ['', 'EMPTY', 'Draft', 0], // no loadId → dropped from the roster
  ],
};

test('normalizeLoads: reads loadId (KeyColumn) + link-wrapped name + status + trips (loadNbr null when no number column)', () => {
  const rows = normalizeLoads(SAMPLE);
  assert.deepEqual(rows, [
    { loadId: '6a3560cb_VINCENT', name: 'VINCENT', loadNbr: null, status: 'Dispatched', driver: '', trips: 21 },
    { loadId: '6a3560cb_WILLIAM', name: 'WILLIAM', loadNbr: null, status: 'In-Progress', driver: '', trips: 15 },
  ]);
  assert.deepEqual(normalizeLoads({}), []);
});

test('looksLikeLoadNbr: DAVIS-prefixed / long-numeric are numbers; route names / hex are not', () => {
  assert.equal(looksLikeLoadNbr('DAVIS000198197'), true);
  assert.equal(looksLikeLoadNbr('007141059'), true);
  assert.equal(looksLikeLoadNbr('SUW'), false);
  assert.equal(looksLikeLoadNbr('BEN 2'), false);       // space → not a number
  assert.equal(looksLikeLoadNbr('6a3560cb52ef82bd1ed4516b'), false); // hex loadId
  assert.equal(looksLikeLoadNbr(''), false);
});

test('normalizeLoads: captures the numeric Load Number as loadNbr, keeps the route NAME distinct (label match)', () => {
  const rows = normalizeLoads({
    filterData: [{
      KeyColumn: { columnName: 'Key' },
      'route.name': { columnName: 'Load Name' },
      'route.loadNbr': { columnName: 'Load Number' },
      status: { columnName: 'Load Status' },
      noOfTrips: { columnName: 'No Of Trips' },
    }],
    values: [
      ['6a3560cb_SUW', JSON.stringify({ columnValue: 'SUW' }), 'DAVIS000198197', 'Draft', 10],
    ],
  });
  assert.deepEqual(rows, [
    { loadId: '6a3560cb_SUW', name: 'SUW', loadNbr: 'DAVIS000198197', status: 'Draft', driver: '', trips: 10 },
  ]);
});

test('normalizeLoads: finds the Load Number by VALUE shape even when the column is not labelled as a number', () => {
  const rows = normalizeLoads({
    filterData: [{ KeyColumn: {}, 'route.name': {}, some_col: {}, status: {} }],
    values: [
      ['6a3560cb_MORGAN', JSON.stringify({ columnValue: 'MORGAN' }), 'DAVIS000198196', 'Dispatched'],
    ],
  });
  assert.deepEqual(rows, [
    { loadId: '6a3560cb_MORGAN', name: 'MORGAN', loadNbr: 'DAVIS000198196', status: 'Dispatched', driver: '', trips: null },
  ]);
});

test('stopLoadId: reads raw.load.loadId, falls back to loadId, else null', () => {
  assert.equal(stopLoadId({ raw: { load: { loadId: 'X' } } }), 'X');
  assert.equal(stopLoadId({ loadId: 'Y' }), 'Y');
  assert.equal(stopLoadId({ routeName: 'BEN 2' }), null);
});

test('dropForeignLoadStops: drops prior-day foreign-load stops, keeps today + id-less', () => {
  const today = '2026-06-25';
  const ids = new Set(['6a3560cb_today']);
  const stops = [
    { stopNbr: 'A', boardDate: today, raw: { load: { loadId: '6a3560cb_today' } } },   // today's load → keep
    { stopNbr: 'B', boardDate: today, routeName: 'BEN 2' },                              // no id yet → keep
    { stopNbr: 'C', boardDate: '2026-06-24', raw: { load: { loadId: '6a340f6_yday' } } }, // prior-day foreign id → DROP
    { stopNbr: 'D', boardDate: today, raw: { load: { loadId: '6a340f6_yday' } } },        // foreign id but dated TODAY → keep (not provably prior)
  ];
  const kept = dropForeignLoadStops(stops, ids, today).map((s) => s.stopNbr);
  assert.deepEqual(kept, ['A', 'B', 'D']);
});

test('dropForeignLoadStops: empty id set is a NO-OP (load list unavailable → board unharmed)', () => {
  const stops = [{ stopNbr: 'A', raw: { load: { loadId: 'whatever' } } }];
  assert.equal(dropForeignLoadStops(stops, new Set()).length, 1);
});

test('buildLoadBody: period as a JSON STRING in seq1, the captured saved-load def id', () => {
  const b = buildLoadBody('0d');
  // openapi deserializes value as a String → must be JSON-stringified, not a raw object.
  assert.deepEqual(b.filterList[0], { sequence: 1, value: '{"period":"0d"}' });
  assert.equal(b.customListDefId, 35833);
  assert.equal(b.canSelect, true);
  assert.equal(b.page, 1);
});

// ── THE DRIVER NUVIZZ ALREADY KNOWS ────────────────────────────────────────────────────────
//
// Chad, on the portal's Loads grid beside our board: "Our roster scan shows who the driver is
// for the load, why are we not using that? The loads are not dispatched but they do already
// have the driver assignment." The rows below are HIS grid — the same saved search the roster
// pull sends, route names that are mostly the driver's own surname, and two loads (ESTES,
// ALPHA 2) whose driver cell is empty because nobody is on them yet. Those two are the whole
// operational point: before this, every one of the fifty shells read blank, so the two that
// genuinely need a driver were invisible among the forty-eight that do not.
const GRID = {
  filterData: [{
    KeyColumn: { columnName: 'Key' },
    'route.name': { columnName: 'Load Name' },
    'route.loadNbr': { columnName: 'Load Number' },
    noOfTrips: { columnName: 'Load - Total Cartons' },
    status: { columnName: 'Load Status' },
    'route.driver.name': { columnName: 'Driver Name' },
  }],
  values: [
    ['hex_SHEATS', JSON.stringify({ columnValue: 'SHEATS' }), 'DAVIS000203725', 8, 'Draft', JSON.stringify({ columnValue: 'Sirdedrick Sheats' })],
    ['hex_STEVEN', JSON.stringify({ columnValue: 'STEVEN' }), 'DAVIS000203724', 0, 'Draft', 'Steven Adjetey'],
    ['hex_ESTES', JSON.stringify({ columnValue: 'ESTES' }), 'DAVIS000203722', 8, 'Draft', ''],
    ['hex_ALPHA2', JSON.stringify({ columnValue: 'ALPHA 2' }), 'DAVIS000203707', 0, 'Draft', 'Enter driver name'],
  ],
};

test("the roster scan keeps the driver NuVizz already assigned — Chad's loads grid, drivers and all", () => {
  const rows = normalizeLoads(GRID);
  assert.deepEqual(rows.map((r) => [r.name, r.driver]), [
    ['SHEATS', 'Sirdedrick Sheats'],   // link-wrapped, like the route name beside it
    ['STEVEN', 'Steven Adjetey'],      // a plain string in the same column — both shapes occur
    ['ESTES', ''],                     // genuinely unassigned: nobody is on this trailer
    ['ALPHA 2', ''],                   // the widget's own prompt is not a person
  ]);
  // The driver never displaces the fields that were already right.
  assert.deepEqual(rows[0], {
    loadId: 'hex_SHEATS', name: 'SHEATS', loadNbr: 'DAVIS000203725',
    status: 'Draft', driver: 'Sirdedrick Sheats', trips: 8,
  });
});

test('an unassigned load reads as unassigned: the grid’s "Enter driver name" prompt is never a driver', () => {
  // The row a dispatcher is hunting for is the one with NOBODY on it. Letting the placeholder
  // through would make that row look staffed and bury it among the forty-eight that are.
  for (const v of ['Enter driver name', 'ENTER DRIVER NAME', ' enter  driver  name ', 'Unassigned', 'none', 'N/A', '—'.replace('—', '--'), '']) {
    assert.equal(cleanDriverName(v), '', `expected "${v}" to read as no driver`);
  }
  assert.equal(cleanDriverName(null), '');
  assert.equal(cleanDriverName(undefined), '');
});

test('a driverId is never shown as a driver name (#254 put an ObjectId on the board)', () => {
  assert.equal(cleanDriverName('6a3560cb52ef82bd1ed4516b'), '');   // Mongo ObjectId
  assert.equal(cleanDriverName('DAVIS000203725'), '');             // a mislabelled load-number column
  assert.equal(cleanDriverName('Sirdedrick Sheats'), 'Sirdedrick Sheats');
  assert.equal(cleanDriverName('  Che Roberts  '), 'Che Roberts'); // trimmed, not rejected
  assert.equal(cleanDriverName('AB'), 'AB');                       // a two-letter route driver is a real name
});

test('the driver column is preferred by NAME, and an id-only driver column yields no driver rather than jibberish', () => {
  const idOnly = normalizeLoads({
    filterData: [{ KeyColumn: {}, 'route.name': { columnName: 'Load Name' }, 'route.driver.driverId': { columnName: 'Driver' } }],
    values: [['hex_A', 'BEN 2', '6a3560cb52ef82bd1ed4516b']],
  });
  assert.deepEqual(idOnly.map((r) => [r.name, r.driver]), [['BEN 2', '']]);

  // Both columns present: the NAME one wins, whatever order they arrive in.
  const both = normalizeLoads({
    filterData: [{
      KeyColumn: {}, 'route.name': { columnName: 'Load Name' },
      'route.driver.driverId': { columnName: 'Driver Id' },
      'route.driver.name': { columnName: 'Driver Name' },
    }],
    values: [['hex_B', 'BEN 2', '6a3560cb52ef82bd1ed4516b', 'Colin Calhoun']],
  });
  assert.deepEqual(both.map((r) => [r.name, r.driver]), [['BEN 2', 'Colin Calhoun']]);
});

test('a load list with no driver column still parses — absent is unknown, never a guess off another cell', () => {
  // The route names at Davis ARE mostly driver surnames ("SHEATS", "THARP"), so a row-wide hunt
  // for "something that looks like a name" would confidently return the route name as the
  // driver. The driver is read from its column or not at all.
  const rows = normalizeLoads({
    filterData: [{ KeyColumn: {}, 'route.name': { columnName: 'Load Name' }, status: { columnName: 'Status' } }],
    values: [['hex_THARP', 'THARP', 'Dispatched']],
  });
  assert.deepEqual(rows.map((r) => [r.name, r.driver]), [['THARP', '']]);
});

test('the route name never becomes the driver’s name when the grid labels no column "Load Name"', () => {
  // route.driver.name ends in ".name", which the route-name matcher's second tier accepts. On a
  // saved search with no load-name label, every load on the board would have been relabelled
  // with the person driving it.
  const rows = normalizeLoads({
    filterData: [{ KeyColumn: {}, 'route.driver.name': { columnName: 'Driver Name' }, 'route.loadNbr': { columnName: 'Load Number' } }],
    values: [['hex_C', 'Marcus Crumpton', 'DAVIS000203717']],
  });
  assert.deepEqual(rows.map((r) => [r.name, r.driver]), [['', 'Marcus Crumpton']]);
});

test('a "Driver Status" column never becomes the LOAD\'s status', () => {
  // /status/ matches "Driver Status" too, and Object.keys order decides which column wins. The
  // load's own status is what puts Draft or Dispatched on the board, so losing it to the
  // driver's would mis-state every row.
  const rows = normalizeLoads({
    filterData: [{
      KeyColumn: {},
      'route.driver.status': { columnName: 'Driver Status' },
      'route.name': { columnName: 'Load Name' },
      status: { columnName: 'Load Status' },
      'route.driver.name': { columnName: 'Driver Name' },
    }],
    values: [['hex_A', 'ON_DUTY', 'SHEATS', 'Draft', 'Sirdedrick Sheats']],
  });
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.driver]), [['SHEATS', 'Draft', 'Sirdedrick Sheats']]);
});
