// test/order-view.test.mjs — the ORDER VIEW window's rules (src/lib/order-view.js).
// Chad, 10/03: "redesign the window to better present the full orders details from more of a
// customer service perspective." Each test is a real dispatch situation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildOrderView, orderMessageDrafts, flagsForStop, instructionCues, formatPhone, clockText,
  clockMinutes, dayText, dayKeyOf, fmtCount, cleanOrderText,
} from '../src/lib/order-view.js';

const DAY = '2026-10-05'; // a Monday
// A list row exactly as the board feed serves most orders: no contact, items, notes or refs.
const LIST = (over = {}) => ({
  stopNbr: '007185553', pro: '007185553', businessName: 'MOTOVARIO CORPORATION',
  addr1: '900 GAINESVILLE HWY', addr2: '', city: 'BUFORD', state: null, zip: '30518', lat: 34.1, lng: -84.0,
  cartons: 8, volume: 2, weight: 4200, routeName: 'GEORGE L', loadNbr: 'GEORGE L', routeSeq: 16,
  driverName: 'GEORGE LEONARD', normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  scheduledFrom: `${DAY}T08:00:00`, scheduledTo: null, listUpdatedDTTM: `${DAY}T09:40:00`, boardDate: DAY,
  ...over,
});
// The same order after enrichment.
const FULL = (over = {}) => LIST({
  enriched: true, enriched_at: `${DAY}T06:10:00`, state: 'GA', pallets: 10,
  contact: { name: 'TAMOND CLARK', phone: '770-752-0911', email: 'dock@motovario.example' },
  scheduledTo: `${DAY}T14:00:00`, timeConstraint: 'STRICT',
  stopDetails: [
    { product: 'GEAR REDUCERS', quantity: 6, quantityUOM: 'PCS', weight: 3600, weightUOM: 'LBS', referenceText: '70', productCategory: 'L', length: 96, width: 40, height: 50, lengthUOM: 'IN' },
    { product: 'MOTOR MOUNTS', quantity: 4, quantityUOM: 'CTN', weight: 600 },
  ],
  allComments: [{ text: 'Dock 4', type: 'ORD_IN' }],
  signalSources: { orderInstructions: 'SPL-INSTR-TEXT: Use dock 4.\nDO NOT BREAKDOWN SKID' },
  poRef: 'PO 99812', bol: 'B-1', custRef: 'MOTO-55', orderNbr: '7712', terms: 'PREPAID',
  ...over,
});
const V = (stop, o = {}) => buildOrderView({ stop, kind: stop.normalizedStatus, boardDate: DAY, today: DAY, nowMin: 9 * 60, ...o });

test('formatting: phones, counts, clocks and days read the way a dispatcher says them', () => {
  assert.equal(formatPhone('770-752-0911'), '(770) 752-0911');
  assert.equal(formatPhone('17707520911'), '(770) 752-0911');
  assert.equal(formatPhone('+44 20 7946 0958'), '+44 20 7946 0958', 'a number that is not US stays as given');
  assert.equal(formatPhone(''), '');
  assert.equal(fmtCount(4200), '4,200');
  assert.equal(fmtCount(null), '', 'no number is no number — never 0');
  assert.equal(fmtCount(''), '');
  assert.equal(clockText(`${DAY}T14:05:00`), '2:05 PM', 'NuVizz wall clock read as written');
  assert.equal(clockText('2026-10-05T18:05:00Z'), '2:05 PM', 'a zoned time is shown in Eastern');
  assert.equal(clockText('2026-10-05'), '', 'a bare date carries no time');
  assert.equal(clockMinutes(`${DAY}T14:05:00`), 14 * 60 + 5);
  assert.equal(dayKeyOf(DAY), 'mon');
  assert.equal(dayText(DAY, DAY), 'Mon, Oct 5');
  assert.equal(dayText('2027-01-04', DAY), 'Mon, Jan 4, 2027', 'another year says which');
  assert.equal(cleanOrderText('SPL-INSTR-TEXT: CALL FIRST\nDO NOT BREAK DOWN SKID'), 'CALL FIRST');
});

test('a list-only row: missing is reported missing, and the next move is to load it (1 call, never automatic)', () => {
  const v = V(LIST());
  assert.equal(v.data.listOnly, true);
  assert.deepEqual(v.data.missing, ['contact', 'items', 'notes', 'references']);
  assert.equal(v.next.key, 'load-order');
  assert.match(v.next.reason, /1 NuVizz call/);
  assert.equal(v.contact.known, false);
  assert.deepEqual(v.freight.items, []);
  // The load-wide Estimated Arrival is not dressed as this order's window, nor as an ETA.
  assert.deepEqual(v.when.window, { text: 'around 8:00 AM', closeMin: null, appointment: false, estimateOnly: true, otherDay: '' });
  assert.equal(v.when.eta, null);
  assert.match(v.when.etaMissing, /No live ETA/);
  // Total pieces with no NuVizz total: pallets + loose, from the fields the row has.
  assert.equal(v.freight.total, 10);
  // Nothing to fix → no alerts, and no requirement invented.
  assert.deepEqual(v.alerts, []);
  assert.deepEqual(v.requirements, []);
});

test('freight that is not on the board stays blank — never a misleading zero', () => {
  const v = V(LIST({ cartons: null, volume: null, weight: null, pallets: null }));
  assert.equal(v.freight.known, false);
  assert.equal(v.freight.total, null);
  assert.equal(v.freight.weight, null);
});

test('a normal enriched order: who to call, what is on it, references, and its delivery window', () => {
  const v = V(FULL());
  assert.equal(v.data.listOnly, false);
  assert.equal(v.contact.phoneDisplay, '(770) 752-0911');
  assert.equal(v.contact.source, 'order');
  assert.equal(v.contact.email, 'dock@motovario.example');
  assert.deepEqual(v.when.window, { text: '8:00 AM – 2:00 PM', closeMin: 14 * 60, appointment: false, estimateOnly: false, otherDay: '' });
  assert.equal(v.freight.total, 10, 'NuVizz total pieces wins when present');
  assert.deepEqual(v.freight.items.map((i) => [i.product, i.qty, i.uom, i.weight, i.cls, i.oversize, i.dims]), [
    ['GEAR REDUCERS', 6, 'PCS', 3600, '70', true, '96 × 40 × 50 in'],
    ['MOTOR MOUNTS', 4, 'CTN', 600, '', false, ''],
  ]);
  assert.deepEqual(v.refs.map((r) => r.label), ['PO', 'BOL', 'Customer ref', 'Order', 'Terms']);
  assert.ok(v.requirements.some((r) => r.key === 'window' && r.label === 'Delivery window' && r.source === 'On the NuVizz order' && r.must));
  assert.equal(v.requirements.some((r) => /strict/i.test(r.label)), false, 'STRICT is NuVizz’s default stamp — never shown as a commitment');
  assert.equal(v.next.key, 'call-customer');
  assert.match(v.next.reason, /Scheduled on GEORGE L for Mon, Oct 5/);
});

test('the corrected address and saved number win, and the order’s own number is still shown beside it', () => {
  const note = { address_override: { addr1: '1 DOCK RD', city: 'SUWANEE', state: 'GA', zip: '30024' }, contacts: [{ name: 'BOB', phone: '6785550100', role: 'Dock' }] };
  const v = V(FULL(), { note });
  assert.deepEqual(v.where.lines, ['1 DOCK RD', 'SUWANEE, GA 30024']);
  assert.equal(v.where.corrected, true);
  assert.equal(v.contact.name, 'BOB');
  assert.equal(v.contact.phoneDisplay, '(678) 555-0100');
  assert.equal(v.contact.source, 'saved');
  assert.deepEqual(v.contact.aside, { name: 'TAMOND CLARK', phoneDisplay: '(770) 752-0911', phone: '770-752-0911' });
});

test('missing contact: the next move is to add a number, said plainly', () => {
  const v = V(FULL({ contact: { name: 'RECEIVING', phone: '' } }));
  assert.equal(v.contact.dialable, false);
  assert.equal(v.next.key, 'add-contact');
  assert.match(v.next.reason, /RECEIVING is on file, but no number/);
  const none = V(FULL({ contact: null }));
  assert.equal(none.next.key, 'add-contact');
  assert.match(none.next.reason, /No customer contact/);
});

test('requirements keep their source: saved, auto-detected, on the NuVizz order, or read from the order text', () => {
  const note = {
    appointment_required: true, appointment_notes: 'Book with Pat', liftgate_required: true, dock_type: 'ground', dock_notes: 'Back of building',
    equipment_restrictions: ['box_truck_only'], manual_overrides: { equipment_restrictions: true },
    receiving_hours: { mon: { open: '07:00', close: '15:00' } }, auto_sources: { receiving_hours: ['orderInstructions'] }, auto_matches: { receiving_hours: [{ text: 'RECV 7-3', source: 'orderInstructions' }] },
  };
  const v = V(FULL({ signalSources: { orderInstructions: 'CALL 30 MIN AHEAD. LIFTGATE NEEDED. GATE CODE 4471' } }), { note });
  const by = Object.fromEntries(v.requirements.map((r) => [r.key, r]));
  assert.equal(by.hours.label, 'Receiving 7:00 AM – 3:00 PM');
  assert.equal(by.hours.source, 'Auto-detected — verify', 'hours the scanner found are not presented as confirmed');
  assert.equal(by.appointment.source, 'Saved for this customer');
  assert.equal(by.appointment.detail, 'Book with Pat');
  assert.equal(by.liftgate.must, true);
  assert.equal(by.dock.label, 'Ground level');
  assert.equal(by.equipment.label, 'Box truck only');
  assert.equal(by['cue:call_ahead'].source, 'In this order’s text');
  assert.equal(by['cue:call_ahead'].detail, 'CALL 30 MIN AHEAD.', 'the original sentence rides with the cue');
  assert.equal(by['cue:gate'].detail, 'GATE CODE 4471');
  assert.ok(by['cue:gate']);
  assert.equal(by['cue:liftgate'], undefined, 'the saved liftgate is not repeated as an inference');
});

test('instruction cues: read only what the text says; long sentences are cut, never lost from the original', () => {
  assert.deepEqual(instructionCues('').map((c) => c.key), []);
  assert.deepEqual(instructionCues('Please call ahead 1 hour. Inside delivery. Residential.').map((c) => c.key), ['call_ahead', 'inside', 'residential']);
  assert.deepEqual(instructionCues('RECEIVING CLOSES AT 2PM').map((c) => c.key), ['hours']);
  assert.deepEqual(instructionCues('DO NOT STACK').map((c) => c.key), [], 'no cue for words it does not know');
  const long = `CALL AHEAD ${'X'.repeat(200)}`;
  assert.equal(instructionCues(long)[0].snippet.length, 138);
  // The window always shows the full text; the cue is only the summary.
  const v = V(FULL({ signalSources: { orderInstructions: long } }));
  assert.equal(v.instructions, long);
  // One line, two instructions: each cue quotes its own sentence, not the whole line twice.
  const two = instructionCues('CALL 30 MIN AHEAD. USE DOCK 4 AT THE BACK OF THE BUILDING.');
  assert.deepEqual(two.map((c) => [c.key, c.snippet]), [['call_ahead', 'CALL 30 MIN AHEAD.'], ['dock', 'USE DOCK 4 AT THE BACK OF THE BUILDING.']]);
  assert.equal(instructionCues('RECEIVING CLOSES AT 4 P.M. USE DOCK 4.').find((c) => c.key === 'hours').snippet, 'RECEIVING CLOSES AT 4 P.M.', 'P.M. does not cut the hours sentence');
});

test('blockers come first and name the fix: two orders on one number, no pin, closed today, a barred driver', () => {
  assert.equal(V(FULL({ dupNbr: true })).next.key, 'load-order');
  const noPin = V(FULL({ lat: null, lng: null }));
  assert.equal(noPin.alerts[0].key, 'no-pin');
  assert.equal(noPin.next.key, 'fix-pin');
  // A saved pin override counts as a location.
  assert.equal(V(FULL({ lat: null, lng: null }), { note: { location_override: { lat: 34, lng: -84 } } }).alerts.some((a) => a.key === 'no-pin'), false);
  const closed = V(FULL(), { note: { closed_days: ['mon'], manual_overrides: { closed_days: true } } });
  // closedDayTier reads TYPED days from closed_days when CLOSED_DAYS_FROM_ORDER is on; the
  // order text also counts. Either way the alert names the day and the fix.
  const closedOrder = V(FULL({ signalSources: { orderInstructions: 'CLOSED ON MONDAYS' }, orderInstructions: 'CLOSED ON MONDAYS' }));
  for (const c of [closed, closedOrder].filter((x) => x.alerts.some((a) => a.key === 'closed'))) {
    assert.equal(c.next.key, 'change-date');
    assert.match(c.alerts.find((a) => a.key === 'closed').title, /closed Mondays/);
  }
  assert.ok(closedOrder.alerts.some((a) => a.key === 'closed'), 'the order’s own "closed on Mondays" is read live');
  const barred = V(FULL(), { note: { do_not_send: true, dns_drivers: ['George Leonard'] } });
  assert.equal(barred.alerts[0].key, 'dns-driver');
  assert.match(barred.alerts[0].title, /GEORGE LEONARD is not allowed/);
  assert.ok(barred.requirements.some((r) => r.key === 'dns_drivers'));
  const otherDriver = V(FULL({ driverName: 'SAM' }), { note: { do_not_send: true, dns_drivers: ['George Leonard'] } });
  assert.equal(otherDriver.alerts.some((a) => a.key.startsWith('dns')), false, 'a barred driver who is not assigned is a requirement, not an alert');
});

test('the delivery window: closing soon warns, closed and not delivered blocks — only on today, only for a whole window', () => {
  const soon = V(FULL(), { nowMin: 13 * 60 + 30 });
  const w = soon.alerts.find((a) => a.key === 'window-closing');
  assert.equal(w.title, 'Delivery window closes in 30 min');
  assert.equal(w.tier, 'warn');
  const gone = V(FULL(), { nowMin: 14 * 60 + 20 });
  assert.equal(gone.alerts[0].key, 'window-closed');
  assert.equal(gone.next.key, 'call-customer');
  assert.equal(gone.next.alertKey, 'window-closed', 'the window knows which alert the next action already covers');
  // Closed, and no number to call: loading the order again would not help — getting a number would.
  const goneNoNumber = V(FULL({ contact: { name: 'RECEIVING', phone: '' } }), { nowMin: 14 * 60 + 20 });
  assert.equal(goneNoNumber.next.key, 'add-contact');
  assert.equal(V(FULL(), { nowMin: 9 * 60 }).alerts.some((a) => a.key.startsWith('window')), false);
  assert.equal(V(FULL(), { today: '2026-10-04', nowMin: 15 * 60 }).alerts.some((a) => a.key.startsWith('window')), false, 'not today: no clock alert');
  assert.equal(V(LIST(), { nowMin: 15 * 60 }).alerts.some((a) => a.key.startsWith('window')), false, 'half a window never alerts');
  assert.equal(V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T13:00:00` }), { nowMin: 15 * 60 }).alerts.some((a) => a.key.startsWith('window')), false);
});

test('ETA: NuVizz’s is "as of" when it was read; ours is an estimate with its band and basis; none is said so', () => {
  const nv = V(FULL({ raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T11:20:00` } } } }));
  assert.equal(nv.when.eta.text, '11:20 AM');
  assert.equal(nv.when.eta.basis, 'nuvizz');
  assert.match(nv.when.eta.detail, /as NuVizz had it at 6:10 AM — it is not updated live/);
  const ours = V(FULL(), { eta: { etaMin: 12 * 60 + 40, errorMin: 25, anchored: false } });
  assert.equal(ours.when.eta.text, 'about 12:40 PM');
  assert.equal(ours.when.eta.band, '±25 min');
  assert.match(ours.when.eta.detail, /Projected from the route’s usual departure/);
  assert.match(V(FULL(), { eta: { etaMin: 700, errorMin: 15, anchored: true } }).when.eta.detail, /Measured from the truck/);
  assert.equal(V(FULL(), { eta: { etaMin: 700 }, today: '2026-10-04' }).when.eta, null, 'our estimate is only for today’s board');
  assert.match(V(FULL(), { today: '2026-10-04' }).when.etaMissing, /No ETA before the delivery day/);
  const done = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T13:00:00` }));
  assert.equal(done.when.eta, null);
  assert.equal(done.when.etaMissing, '');
});

test('a stale ETA: NuVizz’s planned time has passed with no arrival — said so, and the driver is the one to ask', () => {
  const stop = FULL({ raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T11:20:00` } } } });
  const late = V(stop, { nowMin: 12 * 60 });
  assert.equal(late.when.eta.stale, true);
  assert.match(late.when.eta.detail, /has passed with no arrival on our board/);
  const a = late.alerts.find((x) => x.key === 'eta-stale');
  assert.equal(a.tier, 'warn');
  assert.equal(a.title, 'Planned ETA 11:20 AM has passed');
  assert.equal(a.action.key, 'text-driver');
  assert.equal(V(stop, { nowMin: 11 * 60 + 30 }).when.eta.stale, false, 'within 15 minutes is not stale yet');
  assert.equal(V(stop, { nowMin: 12 * 60, today: '2026-10-04' }).alerts.some((x) => x.key === 'eta-stale'), false, 'only on the delivery day');
  assert.equal(V({ ...stop, normalizedStatus: 'ARRIVED' }, { nowMin: 12 * 60 }).alerts.some((x) => x.key === 'eta-stale'), false, 'arrived is not late');
  assert.equal(V({ ...stop, normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T11:50:00` }, { nowMin: 12 * 60 }).alerts.some((x) => x.key === 'eta-stale'), false);
  // A plan written for another day is not today's ETA — said so, never shown as current.
  const old = V(FULL({ raw: { stopExecutionInfo: { to: { plannedEtaDTTM: '2026-10-02T11:20:00' } } } }), { nowMin: 12 * 60 });
  assert.equal(old.when.eta, null);
  assert.match(old.when.etaMissing, /from Fri, Oct 2’s plan/);
  assert.equal(old.alerts.some((x) => x.key === 'eta-stale'), false);
});

test('the window is read the way the rest of the app reads it: NuVizz placeholders and its creation stamp are not windows', () => {
  for (const [from, to] of [['05:00', '05:00'], ['08:00', '20:00']]) {
    const v = V(FULL({ scheduledFrom: `${DAY}T${from}:00`, scheduledTo: `${DAY}T${to}:00` }), { nowMin: 19 * 60 + 10 });
    assert.equal(v.when.window, null, `${from}-${to} is a placeholder`);
    assert.match(v.when.windowNote, /not a delivery window/);
    assert.equal(v.alerts.some((a) => a.key.startsWith('window')), false);
    assert.equal(v.requirements.some((r) => r.key === 'window'), false);
    assert.equal(orderMessageDrafts(v).some((d) => / between /.test(d.text)), false, 'no placeholder in a customer message');
  }
  // 09:00–09:30 stamped on many unrelated customers is NuVizz's creation default (detectDefaultSlots).
  const slot = FULL({ scheduledFrom: `${DAY}T09:00:00`, scheduledTo: `${DAY}T09:30:00` });
  assert.equal(V(slot, { nowMin: 10 * 60, defaultSlots: new Set(['540-570']) }).when.window, null);
  const real = V(slot, { nowMin: 10 * 60 });
  assert.equal(real.when.window.appointment, true, 'a half-hour nobody else holds is a booked slot');
  assert.equal(real.requirements.find((r) => r.key === 'window').label, 'Appointment slot');
  // A carried-over order keeps day one's schedule: shown with its date, never judged against today.
  // A refused schedule is described by WHY, with NuVizz's own times — never called a default it is not.
  const workday = V(FULL({ scheduledFrom: `${DAY}T07:00:00`, scheduledTo: `${DAY}T15:00:00` }));
  assert.equal(workday.when.window, null);
  assert.equal(workday.when.windowNote, 'NuVizz’s schedule 7:00 AM – 3:00 PM spans a working day — not read as a delivery window.');
  assert.match(V(FULL({ scheduledFrom: `${DAY}T08:00:00`, scheduledTo: `${DAY}T20:00:00` })).when.windowNote, /all-day default, 8:00 AM – 8:00 PM/);
  assert.match(V(FULL({ scheduledFrom: `${DAY}T05:00:00`, scheduledTo: `${DAY}T05:00:00` })).when.windowNote, /a placeholder/);
  assert.match(V(slot, { defaultSlots: new Set(['540-570']) }).when.windowNote, /9:00 AM – 9:30 AM is the half hour NuVizz stamps/);
  // A carried-over LIST row's load-wide estimate keeps its date too.
  const carriedList = V(LIST({ scheduledFrom: '2026-10-02T08:00:00', carryover: true }));
  assert.equal(carriedList.when.window.otherDay, 'Fri, Oct 2');
  const carried = V(FULL({ scheduledFrom: '2026-10-02T08:00:00', scheduledTo: '2026-10-02T14:00:00' }), { nowMin: 14 * 60 + 30 });
  assert.equal(carried.when.window.otherDay, 'Fri, Oct 2');
  assert.equal(carried.when.window.closeMin, null);
  assert.equal(carried.alerts.some((a) => a.key.startsWith('window')), false);
  assert.equal(carried.requirements.some((r) => r.key === 'window'), false);
});

test('our anchored ETA outranks NuVizz’s frozen plan, as on the route card; a passed plan is only raised when it is all we have', () => {
  const stop = FULL({ normalizedStatus: 'OUT_FOR_DEL', raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T09:30:00` } } } });
  const v = V(stop, { nowMin: 10 * 60, eta: { etaMin: 11 * 60 + 40, errorMin: 14, anchored: true } });
  assert.equal(v.when.eta.basis, 'model');
  assert.equal(v.when.eta.text, 'about 11:40 AM');
  assert.equal(v.alerts.some((a) => a.key === 'eta-stale'), false);
  // The "as of" time carries its date when it was not read today.
  const readEarlier = V(FULL({ enriched_at: '2026-10-02T06:10:00', raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T11:20:00` } } } }));
  assert.match(readEarlier.when.eta.detail, /6:10 AM on Fri, Oct 2/);
  assert.equal(V({ ...stop, normalizedStatus: 'ARRIVED', arrivalDTTM: `${DAY}T09:50:00` }, { nowMin: 10 * 60 }).when.eta, null, 'arrived: no ETA, the arrival time shows instead');
});

test('our estimate after the window closes is raised as an estimate — only when even its early edge is late', () => {
  const stop = FULL({ normalizedStatus: 'OUT_FOR_DEL', scheduledFrom: `${DAY}T07:40:00`, scheduledTo: `${DAY}T10:10:00` });
  const late = V(stop, { nowMin: 9 * 60 + 40, eta: { etaMin: 13 * 60 + 58, errorMin: 25, anchored: true } });
  const a = late.alerts.find((x) => x.key === 'eta-after-window');
  assert.equal(a.tier, 'warn');
  assert.equal(a.estimate, true);
  assert.equal(a.detail, 'About 1:58 PM ±25 min against a 10:10 AM close.');
  assert.equal(a.action.key, 'call-customer');
  assert.equal(late.next.key, 'call-customer', 'the truck cannot make it: the customer is the call, ahead of texting the driver');
  assert.equal(late.next.alertKey, 'eta-after-window');
  // Inside the band of the close: not raised — the estimate cannot say it is late.
  assert.equal(V(stop, { nowMin: 9 * 60 + 40, eta: { etaMin: 10 * 60 + 25, errorMin: 25, anchored: true } }).alerts.some((x) => x.key === 'eta-after-window'), false);
  // NuVizz's plan alone never raises it.
  const nv = FULL({ normalizedStatus: 'OUT_FOR_DEL', scheduledFrom: `${DAY}T07:40:00`, scheduledTo: `${DAY}T10:10:00`, raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T13:58:00` } } } });
  assert.equal(V(nv, { nowMin: 9 * 60 + 40 }).alerts.some((x) => x.key === 'eta-after-window'), false);
});

test('a customer message never carries an estimate, an unplanned "schedule" or an arrival it has not seen', () => {
  const stale = V(FULL({ normalizedStatus: 'OUT_FOR_DEL', raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T09:00:00` } } } }), { nowMin: 11 * 60 });
  assert.equal(stale.when.eta.stale, true);
  for (const d of orderMessageDrafts(stale)) assert.doesNotMatch(d.text, /9:00 AM|estimated/, 'a passed plan never reaches a draft');
  const ours = V(FULL({ normalizedStatus: 'OUT_FOR_DEL' }), { eta: { etaMin: 700, errorMin: 15, anchored: true } });
  for (const d of orderMessageDrafts(ours)) assert.doesNotMatch(d.text, /11:40|±|estimated/, 'nor does our model');
  const unplanned = V(FULL({ normalizedStatus: 'UNPLANNED', status: '10', loadNbr: '', routeName: '', routeSeq: null, driverName: '' }));
  assert.equal(orderMessageDrafts(unplanned).some((d) => d.key === 'scheduled'), false);
  const arrived = V(FULL({ normalizedStatus: 'ARRIVED', arrivalDTTM: `${DAY}T10:05:00` }));
  assert.deepEqual(orderMessageDrafts(arrived).map((d) => d.key), ['arrived', 'delay', 'call-me']);
  // Parked on ULINE APPT on the day the customer is closed: no "scheduled for" that day.
  const held = V(FULL({ loadNbr: 'ULINE APPT', routeName: 'ULINE APPT', signalSources: { orderInstructions: 'CLOSED ON MONDAYS' }, orderInstructions: 'CLOSED ON MONDAYS' }));
  assert.equal(held.route.held, true);
  assert.equal(orderMessageDrafts(held).some((d) => d.key === 'scheduled'), false);
  assert.ok(orderMessageDrafts(V(FULL({ loadNbr: 'CHAD', routeName: 'CHAD' }))).some((d) => d.key === 'scheduled'), 'the owner’s truck does deliver');
});

test('the flag engine’s gates hold here too: set-aside routes and unrouted unplanned orders are not blocked', () => {
  const closedNote = { closed_days: ['mon'], manual_overrides: { closed_days: true } };
  const typedClosed = { ...closedNote, closed_days_typed: ['mon'] };
  const onAppt = FULL({ loadNbr: 'ULINE APPT', routeName: 'ULINE APPT', lat: null, lng: null, dupNbr: true, signalSources: { orderInstructions: 'CLOSED ON MONDAYS' }, orderInstructions: 'CLOSED ON MONDAYS' });
  const va = V(onAppt, { note: typedClosed });
  assert.deepEqual(va.alerts.filter((a) => ['closed', 'no-pin', 'dup'].includes(a.key)), [], 'ULINE APPT is a holding pen, not a late truck');
  const onChad = V(FULL({ loadNbr: 'CHAD', routeName: 'CHAD', dupNbr: true }));
  assert.equal(onChad.alerts.some((a) => a.key === 'dup'), false, 'the owner’s own truck');
  const parked = V(FULL({ normalizedStatus: 'UNPLANNED', status: '10', loadNbr: '', routeName: '', signalSources: { orderInstructions: 'CLOSED ON MONDAYS' }, orderInstructions: 'CLOSED ON MONDAYS' }));
  assert.equal(parked.alerts.some((a) => a.key === 'closed'), false, 'freight parked because the customer is closed is already solved');
});

test('every action offered can run: no route view without a route, no call without a number, load before guessing', () => {
  // Out for delivery with no route and no driver on our board: reach the customer, never a route view.
  const loose = V(FULL({ normalizedStatus: 'OUT_FOR_DEL', status: '40', loadNbr: null, routeName: null, driverName: null }));
  assert.equal(loose.next.key, 'call-customer');
  assert.match(loose.next.reason, /no route or driver on our board/);
  // Unplanned, no driver, window closing: reach the customer, not a route that does not exist.
  const unrouted = V(FULL({ normalizedStatus: 'UNPLANNED', status: '10', loadNbr: '', routeName: '', driverName: '', scheduledFrom: `${DAY}T13:00:00`, scheduledTo: `${DAY}T17:00:00` }), { nowMin: 16 * 60 + 20 });
  const w = unrouted.alerts.find((a) => a.key === 'window-closing');
  assert.equal(w.action.key, 'call-customer');
  assert.notEqual(unrouted.next.key, 'open-route');
  // A list-only row with a red hours estimate: load it (the number comes with it), never "move the date".
  const listRed = V(LIST(), { flags: [{ rule: 'hours_risk', tier: 'red', stopNbr: '007185553', title: 'May miss receiving hours', fingerprint: 'r' }] });
  assert.equal(listRed.next.key, 'load-order');
  // Arrived: the call-ahead is past.
  const arrived = V(FULL({ normalizedStatus: 'ARRIVED', arrivalDTTM: `${DAY}T10:05:00`, signalSources: { orderInstructions: 'CALL 30 MIN AHEAD' } }));
  assert.notEqual(arrived.next.reason, 'The order asks for a call before arrival.');
  // A barred driver on a delivered order is history, not a blocker (the requirement still records it).
  const done = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T11:00:00` }), { note: { do_not_send: true, dns_drivers: ['George Leonard'] } });
  assert.equal(done.alerts.some((a) => a.key === 'dns-driver'), false);
  assert.ok(done.requirements.some((r) => r.key === 'dns_drivers'));
});

test('provenance is never laundered: scanner hours are not a late-delivery fact, unrecorded hours are not "saved"', () => {
  const autoNote = { receiving_hours: { mon: { open: '06:00', close: '14:00' } }, auto_sources: { receiving_hours: ['orderInstructions'] } };
  const late = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T15:10:00` }), { note: autoNote });
  assert.equal(late.alerts.some((a) => a.key === 'late-delivery'), false);
  const typedNote = { receiving_hours: { mon: { open: '06:00', close: '14:00' } }, manual_overrides: { receiving_hours: true } };
  const lateTyped = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T15:10:00` }), { note: typedNote });
  assert.equal(lateTyped.alerts.find((a) => a.key === 'late-delivery').title, 'Delivered 70 min after receiving closed');
  const unrecorded = V(FULL(), { note: { receiving_hours: { mon: { open: '07:00', close: '11:00' } } } });
  assert.equal(unrecorded.requirements.find((r) => r.key === 'hours').source, 'Source not recorded');
});

test('a flag recovered from a collapsed batch is titled by its rule, and "DO NOT CALL" is never a call-ahead', () => {
  // The exact shape board-flags.js projects into collapsedRows: no title, no fingerprint.
  const projected = { rule: 'hours_risk', tier: 'red', stopNbr: '007185553', routeName: 'GEORGE L', closeMin: 840, etaMin: 900, anchored: false, detail: 'Arrives after close.', servedDate: DAY, hoursTier: 'typed' };
  const v = V(FULL(), { flags: [projected] });
  const a = v.alerts.find((x) => x.key.startsWith('flag:hours_risk'));
  assert.equal(a.title, 'May miss receiving hours');
  assert.equal(a.key, `flag:hours_risk:007185553|${DAY}`);
  assert.deepEqual(instructionCues('DO NOT CALL BEFORE ARRIVAL').map((c) => c.key), []);
  assert.deepEqual(instructionCues("DON'T CALL AHEAD. USE DOCK 2.").map((c) => c.key), ['dock']);
  assert.deepEqual(instructionCues('CALL AHEAD, DO NOT LEAVE AT DOOR').map((c) => c.key), ['call_ahead'], 'a negation after the call is about something else');
  // A negation that governs something else in the same sentence leaves the call-ahead standing.
  for (const txt of ['DO NOT STACK - CALL AHEAD', 'NO DELIVERIES BEFORE 9, CALL AHEAD', 'DO NOT LEAVE AT DOOR, CALL AHEAD', 'PO NO 4471 CALL AHEAD', 'NEVER LEAVE UNATTENDED - CALL 30 MIN PRIOR']) {
    assert.ok(instructionCues(txt).some((c) => c.key === 'call_ahead'), txt);
  }
  assert.deepEqual(instructionCues('NO NEED TO CALL AHEAD').map((c) => c.key), []);
});

test('a Past PRO search result keeps its own day — never the day the screen is showing', () => {
  const hist = { stopNbr: '0071', pro: '0071', businessName: 'X', scheduledDate: '2026-09-20', deliveredDTTM: '2026-09-20T14:14:00', normalizedStatus: 'DELIVERED', __historical: true };
  const v = buildOrderView({ stop: hist, kind: 'DELIVERED', boardDate: '2026-10-03', today: '2026-10-03', nowMin: 9 * 60 });
  assert.equal(v.when.day, '2026-09-20');
  assert.equal(v.when.isToday, false);
  assert.match(orderMessageDrafts(v)[0].text, /on Sun, Sep 20/);
});

test('board flags: the same rows as the flags panel, with the estimate’s basis spelled out', () => {
  const rows = [
    { rule: 'hours_risk', tier: 'critical', stopNbr: '007185553', title: 'May miss receiving hours', detail: 'Arrives after the 2:00 PM close.', etaMin: 14 * 60 + 40, closeMin: 14 * 60, errorMin: 25, anchored: false, hoursTier: 'typed', fingerprint: 'fp1' },
    { rule: 'trailer_conflict', tier: 'red', stopNbrs: ['007185553', '0071'], title: 'Tractor at a no-trailer dock', detail: 'Move it to a box truck.', fingerprint: 'fp2' },
    { rule: 'no_location', tier: 'red', stopNbr: '007185553', title: 'No location' },
    { rule: 'hours_risk', tier: 'amber', stopNbr: 'OTHER', title: 'not ours' },
    { rule: 'hours_risk', tier: 'red', stopNbr: null, collapsedRows: [{ rule: 'hours_risk', tier: 'red', stopNbr: '007185553', title: 'Inside a summary', fingerprint: 'fp3' }] },
  ];
  const mine = flagsForStop(rows, { stopNbr: '007185553' });
  assert.deepEqual(mine.map((r) => r.fingerprint || r.title), ['fp1', 'fp2', 'No location', 'fp3']);
  const v = V(FULL(), { flags: mine });
  const hr = v.alerts.find((a) => a.key === 'flag:hours_risk:fp1');
  assert.equal(hr.tier, 'block');
  assert.equal(hr.estimate, true);
  assert.equal(hr.basis, 'Estimate: arrives about 2:40 PM ±25 min; receiving closes 2:00 PM. Projected from the route’s usual departure.');
  assert.equal(hr.action.key, 'call-customer');
  // The panel's titles end "— CUSTOMER"; inside this customer's own window that is dropped.
  const named = V(FULL(), { flags: [{ rule: 'hours_risk', tier: 'amber', stopNbr: '007185553', title: 'May miss receiving hours — Motovario Corporation', fingerprint: 'fpn' }] });
  assert.equal(named.alerts.find((a) => a.key === 'flag:hours_risk:fpn').title, 'May miss receiving hours');
  assert.ok(v.alerts.some((a) => a.key === 'flag:trailer_conflict:fp2'));
  assert.equal(v.alerts.filter((a) => /No location/.test(a.title)).length, 0, 'no_location is read directly, not doubled');
  assert.deepEqual(flagsForStop(null, { stopNbr: '1' }), []);
});

test('alerts rank blockers, then checks, then notes; carry-over and re-attempts are notes', () => {
  const v = V(FULL({ carryover: true, scheduledDate: '2026-10-02', isAttempt: true, addr1: '', addr2: '900 GAINESVILLE HWY' }));
  const tiers = v.alerts.map((a) => a.tier);
  assert.deepEqual(tiers, [...tiers].sort((a, b) => ({ block: 0, warn: 1, info: 2 }[a] - { block: 0, warn: 1, info: 2 }[b])));
  assert.ok(v.alerts.find((a) => a.key === 'carryover').title.includes('Fri, Oct 2'));
  assert.ok(v.alerts.some((a) => a.key === 'attempt'));
});

test('out for delivery: call ahead when the order asks, otherwise reach the driver', () => {
  const ahead = V(FULL({ normalizedStatus: 'OUT_FOR_DEL', signalSources: { orderInstructions: 'CALL 30 MIN AHEAD' } }));
  assert.equal(ahead.next.key, 'call-customer');
  assert.match(ahead.next.reason, /call before arrival/);
  const drv = V(FULL({ normalizedStatus: 'OUT_FOR_DEL' }), { driverPhone: '4045550101' });
  assert.equal(drv.next.key, 'call-driver');
  assert.equal(drv.next.label, 'Call GEORGE LEONARD');
  assert.match(drv.next.reason, /Out for delivery on GEORGE L, stop 16/);
  assert.equal(V(FULL({ normalizedStatus: 'OUT_FOR_DEL' })).next.key, 'text-driver', 'no number on file: text by name');
  assert.equal(ahead.next.tone, 'act', 'on its way, the call-ahead is due now');
  assert.equal(drv.next.tone, 'calm', 'on its way with nothing wrong is on track');
});

test('the window raises its voice only when something needs doing: On track vs Next', () => {
  // Scheduled, call-ahead in the text, morning: a reminder for later, not a job for now.
  const later = V(FULL({ signalSources: { orderInstructions: 'CALL 30 MIN AHEAD' } }));
  assert.equal(later.next.tone, 'calm');
  assert.match(later.next.reason, /due once the truck is on its way/);
  assert.equal(V(FULL()).next.tone, 'calm', 'scheduled with nothing wrong');
  // A check with a fix leads when nothing blocks: a passed plan sends you to the driver.
  const stale = V(FULL({ raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T08:30:00` } } } }), { nowMin: 9 * 60 + 40 });
  assert.equal(stale.next.key, 'text-driver');
  assert.equal(stale.next.tone, 'act');
  assert.equal(stale.next.alertKey, 'eta-stale');
  // A blocker outranks a check; a list-only row loads before acting on a check.
  const both = V(FULL({ lat: null, lng: null, raw: { stopExecutionInfo: { to: { plannedEtaDTTM: `${DAY}T08:30:00` } } } }), { nowMin: 9 * 60 + 40 });
  assert.equal(both.next.key, 'fix-pin');
  assert.equal(V(LIST(), { flags: [{ rule: 'hours_risk', tier: 'amber', stopNbr: '007185553', title: 'May miss receiving hours', fingerprint: 'f' }] }).next.key, 'load-order');
  // An appointment is confirmed ahead of the day — that is a job now.
  assert.equal(V(FULL(), { note: { appointment_required: true } }).next.tone, 'act');
  assert.equal(V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T10:00:00` })).next.tone, 'calm');
});

test('delivered: proof first — or the one call that loads it; a late delivery is a fact, not an alarm', () => {
  const pod = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T13:05:00`, podDocs: [{ documentName: 'POD.pdf' }, { documentName: 'a.jpg' }] }));
  assert.equal(pod.next.key, 'view-pod');
  assert.equal(pod.next.reason, 'Delivered at 1:05 PM · 2 documents on file.');
  assert.equal(pod.when.delivered, '1:05 PM');
  const none = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T13:05:00` }));
  assert.equal(none.next.key, 'load-pod');
  assert.match(none.next.reason, /1 NuVizz call/);
  const late = V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T15:20:00` }), { note: { receiving_hours: { mon: { open: '07:00', close: '15:00' } }, manual_overrides: { receiving_hours: true } } });
  assert.equal(late.alerts.find((a) => a.key === 'late-delivery').title, 'Delivered 20 min after receiving closed');
  assert.equal(late.alerts.find((a) => a.key === 'late-delivery').tier, 'info');
  // A delivered order raises no pin/address/closed blockers — the freight is gone.
  assert.equal(V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T13:05:00`, lat: null, lng: null })).alerts.some((a) => a.key === 'no-pin'), false);
});

test('an exception: a blocker with the activity as its fix', () => {
  const v = V(FULL({ normalizedStatus: 'EXCEPTION', status: '80' }));
  assert.equal(v.alerts[0].key, 'exception');
  assert.match(v.alerts[0].detail, /Unable to deliver \(code 80\)/);
  assert.equal(v.next.key, 'activity');
  assert.equal(v.timeline.variant, 'terminal');
});

test('message drafts use only verified facts and never send themselves', () => {
  const sched = orderMessageDrafts(V(FULL()));
  assert.deepEqual(sched.map((d) => d.key), ['scheduled', 'delay', 'call-me']);
  assert.equal(sched[0].text, 'Davis Delivery (PRO 007185553 — MOTOVARIO CORPORATION): your delivery is scheduled for Mon, Oct 5 between 8:00 AM and 2:00 PM. Reply here with any questions.');
  // A list row's load-wide estimate is not promised as a window.
  assert.doesNotMatch(orderMessageDrafts(V(LIST()))[0].text, /between/);
  const out = orderMessageDrafts(V(FULL({ normalizedStatus: 'OUT_FOR_DEL' })));
  assert.equal(out[0].key, 'on-the-way');
  assert.doesNotMatch(out[0].text, /estimated/, 'no ETA promised that NuVizz did not give');
  const del = orderMessageDrafts(V(FULL({ normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T13:05:00` })));
  assert.deepEqual(del.map((d) => d.text), ['Davis Delivery (PRO 007185553 — MOTOVARIO CORPORATION): your order was delivered at 1:05 PM on Mon, Oct 5.']);
  assert.deepEqual(orderMessageDrafts(null), []);
});

test('the model is pure: no NuVizz call, no Firestore, no clock of its own', () => {
  const src = readFileSync(new URL('../src/lib/order-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch\(|apiFetch|firebase|Date\.now\(\)|new Date\(\)/);
});
