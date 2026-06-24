// test/nuvizz-list.test.mjs — the list-discovery scan helpers (the primary board
// source). Guards status-code mapping, arrival-date parsing/bucketing, the row→board
// shape, and the geocode cache key. Pure functions only (no network).
import test from 'node:test';
import assert from 'node:assert/strict';

import { statusFromCode, parseSchedDate, parseReqDate, toBoardStop, bucketByDate, fromRows, normalize, periodForDate, mergeEnrich, mergeTwoScan, etDateForTargetUTC, SAVED_SEARCHES } from '../netlify/functions/lib/nuvizz-list.mts';
import { addrKey } from '../netlify/functions/lib/geocode.mts';

test('statusFromCode: NuVizz codes → board status + planned flag', () => {
  assert.deepEqual(statusFromCode('10', false), { status: 'UNPLANNED', planned: false });
  assert.deepEqual(statusFromCode('20', true), { status: 'SCHEDULED', planned: true });
  assert.deepEqual(statusFromCode('40', true), { status: 'OUT_FOR_DEL', planned: true });
  assert.deepEqual(statusFromCode('50', true), { status: 'ARRIVED', planned: true });
  assert.deepEqual(statusFromCode('90', true), { status: 'DELIVERED', planned: true });
  assert.deepEqual(statusFromCode('91', true), { status: 'DELIVERED', planned: true });
  // 80 = "Unable to deliver" — finished but NOT a delivery → EXCEPTION (matches nuvizz-scan).
  assert.deepEqual(statusFromCode('80', true), { status: 'EXCEPTION', planned: true });
  assert.equal(statusFromCode('99', true).status, 'EXCEPTION');
  // Unknown code falls back on route membership.
  assert.deepEqual(statusFromCode('', true), { status: 'SCHEDULED', planned: true });
  assert.deepEqual(statusFromCode('', false), { status: 'UNPLANNED', planned: false });
});

test('SAVED_SEARCHES: active + completed map to the portal saved searches (HAR-captured)', () => {
  // ACTIVE = "Dispatch Map Planned Unplanned": status 20,10 + Estimated Arrival +/-7d (seq 10).
  assert.equal(SAVED_SEARCHES.active.customListDefId, 77128);
  const a = Object.fromEntries(SAVED_SEARCHES.active.filterList.map((f) => [f.sequence, f.value]));
  assert.equal(a[2], '20,10');
  assert.equal(a[10], JSON.stringify({ period: '+/-7d' }));
  assert.equal(SAVED_SEARCHES.active.filterList.length, 12, 'active def has 12 sequences');
  // COMPLETED = "Dispatch Map Completed": status 90,91,80 + arrival +/-7d (seq 10) + updated today (seq 11).
  assert.equal(SAVED_SEARCHES.completed.customListDefId, 77131);
  const c = Object.fromEntries(SAVED_SEARCHES.completed.filterList.map((f) => [f.sequence, f.value]));
  assert.equal(c[2], '90,91,80');
  assert.equal(c[10], JSON.stringify({ period: '+/-7d' }));
  assert.equal(c[11], JSON.stringify({ period: '0d' }), 'Stop Detail Updated = today');
  assert.equal(SAVED_SEARCHES.completed.filterList.length, 11, 'completed def has 11 sequences');
});

test('mergeTwoScan: completed wins over active per stop; buckets by scheduled date', () => {
  const active = [
    { stopNbr: 'A', statusCode: '20', routeName: 'L1', scheduledArrival: '6/24/26 09:00 AM' },
    { stopNbr: 'B', statusCode: '10', scheduledArrival: '6/25/26 09:00 AM' },
  ];
  const completed = [
    // A flipped to delivered — it left the active search and reappears here; completed wins.
    { stopNbr: 'A', statusCode: '90', routeName: 'L1', scheduledArrival: '6/24/26 09:00 AM', updatedTime: '6/24/26 02:00 PM' },
    // C = an unable-to-deliver (80) finished today, scheduled for the 24th.
    { stopNbr: 'C', statusCode: '80', routeName: 'L1', scheduledArrival: '6/24/26 11:00 AM', updatedTime: '6/24/26 03:00 PM' },
  ];
  const m = mergeTwoScan(active, completed);
  const d24 = m.get('2026-06-24');
  const d25 = m.get('2026-06-25');
  assert.equal(d24.length, 2, 'A (delivered) + C (exception) on the 24th');
  assert.equal(d25.length, 1, 'B still open on the 25th');
  const A = d24.find((s) => s.stopNbr === 'A');
  assert.equal(A.normalizedStatus, 'DELIVERED', 'completed pull overrides the active version');
  assert.equal(A.deliveredDTTM, '2026-06-24T14:00:00');
  const C = d24.find((s) => s.stopNbr === 'C');
  assert.equal(C.normalizedStatus, 'EXCEPTION', '80 = unable to deliver');
  assert.equal(C.deliveredDTTM, null, 'an unable-to-deliver is not a delivery');
});

test('etDateForTargetUTC: maps a UTC board key to its ET-equivalent bucket date', () => {
  // ET daytime: UTC == ET → same date.
  assert.equal(etDateForTargetUTC('2026-06-24', '2026-06-24', '2026-06-24'), '2026-06-24');
  // ET evening: UTC already rolled +1 (today=todayUTC ahead of etToday) → today maps back to etToday.
  assert.equal(etDateForTargetUTC('2026-06-24', '2026-06-24', '2026-06-23'), '2026-06-23');
  // The next UTC board from that same evening maps to ET "today".
  assert.equal(etDateForTargetUTC('2026-06-25', '2026-06-24', '2026-06-23'), '2026-06-24');
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

test('parseReqDate: lenient — date-only, time, window, or ISO all yield the day; null on junk', () => {
  assert.equal(parseReqDate('6/24/26'), '2026-06-24', 'date only');
  assert.equal(parseReqDate('6/24/26 08:00 AM'), '2026-06-24', 'date + time');
  assert.equal(parseReqDate('6/24/26 08:00 AM - 08:00 PM'), '2026-06-24', 'requested window → leading day');
  assert.equal(parseReqDate('2026-06-24T08:00:00'), '2026-06-24', 'ISO');
  assert.equal(parseReqDate(''), null);
  assert.equal(parseReqDate('n/a'), null);
});

test('toBoardStop: boardDate = Estimated Arrival, falling back to Requested Date when blank', () => {
  // Arrival present → it's the intended board day; requested is only a fallback.
  const both = toBoardStop({ stopNbr: 'X', statusCode: '20', routeName: 'L1', requestedArrival: '6/26/26', scheduledArrival: '6/24/26 09:00 AM' });
  assert.equal(both.boardDate, '2026-06-24', 'arrival is the intended day');
  assert.equal(both.requestedDate, '2026-06-26');
  // Arrival blank → fall back to Requested Date so the stop still has a day to sit on.
  const noArrival = toBoardStop({ stopNbr: 'Y', statusCode: '20', routeName: 'L1', requestedArrival: '6/24/26 08:00 AM - 08:00 PM', scheduledArrival: '' });
  assert.equal(noArrival.scheduledDate, null, 'no estimated arrival');
  assert.equal(noArrival.boardDate, '2026-06-24', 'requested date fills in when arrival is blank');
  // Neither → no intended day (bucketByDate decides whether to clamp it to today by route).
  const neither = toBoardStop({ stopNbr: 'Z', statusCode: '20', routeName: 'L1' });
  assert.equal(neither.boardDate, null);
});

test('bucketByDate: open route-assigned stops never bucket before today (the rollover fix)', () => {
  const today = '2026-06-24';
  const stops = [
    // Rollover: planned on a route but carrying YESTERDAY's stale arrival → clamped to today.
    toBoardStop({ stopNbr: '372', statusCode: '20', routeName: 'MITCHELL', scheduledArrival: '6/23/26 08:00 AM' }),
    // Normal: planned for today → stays today.
    toBoardStop({ stopNbr: '953', statusCode: '20', routeName: 'MITCHELL', scheduledArrival: '6/24/26 08:00 AM' }),
    // On a route but NO date at all → still surfaced on today, not dropped.
    toBoardStop({ stopNbr: 'ND', statusCode: '20', routeName: 'MITCHELL' }),
    // Future planned (tomorrow's pre-built load) → NOT clamped, stays on its day.
    toBoardStop({ stopNbr: 'FUT', statusCode: '20', routeName: 'MITCHELL', scheduledArrival: '6/25/26 08:00 AM' }),
    // Delivered yesterday → keeps its real day so history/analytics stay accurate.
    toBoardStop({ stopNbr: 'DEL', statusCode: '90', routeName: 'MITCHELL', scheduledArrival: '6/23/26 08:00 AM', updatedTime: '6/23/26 02:00 PM' }),
    // Open but NOT on a route (unplanned, unrouted) with a stale arrival → left where it is.
    toBoardStop({ stopNbr: 'UNR', statusCode: '10', scheduledArrival: '6/23/26 08:00 AM' }),
  ];
  const m = bucketByDate(stops, today);
  assert.deepEqual((m.get('2026-06-24') || []).map((s) => s.stopNbr).sort(), ['372', '953', 'ND'], 'rollover + today + no-date route stops all land on today');
  assert.deepEqual((m.get('2026-06-25') || []).map((s) => s.stopNbr), ['FUT'], 'future load untouched');
  assert.deepEqual((m.get('2026-06-23') || []).map((s) => s.stopNbr).sort(), ['DEL', 'UNR'], 'finished + unrouted keep their real day');
  assert.ok(!m.has('undefined'));
});

test('normalize: discovers the Requested Date column by pattern (key varies by saved def)', () => {
  const cols = ['KeyColumn', 'vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.destination.requestedDttm', 'vizzonInfo.destination.earliestSchTime'];
  const filterData = [Object.fromEntries(cols.map((k) => [k, { columnName: k }]))];
  const [r] = normalize({ filterData, values: [['id1', '007137950', '6/24/26 08:00 AM', '']] });
  assert.equal(r.requestedArrival, '6/24/26 08:00 AM', 'requested column ingested by pattern');
  assert.equal(r.scheduledArrival, '', 'arrival empty for this stop');
  // No requested column present → requestedArrival is blank, board falls back to arrival.
  const cols2 = ['KeyColumn', 'vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.destination.earliestSchTime'];
  const fd2 = [Object.fromEntries(cols2.map((k) => [k, { columnName: k }]))];
  const [r2] = normalize({ filterData: fd2, values: [['id1', '007', '6/24/26 09:00 AM']] });
  assert.equal(r2.requestedArrival, '', 'no requested column → blank, safe fallback');
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

test('normalize: unwraps "link object" columns (load, driver, PRO) — no raw JSON leaks to the board', () => {
  // NuVizz wraps several text columns as {"colmnLinkId":..,"columnValue":".."} strings.
  const cols = [
    'KeyColumn', 'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.stopNbr',
    'route.driver.driverId', 'route.name', 'vizzonInfo.shipmentInfo.proNbr',
    'vizzonInfo.destination.earliestSchTime',
  ];
  const filterData = [Object.fromEntries(cols.map((k) => [k, { columnName: k }]))];
  const row = [
    'id1', '20', '{"colmnLinkId":"abc","columnValue":"007137480"}',
    '{"colmnLinkId":"105292","columnValue":"DENIS"}',
    '{"colmnLinkId":"6a340f6c58e3","columnValue":"TRAILER 1"}',
    '{"colmnLinkId":"xyz","columnValue":"G6"}',
    '6/24/26 08:00 AM',
  ];
  const [r] = normalize({ filterData, values: [row] });
  assert.equal(r.stopNbr, '007137480');
  assert.equal(r.driverName, 'DENIS', 'driver unwrapped from link object');
  assert.equal(r.routeName, 'TRAILER 1', 'load/route name unwrapped from link object');
  assert.equal(r.proNbr, 'G6', 'PRO unwrapped from link object');
  // And the board stop carries clean values (loadNbr doubles as the load name).
  const b = toBoardStop(r);
  assert.equal(b.loadNbr, 'TRAILER 1');
  assert.equal(b.driverName, 'DENIS');
  assert.equal(b.proNbr, 'G6');
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
