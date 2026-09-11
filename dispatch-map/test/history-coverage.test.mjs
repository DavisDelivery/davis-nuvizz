// THE WAREHOUSE FLOOR — how far back "Recent deliveries here" can possibly reach.
//
// The stop card has no date cutoff (it renders the newest 8 of a customer's stored
// 20 PROs), so its reach is bounded only by the oldest day the warehouse holds AND
// by which of those days actually fed the per-customer rollup. summarizeCoverage is
// that rule; these tests pin it against the states a real manifest comes in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCoverage } from '../netlify/functions/lib/history-seal.mts';

const T = 'davis';
const day = (date, fields = {}) => ({ _id: `${T}__${date}`, tenant: T, date, ...fields });
const sealed = (date, fields = {}) => day(date, { verified: true, complete: true, ...fields });

test('coverage: an empty warehouse has no floor to report (not a date of 1970)', () => {
  const c = summarizeCoverage([], T);
  assert.equal(c.days, 0);
  assert.equal(c.first_date, null);
  assert.equal(c.last_date, null);
  assert.equal(c.rollup_from, null);
});

test('coverage: oldest and newest day, whatever order the list arrives in', () => {
  const c = summarizeCoverage([sealed('2026-07-10'), sealed('2026-06-24'), sealed('2026-09-10')], T);
  assert.equal(c.days, 3);
  assert.equal(c.first_date, '2026-06-24');
  assert.equal(c.last_date, '2026-09-10');
  assert.equal(c.sealed_days, 3);
});

// The floor of the history panel is NOT the oldest manifest. The rollup is a
// post-seal derivation, so a day that never sealed never contributed a PRO to any
// customer — reporting its date as the reach would overstate the history by weeks.
test('coverage: rollup_from skips the unsealed days at the front of the range', () => {
  const c = summarizeCoverage([
    day('2026-06-24'),                       // manifest present, never sealed → a hole
    day('2026-06-25'),
    sealed('2026-06-26'),
    sealed('2026-06-29'),
  ], T);
  assert.equal(c.first_date, '2026-06-24', 'the warehouse does hold a doc for the 24th');
  assert.equal(c.rollup_from, '2026-06-26', 'but the history a stop card can show starts at the first SEALED day');
  assert.equal(c.unsealed_days, 2);
  assert.equal(c.sealed_days, 2);
});

// A tombstoned day is a day Davis did not run. It is covered, and it contributes
// no deliveries — counting it as the floor would claim history from a day with no
// freight in it.
test('coverage: a no-board tombstone is covered but is not where the history starts', () => {
  const c = summarizeCoverage([
    day('2026-07-04', { no_board: true, verified: true, complete: true, tombstone_reason: 'holiday' }),
    sealed('2026-07-06'),
  ], T);
  assert.equal(c.days, 2);
  assert.equal(c.tombstone_days, 1);
  assert.equal(c.sealed_days, 1);
  assert.equal(c.rollup_from, '2026-07-06');
});

// A healed day is a recovered one — it re-ran the same post-seal hooks, so it counts
// exactly like a cleanly captured day.
test('coverage: a healed day counts as sealed history', () => {
  const c = summarizeCoverage([day('2026-06-24', { healed: true }), sealed('2026-06-25')], T);
  assert.equal(c.rollup_from, '2026-06-24');
  assert.equal(c.sealed_days, 2);
});

// The silent one: the day sealed, so every capture-health square is green, but the
// customer-rollup hook threw — that day's deliveries are missing from every stop
// card and nothing said so.
test('coverage: a sealed day whose customer-rollup hook failed is a named hole, not the floor', () => {
  const c = summarizeCoverage([
    sealed('2026-08-03', { post_seal_ok: false, post_seal_failed: ['customer-rollup', 'tractor-flags'] }),
    sealed('2026-08-04'),
    sealed('2026-08-05', { post_seal_ok: false, post_seal_failed: ['customer-rollup'] }),
  ], T);
  assert.equal(c.sealed_days, 3, 'the captures themselves were fine');
  assert.equal(c.rollup_from, '2026-08-04', 'the history a customer card can show starts after the failed rollup');
  assert.deepEqual(c.rollup_gaps, ['2026-08-03', '2026-08-05']);
});

// A failure in another hook says nothing about the delivery history.
test('coverage: a paint/miner failure does not make a day a history hole', () => {
  const c = summarizeCoverage([sealed('2026-08-03', { post_seal_failed: ['tractor-flags', 'routing-reference'] })], T);
  assert.equal(c.rollup_from, '2026-08-03');
  assert.deepEqual(c.rollup_gaps, []);
});

// Ids are shared with other tenants/junk in the same collection; a bad id must never
// become a date.
test('coverage: foreign-tenant and malformed ids are ignored', () => {
  const c = summarizeCoverage([
    sealed('2026-08-03'),
    { _id: 'other__2026-01-01', verified: true },
    { _id: 'davis__not-a-date', verified: true },
    { _id: '', verified: true },
    null,
  ], T);
  assert.equal(c.days, 1);
  assert.equal(c.first_date, '2026-08-03');
});
