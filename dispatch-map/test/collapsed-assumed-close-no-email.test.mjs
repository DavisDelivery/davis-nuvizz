// A STOP WITH NO HOURS ON FILE NEVER EMAILS — AND A BUSY DAY MUST NOT CHANGE THAT.
//
// board-flags judges a stop with no receiving hours against a house 5pm close, tiered
// 'assumed', and selectAlertable refuses every such row by provenance (hoursTier) — a deadline
// nobody recorded must not reach customer service. But past AMBER_CAP the amber hours_risk
// bucket collapses to one summary row, and the alert path reads the constituents the summary
// carries. That projection carried the close, the ETA, the overrun and the anchor — and NOT
// hoursTier. So the guard read `undefined`, let every constituent through, and the late floor
// (anchored, 25+ minutes late) mailed all of them. Measured on the real engine before the fix:
// three such stops emailed nobody; twenty-six emailed twenty-six.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, AMBER_CAP } from '../src/lib/board-flags.js';
import { selectAlertable, ALERT_LATE_FLOOR_MIN } from '../netlify/functions/lib/flag-alert.mts';
import { flattenForConsumers } from '../netlify/functions/lib/flag-rows.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const NOW = 16 * 60 + 10; // 4:10p — the assumed 5pm door is still open

// n two-stop routes. Stop 1 delivered at 4:00p (a real stamp, so the rest of the route is
// ANCHORED); stop 2 is ninety miles on with NOTHING on file, so it is judged against the
// assumed 5pm close and lands ~49 minutes past it — over the shipped 25-minute late floor.
const board = (n) => {
  const stops = [];
  for (let i = 0; i < n; i += 1) {
    stops.push({
      stopNbr: `A${i}`, matchKey: `a${i}`, businessName: `FIRST ${i}`, loadNbr: `R${i}`, routeName: `R${i}`,
      routeSeq: 1, stopType: 'DL', lat: DEPOT.lat + 5 * DEG, lng: DEPOT.lng + i * 0.002,
      normalizedStatus: 'DELIVERED', status: '60', deliveredDTTM: '2026-08-17T16:00:00',
      driverName: 'DRV', driverUserName: 'd',
    });
    stops.push({
      stopNbr: `B${i}`, matchKey: `b${i}`, businessName: `CO ${i}`, loadNbr: `R${i}`, routeName: `R${i}`,
      routeSeq: 2, stopType: 'DL', lat: DEPOT.lat + 90 * DEG, lng: DEPOT.lng + i * 0.002,
      normalizedStatus: 'PLANNED', status: '10', driverName: 'DRV', driverUserName: 'd',
    });
  }
  return computeBoardFlags({
    stops, notes: new Map(), servedDate: '2026-08-17', dayKey: 'mon', rosterRows: [],
    opts: { depot: DEPOT, nowMin: NOW },
  });
};

test('the fixture is what it claims: anchored, over the late floor, assumed, and collapsed past the cap', () => {
  const few = board(3).rows.filter((r) => r.rule === 'hours_risk');
  assert.equal(few.length, 3);
  for (const r of few) {
    assert.equal(r.hoursTier, 'assumed');
    assert.equal(r.tier, 'amber');
    assert.equal(r.anchored, true);
    assert.ok(r.lateBy >= ALERT_LATE_FLOOR_MIN, `lateBy ${r.lateBy} clears the late floor`);
  }
  const many = board(AMBER_CAP + 1).rows.filter((r) => r.rule === 'hours_risk');
  assert.equal(many.length, 1, 'the panel collapses the bucket to one summary line');
  assert.equal(many[0].collapsed, AMBER_CAP + 1);
});

test('twenty-six stops judged against an assumed 5pm close email nobody, exactly as three do', () => {
  assert.deepEqual(selectAlertable(board(3).rows, NOW), [], 'three assumed closes: no email');
  assert.deepEqual(selectAlertable(board(AMBER_CAP + 1).rows, NOW), [],
    'a busy day collapses the panel — it must not turn guessed deadlines into customer-service mail');
});

test('the assumed-close refusal still holds on a collapsed day with the amber lead gate switched on', () => {
  assert.deepEqual(selectAlertable(board(AMBER_CAP + 1).rows, NOW, 120), []);
});

test('every constituent of a collapsed batch still says which kind of deadline it was judged against', () => {
  const flat = flattenForConsumers(board(AMBER_CAP + 1).rows).filter((r) => r.rule === 'hours_risk');
  assert.equal(flat.length, AMBER_CAP + 1);
  for (const r of flat) assert.equal(r.hoursTier, 'assumed', `stop ${r.stopNbr}`);
});
