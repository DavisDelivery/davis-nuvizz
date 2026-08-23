// test/completion-pct.test.mjs — a percentage that cannot lie about a finished day.
//
// The 6:30 report's subject line is "Day board <date> — N open, X% complete", read on a
// phone. Plain rounding made the two halves of that sentence contradict each other on the
// size of board this operation actually runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { completionPct, formatCompletionPct } from '../src/lib/completion-pct.js';
import { buildDayCompletion, dayCompletionSubject } from '../netlify/functions/lib/day-completion.mts';

test('815 of 816 is NOT "100% complete" — that stop is still out there', () => {
  // The real numbers off 2026-08-20: 816 planned. One open stop is 99.88%, and plain
  // rounding printed it as a finished day — in the same line as "1 open".
  assert.equal(formatCompletionPct(815 / 816), '99%');
  assert.equal(formatCompletionPct(1630 / 1631), '99%');
  assert.equal(formatCompletionPct(812 / 816), '99%', 'four open still is not done');
});

test('100% is reserved for actually done, and 0% for actually nothing', () => {
  assert.equal(completionPct(1), 100);
  assert.equal(completionPct(816 / 816), 100);
  assert.equal(completionPct(0), 0);
  // ...and the other end: one delivery out of thousands is not "0% complete".
  assert.equal(completionPct(1 / 5000), 1, 'something happened — say so');
});

test('an ordinary partial rate is untouched', () => {
  assert.equal(formatCompletionPct(0.898), '90%');
  assert.equal(formatCompletionPct(0.5), '50%');
  assert.equal(formatCompletionPct(0.977), '98%');
});

test('no rate at all is an em dash, never 0% and never NaN%', () => {
  // Number(null) is 0 and 0 is finite — this repo has already shipped a customer-service
  // email announcing a midnight deadline for a stop that had no deadline at all.
  for (const v of [null, undefined, NaN, 'x', {}]) {
    assert.equal(formatCompletionPct(v), '—', JSON.stringify(v));
  }
});

test('THE SENTENCE AGREES WITH ITSELF: the subject cannot say "1 open, 100% complete"', () => {
  // End to end through the real builder, because the bug was only visible where the two
  // halves are printed side by side.
  const stops = [
    ...Array.from({ length: 815 }, (_, i) => ({ stopNbr: `d${i}`, status: '90', isPlanned: true, loadNbr: 'R1' })),
    { stopNbr: 'open1', status: '20', isPlanned: true, loadNbr: 'R1' },
  ];
  const d = buildDayCompletion(stops, { date: '2026-08-20', asOf: '18:30' });
  assert.equal(d.open, 1);
  const subject = dayCompletionSubject(d);
  assert.match(subject, /1 open/);
  assert.ok(!/100% complete/.test(subject), `the day is not finished: ${subject}`);
  assert.match(subject, /99% complete/);
});
