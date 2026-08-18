// test/customer-comms-sweep-dates.test.mjs
//
// WHICH BOARD DATES THE SCHEDULED SWEEP LOOKS AT.
//
// This is the one piece of judgement in the trigger, and getting it wrong is not
// a cosmetic bug: freight delivered at 23:50 ET is written to YESTERDAY's board,
// and by the next run etDayString() has rolled over. A today-only sweep steps
// straight over that delivery and never returns to it — the customer simply
// never receives the email, on a feature whose entire promise is that it always
// arrives. There is no error, no retry, and nothing in the log to notice.
//
// So: today always, plus yesterday in the early hours, and these tests pin both
// halves against real Eastern-Time instants — including across DST, because the
// window is expressed in ET while the cron that drives it runs in UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sweepDates, dayBefore, YESTERDAY_SWEEP_BEFORE_ET_HOUR, isSweepableBoardDate,
} from '../netlify/functions/lib/customer-comms.mts';

// 04:30 UTC in July = 00:30 EDT (UTC-4) — half an hour after the ET rollover.
const JUST_AFTER_ET_MIDNIGHT_SUMMER = new Date('2026-07-15T04:30:00Z');
// 16:00 UTC in July = 12:00 EDT — the middle of a working day.
const MIDDAY_SUMMER = new Date('2026-07-15T16:00:00Z');
// 05:30 UTC in January = 00:30 EST (UTC-5) — the same ET instant, other side of DST.
const JUST_AFTER_ET_MIDNIGHT_WINTER = new Date('2026-01-15T05:30:00Z');
// 17:00 UTC in January = 12:00 EST.
const MIDDAY_WINTER = new Date('2026-01-15T17:00:00Z');

test('THE LATE-DELIVERY CASE: just after ET midnight, yesterday is swept too', () => {
  const d = sweepDates(JUST_AFTER_ET_MIDNIGHT_SUMMER);
  assert.deepEqual(d, ['2026-07-15', '2026-07-14']);
  // Newest first, so a run cut short has already done the day that matters most.
  assert.equal(d[0], '2026-07-15', 'today leads');
});

test('the same ET instant in WINTER behaves identically — DST must not move the window', () => {
  // 00:30 ET is 04:30 UTC in summer and 05:30 UTC in winter. A window expressed
  // in UTC would be an hour wrong for half the year; this one is expressed in ET.
  const d = sweepDates(JUST_AFTER_ET_MIDNIGHT_WINTER);
  assert.deepEqual(d, ['2026-01-15', '2026-01-14']);
});

test('during the working day only today is swept — yesterday is already done', () => {
  assert.deepEqual(sweepDates(MIDDAY_SUMMER), ['2026-07-15']);
  assert.deepEqual(sweepDates(MIDDAY_WINTER), ['2026-01-15']);
});

test('the early window closes where it says it does, in ET on both sides of DST', () => {
  const at = (utc) => sweepDates(new Date(utc)).length;
  // EDT = UTC-4: 09:59Z is 05:59 ET (inside), 10:00Z is 06:00 ET (outside).
  assert.equal(at('2026-07-15T09:59:00Z'), 2, '05:59 EDT is still inside the window');
  assert.equal(at('2026-07-15T10:00:00Z'), 1, '06:00 EDT is outside');
  // EST = UTC-5: the same ET boundary sits an hour later in UTC.
  assert.equal(at('2026-01-15T10:59:00Z'), 2, '05:59 EST is still inside the window');
  assert.equal(at('2026-01-15T11:00:00Z'), 1, '06:00 EST is outside');
  assert.equal(YESTERDAY_SWEEP_BEFORE_ET_HOUR, 6);
});

test('every date the sweep chooses is one the engine will actually accept', () => {
  // The trigger must never hand sweepDelivered a date its own board-age guard
  // rejects — that would be a run that silently does nothing, every time.
  for (const now of [JUST_AFTER_ET_MIDNIGHT_SUMMER, MIDDAY_SUMMER, JUST_AFTER_ET_MIDNIGHT_WINTER, MIDDAY_WINTER]) {
    const dates = sweepDates(now);
    const today = dates[0];
    for (const d of dates) {
      assert.equal(isSweepableBoardDate(d, today), true, `${d} must be sweepable relative to ${today}`);
    }
  }
});

test('a month boundary does not produce a nonsense yesterday', () => {
  // 04:30Z on the 1st of August = 00:30 EDT on Aug 1; yesterday is July 31.
  assert.deepEqual(sweepDates(new Date('2026-08-01T04:30:00Z')), ['2026-08-01', '2026-07-31']);
  assert.equal(dayBefore('2026-01-01'), '2025-12-31', 'and a year boundary');
  assert.equal(dayBefore('2026-03-01'), '2026-02-28', 'and a non-leap February');
  assert.equal(dayBefore('2024-03-01'), '2024-02-29', 'and a leap one');
});

test('dayBefore refuses junk rather than inventing a date', () => {
  for (const junk of ['', 'nope', '2026-13-45', null, undefined, 42, '20260101']) {
    assert.equal(dayBefore(junk), '', String(junk));
  }
});

test('sweepDates always returns at least today, even if yesterday cannot be computed', () => {
  const d = sweepDates(MIDDAY_SUMMER);
  assert.ok(d.length >= 1);
  assert.match(d[0], /^\d{4}-\d{2}-\d{2}$/);
});
