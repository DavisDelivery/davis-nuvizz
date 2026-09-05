// test/scan-dispatch.test.mjs
//
// WHICH PATH A CRON FIRE TAKES — the rule Chad's Tuesday morning was a symptom of.
//
// Chad, 10:02am on a delivery day, the status card reading Loads / Orders / Completed all
// "updated 3 hr ago", 923 NuVizz calls already spent against a 2,000 ceiling:
// "Something is very wrong with my scan schedule. Go through the code looking for bugs."
//
// refresh-stops-core used to spell the dispatch out as three `if`s with an implicit else, and
// the else was the FULL board rebuild — the most expensive thing the scanner can do, reached
// by whatever nobody thought about. These tests pin the rule instead of the shape, and the
// two accidental fall-throughs are named after what they cost in freight terms.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanPath, dueKinds, defaultScanRules, RULE_BOUNDS, HARD_FLOOR_MIN, CRON_STEP_MIN,
  clampScanRules, resolveInterval, overrideCadenceSkip,
} from '../netlify/functions/lib/scan-plan.mts';

const MON = 1, TUE = 2;
const DUE = (planned, completed, roster) => ({ plannedDue: planned, completedDue: completed, rosterDue: roster });

test('a fire the outer gate refused does nothing, whatever the plan wants', () => {
  assert.equal(scanPath(false, DUE(true, true, true)), 'skip');
});

test('planned due = the full board rebuild, and it subsumes the other two', () => {
  assert.equal(scanPath(true, DUE(true, false, false)), 'full');
  assert.equal(scanPath(true, DUE(true, true, true)), 'full');
});

test('completed alone takes the one-call overlay, never the rebuild', () => {
  assert.equal(scanPath(true, DUE(false, true, false)), 'completed-overlay');
  assert.equal(scanPath(true, DUE(false, true, true)), 'completed-overlay');
});

test('THE HOURLY ROSTER NO LONGER BUYS A WHOLE BOARD REBUILD', () => {
  // The roster drops to hourly precisely so it stops riding along on every fire — the reclaim
  // that pays for 15-minute completed sampling. With no roster-only path, "only the roster is
  // due" fell into the else and re-pulled, re-enriched and re-wrote a ~700-stop board.
  assert.equal(scanPath(true, DUE(false, false, true)), 'roster-only');
});

test('nothing due = nothing runs, which is what an uncovered hour MEANS', () => {
  assert.equal(scanPath(true, DUE(false, false, false)), 'skip');
});

test('no combination of due-ness can reach the rebuild without planned being due', () => {
  for (const p of [false, true]) for (const c of [false, true]) for (const r of [false, true]) {
    const got = scanPath(true, DUE(p, c, r));
    if (got === 'full') assert.equal(p, true, `full without plannedDue: ${p}/${c}/${r}`);
  }
});

test('04:00-05:59 ET: the roster is DUE, which is why the old 6am gate deadlocked it', () => {
  // roster-am opens at 04:00. The branch that stamps the roster carried its own `etHour >= 6`
  // gate from before the plan existed, so for two hours rosterDue was true and nothing could
  // ever clear it — and with no roster-only path, every fire past the 10-minute floor went to
  // a full rebuild. This pins the rule the guard disagreed with.
  const rules = defaultScanRules();
  for (const hour of [4, 5]) {
    assert.equal(resolveInterval('roster', TUE, hour, rules), 60, `roster uncovered at ${hour}:00`);
  }
  const stamps = { planned: '2026-08-25T08:00:00Z', completed: '2026-08-25T08:00:00Z', roster: '2026-08-25T06:00:00Z' };
  const now = Date.parse('2026-08-25T08:10:00Z'); // 04:10 ET
  const due = dueKinds(TUE, 4, rules, stamps, now);
  assert.equal(due.roster.due, true, 'roster should be due at 04:10 ET');
  assert.equal(due.planned.due, false);
  assert.equal(due.completed.due, false);
  assert.equal(scanPath(true, DUE(due.planned.due, due.completed.due, due.roster.due)), 'roster-only');
});

test('the editor cannot accept an interval the scanner will not deliver', () => {
  // The bound used to be the cron step alone (5). effectiveCadence would report 5 back and the
  // scanner would then hold every one of those fires at the 10-minute anti-thrash floor — the
  // same "a screen that lies about a number you typed" defect CRON_STEP_MIN was raised to fix.
  assert.equal(RULE_BOUNDS.intervalMin[0], Math.max(CRON_STEP_MIN, HARD_FLOOR_MIN));
  assert.ok(RULE_BOUNDS.intervalMin[0] >= HARD_FLOOR_MIN);
  const [r] = clampScanRules([{ kind: 'completed', days: [MON], startHour: 6, endHour: 19, intervalMin: 5 }]);
  assert.equal(r.intervalMin, HARD_FLOOR_MIN, 'a 5-minute rule must clamp UP to the real floor');
});

test('the shipped plan still resolves exactly as Chad dictated it', () => {
  const rules = defaultScanRules();
  assert.equal(resolveInterval('planned', TUE, 21, rules), 30);  // 8pm-12am
  assert.equal(resolveInterval('planned', TUE, 2, rules), 20);   // 12am-5am
  assert.equal(resolveInterval('planned', TUE, 7, rules), 15);   // 5am-10am
  assert.equal(resolveInterval('planned', TUE, 10, rules), 30);  // 10am-8pm
  assert.equal(resolveInterval('completed', TUE, 5, rules), 30); // 4-6am
  assert.equal(resolveInterval('completed', TUE, 10, rules), 15);// 6am-7pm
  assert.equal(resolveInterval('completed', TUE, 2, rules), null);// not at 2am
});

// ── The whole Tuesday, replayed on the 5-minute cron ────────────────────────
// Not a shape test: this drives the real scanDecision / dueKinds / overrideCadenceSkip /
// scanPath over 288 fires and counts what the day would cost. Chad's card said 923 NuVizz
// calls by 10am against a 2,000 ceiling, and the 04:00-06:00 window is where the scheduler
// was spending them on rebuilds nobody asked for.
import { scanDecision } from '../netlify/functions/lib/scan-schedule.mts';

function replayTuesday() {
  const rules = defaultScanRules();
  const START = Date.parse('2026-08-25T04:00:00Z');   // Tue 00:00 ET
  const END = Date.parse('2026-08-26T04:00:00Z');
  let lastLoadScanAt = '2026-08-25T03:55:00Z';
  const stamps = { planned: lastLoadScanAt, completed: lastLoadScanAt, roster: lastLoadScanAt };
  const out = { full: 0, overlay: 0, rosterOnly: 0, rosterPulls: 0, fullByHour: {} };
  for (let t = START; t < END; t += 5 * 60000) {
    const at = new Date(t);
    let d = scanDecision(at, false, lastLoadScanAt, {});
    const due = dueKinds(d.weekday, d.etHour, rules, stamps, t);
    const P = due.planned.due, C = due.completed.due, R = due.roster.due;
    d = overrideCadenceSkip(d, P, C, R);
    if (d.act && R) { stamps.roster = at.toISOString(); out.rosterPulls++; }
    const path = scanPath(d.act, { plannedDue: P, completedDue: C, rosterDue: R });
    if (path === 'skip') continue;
    if (path === 'roster-only') { out.rosterOnly++; continue; }
    if (path === 'completed-overlay') { stamps.completed = at.toISOString(); out.overlay++; continue; }
    out.full++;
    out.fullByHour[d.etHour] = (out.fullByHour[d.etHour] || 0) + 1;
    lastLoadScanAt = at.toISOString();
    stamps.planned = at.toISOString();
    stamps.completed = at.toISOString();   // TWO_SCAN: the full pull IS a completed pull
  }
  return out;
}

test('THE 4AM STORM IS GONE: 04:00-05:59 rebuilds the board at the cadence the plan asks for', () => {
  const day = replayTuesday();
  // plan-small-hours is 20 minutes, so three full rebuilds an hour is the ceiling. Before the
  // roster deadlock was fixed this replay produced SIX in each of those hours — a ~700-stop
  // rebuild, with enrichment, roughly every ten minutes, while the dock was still dark.
  assert.ok(day.fullByHour[4] <= 3, `04:00 ran ${day.fullByHour[4]} full rebuilds`);
  assert.ok(day.fullByHour[5] <= 4, `05:00 ran ${day.fullByHour[5]} full rebuilds`);
});

test('the roster is pulled about once an hour, not on every fire', () => {
  const day = replayTuesday();
  // roster-day covers 04:00-24:00 = 20 hours at 60 minutes. It used to be roster-am
  // (04:00-13:00) + roster-eve (20:00-24:00) = 13, and the seven-hour afternoon gap between
  // them is one of the two holes that stopped Chad's empty loads populating; the other was the
  // whole weekend. The RULE this pins is unchanged and is still the one that matters: about
  // once an hour, NOT on every fire — before v0.77.0 it rode along on all ~33 of them.
  assert.ok(day.rosterPulls <= 21, `roster pulled ${day.rosterPulls}× in a day`);
  assert.ok(day.rosterPulls >= 16, `roster pulled only ${day.rosterPulls}× — it stopped running`);
  assert.ok(day.rosterPulls < day.full, 'still far fewer roster pulls than board rebuilds');
});

test("a whole delivery Tuesday still fits inside the day's call budget", () => {
  const day = replayTuesday();
  // 2 saved-search pulls per full scan + 1 per overlay + 1 per roster pull. Enrichment
  // (/stop/info on genuinely new PROs) rides on top and is not schedulable.
  const listCalls = day.full * 2 + day.overlay + day.rosterPulls;
  assert.ok(listCalls < 200, `${listCalls} list calls/day`);
  assert.ok(day.full > 40, `only ${day.full} board rebuilds — the plan stopped running`);
});
