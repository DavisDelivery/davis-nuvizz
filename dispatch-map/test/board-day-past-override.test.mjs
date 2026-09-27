// A3-S18-1 — a dispatcher-set board date whose day has PASSED must not pull a stop that is
// live on a route back onto that past day.
//
// The board-date override map (nuvizz_board_dates) is a "not yet" list: setStopDate records
// "the customer doesn't want it until the 11th", and the map is only pruned of past days when
// it is next WRITTEN (setBoardDateOverride → pruneBoardDateOverrides). The scan reads it
// unpruned, and boardDayFor returned the override BEFORE the live-route clamp — so on the 12th
// an open stop the driver is carrying on a load was filed on the 11th's board, off today's
// route, which is the exact hole the clamp exists to close (Mitchell's 007137332 / 007137372).
//
// NUVIZZ_PAST_OVERRIDE_CLAMP=off puts the old filing back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardDayFor, bucketByDate, pastOverrideClampEnabled } from '../netlify/functions/lib/nuvizz-list.mts';

const TODAY = '2026-09-12';
const YESTERDAY = '2026-09-11';

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'NUVIZZ_PAST_OVERRIDE_CLAMP');
  const prev = process.env.NUVIZZ_PAST_OVERRIDE_CLAMP;
  if (value === undefined) delete process.env.NUVIZZ_PAST_OVERRIDE_CLAMP;
  else process.env.NUVIZZ_PAST_OVERRIDE_CLAMP = value;
  try { return fn(); } finally {
    if (had) process.env.NUVIZZ_PAST_OVERRIDE_CLAMP = prev;
    else delete process.env.NUVIZZ_PAST_OVERRIDE_CLAMP;
  }
}

test('a routed open stop whose deferral day has passed rides TODAY\'s board, not yesterday\'s', () => {
  withEnv(undefined, () => {
    const onTruck = { stopNbr: '007137332', normalizedStatus: 'SCHEDULED', loadNbr: 'L9', boardDate: YESTERDAY };
    assert.equal(boardDayFor(onTruck, TODAY, { '007137332': YESTERDAY }), TODAY);
    // …and a dateless one the same way.
    const dateless = { stopNbr: '007137333', normalizedStatus: 'SCHEDULED', loadNbr: 'L9' };
    assert.equal(boardDayFor(dateless, TODAY, { '007137333': YESTERDAY }), TODAY);
    // bucketByDate (the scan's filing) agrees: yesterday's bucket does not get it.
    const m = bucketByDate([onTruck], TODAY, { '007137332': YESTERDAY });
    assert.deepEqual([...m.keys()], [TODAY]);
  });
});

test('a deferral to today or later still holds a routed stop off today', () => {
  withEnv(undefined, () => {
    const onTruck = { stopNbr: '007150559', normalizedStatus: 'SCHEDULED', loadNbr: 'L9', boardDate: TODAY };
    assert.equal(boardDayFor(onTruck, TODAY, { '007150559': '2026-09-30' }), '2026-09-30');
    assert.equal(boardDayFor(onTruck, TODAY, { '007150559': TODAY }), TODAY);
  });
});

test('an unrouted order and a finished stop file exactly as before', () => {
  withEnv(undefined, () => {
    // No route: the clamp never applied to it, so the override still decides its day.
    const unplanned = { stopNbr: '007150560', normalizedStatus: 'UNPLANNED', boardDate: '2026-09-05' };
    assert.equal(boardDayFor(unplanned, TODAY, { '007150560': YESTERDAY }), YESTERDAY);
    // Finished: history is never re-filed, override or clamp.
    const done = { stopNbr: '007150561', normalizedStatus: 'DELIVERED', loadNbr: 'L9', boardDate: YESTERDAY };
    assert.equal(boardDayFor(done, TODAY, { '007150561': '2026-09-30' }), YESTERDAY);
  });
});

test('NUVIZZ_PAST_OVERRIDE_CLAMP=off puts the old filing back; a typo leaves the fix ON', () => {
  const onTruck = { stopNbr: '007137332', normalizedStatus: 'SCHEDULED', loadNbr: 'L9', boardDate: YESTERDAY };
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' No ']) {
    withEnv(off, () => {
      assert.equal(pastOverrideClampEnabled(), false, `${JSON.stringify(off)} turns it off`);
      assert.equal(boardDayFor(onTruck, TODAY, { '007137332': YESTERDAY }), YESTERDAY);
    });
  }
  for (const on of [undefined, '', 'on', '1', 'true', 'yes', 'of', 'nope']) {
    withEnv(on, () => {
      assert.equal(pastOverrideClampEnabled(), true, `${JSON.stringify(on)} leaves it on`);
      assert.equal(boardDayFor(onTruck, TODAY, { '007137332': YESTERDAY }), TODAY);
    });
  }
});
