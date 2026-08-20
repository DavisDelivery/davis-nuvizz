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
} from '../netlify/functions/lib/scan-plan.mts';

const MON = 1, TUE = 2, FRI = 5, SAT = 6, SUN = 0;
const rule = (over = {}) => ({ kind: 'completed', days: [MON], startHour: 8, endHour: 17, intervalMin: 30, ...over });

// ── the point of the whole feature ───────────────────────────────────────────

test('THE DECOUPLING: completed and planned can run at different rates in the same hour', () => {
  const rules = defaultScanRules();
  // 9am Tuesday — trucks are running. Completed matters most; the plan is settled.
  assert.equal(resolveInterval('completed', TUE, 9, rules), 15);
  assert.equal(resolveInterval('planned', TUE, 9, rules), 30);
  // 9pm Tuesday — routing. Exactly the other way round.
  assert.equal(resolveInterval('planned', TUE, 21, rules), 15);
  assert.equal(resolveInterval('completed', TUE, 21, rules), 60);
});

test('completed is NOT pulled overnight — a 2am pull can only come back empty', () => {
  const rules = defaultScanRules();
  for (const h of [0, 1, 2, 3]) {
    assert.equal(resolveInterval('completed', TUE, h, rules), null, `${h}:00 must not pull completed`);
  }
  // …while the plan is still watched overnight, because routing tails off through it.
  assert.equal(resolveInterval('planned', TUE, 2, rules), 60);
});

test('Saturday is silent, and Sunday evening wakes up for Monday routing', () => {
  const rules = defaultScanRules();
  for (const kind of SCAN_KINDS) {
    for (let h = 0; h < 24; h++) {
      assert.equal(resolveInterval(kind, SAT, h, rules), null, `Sat ${h}:00 ${kind}`);
    }
  }
  assert.equal(resolveInterval('planned', SUN, 21, rules), 15, 'Sunday evening builds Monday');
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

test('a requested interval rounds UP to the cron step — the estimate may not flatter itself', () => {
  assert.equal(effectiveCadence(15), 15);
  assert.equal(effectiveCadence(30), 30);
  assert.equal(effectiveCadence(60), 60);
  assert.equal(effectiveCadence(40), 45, 'ask for 40 on a 15-minute cron and you get 45');
  assert.equal(effectiveCadence(20), 15, 'anything inside one step lands on the step');
  assert.equal(effectiveCadence(90), 90);
});

test('the interval floor is the cron step — a number we cannot deliver is refused, not fudged', () => {
  assert.equal(RULE_BOUNDS.intervalMin[0], 15);
  const [r] = clampScanRules([rule({ intervalMin: 1 })]);
  assert.equal(r.intervalMin, 15);
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
  // One kind, one day, 08:00–12:00, asking for 40 minutes → delivered as 45.
  const rules = [rule({ days: [MON], startHour: 8, endHour: 12, intervalMin: 40 })];
  const est = estimatePlanCalls(rules);
  // 4 hours at a 45-minute cadence = 60/45 per hour × 4 ≈ 5.33 → 5
  assert.equal(est.perDay[MON], 5);
  assert.equal(est.perWeek, 5, 'and nothing on any other day');
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
  assert.ok(est.byKind.completed > est.byKind.planned, 'completed is the one worth scanning hardest');
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
  assert.match(SCAN_INFO.roster.affects, /NOT feed the flags/);
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
  assert.equal(d.completed.due, false);
  assert.match(d.completed.reason, /no rule covers/);
  assert.equal(d.planned.due, true, 'the plan IS watched overnight');
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
  assert.equal(dueKinds(TUE, 9, rules, { completed: at(10) }, now).completed.due, false, '10m < 30-7');
  assert.equal(dueKinds(TUE, 9, rules, { completed: at(24) }, now).completed.due, true, '24m clears 30-7');
  assert.equal(dueKinds(TUE, 9, rules, { completed: at(45) }, now).completed.due, true);
});

test('THE DECOUPLING, ON ONE TICK: completed fires while planned waits', () => {
  const now = Date.parse('2026-08-25T13:00:00Z');   // 9:00a ET Tuesday
  const at = (min) => new Date(now - min * 60000).toISOString();
  // 20 minutes since both last ran. Completed wants 15, planned wants 30.
  const d = dueKinds(TUE, 9, defaultScanRules(), { completed: at(20), planned: at(20) }, now);
  assert.equal(d.completed.due, true, 'completed is due — this is the whole feature');
  assert.equal(d.planned.due, false, 'and the plan is not, so the fire costs 1 call not 3');
});
