// test/saturday-heal.test.mjs — ONE SCAN AT 7AM SATURDAY, AND EXACTLY ONE (v0.95.2).
//
// Chad, on leaving the Friday schedule alone: "fridays schedule is fine if i need fresh data
// before sunday's scans start i can manually refresh and just make sure that pulls all the
// correct data and heals. We could also schedule one scan at 7 am saturday to heal anything."
//
// The word ONE is the design. Two weekend carve-outs shipped before this and both were
// reverted: "let this rule run at the weekend", replayed on a five-minute cron, took a Saturday
// from 0 vendor calls to 65 before anybody pressed anything. So these tests pin the shape that
// makes one mean one — and, because a schedule that acts but pulls nothing is worse than no
// schedule at all, they check the whole chain (blackout gate → per-kind rules → scan path)
// rather than any single half of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDecision, isSaturdayHeal, isWeekendBlackout, SAT_HEAL_MIN_GAP_MIN } from '../netlify/functions/lib/scan-schedule.mts';
import { defaultScanRules, dueKinds, scanPath } from '../netlify/functions/lib/scan-plan.mts';

const FRI_LAST = '2026-09-11T23:50:00Z';          // Friday 19:50 ET — the week's last scheduled scan
const rules = defaultScanRules();
// The whole chain for one cron tick: what the gate decides, what the rules say is due, and
// therefore what the scan actually does.
function tick(iso, { lastScan = FRI_LAST } = {}) {
  const t = new Date(iso);
  const et = new Date(t.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const decision = scanDecision(t, false, lastScan, {});
  const due = dueKinds(et.getDay(), et.getHours(), rules, { planned: lastScan, completed: lastScan, roster: lastScan }, t.getTime());
  return {
    etHour: et.getHours(), weekday: et.getDay(), act: decision.act, skip: decision.skip, reason: decision.reason,
    path: scanPath(decision.act, { plannedDue: due.planned.due, completedDue: due.completed.due, rosterDue: due.roster.due }),
    rosterDue: due.roster.due,
  };
}

test('Saturday 07:05, after Friday evening: the scan RUNS — the blackout gate opens and both saved searches are due, so the path is a full pull', () => {
  const t = tick('2026-09-12T11:05:00Z');
  assert.equal(t.weekday, 6);
  assert.equal(t.etHour, 7);
  assert.equal(t.act, true);
  assert.equal(t.skip, 'none');
  assert.match(t.reason, /saturday heal/);
  assert.equal(t.path, 'full', 'a decision that acts but pulls nothing would be a schedule that only looks like it works');
});

test('…and NOT the roster: the reverted carve-out turned a Saturday into forty-one roster pulls, and a heal does not need one', () => {
  assert.equal(tick('2026-09-12T11:05:00Z').rosterDue, false);
});

test('every other Saturday tick is still blacked out — the window is one hour, not a rule that runs all weekend', () => {
  for (const iso of ['2026-09-12T09:05:00Z', '2026-09-12T13:05:00Z', '2026-09-12T16:05:00Z', '2026-09-12T23:05:00Z']) {
    const t = tick(iso);
    assert.equal(t.act, false, `${t.etHour}:05 must not scan`);
    assert.equal(t.skip, 'weekend');
    assert.equal(t.path, 'skip');
  }
});

test('once it has run, the rest of the hour does nothing: the next tick sees a fresh stamp and the gate closes', () => {
  const t = tick('2026-09-12T11:40:00Z', { lastScan: '2026-09-12T11:05:00Z' });
  assert.equal(t.act, false);
  assert.equal(t.skip, 'weekend');
  assert.equal(t.path, 'skip');
});

test('a fire that FAILED is retried inside the window — the gap is still open, so the next tick acts', () => {
  const t = tick('2026-09-12T11:50:00Z');          // still nothing since Friday
  assert.equal(t.act, true);
  assert.match(t.reason, /saturday heal/);
});

test('the gate itself: Saturday, the heal hour, and a real gap — anything else is false', () => {
  assert.equal(isSaturdayHeal(6, 7, SAT_HEAL_MIN_GAP_MIN), true);
  assert.equal(isSaturdayHeal(6, 7, SAT_HEAL_MIN_GAP_MIN - 1), false, 'something scanned recently');
  assert.equal(isSaturdayHeal(6, 6, 999), false);
  assert.equal(isSaturdayHeal(6, 8, 999), false);
  assert.equal(isSaturdayHeal(0, 7, 999), false, 'Sunday has its own resume hour');
  assert.equal(isSaturdayHeal(5, 7, 999), false, 'Friday is a working day');
  assert.equal(isSaturdayHeal(6, 7, 999, { saturdayHealHour: 0 }), false, 'set the hour to 0 and the heal is off');
  assert.equal(isSaturdayHeal(6, 9, 999, { saturdayHealHour: 9 }), true, 'and the hour is configurable');
  // The blackout itself is unchanged — Saturday is still a blackout day.
  assert.equal(isWeekendBlackout(6, 7), true);
});

test('Sunday and the working week are untouched: the Sunday resume still governs, and Monday runs its own rules', () => {
  assert.equal(tick('2026-09-13T11:05:00Z').act, false, 'Sunday 07:05 is still blacked out');
  const sunEve = tick('2026-09-13T23:05:00Z');                       // Sun 19:05 ET — the resume
  assert.equal(sunEve.act, true);
  assert.match(sunEve.reason, /^(?!.*saturday)/, 'that is the normal Sunday resume, not the heal');
  assert.equal(tick('2026-09-14T11:05:00Z').act, true, 'Monday 07:05 runs the ordinary rollout rule');
});

// ── THE MANUAL REFRESH, WHICH IS WHAT NOW CARRIES THE WEEKEND ───────────────────────────────
// Chad: "if i need fresh data before sunday's scans start i can manually refresh and just make
// sure that pulls all the correct data and heals." Two properties make that true, and neither
// is obvious from reading the button: a press has to get PAST the blackout at all, and once
// past it has to run the whole list path rather than a cadence-trimmed slice of it. (That the
// press then heals frozen copies is proven end to end in board-invariants-e2e, which drives the
// real scan through this same manual URL; its per-call cost is pinned in manual-scan-call-cost.)

test('a MANUAL press scans at any weekend hour the schedule refuses — Saturday afternoon, Sunday morning, Friday midnight', () => {
  for (const iso of ['2026-09-12T18:05:00Z', '2026-09-13T13:05:00Z', '2026-09-12T04:05:00Z']) {
    const d = scanDecision(new Date(iso), true, FRI_LAST, {});
    assert.equal(d.act, true);
    assert.equal(d.skip, 'none');
    assert.equal(d.reason, 'manual');
  }
});

test('…and a press makes every kind due, so it pulls BOTH saved searches and the roster rather than only what the hour would have run', () => {
  // Saturday afternoon: no rule covers the hour, so nothing is due on the schedule's own terms.
  const t = new Date('2026-09-12T18:05:00Z');
  const due = dueKinds(6, 14, rules, { planned: FRI_LAST, completed: FRI_LAST, roster: FRI_LAST }, t.getTime());
  assert.equal(due.planned.due, false, 'nothing is due on a Saturday afternoon by the rules');
  // isManual forces all three (refresh-stops-core: `plannedDue = isManual || due.planned.due`),
  // which is what makes the press a FULL pull.
  const isManual = true;
  const path = scanPath(scanDecision(t, isManual, FRI_LAST, {}).act, {
    plannedDue: isManual || due.planned.due,
    completedDue: isManual || due.completed.due,
    rosterDue: isManual || due.roster.due,
  });
  assert.equal(path, 'full', 'a manual press runs the whole list path — both searches and the roster');
});
