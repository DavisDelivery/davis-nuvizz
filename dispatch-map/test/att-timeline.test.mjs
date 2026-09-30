// test/att-timeline.test.mjs — v1.99.6: the backfill's rule, "the driver it was assigned to on the day
// it should have delivered, not the driver that delivered it the next day late" (Chad, 2026-09-30).
//
// Fixtures are the real NuVizz timelines read in the five-stop test on 2026-09-30, trimmed to the
// events that decide the answer (order kept as NuVizz returned it — not chronological).
import test from 'node:test';
import assert from 'node:assert/strict';

import { dueDayDriver, eventStamp } from '../netlify/functions/lib/att-timeline.mts';

const D = 'DAVIS DELIVERY';
const ev = (dttm, name, user, company = D) => ({ dttm, name, user, company });

test('eventStamp: the portal\'s "M/D/YY h:mm AM" becomes a sortable stamp; noon and midnight are right', () => {
  assert.equal(eventStamp('9/25/26 12:43 PM'), '2026-09-25T12:43');
  assert.equal(eventStamp('9/25/26 12:10 AM'), '2026-09-25T00:10');
  assert.equal(eventStamp('9/25/26 05:58 PM'), '2026-09-25T17:58');
  assert.equal(eventStamp('10/1/2026 9:05 AM'), '2026-10-01T09:05');
  assert.equal(eventStamp(''), null);
  assert.equal(eventStamp(null), null);
  assert.equal(eventStamp('2026-09-25T12:43'), null);
});

test('007180345, due 9/23: Christopher Garrett had it — not Joe Gibbs, who redelivered it 9/24', () => {
  const events = [
    ev('9/24/26 10:07 AM', 'Stop Confirmation', 'Joe Gibbs'),
    ev('9/24/26 08:02 AM', 'Stop Dispatched', 'Joe Gibbs'),
    ev('9/23/26 09:21 PM', 'Stop Planned', 'Zach Johnston'),
    ev('9/23/26 05:30 PM', 'Stop Unplanned', 'Brandi  Bradberry'),
    ev('9/23/26 05:28 PM', 'Stop Updated', 'Brandi  Bradberry', 'ULINE'),
    ev('9/23/26 03:48 PM', 'Pickup Stop Depart', 'Christopher  Garrett'),
    ev('9/23/26 09:13 AM', 'Stop Dispatched', 'Christopher  Garrett'),
    ev('9/22/26 11:52 PM', 'Stop Planned', 'Zach Johnston'),
    ev('9/22/26 02:50 PM', 'Stop Created', 'Intg Uline', 'ULINE'),
  ];
  const a = dueDayDriver(events, '2026-09-23');
  assert.equal(a.driver, 'Christopher  Garrett');
  assert.equal(a.basis, 'dispatched');
  assert.equal(a.dispatchedAt, '2026-09-23T09:13');
  assert.equal(a.unplannedAt, '2026-09-23T17:30');
  assert.equal(a.atCustomer, false);
  assert.deepEqual(a.laterDrivers, ['Joe Gibbs']);
});

test('007181840, due 9/25: the 3–4 AM planning shuffle is not an assignment; Darvin Cepeda took it at 3:22 PM', () => {
  const events = [
    ev('9/28/26 06:18 AM', 'Stop Dispatched', 'Anthony Kostner'),
    ev('9/25/26 05:04 PM', 'Stop Unplanned', 'Brandi  Bradberry'),
    ev('9/25/26 03:22 PM', 'Stop Dispatched', 'Darvin  Cepeda'),
    ev('9/25/26 04:06 AM', 'Stop Unplanned', 'Zach Johnston'),
    ev('9/25/26 04:06 AM', 'Stop Planned', 'Zach Johnston'),
    ev('9/25/26 03:23 AM', 'Stop Unplanned', 'Zach Johnston'),
    ev('9/25/26 03:18 AM', 'Stop Planned', 'Zach Johnston'),
  ];
  const a = dueDayDriver(events, '2026-09-25');
  assert.equal(a.driver, 'Darvin  Cepeda');
  assert.equal(a.unplannedAt, '2026-09-25T17:04');
  assert.deepEqual(a.laterDrivers, ['Anthony Kostner']);
});

test('007181967, due 9/25: Chris Head reached the customer that day (4:18 PM) — atCustomer is true', () => {
  const events = [
    ev('9/25/26 05:59 PM', 'Stop Unplanned', 'Brandi  Bradberry'),
    ev('9/25/26 04:20 PM', 'Stop Departure', 'Chris Head'),
    ev('9/25/26 04:18 PM', 'Stop Arrival', 'Chris Head'),
    ev('9/25/26 12:43 PM', 'Stop Dispatched', 'Chris Head'),
    ev('9/28/26 01:54 PM', 'Stop Arrival', 'Chris Head'),
  ];
  const a = dueDayDriver(events, '2026-09-25');
  assert.equal(a.driver, 'Chris Head');
  assert.equal(a.atCustomer, true);
});

test('a re-dispatch AFTER customer service unplanned it is the next driver, not the one who had it', () => {
  const events = [
    ev('9/11/26 03:39 PM', 'Stop Dispatched', 'Trevarr Howard'),
    ev('9/11/26 06:07 PM', 'Stop Unplanned', 'Freddy Perez'),
    ev('9/11/26 07:30 PM', 'Stop Dispatched', 'Somebody Else'),
  ];
  assert.equal(dueDayDriver(events, '2026-09-11').driver, 'Trevarr Howard');
});

test('handed from one driver to another BEFORE it failed: the last one dispatched in the window had it', () => {
  const events = [
    ev('9/11/26 09:00 AM', 'Stop Dispatched', 'Tony Smith'),
    ev('9/11/26 11:00 AM', 'Stop Dispatched', 'Trevarr Howard'),
    ev('9/11/26 06:07 PM', 'Stop Unplanned', 'Freddy Perez'),
  ];
  assert.equal(dueDayDriver(events, '2026-09-11').driver, 'Trevarr Howard');
});

test('no dispatch that day: the last Davis driver event inside the window answers, and says so', () => {
  const events = [
    ev('9/11/26 03:39 PM', 'Pickup Stop Arrival', 'Trevarr Howard'),
    ev('9/11/26 06:07 PM', 'Stop Unplanned', 'Freddy Perez'),
  ];
  const a = dueDayDriver(events, '2026-09-11');
  assert.equal(a.driver, 'Trevarr Howard');
  assert.equal(a.basis, 'driver-event');
});

test('nothing but planning on the due day (a route never dispatched): no answer, none invented', () => {
  const events = [
    ev('9/29/26 01:00 AM', 'Stop Planned', 'Zach Johnston'),
    ev('9/29/26 05:00 PM', 'Stop Unplanned', 'Brandi  Bradberry'),
    ev('9/30/26 08:00 AM', 'Stop Dispatched', 'Vincent  Bonzo'),
  ];
  assert.equal(dueDayDriver(events, '2026-09-29'), null);
  assert.equal(dueDayDriver([], '2026-09-29'), null);
  assert.equal(dueDayDriver(null, '2026-09-29'), null);
});

test('a non-Davis user on a dispatch-shaped event is never the answer', () => {
  const events = [ev('9/25/26 12:00 PM', 'Stop Dispatched', 'Intg Uline', 'ULINE')];
  assert.equal(dueDayDriver(events, '2026-09-25'), null);
});

// ── the backfill's plan and write ────────────────────────────────────────────
import { backfillGroups, attributionPatch, originalOf } from '../netlify/functions/lib/att-timeline.mts';

test('backfill picks only rows with no driver and no earlier read; an original and its -1 copy are one lookup', () => {
  const days = [
    { date: '2026-09-11', items: [
      { stopNbr: '007174789', matched: false },
      { stopNbr: '007174789-1', matched: false },
      { stopNbr: '007174773', matched: true, originalDriverName: 'Tyrese  Griffin' },
      { stopNbr: '007174801', matched: false, timelineCheckedAt: '2026-09-30T16:00:00Z' },
    ] },
    { date: '2026-09-04', items: [{ stopNbr: '007172068-1', matched: false }] },
  ];
  assert.equal(originalOf('007174789-1'), '007174789');
  assert.deepEqual(backfillGroups(days), [
    { date: '2026-09-04', original: '007172068', rows: ['007172068-1'] },   // oldest day first
    { date: '2026-09-11', original: '007174789', rows: ['007174789', '007174789-1'] },
  ]);
  // recheck re-reads a row an earlier run already read (for a rule change), never a matched one.
  assert.equal(backfillGroups(days, { recheck: true }).length, 3);
});

test('the write names the driver and its source, and leaves route and load alone', () => {
  const answer = { driver: 'Darvin  Cepeda', basis: 'dispatched', dispatchedAt: '2026-09-25T15:22', atCustomer: false, unplannedAt: '2026-09-25T17:04', laterDrivers: ['Anthony Kostner'] };
  const p = attributionPatch(answer, 'stop', '2026-09-30T16:00:00Z');
  assert.equal(p.originalDriverName, 'Darvin  Cepeda');
  assert.equal(p.originalDriverKey, 'DARVIN_CEPEDA');
  assert.equal(p.matched, true);
  assert.equal(p.attributedFrom, 'timeline');
  assert.equal(p.timeline.atCustomer, false);
  assert.deepEqual(p.timeline.laterDrivers, ['Anthony Kostner']);
  assert.equal('routeName' in p, false);
  assert.equal('originalLoadNbr' in p, false);
});

test('no answer: the row is marked read (no second call ever) and stays unattributed', () => {
  const p = attributionPatch(null, 'original', '2026-09-30T16:00:00Z');
  assert.equal(p.timelineCheckedAt, '2026-09-30T16:00:00Z');
  assert.equal(p.timeline.answer, null);
  assert.equal('matched' in p, false);
  assert.equal('originalDriverName' in p, false);
});
