// Closed-day detection from NuVizz order instructions — the Uline "CLOSED ON
// FRIDAYS" format (optional "ON", optional plural "S") plus the legacy forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStopFull } from '../src/lib/signal-scanner.ts';

const days = (instr) => scanStopFull({ signalSources: { orderInstructions: instr } }).closedDays.map((c) => c.day).sort();

test('Uline format "CLOSED ON FRIDAYS" → fri', () => {
  assert.deepEqual(days('CLOSED ON FRIDAYS'), ['fri']);
});

test('Uline format with trailing total line (the real screenshot text) → fri', () => {
  assert.deepEqual(days('CLOSED ON FRIDAYS\nTOTAL-AMOUNT : 129.79'), ['fri']);
});

test('"CLOSED ON MONDAYS" → mon', () => {
  assert.deepEqual(days('CLOSED ON MONDAYS'), ['mon']);
});

test('both Mondays and Fridays in one note', () => {
  assert.deepEqual(days('STORE CLOSED ON MONDAYS AND CLOSED ON FRIDAYS'), ['fri', 'mon']);
});

test('legacy forms still match: "CLOSED FRIDAY", "NO FRIDAY", "FRIDAY CLOSED"', () => {
  assert.deepEqual(days('CLOSED FRIDAY'), ['fri']);
  assert.deepEqual(days('NO FRIDAY DELIVERIES'), ['fri']);
  assert.deepEqual(days('FRIDAY CLOSED'), ['fri']);
});

test('singular + ON: "CLOSED ON FRIDAY"; plural without ON: "CLOSED FRIDAYS"', () => {
  assert.deepEqual(days('CLOSED ON FRIDAY'), ['fri']);
  assert.deepEqual(days('CLOSED FRIDAYS'), ['fri']);
});

test('all seven days resolve from the "CLOSED ON <day>S" form', () => {
  assert.deepEqual(days('CLOSED ON MONDAYS'), ['mon']);
  assert.deepEqual(days('CLOSED ON TUESDAYS'), ['tue']);
  assert.deepEqual(days('CLOSED ON WEDNESDAYS'), ['wed']);
  assert.deepEqual(days('CLOSED ON THURSDAYS'), ['thu']);
  assert.deepEqual(days('CLOSED ON SATURDAYS'), ['sat']);
  assert.deepEqual(days('CLOSED ON SUNDAYS'), ['sun']);
});

test('no false positives: a plain total/instruction line flags nothing', () => {
  assert.deepEqual(days('TOTAL-AMOUNT : 129.79'), []);
  assert.deepEqual(days('LIFTGATE REQUIRED'), []);
  assert.deepEqual(days(''), []);
});

test('addressLine2 source also detected (curated field)', () => {
  const r = scanStopFull({ signalSources: { addressLine2: 'STE 5 — CLOSED ON FRIDAYS' } });
  assert.deepEqual(r.closedDays.map((c) => c.day), ['fri']);
});

test('"NO DELIVERIES ON FRIDAYS" is a closed day (corpus, Aug 2026)', () => {
  assert.deepEqual(days('NO DELIVERIES ON FRIDAYS'), ['fri']);
});

test('"CLOSED FRI AT 12PM" is NOT a closed day — the early close belongs to hours', () => {
  assert.deepEqual(days('CLOSED FRI AT 12PM'), []);
  assert.deepEqual(days('FRIDAYS CLOSE AT NOON'), []);
});

// ── DOUGLASVILLE, PRO 007176487 (Chad, 2026-09-15) ────────────────────────────────────
//
// "parser is incorrectly reading this customers hours they are just stating that they are
// closed for lunch 1230-130 and all day friday."
//
// NuVizz cuts a comment at ~25 characters, so the one sentence arrives in two records:
//   "CLOSED MON-THUR 12 30PM-"  /  "1 30 PM AND ALL DAY FRI"
//
// Every one of the four facts in it came out wrong. The hours scanner read the LUNCH CLOSURE
// as the only window the dock receives in, Monday to Thursday — the exact inverse of the
// truth. The closed-day scanner matched "CLOSED MON" out of the span and marked Monday shut,
// a day they are open. Friday, the one real closed day, was missed entirely.

const DOUGLASVILLE = [
  'SPL-INSTR-TEXT: CLOSED MON-THUR 12 30PM-',
  'SPL-INSTR-TEXT: 1 30 PM AND ALL DAY FRI',
  'SPL-INSTR-TEXT: TOTAL-AMOUNT : 59.29',
].join('\n');

const full = (instr) => scanStopFull({ signalSources: { orderInstructions: instr } });

test('DOUGLASVILLE: a lunch closure is not the hour they receive in', () => {
  // They never said when they are open, so the honest answer is that we do not know.
  assert.equal(full(DOUGLASVILLE).hours, null);
});

test('DOUGLASVILLE: Friday is the closed day, and Monday to Thursday are not', () => {
  assert.deepEqual(days(DOUGLASVILLE), ['fri']);
});

test('the sentence reads the same when the comment is not split across records', () => {
  const one = full('CLOSED MON-THUR 12 30PM-1 30 PM AND ALL DAY FRI');
  assert.equal(one.hours, null);
  assert.deepEqual(one.closedDays.map((c) => c.day), ['fri']);
});

test('a closure window is never a closed day: "CLOSED MON-FRI 12-1" shuts nobody out', () => {
  // Marking those five days closed would send no truck at all to a dock open every weekday.
  assert.deepEqual(days('CLOSED MON-FRI 12-1'), []);
  assert.equal(full('CLOSED MON-FRI 12-1').hours, null);
  assert.deepEqual(days('CLOSED TUE 12-1'), []);
});

test('"CLOSED MON-THUR" with no times closes the WHOLE span, not just Monday', () => {
  assert.deepEqual(days('CLOSED MON-THUR'), ['mon', 'thu', 'tue', 'wed'].sort());
  assert.deepEqual(days('CLOSED SAT-SUN'), ['sat', 'sun']);
});

test('"MON-FRI 8-5 CLOSED SAT-SUN" keeps the weekday hours and closes both weekend days', () => {
  const o = full('MON-FRI 8-5 CLOSED SAT-SUN');
  assert.deepEqual(o.hours.byDay.mon, { open: '08:00', close: '17:00' });
  assert.deepEqual(o.closedDays.map((c) => c.day).sort(), ['sat', 'sun']);
});

test('ALL DAY closes a day only when a closure word governs it', () => {
  assert.deepEqual(days('CLOSED ALL DAY FRI'), ['fri']);
  assert.deepEqual(days('CLOSED SAT AND ALL DAY SUN'), ['sat', 'sun']);
  // The opposite instruction must never be read as a closure.
  assert.deepEqual(days('OPEN ALL DAY FRI'), []);
  assert.deepEqual(days('WE ARE OPEN ALL DAY MON'), []);
});

test('a closure word only governs the span it sits against', () => {
  // "CLOSED SAT, MON-FRI 8-5" — Saturday is shut and the weekday hours still read.
  const o = full('CLOSED SAT, MON-FRI 8-5');
  assert.deepEqual(o.hours.byDay.mon, { open: '08:00', close: '17:00' });
  assert.deepEqual(o.closedDays.map((c) => c.day), ['sat']);
});

test('an early close is still hours, never a closed day', () => {
  for (const t of ['CLOSED FRI AT 12PM', 'CLOSE FRI AT NOON', 'FRIDAYS CLOSE AT 12PM']) {
    assert.deepEqual(days(t), [], t);
    assert.equal(full(t).hours.byDay.fri.close, '12:00', t);
  }
});
