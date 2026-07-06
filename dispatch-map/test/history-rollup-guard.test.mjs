// test/history-rollup-guard.test.mjs
//
// Unit tests for the PURE logic of the history-rollup guard
// (lib/history-rollup-guard.mts) — the piece that makes a silent rollup drift
// (the 2026-07-06 incident) structurally impossible. The Firestore-touching
// orchestration (applyRollupForDay / sweepRollupBacklog) is integration-covered by
// the live rebuild endpoint; here we lock down the date math + backlog logic that
// decides WHICH days get healed and WHEN we alert.
//
// Run with: npm test   (node --test — Node ≥ 22 strips the .mts types natively).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recentWeekdays, reconcileList, nextPending, businessDaysBetween, shouldAlert,
  ROLLUP_ALERT_THRESHOLD,
} from '../netlify/functions/lib/history-rollup-guard.mts';

// ── recentWeekdays: N most-recent weekdays strictly before `today`, newest first ──
test('recentWeekdays: Monday looks back past the weekend to Fri/Thu/Wed', () => {
  // 2026-07-06 is a Monday; 07-04/07-05 are Sat/Sun and must be skipped.
  assert.deepEqual(recentWeekdays('2026-07-06', 3), ['2026-07-03', '2026-07-02', '2026-07-01']);
});
test('recentWeekdays: n=1 from Monday is the prior Friday', () => {
  assert.deepEqual(recentWeekdays('2026-07-06', 1), ['2026-07-03']);
});
test('recentWeekdays: from a Friday steps back over weekdays only', () => {
  // 2026-07-10 is a Friday.
  assert.deepEqual(recentWeekdays('2026-07-10', 2), ['2026-07-09', '2026-07-08']);
});
test('recentWeekdays: n<=0 and empty today yield []', () => {
  assert.deepEqual(recentWeekdays('2026-07-06', 0), []);
  assert.deepEqual(recentWeekdays('', 3), []);
});

// ── reconcileList: backlog ∪ trailing, de-duped, OLDEST-first, capped ──────────
test('reconcileList: unions backlog + trailing, de-dupes, sorts oldest-first', () => {
  assert.deepEqual(
    reconcileList(['2026-06-11', '2026-07-02'], ['2026-07-03', '2026-07-02', '2026-07-01'], 14),
    ['2026-06-11', '2026-07-01', '2026-07-02', '2026-07-03'],
  );
});
test('reconcileList: cap keeps the OLDEST days (so gaps converge)', () => {
  assert.deepEqual(
    reconcileList(['2026-06-03', '2026-06-01', '2026-06-02'], [], 2),
    ['2026-06-01', '2026-06-02'],
  );
});
test('reconcileList: drops falsy entries', () => {
  assert.deepEqual(reconcileList(['2026-06-01', '', null], [undefined], 14), ['2026-06-01']);
});

// ── nextPending: add on failure, remove on success, de-duped + sorted ──────────
test('nextPending: failure adds the day', () => {
  assert.deepEqual(nextPending([], '2026-07-02', false), ['2026-07-02']);
});
test('nextPending: success removes the day', () => {
  assert.deepEqual(nextPending(['2026-07-02', '2026-06-11'], '2026-07-02', true), ['2026-06-11']);
});
test('nextPending: re-failing an already-backlogged day is idempotent', () => {
  assert.deepEqual(nextPending(['2026-07-02'], '2026-07-02', false), ['2026-07-02']);
});

// ── businessDaysBetween: Mon–Fri days in (from, to] ────────────────────────────
test('businessDaysBetween: skips the weekend between Thu and Mon', () => {
  // (2026-07-02, 2026-07-06] → Fri 07-03 + Mon 07-06 = 2 (07-04/05 are weekend).
  assert.equal(businessDaysBetween('2026-07-02', '2026-07-06'), 2);
});
test('businessDaysBetween: same day / reversed is 0', () => {
  assert.equal(businessDaysBetween('2026-07-06', '2026-07-06'), 0);
  assert.equal(businessDaysBetween('2026-07-06', '2026-07-02'), 0);
});
test('businessDaysBetween: adjacent weekdays = 1', () => {
  assert.equal(businessDaysBetween('2026-07-01', '2026-07-02'), 1);
});

// ── shouldAlert: empty backlog never alerts; else on persistence OR age ────────
test('shouldAlert: empty backlog never alerts, even after many failures', () => {
  assert.equal(shouldAlert([], 99, '2026-07-06'), false);
});
test('shouldAlert: consecutive failures at threshold alerts', () => {
  assert.equal(shouldAlert(['2026-07-05'], ROLLUP_ALERT_THRESHOLD, '2026-07-06'), true);
});
test('shouldAlert: a fresh one-run miss does not alert', () => {
  // 07-02 is only 2 business days behind 07-06, and just 1 consecutive failure.
  assert.equal(shouldAlert(['2026-07-02'], 1, '2026-07-06'), false);
});
test('shouldAlert: an old backlogged day alerts on age alone', () => {
  // 06-30 is 4 business days behind 07-06 (≥ threshold) despite only 1 failure.
  assert.equal(shouldAlert(['2026-06-30'], 1, '2026-07-06'), true);
});
