// test/cancelled-not-unplanned.test.mjs
//
// A CANCELLED order is not work waiting to be planned.
//
// Chad, pointing at seven orange pins that stayed on the routing map no matter how he filtered
// the grid: "they are marked as exceptions." PRO 007151447-2 (MICROSOFT ATL22, Fayetteville)
// was cancelled on Jul 23 — `Cancelled — STP_CL — Stop Cancellation` — and never assigned a
// route. statusFromCode hands a cancelled stop `planned: hasRoute`, so with no route it came
// out isPlanned:false → isUnplanned:TRUE. Consequences, all real:
//   • it survived "Unplanned only" while every delivered/scheduled stop was filtered out,
//     so 7 dead stops were the only thing on a 721-stop map;
//   • it was selectable — three of them were staged in the selection panel, one week-old
//     cancellation among them, ready to be built onto a truck;
//   • anywhere it lands in a board day's own doc it counts toward "unplanned in last scan".
//
// The invariant: `planned` may stay false (a route-less stop must not claim a route), but
// `isUnplanned` means STILL TO DO, and a terminal outcome is never still to do.
import test from 'node:test';
import assert from 'node:assert/strict';

import { statusFromCode, isTerminalStatus, toBoardStop } from '../netlify/functions/lib/nuvizz-list.mts';

// The list row as the saved search delivers it. statusCode is the only thing that varies here.
const row = (statusCode, over = {}) => ({
  stopNbr: '007151447-2', statusCode, businessName: 'MICROSOFT ATL22',
  addr1: '167 TYRONE RD BLDG 700', addr2: 'ATTN DOMINIC JACKSON', city: 'FAYETTEVILLE', zip: '30214',
  routeName: '', scheduledArrival: '7/23/26 10:00 AM', ...over,
});

test('isTerminalStatus: finished outcomes only', () => {
  for (const s of ['DELIVERED', 'EXCEPTION', 'CANCELLED', 'delivered', 'exception']) {
    assert.equal(isTerminalStatus(s), true, String(s));
  }
  for (const s of ['UNPLANNED', 'SCHEDULED', 'OUT_FOR_DEL', 'ARRIVED', '', null, undefined]) {
    assert.equal(isTerminalStatus(s), false, String(s));
  }
});

test('THE BUG: a cancelled stop with no route is no longer unplanned', () => {
  const s = toBoardStop(row('99'));
  assert.equal(s.normalizedStatus, 'EXCEPTION');
  assert.equal(s.isUnplanned, false, 'a week-old cancellation is not freight to plan');
  // `planned` is deliberately untouched: with no route it must not claim to be on one.
  assert.equal(s.isPlanned, false, 'and it must not claim a route it does not have');
  assert.equal(statusFromCode('99', false).planned, false, 'statusFromCode itself is unchanged');
});

test('a cancelled stop that IS on a route stays planned, as before', () => {
  const s = toBoardStop(row('99', { routeName: 'NOR' }));
  assert.equal(s.normalizedStatus, 'EXCEPTION');
  assert.equal(s.isPlanned, true);
  assert.equal(s.isUnplanned, false);
});

test('unable-to-deliver (80) is terminal too, routed or not', () => {
  for (const routeName of ['', 'NOR']) {
    const s = toBoardStop(row('80', { routeName }));
    assert.equal(s.normalizedStatus, 'EXCEPTION', `route=${routeName || 'none'}`);
    assert.equal(s.isUnplanned, false, `route=${routeName || 'none'}`);
  }
});

test('a genuinely unplanned order is UNTOUCHED — the fix must not hide real work', () => {
  const s = toBoardStop(row('10'));
  assert.equal(s.normalizedStatus, 'UNPLANNED');
  assert.equal(s.isUnplanned, true, 'status 10 with no route is exactly what the pool is for');
  assert.equal(s.isPlanned, false);
});

test('every non-terminal status keeps its old planned/unplanned answer', () => {
  // 20 Planned, 40 In-transit, 50 Arrived — all routed work, none of it "to plan".
  for (const [code, status] of [['20', 'SCHEDULED'], ['40', 'OUT_FOR_DEL'], ['50', 'ARRIVED']]) {
    const s = toBoardStop(row(code, { routeName: 'NOR' }));
    assert.equal(s.normalizedStatus, status, code);
    assert.equal(s.isPlanned, true, code);
    assert.equal(s.isUnplanned, false, code);
  }
  // A DELIVERED row was already excluded (planned:true) — confirm it stays excluded.
  const done = toBoardStop(row('90', { routeName: 'NOR' }));
  assert.equal(done.normalizedStatus, 'DELIVERED');
  assert.equal(done.isUnplanned, false);
});

test('an unrecognised status with no route is still treated as work (fail-open)', () => {
  // The default branch is the safety net for a code NuVizz adds later: better to show an
  // unknown order as plannable than to silently drop real freight off the board.
  const s = toBoardStop(row('77'));
  assert.equal(s.normalizedStatus, 'UNPLANNED');
  assert.equal(s.isUnplanned, true);
});

test('the unplanned COUNTER stops counting cancellations', () => {
  // This is the shape `unplannedCount` uses: stops.filter(s => s.isUnplanned).length.
  const stops = [
    toBoardStop(row('10', { stopNbr: 'A' })),                       // real work
    toBoardStop(row('99', { stopNbr: 'B' })),                       // cancelled, no route
    toBoardStop(row('80', { stopNbr: 'C' })),                       // unable to deliver
    toBoardStop(row('90', { stopNbr: 'D', routeName: 'NOR' })),     // delivered
    toBoardStop(row('20', { stopNbr: 'E', routeName: 'NOR' })),     // scheduled
  ];
  assert.equal(stops.filter((s) => s.isUnplanned).length, 1, 'only the genuinely unplanned one');
  assert.deepEqual(stops.filter((s) => s.isUnplanned).map((s) => s.stopNbr), ['A']);
});
