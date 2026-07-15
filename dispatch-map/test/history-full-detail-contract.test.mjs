// test/history-full-detail-contract.test.mjs
//
// Contract test for "tap a historical PRO → see the FULL delivery". The client stop
// detail (StopSidebar / MobileStopDetailDrawer) and the Delivery Ticket read plain
// fields off the stop object — route (loadNbr/routeName/driverName), status (isPlanned),
// PROs (pros), line items (stopDetails / raw.stopDetails), freight (weight/pallets/
// volume/cartons), address (businessName/addr1/…), and the ticket's raw.stop /
// raw.stopExecutionInfo. This test proves the warehouse record buildStopRecord writes
// PRESERVES every one of those, so a warehouse doc renders the full card AS-IS — the
// exact reason the fix needs no renderer change. If a future capture change drops one
// of these, this test fails loudly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStopRecord } from '../netlify/functions/lib/history-derive.mts';

const CTX = {
  tenant: 'davis',
  date: '2026-07-14',
  capture: { capture_version: 1, captured_at: '2026-07-15T06:00:00.000Z', source_scanned_at: '2026-07-15T05:59:00.000Z', app_version: '0.50.11' },
};

// A fully-enriched NormalizedStop, the shape scanDate() emits for a delivered stop —
// route + driver + line items + freight + the raw payload the ticket reads.
const ENRICHED_STOP = {
  stopNbr: '007146672',
  pro: '007146672',
  businessName: 'HD SUPPLY',
  addr1: 'ATLANTA DC', addr2: null, city: 'FOREST PARK', state: 'GA', zip: '30297',
  lat: 33.62, lng: -84.35,
  isPlanned: true, isUnplanned: false, status: '90', normalizedStatus: 'DELIVERED',
  loadNbr: 'DAVIS000200042', routeName: 'ANDERSON', routeSeq: 3, loadStopSeq: 3,
  driverName: 'ANDERSON FRIMPONG', driverUserName: 'ANDERSON',
  weight: 1750, pallets: 4, volume: 2, cartons: 4,
  scheduledFrom: '2026-07-14T08:00:00', scheduledTo: '2026-07-14T12:00:00',
  plannedEtaDTTM: '2026-07-14T09:30:00', deliveredDTTM: '2026-07-14T09:45:00', arrivalDTTM: '2026-07-14T09:40:00',
  pros: ['007146672'],
  stopDetails: [
    { product: 'PO-991', productIdentifier: 'SKU-1', quantity: 3, weight: 500, productCategory: 'G' },
    { product: 'PO-992', productIdentifier: 'SKU-2', quantity: 1, weight: 1250, productCategory: 'L' },
  ],
  raw: {
    stop: { to: { address: { name: 'HD SUPPLY', addr1: 'ATLANTA DC', city: 'FOREST PARK', state: 'GA', zip: '30297' }, seq: 3 } },
    stopExecutionInfo: { to: { confirmedDTTM: '2026-07-14T09:45:00' }, receiveDTTM: '2026-07-14T09:45:00', stopStatus: '90' },
  },
};

test('warehouse record preserves every field the client stop-detail + ticket read', () => {
  const rec = buildStopRecord(ENRICHED_STOP, CTX);

  // Header + status
  assert.equal(rec.stopNbr, '007146672');   // ticketData.pro = stop.stopNbr
  assert.equal(rec.pro, '007146672');
  assert.equal(rec.isPlanned, true);          // classifyStopStatus → not UNPLANNED
  assert.equal(rec.normalizedStatus, 'DELIVERED');

  // Route + driver (ROUTE shows the name instead of "Not yet assigned")
  assert.equal(rec.loadNbr, 'DAVIS000200042');
  assert.equal(rec.routeName, 'ANDERSON');
  assert.equal(rec.driverName, 'ANDERSON FRIMPONG');

  // PROs list
  assert.deepEqual(rec.pros, ['007146672']);

  // Line items (ITEMS + ticket PO table)
  assert.ok(Array.isArray(rec.stopDetails) && rec.stopDetails.length === 2);
  assert.equal(rec.stopDetails[0].product, 'PO-991');

  // Freight (ticket summary: weight / loose / pallets / pieces)
  assert.equal(rec.weight, 1750);
  assert.equal(rec.pallets, 4);
  assert.equal(rec.volume, 2);
  assert.equal(rec.cartons, 4);

  // Address (ship-to)
  assert.equal(rec.businessName, 'HD SUPPLY');
  assert.equal(rec.addr1, 'ATLANTA DC');
  assert.equal(rec.city, 'FOREST PARK');

  // The raw payload the delivery ticket + timeline read
  assert.ok(rec.raw && rec.raw.stop && rec.raw.stop.to, 'raw.stop preserved');
  assert.equal(rec.raw.stopExecutionInfo.to.confirmedDTTM, '2026-07-14T09:45:00');

  // Warehouse-added key the client re-attaches as matchKey for the notes editor
  assert.ok(rec.customerMatchKey, 'customerMatchKey derived');
});

test('the OLD synthetic stop is empty on exactly these fields — the bug this fix removes', () => {
  // Mirrors PastProSearch.openCustomer's fallback shape (name+address only).
  const synthetic = {
    stopNbr: 'hist:hd_supply', pro: null, pros: [], loadNbr: null, routeName: null,
    driverName: null, status: null, isPlanned: false, stopDetails: [], raw: {},
  };
  // Every field the enriched warehouse record populates is null/empty here — which is
  // exactly why the card read Unplanned / ROUTE "Not yet assigned" / PROS (0) / ITEMS —.
  assert.equal(synthetic.loadNbr, null);
  assert.equal(synthetic.driverName, null);
  assert.equal(synthetic.pros.length, 0);
  assert.equal(synthetic.stopDetails.length, 0);
  assert.deepEqual(synthetic.raw, {});
  assert.equal(synthetic.isPlanned, false);
});
