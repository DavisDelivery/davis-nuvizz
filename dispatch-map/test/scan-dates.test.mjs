// test/scan-dates.test.mjs — scheduled-scan date horizon (today + next business
// day). Business-day stepping so a Friday run covers Monday, not empty Saturday.
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextBusinessDayUTC, scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';

test('nextBusinessDayUTC skips weekends', () => {
  assert.equal(nextBusinessDayUTC('2026-06-16'), '2026-06-17', 'Tue after Mon');
  assert.equal(nextBusinessDayUTC('2026-06-19'), '2026-06-22', 'Fri → Mon (skip Sat/Sun)');
  assert.equal(nextBusinessDayUTC('2026-06-18'), '2026-06-19', 'Thu → Fri');
});

test('scanDatesFrom: today + next business day (default horizon = 2)', () => {
  assert.deepEqual(scanDatesFrom('2026-06-16', 2), ['2026-06-16', '2026-06-17'], 'Mon + Tue');
  assert.deepEqual(scanDatesFrom('2026-06-19', 2), ['2026-06-19', '2026-06-22'], 'Fri + Mon');
});

test('scanDatesFrom: n=1 is today only; n=3 spans three business days', () => {
  assert.deepEqual(scanDatesFrom('2026-06-16', 1), ['2026-06-16']);
  assert.deepEqual(scanDatesFrom('2026-06-19', 3), ['2026-06-19', '2026-06-22', '2026-06-23'], 'Fri,Mon,Tue');
});
