// test/roster-horizon-freeze.test.mjs
//
// THE ROSTER FOR A FUTURE DATE IS CALLED ONCE A DAY. Chad, 2026-09-06: "The roster for future
// dates only needs to be called once a day as they will not change."
//
// That sentence is the rule, and this file pins it against the two ways it was broken this
// week: v0.93.5 let the third horizon day re-pull hourly (a switch, since removed), and the
// endpoint briefly re-asked an empty capture every hour (committed and reverted the same day).
// Today is the one date that re-pulls every roster fire — its loads are being built and
// dispatched all day — and a manual press is the one caller that always pulls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterFreezeApplies, futureRosterCaptured, skipFutureRosterPull, scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';

const SAT = '2026-09-05';
const [today, tomorrow, dayThree] = scanDatesFrom(SAT, 3);   // Sat, Mon (Labor Day), Tue
const NOW = new Date('2026-09-05T15:00:00Z');                  // 11:00 ET Saturday
const numbered = (at) => ({ at, loads: [{ loadId: 'a', name: 'BEN 2', loadNbr: 'DAVIS000198197', status: 'Draft', trips: 0 }] });

test('the horizon from Saturday is today + the next two business days', () => {
  assert.deepEqual([today, tomorrow, dayThree], ['2026-09-05', '2026-09-07', '2026-09-08']);
});

test('TODAY never freezes — it re-pulls on every roster fire', () => {
  assert.equal(rosterFreezeApplies(today, today), false);
});

test('EVERY future date freezes — tomorrow AND the day after, no third-day exception', () => {
  assert.equal(rosterFreezeApplies(tomorrow, today), true);
  assert.equal(rosterFreezeApplies(dayThree, today), true, 'v0.93.5 let this one re-pull hourly; Chad: once a day');
});

test('a frozen date captured THIS ET day with numbers is left alone for the rest of the day', () => {
  const cached = numbered('2026-09-05T08:05:00Z');            // 04:05 ET this morning
  assert.equal(futureRosterCaptured(cached, NOW), true);
  assert.equal(skipFutureRosterPull({ frozen: true, isManual: false, cached, now: NOW }), true, 'scheduled: skip');
});

test('yesterday’s capture does not count today — the day starts with one pull', () => {
  const cached = numbered('2026-09-04T16:00:00Z');
  assert.equal(futureRosterCaptured(cached, NOW), false);
  assert.equal(skipFutureRosterPull({ frozen: true, isManual: false, cached, now: NOW }), false);
});

test('an EMPTY capture does not count as captured — there is no roster yet to leave alone', () => {
  // "They will not change" is a statement about a roster that exists. Zero rows is not a roster
  // that will not change; it is a day nobody has built yet, and the once-a-day pull has not
  // yet found anything to be once-a-day ABOUT. Same rule since Jul 1 for a number-less list.
  assert.equal(futureRosterCaptured({ at: '2026-09-05T08:05:00Z', loads: [] }, NOW), false);
});

test('A MANUAL PRESS ALWAYS PULLS — the one exception, because a human asking is information the cadence cannot have', () => {
  const cached = numbered('2026-09-05T08:05:00Z');
  assert.equal(skipFutureRosterPull({ frozen: true, isManual: true, cached, now: NOW }), false);
});

test('there is no environment switch that widens this any more', () => {
  assert.equal(rosterFreezeApplies.length, 2, 'rosterFreezeApplies(date, today) — no horizon-refresh flag');
});
