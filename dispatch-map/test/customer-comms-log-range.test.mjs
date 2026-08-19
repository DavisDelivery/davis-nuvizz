// test/customer-comms-log-range.test.mjs
//
// The send log's date ranges and rollups. Chad, Aug 2026: the history "needs to be done
// by the day and have ranges and months, not just a long compilation of all the emails
// that we've sent. We need to be able to sort it."
//
// The things that go wrong here are quiet ones — a range that silently returns fewer days
// than asked for reads as "that month was quiet" when it was never looked at, and a
// per-day row missing for a day that WAS read reads the same way. So these pin:
//
//   • the day set is explicit, bounded, and says when it was clipped
//   • a month stops at today rather than listing days that have not happened
//   • a day that was read and found nothing still gets a zero row
//   • the month totals are summed from the day rows, so the two cannot disagree
//   • bad input (a 13th month, a 45th day, reversed bounds) never throws
//
// Everything here is PURE — no Firestore, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MONTH_RE, MAX_LOG_DAYS,
  monthRange, datesInRange, resolveLogRange,
  tallyEntries, rollupByDay, rollupByMonth, recentMonths,
} from '../netlify/functions/lib/customer-comms.mts';

const TODAY = '2026-08-19';

// ── MONTHS ───────────────────────────────────────────────────────────────────

test('a month resolves to its true first and last day', () => {
  assert.deepEqual(monthRange('2026-08'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(monthRange('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' }, 'leap year');
  assert.deepEqual(monthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' }, 'year boundary');
});

test('a month that is not a month is rejected, not thrown on', () => {
  // MONTH_RE pins the SHAPE; '2026-13' passes it and is still not a month.
  assert.ok(MONTH_RE.test('2026-13'), 'sanity: the pattern really does admit it');
  for (const bad of ['2026-13', '2026-00', '', 'August', '2026-8', '2026-08-01', null, undefined]) {
    assert.equal(monthRange(bad), null, `monthRange(${JSON.stringify(bad)})`);
  }
});

// ── RANGES ───────────────────────────────────────────────────────────────────

test('a range is inclusive of both ends and newest first', () => {
  const r = datesInRange('2026-08-17', '2026-08-19');
  assert.deepEqual(r.dates, ['2026-08-19', '2026-08-18', '2026-08-17']);
  assert.equal(r.requested, 3);
  assert.equal(r.clipped, false);
  assert.equal(r.from, '2026-08-17');
  assert.equal(r.to, '2026-08-19');
});

test('a single day is a range of one', () => {
  const r = datesInRange('2026-08-19', '2026-08-19');
  assert.deepEqual(r.dates, ['2026-08-19']);
  assert.equal(r.requested, 1);
});

test('reversed bounds are swapped, not treated as empty', () => {
  const r = datesInRange('2026-08-19', '2026-08-17');
  assert.deepEqual(r.dates, ['2026-08-19', '2026-08-18', '2026-08-17'],
    'a from/to the wrong way round is a slip; an empty log is a bad way to report it');
});

test('a range crossing a month and a year boundary is continuous', () => {
  const r = datesInRange('2026-12-30', '2027-01-02');
  assert.deepEqual(r.dates, ['2027-01-02', '2027-01-01', '2026-12-31', '2026-12-30']);
});

test('THE QUIET ONE: an over-long range is clipped, keeps the NEWEST days, and says so', () => {
  const r = datesInRange('2020-01-01', '2026-08-19');
  assert.equal(r.dates.length, MAX_LOG_DAYS, 'bounded — every day costs two Firestore reads');
  assert.equal(r.clipped, true, 'a silently shortened range reads as "that period was quiet"');
  assert.ok(r.requested > MAX_LOG_DAYS);
  assert.equal(r.dates[0], '2026-08-19', 'the most recent day survives the clip');
  assert.equal(r.to, '2026-08-19');
  assert.equal(r.from, r.dates[r.dates.length - 1], 'from reflects what was READ, not what was asked');
});

test('a malformed range returns nothing rather than throwing', () => {
  // '2026-13-45' is four-two-two digits and sails through DATE_RE, but Date#toISOString
  // THROWS on it rather than returning something wrong.
  for (const [a, b] of [['2026-13-45', '2026-08-19'], ['2026-08-19', '2026-02-30'],
                        ['', '2026-08-19'], ['nope', 'nope'], [null, undefined]]) {
    const r = datesInRange(a, b);
    assert.deepEqual(r.dates, [], `datesInRange(${a}, ${b})`);
    assert.equal(r.clipped, false);
  }
});

// ── WHICH DAYS DOES A REQUEST MEAN ───────────────────────────────────────────

test('?date= wins, and means exactly that day', () => {
  const r = resolveLogRange({ date: '2026-07-04', month: '2026-08', days: 30 }, TODAY);
  assert.equal(r.mode, 'date');
  assert.deepEqual(r.dates, ['2026-07-04'], 'most specific parameter wins');
});

test('?month= means the whole month — but the CURRENT month stops at today', () => {
  const past = resolveLogRange({ month: '2026-07' }, TODAY);
  assert.equal(past.mode, 'month');
  assert.equal(past.dates.length, 31);
  assert.equal(past.to, '2026-07-31');

  const current = resolveLogRange({ month: '2026-08' }, TODAY);
  assert.equal(current.to, TODAY, 'must not list days that have not happened yet');
  assert.equal(current.from, '2026-08-01');
  assert.equal(current.dates.length, 19);
});

test('a month in the future is empty, not the whole month', () => {
  const r = resolveLogRange({ month: '2026-12' }, TODAY);
  assert.deepEqual(r.dates, [], 'zero-send rows for days that have not happened invite the wrong reading');
});

test('?from=/?to= with one end given runs to today', () => {
  const openEnd = resolveLogRange({ from: '2026-08-15' }, TODAY);
  assert.equal(openEnd.mode, 'range');
  assert.equal(openEnd.to, TODAY);
  assert.equal(openEnd.from, '2026-08-15');
  assert.equal(openEnd.dates.length, 5);

  const onlyTo = resolveLogRange({ to: '2026-08-15' }, TODAY);
  assert.deepEqual(onlyTo.dates, ['2026-08-15'], 'a lone ?to= is that single day');
});

test('?days= counts back from today INCLUSIVE, and is bounded', () => {
  const wk = resolveLogRange({ days: 7 }, TODAY);
  assert.equal(wk.mode, 'days');
  assert.equal(wk.dates.length, 7);
  assert.equal(wk.dates[0], TODAY, 'newest first');
  assert.equal(wk.from, '2026-08-13');

  assert.deepEqual(resolveLogRange({ days: 1 }, TODAY).dates, [TODAY]);
  assert.deepEqual(resolveLogRange({}, TODAY).dates, [TODAY], 'no parameters at all = today');
  assert.equal(resolveLogRange({ days: 9999 }, TODAY).dates.length, MAX_LOG_DAYS);
  assert.equal(resolveLogRange({ days: -5 }, TODAY).dates.length, 1, 'a negative window is not a backwards one');
  assert.equal(resolveLogRange({ days: 'abc' }, TODAY).dates.length, 1);
});

test('an unusable today yields nothing rather than a wrong range', () => {
  for (const bad of ['', 'today', '2026-13-45', null]) {
    assert.deepEqual(resolveLogRange({ days: 7 }, bad).dates, []);
  }
});

// ── ROLLUPS ──────────────────────────────────────────────────────────────────

const E = (date, ok, claimed) => ({ date, ok, claimed, at: `${date}T12:00:00Z` });

test('the three outcomes are counted apart', () => {
  const t = tallyEntries([
    E('2026-08-19', true), E('2026-08-19', true),
    E('2026-08-19', false, true),          // claimed but never confirmed — NOT a clean failure
    E('2026-08-19', false, false),
  ]);
  assert.deepEqual(t, { total: 4, sent: 2, failed: 1, inflight: 1 });
  assert.deepEqual(tallyEntries([]), { total: 0, sent: 0, failed: 0, inflight: 0 });
  assert.deepEqual(tallyEntries(null), { total: 0, sent: 0, failed: 0, inflight: 0 });
});

test('THE QUIET ONE: a day that was read and found nothing still gets a zero row', () => {
  const dates = ['2026-08-19', '2026-08-18', '2026-08-17'];
  const rows = rollupByDay(dates, [E('2026-08-19', true), E('2026-08-17', false, false)]);
  assert.deepEqual(rows.map((r) => r.date), dates, 'newest first, every day read is present');
  assert.deepEqual(rows[1], { date: '2026-08-18', total: 0, sent: 0, failed: 0, inflight: 0 },
    '"we looked and it was quiet" is not the same answer as "that day is not in this range"');
  assert.equal(rows[0].sent, 1);
  assert.equal(rows[2].failed, 1);
});

test('an entry outside the range cannot invent a day row', () => {
  const rows = rollupByDay(['2026-08-19'], [E('2026-08-19', true), E('2026-01-01', true)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 1);
});

test('month totals are summed from the day rows, so the two cannot disagree', () => {
  const dates = ['2026-08-02', '2026-08-01', '2026-07-31', '2026-07-30'];
  const entries = [
    E('2026-08-02', true), E('2026-08-01', true), E('2026-08-01', false, true),
    E('2026-07-31', true), E('2026-07-30', false, false),
  ];
  const days = rollupByDay(dates, entries);
  const months = rollupByMonth(days);

  assert.deepEqual(months.map((m) => m.month), ['2026-08', '2026-07'], 'newest first');
  assert.deepEqual(
    { total: months[0].total, sent: months[0].sent, inflight: months[0].inflight, days: months[0].days },
    { total: 3, sent: 2, inflight: 1, days: 2 },
  );
  assert.equal(months[1].failed, 1);
  assert.equal(months[1].days, 2, 'days counts days READ in that month, not the length of the month');

  const sum = (k) => months.reduce((n, m) => n + m[k], 0);
  const dsum = (k) => days.reduce((n, d) => n + d[k], 0);
  for (const k of ['total', 'sent', 'failed', 'inflight']) {
    assert.equal(sum(k), dsum(k), `${k} must agree between the day and month rollups`);
  }
});

test('rollups survive junk without throwing', () => {
  assert.deepEqual(rollupByDay([], []), []);
  assert.deepEqual(rollupByMonth([]), []);
  assert.deepEqual(rollupByMonth([{ date: 'nonsense', total: 1, sent: 1, failed: 0, inflight: 0 }]), [],
    'a row with no readable month is dropped, not counted under a bogus one');
});

// ── THE MONTH PICKER ─────────────────────────────────────────────────────────

test('the offered months run back from the current one', () => {
  const m = recentMonths(TODAY, 3);
  assert.deepEqual(m, ['2026-08', '2026-07', '2026-06']);
  assert.equal(recentMonths(TODAY).length, 12, 'a year by default');
  assert.equal(recentMonths(TODAY, 14)[13], '2025-07', 'walks back across the year boundary');
  assert.deepEqual(recentMonths('nope'), []);
});
