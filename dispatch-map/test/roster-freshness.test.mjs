// test/roster-freshness.test.mjs — future-date load-roster freshness (the "plan
// tomorrow today" fix). The old behavior captured tomorrow's roster ONCE per scan
// day; loads created in the portal during the day (with the load NUMBERS every
// Save is keyed by) never reached the board until the next morning, so evening
// reorder/unplan Saves were refused ("needs a load number", Jul 1 2026 night).
// futureRosterIsFresh is the gate: fresh (skip re-pull) ONLY within the short
// dedupe window; anything older — and anything empty/garbled — re-pulls.
import test from 'node:test';
import assert from 'node:assert/strict';

import { futureRosterIsFresh } from '../netlify/functions/lib/refresh-stops-core.mts';

const NOW = Date.parse('2026-07-02T20:00:00Z');
const atMinAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const LOADS = [{ loadId: 'a', name: '2 M', loadNbr: 'DAVIS000198000' }];

test('within the dedupe window (default 5 min) a non-empty roster is fresh — skip re-pull', () => {
  assert.equal(futureRosterIsFresh({ at: atMinAgo(2), loads: LOADS }, NOW), true);
});

test('older than the window → stale, re-pull (this is the all-day refresh that pulls tomorrow in today)', () => {
  assert.equal(futureRosterIsFresh({ at: atMinAgo(6), loads: LOADS }, NOW), false);
  // The old once-per-day behavior would have called this "fresh" all day long — a
  // same-scan-day morning capture must now read as STALE by the afternoon/evening.
  assert.equal(futureRosterIsFresh({ at: atMinAgo(11 * 60), loads: LOADS }, NOW), false);
});

test('an EMPTY roster is never fresh (tomorrow’s loads may simply not exist yet)', () => {
  assert.equal(futureRosterIsFresh({ at: atMinAgo(1), loads: [] }, NOW), false);
  assert.equal(futureRosterIsFresh({ at: atMinAgo(1) }, NOW), false);
});

test('missing/garbled cache is never fresh', () => {
  assert.equal(futureRosterIsFresh(null, NOW), false);
  assert.equal(futureRosterIsFresh(undefined, NOW), false);
  assert.equal(futureRosterIsFresh({ loads: LOADS }, NOW), false);
  assert.equal(futureRosterIsFresh({ at: 'not-a-date', loads: LOADS }, NOW), false);
});

test('NUVIZZ_ROSTER_FRESH_MIN widens the window; floor is 1 minute', () => {
  const prev = process.env.NUVIZZ_ROSTER_FRESH_MIN;
  try {
    process.env.NUVIZZ_ROSTER_FRESH_MIN = '30';
    assert.equal(futureRosterIsFresh({ at: atMinAgo(20), loads: LOADS }, NOW), true);
    assert.equal(futureRosterIsFresh({ at: atMinAgo(31), loads: LOADS }, NOW), false);
    process.env.NUVIZZ_ROSTER_FRESH_MIN = '0'; // nonsense → floored to 1, never "always stale-proof"
    assert.equal(futureRosterIsFresh({ at: atMinAgo(0.5), loads: LOADS }, NOW), true);
    assert.equal(futureRosterIsFresh({ at: atMinAgo(2), loads: LOADS }, NOW), false);
  } finally {
    if (prev === undefined) delete process.env.NUVIZZ_ROSTER_FRESH_MIN;
    else process.env.NUVIZZ_ROSTER_FRESH_MIN = prev;
  }
});
