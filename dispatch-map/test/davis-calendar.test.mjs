// test/davis-calendar.test.mjs
//
// THE DAYS DAVIS DOES NOT RUN. Chad, Sept 2026: "We don't run for memorial labor July 4th 2 days
// at Thanksgiving Christmas Day and Eve and new year day."
//
// This is an operating fact two screens read — the Uline forecast card and the nightly manifest
// check — so it is pinned here, once, rather than inside either feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holidayCalendar, davisClosedDay, davisClosedDays, ulineHolidayOn, parseClosedList, isoWeekday, shiftIso } from '../src/lib/davis-calendar.js';

const names = (y) => [...holidayCalendar(y)].map(([d, h]) => `${d} ${h.name}`);

test("CHAD'S LIST, YEAR BY YEAR — seven closures, and never a weekend", () => {
  assert.deepEqual(names(2026), [
    "2026-01-01 New Year's Day", '2026-05-25 Memorial Day', '2026-07-03 July 4th', '2026-09-07 Labor Day',
    '2026-11-26 Thanksgiving', '2026-11-27 the day after Thanksgiving', '2026-12-24 Christmas Eve', '2026-12-25 Christmas Day',
  ]);
  assert.deepEqual(names(2028), [
    '2028-05-29 Memorial Day', '2028-07-04 July 4th', '2028-09-04 Labor Day',
    '2028-11-23 Thanksgiving', '2028-11-24 the day after Thanksgiving', '2028-12-25 Christmas Day',
  ]);
  // 2028: New Year's Day is a Saturday, observed on Fri 12/31/2027 and listed under that year;
  // Christmas Eve is a Sunday, so there is no working day to take off.
  assert.equal(davisClosedDay('2027-12-31'), "New Year's Day");
  assert.equal(davisClosedDay('2028-12-24'), null, 'Christmas Eve 2028 is a Sunday');
  for (const y of [2026, 2027, 2028, 2029, 2030]) {
    for (const [d] of holidayCalendar(y)) assert.ok(![0, 6].includes(isoWeekday(d)), `${d} is a weekend`);
  }
});

test('OBSERVANCE moves a fixed-date holiday the way payroll moves it; an eve is not shifted', () => {
  assert.equal(davisClosedDay('2026-07-03'), 'July 4th', 'the 4th is a Saturday in 2026');
  assert.equal(davisClosedDay('2027-07-05'), 'July 4th', 'the 4th is a Sunday in 2027');
  assert.equal(davisClosedDay('2028-07-04'), 'July 4th', 'an ordinary Tuesday');
  // Christmas 2027 is a Saturday: its observed Friday IS the 24th, so both names land on one day
  // and are printed together rather than one silently overwriting the other.
  assert.equal(davisClosedDay('2027-12-24'), 'Christmas Eve · Christmas Day');
  assert.equal(davisClosedDay('2027-12-23'), null, 'and Davis runs the Thursday — a question for Chad, not an invention');
});

test('ULINE observes all of it EXCEPT the Friday after Thanksgiving — the one day the two calendars differ', () => {
  for (const d of ['2026-11-26', '2026-12-24', '2026-12-25', '2026-09-07', '2026-05-25', '2026-07-03', '2026-01-01']) {
    assert.ok(ulineHolidayOn(d), `Uline is closed ${d} too`);
    assert.ok(davisClosedDay(d), `and so is Davis`);
  }
  assert.equal(ulineHolidayOn('2026-11-27'), null, 'Uline SHIPS the day after Thanksgiving');
  assert.equal(davisClosedDay('2026-11-27'), 'the day after Thanksgiving', 'Davis does not run it');
  assert.equal(holidayCalendar(2026).get('2026-11-27').uline, false);
});

test('a day that is not on the list is a working day, whatever the country is doing', () => {
  for (const [d, what] of [['2026-01-19', 'Martin Luther King Day'], ['2026-02-16', "Presidents' Day"], ['2026-06-19', 'Juneteenth'], ['2026-10-12', 'Columbus Day'], ['2026-11-11', 'Veterans Day']]) {
    assert.equal(davisClosedDay(d), null, `${what} — Davis runs`);
    assert.equal(ulineHolidayOn(d), null);
  }
});

test('ULINE_DAVIS_CLOSED adds one-off closures, and nothing that is not a date', () => {
  assert.deepEqual(parseClosedList('2026-10-12, 2026-10-13\n2026-13-99  rubbish'), ['2026-10-12', '2026-10-13']);
  assert.deepEqual(parseClosedList(''), []);
  assert.deepEqual(parseClosedList(null), []);
  assert.deepEqual(parseClosedList(undefined), []);
  assert.equal(davisClosedDay('2026-10-12', ['2026-10-12']), 'Davis closed');
  assert.equal(davisClosedDay('2026-10-12'), null);
  // The named holiday KEEPS ITS NAME — the extra list adds days, it does not relabel them, and
  // "Christmas Eve" tells a dispatcher more than "Davis closed" does.
  assert.equal(davisClosedDay('2026-11-26', ['2026-11-26']), 'Thanksgiving');
  assert.equal(davisClosedDay('2026-12-24', ['2026-12-24']), 'Christmas Eve');
});

test('a range lists what it holds, and a bad range is empty rather than a hang', () => {
  assert.deepEqual([...davisClosedDays('2026-11-01', '2026-12-31').keys()], ['2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25']);
  assert.equal(davisClosedDays('2026-12-31', '2026-01-01').size, 0);
  for (const bad of [[null, null], ['nope', '2026-01-01'], ['2026-01-01', 'nope'], [undefined, undefined]]) assert.equal(davisClosedDays(...bad).size, 0);
  assert.equal(holidayCalendar('nope').size, 0);
  assert.equal(holidayCalendar(1800).size, 0);
  assert.equal(davisClosedDay(null), null);
  assert.equal(davisClosedDay('2026-1-1'), null, 'not an ISO date');
});

test('the date helpers read in UTC so a local timezone cannot shift a holiday', () => {
  assert.equal(isoWeekday('2026-11-26'), 4);
  assert.equal(shiftIso('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftIso('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftIso('nope', 1), null);
  assert.equal(isoWeekday('nope'), null);
});
