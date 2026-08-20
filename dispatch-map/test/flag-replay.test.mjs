// WOULD THE FLAG HAVE CAUGHT IT? — tests for the sealed-history replay.
//
// The replay grades our own alerting, so the thing these tests defend is honesty about
// TIME: the engine must never see a stamp before the truck made it, a warning that arrived
// after the window shut must never be counted as a catch, and a day with nothing gradable
// must read "unmeasurable", never "perfect". The engine itself is imported real, not
// mocked — a replay graded against a copy grades the wrong thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskStopAsOf, sweepGrid, replayDay, judgeDay, summarizeReplay, blindReason,
} from '../netlify/functions/lib/flag-replay-core.mts';
import { isFinishedStop } from '../src/lib/board-flags.js';
import { stopCustomerKey } from '../netlify/functions/lib/customer-key.mts';

const DATE = '2026-08-13'; // a Thursday
const DAYKEY = 'thu';
const DEPOT = { lat: 34.147791, lng: -83.960911 };

// A stop the real engine will judge: sequenced delivery with a position. Distances are
// spread ~0.09° apart (~6 mi) so the walk accumulates real travel minutes.
function mkStop(n, over = {}) {
  return {
    stopNbr: `9000${n}`, stopType: 'DL', loadNbr: 'TEST 1', routeName: 'TEST 1',
    businessName: `CUSTOMER ${n}`, addr1: `${n} MAIN ST`, city: 'BUFORD', zip: '30518',
    routeSeq: n, driverName: 'TEST DRIVER', lat: 34.147791 + n * 0.09, lng: -83.960911,
    ...over,
  };
}
const noteTyped = (close, open = null) => ({
  receiving_hours: { [DAYKEY]: { ...(open ? { open } : {}), close } },
  manual_overrides: { receiving_hours: true },
});
const keyed = (stops) => stops.map((s) => ({ ...s, matchKey: stopCustomerKey(s) }));

// ── the as-of mask ────────────────────────────────────────────────────────────

test('a stamp from later in the day does not exist yet — and the status cannot leak it', () => {
  const s = mkStop(1, { deliveredDTTM: `${DATE}T10:30`, normalizedStatus: 'DELIVERED', status: '90' });
  const at1020 = maskStopAsOf(s, DATE, 10 * 60 + 20);
  assert.equal(at1020.deliveredDTTM, undefined, 'stamp hidden before it happened');
  assert.equal(isFinishedStop(at1020), false, 'terminal status must not leak the future');
  const at1040 = maskStopAsOf(s, DATE, 10 * 60 + 40);
  assert.equal(at1040.deliveredDTTM, `${DATE}T10:30`, 'stamp visible once it happened');
  assert.equal(isFinishedStop(at1040), true);
});

test('an arrival stamp alone reads ARRIVED, not finished', () => {
  const s = mkStop(1, { arrivalDTTM: `${DATE}T09:00`, normalizedStatus: 'OUT_FOR_DEL', status: '40' });
  const m = maskStopAsOf(s, DATE, 9 * 60 + 30);
  assert.equal(m.arrivalDTTM, `${DATE}T09:00`);
  assert.equal(m.normalizedStatus, 'ARRIVED');
  assert.equal(isFinishedStop(m), false);
});

test('a stamp from a FUTURE day is masked; a prior-day stamp is kept; unparseable same-day is masked', () => {
  const future = maskStopAsOf(mkStop(1, { deliveredDTTM: '2026-08-14T06:00', status: '90' }), DATE, 1400);
  assert.equal(future.deliveredDTTM, undefined, 'tomorrow has not happened at any time today');
  const prior = maskStopAsOf(mkStop(1, { arrivalDTTM: '2026-08-12T15:00' }), DATE, 420);
  assert.equal(prior.arrivalDTTM, '2026-08-12T15:00', 'yesterday already existed');
  const garbled = maskStopAsOf(mkStop(1, { deliveredDTTM: `${DATE}Tnoon`, status: '90' }), DATE, 1400);
  assert.equal(garbled.deliveredDTTM, undefined, '"we cannot tell when" must not become "always knew"');
});

test('an EXCEPTION with no stamp reads as an open stop all day', () => {
  const m = maskStopAsOf(mkStop(1, { normalizedStatus: 'EXCEPTION', status: '80' }), DATE, 1000);
  assert.equal(isFinishedStop(m), false);
});

// ── the replay + the verdicts, through the REAL engine ───────────────────────

test('a stop that delivered after a typed close is CAUGHT before the close, with positive lead', () => {
  // 20 sequenced stops; stop 19 closes at 11:00a. 18 stops of service ahead of it alone
  // blows past the close from an 8:00a departure — Chad's exact example.
  const stops = keyed(Array.from({ length: 20 }, (_, i) => mkStop(i + 1)));
  stops[18].deliveredDTTM = `${DATE}T14:07`; // actually delivered 3h past close
  const notes = new Map([[stopCustomerKey(stops[18]), noteTyped('11:00')]]);

  const grid = sweepGrid(420, 1180, 20);
  const { trajectories } = replayDay({ stops, notes, date: DATE, grid, depot: DEPOT });
  const { rows } = judgeDay({ stops, notes, date: DATE, trajectories });

  assert.equal(rows.length, 1, 'only the stop with hours and a stamp is gradable');
  const r = rows[0];
  assert.equal(r.missed, true);
  assert.equal(r.verdict, 'missed_caught');
  assert.ok(r.firstRedMin === 420, 'typed hours + projected overrun: email-eligible from the first 7:00a sweep');
  assert.ok(r.leadMin > 0 && r.leadMin === 11 * 60 - r.firstRedMin, 'lead measured to the close');
});

test('a warning that could only fire after the close is never a catch', () => {
  const stops = keyed(Array.from({ length: 20 }, (_, i) => mkStop(i + 1)));
  stops[18].deliveredDTTM = `${DATE}T14:07`;
  const notes = new Map([[stopCustomerKey(stops[18]), noteTyped('11:00')]]);

  // Sweeps only exist from 1:00p — the close passed unswept. selectAlertable refuses
  // nowMin past the close, so no sweep is email-eligible; the flag row itself still shows.
  const grid = sweepGrid(780, 1180, 20);
  const { trajectories } = replayDay({ stops, notes, date: DATE, grid, depot: DEPOT });
  const { rows } = judgeDay({ stops, notes, date: DATE, trajectories });
  assert.equal(rows[0].verdict, 'missed_flag_after_close');
  assert.equal(rows[0].leadMin, null);
});

test('a DRIVERLESS route that cannot make its close is CAUGHT — R6 supersedes and emails', () => {
  // Production behavior, pinned so the replay counts it honestly. Two things this test used
  // to get wrong, in opposite directions:
  //
  //   • It asserted the alert path emails hours_risk ONLY. It has not, since no_driver_hours
  //     started carrying a stop and a close — so the replay scored this "screen-only" while
  //     production sent the email. The backtest was marking its own successes as misses.
  //   • The route is driverless, so it now walks on the noon clock: a typed 11:00a close is
  //     unreachable before the truck could leave the yard, which is arithmetic rather than an
  //     estimate — the loudest tier, and it is right to be.
  //
  // At 9:00a there are two hours left to put a driver on this load. That is the whole value
  // of the warning, and 120 minutes of lead is what it is worth.
  const stops = keyed(Array.from({ length: 20 }, (_, i) => mkStop(i + 1, { driverName: '' })));
  stops[18].deliveredDTTM = `${DATE}T14:07`;
  const notes = new Map([[stopCustomerKey(stops[18]), noteTyped('11:00')]]);
  const grid = sweepGrid(540, 1180, 20); // from 9:00a: past departure, no rolling evidence
  const { trajectories } = replayDay({ stops, notes, date: DATE, grid, depot: DEPOT });
  const { rows } = judgeDay({ stops, notes, date: DATE, trajectories });
  assert.equal(rows[0].missed, true);
  assert.equal(rows[0].verdict, 'missed_caught', 'a driverless load nobody can save by 11:00a must reach the inbox');
  assert.equal(rows[0].firstRedMin, 540, 'the first sweep past departure already knows');
  assert.equal(rows[0].leadMin, 120);
});

test('a stop that MADE its window but was email-eligible is a false alarm, never a catch', () => {
  // One nearby stop, tight typed close: the pure 8:00a projection with per-stop service
  // predicts past 8:20a, so it goes red — but the truck actually made it.
  const stops = keyed([mkStop(1), mkStop(2), mkStop(3)]);
  stops[2].deliveredDTTM = `${DATE}T09:55`;
  const notes = new Map([[stopCustomerKey(stops[2]), noteTyped('10:00')]]);
  const grid = sweepGrid(420, 1180, 20);
  const { trajectories } = replayDay({ stops, notes, date: DATE, grid, depot: DEPOT });
  const { rows } = judgeDay({ stops, notes, date: DATE, trajectories });
  const r = rows[0];
  assert.equal(r.missed, false);
  if (r.firstRedMin != null) assert.equal(r.verdict, 'made_flagged');
  else assert.ok(['made_screen_only', 'made_quiet'].includes(r.verdict));
});

test('a late delivery on an unjudgeable route is BLIND, with the reason named', () => {
  // No sequence anywhere on the route → the engine refuses to judge it (an invented
  // order produces confident wrong answers) → the miss must surface as blind, not vanish.
  const stops = keyed([mkStop(1, { routeSeq: undefined }), mkStop(2, { routeSeq: undefined })]);
  stops[1].deliveredDTTM = `${DATE}T15:00`;
  const notes = new Map([[stopCustomerKey(stops[1]), noteTyped('11:00')]]);
  const grid = sweepGrid(420, 1180, 20);
  const { trajectories } = replayDay({ stops, notes, date: DATE, grid, depot: DEPOT });
  const { rows } = judgeDay({ stops, notes, date: DATE, trajectories });
  assert.equal(rows[0].verdict, 'missed_blind');
  assert.equal(rows[0].blindReason, 'no_sequence');
});

test('ungradable stops are counted by reason, never guessed', () => {
  const noStamp = mkStop(1);                                  // hours on file, never stamped
  const noHours = mkStop(2, { deliveredDTTM: `${DATE}T12:00` }); // stamped, no hours anywhere
  const stops = keyed([noStamp, noHours]);
  const notes = new Map([[stopCustomerKey(noStamp), noteTyped('11:00')]]);
  const { rows, ungradable } = judgeDay({ stops, notes, date: DATE, trajectories: new Map() });
  assert.equal(rows.length, 0);
  assert.equal(ungradable.no_arrival_stamp, 1);
  assert.equal(ungradable.no_receiving_hours_on_file, 1);
});

test('summarize: rates are null when nothing is gradable — unmeasurable never reads perfect', () => {
  const s = summarizeReplay([]);
  assert.equal(s.gradable, 0);
  assert.equal(s.recallPct, null);
  assert.equal(s.emailPrecisionPct, null);
  assert.equal(s.leadMedianMin, null);
});

test('blindReason names the unplanned-carryover shape', () => {
  assert.equal(blindReason({ loadNbr: '', routeName: '' }), 'no_route_assigned');
  assert.equal(blindReason({ loadNbr: 'ULINE APPTS' }), 'appointment_route');
  assert.equal(blindReason({ loadNbr: 'X', routeSeq: 4, lat: 'nope' }), 'no_position');
});
