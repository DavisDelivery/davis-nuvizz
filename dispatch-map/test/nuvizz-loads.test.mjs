// test/nuvizz-loads.test.mjs — the load-list anchor (per-day loadId). Pure helpers only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLoads, looksLikeLoadNbr, dropForeignLoadStops, stopLoadId, buildLoadBody } from '../netlify/functions/lib/nuvizz-loads.mts';

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
    { loadId: '6a3560cb_VINCENT', name: 'VINCENT', loadNbr: null, status: 'Dispatched', trips: 21, vehicleType: null },
    { loadId: '6a3560cb_WILLIAM', name: 'WILLIAM', loadNbr: null, status: 'In-Progress', trips: 15, vehicleType: null },
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
    { loadId: '6a3560cb_SUW', name: 'SUW', loadNbr: 'DAVIS000198197', status: 'Draft', trips: 10, vehicleType: null },
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
    { loadId: '6a3560cb_MORGAN', name: 'MORGAN', loadNbr: 'DAVIS000198196', status: 'Dispatched', trips: null, vehicleType: null },
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

// ── THE LOAD'S OWN EQUIPMENT ─────────────────────────────────────────────────
//
// Chad, 2026-09-02: "Loads should not be classed as tractor trailer or box truck only by the
// driver who ends up assigned to them." The only thing entitled to class a load is the load's
// own vehicle type. The live grid does not carry that column today (measured: 21 columns, none
// of them a vehicle type) — so this is matched BY PATTERN and lights up with no deploy the day
// the column is added to the saved search.

test('a Vehicle Type column is read when the saved search carries one — by label OR by key', () => {
  const grid = (col, label) => normalizeLoads({
    filterData: [{ KeyColumn: { columnName: 'Key' }, 'route.name': { columnName: 'Load Name' }, [col]: { columnName: label } }],
    values: [['id1', 'BRENT', 'TRACTOR TRAILER']],
  })[0];
  assert.equal(grid('load.vehType', 'Vehicle Type').vehicleType, 'TRACTOR TRAILER', 'found by label');
  assert.equal(grid('load.vehicleType', 'Equipment').vehicleType, 'TRACTOR TRAILER', 'found by key');
  assert.equal(grid('load.equipmentType', 'Equipment Type').vehicleType, 'TRACTOR TRAILER');
  assert.equal(grid('load.truckType', 'Truck Type').vehicleType, 'TRACTOR TRAILER');
});

test('a trailer/tractor NUMBER column is not mistaken for a vehicle TYPE — a unit id is not a class', () => {
  const r = normalizeLoads({
    filterData: [{ KeyColumn: { columnName: 'Key' }, 'route.name': { columnName: 'Load Name' },
                   trailerNbr: { columnName: 'Trailer Number' }, tractorId: { columnName: 'Tractor Id' } }],
    values: [['id1', 'BRENT', '234TRCNBR', '123TRI']],
  })[0];
  assert.equal(r.vehicleType, null);
});

test('the live grid as it stands today reads null — no vehicle type, and no guess in its place', () => {
  // The 21 real columns from nuvizz_ops/load_columns__2026-09-02.
  const cols = ['KeyColumn','name','load.ref','driver.driverId','status','noOfTrips','load.totalCtn','load.volume',
    'load.totalPlt','schEndTime','load.weight','load.origin','actStartTime','updatedTime','actEndTime','load.proNbr',
    'statusDTTM','createdTime','plannedDist','rteNbr','canSelect'];
  const r = normalizeLoads({
    filterData: [Object.fromEntries(cols.map((c) => [c, { columnName: c }]))],
    values: [['6a97ea13', 'DIXON', '', 'Brent Dixon', 'In-Progress', '11', '13', '10', '23', '', '4159', '', '', '', '', '', '', '', '32.44', 'DAVIS000203100', '']],
  })[0];
  assert.equal(r.vehicleType, null, 'no column, no value — never inferred from the driver beside it');
  assert.equal(r.loadNbr, 'DAVIS000203100', 'but the load NUMBER is there, which is the key to /load/info');
  assert.equal(r.name, 'DIXON');
});
