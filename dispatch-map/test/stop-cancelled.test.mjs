// test/stop-cancelled.test.mjs — a cancelled stop is not freight, and comes off the board.
//
// Chad, with a photograph of the wall display showing the whole United States: "This stop is
// what is making the map messed up its been canceled and shouldn't be on my map anymore so
// handle that and it should self heal."
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stopCancellation, isCancelledStop, dropCancelledStops, dropCancelledEnabled,
} from '../src/lib/stop-cancelled.js';

// THE REAL ROW, copied off the 2026-09-21 board — the one that stretched the wall from the
// Rockies to Georgia. A fixture invented from the description would not have caught that the
// cancellation sits under `raw`, which is the one thing about this that was easy to get wrong.
const CANCELLED = {
  stopNbr: 'GRENZEBACH131732373',
  businessName: 'GRENZEBACH131732373',
  addr1: '5', city: '0.00', zip: 'POUNDS',
  lat: 38.7946, lng: -106.53484,
  status: '99', normalizedStatus: 'EXCEPTION',
  orderInstructions: 'Cancelled',
  raw: {
    stop: { from: { address: { addr1: '5', city: '0.00', state: 'CUBIC FEET', zip: 'POUNDS' } } },
    stopExecutionInfo: {
      cancellation: { cancelDTTM: '2026-09-20T21:00:55', cancelTimeZone: 'GMT', reasonCode: 'CANCELLED', reasonDesc: '' },
      exceptions: [],
    },
  },
};
// An ordinary delivery off the same board.
const LIVE = {
  stopNbr: 'GRENZEBACH13173237', businessName: 'PRIMARY FREIGHT',
  addr1: '845 HIGHWAY 16 E', city: 'NEWNAN', zip: '30263',
  lat: 33.33131, lng: -84.75363, status: '20', normalizedStatus: 'SCHEDULED',
  raw: { stopExecutionInfo: { exceptions: [], loadingInfo: { loadingStatus: 'NA' } } },
};

test('THE ROW THAT BROKE THE WALL IS RECOGNISED, off NuVizz\'s own cancellation record', () => {
  const c = stopCancellation(CANCELLED);
  assert.ok(c, 'the cancellation was not found');
  assert.equal(c.at, '2026-09-20T21:00:55');
  assert.equal(c.reasonCode, 'CANCELLED');
  assert.equal(isCancelledStop(CANCELLED), true);
});

test('AND AN ORDINARY DELIVERY IS NOT — this is the expensive direction to get wrong', () => {
  // Dropping live freight hides a real delivery from a dispatcher. Keeping a cancelled row is
  // clutter. The two mistakes are nowhere near symmetrical, so the signal has to be exact.
  assert.equal(stopCancellation(LIVE), null);
  assert.equal(isCancelledStop(LIVE), false);
});

test('AN EMPTY cancellation:{} IS NOT A CANCELLATION — NuVizz ships that shape on live stops', () => {
  // "the key exists" as the signal would empty the whole board.
  assert.equal(isCancelledStop({ raw: { stopExecutionInfo: { cancellation: {} } } }), false);
  assert.equal(isCancelledStop({ raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '' } } } }), false);
  assert.equal(isCancelledStop({ raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '   ' } } } }), false);
  assert.equal(isCancelledStop({ raw: { stopExecutionInfo: { cancellation: { reasonDesc: 'nope' } } } }), false);
});

test('FREE TEXT IS NOT ENOUGH. A word in a comment field must never drop a stop', () => {
  // This very row also says "Cancelled" in orderInstructions. A board that reads that would
  // one day drop a live delivery whose customer note happens to contain the word.
  const chatty = { ...LIVE, orderInstructions: 'Cancelled', allComments: [{ text: 'Cancelled', type: 'STP_CL' }] };
  assert.equal(isCancelledStop(chatty), false, 'a comment must not cancel a stop');
});

test('either signal alone is enough — a timestamp OR an explicit CANCELLED code', () => {
  assert.ok(stopCancellation({ raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '2026-09-20T21:00:55' } } } }));
  assert.ok(stopCancellation({ raw: { stopExecutionInfo: { cancellation: { reasonCode: 'cancelled' } } } }), 'lower case');
  assert.ok(stopCancellation({ raw: { stopExecutionInfo: { cancellation: { reasonCode: ' CANCELLED ' } } } }), 'padded');
});

test('a malformed stop is never cancelled, and never throws', () => {
  for (const bad of [null, undefined, {}, { raw: null }, { raw: {} }, { raw: { stopExecutionInfo: null } },
    { raw: { stopExecutionInfo: { cancellation: 'yes' } } }, { raw: { stopExecutionInfo: { cancellation: 7 } } }]) {
    assert.equal(isCancelledStop(bad), false, `${JSON.stringify(bad)} read as cancelled`);
  }
});

// ── taking it off the board ─────────────────────────────────────────────────
test('THE BOARD COMES BACK WITHOUT IT, AND NAMES WHAT CAME OFF', () => {
  const board = [LIVE, CANCELLED, { ...LIVE, stopNbr: 'X2' }];
  const out = dropCancelledStops(board, true);
  assert.equal(out.stops.length, 2);
  assert.ok(!out.stops.some((s) => s.stopNbr === 'GRENZEBACH131732373'));
  assert.deepEqual(out.dropped, [{ stopNbr: 'GRENZEBACH131732373', at: '2026-09-20T21:00:55', reasonCode: 'CANCELLED' }]);
});

test('an ordinary day drops nothing and returns the board untouched', () => {
  const board = [LIVE, { ...LIVE, stopNbr: 'X2' }];
  const out = dropCancelledStops(board, true);
  assert.equal(out.stops.length, 2);
  assert.deepEqual(out.dropped, []);
});

test('SWITCHED OFF, EVERY ROW COMES BACK — the way back has to actually work', () => {
  const out = dropCancelledStops([LIVE, CANCELLED], false);
  assert.equal(out.stops.length, 2);
  assert.deepEqual(out.dropped, [], 'nothing is reported as dropped when nothing was');
});

test('a malformed board is a board, not a crash', () => {
  assert.deepEqual(dropCancelledStops(null, true), { stops: [], dropped: [] });
  assert.deepEqual(dropCancelledStops(undefined, true), { stops: [], dropped: [] });
});

// ── the switch ──────────────────────────────────────────────────────────────
test('BOARD_DROP_CANCELLED is ON by default — that is the point of the change', () => {
  assert.equal(dropCancelledEnabled({}), true);
  assert.equal(dropCancelledEnabled(), true);
  assert.equal(dropCancelledEnabled({ BOARD_DROP_CANCELLED: '' }), true);
});

test('BOARD_DROP_CANCELLED=off puts cancelled stops back on the board', () => {
  for (const v of ['off', 'OFF', ' off ', '0', 'false', 'no', 'No']) {
    assert.equal(dropCancelledEnabled({ BOARD_DROP_CANCELLED: v }), false, `"${v}" should disable`);
  }
});

test('A TYPO LEAVES IT ON, because a silently-restored cancelled stop looks like a real one', () => {
  for (const v of ['offf', 'yes', 'on', 'true', 'disabled', '1', 'nope']) {
    assert.equal(dropCancelledEnabled({ BOARD_DROP_CANCELLED: v }), true, `"${v}" must not disable`);
  }
});
