// test/plan-version-rollup.test.mjs — PURE per-engine-version rollup summarizer.
// Locks in: version filtering, stop-weighting (tiny days can't skew), the
// trips/travel over-split deltas, and empty/degenerate inputs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizePlanVersion } from '../netlify/functions/lib/routing-plan-core.mts';

const day = (o) => ({
  tenant: 'davis', engine_version: '2.4.1',
  stop_agreement_pct: 20, coload_agreement_pct: 25, stop_agreement_known_pct: 22,
  trips_engine: 60, trips_actual: 55, est_travel_engine_min: 8000, est_travel_actual_min: 7000,
  planned_stops: 700, date: '2026-07-15', ...o,
});

test('summarizePlanVersion: filters to the version, stop-weights the means', () => {
  const docs = [
    day({ date: '2026-07-14', stop_agreement_pct: 10, planned_stops: 100 }),
    day({ date: '2026-07-15', stop_agreement_pct: 30, planned_stops: 900 }),
    day({ date: '2026-07-13', engine_version: '2.3.0', stop_agreement_pct: 99, planned_stops: 999 }), // other version — ignored
  ];
  const r = summarizePlanVersion(docs, '2.4.1', 'davis', '2026-07-21T00:00:00Z');
  assert.equal(r.days_scored, 2, 'only the 2.4.1 days');
  // stop-weighted: (10*100 + 30*900) / 1000 = 28, NOT the plain mean 20
  assert.equal(r.stop_agreement_wmean, 28);
  assert.equal(r.planned_stops_total, 1000);
  assert.equal(r.window_from, '2026-07-14');
  assert.equal(r.window_to, '2026-07-15');
  assert.equal(r.computed_at, '2026-07-21T00:00:00Z');
});

test('summarizePlanVersion: a 2-stop skeleton day cannot swing the mean', () => {
  const docs = [
    day({ date: '2026-07-15', stop_agreement_pct: 20, planned_stops: 750 }),
    day({ date: '2026-07-03', stop_agreement_pct: 100, planned_stops: 2 }), // holiday skeleton
  ];
  const r = summarizePlanVersion(docs, '2.4.1');
  // (20*750 + 100*2) / 752 = 20.2 — the 100% day barely moves it (a plain avg would be 60)
  assert.ok(r.stop_agreement_wmean >= 20 && r.stop_agreement_wmean <= 21, `got ${r.stop_agreement_wmean}`);
});

test('summarizePlanVersion: trips + travel deltas quantify the over-split gap', () => {
  const docs = [day({ trips_engine: 80, trips_actual: 66, est_travel_engine_min: 10098, est_travel_actual_min: 8141 })];
  const r = summarizePlanVersion(docs, '2.4.1');
  assert.equal(r.trips_engine_total, 80);
  assert.equal(r.trips_actual_total, 66);
  assert.equal(r.trips_delta_pct, 21.2, '(80-66)/66 ×100');
  assert.equal(r.travel_delta_pct, 24, '(10098-8141)/8141 ×100');
});

test('summarizePlanVersion: a day with no co-load score cannot drag the co-load mean down', () => {
  // A day can carry a stop-agreement score but a null coload score (nothing was
  // co-loaded, or an older doc predates the metric). Its stop weight must not
  // enter the coload denominator — that would read "no co-loads scored" as
  // "0% co-load agreement" and halve the mean.
  const docs = [
    day({ date: '2026-07-14', coload_agreement_pct: 40, planned_stops: 500 }),
    day({ date: '2026-07-15', coload_agreement_pct: null, planned_stops: 500 }),
  ];
  const r = summarizePlanVersion(docs, '2.4.1');
  assert.equal(r.coload_agreement_wmean, 40, 'the null-coload day is excluded, not counted as zero');
  // No coload-scored days at all → null, never 0.
  const none = summarizePlanVersion([day({ coload_agreement_pct: null })], '2.4.1');
  assert.equal(none.coload_agreement_wmean, null);
});

test('summarizePlanVersion: drops unscored / zero-stop days; degenerate input never throws', () => {
  const docs = [
    day({ stop_agreement_pct: null }),           // never scored
    day({ planned_stops: 0 }),                   // no stops
    day({ stop_agreement_pct: 20, planned_stops: 500 }),
  ];
  const r = summarizePlanVersion(docs, '2.4.1');
  assert.equal(r.days_scored, 1);
  const empty = summarizePlanVersion([], '2.4.1');
  assert.equal(empty.days_scored, 0);
  assert.equal(empty.stop_agreement_wmean, null);
  assert.equal(empty.trips_delta_pct, null);
  assert.deepEqual(summarizePlanVersion(null, '2.4.1').days_scored, 0);
});
