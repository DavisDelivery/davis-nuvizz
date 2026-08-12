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

// ── Corpus sweep (Aug 2026): every case below is a REAL string from the Firestore boards ──

test('single-letter meridiems: "8A-1P", "8A-4 30P", "11A-4P"', () => {
  assert.deepEqual([hours('SPL-INSTR-TEXT: RECEIVING HOURS 8A-1P').open, hours('SPL-INSTR-TEXT: RECEIVING HOURS 8A-1P').close], ['08:00', '13:00']);
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS 8A-4 30P').close, '16:30');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 11A-4P').close, '16:00');
});

test('abbreviated labels: REC HRS / RCVG HRS / RCV HRS / RCVNG', () => {
  assert.equal(hours('SPL-INSTR-TEXT: REC HRS 7AM-2PM').close, '14:00');
  assert.equal(hours('SPL-INSTR-TEXT: RCVG HRS UNTIL 2PM ONLY').close, '14:00');
  assert.deepEqual([hours('SPL-INSTR-TEXT: RCVNG AFTER 11AM').open, hours('SPL-INSTR-TEXT: RCVNG AFTER 11AM').close], ['11:00', '']);
});

test('day-qualified schedules produce per-day windows — Friday stays different', () => {
  const h = hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: MON-THURS 6 30-4\nSPL-INSTR-TEXT: FRI 8-12');
  assert.deepEqual(h.byDay.mon, { open: '06:30', close: '16:00' });
  assert.deepEqual(h.byDay.thu, { open: '06:30', close: '16:00' });
  assert.deepEqual(h.byDay.fri, { open: '08:00', close: '12:00' });
  assert.equal(h.byDay.sat, undefined, 'unnamed days stay unset');
  // The label-on-its-own-line form ("FRIDAY" then the range in the next comment).
  const h2 = hours('SPL-INSTR-TEXT: RECEIVING HOURS M-THURS\nSPL-INSTR-TEXT: 7 00 AM - 5 00 PM\nSPL-INSTR-TEXT: FRIDAY\nSPL-INSTR-TEXT: 7 00 AM - 12 00 PM');
  assert.deepEqual(h2.byDay.wed, { open: '07:00', close: '17:00' });
  assert.deepEqual(h2.byDay.fri, { open: '07:00', close: '12:00' });
});

test('"M-TH ONLY 9-4PM" reads 9 AM, not 9 PM (the peer-inference trap)', () => {
  const h = hours('SPL-INSTR-TEXT: NO DELIVERIES ON FRIDAYS\nSPL-INSTR-TEXT: M-TH ONLY 9-4PM');
  assert.deepEqual(h.byDay.mon, { open: '09:00', close: '16:00' });
  assert.equal(h.byDay.fri, undefined);
});

test('close-only forms: CLOSE AT / CLOSES @ / PICKED UP BEFORE', () => {
  assert.equal(hours('SPL-INSTR-TEXT: CLOSE AT 3PM').close, '15:00');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING CLOSES @ 3PM.').close, '15:00');
  assert.equal(hours('PICK UP FOR UNITED BROKERAGE. **HAS TO BE PICKED UP BEFORE 3PM**').close, '15:00');
});

test('day-qualified closes: "CLOSED FRI AT 12PM" is an early close, never a closed day', () => {
  const r = scanStopFull({ signalSources: { orderInstructions: 'SPL-INSTR-TEXT: CLOSED FRI AT 12PM' } });
  assert.deepEqual(r.hours.byDay.fri, { open: '', close: '12:00' });
  assert.deepEqual(r.closedDays, [], 'they are OPEN Friday morning — marking the day closed would skip deliverable hours');
  assert.deepEqual(hours('SPL-INSTR-TEXT: FRIDAYS  CLOSE AT NOON').byDay.fri, { open: '', close: '12:00' });
  assert.deepEqual(hours('SPL-INSTR-TEXT: DEL BY NOON ON FRIDAYS').byDay.fri, { open: '', close: '12:00' });
});

test('open-only forms store the open with no close (informs the card, arms nothing)', () => {
  assert.deepEqual([hours('SPL-INSTR-TEXT: OPENS AT 11AM').open, hours('SPL-INSTR-TEXT: OPENS AT 11AM').close], ['11:00', '']);
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING AFTER 10AM').open, '10:00');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS 8-5\nSPL-INSTR-TEXT: NO DELIVERIES BEFORE 8AM').close, '17:00', 'a full range beats the open-only qualifier');
});

test('compact and split-range forms: "8-430PM", "830-1230", "OPEN FROM 11AM- / 6PM"', () => {
  assert.deepEqual([hours('SPL-INSTR-TEXT: RECEIVING HOURS 8-430PM').open, hours('SPL-INSTR-TEXT: RECEIVING HOURS 8-430PM').close], ['08:00', '16:30']);
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS 830-1230').open, '08:30');
  assert.deepEqual([hours('SPL-INSTR-TEXT: WAREHOUSE OPEN FROM 11AM-\nSPL-INSTR-TEXT: 6PM').open, hours('SPL-INSTR-TEXT: WAREHOUSE OPEN FROM 11AM-\nSPL-INSTR-TEXT: 6PM').close], ['11:00', '18:00']);
  assert.equal(hours('$80.00 8AM-11AM Jobsite Delivery').close, '11:00');
});

test('garbage still refuses: "83A-30P", lunch closures, AM-required prose', () => {
  assert.equal(hours('SPL-INSTR-TEXT: RCV HRS 83A-30P'), null);
  assert.equal(hours('SPL-INSTR-TEXT: CLOSED 1-2 FOR LUNCH'), null);
  assert.equal(hours('SPL-INSTR-TEXT: CLOSED 2P-3P'), null);
  assert.equal(hours('SPL-INSTR-TEXT: AM DELIVERY REQ - NO GUARANTEE'), null);
});
