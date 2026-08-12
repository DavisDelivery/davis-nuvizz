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

// Chad (Aug 2026), reversing the original refusal: "we should learn the bare number
// pairs because ... most businesses we deliver to are normal day time hours as we
// don't run through the night." The daytime constraint IS the safety: a bare pair only
// counts when it resolves to a 5:00a-12:00p open, a close by 7:00p, and at least a
// 3-hour width — and never out of a refusing context.
test('a bare daytime pair with no label IS learned (last resort, amber tier as always)', () => {
  assert.deepEqual([hours('SPL-INSTR-TEXT: 7 30-1').open, hours('SPL-INSTR-TEXT: 7 30-1').close], ['07:30', '13:00']);
  assert.deepEqual([hours('SPL-INSTR-TEXT: 8-4').open, hours('SPL-INSTR-TEXT: 8-4').close], ['08:00', '16:00']);
  assert.deepEqual([hours('PREFERS 9AM-12PM BUT WILL BE ON SITE').open, hours('PREFERS 9AM-12PM BUT WILL BE ON SITE').close], ['09:00', '12:00']);
});

test('bare-pair guards: everything that is NOT a daytime receiving window still refuses', () => {
  assert.equal(hours('CALL 30-1 MIN AHEAD'), null, 'invalid hour');
  assert.equal(hours('CALL 9-5 MINS PRIOR'), null, 'MIN/MINS qualifier');
  assert.equal(hours('SPL-INSTR-TEXT: CLOSED 1-2 FOR LUNCH'), null, 'lunch closure — the opposite of hours');
  assert.equal(hours('SPL-INSTR-TEXT: NO DELIVERIES BTWN 12-1PM'), null, 'refusing context');
  assert.equal(hours('SPL-INSTR-TEXT: 7PM-11PM'), null, 'we never run nights');
  assert.equal(hours('SPL-INSTR-TEXT: 1-2'), null, 'a 1-hour pair is lunch-shaped, not a window');
  assert.equal(hours('SPL-INSTR-TEXT: 678-900-4210'), null, 'phone number');
  assert.equal(hours('SPL-INSTR-TEXT: 029785-09 ,SEQ# 1'), null, 'PO identifier');
  assert.equal(hours('TOTAL-AMOUNT : 87.56'), null);
  assert.equal(hours('12 AUG 2026 12:00 AM - 08:00 AM'), null, 'requested-window timestamps open before 5a');
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

// ── Month-of-data study (Jul 13 – Aug 11): the cases 23 boards surfaced ──

test('digit-less closes read as afternoon — the dawn-close regression the study caught', () => {
  // v0.54.60's peer-inference rewrite read "CLOSES AT 4" as 04:00; eleven real texts
  // hit it, and a 4:00 AM close would amber-flag every arrival all day.
  assert.equal(hours('SPL-INSTR-TEXT: CLOSES AT 4').close, '16:00');
  assert.equal(hours('SPL-INSTR-TEXT: CLOSES AT 3 30').close, '15:30');
  assert.equal(hours('SPL-INSTR-TEXT: CLOSE AT 330').close, '15:30');
  assert.equal(hours('SPL-INSTR-TEXT: CLOSES AT 12').close, '12:00');
  assert.equal(hours('SPL-INSTR-TEXT: DELIVER BY 2').close, '14:00');
  assert.equal(hours('SPL-INSTR-TEXT: CLOSES AT 11'), null, 'a bare 8-11 close is ambiguous — refused, never guessed');
});

test('an explicit-meridiem bare pair is a window even under 3 hours', () => {
  const h = hours('8-10am Delivery. Call Bobby Lyons (678-223-2170) prior.');
  assert.deepEqual([h.open, h.close], ['08:00', '10:00']);
  assert.equal(hours('SPL-INSTR-TEXT: 1-2'), null, 'meridiem-less 1-hour pairs stay lunch-shaped');
});

test('a paid time GUARANTEE is a delivery deadline', () => {
  assert.equal(hours('$69.99 *11:00 AM GUARANTEE LAMAR 470-732-8195*').close, '11:00');
});

// ── Lunch-split continuations (Chad, Aug 12: "they just break for lunch then start
// receiving again from 1-5pm"). One window per day in the schema → store the ENVELOPE. ──

test('two-range hours store first open to last close — real corpus customers', () => {
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 8-12 & 1-5').close, '17:00', 'FN USA');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 7-11 30AM AND 1-4PM').close, '16:00', 'Fulfillex');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 6 45-11 30 & 12 30-3 45').close, '15:45', 'Vintage Modern');
  assert.equal(hours('SPL-INSTR-TEXT: RH  9 30A - 1P & 2P-5 30P').close, '17:30', 'Atlanta Network');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HRS 9-12, 2-5').close, '17:00', 'True Precision — bare afternoon half reads PM');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 9 00-11 30 AND 1 00-4 00').close, '16:00', 'Thoracent');
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 7AM-12PM AND 1PM-3PM').close, '15:00', 'Plaid');
});

test('day-qualified lunch splits keep the envelope per day — the RIOF false flag', () => {
  const riof = hours('SPL-INSTR-TEXT: RH  MON-FRI 8AM-12P\nSPL-INSTR-TEXT: AND 1PM-4PM');
  assert.deepEqual(riof.byDay.mon, { open: '08:00', close: '16:00' }, 'noon close was a lunch break, not the day end');
  const sany = hours('SPL-INSTR-TEXT: M-F 8AM - 11AM, 1PM - 5PM');
  assert.deepEqual(sany.byDay.fri, { open: '08:00', close: '17:00' });
  const mjc = hours('SPL-INSTR-TEXT: RECEIVING HOURS MON-THUR\nSPL-INSTR-TEXT: 7A-11 30A AND 12 30P-4P.');
  assert.deepEqual(mjc.byDay.thu, { open: '07:00', close: '16:00' });
  assert.equal(mjc.byDay.fri, undefined);
});

test('a genuine noon close is NOT extended, and day pairs are not eaten as continuations', () => {
  assert.equal(hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: 8 AM -12 PM').close, '12:00', 'Subaru really does close at noon');
  const h = hours('SPL-INSTR-TEXT: RECEIVING HOURS\nSPL-INSTR-TEXT: MON-TH 12-5 & FRI 1130-4');
  assert.deepEqual(h.byDay.mon, { open: '12:00', close: '17:00' });
  assert.deepEqual(h.byDay.fri, { open: '11:30', close: '16:00' }, '"& FRI ..." is a new day segment, not a same-day continuation');
});
