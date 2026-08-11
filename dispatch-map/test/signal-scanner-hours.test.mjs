// Receiving-hours detection from NuVizz order instructions — pinned against the REAL
// formats Uline sends, starting with Chad's 08-11 EOD manifest (stop 007160271, Shape
// Innovation): the label and the range arrive as SEPARATE comments, and the range writes
// 7:30 as "7 30". Also pins the business-hours correction: "RH 8-3" is 8a-3p, never a
// 3:00 AM close — the bug class that would have flagged every arrival after dawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStopFull } from '../src/lib/signal-scanner.ts';

const hours = (instr) => scanStopFull({ signalSources: { orderInstructions: instr } }).hours;

test("the Shape Innovation manifest: label and '7 30-1' range in separate comments", () => {
  const h = hours([
    'SPL-INSTR-TEXT: RECEIVING HOURS',
    'SPL-INSTR-TEXT: 7 30-1',
    'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID',
    'SPL-INSTR-TEXT: NTFY OF DELIVERY-APPT REQD',
  ].join('\n'));
  assert.ok(h, 'the split label + space-for-colon range must be detected');
  assert.equal(h.open, '07:30');
  assert.equal(h.close, '13:00', 'bare "1" after a 7:30 open is 1:00 PM, not 1:00 AM');
});

test('a bare close at or before the open shifts to afternoon (business-hours convention)', () => {
  assert.deepEqual([hours('RH 8-3').open, hours('RH 8-3').close], ['08:00', '15:00']);
  assert.deepEqual([hours('HOURS 8-4').open, hours('HOURS 8-4').close], ['08:00', '16:00']);
  assert.equal(hours('RECEIVING HOURS 11-1').close, '13:00');
});

test('an explicit meridiem is never overridden', () => {
  assert.deepEqual([hours('RH 7-11AM').open, hours('RH 7-11AM').close], ['07:00', '11:00']);
  assert.deepEqual([hours('HOURS 6AM-2PM').open, hours('HOURS 6AM-2PM').close], ['06:00', '14:00']);
});

test('an explicitly overnight window is refused, not flipped 12 hours', () => {
  assert.equal(hours('HOURS 9PM-5AM'), null);
});

test('dot as the minutes separator also reads', () => {
  const h = hours('RECEIVING HOURS 7.30-1');
  assert.deepEqual([h.open, h.close], ['07:30', '13:00']);
});

test('DELIVER BY single time keeps its 06:00 default open', () => {
  const h = hours('DELIVER BY 2PM');
  assert.deepEqual([h.open, h.close], ['06:00', '14:00']);
});

test('a bare range with NO hours label is never guessed at', () => {
  assert.equal(hours('SPL-INSTR-TEXT: 7 30-1'), null, 'context is required — a naked number pair is not hours');
  assert.equal(hours('CALL 30-1 MIN AHEAD'), null);
});
