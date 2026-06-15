// src/lib/parseStopComments.test.ts
//
// Run: npm test  (node --test --experimental-strip-types, no extra deps)
//
// Covers every real-world example from the brief plus empty / garbled / multi-segment
// edge cases. The parser must never drop unrecognized text and must always preserve raw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStopComments,
  commentsToString,
  isPlaceholderWindow,
  fmtReceivingHours,
  activeChips,
  RECEIVING_HOURS_HARD,
} from './parseStopComments.ts';

test('receiving hours stay advisory by default (hard-gate constant is false)', () => {
  assert.equal(RECEIVING_HOURS_HARD, false);
});

test('example: DO NOT BREAKDOWN SKID + TOTAL-AMOUNT', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; TOTAL-AMOUNT : 58.37');
  assert.equal(p.doNotBreakdownSkid, true);
  assert.equal(p.totalAmount, 58.37);
  assert.deepEqual(p.other, []); // the amount tail must NOT leak into other[]
  assert.equal(p.raw, 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; TOTAL-AMOUNT : 58.37');
  assert.equal(p.hasAny, true);
});

test('example: INSIDE DELIVERY', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: INSIDE DELIVERY');
  assert.equal(p.insideDelivery, true);
  assert.equal(p.liftgate, false);
  assert.equal(p.totalAmount, null);
});

test('example: RECEIVING HOURS 7AM-12PM + CALL UPON APPROACH (multi-segment)', () => {
  const p = parseStopComments(
    'SPL-INSTR-TEXT: RECEIVING HOURS 7AM-12PM; SPL-INSTR-TEXT: CALL UPON APPROACH'
  );
  assert.ok(p.receivingHours);
  assert.equal(p.receivingHours!.start, '07:00');
  assert.equal(p.receivingHours!.end, '12:00');
  assert.equal(p.receivingHours!.confidence, 'high');
  assert.equal(p.callUponApproach, true);
  assert.equal(fmtReceivingHours(p.receivingHours), 'Recv 7:00a-12:00p');
});

test('example: Do Not Deliver Double Stacked + LIFT GATE', () => {
  const p = parseStopComments(
    'SPL-INSTR-TEXT: Do Not Deliver Double Stacked; SPL-INSTR-TEXT: LIFT GATE'
  );
  assert.equal(p.doNotDoubleStack, true);
  assert.equal(p.liftgate, true);
});

test('case-insensitive + extra whitespace', () => {
  const p = parseStopComments('  spl-instr-text :   lift   gate  ;  inside delivery ');
  assert.equal(p.liftgate, true);
  assert.equal(p.insideDelivery, true);
});

test('receiving hours: bare "RECV 8-3" infers an AM/PM business window at low confidence', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: RECV 8-3');
  assert.ok(p.receivingHours);
  assert.equal(p.receivingHours!.start, '08:00');
  assert.equal(p.receivingHours!.end, '15:00');
  assert.equal(p.receivingHours!.confidence, 'low');
});

test('receiving hours: explicit 24h "07:00-15:00" reads high confidence', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: RECEIVING HOURS 07:00-15:00');
  assert.equal(p.receivingHours!.start, '07:00');
  assert.equal(p.receivingHours!.end, '15:00');
  assert.equal(p.receivingHours!.confidence, 'high');
});

test('receiving hours: "9 AM to 5 PM" with word separator', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: RECEIVING HOURS 9 AM to 5 PM');
  assert.equal(p.receivingHours!.start, '09:00');
  assert.equal(p.receivingHours!.end, '17:00');
});

test('gravel / new construction flag', () => {
  assert.equal(parseStopComments('SPL-INSTR-TEXT: GRAVEL LOT').gravelOrNewConstruction, true);
  assert.equal(
    parseStopComments('SPL-INSTR-TEXT: NEW CONSTRUCTION SITE').gravelOrNewConstruction,
    true
  );
});

test('unrecognized segment is preserved verbatim in other[] (never dropped)', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: ASK FOR MIKE AT THE BACK DOCK');
  assert.deepEqual(p.other, ['ASK FOR MIKE AT THE BACK DOCK']);
  assert.equal(p.hasAny, false); // nothing structured matched
});

test('empty input', () => {
  for (const v of ['', '   ', null, undefined]) {
    const p = parseStopComments(v as any);
    assert.equal(p.raw.trim(), ''); // raw is preserved verbatim; nothing meaningful in it
    assert.equal(p.hasAny, false);
    assert.deepEqual(p.other, []);
    assert.equal(p.receivingHours, null);
    assert.equal(p.totalAmount, null);
  }
});

test('garbled value: TOTAL-AMOUNT with no number does not crash or set amount', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: LIFT GATE; TOTAL-AMOUNT :');
  assert.equal(p.liftgate, true);
  assert.equal(p.totalAmount, null);
});

test('garbled receiving hours (no parseable range) → null window, text preserved', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: RECEIVING HOURS CALL STORE');
  assert.equal(p.receivingHours, null);
  assert.ok(p.other.length >= 1); // the unparseable instruction is kept
});

test('amount with $ sign and commas-free decimal', () => {
  assert.equal(parseStopComments('TOTAL-AMOUNT : $1234.50').totalAmount, 1234.5);
});

test('multi-segment: flags + window + amount all in one blob', () => {
  const p = parseStopComments(
    'SPL-INSTR-TEXT: LIFT GATE; SPL-INSTR-TEXT: INSIDE DELIVERY; ' +
      'SPL-INSTR-TEXT: RECEIVING HOURS 6AM-2PM; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; ' +
      'TOTAL-AMOUNT : 91.00'
  );
  assert.equal(p.liftgate, true);
  assert.equal(p.insideDelivery, true);
  assert.equal(p.doNotBreakdownSkid, true);
  assert.equal(p.receivingHours!.start, '06:00');
  assert.equal(p.receivingHours!.end, '14:00');
  assert.equal(p.totalAmount, 91);
  assert.equal(activeChips(p).length, 3); // liftgate, inside, no-breakdown
});

test('commentsToString accepts NuVizz Comment objects array', () => {
  const s = commentsToString([
    { commentDescription: 'SPL-INSTR-TEXT: LIFT GATE' },
    { commentDescription: 'SPL-INSTR-TEXT: INSIDE DELIVERY' },
  ]);
  const p = parseStopComments(s);
  assert.equal(p.liftgate, true);
  assert.equal(p.insideDelivery, true);
});

test('parseStopComments accepts a Comment[] directly', () => {
  const p = parseStopComments([
    { commentDescription: 'SPL-INSTR-TEXT: CALL UPON APPROACH' },
    { commentDescription: 'TOTAL-AMOUNT : 12.00' },
  ]);
  assert.equal(p.callUponApproach, true);
  assert.equal(p.totalAmount, 12);
});

// --- appointment reality ---
test('placeholder windows are detected as "no appt"', () => {
  assert.equal(isPlaceholderWindow('00:00', '00:00'), true);
  assert.equal(isPlaceholderWindow('00:00', '23:59'), true);
  assert.equal(isPlaceholderWindow('00:00', '24:00'), true);
  assert.equal(isPlaceholderWindow(null, null), true);
  assert.equal(isPlaceholderWindow('09:00', '09:00'), true); // zero-width
});

test('real windows are NOT flagged as placeholders', () => {
  assert.equal(isPlaceholderWindow('09:00', '13:00'), false);
  assert.equal(isPlaceholderWindow('07:00', '15:00'), false);
});
