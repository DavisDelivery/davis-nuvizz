// test/scan-schedule.test.mjs — elapsed-time scan cadence + feed windows.
// Regression for DEFECT 1 (wall-clock-minute gate no-op'd jittered */15 fires)
// and DEFECT 2 (tomorrow's orders were never descended).
import test from 'node:test';
import assert from 'node:assert/strict';

import { scanDecision, intervalForHour, nowET } from '../netlify/functions/lib/scan-schedule.mts';

// 2026-06-17 is EDT (UTC-4). Build a Date at a given ET hour/min.
const at = (etHour, etMin = 0) => new Date(Date.UTC(2026, 5, 17, etHour + 4, etMin, 0));
const ago = (now, min) => new Date(now.getTime() - min * 60000).toISOString();

test('test harness maps ET hours correctly (EDT UTC-4)', () => {
  assert.equal(nowET(at(14, 3)).hour, 14);
  assert.equal(nowET(at(21)).hour, 21);
  assert.equal(nowET(at(0)).hour, 0);
});

test('intervalForHour: 15/30/60 by window', () => {
  assert.equal(intervalForHour(5), 15);
  assert.equal(intervalForHour(9), 30);
  assert.equal(intervalForHour(14), 60);
  assert.equal(intervalForHour(2), 60);  // overnight
  assert.equal(intervalForHour(0), 60);
});

test('DEFECT 1 fixed: a jittered :03 fire scans when the interval has elapsed', () => {
  const now = at(14, 3);                         // 2:03pm ET — old minute===0 gate would no-op
  const d = scanDecision(now, false, ago(now, 58)); // 58 min since last load scan
  assert.equal(d.act, true);
  assert.equal(d.intervalMin, 60);
  assert.equal(d.skip, 'none');
});

test('cadence skip when not enough elapsed; floor skip when too soon', () => {
  const now = at(14, 3);
  assert.equal(scanDecision(now, false, ago(now, 20)).skip, 'cadence'); // 20 < 60-7
  const f = scanDecision(now, false, ago(now, 5));                      // 5 < 10 floor
  assert.equal(f.act, false);
  assert.equal(f.skip, 'floor');
});

test('never-scanned (null) always acts (elapsed=Infinity)', () => {
  const now = at(14, 3);
  const d = scanDecision(now, false, null);
  assert.equal(d.act, true);
  assert.equal(d.elapsedMin, Infinity);
});

test('cadence by window: 30-min (7am-1pm) and 15-min (4-7am, floor-bound)', () => {
  const m = at(9, 7);
  assert.equal(scanDecision(m, false, ago(m, 24)).act, true);   // 24 >= 30-7
  assert.equal(scanDecision(m, false, ago(m, 20)).act, false);  // 20 < 23
  const e = at(5, 2);
  assert.equal(scanDecision(e, false, ago(e, 11)).act, true);   // 11 >= max(15-7, floor10)
  assert.equal(scanDecision(e, false, ago(e, 9)).skip, 'floor'); // 9 < 10 floor
});

test('DEFECT 2 fixed: tomorrow orders descend 10am-midnight; loads only 8pm-midnight', () => {
  const two = scanDecision(at(14), false, ago(at(14), 90));   // 2pm
  assert.equal(two.scanTodayUnplanned, true);
  assert.equal(two.scanTomorrowUnplanned, true, 'tomorrow orders scan at 2pm');
  assert.equal(two.scanTomorrowLoads, false, 'tomorrow loads not yet (pre-8pm)');

  const nine = scanDecision(at(21), false, ago(at(21), 90));  // 9pm
  assert.equal(nine.scanTomorrowLoads, true);
  assert.equal(nine.scanTomorrowUnplanned, true);
});

test('before 10am: acts on loads but no order descent for either day', () => {
  const d = scanDecision(at(9), false, ago(at(9), 90));
  assert.equal(d.act, true);
  assert.equal(d.scanTodayUnplanned, false);
  assert.equal(d.scanTomorrowUnplanned, false);
  assert.equal(d.scanTomorrowLoads, false);
});

test('manual: always acts, full scan, floor bypassed', () => {
  const now = at(2);                              // 2am overnight
  const d = scanDecision(now, true, ago(now, 1)); // 1 min ago → would floor-skip if scheduled
  assert.equal(d.act, true);
  assert.equal(d.scanTodayUnplanned, true);
  assert.equal(d.scanTomorrowLoads, true);
  assert.equal(d.scanTomorrowUnplanned, true);
  assert.equal(d.reason, 'manual');
});
