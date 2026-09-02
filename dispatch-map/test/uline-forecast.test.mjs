// test/uline-forecast.test.mjs
//
// THE FORECAST READER READS WHAT ULINE SENDS, AND SAYS SO WHEN IT CANNOT.
//
// Chad: "compare [the forecasts] to what the manifest actually produce so we can try to
// forecast what is coming." Every number that comparison will ever show starts here, so the
// reader has to find columns by NAME (a re-ordered export must not quietly put the high range
// where the estimate goes), read Uline's M/D/YY dates into the ISO the archive is keyed on,
// and name every row it could not read instead of shortening the list in silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { readUlineForecast, forecastDateToIso, resolveForecastColumns, looksLikeUlineForecast } from '../netlify/functions/lib/uline-forecast.mts';

/** Build a workbook the way Uline's arrives: one sheet, a header row, text dates. */
function book(rows, { sheet = 'ULINEForecast', header = ['date', 'warehouse', 'via', 'viatype', 'estimate', 'upperest'] } = {}) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const ULINE = [
  ['7/15/26', 'G', 'DA', 'DA', '671', '745'],
  ['7/16/26', 'G', 'DA', 'DA', '630', '702'],
  ['7/17/26', 'G', 'DA', 'DA', '500', '574'],
  ['7/19/26', 'G', 'DA', 'DA', '70', '93'],   // a Sunday; Saturdays are simply absent
  ['7/20/26', 'G', 'DA', 'DA', '663', '731'],
];

test('READS ULINE’S FILE AS SENT: header row, M/D/YY ship dates, estimate and high range', () => {
  const r = readUlineForecast(book(ULINE));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.sheet, 'ULINEForecast');
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows[0], { date: '2026-07-15', warehouse: 'G', via: 'DA', viaType: 'DA', estimate: 671, upperEst: 745 });
  assert.equal(r.from, '2026-07-15');
  assert.equal(r.to, '2026-07-20');
  assert.ok(looksLikeUlineForecast({ ...r, rows: Array(20).fill(r.rows[0]) }));
  assert.ok(!looksLikeUlineForecast(r), 'five rows is a snippet, not a 12-month forecast');
});

test('the ISO date is the SAME key the manifest archive uses, so the join is exact', () => {
  // manifestDeliveryDate keys a night on the manifest's mode ship date, YYYY-MM-DD. The
  // forecast's 7/15/26 must land on the identical string or every night compares to nothing.
  assert.equal(forecastDateToIso('7/15/26'), '2026-07-15');
  assert.equal(forecastDateToIso('12/1/2026'), '2026-12-01');
  assert.equal(forecastDateToIso('2026-07-15'), '2026-07-15');
  assert.equal(forecastDateToIso(new Date(Date.UTC(2026, 6, 15))), '2026-07-15');
  assert.equal(forecastDateToIso(46218), '2026-07-15', 'an Excel serial, when the reader hands back the number');
});

test('COLUMNS ARE FOUND BY NAME — a re-ordered export must not put the high range in the estimate', () => {
  const swapped = book(ULINE.map((r) => [r[5], r[4], r[0], r[1]]), { header: ['upperest', 'estimate', 'date', 'warehouse'] });
  const r = readUlineForecast(swapped);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.rows[0].estimate, 671);
  assert.equal(r.rows[0].upperEst, 745);
  assert.equal(r.rows[0].via, null, 'a column that is not there reads as null, not as its neighbour');
});

test('a sheet without a date or estimate column is NOT a forecast, and says which is missing', () => {
  const r = readUlineForecast(book([['x', 1]], { header: ['pro', 'lbs'] }));
  assert.equal(r.rows.length, 0);
  assert.match(r.warnings[0], /no header row with date and estimate/);
  assert.match(r.warnings[0], /pro \| lbs/, 'and shows what it saw instead');
  assert.ok(!looksLikeUlineForecast(r));
});

test('a title line above the header does not defeat the reader', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Uline Forecast — Georgia'], [], ['date', 'estimate', 'upperest'], ['7/15/26', '671', '745']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const r = readUlineForecast(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].date, '2026-07-15');
});

test('EVERY ROW IT CANNOT READ IS NAMED — the list is never quietly shorter', () => {
  const r = readUlineForecast(book([
    ['7/15/26', 'G', 'DA', 'DA', '671', '745'],
    ['not a date', 'G', 'DA', 'DA', '600', '660'],
    ['7/17/26', 'G', 'DA', 'DA', 'n/a', '574'],
    ['7/18/26', 'G', 'DA', 'DA', '-5', '10'],
    ['2/30/26', 'G', 'DA', 'DA', '500', '560'],
    [null, null, null, null, null, null],           // a blank line is not an error
    ['7/20/26', 'G', 'DA', 'DA', '663', '731'],
  ]));
  assert.equal(r.rows.length, 2, 'the two good rows');
  assert.equal(r.warnings.length, 4, 'and four named problems');
  assert.match(r.warnings[0], /row 3: unreadable date "not a date"/);
  assert.match(r.warnings[1], /row 4 \(2026-07-17\): unreadable estimate "n\/a"/);
  assert.match(r.warnings[2], /row 5 \(2026-07-18\): negative estimate/);
  assert.match(r.warnings[3], /row 6: unreadable date "2\/30\/26"/, 'February 30th is not a day');
});

test('a high range below its own estimate is kept AND flagged — a forecast with a wart is still a forecast', () => {
  const r = readUlineForecast(book([['7/15/26', 'G', 'DA', 'DA', '671', '600']]));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].upperEst, 600);
  assert.match(r.warnings[0], /high range 600 is below the estimate 671/);
});

test('the same ship date twice keeps the FIRST and reports the second', () => {
  const r = readUlineForecast(book([
    ['7/15/26', 'G', 'DA', 'DA', '671', '745'],
    ['7/15/26', 'G', 'DA', 'DA', '999', '999'],
  ]));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].estimate, 671);
  assert.match(r.warnings[0], /2026-07-15 \(G\/DA\) appears twice \(first at row 2\)/);
});

test('rows come back sorted by date whatever order they arrived in', () => {
  const r = readUlineForecast(book([ULINE[4], ULINE[0], ULINE[2]]));
  assert.deepEqual(r.rows.map((x) => x.date), ['2026-07-15', '2026-07-17', '2026-07-20']);
});

test('numbers with thousands separators and numeric cells both read', () => {
  const r = readUlineForecast(book([['7/15/26', 'G', 'DA', 'DA', '1,071', 1145]]));
  assert.equal(r.rows[0].estimate, 1071);
  assert.equal(r.rows[0].upperEst, 1145);
});

test('junk bytes are "not a readable workbook", not a crash', () => {
  const r = readUlineForecast(Buffer.from('%PDF-1.4 this is a pdf, not a forecast'));
  assert.equal(r.rows.length, 0);
  assert.ok(r.warnings.length >= 1);
  assert.ok(!looksLikeUlineForecast(r));
});

test('resolveForecastColumns: names are case- and space-insensitive', () => {
  const { cols, missing } = resolveForecastColumns(['Date', ' ESTIMATE ', 'Upper Est']);
  assert.deepEqual(missing, []);
  assert.equal(cols.date, 0);
  assert.equal(cols.estimate, 1);
  assert.equal(cols.upperEst, 2);
});

// ── WHAT THE LANE LAYER NEEDS FROM THE READER ────────────────────────────────

test('A FILE WITH TWO LANES KEEPS EVERY GEORGIA ROW — the duplicate rule is per lane, not per date', () => {
  // Keyed on the date alone, a consolidated export listing warehouse K first would win every
  // day and Georgia would read as "no freight" on ordinary Wednesdays.
  const r = readUlineForecast(book([
    ['7/15/26', 'K', 'XX', 'XX', '300', '340'],
    ['7/15/26', 'G', 'DA', 'DA', '671', '745'],
    ['7/16/26', 'G', 'DA', 'DA', '630', '702'],
    ['7/16/26', 'K', 'XX', 'XX', '310', '350'],
  ]));
  assert.equal(r.rows.length, 4, 'all four rows survive');
  assert.deepEqual(r.rows.filter((x) => x.warehouse === 'G').map((x) => [x.date, x.estimate]), [['2026-07-15', 671], ['2026-07-16', 630]]);
  assert.deepEqual(r.warnings, []);
  // The same lane twice is still a duplicate.
  const dup = readUlineForecast(book([['7/15/26', 'G', 'DA', 'DA', '671', '745'], ['7/15/26', 'G', 'DA', 'DA', '9', '9']]));
  assert.equal(dup.rows.length, 1);
  assert.equal(dup.dropped[0].reason, 'duplicate');
});

test('every dropped row is returned WITH ITS DATE, so a day with no readable number is never mistaken for a closed day', () => {
  const r = readUlineForecast(book([
    ['7/15/26', 'G', 'DA', 'DA', '671', '745'],
    ['7/16/26', 'G', 'DA', 'DA', 'n/a', '702'],
    ['bad', 'G', 'DA', 'DA', '600', '660'],
  ]));
  assert.deepEqual(r.dropped.map((d) => [d.date, d.reason]), [['2026-07-16', 'bad_number'], [null, 'bad_date']]);
  assert.equal(r.dropped[0].row, 3, '1-based, as the spreadsheet shows it');
});

test('the header row and the resolved columns come back, so "column absent" is a fact and not a guess', () => {
  const full = readUlineForecast(book(ULINE));
  assert.deepEqual(full.headers, ['date', 'warehouse', 'via', 'viatype', 'estimate', 'upperest']);
  assert.equal(full.cols.warehouse, 1);
  assert.equal(full.cols.via, 2);
  const noVia = readUlineForecast(book([['7/15/26', '671', '745']], { header: ['date', 'estimate', 'upperest'] }));
  assert.equal(noVia.cols.via, undefined, 'no via column at all');
  assert.equal(noVia.rows[0].via, null);
  // A blank cell in a column that IS present is also null on the row — the caller tells the
  // two apart through `cols`, which is the whole reason it is returned.
  const blankVia = readUlineForecast(book([['7/15/26', 'G', '', 'DA', '671', '745']]));
  assert.equal(blankVia.cols.via, 2);
  assert.equal(blankVia.rows[0].via, null);
  // And a file that is not a forecast still reports what it saw.
  const junk = readUlineForecast(book([['x', 1]], { header: ['pro', 'lbs'] }));
  assert.deepEqual(junk.headers, ['pro', 'lbs']);
});

test('a General-format date cell arrives as the STRING "46220" through raw:false and reads as a serial; d-mmm-yy reads too', () => {
  assert.equal(forecastDateToIso(46220), '2026-07-17');
  assert.equal(forecastDateToIso('46220'), '2026-07-17');
  assert.equal(forecastDateToIso('18-Jul-26'), '2026-07-18');
  assert.equal(forecastDateToIso('18-Jul-2026'), '2026-07-18');
  assert.equal(forecastDateToIso('18-Xyz-26'), null);
  assert.equal(forecastDateToIso('99999'), null, 'outside the plausible serial range');
});
