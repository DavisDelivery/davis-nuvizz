// test/roster-manual-refresh.test.mjs — the refresh button must actually refresh.
//
// Chad, planning Tuesday on a Saturday: "i need it to fire when i manually refresh … If I'm
// working on Saturday or Sunday its to plan loads for following week like i was trying to do
// for Tuesday but all my empty loads weren't there."
//
// persistLoadRoster short-circuits a FROZEN date once it has been captured for the ET day
// (futureRosterCaptured — the guard the Jul 1 2026 number-less-snapshot regression bought), and
// that check was applied to EVERY caller, a human pressing the button included. So a manual
// scan pulled today and silently skipped the frozen horizon date. On a weekend the first
// capture of the day is the one taken before the following week's loads exist, so the day
// being planned sat frozen at the emptiest snapshot of the day with nothing able to move it —
// not the schedule, and not the one control that means "get me the current answer".
//
// THE SCAN SCHEDULE IS NOT TOUCHED BY ANY OF THIS. Chad: "all scans should be kept to the
// previous scan schedule." The cadence is exactly what it was; what changed is that a human
// asking is treated as information the cadence cannot have.
//
// WHICH dates freeze is rosterFreezeApplies' question and is tested next to it; this file only
// pins what happens once a date IS frozen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { skipFutureRosterPull, futureRosterCaptured, rosterFreezeApplies } from '../netlify/functions/lib/refresh-stops-core.mts';

const CAPTURED = { at: '2026-09-05T14:00:00Z', loads: [{ loadId: 'a', loadNbr: 'DAVIS000200600' }] };
const NOW_SAT = new Date('2026-09-05T18:00:00Z'); // 2pm ET Saturday

test('A MANUAL REFRESH ALWAYS PULLS, even a frozen date already captured today', () => {
  assert.equal(futureRosterCaptured(CAPTURED, NOW_SAT), true, 'the day IS captured — that is the premise');
  assert.equal(
    skipFutureRosterPull({ frozen: true, isManual: true, cached: CAPTURED, now: NOW_SAT }),
    false,
    'and a manual scan must pull it anyway',
  );
});

test('the SCHEDULED path still skips a captured frozen date — the cadence is unchanged', () => {
  assert.equal(
    skipFutureRosterPull({ frozen: true, isManual: false, cached: CAPTURED, now: NOW_SAT }),
    true,
  );
});

test('AN UNFROZEN DATE IS NEVER SKIPPED BY ANYBODY — today, and the rest of the horizon', () => {
  // rosterFreezeApplies is what decides this, and the two cases it answers false for are the
  // live board and (with horizon refresh on) every date past tomorrow. Both must reach the
  // vendor on every roster fire, manual or scheduled — a captured cache is irrelevant to them.
  assert.equal(rosterFreezeApplies('2026-09-05', '2026-09-05', '2026-09-07'), false, 'today never freezes');
  assert.equal(rosterFreezeApplies('2026-09-08', '2026-09-05', '2026-09-07'), false, 'day 3 does not freeze');
  for (const isManual of [true, false]) {
    assert.equal(
      skipFutureRosterPull({ frozen: false, isManual, cached: CAPTURED, now: NOW_SAT }),
      false,
      `unfrozen, manual=${isManual}`,
    );
  }
});

test('a frozen date never captured is pulled by either path', () => {
  for (const cached of [null, undefined, { at: null, loads: [] }, { at: '2026-09-05T14:00:00Z', loads: [] }]) {
    for (const isManual of [true, false]) {
      assert.equal(
        skipFutureRosterPull({ frozen: true, isManual, cached, now: NOW_SAT }),
        false,
        `${JSON.stringify(cached)} manual=${isManual}`,
      );
    }
  }
});

test('a number-less capture never counts as captured, manual or not', () => {
  // The Jul 1 2026 regression futureRosterCaptured exists for: 102 rows with zero load numbers
  // froze the day and every evening Save was refused ("needs a load number"). Asserted here so
  // the manual bypass can never be read as having replaced it.
  const numberless = { at: '2026-09-05T14:00:00Z', loads: [{ loadId: 'a', loadNbr: null }] };
  assert.equal(
    skipFutureRosterPull({ frozen: true, isManual: false, cached: numberless, now: NOW_SAT }),
    false,
  );
});

test('a PRIOR scan-day capture still never counts', () => {
  const yesterday = { at: '2026-09-04T14:00:00Z', loads: [{ loadId: 'a', loadNbr: 'DAVIS000200600' }] };
  assert.equal(skipFutureRosterPull({ frozen: true, isManual: false, cached: yesterday, now: NOW_SAT }), false);
});

test('a malformed options bag is refused rather than assumed', () => {
  assert.equal(skipFutureRosterPull(null), false);
  assert.equal(skipFutureRosterPull(undefined), false);
});
