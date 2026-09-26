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

// ── THE DAY EACH LOAD ROW CARRIES (the Monday-roster investigation, 2026-09-26) ──
import { gridDay, tallyLoadDays } from '../netlify/functions/lib/load-columns.mts';

test('the grid\'s own date formats read as the day they name — and nothing else does', () => {
  assert.equal(gridDay('9/2/26 11:59 PM'), '2026-09-02');
  assert.equal(gridDay('09/28/2026'), '2026-09-28');
  assert.equal(gridDay('2026-09-28T08:00:00'), '2026-09-28');
  assert.equal(gridDay(''), null);
  assert.equal(gridDay(null), null, 'null is no date, never 1970');
  assert.equal(gridDay('13/40/26'), null);
  assert.equal(gridDay('DAVIS000203100'), null);
  assert.equal(gridDay('4159'), null, 'a weight is not a date');
});

test('a window pull says which loads sit on Monday, by the column that carries the day, and counts the blanks', () => {
  const j = grid([
    ['KeyColumn', 'KeyColumn'], ['name', 'Load Name'], ['schEndTime', 'Load Latest Departure'],
    ['createdTime', 'Load Created Dttm'], ['load.weight', 'Load - Weight'],
  ], [
    ['a1', 'CHE', '9/28/26 11:59 PM', '9/25/26 05:10 PM', '7804'],
    ['a2', 'DARVIN', '9/28/26 11:59 PM', '9/26/26 10:01 AM', '6750'],
    ['a3', 'TRAILER 3', '', '9/26/26 10:02 AM', ''],
    ['a4', 'DIXON', '9/25/26 11:59 PM', '9/25/26 05:19 AM', '4159'],
  ]);
  const t = tallyLoadDays(j, '2026-09-28');
  assert.deepEqual(t.columns.schEndTime.byDay, { '2026-09-25': 1, '2026-09-28': 2 });
  assert.equal(t.columns.schEndTime.blank, 1, 'an empty trailer with no departure is counted, not dropped silently');
  assert.deepEqual(t.onDate.schEndTime, ['CHE', 'DARVIN']);
  assert.equal(t.columns['load.weight'], undefined, 'a numeric column is not mistaken for a date column');
  assert.deepEqual(t.columns.createdTime.byDay, { '2026-09-25': 2, '2026-09-26': 2 });
});

test('an empty grid tallies to nothing rather than throwing', () => {
  const t = tallyLoadDays(grid([['KeyColumn', 'K'], ['name', 'Load Name']], []), '2026-09-28');
  assert.deepEqual(t.columns, {});
  assert.deepEqual(t.onDate, {});
});
