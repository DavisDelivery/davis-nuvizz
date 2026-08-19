// THE GROUND-TRUTH LABEL. scoreDay decides, for every stop that had a real receiving
// deadline and a real arrival stamp, whether we made it. The rules that matter most are
// the REFUSALS: a stop with a deadline and no stamp is "we cannot tell", not "made it",
// and counting it as made would flatter every number the flag system is ever judged by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDay, weekdayKey } from '../netlify/functions/lib/miss-ledger.mts';

const DATE = '2026-08-17';                       // a Monday
const typed = { manual_overrides: { receiving_hours: true }, receiving_hours: { mon: { open: '08:00', close: '14:00' } } };
const auto = { receiving_hours: { mon: { open: '08:00', close: '14:00' } } };
const notes = { c1: typed, c2: typed, c3: auto, c4: typed };
const noteFor = (k) => notes[k] ?? null;
const stop = (o) => ({ stopNbr: o.n, matchKey: o.k, businessName: o.b || o.k, loadNbr: 'L1', ...o });

test('weekdayKey is noon-anchored so a DST boundary cannot roll the day', () => {
  assert.equal(weekdayKey('2026-08-17'), 'mon');
  assert.equal(weekdayKey('2026-11-01'), 'sun');   // US DST fall-back date
  assert.equal(weekdayKey(''), null);
});

test('an arrival after the close is a miss; before it is not', () => {
  const { rows, summary } = scoreDay([
    stop({ n: '1', k: 'c1', arrivalDTTM: `${DATE}T15:10` }),   // 70 min late
    stop({ n: '2', k: 'c2', arrivalDTTM: `${DATE}T13:30` }),   // made it
  ], DATE, noteFor);
  assert.equal(summary.scored, 2);
  assert.equal(summary.missed, 1);
  assert.equal(summary.miss_rate_pct, 50);
  assert.equal(rows.find((r) => r.stopNbr === '1').lateBy, 70);
  assert.equal(rows.find((r) => r.stopNbr === '2').missed, false);
});

test('a stop with a deadline and NO stamp is unscorable, never counted as made', () => {
  const { summary } = scoreDay([
    stop({ n: '1', k: 'c1', arrivalDTTM: `${DATE}T15:10` }),
    stop({ n: '2', k: 'c2' }),                                          // never stamped
    stop({ n: '3', k: 'c4', deliveredDTTM: '', normalizedStatus: 'DELIVERED' }), // finished, no usable stamp
  ], DATE, noteFor);
  assert.equal(summary.scored, 1, 'only the stamped stop is scorable');
  assert.equal(summary.missed, 1);
  assert.equal(summary.miss_rate_pct, 100, 'the rate is over SCORED stops, not all stops');
  assert.equal(summary.unscorable.never_stamped, 1);
  assert.equal(summary.unscorable.finished_but_no_stamp, 1);
});

test('a stop with no hours on file is unscorable and reported as such', () => {
  const { summary } = scoreDay([stop({ n: '9', k: 'nobody', arrivalDTTM: `${DATE}T15:10` })], DATE, noteFor);
  assert.equal(summary.scored, 0);
  assert.equal(summary.unscorable.no_receiving_hours_on_file, 1);
});

test('typed and auto-detected hours are counted separately — one is a harder fact', () => {
  const { summary } = scoreDay([
    stop({ n: '1', k: 'c1', arrivalDTTM: `${DATE}T15:10` }),   // typed, missed
    stop({ n: '3', k: 'c3', arrivalDTTM: `${DATE}T16:00` }),   // auto, missed
  ], DATE, noteFor);
  assert.equal(summary.scored, 2);
  assert.equal(summary.missed, 2);
  assert.equal(summary.scored_typed, 1);
  assert.equal(summary.missed_typed, 1);
});

test('a stamp dated to another day never scores this day', () => {
  const { summary } = scoreDay([stop({ n: '1', k: 'c1', arrivalDTTM: '2026-08-16T15:10' })], DATE, noteFor);
  assert.equal(summary.scored, 0);
  assert.equal(summary.unscorable.never_stamped, 1);
});

test('the worst misses are surfaced with how late they were', () => {
  // Three misses, so the nearest-rank median lands on a single unambiguous value.
  const { summary } = scoreDay([
    stop({ n: '1', k: 'c1', b: 'PYROK INC', arrivalDTTM: `${DATE}T17:00` }),   // 180 late
    stop({ n: '2', k: 'c2', b: 'ACME', arrivalDTTM: `${DATE}T15:00` }),        //  60 late
    stop({ n: '3', k: 'c4', b: 'BETA', arrivalDTTM: `${DATE}T14:30` }),        //  30 late
  ], DATE, noteFor);
  assert.equal(summary.missed, 3);
  assert.equal(summary.worst[0].customer, 'PYROK INC');
  assert.equal(summary.worst[0].late_min, 180);
  assert.equal(summary.late_median_min, 60);
  assert.equal(summary.late_p90_min, 180);
});
