// A CANCELLED ORDER IS NOT A DELIVERY — the session audit's top finding.
//
// hasLeftYard's first draft delegated to isFinishedStop, whose question is "does the driver
// still owe this stop anything" — and by that test a cancelled order ('99', surfaced as
// EXCEPTION on a routed load) took its whole route off the yard, restored the 8:00
// departure, and quietly erased a red card 20 minutes past its close. Same for a stamp from
// another day: arrivalAnchor refuses those 180 lines up, for a reason its comment spells
// out, and the yard test now gives the same answer to the same fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, hasLeftYard } from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DATE = '2026-08-17', DAY = 'mon', DEG = 1 / 69.055;

test('a cancelled order does not take a route off the yard', () => {
  assert.equal(hasLeftYard({ status: '99' }, DATE), false);
  assert.equal(hasLeftYard({ normalizedStatus: 'EXCEPTION' }, DATE), false, 'a bare EXCEPTION is ambiguous — fail toward the yard');
});

test("yesterday's stamp does not either — the same refusal arrivalAnchor already makes", () => {
  assert.equal(hasLeftYard({ deliveredDTTM: '2026-08-16T15:00' }, DATE), false);
  assert.equal(hasLeftYard({ arrivalDTTM: '2026-08-16T15:00' }, DATE), false);
  assert.equal(hasLeftYard({ deliveredDTTM: `${DATE}T09:15` }, DATE), true, "today's delivery still counts");
});

test('an attempted delivery DOES — the driver stood at a door, that truck is not on the yard', () => {
  assert.equal(hasLeftYard({ status: '80' }, DATE), true);
});

const board = (firstOver = {}) => [...Array(8)].map((_, i) => ({
  stopNbr: `S${i + 1}`, matchKey: `c${i + 1}`, businessName: `CUST ${i + 1}`, loadNbr: 'RT',
  routeSeq: i + 1, stopType: 'DL', lat: DEPOT.lat + (i + 1) * 3 * DEG, lng: DEPOT.lng,
  normalizedStatus: 'PLANNED', status: '10', driverName: 'DRV', driverUserName: 'd',
  ...(i === 0 ? firstOver : {}),
}));
const notes = new Map([['c8', {
  manual_overrides: { receiving_hours: true },
  receiving_hours: { [DAY]: { open: '08:00', close: '14:00' } },
}]]);
const flagFor = (firstOver, nowMin) => {
  const out = computeBoardFlags({ stops: board(firstOver), notes, servedDate: DATE, dayKey: DAY, opts: { depot: DEPOT, nowMin } });
  return out.rows.find((r) => r.rule === 'hours_risk' && r.stopNbr === 'S8') || null;
};

test('the BOARD consequence: one cancelled stop no longer erases the red card the yard route raises', () => {
  const pure = flagFor({}, 14 * 60);
  assert.ok(pure, 'the yard route flags — this is the baseline');
  const withCancelled = flagFor({ status: '99', normalizedStatus: 'EXCEPTION' }, 14 * 60);
  assert.ok(withCancelled, 'a cancelled first stop must not silence the load');
  assert.equal(withCancelled.tier, pure.tier);
});

test("and a stop wearing yesterday's POD no longer restores the 8:00 departure", () => {
  const stale = flagFor({ deliveredDTTM: '2026-08-16T15:00', normalizedStatus: 'DELIVERED', status: '90' }, 14 * 60);
  assert.ok(stale, "yesterday's stamp says nothing about where this truck is now");
});

// THE SEAM: a driverless load that dispatch marked OUT_FOR_DELIVERY fell between the two
// rules — R5's clock said "on the yard" while R6's gate said "somebody is working it", so
// the noon threshold never ran and the load went completely silent.
test('a driverless load marked OUT_FOR_DELIVERY is no quieter than the same load marked PLANNED', () => {
  const mk = (status, normalized) => [...Array(4)].map((_, i) => ({
    stopNbr: `S${i + 1}`, matchKey: `c${i + 1}`, businessName: `CUST ${i + 1}`, loadNbr: 'NODRV',
    routeSeq: i + 1, stopType: 'DL', lat: DEPOT.lat + (i + 1) * 3 * DEG, lng: DEPOT.lng,
    normalizedStatus: normalized, status,
  }));
  const n2 = new Map([['c1', { manual_overrides: { receiving_hours: true }, receiving_hours: { [DAY]: { open: '08:00', close: '11:00' } } }]]);
  const run = (stops) => computeBoardFlags({ stops, notes: n2, servedDate: DATE, dayKey: DAY, opts: { depot: DEPOT, nowMin: 9 * 60 } })
    .rows.filter((r) => r.rule === 'no_driver_hours');
  const planned = run(mk('10', 'PLANNED'));
  const outForDel = run(mk('40', 'OUT_FOR_DEL'));
  assert.ok(planned.length, 'the driverless PLANNED load raises its card');
  assert.equal(outForDel.length, planned.length, 'dispatch paperwork must not silence the same card');
});
