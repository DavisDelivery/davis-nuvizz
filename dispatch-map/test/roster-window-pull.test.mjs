// test/roster-window-pull.test.mjs — A FUTURE DAY'S ROSTER IS A WINDOW READ DOWN TO ITS DAY.
//
// Chad, Saturday 2026-09-26, Monday's board with CHE, DARVIN, DENIS SALKIC, MARCUS, SCOTT and
// VICTOR planned and a roster of 0: "every roster scan on friday should be picking up monday
// and tuesdays loads". Four calls measured why: NuVizz answers "+2d"/"+3d" with HTTP 200 and
// zero rows, and "+/-7d" with 959 loads — 90 on Monday by Load Latest Departure. These pin the
// rule that replaces the offset, and drive the REAL loadRosterPull against a stubbed socket.
//
// ZERO NuVizz calls: the vendor is a function in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  rosterPullPlan, filterLoadGridToDay, rosterWindowEnabled, gridDay, loadRosterPull,
  ROSTER_WINDOW_PERIOD, ROSTER_WINDOW_MAX,
} from '../netlify/functions/lib/nuvizz-loads.mts';
import { explainRosterRow } from '../netlify/functions/lib/roster-write.mts';

process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';

// The load grid's real shape (columns as stored from the 2026-09-02 capture), trimmed.
const COLS = [
  ['KeyColumn', 'KeyColumn'], ['name', 'Load Name'], ['driver.driverId', 'Driver Name'],
  ['status', 'Load Status'], ['noOfTrips', 'Total Stops'], ['schEndTime', 'Load Latest Departure'],
  ['createdTime', 'Load Created Dttm'], ['rteNbr', 'Load Number'],
];
const grid = (rows, cols = COLS) => ({
  filterData: [Object.fromEntries(cols.map(([k, label]) => [k, { columnName: label }]))],
  values: rows,
});
const row = (id, name, dep, nbr, trips = '0', driver = '') => [id, name, driver, 'Draft', trips, dep, '9/19/26 05:10 AM', nbr];
const WINDOW = grid([
  row('a1', 'CHE', '9/28/26 11:59 PM', 'DAVIS000204901', '14', 'Che Roberts'),
  row('a2', 'DARVIN', '9/28/26 11:59 PM', 'DAVIS000204902', '13', 'Darvin Cepeda'),
  row('a3', 'TRAILER 3', '9/28/26 11:59 PM', 'DAVIS000204903'),
  row('b1', 'CHE', '9/29/26 11:59 PM', 'DAVIS000205001'),          // Tuesday's CHE: a different load
  row('c1', 'CHE', '9/25/26 11:59 PM', 'DAVIS000204701', '12'),    // Friday's, already run
]);

test('Saturday asks for Monday as a WINDOW, not "+2d" — and today still asks "0d"', () => {
  assert.deepEqual(rosterPullPlan('2026-09-28', '2026-09-26'), { period: '+/-7d', day: '2026-09-28', pageSize: ROSTER_WINDOW_MAX });
  assert.deepEqual(rosterPullPlan('2026-09-29', '2026-09-25').period, '+/-7d', 'Friday → Tuesday is a window too');
  const today = rosterPullPlan('2026-09-26', '2026-09-26');
  assert.equal(today.period, '0d');
  assert.equal(today.day, null, 'the proven daily pull is kept whole');
});

test('beyond a week nothing was measured, so the old period is kept rather than guessed at', () => {
  const p = rosterPullPlan('2026-10-06', '2026-09-26');
  assert.equal(p.period, '+10d');
  assert.equal(p.day, null);
});

test('ROSTER_WINDOW_PULL=off puts the offset back; a typo leaves the fix ON', () => {
  assert.equal(rosterPullPlan('2026-09-28', '2026-09-26', false).period, '+2d');
  for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(rosterWindowEnabled({ ROSTER_WINDOW_PULL: v }), false, v);
  for (const v of [undefined, '', 'on', 'of. ', 'yes']) assert.equal(rosterWindowEnabled({ ROSTER_WINDOW_PULL: v }), true, String(v));
});

test('the window is cut to the rows that DEPART that day — Tuesday\'s and Friday\'s CHE stay out', () => {
  const { grid: g, windowRows } = filterLoadGridToDay(WINDOW, '2026-09-28');
  assert.equal(windowRows, 5);
  assert.deepEqual(g.values.map((r) => r[0]), ['a1', 'a2', 'a3'], 'the empty trailer is kept: it departs Monday too');
});

test('a grid with no Load Latest Departure column is REFUSED — a fortnight is never written as one day', () => {
  const noDay = grid([['x1', 'CHE']], [['KeyColumn', 'KeyColumn'], ['name', 'Load Name']]);
  assert.throws(() => filterLoadGridToDay(noDay, '2026-09-28'), /no Load Latest Departure column/);
  // …but an EMPTY grid is just an empty answer, handled by the write guard like any other.
  assert.equal(filterLoadGridToDay(grid([], [['KeyColumn', 'K']]), '2026-09-28').windowRows, 0);
});

test('gridDay reads the grid\'s date formats and nothing else', () => {
  assert.equal(gridDay('9/28/26 11:59 PM'), '2026-09-28');
  assert.equal(gridDay(null), null);
  assert.equal(gridDay('DAVIS000204901'), null);
});

test('END TO END: loadRosterPull sends +/-7d with the window cap and returns ONLY Monday\'s loads', async () => {
  const sent = [];
  const h = installFirestoreFake({}, async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    return new Response(JSON.stringify(WINDOW), { status: 200 });
  });
  try {
    const { loads, pull } = await loadRosterPull('2026-09-28', '2026-09-26');
    assert.equal(sent.length, 1, 'ONE call, same as before');
    assert.match(sent[0].url, /entity\/filterdata\/PkgRoute\//);
    assert.equal(JSON.parse(sent[0].body.filterList[0].value).period, ROSTER_WINDOW_PERIOD);
    assert.equal(sent[0].body.maxResult, ROSTER_WINDOW_MAX);
    assert.deepEqual(loads.map((l) => l.name), ['CHE', 'DARVIN', 'TRAILER 3']);
    assert.equal(loads[0].loadNbr, 'DAVIS000204901', 'Monday\'s CHE, with the number a Compare card saves to');
    assert.equal(loads[0].driver, 'Che Roberts');
    assert.deepEqual({ period: pull.period, rows: pull.rows, kept: pull.kept, day: pull.day }, { period: '+/-7d', rows: 5, kept: 3, day: '2026-09-28' });
  } finally { h.restore?.(); }
});

test('END TO END: a window AT its row cap THROWS, so the replace-write never lands a partial day', async () => {
  const full = grid(Array.from({ length: ROSTER_WINDOW_MAX }, (_, i) => row(`z${i}`, `L${i}`, '9/28/26 11:59 PM', `DAVIS0009${String(i).padStart(5, '0')}`)));
  const h = installFirestoreFake({}, async () => new Response(JSON.stringify(full), { status: 200 }));
  try {
    await assert.rejects(loadRosterPull('2026-09-28', '2026-09-26'), /AT the \d+ cap/);
  } finally { h.restore?.(); }
});

test('END TO END: today is unchanged — "0d", default cap, every row kept', async () => {
  const sent = [];
  const h = installFirestoreFake({}, async (url, init) => {
    sent.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify(WINDOW), { status: 200 });
  });
  try {
    const { loads, pull } = await loadRosterPull('2026-09-28', '2026-09-28');
    assert.equal(JSON.parse(sent[0].filterList[0].value).period, '0d');
    assert.equal(sent[0].maxResult, 500);
    assert.equal(loads.length, 5, 'the 0d pull is not filtered');
    assert.equal(pull.day, null);
  } finally { h.restore?.(); }
});

test('the roster explain says what a window pull did — never "the parser kept none" on a day with no loads', () => {
  const r = explainRosterRow('2026-09-27', { at: 'x', loads: [], pull: { period: '+/-7d', httpStatus: 200, cols: 21, rows: 959, kept: 0, drivers: 0, day: '2026-09-27' } });
  assert.equal(r.pullNote, '0 of the 959 load(s) in window +/-7d depart 2026-09-27');
  const m = explainRosterRow('2026-09-28', { at: 'x', loads: [{ name: 'CHE' }], pull: { period: '+/-7d', httpStatus: 200, cols: 21, rows: 959, kept: 90, drivers: 80, day: '2026-09-28' } });
  assert.equal(m.pullNote, '90 of the 959 load(s) in window +/-7d depart 2026-09-28');
  // An old offset document still reads as it always did.
  const old = explainRosterRow('2026-09-28', { at: 'x', loads: [], pull: { period: '+2d', httpStatus: 200, cols: 21, rows: 0, kept: 0 } });
  assert.match(old.pullNote, /ZERO rows for period \+2d/);
});
