// test/roster-horizon-freeze.test.mjs
//
// THE THIRD DAY IN THE HORIZON WAS STILL FROZEN AFTER v0.93.4.
//
// v0.93.4 gave the load roster an hour-by-hour schedule on all seven days, which fixed WHEN
// the scanner asks. It did not change what happens once it has asked: every FUTURE date
// short-circuits on futureRosterCaptured, so the first good capture of the ET day stands
// until midnight however many times the roster fires afterwards.
//
// The premise behind that freeze is Chad's, and it is about TOMORROW — "the shells are
// generated up front, the set doesn't change through the day." True there. Not true two or
// three days out, and the weekend Chad reported this on is the case that proves it: from
// Saturday the horizon reaches Tuesday, Monday is Labor Day, and Tuesday's empty trailers
// are not created yet. The 08:00 capture is a list of nothing, and it WAS the answer for the
// rest of the day — which is exactly what both Loads surfaces were faithfully showing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterFreezeApplies, scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';

// Chad's weekend, from the Saturday he was looking at it. LIST_HORIZON_DAYS is 3.
const SAT = '2026-09-05';
const HORIZON = scanDatesFrom(SAT, 3);
const [today, tomorrow, dayThree] = HORIZON;

test('the horizon from Saturday really is today + the next two business days', () => {
  assert.deepEqual(HORIZON, ['2026-09-05', '2026-09-07', '2026-09-08'], 'Sat, Mon, Tue');
});

test('TODAY never freezes — it has always re-pulled on every fire, under either setting', () => {
  assert.equal(rosterFreezeApplies(today, today, tomorrow, true), false);
  assert.equal(rosterFreezeApplies(today, today, tomorrow, false), false);
});

test('TOMORROW still freezes — its load set is fixed, so re-pulling it 20x a day buys nothing', () => {
  assert.equal(rosterFreezeApplies(tomorrow, today, tomorrow, true), true);
});

test('THE FIX: the day BEYOND tomorrow re-pulls — its trailers may not exist yet', () => {
  // Tuesday Sep 8, seen from Saturday. This is the date Chad had open.
  assert.equal(rosterFreezeApplies(dayThree, today, tomorrow, true), false);
});

test('NUVIZZ_ROSTER_HORIZON_REFRESH=off restores the old freeze on every future date', () => {
  assert.equal(rosterFreezeApplies(dayThree, today, tomorrow, false), true);
  assert.equal(rosterFreezeApplies(tomorrow, today, tomorrow, false), true);
  assert.equal(rosterFreezeApplies(today, today, tomorrow, false), false, 'today is never frozen either way');
});

test('a horizon of two has no third day, so the switch changes nothing there', () => {
  const [t, tm] = scanDatesFrom(SAT, 2);
  for (const on of [true, false]) {
    assert.equal(rosterFreezeApplies(t, t, tm, on), false);
    assert.equal(rosterFreezeApplies(tm, t, tm, on), true);
  }
});
