// The hours line on a "CAN'T MAKE" Compare row — unreachableHoursMark.
//
// Chad, 2026-09-28, with MCKESSON ("CAN'T MAKE 11:00A") and GENESIS BIOSCIENCES ("CAN'T MAKE
// 12:00P") on SUW and no hours anywhere on either row: "2 stops can't meet receiving hours
// however the hours are not listed on the card why?" — then: "make it 2 rows on the card one
// with the hours and 2 with can't make 12 or whatever".
//
// The row used to drop its hours chip whenever the verdict named the same close. These pin what
// the new hours line says: the WHOLE window on file (not "closes 11:00a" a second time), where
// the hours came from, and nothing invented for an edge the dock never stated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeMarkChip, unreachableHoursMark, compareUnreachableHoursEnabled } from '../src/lib/time-marks.js';

// The stored hours for the two stops, read 2026-09-28 from time-restricted-pros (zero NuVizz calls).
const MCKESSON = { receiving_hours: { mon: { open: '7:00', close: '11:00' } }, manual_overrides: { receiving_hours: true } };   // dispatcher-entered
const GENESIS = { receiving_hours: { mon: { open: '8:00', close: '12:00' } } };                                             // auto-detected

test('MCKESSON: the row said nothing but the close; the hours line says 7:00a–11:00a', () => {
  const chip = timeMarkChip(MCKESSON, 'mon', { autoHours: true });
  assert.equal(chip.text, 'closes 11:00a', 'what the chip alone would have said — the verdict already says it');
  const line = unreachableHoursMark(chip);
  assert.equal(line.text, '7:00a–11:00a');
  assert.equal(line.kind, chip.kind, 'same glyph as the map pin');
  assert.ok(!line.auto, 'typed by a dispatcher — no "· auto"');
});

test('GENESIS: auto-detected hours keep their "· auto" on the hours line', () => {
  const chip = timeMarkChip(GENESIS, 'mon', { autoHours: true });
  const line = unreachableHoursMark(chip);
  assert.equal(line.text, '8:00a–12:00p');
  assert.equal(line.auto, true, 'the row must say these hours were read from the order, not typed');
});

test('only the half on file is stated — a close with no open never invents one', () => {
  assert.equal(unreachableHoursMark({ kind: 'hours_shuts_early', text: 'closes 11:00a', openMin: null, closeMin: 660 }).text, 'closes 11:00a');
  assert.equal(unreachableHoursMark({ kind: 'hours_opens_late', text: 'opens 10:00a', openMin: 600, closeMin: null }).text, 'opens 10:00a');
  assert.equal(unreachableHoursMark(null), null);
});

test('VITE_COMPARE_UNREACHABLE_HOURS: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(compareUnreachableHoursEnabled({}), true);
  assert.equal(compareUnreachableHoursEnabled(undefined), true);
  for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(compareUnreachableHoursEnabled({ VITE_COMPARE_UNREACHABLE_HOURS: off }), false, off);
  assert.equal(compareUnreachableHoursEnabled({ VITE_COMPARE_UNREACHABLE_HOURS: 'of' }), true);
});
