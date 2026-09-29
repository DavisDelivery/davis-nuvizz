// test/engine-replay-compare.test.mjs — old engine version vs new, per day and in total
// (scripts/engine-replay-compare.mjs). Pure: two snapshot objects in, a comparison out.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareSnapshots, formatReport, runCli, parseExclude, num, SEQUENCE_METRICS, PLAN_METRICS,
} from '../scripts/engine-replay-compare.mjs';
import { SNAPSHOT_KIND, SNAPSHOT_SCHEMA } from '../scripts/engine-replay-snapshot.mjs';
import { summarizePlanVersion } from '../netlify/functions/lib/routing-plan-core.mts';
import { ENGINE_VERSION } from '../netlify/functions/lib/routing-engine-config.mts';

const OLD = '2.13.0';
const NEW = '2.13.1';

const seq = (date, v, o = {}) => ({
  tenant: 'davis', date, engine_version: v, computed_at: v === OLD ? `${date}T07:31:00.000Z` : '2026-09-29T15:00:00.000Z',
  routes_scored: 40, routes_skipped: 1, unguided_count: 4, mean_score: 0.12, median_score: 0.1,
  mean_score_guided: 0.11, median_score_guided: 0.09, mean_score_unguided: 0.2,
  mean_seq_dev_guided: 0.3, mean_erp_per_edit_guided: 0.4, mean_travel_delta_min: -2, ...o,
});
const plan = (date, v, o = {}) => ({
  tenant: 'davis', date, engine_version: v, computed_at: v === OLD ? `${date}T07:33:00.000Z` : '2026-09-29T15:30:00.000Z',
  drivers: 30, trips_engine: 44, trips_actual: 40, planned_stops: 700, unassigned_count: 2,
  stop_agreement_pct: 30, coload_agreement_pct: 40, coload_precision_pct: 35, stop_agreement_known_pct: 36,
  stop_agreement_fallback_pct: 10, candidate_containment_pct: 80, est_travel_engine_min: 9000, est_travel_actual_min: 8000,
  matched_load_sequence_score: 0.15, tie_margin: { stops: 300, mean: 1.2, p50: 0.9, share_lt_05: 0.2, share_lt_1: 0.4 }, ...o,
});
const manifest = (date, o = {}) => ({ captured_at: `${date}T06:01:00.000Z`, capture_version: 1, checksum: 'c', verified: true, complete: true, ...o });
function snap(takenAt, { sequence = {}, plan: p = {}, manifests = {}, rollups = {}, config = null, ...o } = {}) {
  return {
    kind: SNAPSHOT_KIND, schema: SNAPSHOT_SCHEMA, taken_at: takenAt, project: 'demo-project', database: '(default)', tenant: 'davis', reads: 1,
    sequence, plan: p, version_rollups: rollups, manifests, engine_config_stored: config, plan_replay_cursor: null, ...o,
  };
}
const days = (...ds) => ds;
const D = days('2026-09-01', '2026-09-02', '2026-09-03');
const allManifests = Object.fromEntries(D.map((d) => [d, manifest(d)]));
const tableOf = (r, id) => r.tables.find((t) => t.id === id);
const totalOf = (r, id, key) => tableOf(r, id).totals.find((t) => t.key === key);

function simplePair({ beforeSeq, afterSeq, beforePlan = {}, afterPlan = {}, manifests = allManifests } = {}) {
  const before = snap('2026-09-28T12:00:00.000Z', { sequence: beforeSeq, plan: beforePlan, manifests });
  const after = snap('2026-09-29T18:00:00.000Z', { sequence: afterSeq, plan: afterPlan, manifests });
  return { before, after };
}

test('a day on only one side has no pair: listed, and in no total', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', OLD, { routes_scored: 999 }) },
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW), '2026-09-03': seq('2026-09-03', NEW, { routes_scored: 777 }) },
  });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const t = tableOf(r, 'sequence');
  assert.equal(t.compared, 1);
  assert.deepEqual(t.left.only_before, ['2026-09-02']);
  assert.deepEqual(t.left.only_after, ['2026-09-03']);
  assert.equal(totalOf(r, 'sequence', 'routes_scored').old, 40, 'the unpaired 999 and 777 never reach a total');
  assert.equal(totalOf(r, 'sequence', 'routes_scored').new, 40);
});

test('a partial day named in --exclude is left out of every total', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', OLD, { mean_score: 0.9 }) },
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW), '2026-09-02': seq('2026-09-02', NEW, { mean_score: 0.01 }) },
  });
  const r = compareSnapshots(before, after, { newVersion: NEW, exclude: parseExclude(['2026-09-02']) });
  assert.deepEqual(tableOf(r, 'sequence').left.excluded, ['2026-09-02']);
  assert.equal(totalOf(r, 'sequence', 'mean_score').old, 0.12);
  assert.equal(totalOf(r, 'sequence', 'mean_score').new, 0.12);
  assert.throws(() => parseExclude(['2026-9-2']), /not a YYYY-MM-DD date/, 'a typo is refused, never silently ignored');
  assert.deepEqual([...parseExclude(['2026-09-10,2026-09-11', ' 2026-09-24 '])], ['2026-09-10', '2026-09-11', '2026-09-24']);
});

test('a day whose history was captured again after its old score was computed is left out; a normally captured day is kept', () => {
  const manifests = {
    ...allManifests,
    // re-captured (or re-sealed) on Sep 28 — after the old score of Sep 2 was computed on Sep 2
    '2026-09-02': manifest('2026-09-02', { captured_at: '2026-09-28T20:00:00.000Z', capture_version: 2 }),
  };
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', OLD) },
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW), '2026-09-02': seq('2026-09-02', NEW) },
    manifests,
  });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const t = tableOf(r, 'sequence');
  assert.deepEqual(t.left.recaptured, ['2026-09-02']);
  assert.equal(t.compared, 1, 'Sep 1 was captured at 06:01 and scored at 07:31 — the normal order — and is compared');
});

test('a day the replay has not reached yet is left out, and the re-score reads NOT finished until it is at the new version', () => {
  const beforeSeq = Object.fromEntries(D.map((d) => [d, seq(d, OLD)]));
  const { before, after } = simplePair({
    beforeSeq,
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW), '2026-09-02': seq('2026-09-02', NEW), '2026-09-03': seq('2026-09-03', OLD) },
    beforePlan: {}, afterPlan: {},
  });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const t = tableOf(r, 'sequence');
  assert.deepEqual(t.left.not_rescored, ['2026-09-03']);
  assert.deepEqual(t.progress.pending, ['2026-09-03']);
  assert.equal(t.progress.finished, false);
  assert.equal(r.finished, false);
  assert.match(formatReport(r), /NOT FINISHED/);

  const done = simplePair({
    beforeSeq,
    afterSeq: Object.fromEntries(D.map((d) => [d, seq(d, NEW)])),
    beforePlan: Object.fromEntries(D.map((d) => [d, plan(d, OLD)])),
    afterPlan: Object.fromEntries(D.map((d) => [d, plan(d, NEW)])),
  });
  const r2 = compareSnapshots(done.before, done.after, { newVersion: NEW });
  assert.equal(r2.finished, true);
  assert.match(formatReport(r2), /Re-score: FINISHED/);
});

test('a day the nightly scored fresh at the new version does not make an unstarted re-score look finished', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', OLD) },
    afterSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', OLD), '2026-09-03': seq('2026-09-03', NEW) },
  });
  const t = tableOf(compareSnapshots(before, after, { newVersion: NEW }), 'sequence');
  assert.equal(t.progress.first_new, null, 'Sep 3 was never in the BEFORE file: it is the nightly, not the replay');
  assert.equal(t.progress.finished, false);
  assert.match(formatReport(compareSnapshots(before, after, { newVersion: NEW })), /NOT STARTED/);
});

test('days the replay skips on purpose are not waited for: too early to judge, or no history manifest', () => {
  const manifests = { '2026-09-01': manifest('2026-09-01'), '2026-09-02': manifest('2026-09-02') }; // no manifest for Sep 3
  const { before, after } = simplePair({
    beforeSeq: Object.fromEntries(D.map((d) => [d, seq(d, OLD)])),
    afterSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', NEW), '2026-09-03': seq('2026-09-03', OLD) },
    manifests,
  });
  const t = tableOf(compareSnapshots(before, after, { newVersion: NEW }), 'sequence');
  assert.deepEqual(t.progress.older_untouched, ['2026-09-01'], 'before the first re-scored day: skipped as too early');
  assert.deepEqual(t.progress.no_manifest, ['2026-09-03'], 'the replays only list manifest days');
  assert.deepEqual(t.progress.pending, []);
  assert.equal(t.progress.finished, true);
});

test('a captured day with no stored score yet, after the first re-scored day, is still pending', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD) },
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW) },
  });
  const t = tableOf(compareSnapshots(before, after, { newVersion: NEW }), 'sequence');
  assert.deepEqual(t.progress.pending, ['2026-09-02', '2026-09-03'], 'manifests exist for them; the replay will score them');
});

test('a BEFORE file that already holds a new-version number has no old number for that day', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD), '2026-09-02': seq('2026-09-02', NEW) },
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW), '2026-09-02': seq('2026-09-02', NEW) },
  });
  const t = tableOf(compareSnapshots(before, after, { newVersion: NEW }), 'sequence');
  assert.deepEqual(t.left.before_already_new, ['2026-09-02']);
  assert.equal(t.compared, 1);
});

test('the sequencing total is the mean over every route, not an average of the daily means', () => {
  const { before, after } = simplePair({
    beforeSeq: {
      '2026-09-01': seq('2026-09-01', OLD, { routes_scored: 90, unguided_count: 10, mean_score: 0.1, mean_score_guided: 0.1 }),
      '2026-09-02': seq('2026-09-02', OLD, { routes_scored: 10, unguided_count: 0, mean_score: 0.5, mean_score_guided: 0.5 }),
    },
    afterSeq: {
      '2026-09-01': seq('2026-09-01', NEW, { routes_scored: 90, unguided_count: 10, mean_score: 0.1, mean_score_guided: 0.1 }),
      '2026-09-02': seq('2026-09-02', NEW, { routes_scored: 10, unguided_count: 0, mean_score: 0.3, mean_score_guided: 0.3 }),
    },
  });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const ms = totalOf(r, 'sequence', 'mean_score');
  assert.ok(Math.abs(ms.old - 0.14) < 1e-12, `(0.1×90 + 0.5×10)/100 = 0.14, not the plain 0.3 — got ${ms.old}`);
  assert.ok(Math.abs(ms.new - 0.12) < 1e-12);
  assert.equal(ms.verdict, 'closer to dispatch', 'a lower order score is closer to dispatch (score.mts: 0 = identical)');
  const g = totalOf(r, 'sequence', 'mean_score_guided');
  assert.ok(Math.abs(g.old - (0.1 * 80 + 0.5 * 10) / 90) < 1e-12, 'guided means weigh by GUIDED routes (routes − unguided)');
  const med = totalOf(r, 'sequence', 'median_score');
  assert.equal(med.old, null, 'a median does not add up across days');
  assert.match(med.note, /per day only/);
});

test('the assignment totals mean what the Engine tab\'s version card means (summarizePlanVersion)', () => {
  const beforePlan = {
    '2026-09-01': plan('2026-09-01', OLD, { planned_stops: 100, stop_agreement_pct: 10, stop_agreement_known_pct: 12, coload_agreement_pct: 20, trips_engine: 10, trips_actual: 8, est_travel_engine_min: 1000, est_travel_actual_min: 900 }),
    '2026-09-02': plan('2026-09-02', OLD, { planned_stops: 900, stop_agreement_pct: 30, stop_agreement_known_pct: 33, coload_agreement_pct: 44, trips_engine: 50, trips_actual: 47, est_travel_engine_min: 8000, est_travel_actual_min: 7700 }),
  };
  const afterPlan = {
    '2026-09-01': plan('2026-09-01', NEW, { planned_stops: 100, stop_agreement_pct: 11, stop_agreement_known_pct: 13, coload_agreement_pct: 21, trips_engine: 9, trips_actual: 8, est_travel_engine_min: 990, est_travel_actual_min: 900 }),
    '2026-09-02': plan('2026-09-02', NEW, { planned_stops: 898, stop_agreement_pct: 32, stop_agreement_known_pct: 35, coload_agreement_pct: 45, trips_engine: 49, trips_actual: 47, est_travel_engine_min: 7900, est_travel_actual_min: 7700 }),
  };
  const { before, after } = simplePair({ beforeSeq: {}, afterSeq: {}, beforePlan, afterPlan });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const round1 = (n) => Math.round(n * 10) / 10;
  for (const [side, docs, version] of [['old', Object.values(beforePlan), OLD], ['new', Object.values(afterPlan), NEW]]) {
    const card = summarizePlanVersion(docs, version);
    assert.equal(round1(totalOf(r, 'plan', 'stop_agreement_pct')[side]), card.stop_agreement_wmean, `${side} stop agreement`);
    assert.equal(round1(totalOf(r, 'plan', 'stop_agreement_known_pct')[side]), card.stop_agreement_known_wmean, `${side} known`);
    assert.equal(round1(totalOf(r, 'plan', 'coload_agreement_pct')[side]), card.coload_agreement_wmean, `${side} co-load`);
    assert.equal(round1(totalOf(r, 'plan', 'trips_delta_pct')[side]), card.trips_delta_pct, `${side} trips Δ`);
    assert.equal(round1(totalOf(r, 'plan', 'travel_delta_pct')[side]), card.travel_delta_pct, `${side} travel Δ`);
    assert.equal(totalOf(r, 'plan', 'planned_stops')[side], card.planned_stops_total, `${side} stops`);
    assert.equal(totalOf(r, 'plan', 'trips_engine')[side], card.trips_engine_total, `${side} engine trips`);
  }
  assert.equal(totalOf(r, 'plan', 'stop_agreement_pct').verdict, 'closer to dispatch', 'higher agreement is closer to dispatch');
});

test('a day the engine could not score stays out of the assignment totals, as on the card — but is still shown per day', () => {
  const beforePlan = { '2026-09-01': plan('2026-09-01', OLD), '2026-09-02': plan('2026-09-02', OLD, { planned_stops: 0, stop_agreement_pct: null, trips_actual: 12 }) };
  const afterPlan = { '2026-09-01': plan('2026-09-01', NEW), '2026-09-02': plan('2026-09-02', NEW, { planned_stops: 0, stop_agreement_pct: null, trips_actual: 12 }) };
  const { before, after } = simplePair({ beforeSeq: {}, afterSeq: {}, beforePlan, afterPlan });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const t = tableOf(r, 'plan');
  assert.equal(t.compared, 2);
  assert.deepEqual(t.not_totalled, ['2026-09-02']);
  assert.equal(totalOf(r, 'plan', 'trips_actual').old, 40, 'the unscored day\'s 12 trips are not summed');
  assert.equal(t.days.length, 2, 'both days are printed per day');
});

test('a number missing on one side drops that day from that number\'s total only — it is never read as 0', () => {
  const { before, after } = simplePair({
    beforeSeq: {
      '2026-09-01': seq('2026-09-01', OLD, { mean_score_unguided: null, unguided_count: 0 }),
      '2026-09-02': seq('2026-09-02', OLD, { mean_score_unguided: 0.2, unguided_count: 4, mean_travel_delta_min: null }),
    },
    afterSeq: {
      '2026-09-01': seq('2026-09-01', NEW, { mean_score_unguided: 0.25, unguided_count: 5 }),
      '2026-09-02': seq('2026-09-02', NEW, { mean_score_unguided: 0.3, unguided_count: 4, mean_travel_delta_min: -1 }),
    },
  });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const u = totalOf(r, 'sequence', 'mean_score_unguided');
  assert.equal(u.days, 1, 'Sep 1 has no old unguided score, so it is in neither side of this total');
  assert.ok(Math.abs(u.old - 0.2) < 1e-12 && Math.abs(u.new - 0.3) < 1e-12);
  const tr = totalOf(r, 'sequence', 'mean_travel_delta_min');
  assert.equal(tr.days, 1, 'Sep 2 has no old travel Δ — dropped, not counted as 0 minutes');
  assert.equal(tr.old, -2);
  assert.equal(num(null), null);
  assert.equal(num(''), null);
  assert.equal(num(false), null);
  assert.equal(num('0'), 0);
  assert.equal(totalOf(r, 'sequence', 'routes_scored').old, 80, 'the other totals still use both days');
});

test('a mixed old side gets totals per old version, so an older day never hides inside a 2.13.0 total', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', '2.12.1', { mean_score: 0.5 }), '2026-09-02': seq('2026-09-02', OLD, { mean_score: 0.1 }) },
    afterSeq: { '2026-09-01': seq('2026-09-01', NEW, { mean_score: 0.2 }), '2026-09-02': seq('2026-09-02', NEW, { mean_score: 0.1 }) },
  });
  const r = compareSnapshots(before, after, { newVersion: NEW });
  const t = tableOf(r, 'sequence');
  assert.deepEqual(t.old_versions, { '2.12.1': 1, [OLD]: 1 });
  const ms = (v) => t.by_old_version[v].find((x) => x.key === 'mean_score');
  assert.equal(ms('2.12.1').old, 0.5);
  assert.equal(ms(OLD).old, 0.1);
  assert.match(formatReport(r), /TOTAL by OLD version/);
});

test('a tuning change between the two files is called out; a re-save with the same values is not', () => {
  const base = simplePair({ beforeSeq: {}, afterSeq: {} });
  base.before.engine_config_stored = { w_candidate_rank: 2, updated_at: '2026-08-25T00:00:00Z' };
  base.after.engine_config_stored = { w_candidate_rank: 2, updated_at: '2026-09-29T00:00:00Z' };
  assert.deepEqual(compareSnapshots(base.before, base.after, { newVersion: NEW }).engine_config_changes, []);
  base.after.engine_config_stored = { w_candidate_rank: 4, weight_cap_tractor_lb: 44000, updated_at: '2026-09-29T00:00:00Z' };
  const r = compareSnapshots(base.before, base.after, { newVersion: NEW });
  assert.deepEqual(r.engine_config_changes.map((c) => c.key), ['w_candidate_rank', 'weight_cap_tractor_lb']);
  assert.match(formatReport(r), /stored engine settings changed between the two files/);
});

test('swapped, foreign or malformed files are refused', () => {
  const { before, after } = simplePair({ beforeSeq: {}, afterSeq: {} });
  assert.throws(() => compareSnapshots(after, before, { newVersion: NEW }), /swapped/);
  assert.throws(() => compareSnapshots(before, { ...after, project: 'elsewhere' }, { newVersion: NEW }), /different projects/);
  assert.throws(() => compareSnapshots({ ...before, kind: 'x' }, after, { newVersion: NEW }), /not an engine replay snapshot/);
  assert.throws(() => compareSnapshots(before, { ...after, manifests: null }, { newVersion: NEW }), /no manifests table/);
});

test('the report prints every number old → new with the change, per day and in total, and the default new version is this checkout\'s', () => {
  const { before, after } = simplePair({
    beforeSeq: { '2026-09-01': seq('2026-09-01', OLD) },
    afterSeq: { '2026-09-01': seq('2026-09-01', ENGINE_VERSION, { mean_score: 0.1 }) },
    beforePlan: { '2026-09-01': plan('2026-09-01', OLD) },
    afterPlan: { '2026-09-01': plan('2026-09-01', ENGINE_VERSION, { stop_agreement_pct: 31.5 }) },
  });
  const r = compareSnapshots(before, after);
  assert.equal(r.new_version, ENGINE_VERSION);
  const text = formatReport(r);
  for (const m of [...SEQUENCE_METRICS, ...PLAN_METRICS]) assert.ok(text.includes(m.label), `the report names "${m.label}"`);
  assert.match(text, /Order score, all routes \(0 = dispatch's order\)\s+0\.1200\s+0\.1000\s+−0\.0200\s+closer to dispatch/);
  assert.match(text, /Stop agreement % \(same driver as dispatch\)\s+30\.0\s+31\.5\s+\+1\.5\s+closer to dispatch/);
  assert.match(text, /PER DAY\n\s+2026-09-01\s+old 2\.13\.0/);
});

test('runCli: 2 on bad input with the reason, 0 with the report', () => {
  const { before, after } = simplePair({ beforeSeq: { '2026-09-01': seq('2026-09-01', OLD) }, afterSeq: { '2026-09-01': seq('2026-09-01', NEW) } });
  const files = { 'b.json': JSON.stringify(before), 'a.json': JSON.stringify(after) };
  const readFile = (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; };
  const outs = [], errs = [];
  assert.equal(runCli(['--before', 'b.json', '--after', 'a.json', '--new-version', NEW], { readFile, out: (s) => outs.push(s), err: (s) => errs.push(s) }), 0);
  assert.match(outs[0], /ENGINE RE-SCORE/);
  assert.equal(runCli(['--before', 'b.json', '--after', 'a.json', '--json', '--new-version', NEW], { readFile, out: (s) => outs.push(s), err: () => {} }), 0);
  assert.equal(JSON.parse(outs[1]).tables.length, 2);
  assert.equal(runCli(['--before', 'b.json'], { readFile, out: () => {}, err: (s) => errs.push(s) }), 2);
  assert.equal(runCli(['--before', 'b.json', '--after', 'missing.json'], { readFile, out: () => {}, err: (s) => errs.push(s) }), 2);
  assert.equal(runCli(['--before', 'a.json', '--after', 'b.json', '--new-version', NEW], { readFile, out: () => {}, err: (s) => errs.push(s) }), 2, 'swapped files');
  assert.equal(runCli(['--before', 'b.json', '--after', 'a.json', '--exclude', '09/10/2026'], { readFile, out: () => {}, err: (s) => errs.push(s) }), 2);
  assert.equal(runCli(['--before', 'b.json', '--after', 'a.json', '--new-version', 'v2'], { readFile, out: () => {}, err: (s) => errs.push(s) }), 2);
});
