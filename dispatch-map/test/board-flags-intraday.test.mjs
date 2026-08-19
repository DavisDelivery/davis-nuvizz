// THE FLAG IS WITHDRAWN AS THE TRUCK FALLS BEHIND.
//
// computeBoardFlags judges only the stops still OPEN (board-flags.js filters finished
// stops), but the arrival walk always restarts at the DEPOT at 08:00. So every completed
// stop deletes its leg AND its 20-minute service block from the front of the chain while
// the start time stays put, and the predicted arrival for everything still out moves
// EARLIER as the day runs — most optimistic exactly when lateness is realest.
//
// The re-anchor cannot rescue it: one delivered stop makes the route "rolling"
// (isRollingEvidence), so notStarted is false and effDepart stays 08:00 all day.
//
// This is the PYROK shape — a typed 2pm close, second-to-last on the load. These tests
// pin the CURRENT behaviour so the rebuild has to change them deliberately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags } from '../src/lib/board-flags.js';

const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };
const N = 10, TARGET = 9;

const board = (delivered) => {
  const stops = [];
  for (let i = 1; i <= N; i += 1) {
    const s = {
      stopNbr: `S${i}`, matchKey: `c${i}`, businessName: `CUST ${i}`, loadNbr: 'TESTLOAD',
      routeSeq: i, stopType: 'DL', lat: 34.147791 + i * 0.15, lng: -83.960911,
      normalizedStatus: 'PLANNED', status: '10',
      driverName: 'TEST DRIVER', driverUserName: 'tdriver',   // keeps R6 from superseding
    };
    if (i <= delivered) { s.deliveredDTTM = '2026-08-17T09:00'; s.normalizedStatus = 'DELIVERED'; s.status = '90'; }
    stops.push(s);
  }
  return stops;
};
const notes = new Map([['c9', {
  manual_overrides: { receiving_hours: true },              // typed => red tier
  receiving_hours: { mon: { open: '08:00', close: '14:00' } },
}]]);

const flagFor = (delivered) => {
  const out = computeBoardFlags({
    stops: board(delivered), notes, servedDate: '2026-08-17', dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 8 * 60 + 5 + delivered * 30 },
  });
  return out.rows.find((r) => r.rule === 'hours_risk' && /CUST 9/.test(`${r.title} ${r.detail}`)) || null;
};
const etaOf = (row) => (row ? (row.detail.match(/estimated arrival ~([^ ]+)/) || [])[1] : null);

test('the same stop is predicted EARLIER as its route completes', () => {
  const at0 = flagFor(0), at1 = flagFor(1), at2 = flagFor(2);
  assert.ok(at0 && at1 && at2, 'all three should still flag');
  assert.equal(etaOf(at0), '2:43p');
  assert.equal(etaOf(at1), '2:23p');   // one stop done -> 20 minutes more optimistic
  assert.equal(etaOf(at2), '2:03p');   // two stops done -> 40 minutes more optimistic
});

test('the red flag is WITHDRAWN once enough stops complete, though nothing improved', () => {
  assert.ok(flagFor(2), 'still flagged with 2 delivered');
  for (let done = 3; done < TARGET; done += 1) {
    assert.equal(flagFor(done), null, `flag unexpectedly present with ${done} delivered`);
  }
});

test('a delivered stop makes the route rolling, so the not-started re-anchor never applies', () => {
  // Late morning, three stops done. If the re-anchor fired, the clock would restart at NOW
  // (11:00) and the estimate would be far LATER, not earlier. It does not fire.
  const out = computeBoardFlags({
    stops: board(3), notes, servedDate: '2026-08-17', dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 11 * 60 },
  });
  const row = out.rows.find((r) => r.rule === 'hours_risk' && /CUST 9/.test(`${r.title} ${r.detail}`));
  assert.equal(row, undefined, 'no flag: the walk still starts at 08:00 from the depot');
});
