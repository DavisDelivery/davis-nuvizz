// test/r6-pickup-before-delivery.test.mjs — A2-S12-11.
//
// R6 (the "No driver" card) collapses a multi-order customer into ONE visit before it asks
// which stops carry a real receiving deadline. The collapse keyed on the customer alone, so a
// PICKUP at the same customer sequenced before the delivery claimed the visit key first — and a
// pickup has no receiving window (receivingWindow returns null for it), so it was then thrown
// away by the deadline filter, taking the delivery's slot with it. The route lost its red card.
//
// Chad's LVILLE case, with one change: a return pickup at LUND sits ahead of the LUND delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags } from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const OPTS = { depot: DEPOT, departMin: 8 * 60, nowMin: 9 * 60 + 24 };
const stop = (over = {}) => ({
  stopNbr: '1001', businessName: 'ACME', addr1: '1 Main', city: 'Buford',
  lat: 34.10, lng: -84.00, matchKey: 'acme|1 main|buford|30518',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'SUW', routeName: 'SUW', routeSeq: 1, stopType: 'DO', ...over,
});
const notesObj = { 'lund|k': { receiving_hours: { mon: { open: '06:00', close: '11:00' } } } };
const LVILLE = { loadNbr: 'LVILLE', routeName: 'LVILLE', driverName: null, driverUserName: null };
const run = (stops) => computeBoardFlags({
  stops, notes: new Map(Object.entries(notesObj)), servedDate: '2026-08-10', dayKey: 'mon', rosterRows: [], opts: OPTS,
});
const noDriverRows = (out) => out.rows.filter((r) => r.rule === 'no_driver_hours');

test('a driverless load still gets its No-driver card when a pickup at the same customer comes before the delivery', () => {
  const deliveryOnly = run([
    stop({ stopNbr: '1', routeSeq: 1, ...LVILLE }),
    stop({ stopNbr: '2', routeSeq: 2, ...LVILLE, matchKey: 'lund|k', businessName: 'LUND INTERNATIONAL' }),
  ]);
  const withPickupFirst = run([
    stop({ stopNbr: '1', routeSeq: 1, ...LVILLE }),
    stop({ stopNbr: 'RA9', routeSeq: 2, ...LVILLE, stopType: 'PU', matchKey: 'lund|k', businessName: 'LUND INTERNATIONAL' }),
    stop({ stopNbr: '2', routeSeq: 3, ...LVILLE, matchKey: 'lund|k', businessName: 'LUND INTERNATIONAL' }),
  ]);

  const base = noDriverRows(deliveryOnly);
  assert.equal(base.length, 1, 'baseline: the delivery-only route carries the No-driver card');

  const got = noDriverRows(withPickupFirst);
  assert.equal(got.length, 1, 'a return pickup ahead of the delivery must not swallow the card');
  assert.equal(got[0].tier, base[0].tier, 'same severity as without the pickup');
  assert.equal(got[0].stopNbr, '2', 'the card claims the DELIVERY, not the pickup');
  assert.equal(got[0].closeMin, 11 * 60, 'and quotes the delivery\'s 11:00a close');
});

test('the pickup itself never becomes the stop the No-driver card names', () => {
  // A route whose ONLY stop at the customer is a pickup has no receiving deadline to miss.
  const out = run([
    stop({ stopNbr: '1', routeSeq: 1, ...LVILLE }),
    stop({ stopNbr: 'RA9', routeSeq: 2, ...LVILLE, stopType: 'PU', matchKey: 'lund|k', businessName: 'LUND INTERNATIONAL' }),
  ]);
  assert.equal(noDriverRows(out).length, 0);
});
