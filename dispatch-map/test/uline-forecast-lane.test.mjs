// test/uline-forecast-lane.test.mjs
//
// FROM ULINE'S ROWS TO ONE VERSION — and every row that did not make it, counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { laneRows, canonicalRows, versionIdFor, sentDateET, LANE, MIN_LANE_ROWS } from '../src/lib/uline-forecast-lane.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/uline-forecast-2026-08-04.json', import.meta.url), 'utf8'));
/** A ForecastRead shaped like the reader's, from the real Aug-04 rows. */
function readFrom(days, over = {}) {
  const rows = Object.keys(days).sort().map((date) => ({ date, warehouse: 'G', via: 'DA', viaType: 'DA', estimate: days[date][0], upperEst: days[date][1] }));
  return { rows, warnings: [], from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null, sheet: 'ULINEForecast',
    headers: ['date', 'warehouse', 'via', 'viatype', 'estimate', 'upperest'], cols: { date: 0, warehouse: 1, via: 2, viaType: 3, estimate: 4, upperEst: 5 }, dropped: [], ...over };
}

test('THE REAL AUG-04 FILE: every G/DA row kept, Saturdays absent, the weekday shape Uline actually forecasts', () => {
  const v = laneRows(readFrom(FIX.days), '2026-08-04');
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.rowsUsed, 332);
  assert.equal(v.rowsTotal, 332);
  assert.equal(v.from, '2026-07-15');
  assert.equal(v.to, '2027-08-13');
  assert.equal(v.weekdayMeans[6], null, 'no Saturdays');
  assert.equal(v.weekdayMeans[0], 75);
  assert.equal(v.weekdayMeans[1], 665);
  assert.equal(v.weekdayMeans[2], 686);
  assert.equal(v.weekdayMeans[3], 675);
  assert.equal(v.weekdayMeans[4], 643);
  assert.equal(v.weekdayMeans[5], 508);
  assert.ok(v.medianBand >= 55 && v.medianBand <= 70, `Uline's own band is ~62 (got ${v.medianBand})`);
  assert.deepEqual(v.unreadableDates, []);
  assert.deepEqual(v.days['2026-09-01'], [702, 773]);
});

test('ANOTHER WAREHOUSE OR VIA IS COUNTED AND DROPPED, NEVER SUMMED INTO GEORGIA', () => {
  const read = readFrom({ '2026-07-15': [671, 745], '2026-07-16': [630, 702] });
  read.rows.push({ date: '2026-07-15', warehouse: 'K', via: 'DA', viaType: 'DA', estimate: 300, upperEst: 340 });
  read.rows.push({ date: '2026-07-16', warehouse: 'G', via: 'XX', viaType: 'XX', estimate: 900, upperEst: 990 });
  const v = laneRows(read, '2026-07-07');
  assert.deepEqual(v.days['2026-07-15'], [671, 745], 'Georgia kept, K dropped');
  assert.deepEqual(v.days['2026-07-16'], [630, 702], 'Georgia kept, XX dropped');
  assert.deepEqual(v.rowsDropped.otherWarehouse, { K: 1 });
  assert.deepEqual(v.rowsDropped.otherVia, { XX: 1 });
  assert.deepEqual(v.seen, { warehouses: ['G', 'K'], vias: ['DA', 'XX'] });
  // Zero G/DA rows: not a forecast for us, and the reason names what WAS there.
  const foreign = readFrom({});
  for (let i = 1; i <= 25; i++) foreign.rows.push({ date: `2026-07-${String(i).padStart(2, '0')}`, warehouse: 'K', via: 'ZZ', viaType: 'ZZ', estimate: 100, upperEst: 120 });
  const f = laneRows(foreign, '2026-07-07');
  assert.equal(f.ok, false);
  assert.match(f.reason, /0 G\/DA rows \(need 20\) — warehouses seen: K; vias seen: ZZ/);
});

test('a column that is ABSENT keeps the rows; a BLANK cell in a present column is a dropped stray', () => {
  const noLane = readFrom({ '2026-07-15': [671, 745] }, { headers: ['date', 'estimate', 'upperest'], cols: { date: 0, estimate: 1, upperEst: 2 } });
  noLane.rows.forEach((r) => { r.warehouse = null; r.via = null; });
  const a = laneRows(noLane, '2026-07-07');
  assert.deepEqual(a.days['2026-07-15'], [671, 745], 'kept — a re-export with no lane column cannot be hiding another lane');
  assert.match(a.warnings.join(' '), /lane columns absent \(warehouse, via\)/);
  const blank = readFrom({ '2026-07-15': [671, 745] });
  blank.rows.push({ date: '2026-07-16', warehouse: '', via: 'DA', viaType: 'DA', estimate: 5000, upperEst: 5000 }); // a subtotal line
  const b = laneRows(blank, '2026-07-07');
  assert.equal(b.days['2026-07-16'], undefined, 'a blank warehouse in a present column is not Georgia');
  assert.equal(b.rowsDropped.blankLane, 1);
});

test('A DATE OUTSIDE THE SEND WINDOW IS A MISREAD — a two-digit-year slip never files a 1926 forecast', () => {
  const read = readFrom({ '2026-07-15': [671, 745], '1926-07-16': [630, 702], '2028-01-01': [1, 1] });
  const v = laneRows(read, '2026-07-07');
  assert.equal(v.days['1926-07-16'], undefined);
  assert.equal(v.days['2028-01-01'], undefined, '400 days forward is the ceiling');
  assert.equal(v.rowsDropped.outOfWindow, 2);
  assert.deepEqual(v.days['2026-07-15'], [671, 745]);
});

test('MORE THAN 5% REJECTED ROWS IS NOT A FORECAST — refused with the reason, not adopted half-empty', () => {
  const days = {}; for (let i = 0; i < 40; i++) days[`2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`] = [600, 660];
  const read = readFrom(days);
  read.dropped = Array.from({ length: 3 }, (_, i) => ({ row: 50 + i, date: null, reason: 'bad_date', detail: 'x' }));
  const v = laneRows(read, '2026-01-05');
  assert.equal(v.ok, false, '3 of 43 is 7%');
  assert.match(v.reason, /3 of 43 rows could not be read \(7%\)/);
  read.dropped = [{ row: 50, date: null, reason: 'bad_date', detail: 'x' }];
  assert.equal(laneRows(read, '2026-01-05').ok, true, '1 of 41 is 2% — a wart, not a broken file');
});

test('A DAY WITH NO READABLE NUMBER IS NAMED — it is not a closed day', () => {
  // The reader dropped row 41 for 2026-09-16 with "unreadable estimate". The outlook must
  // render "no readable estimate", never "NO ULINE FREIGHT", so the date is carried out.
  const read = readFrom(FIX.days);
  delete read.rows[read.rows.findIndex((r) => r.date === '2026-09-16')];
  read.rows = read.rows.filter(Boolean);
  read.dropped = [{ row: 41, date: '2026-09-16', reason: 'bad_number', detail: 'row 41 (2026-09-16): unreadable estimate "n/a"' }];
  const v = laneRows(read, '2026-08-04');
  assert.equal(v.ok, true);
  assert.deepEqual(v.unreadableDates, ['2026-09-16']);
  assert.equal(v.days['2026-09-16'], undefined);
  assert.equal(v.rowsDropped.badNumber, 1);
});

test('a missing high range is kept and the band falls back to the version median', () => {
  const read = readFrom({ '2026-07-15': [671, 745], '2026-07-16': [630, null], '2026-07-17': [500, 570] });
  const v = laneRows(read, '2026-07-07');
  assert.deepEqual(v.days['2026-07-16'], [630, null]);
  assert.equal(v.medianBand, 72, 'median of 74 and 70');
});

test('IDENTITY IS THE CONTENT: the same sheet forwarded is the same canonical string; one changed number is not', () => {
  const a = canonicalRows({ '2026-07-16': [630, 702], '2026-07-15': [671, 745] });
  const b = canonicalRows({ '2026-07-15': [671, 745], '2026-07-16': [630, 702] });
  assert.equal(a, b, 'insertion order is not identity');
  assert.equal(a, '2026-07-15|671|745\n2026-07-16|630|702');
  assert.notEqual(canonicalRows({ '2026-07-15': [672, 745], '2026-07-16': [630, 702] }), a);
  assert.equal(canonicalRows({ '2026-07-15': [671, null] }), '2026-07-15|671|', 'a missing high is a stable empty field');
  assert.equal(versionIdFor('davis', '2026-08-04', 'abcdef0123456789'), 'davis__2026-08-04__abcdef01');
});

test('THE VERSION DATE IS THE ET DAY IT ARRIVED — 23:30 ET on the 3rd is the 3rd, not the 4th', () => {
  assert.equal(sentDateET(Date.UTC(2026, 8, 4, 3, 30)), '2026-09-03', '03:30 UTC Sep 4 is 23:30 EDT Sep 3');
  assert.equal(sentDateET(1785874602000), '2026-08-04', 'the real Aug-04 email');
  assert.equal(sentDateET(Date.UTC(2026, 0, 4, 4, 30)), '2026-01-03', 'and in EST');
  assert.equal(sentDateET(null), null);
  assert.equal(sentDateET('x'), null);
});

test('a snippet is not a forecast', () => {
  const v = laneRows(readFrom({ '2026-07-15': [671, 745] }), '2026-07-07');
  assert.equal(v.ok, false);
  assert.match(v.reason, new RegExp(`1 ${LANE.warehouse}/${LANE.via} row \\(need ${MIN_LANE_ROWS}\\)`));
});

test('junk in: no rows, no read, still a shaped answer', () => {
  const v = laneRows(null, null);
  assert.equal(v.ok, false);
  assert.deepEqual(v.days, {});
  assert.equal(v.rowsTotal, 0);
  assert.equal(v.medianBand, null);
});
