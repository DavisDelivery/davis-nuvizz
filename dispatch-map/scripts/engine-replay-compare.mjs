#!/usr/bin/env node
// engine-replay-compare.mjs — OLD ENGINE VERSION vs NEW, DAY BY DAY AND IN TOTAL. OFFLINE.
//
// Reads two files written by engine-replay-snapshot.mjs — one taken BEFORE the engine's
// history replays re-scored the past days at the new ENGINE_VERSION, one AFTER — and prints,
// for the sequencing replay (route_proposals_daily) and the assignment replay
// (plan_proposals_daily), every number each day carries, old → new, then the total over the
// days both files can honestly compare. It makes no network call of any kind.
//
//   node scripts/engine-replay-compare.mjs --before engine-before.json --after engine-after.json
//       [--exclude 2026-09-10,2026-09-11]   days to leave out (repeatable): the partial /
//                                           re-captured days, named by whoever knows them
//       [--new-version 2.13.1]              default: this checkout's ENGINE_VERSION
//       [--json]                            the whole result as JSON instead of text
//
// WHICH DAYS ARE COMPARED. A day is left out, and listed with the reason, when
//   • only one file has it (no old number, or no new one);
//   • --exclude names it;
//   • the BEFORE file already holds a new-version number for it (the old one is gone);
//   • the AFTER file does not hold a new-version number for it yet (not re-scored);
//   • its history was captured (or re-sealed) after its old score was computed — the
//     manifest's captured_at (history_days) is later than the old doc's computed_at — so
//     the two numbers may have been scored from different stops. A capture writes a new
//     captured_at every time (history-core.mts, history-manifest-heal-background.mts).
// A partial day that was re-captured BEFORE its old score was computed is not caught by that
// last rule — both numbers then read the same stops — so name those with --exclude.
// Each TOTAL then uses only the days where both files have that particular number, and for
// the assignment replay only the days both sides scored (a stop-agreement number and planned
// stops above zero — the version cards' own day rule).
//
// WHAT A TOTAL MEANS. Counts are summed. A day's mean is weighted by what it is a mean OF —
// routes for the order score, guided routes for the guided score, planned stops for the
// agreement percentages (the same stop weighting as the Engine tab's version cards,
// summarizePlanVersion — a test holds the two equal), stops-with-a-choice for the tie
// margin — so a total is the mean over every route or stop, not an average of daily
// averages. A median does not add up across days and gets no total. Trips Δ% and travel Δ%
// come from the summed trips and minutes, as on the version cards.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ENGINE_VERSION } from '../netlify/functions/lib/routing-engine-config.mts';
import { SNAPSHOT_KIND, SNAPSHOT_SCHEMA } from './engine-replay-snapshot.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Missing is missing: Number(null) is 0 and 0 is finite, so null/''/undefined must be
// rejected BEFORE the coercion, or an unscored day reads as a perfect 0.
export function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const ratioPct = (a, b) => (a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null);

// ── what each number is, how it totals, and which way is closer to dispatch ─────────────
// dir: 'lower' / 'higher' = which way is CLOSER TO WHAT DISPATCH DID, as the code and the
// Engine tab define it (score.mts: "0 = the proposed sequence is identical to what dispatch
// actually built"; the Assignment chart: "higher is closer to dispatch"). 'tab-lower' = the
// Engine tab's version cards call lower better (trips/travel Δ). null = no direction is
// stated anywhere, so none is claimed here.
const guided = (d) => { const r = num(d?.routes_scored), u = num(d?.unguided_count); return r != null && u != null ? r - u : null; };
export const SEQUENCE_METRICS = [
  { key: 'routes_scored', label: 'Routes scored', total: 'sum', fmt: 'int' },
  { key: 'routes_skipped', label: 'Routes skipped (too few stops or missing coordinates)', total: 'sum', fmt: 'int' },
  { key: 'unguided_count', label: 'Unguided routes (no earlier route shared enough of the area)', total: 'sum', fmt: 'int' },
  { key: 'mean_score', label: 'Order score, all routes (0 = dispatch\'s order)', total: { weight: (d) => num(d?.routes_scored) }, fmt: 'score', dir: 'lower' },
  { key: 'median_score', label: 'Order score, median route', total: null, fmt: 'score', dir: 'lower' },
  { key: 'mean_score_guided', label: 'Order score, guided routes', total: { weight: guided }, fmt: 'score', dir: 'lower' },
  { key: 'median_score_guided', label: 'Order score, median guided route', total: null, fmt: 'score', dir: 'lower' },
  { key: 'mean_score_unguided', label: 'Order score, unguided routes', total: { weight: (d) => num(d?.unguided_count) }, fmt: 'score', dir: 'lower' },
  { key: 'mean_seq_dev_guided', label: 'Stop-order part of the score, guided', total: { weight: guided }, fmt: 'score', dir: 'lower' },
  { key: 'mean_erp_per_edit_guided', label: 'Distance part of the score, guided', total: { weight: guided }, fmt: 'score', dir: 'lower' },
  { key: 'mean_travel_delta_min', label: 'Travel Δ per route, engine − dispatch, min (negative = engine shorter)', total: { weight: (d) => num(d?.routes_scored) }, fmt: 'min' },
];
const stops = (d) => num(d?.planned_stops);
const tieStops = (d) => num(d?.tie_margin?.stops);
export const PLAN_METRICS = [
  { key: 'drivers', label: 'Drivers (dispatch\'s crew that day)', total: 'sum', fmt: 'int' },
  { key: 'planned_stops', label: 'Stops dispatch planned', total: 'sum', fmt: 'int' },
  { key: 'unassigned_count', label: 'Stops the engine left unplanned', total: 'sum', fmt: 'int' },
  { key: 'stop_agreement_pct', label: 'Stop agreement % (same driver as dispatch)', total: { weight: stops }, fmt: 'pct', dir: 'higher' },
  { key: 'stop_agreement_known_pct', label: 'Stop agreement %, drivers with their own history', total: { weight: stops }, fmt: 'pct', dir: 'higher' },
  { key: 'stop_agreement_fallback_pct', label: 'Stop agreement %, drivers the engine guessed at', total: { weight: stops }, fmt: 'pct', dir: 'higher' },
  { key: 'coload_agreement_pct', label: 'Co-load agreement % (stops dispatch loaded together)', total: { weight: stops }, fmt: 'pct', dir: 'higher' },
  { key: 'coload_precision_pct', label: 'Co-load precision % (engine co-loads dispatch also made)', total: { weight: stops }, fmt: 'pct' },
  { key: 'candidate_containment_pct', label: 'Stops whose dispatch driver the engine could pick %', total: { weight: stops }, fmt: 'pct' },
  { key: 'trips_engine', label: 'Trips, engine', total: 'sum', fmt: 'int' },
  { key: 'trips_actual', label: 'Trips, dispatch', total: 'sum', fmt: 'int' },
  { key: 'trips_delta_pct', label: 'Trips Δ %, engine vs dispatch', get: (d) => ratioPct(num(d?.trips_engine), num(d?.trips_actual)), total: { ratioOf: ['trips_engine', 'trips_actual'] }, fmt: 'pct', dir: 'tab-lower' },
  { key: 'est_travel_engine_min', label: 'Travel minutes, engine (estimate)', total: 'sum', fmt: 'min' },
  { key: 'est_travel_actual_min', label: 'Travel minutes, dispatch (estimate)', total: 'sum', fmt: 'min' },
  { key: 'travel_delta_pct', label: 'Travel Δ %, engine vs dispatch', get: (d) => ratioPct(num(d?.est_travel_engine_min), num(d?.est_travel_actual_min)), total: { ratioOf: ['est_travel_engine_min', 'est_travel_actual_min'] }, fmt: 'pct', dir: 'tab-lower' },
  { key: 'matched_load_sequence_score', label: 'Order score on matched loads (0 = dispatch\'s order; stop-weighted)', total: { weight: stops }, fmt: 'score', dir: 'lower' },
  { key: 'tie_margin.stops', label: 'Stops with 2+ possible drivers', get: (d) => tieStops(d), total: 'sum', fmt: 'int' },
  { key: 'tie_margin.mean', label: 'Tie margin, mean', get: (d) => num(d?.tie_margin?.mean), total: { weight: tieStops }, fmt: 'score' },
  { key: 'tie_margin.p50', label: 'Tie margin, median', get: (d) => num(d?.tie_margin?.p50), total: null, fmt: 'score' },
  { key: 'tie_margin.share_lt_05', label: 'Near-tie share (margin < 0.5)', get: (d) => num(d?.tie_margin?.share_lt_05), total: { weight: tieStops }, fmt: 'share' },
  { key: 'tie_margin.share_lt_1', label: 'Share with margin < 1', get: (d) => num(d?.tie_margin?.share_lt_1), total: { weight: tieStops }, fmt: 'share' },
];
// A plan day enters the TOTALS only when both sides scored it: a stop-agreement number and
// planned stops above zero — the same day rule the Engine tab's version cards apply
// (summarizePlanVersion), so a total here means what a card means. It is still shown per day.
const planDayScored = (d) => num(d?.stop_agreement_pct) != null && num(d?.planned_stops) > 0;
export const TABLES = [
  { id: 'sequence', title: 'SEQUENCING — each load dispatch built, re-ordered by the engine (Engine tab › Sequencing; route_proposals_daily)', metrics: SEQUENCE_METRICS, totalsDay: null },
  { id: 'plan', title: 'ASSIGNMENT — the whole day planned by the engine with dispatch\'s crew (Engine tab › Assignment; plan_proposals_daily)', metrics: PLAN_METRICS, totalsDay: (o, n) => planDayScored(o) && planDayScored(n) },
];
const valueOf = (m, d) => (m.get ? m.get(d) : num(d?.[m.key]));

// ── day selection ──────────────────────────────────────────────────────────────────────
export const REASONS = {
  only_before: 'only in the BEFORE file (no new number)',
  only_after: 'only in the AFTER file (no old number — a day first scored after the snapshot)',
  excluded: 'named in --exclude',
  before_already_new: 'the BEFORE file already holds a new-version number (the old one was overwritten before the snapshot)',
  not_rescored: 'not re-scored at the new version yet',
  recaptured: 'history captured or re-sealed after the old score was computed (manifest captured_at later than the old computed_at), so the two scores may have read different stops',
};

export function classifyDays(table, before, after, { exclude, newVersion }) {
  const b = before?.[table] || {}, a = after?.[table] || {};
  const manifests = after?.manifests || {};
  const dates = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((d) => DATE_RE.test(d)).sort();
  const compared = [];
  const left = Object.fromEntries(Object.keys(REASONS).map((k) => [k, []]));
  let captureUnknown = 0;
  for (const date of dates) {
    const oldDoc = b[date], newDoc = a[date];
    if (oldDoc && !newDoc) { left.only_before.push(date); continue; }
    if (!oldDoc && newDoc) { left.only_after.push(date); continue; }
    if (exclude.has(date)) { left.excluded.push(date); continue; }
    if (String(oldDoc.engine_version ?? '') === newVersion) { left.before_already_new.push(date); continue; }
    if (String(newDoc.engine_version ?? '') !== newVersion) { left.not_rescored.push(date); continue; }
    const capturedMs = Date.parse(manifests[date]?.captured_at ?? '');
    const oldScoredMs = Date.parse(oldDoc.computed_at ?? '');
    if (Number.isFinite(capturedMs) && Number.isFinite(oldScoredMs)) {
      if (capturedMs > oldScoredMs) { left.recaptured.push(date); continue; }
    } else {
      captureUnknown++; // cannot tell — compared, and counted in the header so nobody assumes otherwise
    }
    compared.push(date);
  }
  return { compared, left, captureUnknown, progress: replayProgress(table, before, after, newVersion) };
}

// RE-SCORE PROGRESS — has the replay finished? Read from the code, not assumed:
//   • both replays list their dates from the history_days manifests (listCapturedDates /
//     capturedDatesFromManifests), so a day with no manifest is never re-scored by them;
//   • both walk those dates oldest → newest, and the days they skip on purpose — too few
//     earlier reference days (min_prior_reference_days), or for the plan no driver-day
//     history before it — are a run at the FRONT, because both tests only get easier as the
//     date moves later.
// So once a day that was in the BEFORE file is at the new version, every manifest day after
// it that is not at the new version yet is one the replay has still to reach. A day scored
// fresh by the nightly (in the AFTER file only) says nothing about the replay and is not used
// as the starting point.
export function replayProgress(table, before, after, newVersion) {
  const b = before?.[table] || {}, a = after?.[table] || {};
  const manifests = after?.manifests || {};
  const atNew = (d) => String(a[d]?.engine_version ?? '') === newVersion;
  const atNewDates = Object.keys(a).filter(atNew).sort();
  const firstNew = Object.keys(b).filter((d) => atNew(d)).sort()[0] ?? null;
  // Every manifest day counts, a tombstone (no_board) included: the replays' date lists do not
  // filter tombstones out, so the replays reach them too.
  const pending = firstNew
    ? Object.keys(manifests).filter((d) => DATE_RE.test(d) && d > firstNew && !atNew(d)).sort()
    : [];
  const olderUntouched = Object.keys(a).filter((d) => !atNew(d) && manifests[d] && (!firstNew || d < firstNew)).sort();
  const noManifest = Object.keys(a).filter((d) => !atNew(d) && !manifests[d]).sort();
  return {
    at_new: atNewDates.length, first_new: firstNew, pending,
    older_untouched: olderUntouched, no_manifest: noManifest,
    finished: !!firstNew && pending.length === 0,
  };
}

// ── totals ─────────────────────────────────────────────────────────────────────────────
export function totalFor(metric, days, before, after) {
  if (metric.total === null || metric.total === undefined) return { old: null, new: null, days: 0, note: 'per day only — a median does not add up across days' };
  if (metric.total === 'sum') {
    let o = 0, n = 0, k = 0;
    for (const date of days) {
      const vo = valueOf(metric, before[date]), vn = valueOf(metric, after[date]);
      if (vo == null || vn == null) continue;
      o += vo; n += vn; k++;
    }
    return { old: k ? o : null, new: k ? n : null, days: k };
  }
  if (metric.total.ratioOf) {
    const [num_, den_] = metric.total.ratioOf;
    let on = 0, od = 0, nn = 0, nd = 0, k = 0;
    for (const date of days) {
      const a1 = num(before[date]?.[num_]), a2 = num(before[date]?.[den_]);
      const b1 = num(after[date]?.[num_]), b2 = num(after[date]?.[den_]);
      if (a1 == null || a2 == null || b1 == null || b2 == null) continue;
      on += a1; od += a2; nn += b1; nd += b2; k++;
    }
    return { old: k ? ratioPct(on, od) : null, new: k ? ratioPct(nn, nd) : null, days: k };
  }
  const w = metric.total.weight;
  let os = 0, ow = 0, ns = 0, nw = 0, k = 0;
  for (const date of days) {
    const vo = valueOf(metric, before[date]), vn = valueOf(metric, after[date]);
    const wo = w(before[date]), wn = w(after[date]);
    if (vo == null || vn == null || !(wo > 0) || !(wn > 0)) continue;
    os += vo * wo; ow += wo; ns += vn * wn; nw += wn; k++;
  }
  return { old: ow > 0 ? os / ow : null, new: nw > 0 ? ns / nw : null, days: k };
}

export function verdict(metric, oldV, newV) {
  if (oldV == null || newV == null || !metric.dir) return null;
  const eps = 1e-9;
  if (Math.abs(newV - oldV) <= eps) return 'same';
  const up = newV > oldV;
  if (metric.dir === 'lower') return up ? 'further from dispatch' : 'closer to dispatch';
  if (metric.dir === 'higher') return up ? 'closer to dispatch' : 'further from dispatch';
  if (metric.dir === 'tab-lower') return up ? 'higher (the Engine tab reads lower as better)' : 'lower (the Engine tab reads lower as better)';
  return null;
}

function engineConfigDiff(before, after) {
  const skip = new Set(['updated_at', 'updatedBy', 'updated_by']);
  const b = before?.engine_config_stored || {}, a = after?.engine_config_stored || {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.has(k)).sort();
  const out = [];
  for (const k of keys) {
    const vb = JSON.stringify(b[k] ?? null), va = JSON.stringify(a[k] ?? null);
    if (vb !== va) out.push({ key: k, before: b[k] ?? null, after: a[k] ?? null });
  }
  return out;
}

export function validateSnapshot(s, which) {
  if (!s || s.kind !== SNAPSHOT_KIND) throw new Error(`${which} is not an engine replay snapshot (kind ${JSON.stringify(s?.kind)})`);
  if (s.schema !== SNAPSHOT_SCHEMA) throw new Error(`${which} has schema ${s.schema}; this compare reads schema ${SNAPSHOT_SCHEMA}`);
  for (const k of ['sequence', 'plan', 'manifests']) {
    if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) throw new Error(`${which} has no ${k} table`);
  }
  if (!Number.isFinite(Date.parse(s.taken_at))) throw new Error(`${which} has no readable taken_at`);
}

export function parseExclude(list) {
  const out = new Set();
  for (const chunk of list || []) {
    for (const raw of String(chunk).split(',')) {
      const d = raw.trim();
      if (!d) continue;
      if (!DATE_RE.test(d)) throw new Error(`--exclude: "${d}" is not a YYYY-MM-DD date`);
      out.add(d);
    }
  }
  return out;
}

/** PURE: the whole comparison as data. */
export function compareSnapshots(before, after, { exclude = new Set(), newVersion = ENGINE_VERSION } = {}) {
  validateSnapshot(before, 'the BEFORE file');
  validateSnapshot(after, 'the AFTER file');
  for (const k of ['project', 'database', 'tenant']) {
    if (String(before[k]) !== String(after[k])) throw new Error(`the two files are from different ${k}s (${before[k]} vs ${after[k]})`);
  }
  if (Date.parse(after.taken_at) < Date.parse(before.taken_at)) {
    throw new Error(`the AFTER file (${after.taken_at}) was taken before the BEFORE file (${before.taken_at}) — are they swapped?`);
  }
  const tables = TABLES.map((t) => {
    const sel = classifyDays(t.id, before, after, { exclude, newVersion });
    const b = before[t.id], a = after[t.id];
    const oldVersions = {};
    for (const d of sel.compared) { const v = String(b[d]?.engine_version ?? '(none)'); oldVersions[v] = (oldVersions[v] || 0) + 1; }
    const totalDays = t.totalsDay ? sel.compared.filter((d) => t.totalsDay(b[d], a[d])) : sel.compared;
    const notTotalled = sel.compared.filter((d) => !totalDays.includes(d));
    const totals = t.metrics.map((m) => {
      const tot = totalFor(m, totalDays, b, a);
      return { key: m.key, label: m.label, fmt: m.fmt, ...tot, change: tot.old != null && tot.new != null ? tot.new - tot.old : null, verdict: verdict(m, tot.old, tot.new) };
    });
    // Mixed old versions: each gets its own totals, so a 2.12.x day never hides inside a 2.13.0 total.
    const byOldVersion = Object.keys(oldVersions).length > 1
      ? Object.fromEntries(Object.keys(oldVersions).sort().map((v) => {
        const ds = totalDays.filter((d) => String(b[d]?.engine_version ?? '(none)') === v);
        return [v, t.metrics.map((m) => ({ key: m.key, ...totalFor(m, ds, b, a) }))];
      }))
      : null;
    const days = sel.compared.map((date) => ({
      date,
      old_version: b[date]?.engine_version ?? null, old_computed_at: b[date]?.computed_at ?? null,
      new_version: a[date]?.engine_version ?? null, new_computed_at: a[date]?.computed_at ?? null,
      values: t.metrics.map((m) => {
        const o = valueOf(m, b[date]), n = valueOf(m, a[date]);
        return { key: m.key, old: o, new: n, change: o != null && n != null ? n - o : null, verdict: verdict(m, o, n) };
      }),
    }));
    return { id: t.id, title: t.title, compared: sel.compared.length, not_totalled: notTotalled, left: sel.left, capture_unknown: sel.captureUnknown, progress: sel.progress, old_versions: oldVersions, totals, by_old_version: byOldVersion, days };
  });
  // The version cards worth showing are the ones for the OLD versions actually compared.
  const cmpVersion = (x, y) => {
    const px = String(x).split('.').map((n) => parseInt(n, 10) || 0), py = String(y).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(px.length, py.length); i++) if ((px[i] || 0) !== (py[i] || 0)) return (px[i] || 0) - (py[i] || 0);
    return 0;
  };
  const comparedOld = new Set(tables.flatMap((t) => Object.keys(t.old_versions)));
  const oldRollupVersions = Object.keys(before.version_rollups || {}).filter((v) => comparedOld.has(v)).sort(cmpVersion);
  return {
    new_version: newVersion,
    before: { taken_at: before.taken_at, reads: before.reads ?? null },
    after: { taken_at: after.taken_at, reads: after.reads ?? null },
    excluded_by_flag: [...exclude].sort(),
    tables,
    version_cards: {
      before: oldRollupVersions.map((v) => before.version_rollups[v]),
      after_new: after.version_rollups?.[newVersion] ?? null,
    },
    engine_config_changes: engineConfigDiff(before, after),
    finished: tables.every((t) => t.progress.finished),
  };
}

// ── text ───────────────────────────────────────────────────────────────────────────────
export function fmt(v, kind) {
  if (v == null) return '—';
  switch (kind) {
    case 'int': return Math.round(v).toLocaleString('en-US');
    case 'pct': return v.toFixed(1);
    case 'min': return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case 'share': return v.toFixed(3);
    default: return v.toFixed(4);
  }
}
function fmtChange(v, kind) {
  if (v == null) return '—';
  const s = fmt(Math.abs(v), kind);
  if (Number(s.replace(/,/g, '')) === 0) return '0';
  return `${v > 0 ? '+' : '−'}${s}`;
}
const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const lpad = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));

export function formatReport(r) {
  const L = [];
  L.push(`ENGINE RE-SCORE — old numbers vs ${r.new_version}`);
  L.push(`  old: the BEFORE file, taken ${r.before.taken_at}`);
  L.push(`  new: the AFTER file, taken ${r.after.taken_at}`);
  if (r.excluded_by_flag.length) L.push(`  --exclude: ${r.excluded_by_flag.join(', ')}`);
  L.push(r.finished
    ? '  Re-score: FINISHED on both replays — every captured day after the first re-scored one is at the new version.'
    : '  Re-score: NOT FINISHED — see RE-SCORE PROGRESS under each replay; run that replay again, then take a new AFTER file.');
  if (r.engine_config_changes.length) {
    L.push('  ⚠ The stored engine settings changed between the two files, so old vs new mixes the version change with these:');
    for (const c of r.engine_config_changes) L.push(`      ${c.key}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  } else {
    L.push('  Stored engine settings (routing_engine_config): the same in both files. (Netlify env settings are not visible to this compare.)');
  }
  for (const t of r.tables) {
    L.push('');
    L.push(t.title);
    const versions = Object.entries(t.old_versions).map(([v, n]) => `${v} ×${n}`).join(', ') || 'none';
    L.push(`  ${t.compared} day(s) compared; old version(s): ${versions}`);
    if (t.not_totalled.length) L.push(`  ${t.not_totalled.length} of them are shown per day but left out of the totals — one side has no stop-agreement score or no planned stops, the days the version cards leave out too: ${t.not_totalled.join(', ')}`);
    if (t.capture_unknown) L.push(`  ${t.capture_unknown} compared day(s) have no readable capture time or old computed_at, so a re-capture could not be ruled out for them.`);
    for (const [k, list] of Object.entries(t.left)) if (list.length) L.push(`  left out, ${REASONS[k]}: ${list.length} — ${list.join(', ')}`);
    L.push(`  RE-SCORE PROGRESS: ${t.progress.finished ? 'finished' : t.progress.first_new ? 'NOT finished' : 'NOT STARTED — no day from the BEFORE file is at the new version yet'}`);
    L.push(`    ${t.progress.at_new} day(s) in the AFTER file are at ${r.new_version}${t.progress.first_new ? `; the replay's first re-scored day is ${t.progress.first_new}` : ''}.`);
    if (t.progress.pending.length) L.push(`    ${t.progress.pending.length} captured day(s) after that are not at ${r.new_version} yet — the replay has still to reach them: ${t.progress.pending.join(', ')}`);
    if (t.progress.older_untouched.length) L.push(`    ${t.progress.older_untouched.length} day(s) before the first re-scored day stay at an old version — the replay skips days too early to judge: ${t.progress.older_untouched.join(', ')}`);
    if (t.progress.no_manifest.length) L.push(`    ${t.progress.no_manifest.length} day(s) stay at an old version because history_days has no manifest for them, and the replays only list manifest days: ${t.progress.no_manifest.join(', ')}`);
    L.push(`  ${pad('TOTAL over the compared days', 74)} ${lpad('old', 11)}  ${lpad('new', 11)}  ${lpad('change', 10)}`);
    for (const m of t.totals) {
      const line = `    ${pad(m.label, 72)} ${lpad(fmt(m.old, m.fmt), 11)}  ${lpad(fmt(m.new, m.fmt), 11)}  ${lpad(fmtChange(m.change, m.fmt), 10)}`;
      const tail = m.note ? `  (${m.note})` : `${m.verdict ? `  ${m.verdict}` : ''}${m.days ? `  [${m.days} day(s)]` : ''}`;
      L.push(line + tail);
    }
    if (t.by_old_version) {
      L.push('  TOTAL by OLD version (the old side mixes versions):');
      const metricByKey = Object.fromEntries(TABLES.find((x) => x.id === t.id).metrics.map((m) => [m.key, m]));
      for (const [v, rows] of Object.entries(t.by_old_version)) {
        L.push(`    old ${v}:`);
        for (const row of rows) {
          if (row.old == null && row.new == null) continue;
          const m = metricByKey[row.key];
          L.push(`      ${pad(m.label, 70)} ${lpad(fmt(row.old, m.fmt), 11)}  ${lpad(fmt(row.new, m.fmt), 11)}  [${row.days} day(s)]`);
        }
      }
    }
    L.push('  PER DAY');
    const metricByKey = Object.fromEntries(TABLES.find((x) => x.id === t.id).metrics.map((m) => [m.key, m]));
    for (const d of t.days) {
      L.push(`    ${d.date}   old ${d.old_version ?? '?'} (scored ${d.old_computed_at ?? '?'})   new ${d.new_version ?? '?'} (scored ${d.new_computed_at ?? '?'})`);
      for (const v of d.values) {
        const m = metricByKey[v.key];
        if (v.old == null && v.new == null) continue;
        L.push(`      ${pad(m.label, 70)} ${lpad(fmt(v.old, m.fmt), 11)}  ${lpad(fmt(v.new, m.fmt), 11)}  ${lpad(fmtChange(v.change, m.fmt), 10)}${v.verdict ? `  ${v.verdict}` : ''}`);
      }
    }
  }
  L.push('');
  L.push('VERSION CARDS — the Engine tab\'s own per-version totals, each over that version\'s WHOLE window (not limited to the compared days):');
  if (!r.version_cards.before.length) L.push('  The BEFORE file has no version card for the old version(s) compared.');
  for (const c of r.version_cards.before) {
    L.push(`  ${c.engine_version} (BEFORE file): ${c.days_scored ?? '?'} day(s) ${c.window_from ?? '?'} … ${c.window_to ?? '?'} — stop agreement ${fmt(num(c.stop_agreement_wmean), 'pct')}%, co-load ${fmt(num(c.coload_agreement_wmean), 'pct')}%, trips Δ ${fmt(num(c.trips_delta_pct), 'pct')}%, travel Δ ${fmt(num(c.travel_delta_pct), 'pct')}%`);
  }
  const n = r.version_cards.after_new;
  L.push(n
    ? `  ${n.engine_version} (AFTER file): ${n.days_scored ?? '?'} day(s) ${n.window_from ?? '?'} … ${n.window_to ?? '?'} — stop agreement ${fmt(num(n.stop_agreement_wmean), 'pct')}%, co-load ${fmt(num(n.coload_agreement_wmean), 'pct')}%, trips Δ ${fmt(num(n.trips_delta_pct), 'pct')}%, travel Δ ${fmt(num(n.travel_delta_pct), 'pct')}%`
    : `  ${r.new_version}: no version card in the AFTER file yet.`);
  return L.join('\n');
}

export function parseArgs(argv) {
  const out = { exclude: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    if (a === '--before') out.before = val();
    else if (a === '--after') out.after = val();
    else if (a === '--exclude') out.exclude.push(val());
    else if (a === '--new-version') out.newVersion = val();
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.before || !out.after) throw new Error('--before <file> and --after <file> are both required');
  if (out.newVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(out.newVersion)) throw new Error(`--new-version: "${out.newVersion}" is not x.y.z`);
  return out;
}

export function runCli(argv, { readFile = readFileSync, out = console.log, err = console.error } = {}) {
  let args, before, after, exclude;
  try {
    args = parseArgs(argv);
    exclude = parseExclude(args.exclude);
    before = JSON.parse(readFile(args.before, 'utf8'));
    after = JSON.parse(readFile(args.after, 'utf8'));
  } catch (e) { err(`✗ ${e.message}`); return 2; }
  let result;
  try {
    result = compareSnapshots(before, after, { exclude, newVersion: args.newVersion ?? ENGINE_VERSION });
  } catch (e) { err(`✗ ${e.message}`); return 2; }
  out(args.json ? JSON.stringify(result, null, 1) : formatReport(result));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = runCli(process.argv.slice(2));
}
