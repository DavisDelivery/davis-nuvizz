// test/routing-time-windows.test.mjs — what a stop's clock says to the build.
//
// Each case is a freight situation, not a code path: the 1pm appointment stored the way
// the board stores it, the dock that shuts at two, the vendor's all-day placeholder that
// must NOT become a window, the customer closed on Fridays, and the green/red mark that
// must change nothing here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stopTimeRestriction, timeRestrictionsEnabled, boardDefaultSlots } from '../netlify/functions/lib/routing-time-windows.mts';

const FRI = '2026-09-11'; // Fri, Sep 11, 2026 — the day on Chad's screenshot
const stamp = (from, to) => ({ scheduledFrom: `${FRI}T${from}:00`, scheduledTo: `${FRI}T${to}:00`, timeConstraint: 'STRICT' });

test('A 1:00p–1:30p APPOINTMENT, STORED AS THE BOARD STORES IT (a full stamp), is a window', () => {
  const r = stopTimeRestriction({ stop: stamp('13:00', '13:30'), note: null, date: FRI });
  assert.deepEqual([r.openMin, r.closeMin, r.closedToday], [13 * 60, 13 * 60 + 30, false]);
  assert.match(r.sources.join(' '), /appointment 1:00p–1:30p/);
  assert.equal(r.label, '1:00p–1:30p');
});

test('THE VENDOR\'S 08:00–20:00 ALL-DAY STAMP IS NOT A WINDOW — 88% of the board carries it', () => {
  assert.equal(stopTimeRestriction({ stop: stamp('08:00', '20:00'), note: null, date: FRI }), null);
  // …and neither is the zero-length placeholder.
  assert.equal(stopTimeRestriction({ stop: stamp('05:00', '05:00'), note: null, date: FRI }), null);
});

test('receiving hours typed by a dispatcher become the window, and say so', () => {
  const note = { receiving_hours: { fri: { open: '08:00', close: '14:00' } }, manual_overrides: { receiving_hours: true } };
  const r = stopTimeRestriction({ stop: stamp('08:00', '20:00'), note, date: FRI });
  assert.deepEqual([r.openMin, r.closeMin], [8 * 60, 14 * 60]);
  assert.match(r.sources.join(' '), /receiving hours 8:00a–2:00p \(typed\)/);
  assert.equal(r.label, '8:00a–2:00p');
});

test('legacy string hours ("6AM-2PM") are read too — the clock badge lights for these', () => {
  const r = stopTimeRestriction({ stop: {}, note: { receiving_hours: { fri: '6AM-2PM' } }, date: FRI });
  assert.deepEqual([r.openMin, r.closeMin], [6 * 60, 14 * 60]);
});

test('an appointment inside the dock\'s hours: the TIGHTEST combination wins', () => {
  const note = { receiving_hours: { fri: { open: '08:00', close: '14:00' } } };
  const r = stopTimeRestriction({ stop: stamp('09:00', '09:30'), note, date: FRI });
  assert.deepEqual([r.openMin, r.closeMin], [9 * 60, 9 * 60 + 30]);
  assert.equal(r.sources.length, 2, 'both sources are named');
});

test('a 3pm appointment at a dock that says 2pm: the APPOINTMENT stands and the disagreement is named', () => {
  const note = { receiving_hours: { fri: { open: '08:00', close: '14:00' } } };
  const r = stopTimeRestriction({ stop: stamp('15:00', '15:30'), note, date: FRI });
  assert.deepEqual([r.openMin, r.closeMin], [15 * 60, 15 * 60 + 30]);
  assert.match(r.sources.join(' '), /disagree/);
});

test('CLOSED ON FRIDAY: there is no window to plan around, there is no delivery', () => {
  const note = { closed_days: ['fri'], receiving_hours: { fri: { open: '08:00', close: '14:00' } } };
  const r = stopTimeRestriction({ stop: stamp('09:00', '09:30'), note, date: FRI });
  assert.equal(r.closedToday, true);
  assert.equal(r.label, 'closed Friday');
  // The same customer on Monday is a normal dock.
  const mon = stopTimeRestriction({ stop: {}, note: { ...note, receiving_hours: { mon: { open: '08:00', close: '14:00' } } }, date: '2026-09-14' });
  assert.equal(mon.closedToday, false);
});

test('"opens at 10" with no close is a real constraint (cannot lead the route) and no deadline', () => {
  const r = stopTimeRestriction({ stop: {}, note: { receiving_hours: { fri: { open: '10:00', close: '' } } }, date: FRI });
  assert.deepEqual([r.openMin, r.closeMin], [10 * 60, null]);
  assert.equal(r.label, 'opens 10:00a');
});

test('THE VENDOR\'S DEFAULT 30-MINUTE CREATION SLOT IS NOT 21 APPOINTMENTS', () => {
  const board = Array.from({ length: 6 }, (_, i) => ({ businessName: `CUST ${i}`, ...stamp('09:00', '09:30') }));
  const slots = boardDefaultSlots(board);
  assert.equal(stopTimeRestriction({ stop: board[0], note: null, date: FRI, defaultSlots: slots }), null);
  // One customer with the same slot on a board that does not repeat it IS an appointment.
  assert.ok(stopTimeRestriction({ stop: board[0], note: null, date: FRI, defaultSlots: boardDefaultSlots([board[0]]) }));
});

test('WHETHER OR NOT IT IS A TRACTOR-FRIENDLY STOP: eligibility changes nothing here', () => {
  const hours = { receiving_hours: { fri: { open: '08:00', close: '14:00' } } };
  const green = stopTimeRestriction({ stop: stamp('09:00', '09:30'), note: { ...hours, vehicle_eligibility: 'tractor' }, date: FRI });
  const red = stopTimeRestriction({ stop: stamp('09:00', '09:30'), note: { ...hours, vehicle_eligibility: 'box_only', equipment_restrictions: ['no_tractor_trailer'] }, date: FRI });
  const plain = stopTimeRestriction({ stop: stamp('09:00', '09:30'), note: hours, date: FRI });
  assert.deepEqual(green, plain);
  assert.deepEqual(red, plain);
});

test('no clock at all → null, and the absent/malformed never throw', () => {
  assert.equal(stopTimeRestriction({ stop: {}, note: null, date: FRI }), null);
  assert.equal(stopTimeRestriction({ stop: { scheduledFrom: 'garbage', scheduledTo: null }, note: {}, date: 'not-a-date' }), null);
  assert.equal(stopTimeRestriction({ stop: null, note: undefined, date: undefined }), null);
});

test('ROUTING_TIME_RESTRICTIONS: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(timeRestrictionsEnabled({}), true);
  for (const w of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(timeRestrictionsEnabled({ ROUTING_TIME_RESTRICTIONS: w }), false, w);
  for (const w of ['on', 'banana', '', 'true']) assert.equal(timeRestrictionsEnabled({ ROUTING_TIME_RESTRICTIONS: w }), true, w);
});
