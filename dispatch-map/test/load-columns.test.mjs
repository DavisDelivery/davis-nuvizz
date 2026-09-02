// ONE LOOK AT THE RAW LOAD LIST — the summary has to answer both open questions by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLoadColumns } from '../netlify/functions/lib/load-columns.mts';

const grid = (cols, rows) => ({
  filterData: [Object.fromEntries(cols.map(([k, label]) => [k, { columnName: label }]))],
  values: rows,
  totalRecords: rows.length,
});

test('a vehicle-type column is found by key OR label, and the first rows come back unwrapped', () => {
  const j = grid([
    ['KeyColumn', 'Key'], ['route.name', 'Route Name'], ['load.loadNbr', 'Load Number'],
    ['x.vt', 'Vehicle Type'], ['status', 'Status'], ['trips', 'Trips'],
  ], [
    ['6a1b', '{"columnValue":"BRENT"}', 'DAVIS000198197', 'TRACTOR TRAILER', 'PLANNED', '18'],
    ['6a1c', 'MARCUS', 'DAVIS000198198', 'TRACTOR TRAILER', 'PLANNED', '18'],
  ]);
  const s = summarizeLoadColumns(j);
  assert.deepEqual(s.vehicleColumns, [{ key: 'x.vt', label: 'Vehicle Type' }]);
  assert.equal(s.rowCount, 2);
  assert.equal(s.firstRows[0]['route.name'], 'BRENT', 'link objects are unwrapped');
  assert.equal(s.firstRows[0]['x.vt'], 'TRACTOR TRAILER');
  assert.equal(s.normalizedCount, 2);
  assert.match(s.verdict, /2 loads normalised/);
  assert.match(s.verdict, /vehicle-type column present: x\.vt/);
});

test('ZERO rows is called out as the list/period matching nothing — the state every day on file was in', () => {
  const s = summarizeLoadColumns(grid([['KeyColumn', 'Key'], ['route.name', 'Route Name']], []));
  assert.equal(s.rowCount, 0);
  assert.match(s.verdict, /ZERO rows/);
  assert.match(s.verdict, /NO vehicle-type column/);
});

test('rows that normalizeLoads cannot key are called out separately from an empty list', () => {
  // Rows exist, but the id cell is blank on every one: normalizeLoads drops them all. (It
  // falls back to the FIRST column as the id when nothing is labelled — so the only way it
  // keeps nothing from a non-empty grid is an id column that is present and empty. Measured.)
  const j = grid([['KeyColumn', 'Key'], ['route.name', 'Route Name']], [['', 'BRENT'], ['', 'MARCUS']]);
  const s = summarizeLoadColumns(j);
  assert.equal(s.rowCount, 2);
  assert.equal(s.normalizedCount, 0);
  assert.match(s.verdict, /kept none/);
});

test('a response with no column definitions is named as the wrong shape, never summarised as "no loads"', () => {
  const s = summarizeLoadColumns({ status: 'Success', message: 'x' });
  assert.equal(s.columnCount, 0);
  assert.deepEqual(s.topLevelKeys, ['status', 'message']);
  assert.match(s.verdict, /no filterData column definitions/);
});

test('long values are truncated so the stored record stays small', () => {
  const j = grid([['KeyColumn', 'Key'], ['blob', 'Blob']], [['id1', 'x'.repeat(500)]]);
  const s = summarizeLoadColumns(j, { maxValue: 20 });
  assert.equal(s.firstRows[0].blob.length, 21);
});
