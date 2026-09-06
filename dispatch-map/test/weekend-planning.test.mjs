// test/weekend-planning.test.mjs
//
// PLANNING MONDAY ON A SATURDAY IS THE BUTTON'S JOB, NOT THE SCHEDULE'S.
//
// THE HISTORY, KEPT BECAUSE IT IS THE WHOLE ARGUMENT. Chad wanted next week's loads visible on
// a weekend so he could plan them. Two releases tried to do that by letting scheduled scans
// through the weekend blackout: v0.93.4 carved out the ROSTER, v0.93.6 carved out PLANNED as
// well (the freight he plans ONTO those trailers). Both were defensible and both were wrong,
// and the number is why. Replayed against the shipped plan on the 5-minute cron, they took a
// SATURDAY from 0 scheduled vendor calls to 65 — twelve full ~700-stop board rebuilds plus
// forty-one roster pulls, before he touched anything. He watched that land on his own counter
// and said: "I want my schedule to be just what it was unless I hit the manual refresh."
//
// So the carve-outs are GONE — rosterMayRunOnBlackout and plannedMayRunOnBlackout are deleted,
// not disabled, and their env switches with them. The blackout stands unqualified.
//
// AND THE NEED THEY WERE BUILT FOR IS MET THE OTHER WAY, which is the better engineering
// anyway: a schedule cannot know which board is on screen, so it guessed by widening. A press
// knows exactly. "if I have it set for a future date when I hit the refresh button it should
// pull the load roster for that day and the next" — rosterDatesFor, tested next door in
// roster-viewed-date.test.mjs. Two calls, aimed where he is working, when he asks for them.
//
// These tests pin the silence. A future release that reintroduces a weekend scheduled fire —
// under any name, for any feed — fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as plan from '../netlify/functions/lib/scan-plan.mts';
import { defaultScanRules, resolveInterval, dueKinds, scanPath, overrideCadenceSkip } from '../netlify/functions/lib/scan-plan.mts';
import { scanDecision, isWeekendBlackout } from '../netlify/functions/lib/scan-schedule.mts';
import { scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';

const SAT = 6, SUN = 0, MON = 1;

test('THE CARVE-OUT FUNCTIONS ARE GONE, not merely unused', () => {
  // Left exported-but-uncalled they are one import away from coming back by accident, and the
  // next person reading the plan cannot tell a dead permission from a live one.
  assert.equal(plan.rosterMayRunOnBlackout, undefined, 'rosterMayRunOnBlackout must not exist');
  assert.equal(plan.plannedMayRunOnBlackout, undefined, 'plannedMayRunOnBlackout must not exist');
});

test('NO RULE OF ANY KIND COVERS A SATURDAY HOUR — the schedule is silent all day', () => {
  const rules = defaultScanRules();
  for (let hour = 0; hour < 24; hour++) {
    for (const kind of ['planned', 'completed', 'roster']) {
      assert.equal(resolveInterval(kind, SAT, hour, rules), null,
        `${kind} is scheduled at Sat ${hour}:00 — Saturday must be silent`);
    }
  }
});

test('and the blackout would refuse them even if a rule appeared', () => {
  // Belt and braces, and they are independent: the rules say "not scheduled", the blackout says
  // "not now". Losing either one alone must not put calls back on a Saturday.
  for (let hour = 0; hour < 24; hour++) {
    assert.equal(isWeekendBlackout(SAT, hour), true, `Sat ${hour}:00 ET must be inside the blackout`);
  }
});

test('A WHOLE SATURDAY ON THE 5-MINUTE CRON SPENDS NOTHING — the number he asked for', () => {
  // The replay that produced the 65. Driving the real scanDecision/dueKinds/scanPath over all
  // 288 fires of the day, nothing may act. This is the test that fails if anyone reintroduces
  // a weekend fire under a new name.
  const rules = defaultScanRules();
  const stamps = { planned: '2026-09-04T12:00:00Z', completed: '2026-09-04T12:00:00Z', roster: '2026-09-04T12:00:00Z' };
  let acted = 0;
  for (let t = Date.parse('2026-09-05T04:00:00Z'); t < Date.parse('2026-09-06T04:00:00Z'); t += 5 * 60000) {
    const at = new Date(t);
    let d = scanDecision(at, false, stamps.planned, {});
    const due = dueKinds(d.weekday, d.etHour, rules, stamps, t);
    d = overrideCadenceSkip(d, due.planned.due, due.completed.due, due.roster.due);
    if (d.act) acted++;
    if (scanPath(d.act, { plannedDue: due.planned.due, completedDue: due.completed.due, rosterDue: due.roster.due }) !== 'skip') acted++;
  }
  assert.equal(acted, 0, `${acted} Saturday fires acted — the schedule must be silent`);
});

test('a MANUAL press is the one thing that still reaches the vendor on a Saturday', () => {
  // The blackout is bypassed by isManual and only by isManual. Without this the revert would
  // have taken his weekend planning away entirely instead of moving it onto the button.
  const sat = new Date('2026-09-05T18:00:00Z'); // 2pm ET Saturday
  assert.equal(scanDecision(sat, false, null, {}).act, false, 'scheduled: silent');
  assert.equal(scanDecision(sat, true, null, {}).act, true, 'manual: runs');
});

test('the days he plans are still reachable from the board — the horizon never was the problem', () => {
  assert.deepEqual(scanDatesFrom('2026-09-05', 3), ['2026-09-05', '2026-09-07', '2026-09-08']);
  assert.deepEqual(scanDatesFrom('2026-09-06', 3), ['2026-09-06', '2026-09-07', '2026-09-08']);
});

test('SUNDAY EVENING STILL OPENS, exactly as it did before any of this', () => {
  // "Just what it was" cuts both ways: the routing window from 20:00 Sunday is original
  // behaviour and reverting must not have taken it too.
  const rules = defaultScanRules();
  assert.equal(resolveInterval('planned', SUN, 21, rules), 30, 'plan-eve covers Sunday night');
  assert.equal(resolveInterval('roster', SUN, 21, rules), 60, 'roster-eve too');
  // The real edges are Fri 23:00 -> Sun 19:00 ET, not the 22/20 quoted in older comments.
  assert.equal(isWeekendBlackout(SUN, 19), false, 'Sunday reopens AT 19:00 ET');
  assert.equal(isWeekendBlackout(SUN, 18), true, '...and 6pm Sunday is still inside it');
  assert.equal(isWeekendBlackout(5, 23), true, 'Friday closes at 23:00 ET');
  assert.equal(isWeekendBlackout(5, 22), false, '...and 10pm Friday still scans');
});

test('the delivery-day bands are untouched — this removed the weekend, it did not retune the week', () => {
  const rules = defaultScanRules();
  assert.equal(resolveInterval('planned', MON, 7, rules), 15, 'plan-rollout');
  assert.equal(resolveInterval('planned', MON, 12, rules), 30, 'plan-day');
  assert.equal(resolveInterval('completed', MON, 10, rules), 15, 'done-run');
  assert.equal(resolveInterval('roster', MON, 6, rules), 60, 'roster-am');
});
