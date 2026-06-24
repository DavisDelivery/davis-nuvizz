// test/nuvizz-list.test.mjs — the list-discovery scan helpers (the primary board
// source). Guards status-code mapping, arrival-date parsing/bucketing, the row→board
// shape, and the geocode cache key. Pure functions only (no network).
import test from 'node:test';
import assert from 'node:assert/strict';

import { statusFromCode, parseSchedDate, toBoardStop, bucketByDate, fromRows, normalize, periodForDate, mergeEnrich } from '../netlify/functions/lib/nuvizz-list.mts';
import { addrKey } from '../netlify/functions/lib/geocode.mts';

test('statusFromCode: NuVizz codes → board status + planned flag', () => {
  assert.deepEqual(statusFromCode('10', false), { status: 'UNPLANNED', planned: false });
  assert.deepEqual(statusFromCode('20', true), { status: 'SCHEDULED', planned: true });
  assert.deepEqual(statusFromCode('40', true), { status: 'OUT_FOR_DEL', planned: true });
  assert.deepEqual(statusFromCode('50', true), { status: 'ARRIVED', planned: true });
  assert.deepEqual(statusFromCode('90', true), { status: 'DELIVERED', planned: true });
  assert.deepEqual(statusFromCode('91', true), { status: 'DELIVERED', planned: true });
  assert.equal(statusFromCode('99', true).status, 'EXCEPTION');
  // Unknown code falls back on route membership.
  assert.deepEqual(statusFromCode('', true), { status: 'SCHEDULED', planned: true });
  assert.deepEqual(statusFromCode('', false), { status: 'UNPLANNED', planned: false });
});

test('parseSchedDate: "M/D/YY h:mm AM" → date + ordered iso, null on junk', () => {
  assert.deepEqual(parseSchedDate('6/24/26 08:00 AM'), { date: '2026-06-24', iso: '2026-06-24T08:00:00' });
  assert.deepEqual(parseSchedDate('12/9/26 5:30 PM'), { date: '2026-12-09', iso: '2026-12-09T17:30:00' });
  assert.equal(parseSchedDate('12/9/26 12:00 AM').iso, '2026-12-09T00:00:00', 'midnight 12 AM → 00');
  assert.equal(parseSchedDate('12/9/26 12:00 PM').iso, '2026-12-09T12:00:00', 'noon 12 PM → 12');
  assert.equal(parseSchedDate(''), null);
  assert.equal(parseSchedDate('not a date'), null);
});

test('toBoardStop: planned stop carries load + ordering; unplanned has no load', () => {
  const planned = toBoardStop({ stopNbr: '007', statusCode: '20', routeName: 'TRAILER 1', driverName: 'DENIS', scheduledArrival: '6/24/26 09:00 AM', businessName: 'ACME', addr1: '1 Main', city: 'Buford', zip: '30518', cartons: 3, weight: 500, comments: 'liftgate', updatedTime: '6/24/26 04:37 AM' });
  assert.equal(planned.isPlanned, true);
  assert.equal(planned.loadNbr, 'TRAILER 1', 'route name doubles as the load id');
  assert.equal(planned.normalizedStatus, 'SCHEDULED');
  assert.equal(planned.plannedEtaDTTM, '2026-06-24T09:00:00', 'ordering key from scheduled arrival');
  assert.equal(planned.scheduledDate, '2026-06-24');
  assert.equal(planned.listUpdatedDTTM, '2026-06-24T04:37:00', 'free "last updated" from the list (parsed)');
  assert.equal(planned.deliveredDTTM, null, 'not delivered yet → no delivery time');
  // PRO == stop number, surfaced FREE from the list so every stop shows it without enrichment.
  assert.equal(planned.pro, '007');
  assert.deepEqual(planned.pros, ['007']);
  assert.equal(planned.primaryPro, '007');
  assert.equal(planned.lat, null, 'coords filled later by geocode/carry-forward');

  const unplanned = toBoardStop({ stopNbr: '008', statusCode: '10', routeName: '', scheduledArrival: '6/24/26 10:00 AM', businessName: 'BETA', addr1: '2 Oak', city: 'Buford', zip: '30518' });
  assert.equal(unplanned.isPlanned, false);
  assert.equal(unplanned.isUnplanned, true);
  assert.equal(unplanned.loadNbr, null);
});

test('toBoardStop: delivery time comes FREE from the list flip — deliveredDTTM = Stop Updated Dttm when DELIVERED', () => {
  // Status 90/91 (Completed) → the list update time IS the delivery flip time. No /stop/info.
  const delivered = toBoardStop({ stopNbr: '009', statusCode: '90', routeName: 'TRAILER 1', scheduledArrival: '6/24/26 09:00 AM', updatedTime: '6/24/26 02:15 PM' });
  assert.equal(delivered.normalizedStatus, 'DELIVERED');
  assert.equal(delivered.deliveredDTTM, '2026-06-24T14:15:00', 'delivery time taken from the list update at the delivered flip');
  assert.equal(delivered.deliveredDTTM, delivered.listUpdatedDTTM, 'same free signal — no extra call');

  // EXCEPTION/cancelled (99) is terminal but NOT a delivery → stays null (never counts on-time/late).
  const exception = toBoardStop({ stopNbr: '010', statusCode: '99', routeName: 'TRAILER 1', scheduledArrival: '6/24/26 09:00 AM', updatedTime: '6/24/26 03:00 PM' });
  assert.equal(exception.normalizedStatus, 'EXCEPTION');
  assert.equal(exception.deliveredDTTM, null, 'an exception is not a delivery');
});

test('fromRows: dedups by stopNbr (last wins) and drops blank stopNbr', () => {
  const rows = [
    { stopNbr: 'A', statusCode: '10', scheduledArrival: '6/24/26 09:00 AM' },
    { stopNbr: 'A', statusCode: '20', routeName: 'L1', scheduledArrival: '6/24/26 09:00 AM' }, // later wins
    { stopNbr: '', statusCode: '10' }, // dropped
  ];
  const out = fromRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].isPlanned, true, 'last row for stop A wins');
});

test('bucketByDate: groups board stops by scheduled delivery date', () => {
  const stops = [
    toBoardStop({ stopNbr: '1', statusCode: '10', scheduledArrival: '6/24/26 09:00 AM' }),
    toBoardStop({ stopNbr: '2', statusCode: '10', scheduledArrival: '6/24/26 14:00 PM' }),
    toBoardStop({ stopNbr: '3', statusCode: '10', scheduledArrival: '6/25/26 09:00 AM' }),
    toBoardStop({ stopNbr: '4', statusCode: '10', scheduledArrival: '' }), // no date → excluded
  ];
  const m = bucketByDate(stops);
  assert.equal(m.get('2026-06-24').length, 2);
  assert.equal(m.get('2026-06-25').length, 1);
  assert.ok(!m.has('undefined'));
});

test('normalize: maps the live VizzonStop response (filterData defs + values rows) by key', () => {
  const colOrder = [
    'KeyColumn', 'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.stopNbr',
    'vizzonInfo.createdTime', 'vizzonInfo.shipmentInfo.shipmentNbr', 'route.driver.driverId',
    'route.name', 'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
    'vizzonInfo.destination.address.line2', 'vizzonInfo.destination.address.city',
    'vizzonInfo.destination.address.zipCode', 'vizzonInfo.shipmentInfo.cartons',
    'vizzonInfo.shipmentInfo.weight', 'vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.proNbr',
    'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.shipmentInfo.stopUpdatedDttm', 'comments.commentList.commentText',
  ];
  const filterData = [Object.fromEntries(colOrder.map((k) => [k, { columnName: k }]))];
  const row = ['id1', '10', '{"columnValue":"007137806"}', '6/23/26 07:50 PM', '007137806', 'DENIS', 'TRAILER 1', 'ACME', '1 Main', '', 'Buford', '30518', '2', '400', 'Un-Planned', 'G6', '6/24/26 08:00 AM', '6/24/26 04:37 AM', 'note'];
  const [r] = normalize({ filterData, values: [row] });
  assert.equal(r.stopNbr, '007137806');
  assert.equal(r.statusCode, '10');
  assert.equal(r.routeName, 'TRAILER 1');
  assert.equal(r.scheduledArrival, '6/24/26 08:00 AM');
  assert.equal(r.updatedTime, '6/24/26 04:37 AM', 'Stop Updated Dttm discovered by pattern, ingested free');
});

test('normalize: updated-column detection prefers a stop-scoped column over an unrelated updatedBy', () => {
  // Two candidate columns: an unrelated route audit field and the real stop update time.
  const cols = ['KeyColumn', 'route.updatedOn', 'vizzonInfo.shipmentInfo.stopUpdatedDttm', 'vizzonInfo.shipmentInfo.stopNbr'];
  const filterData = [Object.fromEntries(cols.map((k) => [k, { columnName: k }]))];
  const row = ['id1', '1/1/26 01:00 AM', '6/24/26 04:37 AM', '007'];
  const [r] = normalize({ filterData, values: [row] });
  assert.equal(r.updatedTime, '6/24/26 04:37 AM', 'stop/shipment-scoped update column wins over route.updatedOn');

  // With ONLY a bare updated column, fall back to it rather than missing it.
  const cols2 = ['KeyColumn', 'order.lastUpdatedTime', 'vizzonInfo.shipmentInfo.stopNbr'];
  const fd2 = [Object.fromEntries(cols2.map((k) => [k, { columnName: k }]))];
  const [r2] = normalize({ filterData: fd2, values: [['id1', '6/24/26 05:00 AM', '008']] });
  assert.equal(r2.updatedTime, '6/24/26 05:00 AM', 'bare updated column used as fallback');
});

test('periodForDate: ET-adjusts the UTC doc date to NuVizz period (the tz-drift fix)', () => {
  // ET daytime: UTC date == ET date → today is "0d".
  assert.equal(periodForDate('2026-06-24', '2026-06-24'), '0d');
  // ET evening: UTC already rolled +1 while ET is still yesterday → todayUTC = "+1d".
  assert.equal(periodForDate('2026-06-24', '2026-06-23'), '+1d');
  // The next-day doc from that same evening → "+2d".
  assert.equal(periodForDate('2026-06-25', '2026-06-23'), '+2d');
  // A past doc → negative.
  assert.equal(periodForDate('2026-06-23', '2026-06-24'), '-1d');
});

test('mergeEnrich: adds static detail + enriched flag; never nukes list values with blanks', () => {
  // A list-sourced board stop (no detail yet).
  const s = toBoardStop({ stopNbr: '7', statusCode: '20', routeName: 'L1', scheduledArrival: '6/24/26 09:00 AM', businessName: 'ACME', lat: null });
  assert.equal(s.enriched, undefined);
  // Enrichment detail from /stop/info (normalized): real coords + line items + contact.
  mergeEnrich(s, { lat: 33.9, lng: -83.8, stopDetails: [{ sku: 'A' }], contact: { phone: '555' }, scheduledFrom: '2026-06-24T08:30:00', itemsSummary: '3 pallets', routeName: '', status: 'SHOULD_NOT_COPY' });
  assert.equal(s.enriched, true);
  assert.equal(s.lat, 33.9);
  assert.equal(s.lng, -83.8);
  assert.deepEqual(s.stopDetails, [{ sku: 'A' }]);
  assert.deepEqual(s.contact, { phone: '555' });
  assert.equal(s.scheduledFrom, '2026-06-24T08:30:00');
  assert.equal(s.itemsSummary, '3 pallets');
  // live fields (status/loadNbr) ARE in LIVE_LIST_FIELDS → list keeps owning them.
  assert.equal(s.status, '20');
  assert.equal(s.loadNbr, 'L1');
  // blank src values don't overwrite existing.
  const t = { lat: 1, lng: 2 };
  mergeEnrich(t, { lat: null, lng: undefined, stopDetails: [] });
  assert.equal(t.lat, 1); assert.equal(t.lng, 2); assert.ok(!('stopDetails' in t));
});

test('addrKey: stable + case/space-insensitive; null without a street address', () => {
  const a = addrKey({ addr1: '1 Main St', city: 'Buford', state: 'GA', zip: '30518' });
  const b = addrKey({ addr1: '  1 MAIN ST ', city: 'buford', state: 'ga', zip: '30518' });
  assert.equal(a, b, 'normalized identically');
  assert.equal(addrKey({ city: 'Buford', zip: '30518' }), null, 'no street → null (never geocode a bare city)');
  assert.equal(addrKey({ addr1: '' }), null);
});
