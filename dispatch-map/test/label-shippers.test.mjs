// Labels by shipper and day — src/lib/label-shippers.js.
//
// Chad: "pick a shipper and a day like averitts or estes or shp and when all those orders come up
// for that day be able to print labels one by one for their orders or bulk print them".
// The shapes below are the ones production's own board carried on 2026-09-24.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shipperOf, shipperSummary, shipperLabelRows, filterLabelRows, compareStopNbr, isPickup, stopMatchKey,
} from '../src/lib/label-shippers.js';
import { labelOrderFromStop } from '../src/lib/order-labels.js';

const stop = (stopNbr, extra = {}) => ({
  stopNbr, pro: stopNbr, stopType: 'DO', businessName: `CONSIGNEE ${stopNbr}`,
  addr1: '100 MAIN ST', city: 'ATLANTA', state: 'GA', zip: '30318',
  cartons: 1, volume: 0, weight: 500, scheduledFrom: '2026-09-24T12:00:00',
  normalizedStatus: 'SCHEDULED', routeName: 'NOR 2', driverName: 'ENOCK AKYEA', ...extra,
});

test('the order number IS the shipper — every shape the board carried', () => {
  assert.deepEqual(shipperOf('ESTES-0538243875'), { key: 'ESTES', name: 'Estes' });
  assert.deepEqual(shipperOf('AVRT-0170416694'), { key: 'AVRT', name: 'Averitt' });
  assert.deepEqual(shipperOf('avrt-0170416694'), { key: 'AVRT', name: 'Averitt' }, 'case never splits a shipper');
  // Chad, Sep 24: "Shp is puremaxx".
  assert.deepEqual(shipperOf('SHP29379'), { key: 'SHP', name: 'Puremaxx' });
  assert.deepEqual(shipperOf('MCC4410'), { key: 'MCC', name: 'MCC' }, 'a prefix nobody named is shown as itself');
  assert.deepEqual(shipperOf('RA5732712'), { key: 'RA', name: 'RA' });
  assert.deepEqual(shipperOf('MILLER123'), { key: 'MILLER', name: 'MILLER' });
  assert.deepEqual(shipperOf('007163747'), { key: 'ULINE', name: 'Uline' });
  assert.deepEqual(shipperOf(' ESTES-0538243875 '), { key: 'ESTES', name: 'Estes' }, 'stray spaces never move an order to Other');
  assert.deepEqual(shipperOf('7163747'), { key: 'ULINE', name: 'Uline' }, 'a bare 7-digit Uline PRO');
  assert.deepEqual(shipperOf('007157687-1'), { key: 'ULINE', name: 'Uline' }, 'a segmented Uline piece row');
  // NOT CALLED AVERITT: no bare ten-digit number was on the board, so the code cannot vouch for it.
  assert.deepEqual(shipperOf('0259185096'), { key: 'OTHER', name: 'Other numbers' });
  assert.equal(shipperOf(''), null);
  assert.equal(shipperOf(null), null);
});

test('the summary lists the barcode-less shippers first, busiest first, then Uline — and counts the pickups it left out', () => {
  const board = [
    ...Array.from({ length: 3 }, (_, i) => stop(`ESTES-00000000${i}`)),
    stop('AVRT-0170416694'), stop('AVRT-0170416695'),
    stop('SHP29379'),
    ...Array.from({ length: 5 }, (_, i) => stop(`00716374${i}`)),
    stop('RA5732712', { stopType: 'PU' }), stop('RA5732713', { stopType: 'PU' }),
    stop('0259185096'),
    stop(''),
  ];
  const s = shipperSummary(board);
  assert.deepEqual(s.shippers.map((x) => `${x.key}:${x.orders}`), ['ESTES:3', 'AVRT:2', 'SHP:1', 'ULINE:5', 'OTHER:1']);
  assert.equal(s.pickups, 2, 'RA pickups are counted, not listed');
  assert.equal(s.noNumber, 1);
  assert.equal(s.deliveries, 12);
  assert.ok(!s.shippers.some((x) => x.key === 'RA'), 'a shipper whose every order is a pickup has nothing to label');
});

test('a row\'s label IS the stop card\'s label — board counts, the dispatcher\'s address fix, the saved reference', () => {
  const s = stop('ESTES-0538243875', { cartons: 2, volume: 1, weight: 1240, contact: { name: 'RAY', phone: '7705551212' } });
  const key = stopMatchKey(s);
  const note = { address_override: { addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336' } };
  const saved = { stopNbr: 'ESTES-0538243875', ref: 'EST-PO-77', dispatchNotes: 'Call ahead', origin: { name: 'DAVIS', addr1: '943 GAINESVILLE HWY' }, pallets: '9', loose: '9' };
  const rows = shipperLabelRows([s, stop('AVRT-1')], 'ESTES', { saved: new Map([['ESTES-0538243875', saved]]), notes: new Map([[key, note]]) });
  assert.equal(rows.length, 1, 'only the chosen shipper');
  const [r] = rows;
  // Byte-for-byte what the stop card's Label button builds from the same inputs.
  assert.deepEqual(r.label, labelOrderFromStop(s, { saved, addressOverride: note.address_override, phone: '7705551212' }));
  assert.equal(r.label.addr1, '4200 WENDELL DR SW', 'the address fix is what prints');
  assert.equal(r.label.ref, 'EST-PO-77', 'the saved reference fills in');
  assert.equal(r.label.pallets, '2', 'but the BOARD\'s count wins — it is what the load-out app caps at');
  assert.equal(r.pages, 3, '2 skids + 1 loose = 3 pages');
  assert.equal(r.skids, 2);
  assert.equal(r.loose, 1);
  assert.equal(r.fromSaved, true);
  assert.equal(r.addressFixed, true);
  assert.equal(r.countMissing, false);
});

test('an order with no count still prints ONE page, and the row says the count is missing', () => {
  const rows = shipperLabelRows([stop('AVRT-0170416694', { cartons: null, volume: null })], 'AVRT');
  assert.equal(rows[0].pages, 1);
  assert.equal(rows[0].countMissing, true);
});

test('pickups never become labels, even when their prefix is picked', () => {
  const rows = shipperLabelRows([stop('RA5732712', { stopType: 'PU' }), stop('RA5732799')], 'RA');
  assert.deepEqual(rows.map((r) => r.stopNbr), ['RA5732799']);
  assert.equal(isPickup({ stopType: 'pu' }), true);
});

test('rows run in natural number order — SHP9 before SHP10', () => {
  const rows = shipperLabelRows([stop('SHP10'), stop('SHP9'), stop('SHP100')], 'SHP');
  assert.deepEqual(rows.map((r) => r.stopNbr), ['SHP9', 'SHP10', 'SHP100']);
  assert.ok(compareStopNbr('ESTES-0538243875', 'ESTES-1000000001') < 0);
});

test('the filter finds an order by the number on the pallet, the name, or the city', () => {
  const rows = shipperLabelRows([
    stop('ESTES-0538243875', { businessName: 'JOHN SMITH', city: 'MARIETTA' }),
    stop('ESTES-0538240000', { businessName: 'LED ENERGY PLUS', city: 'ATLANTA' }),
  ], 'ESTES');
  assert.deepEqual(filterLabelRows(rows, '0538243875').map((r) => r.stopNbr), ['ESTES-0538243875'], 'the carrier PRO without its prefix');
  assert.deepEqual(filterLabelRows(rows, 'led energy').map((r) => r.stopNbr), ['ESTES-0538240000'], 'spaces and case ignored');
  assert.deepEqual(filterLabelRows(rows, 'marietta').map((r) => r.stopNbr), ['ESTES-0538243875']);
  assert.equal(filterLabelRows(rows, '   ').length, 2, 'an empty filter keeps everything');
});
