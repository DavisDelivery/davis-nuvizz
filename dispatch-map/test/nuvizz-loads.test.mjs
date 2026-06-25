// test/nuvizz-loads.test.mjs — the load-list anchor (per-day loadId). Pure helpers only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLoads, dropForeignLoadStops, stopLoadId, buildLoadBody } from '../netlify/functions/lib/nuvizz-loads.mts';

// A response shaped like the portal HAR: filterData column-defs + values rows, with the
// loadId in KeyColumn and the route name link-wrapped.
const SAMPLE = {
  filterData: [{ KeyColumn: 0, name: 1, status: 2, noOfTrips: 3 }],
  values: [
    ['6a3560cb_VINCENT', JSON.stringify({ columnValue: 'VINCENT' }), 'Dispatched', 21],
    ['6a3560cb_WILLIAM', JSON.stringify({ columnValue: 'WILLIAM' }), 'In-Progress', 15],
    ['', 'EMPTY', 'Draft', 0], // no loadId → dropped from the roster
  ],
};

test('normalizeLoads: reads loadId (KeyColumn) + link-wrapped name + status + trips', () => {
  const rows = normalizeLoads(SAMPLE);
  assert.deepEqual(rows, [
    { loadId: '6a3560cb_VINCENT', name: 'VINCENT', status: 'Dispatched', trips: 21 },
    { loadId: '6a3560cb_WILLIAM', name: 'WILLIAM', status: 'In-Progress', trips: 15 },
  ]);
  assert.deepEqual(normalizeLoads({}), []);
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

test('buildLoadBody: period in seq1, the captured saved-load def id', () => {
  const b = buildLoadBody('0d');
  assert.deepEqual(b.filterList[0], { sequence: 1, value: { period: '0d' } });
  assert.equal(b.customListDefId, 35833);
  assert.equal(b.page, 1);
});
