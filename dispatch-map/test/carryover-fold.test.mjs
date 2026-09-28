// test/carryover-fold.test.mjs — lib/carryover-fold.mts, THE JUDGES' CLOCK (v1.77.0 audit fix).
//
// foldCarryover measures the open-order pool's and the unplanned snapshot's 7-day backstops at
// `judgedAtMs` when a caller passes one (the Map feed and the Claude planner read it after their
// judge documents are in and before the look-back days). The rule pinned here is what happens when
// that value is NOT a usable clock: the fold must behave exactly as if none was passed and read its
// own nowMs(). Anything else is silent: `now - at > 7 days` is false for NaN, so a NaN clock makes a
// month-old pool look fresh and lets it prune orders it has no business judging; and a string or an
// object would be coerced by the subtraction into a clock nobody meant.
// The end-to-end order of the clock read on both sides is pinned in map-planner-parity-e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldCarryover } from '../netlify/functions/lib/carryover-fold.mts';

const D = '2026-09-28', D1 = '2026-09-27';
const NOW = Date.parse('2026-09-28T12:00:00Z');
const HOUR = 3600e3, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const unplanned = (nbr) => ({ stopNbr: nbr, normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, status: '10' });
// OPEN is still listed by both judges; CLOSED is listed by neither — a judge that is trusted prunes it.
const reads = () => [{ d: D1, stops: [unplanned('OPEN'), unplanned('CLOSED')] }];
const poolAt = (ms) => ({ at: iso(ms), windowStart: '2026-09-20', windowEnd: '2026-10-05', count: 1, thin: false,
  rows: [{ stopNbr: 'OPEN', day: D1, isPlanned: false, isUnplanned: true, status: '10', normalizedStatus: 'UNPLANNED' }] });
const snapAt = (ms) => ({ at: iso(ms), windowStart: '2026-09-20', stopNbrs: new Set(['OPEN']), thin: false });

function fold({ pool = null, live = null, judgedAtMs, omit = false }) {
  const rows = [];
  const f = { date: D, reads: reads(), live, retired: {}, pool, nowMs: () => NOW, lastUnplannedScanAt: null };
  if (!omit) f.judgedAtMs = judgedAtMs;
  const stats = foldCarryover(rows, f);
  return { stats, served: rows.map((r) => r.stopNbr).sort() };
}

// Not a clock: each of these must leave the fold exactly as if no judgedAtMs had been passed.
const MALFORMED = [
  ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['null', null], ['undefined', undefined],
  ['a numeric string', String(NOW - DAY)], ['an object with valueOf', { valueOf: () => NOW - DAY }], ['a Date', new Date(NOW - DAY)], ['0 as a string', '0'],
];

test('A MONTH-OLD OPEN-ORDER POOL NEVER JUDGES because the clock it is measured at came through malformed — the fold falls back to its own clock, as if none was passed', () => {
  const absent = fold({ pool: poolAt(NOW - 30 * DAY), omit: true });
  // The baseline itself: a 30-day-old pool is past its backstop, judges nothing, prunes nothing.
  assert.equal(absent.stats.basis, 'none');
  assert.equal(absent.stats.poolWhy, 'pool is 720h old');
  assert.deepEqual(absent.served, ['CLOSED', 'OPEN'], 'nothing pruned: over-count, never hide');
  for (const [label, bad] of MALFORMED) {
    assert.deepEqual(fold({ pool: poolAt(NOW - 30 * DAY), judgedAtMs: bad }), absent, `judgedAtMs = ${label}`);
  }
});

test('A FRESH UNPLANNED SNAPSHOT STILL PRUNES a closed order when the judges’ clock came through malformed — it is judged on the fold’s own clock, not thrown out', () => {
  const absent = fold({ live: snapAt(NOW - HOUR), omit: true });
  assert.equal(absent.stats.basis, 'snapshot');
  assert.deepEqual(absent.served, ['OPEN'], 'the snapshot pruned the order it no longer lists');
  for (const [label, bad] of MALFORMED) {
    assert.deepEqual(fold({ live: snapAt(NOW - HOUR), judgedAtMs: bad }), absent, `judgedAtMs = ${label}`);
  }
});

test('A FINITE JUDGES’ CLOCK IS THE ONE THE 7-DAY BACKSTOPS USE — a pool 1s inside a week at that moment judges, though the fold’s own clock has moved past it', () => {
  // The clock was read when the judges came in; the look-back then took 5s to read.
  const judgedAtMs = NOW - 5000;
  const r = fold({ pool: poolAt(judgedAtMs - 7 * DAY + 1000), judgedAtMs });
  assert.equal(r.stats.basis, 'pool', String(r.stats.poolWhy));
  assert.deepEqual(r.served, ['OPEN'], 'the pool pruned the order it no longer lists');
  const s = fold({ live: snapAt(judgedAtMs - 7 * DAY + 1000), judgedAtMs });
  assert.equal(s.stats.basis, 'snapshot');
  // Without it, the same pool is read on the fold's own clock: 4s past the week, not trusted.
  assert.equal(fold({ pool: poolAt(judgedAtMs - 7 * DAY + 1000), omit: true }).stats.basis, 'none');
});
