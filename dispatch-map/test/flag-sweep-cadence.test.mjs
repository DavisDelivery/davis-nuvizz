// The flag sweeps now run on the scanner's own five-minute tick, not once an hour.
//
// Chad, 2026-09-22: "SO RUN THE FLAG SWEEPS RIGHT AFTER OUR SCANS SO THEY ARE MUCH MORE
// CURRENT NOT ONCE PER HOUR AS THE FLAG SWEEPS ARE FREE AND COST NOTHING WITH NUVIZZ."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sweepDue, everyTickEnabled, TICK_MIN, LEGACY_STEP_MIN,
} from '../netlify/functions/lib/flag-sweep-cadence.mts';

const ON = {};                       // nothing set — the shipped default
const OFF = { FLAG_SWEEP_EVERY_TICK: 'off' };

test('by default every fire works — a 4:47a board is judged at 4:50a, not at 5:00a', () => {
  for (let m = 0; m < 24 * 60; m += TICK_MIN) {
    assert.equal(sweepDue(m, LEGACY_STEP_MIN.evening, ON), true, `stood down at ${m}`);
  }
});

test('FLAG_EARLY off-words are the only thing that turns it off', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'No', ' off ']) {
    assert.equal(everyTickEnabled({ FLAG_SWEEP_EVERY_TICK: v }), false, v);
  }
});

test('a typo leaves the sweeps running — a malformed env must never silence an alert', () => {
  // The house shape, and the reason for it: a quiet feature looks exactly like a working one.
  for (const v of ['offf', 'nope', 'true', 'on', '1', '', 'none', undefined, null, 'ON']) {
    assert.equal(everyTickEnabled({ FLAG_SWEEP_EVERY_TICK: v }), true, String(v));
  }
  assert.equal(everyTickEnabled({}), true);
  assert.equal(everyTickEnabled(undefined), true);
});

test('switched off, the evening sweep is hourly again and the day sweep is every twenty', () => {
  const ran = (step) => {
    const out = [];
    for (let m = 0; m < 24 * 60; m += TICK_MIN) if (sweepDue(m, step, OFF)) out.push(m);
    return out;
  };
  const hourly = ran(LEGACY_STEP_MIN.evening);
  assert.equal(hourly.length, 24);
  assert.deepEqual(hourly.slice(0, 4), [0, 60, 120, 180]);
  const twenty = ran(LEGACY_STEP_MIN.day);
  assert.equal(twenty.length, 72);
  assert.deepEqual(twenty.slice(0, 4), [0, 20, 40, 60]);
});

test('the off path absorbs cron jitter instead of no-opping on it', () => {
  // The scanner carries a comment about exactly this: a `minute === 0` gate silently dropped
  // every fire that landed at :01. A fire anywhere in the first tick of the step counts.
  for (let jitter = 0; jitter < TICK_MIN; jitter += 1) {
    assert.equal(sweepDue(60 + jitter, LEGACY_STEP_MIN.evening, OFF), true, `jitter ${jitter}`);
  }
  assert.equal(sweepDue(60 + TICK_MIN, LEGACY_STEP_MIN.evening, OFF), false);
});

test('every uncertain input resolves toward LOOKING, never toward standing down', () => {
  for (const bad of [NaN, -1, undefined, null, 'x']) {
    assert.equal(sweepDue(bad, LEGACY_STEP_MIN.evening, OFF), true, `etMin ${bad}`);
  }
  for (const bad of [NaN, 0, -5, undefined, null, 'x', TICK_MIN]) {
    assert.equal(sweepDue(600, bad, OFF), true, `step ${bad}`);
  }
});

// ── THE CRON IS THE OTHER HALF OF THIS, so it is pinned here too ─────────────
// A module that says "every five minutes" beside a function still scheduled hourly is the
// intent-as-outcome mistake this repo keeps paying for. These read the real files.
const cronOf = (f) => {
  const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
  // Tolerant of a comment block between the brace and the field — the scanner has one.
  const m = src.match(/export const config = \{[\s\S]*?schedule: '([^']+)'/);
  return m ? m[1] : null;
};

test('both sweeps are actually scheduled on the five-minute tick', () => {
  assert.equal(cronOf('eta-flag-evening-background.mts'), '*/5 0-11 * * *');
  assert.equal(cronOf('eta-flag-alert-background.mts'), '*/5 11-23 * * 1-5');
});

test('and the tick they fire on is the scanner\'s own', () => {
  assert.equal(cronOf('nuvizz-refresh-stops-background.mts'), `*/${TICK_MIN} * * * *`);
});
