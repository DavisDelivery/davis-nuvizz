// Map time marks — pinned against the 2026-08-21 board, where the old blanket clock put
// 116 icons on 755 stops and 67 of them were docks open a full working day.
//
// The rule these tests exist to protect: a mark has to change what a dispatcher DOES.
// "This customer has hours on file" does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTimeMark, timeMarkForDay, dayWindowMinutes, TIME_MARK_KEYS,
  SHUTS_EARLY_BEFORE, EARLY_CLOSE_BEFORE, OPENS_LATE_FROM, OPENS_EARLY_BY,
} from '../src/lib/time-marks.js';

const at = (h, m = 0) => h * 60 + m;
const typed = (open, close) => ({
  receiving_hours: { fri: { open, close } },
  manual_overrides: { receiving_hours: true },
});

// ── the silence, which is the whole point ────────────────────────────────────

test('an ordinary working day draws NOTHING — 7a-4p is not a restriction', () => {
  assert.equal(classifyTimeMark(at(7), at(16)), null);
  assert.equal(classifyTimeMark(at(8), at(17)), null, '8-5 is the case Chad called out');
});

test('9-5 is silent in the REPORT but "opens late" on the MAP, and that is deliberate', () => {
  // The report asks "is this window restrictive?" and measures the SPAN, so 9-5 (eight
  // hours) is cut. The map asks "which end of the day does this constrain?" and reads the
  // EDGES — and a dock that does not open until nine genuinely cannot be your first stop.
  // Same customer, two different questions, two honest answers. Worth knowing when the
  // sheet and the pins are compared side by side.
  assert.equal(classifyTimeMark(at(9), at(17)), 'hours_opens_late');
});

test('a customer with no hours at all says nothing', () => {
  assert.equal(classifyTimeMark(null, null), null);
  assert.equal(classifyTimeMark(undefined, undefined), null);
});

test('NaN and non-numbers are not treated as midnight', () => {
  // Number(null) is 0, and 0 is a finite midnight that would read as "shuts at 12am" —
  // the coercion that once mailed a customer a midnight deadline.
  assert.equal(classifyTimeMark(NaN, NaN), null);
  assert.equal(classifyTimeMark('08:00', '17:00'), null, 'strings are not minutes');
});

// ── mark 1 — shuts early ─────────────────────────────────────────────────────

test('a dock that shuts by noon is the loudest mark on the map', () => {
  assert.equal(classifyTimeMark(at(6), at(10)), 'hours_shuts_early');
  assert.equal(classifyTimeMark(at(7), at(11)), 'hours_shuts_early');
  assert.equal(classifyTimeMark(null, at(11)), 'hours_shuts_early', 'a close alone is enough');
});

test('a three-hour window is severe wherever it falls in the day', () => {
  assert.equal(classifyTimeMark(at(13), at(16)), 'hours_shuts_early',
    'an afternoon slot this tight is as hard to hit as a morning one');
  assert.equal(classifyTimeMark(at(13), at(16, 1)), 'hours_opens_late',
    'one minute wider and nothing binds at the close, so the 1pm open becomes the story');
});

// ── mark 2 — early close ─────────────────────────────────────────────────────

test('closing before 3pm is a deadline inside the working day', () => {
  assert.equal(classifyTimeMark(at(8), at(12)), 'hours_early_close');
  assert.equal(classifyTimeMark(at(7), at(14, 30)), 'hours_early_close');
});

test('3:00pm exactly is the cliff, and it falls on the quiet side', () => {
  // Nineteen docks on that board shut at exactly three. Including them would nearly
  // double the marks, so the line is BEFORE three and this test says so out loud.
  assert.equal(classifyTimeMark(at(7), at(15)), null);
  assert.equal(classifyTimeMark(at(7), at(14, 59)), 'hours_early_close');
});

// ── mark 3 — opens late ──────────────────────────────────────────────────────

test('a dock that opens at 9 cannot lead a route', () => {
  assert.equal(classifyTimeMark(at(9), at(17)), 'hours_opens_late');
  assert.equal(classifyTimeMark(at(10), at(16)), 'hours_opens_late');
  assert.equal(classifyTimeMark(at(10), null), 'hours_opens_late', 'an open alone is enough');
});

test('the close outranks the open — you are going in the morning either way', () => {
  // 10a-2p opens late AND shuts early. Only one mark is drawn, and it is the costlier one.
  assert.equal(classifyTimeMark(at(10), at(14)), 'hours_early_close');
  assert.equal(classifyTimeMark(at(10), at(11, 30)), 'hours_shuts_early');
});

// ── mark 4 — extra room, the only good news on the map ───────────────────────

test('a 6am dock that stays open is an OPPORTUNITY, not a restriction', () => {
  assert.equal(classifyTimeMark(at(6), at(17)), 'hours_extra_room',
    'this is the NEFAB / Conwed case — route a driver there at dawn');
  assert.equal(classifyTimeMark(at(6, 30), at(16)), 'hours_extra_room');
});

test('a dock still taking freight after 6pm is room at the other end', () => {
  assert.equal(classifyTimeMark(at(8), at(19)), 'hours_extra_room');
});

test('extra room never overrides a deadline', () => {
  // Opens at 6am AND shuts at noon: the early open is not news, the noon close is.
  assert.equal(classifyTimeMark(at(6), at(12, 0) - 1), 'hours_shuts_early');
  assert.equal(classifyTimeMark(at(6), at(14)), 'hours_early_close');
});

test('7am is deliberately NOT early enough', () => {
  // Twelve docks open at exactly 7:00; treating that as remarkable would put the noise back.
  assert.equal(classifyTimeMark(at(7), at(16)), null);
  assert.equal(OPENS_EARLY_BY, at(6, 30));
});

// ── precedence is the array, and the array is the legend order ───────────────

test('the four keys are declared most-binding first', () => {
  assert.deepEqual(TIME_MARK_KEYS,
    ['hours_shuts_early', 'hours_early_close', 'hours_opens_late', 'hours_extra_room']);
  assert.ok(SHUTS_EARLY_BEFORE < EARLY_CLOSE_BEFORE);
  assert.ok(OPENS_EARLY_BY < OPENS_LATE_FROM);
});

// ── reading a customer's note ────────────────────────────────────────────────

test('the mark is read for ONE weekday — Friday can shut when Wednesday does not', () => {
  const note = {
    receiving_hours: { wed: { open: '08:00', close: '17:00' }, fri: { open: '08:00', close: '12:00' } },
  };
  assert.equal(timeMarkForDay(note, 'wed'), null, 'Wednesday is an ordinary day');
  assert.equal(timeMarkForDay(note, 'fri'), 'hours_early_close', 'Friday shuts at noon');
});

test('an OPEN with no close is still read — "receiving after 10am" is a real constraint', () => {
  // dayReceivingWindow returns null without a parseable close, because everything that
  // consumed it was measuring a deadline. That would have made this dock invisible.
  const note = { receiving_hours: { fri: { open: '10:00', close: '' } } };
  assert.deepEqual(dayWindowMinutes(note, 'fri'), { openMin: at(10), closeMin: null });
  assert.equal(timeMarkForDay(note, 'fri'), 'hours_opens_late');
});

test('the legacy "6AM-2PM" string form still classifies', () => {
  const note = { receiving_hours: { fri: '6AM-2PM' } };
  assert.equal(timeMarkForDay(note, 'fri'), 'hours_early_close');
});

test('hours a dispatcher typed are read the same as hours we scanned', () => {
  assert.equal(timeMarkForDay(typed('08:00', '17:00'), 'fri'), null);
  assert.equal(timeMarkForDay(typed('08:00', '11:00'), 'fri'), 'hours_shuts_early');
});

test('a missing note, a missing day and an empty day are all quiet', () => {
  assert.equal(timeMarkForDay(null, 'fri'), null);
  assert.equal(timeMarkForDay({ receiving_hours: {} }, 'fri'), null);
  assert.equal(timeMarkForDay({ receiving_hours: { fri: { open: '', close: '' } } }, 'fri'), null);
  assert.equal(timeMarkForDay(typed('08:00', '11:00'), null), null, 'no day, no claim');
});
