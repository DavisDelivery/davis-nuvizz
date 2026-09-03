// THE 6:30 REPORT DID NOT COME, AND NOTHING COVERED FOR IT.
//
// Chad, at half past midnight: "Where is my end of day email I'm supposed to receive at 6:30
// pm it didn't come today."
//
// 2026-09-02: no email in the send log, and no snapshot in Firestore either — while 09-01 has
// one stamped 6:30p. The board was healthy (841 planned, 808 delivered, 31 open), all three
// email gates were open, and another scheduled function on the same site ran at 22:55 UTC. So
// one invocation produced nothing, and the cron's SECOND firing — which exists only for
// daylight saving — stood down as it always does rather than covering.
//
// These pin the rule that lets the spare cover, and the winter case that makes it dangerous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReportHour, isAfterReportTime, previousDay, REPORT_HOUR_ET, REPORT_MINUTE_ET,
} from '../netlify/functions/day-completion-report-background.mts';

// The two UTC slots the cron fires, expressed as the ET wall clock they land on.
const EDT = { primary: [18, 30], spare: [19, 30] };   // 22:30 and 23:30 UTC, clocks ahead
const EST = { early: [17, 30], primary: [18, 30] };   // 22:30 and 23:30 UTC, clocks back

test('summer: 22:30 UTC is the real 6:30 and 23:30 UTC is the spare', () => {
  assert.equal(isReportHour(...EDT.primary), true);
  assert.equal(isReportHour(...EDT.spare), false);
  // The spare is PAST report time, so it is allowed to cover a failed primary.
  assert.equal(isAfterReportTime(...EDT.spare), true);
});

test('WINTER: the earlier firing must NOT cover — 6:30 has not happened yet', () => {
  // The case that makes a naive "the other slot retries" rule dangerous. At 17:30 ET the day
  // is still running; covering here would mail a half-finished board every evening from
  // November to March, and it would look exactly like a working report.
  assert.equal(isReportHour(...EST.early), false);
  assert.equal(isAfterReportTime(...EST.early), false, 'a 5:30pm firing may never stand in for 6:30');
  assert.equal(isReportHour(...EST.primary), true);
});

test('the minute matters: 6:29 is not yet the report and may not cover', () => {
  assert.equal(isReportHour(18, 29), false);
  assert.equal(isAfterReportTime(18, 29), false);
  assert.equal(isReportHour(18, 30), true);
  assert.equal(isAfterReportTime(18, 30), true);
});

test('anything later in the evening counts as past report time', () => {
  for (const h of [19, 20, 21, 22, 23]) {
    assert.equal(isAfterReportTime(h, 0), true, `${h}:00`);
    assert.equal(isReportHour(h, 0), false, `${h}:00 is not the primary`);
  }
});

test('the small hours are NOT past report time — a new day has started', () => {
  // 00:xx ET is a different calendar day, and etDayString would name that new day. Covering
  // here would build "today's" report from a board with nothing on it yet.
  for (const h of [0, 1, 6, 12, 17]) {
    assert.equal(isAfterReportTime(h, 45), h > REPORT_HOUR_ET, `${h}:45`);
  }
  assert.equal(isAfterReportTime(0, 0), false);
});

test('the two predicates agree at exactly one hour — the primary is a subset of past', () => {
  // If a firing is the real 6:30, it is by definition past 6:30. A spare is only ever
  // reached when the primary predicate said no, so an overlap here would double-run.
  for (let h = 0; h < 24; h += 1) {
    for (const m of [0, 29, 30, 31, 59]) {
      if (isReportHour(h, m)) assert.equal(isAfterReportTime(h, m), true, `${h}:${m}`);
    }
  }
  assert.equal(REPORT_HOUR_ET, 18);
  assert.equal(REPORT_MINUTE_ET, 30);
});

test('previousDay still walks the calendar, including across a month end', () => {
  // The spare firing reconciles yesterday too, so this stays load-bearing.
  assert.equal(previousDay('2026-09-02'), '2026-09-01');
  assert.equal(previousDay('2026-09-01'), '2026-08-31');
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
  assert.equal(previousDay('2026-03-01'), '2026-02-28');
});
