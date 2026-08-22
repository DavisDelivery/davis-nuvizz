// THE ETA IS ANCHORED ON WHAT THE TRUCK ACTUALLY DID, NOT ON AN ASSUMPTION MADE AT 8:00.
//
// R5 used to judge only the stops still OPEN while restarting the walk at the DEPOT at
// 08:00. Every completed stop therefore deleted its leg AND its 20-minute service block
// from the front of the chain while the start time stayed put, so the predicted arrival
// for everything still out walked BACKWARDS as the day ran — and a red flag was quietly
// WITHDRAWN exactly when lateness became real. Measured on 39 sealed days, that model put
// the truck within 30 minutes of reality 12% of the time (median miss 2h09).
//
// It now walks the FULL sequenced chain and snaps the clock to each stop's real arrival
// stamp. Same 39 days, that model is within 30 minutes 67% of the time (median miss ~15).
//
// These tests are the PYROK shape: a dispatcher-typed 2pm close on stop 9 of 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, arrivalAnchor, stampMinutes } from '../src/lib/board-flags.js';

const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };
const N = 10, TARGET = 9, DATE = '2026-08-17';
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// `pace` = real minutes per stop. Under the distance-tiered curve the model believes ~44
// per stop here (18-mile legs at ~36 mph effective = 30 travel + the MEASURED 14 service,
// not the routing engine's 20-minute planning allowance), so a pace of 75 is a truck
// steadily falling behind and 35 is one running ahead. The spacing is tuned so the pure
// 8:00 projection ALREADY misses the 14:00 close — these tests are about what the anchor
// does to an already-late route, not about whether the curve finds it late.
const board = (delivered, { pace = 75, firstArrival = 8 * 60 + 30 } = {}) => {
  const stops = [];
  for (let i = 1; i <= N; i += 1) {
    const s = {
      stopNbr: `S${i}`, matchKey: `c${i}`, businessName: `CUST ${i}`, loadNbr: 'TESTLOAD',
      routeSeq: i, stopType: 'DL', lat: 34.147791 + i * 0.26, lng: -83.960911,
      normalizedStatus: 'PLANNED', status: '10',
      driverName: 'TEST DRIVER', driverUserName: 'tdriver',   // keeps R6 from superseding
    };
    if (i <= delivered) {
      s.arrivalDTTM = `${DATE}T${hhmm(firstArrival + (i - 1) * pace)}`;
      s.deliveredDTTM = `${DATE}T${hhmm(firstArrival + (i - 1) * pace + 15)}`;
      s.normalizedStatus = 'DELIVERED'; s.status = '90';
    }
    stops.push(s);
  }
  return stops;
};
const notes = new Map([['c9', {
  manual_overrides: { receiving_hours: true },              // typed => red tier
  receiving_hours: { mon: { open: '08:00', close: '14:00' } },
}]]);

// THE CLOCK HAS TO MATCH THE FICTION. This used to be `8:05 + delivered*60` — a flat hour
// per stop regardless of `pace` — so the running-ahead case (pace 35) claimed it was 12:05
// while the truck's last delivery was 10:00 and six stops sat untouched. That is not a truck
// running ahead; that is a truck that stopped reporting two hours ago, and the engine is
// right to flag it (a stop still open cannot have been arrived at in the past). The clock now
// sits just after the last stamp the fixture wrote, which is the world these tests describe:
// the truck just delivered stop N and is en route to N+1.
const nowFor = (delivered, { pace = 75, firstArrival = 8 * 60 + 30 } = {}) =>
  (delivered > 0 ? firstArrival + (delivered - 1) * pace + 15 + 5 : 8 * 60 + 5);

const flagFor = (delivered, opts) => {
  const out = computeBoardFlags({
    stops: board(delivered, opts), notes, servedDate: DATE, dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: nowFor(delivered, opts) },
  });
  return out.rows.find((r) => r.rule === 'hours_risk' && /CUST 9/.test(`${r.title} ${r.detail}`)) || null;
};
const etaMin = (row) => {
  const t = row.detail.match(/estimated arrival ~(\d+):(\d+)([ap])/);
  let h = Number(t[1]) % 12; if (t[3] === 'p') h += 12;
  return h * 60 + Number(t[2]);
};

test('a truck that is falling behind KEEPS its red flag as the route completes', () => {
  for (let done = 0; done <= 5; done += 1) {
    assert.ok(flagFor(done), `flag lost with ${done} delivered — this is the withdrawal bug`);
  }
});

test('and the estimate gets LATER as it falls further behind, never earlier', () => {
  const seen = [];
  for (let done = 1; done <= 5; done += 1) seen.push(etaMin(flagFor(done)));
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `estimate moved backwards: ${seen[i - 1]} -> ${seen[i]}`);
  }
  assert.ok(seen[seen.length - 1] > seen[0], 'a steadily later truck must read steadily later');
});

test('the row says the clock is running from a real arrival, not from the 8:00 assumption', () => {
  const row = flagFor(3);
  assert.match(row.detail, /from CUST 3's [\d:]+[ap]'?s? ?arrival|from CUST 3's [\d:]+[ap] arrival/);
  assert.doesNotMatch(row.detail, /departs 8:00a/);
});

test('a truck running AHEAD correctly clears the flag — that is the point, not a regression', () => {
  assert.equal(flagFor(4, { pace: 35, firstArrival: 8 * 60 }), null);
});

// SUPERSEDED BY THE YARD RULE (Chad, 2026-08-22), and re-pointed rather than deleted: the
// thing this test protects is that the ROW STATES WHERE ITS CLOCK COMES FROM, so a
// dispatcher can tell an assumption from a measurement. What changed is which answer is
// correct once the departure hour has passed with nothing delivered — the truck is on the
// yard, so the clock runs from now, not from the 8:00 assumption. See yard-departure.test.mjs.
test('with nothing delivered yet the walk says the clock runs from NOW, not from 8:00', () => {
  const row = flagFor(0);                      // nowFor(0) is 8:05a — past the departure hour
  assert.match(row.detail, /no movement yet, clock runs from 8:05a/);
  assert.doesNotMatch(row.detail, /departs 8:00a/);
});

test('but before the departure hour it still reports the assumption, honestly labelled', () => {
  const out = computeBoardFlags({
    stops: board(0), notes, servedDate: DATE, dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 7 * 60 },    // a 7:00a sweep: nothing is late to leave yet
  });
  const row = out.rows.find((r) => r.rule === 'hours_risk' && /CUST 9/.test(`${r.title} ${r.detail}`));
  assert.ok(row, 'the 7:00a sweep should still judge this route');
  assert.match(row.detail, /departs 8:00a \(assumed\)/);
});

test('a delivered stamp is not given another service block (the dwell already happened)', () => {
  assert.deepEqual(arrivalAnchor({ arrivalDTTM: `${DATE}T10:15` }, DATE), { min: 615, source: 'arrival' });
  assert.deepEqual(arrivalAnchor({ deliveredDTTM: `${DATE}T10:40` }, DATE), { min: 640, source: 'delivered' });
});

test("a stamp dated to another day is refused — yesterday says nothing about today's truck", () => {
  assert.equal(arrivalAnchor({ arrivalDTTM: '2026-08-16T10:15' }, DATE), null);
});

test('stamps are read as naive ET digits, never through Date + timeZone', () => {
  assert.equal(stampMinutes('2026-08-17T03:43'), 223);   // a pre-dawn run stays on its own day
  assert.equal(stampMinutes('2026-08-17 17:32'), 1052);
  assert.equal(stampMinutes('not a stamp'), null);
});

// ── REGRESSION GUARDS FOR THE CHAIN NOW CARRYING FINISHED STOPS ───────────────

test('an unpinned but STAMPED finished stop does not abandon the route', () => {
  // Before the chain carried finished stops, this stop was never walked at all. If a
  // missing pin still broke the chain, adding it would silently REDUCE flag coverage —
  // the change would look like an improvement while judging fewer routes.
  const stops = board(3, { pace: 75 });
  delete stops[1].lat; delete stops[1].lng;          // CUST 2: delivered, stamped, no pin
  const out = computeBoardFlags({
    stops, notes, servedDate: DATE, dayKey: 'mon', opts: { depot: DEPOT, nowMin: 11 * 60 },
  });
  assert.ok(out.rows.some((r) => r.rule === 'hours_risk' && /CUST 9/.test(`${r.title} ${r.detail}`)),
    'route was abandoned by an unpinned delivered stop');
  assert.equal(out.checked.routesJudged, 1);
});

test('a stop with NEITHER a pin nor a stamp still breaks the chain honestly', () => {
  const stops = board(0);
  delete stops[1].lat; delete stops[1].lng;          // CUST 2: open, unpinned, unstamped
  const out = computeBoardFlags({
    stops, notes, servedDate: DATE, dayKey: 'mon', opts: { depot: DEPOT, nowMin: 8 * 60 + 5 },
  });
  assert.equal(out.checked.routesJudged, 0);
  assert.ok(out.skipped.routesNoSequence.some((x) => /missing pin/.test(x)));
});

test('an unpinned stop leaves the last known position standing for the next leg', () => {
  // CUST 2 unpinned: the leg into CUST 3 must be measured from CUST 1, not from the depot
  // and not from a null. A wrong origin here would silently distort every later estimate.
  const stops = board(3, { pace: 75 });
  delete stops[1].lat; delete stops[1].lng;
  const withGap = computeBoardFlags({ stops, notes, servedDate: DATE, dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 11 * 60 } })
    .rows.find((r) => /CUST 9/.test(`${r.title} ${r.detail}`));
  // Anchored on CUST 3's real 10:30a arrival, so the unpinned gap upstream cannot move it.
  assert.match(withGap.detail, /from CUST 3's 11:00a arrival/);
});
