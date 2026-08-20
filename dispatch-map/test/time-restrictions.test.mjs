// Time-restriction classification — pinned against the shapes a REAL Davis board sends.
//
// The counts quoted below are from the 2026-08-19 board (862 stops) and are the reason
// most of these tests exist: the signals that look like time restrictions are on nearly
// every stop, and the ones that matter are on about a sixth of them. A report that gets
// this backwards is worse than no report, because it reads as "everything is urgent".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStopTimeRestriction, buildTimeRestrictionRows, orderWindow, clockMinFromStamp,
  weekdayKey, toCsv, csvCell, summarizeRows, ALL_DAY_MIN, detectDefaultSlots, CSV_COLUMNS, proHasPrefix,
} from '../src/lib/time-restrictions.js';

const WED = '2026-08-19'; // a Wednesday
const FRI = '2026-08-21';

const stop = (over = {}) => ({
  primaryPro: '007163267-1',
  businessName: 'ACME WAREHOUSE',
  scheduledFrom: `${WED}T08:00:00`,
  scheduledTo: `${WED}T20:00:00`,
  timeConstraint: 'STRICT',
  normalizedStatus: 'DELIVERED',
  signalSources: { orderInstructions: 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' },
  ...over,
});
const instr = (...lines) => ({ signalSources: { orderInstructions: lines.map((l) => `SPL-INSTR-TEXT: ${l}`).join('\n') } });
const classify = (over, note = null, date = WED) => classifyStopTimeRestriction(stop(over), note, date);

// ── the four false positives that would drown the report ──────────────────────

test('a STRICT time constraint on its own is NOT a time restriction (800 of 862 stops carry it)', () => {
  assert.equal(classify({ timeConstraint: 'STRICT' }), null);
});

test('the all-day 8a-8p placeholder is NOT a window (760 of 862 stops carry it)', () => {
  assert.equal(orderWindow(stop()), null);
  assert.equal(classify({}), null);
});

test('a zero-length 5:00-5:00 schedule is a placeholder, not a 0-minute appointment', () => {
  assert.equal(orderWindow(stop({ scheduledFrom: `${WED}T05:00:00`, scheduledTo: `${WED}T05:00:00` })), null);
});

test('"DO NOT BREAKDOWN SKID" is boilerplate (745 of 862 stops) and never a restriction', () => {
  assert.equal(classify({ ...instr('DO NOT BREAKDOWN SKID', 'INSIDE DELIVERY', 'LIFT GATE NEEDED') }), null);
});

// ── the windows that ARE real ─────────────────────────────────────────────────

test('a 12p-5p PM window is a half-day restriction (61 stops that day)', () => {
  const r = classify({ scheduledFrom: `${WED}T12:00:00`, scheduledTo: `${WED}T17:00:00` });
  assert.equal(r.tier, 'half_day');
  assert.equal(r.orderWindowLabel, '12:00p–5:00p');
});

test('a 9:00-9:30 booked slot is a HARD window, not a half-day preference', () => {
  const r = classify({ scheduledFrom: `${WED}T09:00:00`, scheduledTo: `${WED}T09:30:00` });
  assert.equal(r.tier, 'hard_window');
  assert.equal(r.orderWindowKind, 'appointment');
});

// ── the 30-minute "appointment" that is really a creation default ─────────────

test('the same half-hour slot across many customers is a system stamp, not 21 bookings', () => {
  const board = Array.from({ length: 21 }, (_, i) => stop({
    primaryPro: `P${i}`, businessName: `CUSTOMER ${i}`,
    scheduledFrom: `${WED}T09:00:00`, scheduledTo: `${WED}T09:30:00`,
  }));
  const slots = detectDefaultSlots(board);
  assert.ok(slots.has(`${9 * 60}-${9 * 60 + 30}`), '09:00-09:30 on 21 customers is a default');
  assert.equal(orderWindow(board[0], slots), null, 'and must not read as a booked slot');
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED).length, 0);
});

test('a genuinely rare slot survives — two stops at 5:00a is a real early pickup', () => {
  const board = [
    stop({ primaryPro: 'A', businessName: 'DAVIS DELIVERY', scheduledFrom: `${WED}T05:00:00`, scheduledTo: `${WED}T05:30:00` }),
    stop({ primaryPro: 'B', businessName: 'DAVIS DELIVERY', scheduledFrom: `${WED}T05:00:00`, scheduledTo: `${WED}T05:30:00` }),
  ];
  assert.equal(detectDefaultSlots(board).size, 0, 'two stops is not a stamp');
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED).length, 2);
});

test('a busy PM half-day window is NEVER swept up as a default, however common', () => {
  const board = Array.from({ length: 61 }, (_, i) => stop({
    primaryPro: `P${i}`, businessName: `CUSTOMER ${i}`,
    scheduledFrom: `${WED}T12:00:00`, scheduledTo: `${WED}T17:00:00`,
  }));
  assert.equal(detectDefaultSlots(board).size, 0, 'only slot-shaped windows are eligible');
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED).length, 61);
});

test('one customer booking the same slot on many orders is still a real booking', () => {
  const board = Array.from({ length: 8 }, (_, i) => stop({
    primaryPro: `P${i}`, businessName: 'ONE BIG CONSIGNEE',
    scheduledFrom: `${WED}T14:00:00`, scheduledTo: `${WED}T14:30:00`,
  }));
  assert.equal(detectDefaultSlots(board).size, 0, 'needs 3+ distinct customers to be a stamp');
});

test('an 8-hour span is the boundary: 8a-4p is a working day, 8a-3p is an early close', () => {
  assert.equal(orderWindow(stop({ scheduledFrom: `${WED}T08:00:00`, scheduledTo: `${WED}T16:00:00` })), null);
  assert.equal(orderWindow(stop({ scheduledFrom: `${WED}T08:00:00`, scheduledTo: `${WED}T15:00:00` })).spanMin, 420);
  assert.equal(ALL_DAY_MIN, 480);
});

// ── receiving hours out of the order text ─────────────────────────────────────

test('"RECEIVING HOURS 8AM-2PM" is a hard window with the close read off the text', () => {
  const r = classify(instr('RECEIVING HOURS 8AM-2PM', 'DO NOT BREAKDOWN SKID'));
  assert.equal(r.tier, 'hard_window');
  assert.equal(r.closeMin, 14 * 60);
  assert.equal(r.hoursLabel, '8:00a–2:00p');
});

// ── a dock open all day is not a restriction, whoever stated the hours ────────

test('"RECEIVING HOURS 9AM-5PM" is a working day, not a hard window', () => {
  assert.equal(classify(instr('RECEIVING HOURS 9AM-5PM')), null, 'exactly 8 hours is already a day');
  assert.equal(classify(instr('RECEIVING HOURS 8AM-5PM')), null);
  assert.equal(classify(instr('RECEIVING HOURS 7AM-5PM')), null);
});

test('7:30a-3:30p is 8 hours and goes; 7:30a-3:00p is 7.5 and stays', () => {
  assert.equal(classify(instr('RECEIVING HOURS 7 30AM-3 30PM')), null);
  assert.equal(classify(instr('RECEIVING HOURS 7 30AM-3PM')).tier, 'hard_window');
});

test('the span rule applies to hours a DISPATCHER typed, not just ones we scanned', () => {
  const wide = { receiving_hours: { wed: { open: '08:00', close: '17:00' } }, manual_overrides: { receiving_hours: true } };
  assert.equal(classify({}, wide), null, 'a typed 8-5 is still a working day');
  const tight = { receiving_hours: { wed: { open: '08:00', close: '12:00' } }, manual_overrides: { receiving_hours: true } };
  assert.equal(classify({}, tight).tier, 'hard_window');
});

test('an opens-at or closes-at has no span to measure and survives', () => {
  assert.equal(classify(instr('RECEIVING AFTER 10AM')).hoursLabel, 'opens 10:00a');
  assert.equal(classify(instr('CLOSES AT 3 30 PM')).closeMin, 15 * 60 + 30);
  assert.equal(classify(instr('PICK UP BEFORE 11AM OR AFTER 12:30PM.')).tier, 'hard_window',
    'a midday closure is a hole in the day, not a wide window');
});

test('wide hours cannot prop up an appointment-only stop', () => {
  // The hours go, which leaves the appointment standing alone — and an appointment alone
  // is not a clock constraint either, so the row leaves the sheet entirely.
  const board = [stop({ ...instr('RECEIVING HOURS 8AM-5PM', 'NTFY OF DELIVERY-APPT REQD') })];
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED, { dropAppointmentOnly: true }).length, 0);
});

test('a stop with wide hours keeps a genuine PM order window', () => {
  const r = classify({ ...instr('RECEIVING HOURS 8AM-5PM'),
    scheduledFrom: `${WED}T12:00:00`, scheduledTo: `${WED}T17:00:00` });
  assert.equal(r.tier, 'half_day', 'the wide hours drop away, the real window remains');
});

test('FRIDAY is the day that bites: "MON-THU 8-2 / FRI 8-12" closes at noon on a Friday', () => {
  const lines = instr('RECEIVING HOURS', 'MONDAY-THURSDAY 8-2', 'FRIDAY 8-12');
  assert.equal(classify(lines, null, WED).closeMin, 14 * 60, 'Wednesday still closes at 2p');
  assert.equal(classify(lines, null, FRI).closeMin, 12 * 60, 'Friday closes at noon');
});

test('"CLOSES AT 3 30 PM" — space-for-colon, no range — is still a closing time', () => {
  const r = classify(instr('CLOSES AT 3 30 PM', 'DO NOT BREAKDOWN SKID'));
  assert.equal(r.tier, 'hard_window');
  assert.equal(r.closeMin, 15 * 60 + 30);
});

// ── the midday closure, and the false accusation it used to produce ───────────

test('"PICK UP BEFORE 11AM OR AFTER 12:30PM" is a midday closure, not an 11am deadline', () => {
  const r = classify(instr('PICK UP BEFORE 11AM OR AFTER 12:30PM.'));
  assert.equal(r.tier, 'hard_window');
  assert.deepEqual(r.splitWindow, { shutFromMin: 11 * 60, shutUntilMin: 12 * 60 + 30 });
  assert.equal(r.hoursLabel, 'before 11:00a or after 12:30p');
});

test('delivering at 4:29p when the customer said "or after 12:30pm" is NOT late', () => {
  const r = classify({ ...instr('PICK UP BEFORE 11AM OR AFTER 12:30PM.'), deliveredDTTM: `${WED}T16:29:00` });
  assert.equal(r.missedByMin, null, 'the escape hatch the customer offered must be honoured');
});

test('delivering at 11:45a — inside the closure — IS late, by the minutes past the shut', () => {
  const r = classify({ ...instr('PICK UP BEFORE 11AM OR AFTER 12:30PM.'), deliveredDTTM: `${WED}T11:45:00` });
  assert.equal(r.missedByMin, 45);
});

// ── open-only constraints ─────────────────────────────────────────────────────

test('"RECEIVING AFTER 10AM" is a real constraint — it cannot be the 7am first stop', () => {
  const r = classify(instr('RECEIVING AFTER 10AM', 'DO NOT BREAKDOWN SKID'));
  assert.equal(r.tier, 'hard_window');
  assert.equal(r.openMin, 10 * 60);
  assert.equal(r.hoursLabel, 'opens 10:00a');
});

test('an opens-at constraint has no close, so it can never report a past-close miss', () => {
  const r = classify({ ...instr('RECEIVING AFTER 10AM'), deliveredDTTM: `${WED}T18:00:00` });
  assert.equal(r.closeMin, null);
  assert.equal(r.missedByMin, null);
});

// ── where the hours came from ─────────────────────────────────────────────────

test('hours kept on the customer record are NOT attributed to the order in front of you', () => {
  // dayReceivingWindow reports tier 'auto' for both saved and order-text hours, so a
  // tier-derived label called 100 of 107 rows "Order text" when they came off a saved
  // record. The column is how a dispatcher judges a row; it must say which it is.
  const note = { receiving_hours: { wed: { open: '06:00', close: '11:00' } } };
  const saved = buildTimeRestrictionRows([{ ...stop(), matchKey: 'k' }], new Map([['k', note]]), WED);
  assert.equal(saved[0].hoursSource, 'Saved on customer');

  const typed = buildTimeRestrictionRows([{ ...stop(), matchKey: 'k' }],
    new Map([['k', { ...note, manual_overrides: { receiving_hours: true } }]]), WED);
  assert.equal(typed[0].hoursSource, 'Dispatcher');

  const fromOrder = buildTimeRestrictionRows([stop(instr('RECEIVING HOURS 8AM-2PM'))], new Map(), WED);
  assert.equal(fromOrder[0].hoursSource, 'This order');
});

test('a stop with no hours at all claims no source', () => {
  const rows = buildTimeRestrictionRows([stop(instr('APPOINTMENT REQUIRED'))], new Map(), WED);
  assert.equal(rows[0].hoursSource, '');
});

test('hours a dispatcher TYPED outrank the scanner reading of the order text', () => {
  const note = { receiving_hours: { wed: { open: '07:00', close: '11:00' } }, manual_overrides: { receiving_hours: true } };
  const r = classify(instr('RECEIVING HOURS 8AM-2PM'), note);
  assert.equal(r.closeMin, 11 * 60, 'the typed 11a close wins over the order text 2p');
  assert.equal(r.hoursTier, 'typed');
});

// ── appointments ──────────────────────────────────────────────────────────────

test('"NTFY OF DELIVERY-APPT REQD" is a real obligation (27 stops), not boilerplate', () => {
  const r = classify(instr('DO NOT BREAKDOWN SKID', 'NTFY OF DELIVERY-APPT REQD'));
  assert.equal(r.tier, 'appointment');
  assert.match(r.appointmentReasons[0], /appointment required/i);
});

test('"EMAIL FOR APPOINTMENT" books the stop before the truck rolls', () => {
  assert.equal(classify(instr('EMAIL FOR APPOINTMENT', 'SCHEDULING@GXO.COM')).tier, 'appointment');
});

test('a call-ahead 30 minutes prior is an appointment-tier obligation', () => {
  const r = classify(instr('DELIVERY DRIVER MUST CALL', '770-843-6263 30 MINUTES', 'PRIOR TO DELIVERY'));
  assert.equal(r.tier, 'appointment');
});

test('appointment_required on the customer note counts even with silent order text', () => {
  const r = classify({}, { appointment_required: true });
  assert.equal(r.tier, 'appointment');
  assert.ok(r.sources.includes('Customer notes'));
});

// ── closed days and AM/PM ─────────────────────────────────────────────────────

test('a customer closed Wednesday is flagged on a Wednesday board and not on a Friday one', () => {
  const note = { closed_days: ['wed'] };
  assert.equal(classify({}, note, WED).tier, 'closed_day');
  assert.equal(classify({}, note, FRI), null);
});

test('a dispatcher AM/PM tag is the mildest tier — sequencing, not refusal', () => {
  const r = classify({}, { delivery_window: 'AM' });
  assert.equal(r.tier, 'half_day');
  assert.equal(r.amPm, 'AM');
});

// ── severity ordering ─────────────────────────────────────────────────────────

test('a stop carrying hours AND an appointment ranks by the costlier failure — the dock shutting', () => {
  const r = classify(instr('RECEIVING HOURS 8AM-2PM', 'NTFY OF DELIVERY-APPT REQD'));
  assert.equal(r.tier, 'hard_window');
  assert.deepEqual(r.kinds, ['hard_window', 'appointment']);
});

// ── the null/absent/malformed cases ───────────────────────────────────────────

test('no schedule and no text yields NO deadline — never a midnight one', () => {
  const r = classifyStopTimeRestriction({ scheduledFrom: null, scheduledTo: null }, null, WED);
  assert.equal(r, null);
  assert.equal(clockMinFromStamp(null), null, 'null must not coerce to 0 (midnight)');
  assert.equal(clockMinFromStamp(''), null);
  assert.equal(clockMinFromStamp('not-a-date'), null);
});

test('a malformed stamp is rejected rather than half-parsed', () => {
  assert.equal(clockMinFromStamp('2026-08-19T99:99:00'), null);
  assert.equal(clockMinFromStamp('2026-08-19'), null);
});

test('an unparseable served date yields no weekday, and closed-day/hours checks stay quiet', () => {
  assert.equal(weekdayKey(''), null);
  assert.equal(weekdayKey('garbage'), null);
  assert.equal(classifyStopTimeRestriction(stop(), { closed_days: ['wed'] }, null), null);
});

test('a null stop is answered, not thrown at', () => {
  assert.equal(classifyStopTimeRestriction(null, null, WED), null);
});

// ── "did we make it" ──────────────────────────────────────────────────────────

test('a stop delivered after the dock closed reports the minutes it missed by', () => {
  const r = classify({ ...instr('RECEIVING HOURS 8AM-2PM'), deliveredDTTM: `${WED}T14:31:00` });
  assert.equal(r.missedByMin, 31);
});

test('delivered INSIDE the window reports no miss at all', () => {
  const r = classify({ ...instr('RECEIVING HOURS 8AM-2PM'), deliveredDTTM: `${WED}T13:13:00` });
  assert.equal(r.missedByMin, null);
});

test('a PICKUP is never scored against receiving hours — they govern freight coming IN', () => {
  // The real shape: an internal Davis pickup whose order said "PICK UP BEFORE 1:00PM",
  // collected at 12:05p exactly as asked, inheriting a 6a-11a receiving window from a
  // customer_notes doc that describes the dock, not the pickup.
  const note = { receiving_hours: { wed: { open: '06:00', close: '11:00' } } };
  const r = classify({ stopType: 'PU', deliveredDTTM: `${WED}T12:05:00` }, note);
  assert.equal(r.closeMin, 11 * 60, 'the hours still show as context');
  assert.equal(r.missedByMin, null, 'but a pickup is never accused of missing them');
});

test('the same clock on a DELIVERY does score, so the guard is about type not timing', () => {
  const note = { receiving_hours: { wed: { open: '06:00', close: '11:00' } } };
  const r = classify({ stopType: 'DO', deliveredDTTM: `${WED}T12:05:00` }, note);
  assert.equal(r.missedByMin, 65);
});

test('an undelivered stop never claims we were on time or late', () => {
  const r = classify({ ...instr('RECEIVING HOURS 8AM-2PM'), deliveredDTTM: null, normalizedStatus: 'UNPLANNED' });
  assert.equal(r.missedByMin, null);
  assert.equal(r.deliveredMin, null);
});

// ── rows + CSV ────────────────────────────────────────────────────────────────

test('rows come back most-constrained first so the top of the sheet is the expensive half', () => {
  const rows = buildTimeRestrictionRows([
    stop({ primaryPro: 'A', businessName: 'AMPM CO' }),
    stop({ primaryPro: 'B', businessName: 'HOURS CO', ...instr('RECEIVING HOURS 8AM-2PM') }),
    stop({ primaryPro: 'C', businessName: 'APPT CO', ...instr('APPOINTMENT REQUIRED') }),
  ], new Map([['k', { delivery_window: 'PM' }]]), WED);
  assert.deepEqual(rows.map((r) => r.pro), ['B', 'C']);
  assert.equal(rows[0].tierLabel, 'Hard window');
});

test('inside a tier the EARLIEST CLOSE leads, whatever the customer is called', () => {
  const rows = buildTimeRestrictionRows([
    stop({ primaryPro: 'LATE', businessName: 'AAA CO', ...instr('RECEIVING HOURS 8AM-3PM') }),
    stop({ primaryPro: 'EARLY', businessName: 'ZZZ CO', ...instr('RECEIVING HOURS 8AM-11AM') }),
  ], new Map(), WED);
  assert.deepEqual(rows.map((r) => r.pro), ['EARLY', 'LATE'],
    'an 11am dock has to be planned before a 5pm one even though Z sorts after A');
});

test('a stop with no note is classified from the order text alone, not skipped', () => {
  const rows = buildTimeRestrictionRows([stop(instr('RECEIVING HOURS 8AM-2PM'))], new Map(), WED);
  assert.equal(rows.length, 1);
});

test('an unrestricted board yields an empty sheet rather than a header-less file', () => {
  const csv = toCsv(buildTimeRestrictionRows([stop()], new Map(), WED));
  assert.match(csv, /^PRO,Order #,Customer/);
  assert.equal(csv.trim().split('\r\n').length, 1, 'header only');
});

test('CSV quotes commas and doubles embedded quotes', () => {
  assert.equal(csvCell('ACME, INC'), '"ACME, INC"');
  assert.equal(csvCell('THE "BIG" DOCK'), '"THE ""BIG"" DOCK"');
  assert.equal(csvCell(null), '');
});

test('a cell starting with = is neutered so Excel shows text, not a formula', () => {
  assert.equal(csvCell('=cmd|calc'), "'=cmd|calc");
  assert.equal(csvCell('-ACME'), "'-ACME");
});

test('a carried-over restricted stop is LABELLED, not silently folded in as today\'s work', () => {
  const rows = buildTimeRestrictionRows([
    stop({ primaryPro: 'OLD', businessName: 'GXO', carryover: true, scheduledDate: '2026-08-17',
      normalizedStatus: 'UNPLANNED', ...instr('NTFY OF DELIVERY-APPT REQD') }),
  ], new Map(), WED);
  assert.equal(rows[0].carryover, 'Yes');
  assert.equal(rows[0].scheduledDate, '2026-08-17', 'the day it was FOR, so its age is visible');
  const s = summarizeRows(rows);
  assert.equal(s.carryover, 1);
  assert.equal(s.stillOpen, 1, 'undelivered freight with a clock on it is the actionable count');
});

// ── what the sheet covers ─────────────────────────────────────────────────────

test('deliveries-only drops pickups — a receiving window is about freight arriving', () => {
  const board = [
    stop({ primaryPro: 'DEL', stopType: 'DO', ...instr('RECEIVING HOURS 8AM-2PM') }),
    stop({ primaryPro: 'PU1', stopType: 'PU', ...instr('RECEIVING HOURS 8AM-2PM') }),
  ];
  assert.deepEqual(
    buildTimeRestrictionRows(board, new Map(), WED, { include: 'deliveries' }).map((r) => r.pro), ['DEL']);
  assert.deepEqual(
    buildTimeRestrictionRows(board, new Map(), WED, { include: 'pickups' }).map((r) => r.pro), ['PU1']);
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED, { include: 'all' }).length, 2);
});

test('the library defaults to ALL — silently dropping rows is the caller\'s choice to make', () => {
  const board = [stop({ stopType: 'PU', ...instr('RECEIVING HOURS 8AM-2PM') })];
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED).length, 1);
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED, { include: 'nonsense' }).length, 1,
    'an unrecognised mode falls back to all rather than hiding data');
});

test('filtering happens AFTER default-slot detection, so a stamp cannot slip through', () => {
  // Five customers share 09:00-09:30 — a creation default. Four are pickups. If the
  // pickups were filtered out BEFORE detection, only one stop would carry the slot, it
  // would no longer look like a stamp, and the surviving delivery would be reported as a
  // booked appointment it never had.
  const board = ['a', 'b', 'c', 'd'].map((n) => stop({
    primaryPro: `PU${n}`, businessName: `CUST ${n}`, stopType: 'PU',
    scheduledFrom: `${WED}T09:00:00`, scheduledTo: `${WED}T09:30:00`,
  }));
  board.push(stop({
    primaryPro: 'DEL', businessName: 'CUST E', stopType: 'DO',
    scheduledFrom: `${WED}T09:00:00`, scheduledTo: `${WED}T09:30:00`,
  }));
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED, { include: 'deliveries' }).length, 0);
});

// ── an appointment alone is not a clock constraint ────────────────────────────

test('a stop whose ONLY flag is "appointment required" drops off the sheet', () => {
  const board = [stop({ primaryPro: 'APPT', ...instr('NTFY OF DELIVERY-APPT REQD') })];
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED, { dropAppointmentOnly: true }).length, 0);
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED).length, 1, 'kept by default');
});

test('an appointment PLUS receiving hours stays — it is a hard window and always was', () => {
  const rows = buildTimeRestrictionRows(
    [stop({ primaryPro: 'BOTH', ...instr('RECEIVING HOURS 8AM-2PM', 'NTFY OF DELIVERY-APPT REQD') })],
    new Map(), WED, { dropAppointmentOnly: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tierLabel, 'Hard window');
  assert.match(rows[0].appointment, /appointment required/i);
});

test('an appointment paired with a CLOSED DAY survives, though its tier is still appointment', () => {
  // The trap: tier === 'appointment' does not mean appointment is the only kind. Testing
  // the tier instead of the whole kinds list would silently drop a stop that is shut today.
  const rows = buildTimeRestrictionRows(
    [{ ...stop({ primaryPro: 'SHUT', ...instr('NTFY OF DELIVERY-APPT REQD') }), matchKey: 'k' }],
    new Map([['k', { closed_days: ['wed'] }]]), WED, { dropAppointmentOnly: true });
  assert.equal(rows.length, 1, 'a customer shut today is a clock fact, whatever else it carries');
  assert.equal(rows[0].tierLabel, 'Appointment / call ahead');
});

test('an appointment paired with an AM/PM window survives too', () => {
  const rows = buildTimeRestrictionRows(
    [{ ...stop({ primaryPro: 'AMPM', ...instr('APPOINTMENT REQUIRED') }), matchKey: 'k' }],
    new Map([['k', { delivery_window: 'AM' }]]), WED, { dropAppointmentOnly: true });
  assert.equal(rows.length, 1);
});

// ── whose freight is on the sheet ─────────────────────────────────────────────

test('the 716 series keeps Uline and drops every other shipper on the board', () => {
  const board = [
    stop({ primaryPro: '007163747', ...instr('RECEIVING HOURS 8AM-2PM') }),   // Uline
    stop({ primaryPro: '007164430', ...instr('RECEIVING HOURS 8AM-2PM') }),   // Uline
    stop({ primaryPro: 'ESTES-2918517246', ...instr('RECEIVING HOURS 8AM-2PM') }),
    stop({ primaryPro: 'SHP030527', ...instr('RECEIVING HOURS 8AM-2PM') }),
    stop({ primaryPro: 'FOODSERV8182026-A', ...instr('RECEIVING HOURS 8AM-2PM') }),
    stop({ primaryPro: '007159942-1', ...instr('RECEIVING HOURS 8AM-2PM') }),  // 715 series
  ];
  assert.deepEqual(
    buildTimeRestrictionRows(board, new Map(), WED, { proPrefix: '716' }).map((r) => r.pro),
    ['007163747', '007164430']);
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED).length, 6, 'no prefix = every shipper');
});

test('leading zeros do not decide whether a PRO is Uline', () => {
  assert.ok(proHasPrefix('007163747', '716'));
  assert.ok(proHasPrefix('7163747', '716'));
  assert.ok(!proHasPrefix('007159942-1', '716'), '715 is a different series');
  assert.ok(!proHasPrefix('ESTES-7163747', '716'), 'a prefix match must start the number');
  assert.ok(proHasPrefix('anything', ''), 'no prefix filters nothing');
  assert.ok(proHasPrefix('anything', null));
});

test('a prefix matching nothing yields an EMPTY sheet, never a wrong one', () => {
  const board = [stop({ primaryPro: '007163747', ...instr('RECEIVING HOURS 8AM-2PM') })];
  assert.equal(buildTimeRestrictionRows(board, new Map(), WED, { proPrefix: '999' }).length, 0);
});

test('the sheet carries no driver and no load name', () => {
  const rows = buildTimeRestrictionRows(
    [stop({ routeName: 'FRANK', driverName: 'Frank Okine', ...instr('RECEIVING HOURS 8AM-2PM') })],
    new Map(), WED);
  const headers = CSV_COLUMNS.map(([, h]) => h);
  assert.deepEqual(headers, ['PRO', 'Order #', 'Customer', 'Address', 'City', 'State', 'ZIP', 'Type', 'Restriction'],
    'the sheet is exactly these nine columns — anything else creeping back is a regression');
  for (const gone of ['Route', 'Driver', 'Status', 'Carried over', 'Scheduled for', 'Restriction type',
    'Receiving hours', 'Hours source', 'Order window', 'Appointment / call-ahead', 'Closed today',
    'AM/PM', 'Delivered at', 'Minutes past close', 'Signal source']) {
    assert.ok(!headers.includes(gone), `${gone} must stay off the sheet`);
  }
  assert.equal(rows[0].route, undefined);
  assert.equal(rows[0].driver, undefined);
  assert.ok(!toCsv(rows).includes('Frank Okine'), 'and no driver name reaches the file');
});

test('the summary counts customers once even when they have several restricted PROs', () => {
  const rows = buildTimeRestrictionRows([
    stop({ primaryPro: 'A', businessName: 'SAME CO', ...instr('RECEIVING HOURS 8AM-2PM') }),
    stop({ primaryPro: 'B', businessName: 'SAME CO', ...instr('RECEIVING HOURS 8AM-2PM') }),
  ], new Map(), WED);
  const s = summarizeRows(rows);
  assert.equal(s.total, 2);
  assert.equal(s.customers, 1);
  assert.equal(s.byTier.hard_window, 2);
});
