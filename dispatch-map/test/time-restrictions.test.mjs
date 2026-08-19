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
  weekdayKey, toCsv, csvCell, summarizeRows, ALL_DAY_MIN, detectDefaultSlots,
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
    stop({ primaryPro: 'LATE', businessName: 'AAA CO', ...instr('RECEIVING HOURS 8AM-5PM') }),
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
