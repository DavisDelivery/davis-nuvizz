// A ROUTE THAT HAS DELIVERED NOTHING IS STILL ON THE YARD.
//
// Chad, 2026-08-22: "once we get past eight AM, then for any route that has not had a
// delivery done on it, that route no longer needs to be assumed that it's leaving at eight.
// It needs to be assumed that it's leaving every minute after that. So if it's eight thirty,
// then that route needs to be assuming it's leaving at eight thirty."
//
// What the board did before: the departure clock was held on the 8:00a assumption for a full
// grace hour, and a route counted as "gone" the moment it carried OUT_FOR_DELIVERY — a status
// this board sets at dispatch, not at the gate. Measured over 14 sealed days (851 routes): at
// 8:30a, 545 routes had no delivery yet; 424 of them (78%) had genuinely not left and would
// not leave for a median of another 158 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, fmtMin, hasLeftYard } from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DATE = '2026-08-17', DAY = 'mon', DEG = 1 / 69.055;

const board = (firstStopOverride = {}) => [...Array(8)].map((_, i) => ({
  stopNbr: `S${i + 1}`, matchKey: `c${i + 1}`, businessName: `CUST ${i + 1}`, loadNbr: 'RT',
  routeSeq: i + 1, stopType: 'DL', lat: DEPOT.lat + (i + 1) * 3 * DEG, lng: DEPOT.lng,
  normalizedStatus: 'PLANNED', status: '10', driverName: 'DRV', driverUserName: 'd',
  ...(i === 0 ? firstStopOverride : {}),
}));
const notes = new Map([['c8', {
  manual_overrides: { receiving_hours: true },
  receiving_hours: { [DAY]: { open: '08:00', close: '14:00' } },
}]]);
const etaOf = (stops, nowMin, id = 'S1') => {
  const out = computeBoardFlags({ stops, notes, servedDate: DATE, dayKey: DAY, opts: { depot: DEPOT, nowMin } });
  const e = out.etaByStop.get(id);
  return e ? e.etaMin : null;
};

test('a route with nothing delivered is on the YARD at 8:30 — it did not leave at 8:00', () => {
  const at830 = etaOf(board(), 8 * 60 + 30);
  // Leaving the yard at 8:30 means arriving at stop 1 one first-leg later, NOT at 8:09
  // (which is what an 8:00 departure predicts) and not at 8:30 (which would mean the first
  // leg had already been driven).
  assert.ok(at830 > 8 * 60 + 30, `expected an arrival after 8:30, got ${fmtMin(at830)}`);
  const at800 = etaOf(board(), 8 * 60);
  assert.ok(at830 > at800, 'the 8:30 estimate must be later than the 8:00 one');
});

test('and the yard clock keeps moving with the wall clock, every minute after', () => {
  let prev = -Infinity;
  for (const now of [8 * 60, 8 * 60 + 15, 8 * 60 + 30, 9 * 60, 10 * 60, 11 * 60, 12 * 60]) {
    const eta = etaOf(board(), now);
    assert.ok(eta >= prev, `estimate went BACKWARDS at ${fmtMin(now)}: ${fmtMin(eta)} after ${fmtMin(prev)}`);
    prev = eta;
  }
});

test('OUT_FOR_DELIVERY alone does NOT take a route off the yard — this board sets it at dispatch', () => {
  const out40 = etaOf(board({ status: '40', normalizedStatus: 'OUT_FOR_DEL' }), 9 * 60);
  const plain = etaOf(board(), 9 * 60);
  assert.equal(out40, plain, 'a dispatch-time status must not buy a route an earlier clock');
  assert.equal(hasLeftYard({ status: '40', normalizedStatus: 'OUT_FOR_DEL' }), false);
});

test('an ARRIVED stamp DOES take it off the yard — a truck at the door has driven its first leg', () => {
  const arrived = etaOf(board({ status: '50', normalizedStatus: 'ARRIVED' }), 9 * 60);
  const plain = etaOf(board(), 9 * 60);
  assert.ok(arrived < plain, 'a truck standing at a customer must not have a first leg re-added');
  assert.equal(arrived, 9 * 60, 'it is at the stop now');
  assert.equal(hasLeftYard({ status: '50', normalizedStatus: 'ARRIVED' }), true);
});

test('a delivered stop takes it off the yard too', () => {
  assert.equal(hasLeftYard({ deliveredDTTM: `${DATE}T09:15`, status: '90' }), true);
  assert.equal(hasLeftYard({ arrivalDTTM: `${DATE}T09:15` }), true);
  assert.equal(hasLeftYard({ status: '10', normalizedStatus: 'PLANNED' }), false);
});

test('before the departure hour the assumption still stands — 7:00a does not drag a route earlier', () => {
  // At 7:00a nothing is clamped: the route is still expected to leave at its 8:00 departure.
  const at700 = etaOf(board(), 7 * 60);
  const at800 = etaOf(board(), 8 * 60);
  assert.equal(at700, at800, 'a pre-departure sweep must read the same as the departure hour');
});
