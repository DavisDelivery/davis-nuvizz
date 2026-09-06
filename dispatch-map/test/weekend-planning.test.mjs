// test/weekend-planning.test.mjs
//
// PLANNING MONDAY ON A SATURDAY NEEDS BOTH HALVES.
//
// Chad, 18:17 on Saturday Sep 5, looking at the Routing screen: "I want to see Monday's and
// Tuesday's of next week's loads here like this so I can start planning them today or
// tomorrow."
//
// v0.93.4 gave the ROSTER the weekend, so the empty trailers for Monday and Tuesday appear.
// That is the list of what he can fill. It is not what he fills them WITH — the orders are
// 77128 (`planned`), and that had no weekend rule at all: zero hours on Saturday, nothing
// before 20:00 on Sunday. A Saturday board therefore showed Friday evening's picture of
// Monday's freight, and anything that landed since was invisible on the screen he plans from.
//
// THE INTERACTION IS THE INTERESTING PART. rosterMayRunOnBlackout refuses outright when
// planned is due — deliberately, so a cheap list call can never carry a ~700-stop rebuild
// through a blackout on its permission. So adding a weekend `planned` rule SILENCES the roster
// carve-out as a side effect: one gap traded for another, with no line of code looking wrong.
// These tests pin both halves running on the same Saturday fire.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultScanRules, resolveInterval, scanPath,
  rosterMayRunOnBlackout, plannedMayRunOnBlackout,
} from '../netlify/functions/lib/scan-plan.mts';
import { isWeekendBlackout } from '../netlify/functions/lib/scan-schedule.mts';
import { scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';

const SAT = 6, SUN = 0, MON = 1;
const weekendSkip = { act: false, skip: 'weekend' };

test('the days Chad wants to plan are already in the horizon from Saturday AND Sunday', () => {
  // Sep 5 2026 is the Saturday; Sep 7 is Labor Day Monday, Sep 8 the Tuesday.
  assert.deepEqual(scanDatesFrom('2026-09-05', 3), ['2026-09-05', '2026-09-07', '2026-09-08']);
  assert.deepEqual(scanDatesFrom('2026-09-06', 3), ['2026-09-06', '2026-09-07', '2026-09-08']);
});

test('PLANNED now runs on Saturday and Sunday daytime — the hours a dispatcher plans in', () => {
  const rules = defaultScanRules();
  for (const [wd, label] of [[SAT, 'Sat'], [SUN, 'Sun']]) {
    assert.equal(resolveInterval('planned', wd, 10, rules), 60, `${label} 10:00`);
    assert.equal(resolveInterval('planned', wd, 17, rules), 60, `${label} 17:00 — Chad's screenshot`);
    assert.equal(resolveInterval('planned', wd, 3, rules), null, `${label} 03:00 — nobody plans at 3am`);
  }
});

test('COMPLETED stays dark all weekend — nothing delivered, so that pull is empty by construction', () => {
  const rules = defaultScanRules();
  for (const wd of [SAT, SUN]) {
    for (let h = 0; h < 24; h++) assert.equal(resolveInterval('completed', wd, h, rules), null, `wd${wd} ${h}:00`);
  }
});

test('the delivery-day bands are untouched — this adds the weekend, it does not retune the week', () => {
  const rules = defaultScanRules();
  assert.equal(resolveInterval('planned', MON, 7, rules), 15, 'plan-rollout');
  assert.equal(resolveInterval('planned', MON, 12, rules), 30, 'plan-day');
  assert.equal(resolveInterval('completed', MON, 10, rules), 15, 'done-run');
});

// ── the two permissions, and the interaction between them ────────────────────

test('a due PLANNED scan gets through the weekend blackout', () => {
  assert.equal(plannedMayRunOnBlackout(weekendSkip, true, false), true);
});

test('...and it becomes a full board scan, not a roster-only tick', () => {
  const plannedOnBlackout = plannedMayRunOnBlackout(weekendSkip, true, false);
  assert.equal(scanPath(weekendSkip.act || plannedOnBlackout, { plannedDue: true, completedDue: false, rosterDue: true }), 'full');
});

test('THE INTERACTION: the roster carve-out goes quiet once planned is due, so the caller must grant it under either permission', () => {
  // This is the regression the two-function split exists to make visible. On a Saturday fire
  // with the new rule BOTH are due, and rosterMayRunOnBlackout answers false — correctly, by
  // its own contract. The roster still has to run.
  assert.equal(rosterMayRunOnBlackout(weekendSkip, true, false, true), false, 'refuses, as designed');
  const rosterOnlyOnBlackout = rosterMayRunOnBlackout(weekendSkip, true, false, true);
  const plannedOnBlackout = plannedMayRunOnBlackout(weekendSkip, true, false);
  assert.equal(weekendSkip.act || rosterOnlyOnBlackout || plannedOnBlackout, true,
    'refresh-stops-core runs the roster under EITHER permission — the trailers must not vanish when the freight arrives');
});

test('a weekend fire with nothing due still runs nothing', () => {
  assert.equal(plannedMayRunOnBlackout(weekendSkip, false, false), false);
  assert.equal(rosterMayRunOnBlackout(weekendSkip, false, false, false), false);
});

test('COMPLETED can never ride through on the planned permission', () => {
  assert.equal(plannedMayRunOnBlackout(weekendSkip, true, true), false);
});

test('only the WEEKEND skip is carved out — the hard floor and the cadence gate stand', () => {
  for (const skip of ['floor', 'cadence']) {
    assert.equal(plannedMayRunOnBlackout({ act: false, skip }, true, false), false, skip);
  }
});

test('an already-acting decision is left alone', () => {
  assert.equal(plannedMayRunOnBlackout({ act: true, skip: 'none' }, true, false), false);
});

test('every weekend hour that plans is inside the blackout, so the carve-out is load-bearing', () => {
  // If this ever stops being true the rule is being served by something else and the carve-out
  // is dead code pretending to work.
  const rules = defaultScanRules();
  const carved = [];
  for (const wd of [SAT, SUN]) {
    for (let h = 0; h < 24; h++) {
      if (resolveInterval('planned', wd, h, rules) == null) continue;
      if (isWeekendBlackout(wd, h, {})) carved.push(`${wd}:${h}`);
    }
  }
  assert.ok(carved.length >= 20, `expected the weekend planning hours to need the carve-out, got ${carved.length}`);
});
