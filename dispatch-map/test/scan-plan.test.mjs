// test/scan-plan.test.mjs
//
// THE SCAN PLAN — per-scan, per-day, per-hour cadence.
//
// Chad: "it's time to decouple them. Part of the day we need to scan more for completed, and
// part of the day we need to scan more for unplanned and planned… rows of when it scans so I
// can scan more heavily on each scan at different times of the day."
//
// The two saved searches answer different questions and matter at opposite ends of the day:
// 77128 (the PLAN) churns during the routing evening and the ~10am order drop and is static
// while trucks run; 77131 (WHAT HAPPENED) is dead overnight and is the whole game from first
// roll to last stop, because every delivery stamp re-anchors a route clock.
//
// These pin the resolver, because a schedule that resolves differently from what the grid
// shows is a schedule nobody can trust — and the failure is silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_KINDS, SCAN_INFO, defaultScanRules, clampScanRules, resolveInterval, ruleCoversHour,
  resolveWeekGrid, estimatePlanCalls, effectiveCadence, MAX_RULES, RULE_BOUNDS, dueKinds,
  CRON_STEP_MIN, CRON_TOLERANCE_MIN,
} from '../netlify/functions/lib/scan-plan.mts';

const MON = 1, TUE = 2, FRI = 5, SAT = 6, SUN = 0;
const rule = (over = {}) => ({ kind: 'completed', days: [MON], startHour: 8, endHour: 17, intervalMin: 30, ...over });

// ── the point of the whole feature ───────────────────────────────────────────

test('THE DECOUPLING: completed and planned run at different rates in the same hour', () => {
  const rules = defaultScanRules();
  // 2pm Tuesday — trucks are running, the plan is settled. Completed matters twice as much.
  assert.equal(resolveInterval('completed', TUE, 14, rules), 15);
  assert.equal(resolveInterval('planned', TUE, 14, rules), 30);
  // 9pm Tuesday — routing. Exactly the other way round: the plan moves, nothing delivers.
  assert.equal(resolveInterval('planned', TUE, 21, rules), 30);
  assert.equal(resolveInterval('completed', TUE, 21, rules), null);
});

test("CHAD'S COMPLETED BANDS: 30 from 4-6am, 15 from 6am-7pm, nothing 7pm-4am", () => {
  const r = defaultScanRules();
  assert.equal(resolveInterval('completed', TUE, 4, r), 30);
  assert.equal(resolveInterval('completed', TUE, 5, r), 30);
  assert.equal(resolveInterval('completed', TUE, 6, r), 15);
  assert.equal(resolveInterval('completed', TUE, 18, r), 15, '6pm is still inside the run');
  assert.equal(resolveInterval('completed', TUE, 19, r), null, '7pm the pull stops');
  assert.equal(resolveInterval('completed', TUE, 3, r), null, 'and does not resume until 4am');
});

test("CHAD'S BANDS, verbatim: 30 from 8pm, 20 through the small hours, 15 from 5am, 30 from 10am", () => {
  const r = defaultScanRules();
  assert.equal(resolveInterval('planned', TUE, 21, r), 30, '8pm-12am');
  assert.equal(resolveInterval('planned', TUE, 2, r), 20, '12am-5am');
  assert.equal(resolveInterval('planned', TUE, 4, r), 20, 'still the small-hours band at 4am');
  assert.equal(resolveInterval('planned', TUE, 5, r), 15, '5am-10am');
  assert.equal(resolveInterval('planned', TUE, 9, r), 15);
  assert.equal(resolveInterval('planned', TUE, 10, r), 30, '10am-8pm');
  assert.equal(resolveInterval('planned', TUE, 19, r), 30);
  // …and every one of those is delivered exactly, which is why the cron step moved to 5.
  for (const iv of [15, 20, 30]) assert.equal(effectiveCadence(iv), iv, `${iv} is honoured`);
});

test('completed is NOT pulled 7pm-4am — nine hours a day where a pull returns empty', () => {
  const rules = defaultScanRules();
  for (const h of [19, 20, 21, 22, 23, 0, 1, 2, 3]) {
    assert.equal(resolveInterval('completed', TUE, h, rules), null, `${h}:00 must not pull completed`);
  }
  // …while the plan is still watched hard overnight, because routing runs late.
  assert.equal(resolveInterval('planned', TUE, 2, rules), 20);
});

test('Saturday is silent, and Sunday evening wakes up for Monday routing', () => {
  const rules = defaultScanRules();
  for (const kind of SCAN_KINDS) {
    for (let h = 0; h < 24; h++) {
      assert.equal(resolveInterval(kind, SAT, h, rules), null, `Sat ${h}:00 ${kind}`);
    }
  }
  assert.equal(resolveInterval('planned', SUN, 21, rules), 30, 'Sunday evening builds Monday');
  assert.equal(resolveInterval('planned', SUN, 9, rules), null, 'Sunday daytime stays quiet');
});

// ── resolution rules ─────────────────────────────────────────────────────────

test('TIGHTEST WINS, so row order can never change the answer', () => {
  const loose = rule({ id: 'a', intervalMin: 60 });
  const tight = rule({ id: 'b', intervalMin: 15 });
  assert.equal(resolveInterval('completed', MON, 10, [loose, tight]), 15);
  assert.equal(resolveInterval('completed', MON, 10, [tight, loose]), 15, 'same answer reversed');
});

test('an uncovered hour means that scan simply does not run', () => {
  const rules = [rule({ startHour: 8, endHour: 17 })];
  assert.equal(resolveInterval('completed', MON, 7, rules), null);
  assert.equal(resolveInterval('completed', MON, 8, rules), 30, 'start is inclusive');
  assert.equal(resolveInterval('completed', MON, 16, rules), 30);
  assert.equal(resolveInterval('completed', MON, 17, rules), null, 'end is exclusive');
});

test('a disabled row contributes nothing — and does not fall back to itself', () => {
  const rules = [rule({ enabled: false })];
  assert.equal(resolveInterval('completed', MON, 10, rules), null);
});

test('a rule only answers for its own scan', () => {
  const rules = [rule({ kind: 'completed' })];
  assert.equal(resolveInterval('planned', MON, 10, rules), null);
  assert.equal(resolveInterval('roster', MON, 10, rules), null);
});

test('a window that wraps midnight covers both ends, and the DAY is the hour’s own day', () => {
  const r = rule({ startHour: 22, endHour: 3, days: [FRI] });
  assert.equal(ruleCoversHour(r, 23), true);
  assert.equal(ruleCoversHour(r, 1), true);
  assert.equal(ruleCoversHour(r, 12), false);
  // Friday 23:00 is covered; Saturday 01:00 is NOT, unless Saturday is on the row. An hour is
  // coloured by the day it is in — any other reading makes the preview grid lie.
  assert.equal(resolveInterval('completed', FRI, 23, [r]), 30);
  assert.equal(resolveInterval('completed', SAT, 1, [r]), null);
  assert.equal(resolveInterval('completed', SAT, 1, [{ ...r, days: [FRI, SAT] }]), 30);
});

// ── what the box accepts vs what the system delivers ─────────────────────────

test('EVERY interval a dispatcher would type is now honoured exactly', () => {
  // The whole reason the cron step moved to 5. On the old 15-minute step there was no such
  // thing as 20 — it snapped to 15, and the box would have said 20 while the system did 15.
  for (const iv of [5, 10, 15, 20, 30, 45, 60, 90, 120]) {
    assert.equal(effectiveCadence(iv), iv, `${iv} minutes is delivered as ${iv}`);
  }
  // An off-step number lands on the nearest cron step at or above (interval - tolerance), so
  // it can come out slightly FASTER than asked — the tolerance exists to let a fire that is
  // a couple of minutes early still count, rather than slipping a whole step. Either way the
  // screen shows the delivered number, so it never flatters the plan.
  assert.equal(effectiveCadence(22), 20);
  assert.equal(effectiveCadence(37), 35);
  for (const iv of [7, 13, 22, 37, 53]) {
    const got = effectiveCadence(iv);
    assert.equal(got % CRON_STEP_MIN, 0, `${iv} lands on a cron step`);
    assert.ok(Math.abs(got - iv) <= CRON_TOLERANCE_MIN + CRON_STEP_MIN,
      `${iv} -> ${got} stays within a step of what was asked`);
  }
});

test('the interval floor is the cron step — a number we cannot deliver is refused, not fudged', () => {
  assert.equal(RULE_BOUNDS.intervalMin[0], CRON_STEP_MIN);
  const [r] = clampScanRules([rule({ intervalMin: 1 })]);
  assert.equal(r.intervalMin, CRON_STEP_MIN);
});

// ── clamping: junk is dropped, never repaired into something plausible ───────

test('unusable rows are DROPPED rather than guessed at', () => {
  const kept = clampScanRules([
    rule(),                                   // good
    { kind: 'nonsense', days: [1], startHour: 1, endHour: 2, intervalMin: 30 },
    rule({ days: [] }),                       // no days
    rule({ days: 'monday' }),                 // days not an array
    rule({ startHour: 9, endHour: 9 }),       // zero-width window
    rule({ intervalMin: 'soon' }),
    null, 'x', 42,
  ]);
  assert.equal(kept.length, 1, 'only the good row survives');
  assert.equal(kept[0].kind, 'completed');
});

test('clamping is idempotent — the stored plan is the plan', () => {
  const once = clampScanRules(defaultScanRules());
  const twice = clampScanRules(once);
  assert.deepEqual(twice, once);
});

test('every row comes back with an id, so the UI can key it', () => {
  const kept = clampScanRules([rule({ id: undefined }), rule({ id: undefined })]);
  assert.equal(kept.length, 2);
  assert.ok(kept[0].id && kept[1].id);
  assert.notEqual(kept[0].id, kept[1].id);
});

test('a runaway table is capped rather than accepted', () => {
  const many = Array.from({ length: MAX_RULES + 25 }, (_, i) => rule({ id: `r${i}` }));
  assert.equal(clampScanRules(many).length, MAX_RULES);
});

test('an empty or absent plan resolves to nothing — it must never mean "scan constantly"', () => {
  for (const empty of [[], null, undefined, 'x', {}]) {
    assert.equal(resolveInterval('completed', MON, 10, clampScanRules(empty)), null);
  }
});

// ── the grid and the estimate the screen shows ───────────────────────────────

test('the preview grid is exactly what the resolver says, for every hour of the week', () => {
  const rules = defaultScanRules();
  const grid = resolveWeekGrid(rules);
  for (const kind of SCAN_KINDS) {
    for (let wd = 0; wd < 7; wd++) {
      for (let h = 0; h < 24; h++) {
        assert.equal(grid[kind][wd][h], resolveInterval(kind, wd, h, rules), `${kind} wd${wd} h${h}`);
      }
    }
  }
});

test('the estimate counts the ACHIEVED cadence, not the typed one', () => {
  // One kind, one day, 08:00–12:00, asking for 22 minutes → delivered as 20 (see
  // effectiveCadence). The estimate must count the 20, not the 22.
  const rules = [rule({ days: [MON], startHour: 8, endHour: 12, intervalMin: 22 })];
  const est = estimatePlanCalls(rules);
  assert.equal(est.perDay[MON], 12, '4 hours at a 20-minute cadence = 12 scans, not 11');
  assert.equal(est.perWeek, 12, 'and nothing on any other day');
});

test('the default plan stays comfortably inside the daily ceiling', () => {
  const est = estimatePlanCalls(defaultScanRules());
  const busiest = Math.max(...est.perDay);
  assert.ok(busiest > 0, 'it does actually scan');
  // The hard cap is 2,000 calls/day and enrichment rides on top of this, so discovery has to
  // stay a small fraction of it — a plan that spends the budget on list pulls starves the
  // /stop/info reads that give new orders their address and pin.
  assert.ok(busiest < 300, `busiest day ${busiest} must stay well under the 2,000 ceiling`);
  assert.equal(est.perDay[SAT], 0, 'nothing on Saturday');
  assert.ok(est.byKind.completed > 200, 'completed is still sampled hard through the delivery day');
});

// ── the descriptions the screen shows ────────────────────────────────────────

test('every scan carries a description, because the screen and the scheduler must agree', () => {
  for (const kind of SCAN_KINDS) {
    const info = SCAN_INFO[kind];
    assert.ok(info, `${kind} has info`);
    for (const field of ['label', 'listDef', 'what', 'affects', 'costPerScan', 'quietWhen']) {
      assert.ok(info[field] && info[field].length > 3, `${kind}.${field} is filled in`);
    }
  }
  // The two that matter say what they affect in terms of the flags, since that is the
  // question this table exists to answer.
  assert.match(SCAN_INFO.planned.affects, /flag/i);
  assert.match(SCAN_INFO.completed.affects, /anchor/i);
  // The roster DOES reach the flag engine — it is what detects two live loads sharing one
  // route name, which both raises a red flag and makes the engine refuse to judge that route.
  // An earlier draft of this description said the opposite; the test is here so it cannot
  // drift back.
  assert.match(SCAN_INFO.roster.affects, /route name/i);
  assert.match(SCAN_INFO.roster.affects, /refuse to judge/i);
});

test('the default plan covers every scan kind', () => {
  const rules = defaultScanRules();
  for (const kind of SCAN_KINDS) {
    assert.ok(rules.some((r) => r.kind === kind), `${kind} has at least one row`);
  }
});

// ── which scans fire on THIS tick ────────────────────────────────────────────

test('dueKinds: a kind with no rule for this hour is never due', () => {
  const rules = defaultScanRules();
  const d = dueKinds(TUE, 2, rules, {}, Date.parse('2026-08-25T06:00:00Z'));
  assert.equal(d.completed.due, false, 'nothing delivers at 2am');
  assert.match(d.completed.reason, /no rule covers/);
  assert.equal(d.planned.due, true, 'the plan IS watched overnight — routing runs late');
});

test('dueKinds: a kind that has never run is due immediately', () => {
  const rules = defaultScanRules();
  const d = dueKinds(TUE, 9, rules, {}, Date.parse('2026-08-25T13:00:00Z'));
  assert.equal(d.completed.due, true);
  assert.match(d.completed.reason, /never run/);
});

test('dueKinds: elapsed time gates it, with tolerance for a late cron fire', () => {
  const now = Date.parse('2026-08-25T13:00:00Z');
  const rules = [{ kind: 'completed', days: [TUE], startHour: 0, endHour: 24, intervalMin: 30 }];
  const at = (min) => new Date(now - min * 60000).toISOString();
  assert.equal(dueKinds(TUE, 9, rules, { completed: at(10) }, now).completed.due, false, '10m short of 30');
  assert.equal(dueKinds(TUE, 9, rules, { completed: at(28) }, now).completed.due, true, '28m clears 30 minus tolerance');
  assert.equal(dueKinds(TUE, 9, rules, { completed: at(45) }, now).completed.due, true);
});

test('THE DECOUPLING, ON ONE TICK: completed fires while planned waits', () => {
  const now = Date.parse('2026-08-25T13:00:00Z');   // 9:00a ET Tuesday
  const at = (min) => new Date(now - min * 60000).toISOString();
  // 2pm: completed wants 15, the plan wants 30. 20 minutes since both last ran.
  const d = dueKinds(TUE, 14, defaultScanRules(), { completed: at(20), planned: at(20) }, now);
  assert.equal(d.completed.due, true, 'completed is due — this is the whole feature');
  assert.equal(d.planned.due, false, 'and the plan is not, so the fire costs 1 call not 3');
});
