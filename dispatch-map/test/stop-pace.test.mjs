// test/stop-pace.test.mjs — THE PACE DIGEST: one board day, reduced to when it was delivered.
//
// Chad, 2026-09-30: "track the number of stops that we've done compared to other days or like
// the daily average at that point in time to let us know if we're behind or ahead of schedule."
//
// These pin the three things that would make that line lie: a count that disagrees with the 6:30
// report, a delivery placed at a minute it did not happen, and a day compared at a minute its
// board does not know yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPaceDigest, stampMinute, countsOnDay, isoWeekday, etClockOf, boardAsOfMinute, paceSummaryOf,
  PACE_STOP_FIELDS, PACE_SUMMARY_FIELDS, PACE_BUCKETS, PACE_BUCKET_MIN,
} from '../netlify/functions/lib/stop-pace.mts';
import { buildDayCompletion } from '../netlify/functions/lib/day-completion.mts';
import {
  stopPaceEnabled, writePaceDigest, paceDigestPath, readPaceDays, PACE_COLLECTION,
} from '../netlify/functions/lib/stop-pace-store.mts';
import { resolvePerformanceQuery, classifyWarehouse } from '../netlify/functions/stop-performance.mts';

const DATE = '2026-09-29';   // a Tuesday
const stop = (over = {}) => ({
  stopNbr: `S${Math.random().toString(36).slice(2, 8)}`, loadNbr: 'SUW 1', routeName: 'SUW 1',
  driverName: 'Joe Gibbs', isPlanned: true, status: '20', ...over,
});
const delivered = (hhmm, over = {}) => stop({ status: '90', normalizedStatus: 'DELIVERED', deliveredDTTM: `${DATE}T${hhmm}`, ...over });
const excludeRoutes = ['CHAD'];
const digest = (stops, o = {}) => buildPaceDigest(stops, { date: DATE, builtAt: '2026-09-30T06:00:00Z', excludeRoutes, ...o });
const sumCurve = (c) => c.reduce((a, b) => a + b, 0);

// ── the minute a delivery happened ───────────────────────────────────────────

test('a 90 at 9:12a and a 91 at 4:40p land in their own 5-minute buckets, and both are deliveries', () => {
  const d = digest([delivered('09:12'), delivered('16:40', { status: '91' })]);
  assert.equal(d.delivered, 2);
  assert.equal(d.timed, 2);
  assert.equal(d.curve.length, PACE_BUCKETS);
  assert.equal(d.curve[Math.floor((9 * 60 + 12) / PACE_BUCKET_MIN)], 1, '9:12 sits in the 9:10–9:14 bucket');
  assert.equal(d.curve[Math.floor((16 * 60 + 40) / PACE_BUCKET_MIN)], 1);
  assert.equal(d.counts.delivered_manual, 1, 'the hand-close is still counted as one, for the table');
  assert.equal(d.firstMin, 9 * 60 + 12);
  assert.equal(d.lastMin, 16 * 60 + 40);
});

test('a delivery stamped on ANOTHER day is untimed — never "20 minutes past midnight" on this one', () => {
  // Delivered 00:20 the next morning, on this board. Read as a minute of today it would sit at
  // the very start of the curve and make every early morning look ahead.
  const d = digest([delivered('10:00'), stop({ status: '90', deliveredDTTM: '2026-09-30T00:20' })]);
  assert.equal(d.delivered, 2, 'still a delivery, still counted');
  assert.equal(d.timed, 1);
  assert.equal(d.untimed, 1, 'and SAID, not placed');
  assert.equal(sumCurve(d.curve), 1);
  assert.equal(stampMinute('2026-09-30T00:20', DATE), null);
});

test('a delivery with no stamp at all is untimed, not a lump at a made-up minute', () => {
  const d = digest([delivered('10:00'), stop({ status: '90' })]);
  assert.equal(d.delivered, 2);
  assert.equal(d.untimed, 1);
  assert.equal(sumCurve(d.curve), 1);
});

test('a stamp that CARRIES a zone is read in Eastern — 13:12Z in September is 9:12a, not 1:12p', () => {
  // The board writes naive Eastern wall-clock text; the /stop/info copy can carry an offset.
  // finishedAt (load-lookup.js) converts only a zoned stamp. Parsed naively this would move the
  // delivery four hours and put a morning run in the afternoon.
  const d = digest([stop({ status: '90', 'raw': { stopExecutionInfo: { to: { deliveredDTTM: '2026-09-29T13:12:00Z' } } } })]);
  assert.equal(d.timed, 1);
  assert.equal(d.firstMin, 9 * 60 + 12);
});

test('the warehouse copy of the stamp (executed.deliveredDTTM) is read when the top-level one is gone', () => {
  const d = digest([stop({ status: '90', executed: { deliveredDTTM: `${DATE}T14:05`, stopStatus: '90' } })]);
  assert.equal(d.timed, 1);
  assert.equal(d.firstMin, 14 * 60 + 5);
});

// ── the count is the 6:30 report's count ─────────────────────────────────────

const MIXED = () => [
  delivered('08:05'), delivered('08:40'), delivered('11:15', { status: '91' }),
  delivered('13:30', { loadNbr: 'GAINESVILLE', routeName: 'GAINESVILLE', driverName: 'Brent' }),
  stop({ status: '90', loadNbr: 'GAINESVILLE', routeName: 'GAINESVILLE' }),                   // untimed
  stop({ status: '50', arrivalDTTM: `${DATE}T12:00` }),                                         // in flight
  stop({ status: '20' }),                                                                       // not attempted
  stop({ status: '80', loadNbr: 'GAINESVILLE', routeName: 'GAINESVILLE' }),                     // unable
  stop({ status: '99' }),                                                                       // cancelled
  delivered('09:00', { loadNbr: 'CHAD', routeName: 'CHAD' }),                                   // the owner's route
  delivered('09:30', { loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' }),                       // a holding pen
  stop({ isPlanned: false, loadNbr: null, routeName: null, status: '10' }),                     // unplanned
  delivered('10:10', { closedOnBoard: '2026-09-30' }),                                          // finished on a later board
];

test('PARITY: stamped + unstamped deliveries equal the 6:30 report\'s delivered count, route by route', () => {
  const stops = MIXED();
  const report = buildDayCompletion(stops, { date: DATE, excludeRoutes });
  const d = digest(stops);
  assert.equal(d.delivered, report.delivered);
  assert.equal(d.timed + d.untimed, report.delivered, 'every delivery the report counts is either on the curve or said to be off it');
  assert.equal(d.planned, report.planned);
  assert.equal(d.gradable, report.gradable);
  assert.equal(d.open, report.open);
  assert.deepEqual(d.counts, report.counts);
  assert.equal(d.completionRate, report.completionRate);
  for (const r of report.byRoute) {
    const mine = d.routes.find((x) => x.route === r.route);
    assert.ok(mine, `route ${r.route} is in the digest`);
    assert.equal(mine.delivered, r.delivered, `${r.route}: delivered`);
    assert.equal(mine.planned, r.planned, `${r.route}: planned`);
    assert.equal(mine.open, r.open, `${r.route}: open`);
  }
});

test('CHAD and ULINE APPT are left out of every number — and counted, so the total can be reconciled', () => {
  const d = digest(MIXED());
  assert.equal(d.excluded, 2);
  assert.ok(!d.routes.some((r) => r.route === 'CHAD' || r.route === 'ULINE APPT'));
  // 9:00 and 9:30 were theirs — neither is on the curve.
  assert.equal(d.curve[Math.floor(540 / PACE_BUCKET_MIN)], 0);
  assert.equal(d.curve[Math.floor(570 / PACE_BUCKET_MIN)], 0);
});

test('an unplanned stop is on nobody\'s truck and never counts; a copy closed on a later board counts there, not here', () => {
  const d = digest(MIXED());
  assert.equal(d.closedElsewhere, 1);
  assert.equal(countsOnDay({ isPlanned: false, status: '10' }, DATE, excludeRoutes), false);
  assert.equal(countsOnDay(stop({ closedOnBoard: '2026-09-30' }), DATE, excludeRoutes), false);
  assert.equal(countsOnDay(stop({ closedOnBoard: DATE }), DATE, excludeRoutes), true, 'closed on its own board is its own board');
  assert.equal(d.curve[Math.floor(610 / PACE_BUCKET_MIN)], 0, 'the 10:10 on the later board is not placed on this curve');
});

test('each route keeps its first and last delivery and how many it closed by hand', () => {
  const d = digest(MIXED());
  const suw = d.routes.find((r) => r.route === 'SUW 1');
  assert.equal(suw.firstMin, 8 * 60 + 5);
  assert.equal(suw.lastMin, 11 * 60 + 15);
  assert.equal(suw.manual, 1);
  const g = d.routes.find((r) => r.route === 'GAINESVILLE');
  assert.equal(g.delivered, 2);
  assert.equal(g.firstMin, 13 * 60 + 30, 'the untimed delivery does not invent a first minute');
  assert.equal(g.unable, 1);
});

test('half done and nine-in-ten done are minutes of REAL deliveries (nearest rank), never an average of two', () => {
  const d = digest(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'].map((t) => delivered(t)));
  assert.equal(d.halfMin, 12 * 60, 'the 5th of 10');
  assert.equal(d.p90Min, 16 * 60, 'the 9th of 10');
  const one = digest([delivered('09:42')]);
  assert.equal(one.halfMin, 9 * 60 + 42);
});

test('an empty board is a digest of zeros with no minutes — not a throw', () => {
  const d = digest([]);
  assert.equal(d.delivered, 0);
  assert.equal(d.timed, 0);
  assert.equal(d.firstMin, null);
  assert.equal(d.halfMin, null);
  assert.equal(d.completionRate, null, 'a day with nothing gradable has no rate, not 0%');
  assert.equal(sumCurve(d.curve), 0);
  assert.throws(() => buildPaceDigest([], { date: 'yesterday' }), /not a day id/);
});

test('the weekday is ISO: Monday 1 … Sunday 7, read off the digits', () => {
  assert.equal(isoWeekday('2026-09-28'), 1);
  assert.equal(isoWeekday('2026-09-29'), 2);
  assert.equal(isoWeekday('2026-10-04'), 7);
  assert.equal(digest([]).weekday, 2);
});

// ── the mask loses nothing ───────────────────────────────────────────────────

/** What Firestore's field mask returns: only the listed paths, nested ones as nested objects. */
function mask(record, paths) {
  const out = {};
  for (const p of paths) {
    const parts = p.split('.');
    let src = record;
    for (const k of parts) src = src == null ? undefined : src[k];
    if (src === undefined) continue;
    let dst = out;
    for (let i = 0; i < parts.length - 1; i++) dst = dst[parts[i]] ??= {};
    dst[parts[parts.length - 1]] = src;
  }
  return out;
}

test('PACE_STOP_FIELDS carries every field the digest reads — the masked read and the full record agree', () => {
  // The live board and the warehouse are both read through this mask. A field the builder reads
  // but the mask drops is ALWAYS undefined on those reads: the digest would quietly change shape
  // between the nightly hook (handed full records) and the rebuild (masked).
  const full = [
    ...MIXED().map((s) => ({ ...s, businessName: 'ACME', addr1: '1 Main', city: 'Buford', lat: 34, lng: -84, raw: { stop: { big: 'x'.repeat(50) } } })),
    { stopNbr: 'W1', loadNbr: 'SUW 1', isPlanned: true, executed: { stopStatus: '90', deliveredDTTM: `${DATE}T15:15`, arrivalDTTM: `${DATE}T15:00` } },
    { stopNbr: 'W2', loadNbr: 'SUW 1', isPlanned: true, status: '90', raw: { stopExecutionInfo: { to: { deliveredDTTM: '2026-09-29T19:30:00Z' } } } },
  ];
  const masked = full.map((s) => mask(s, PACE_STOP_FIELDS));
  const a = digest(full); const b = digest(masked);
  assert.deepEqual({ ...b, builtAt: null }, { ...a, builtAt: null });
});

test('the summary is the digest without its curve and route rows — what a trend reads', () => {
  const d = digest(MIXED());
  const s = paceSummaryOf(d);
  assert.equal(s.curve, undefined);
  assert.equal(s.routes, undefined);
  for (const k of PACE_SUMMARY_FIELDS) assert.ok(k in s, `${k} is in the summary`);
});

// ── the minute today is compared at ──────────────────────────────────────────

test('etClockOf reads Eastern through both DST changes', () => {
  assert.deepEqual(etClockOf('2026-09-29T15:12:00Z'), { date: '2026-09-29', minute: 11 * 60 + 12 }, 'EDT, UTC−4');
  assert.deepEqual(etClockOf('2026-12-01T15:12:00Z'), { date: '2026-12-01', minute: 10 * 60 + 12 }, 'EST, UTC−5');
  assert.deepEqual(etClockOf('2026-09-30T02:30:00Z'), { date: '2026-09-29', minute: 22 * 60 + 30 }, 'late evening ET is still the ET day');
  assert.equal(etClockOf('not a time'), null);
  assert.equal(etClockOf(null), null);
});

test('the board is compared at its LAST SCAN dated today — not the wall clock, and never yesterday\'s scan', () => {
  const meta = {
    last_scanned_at: '2026-09-29T14:40:00Z',            // 10:40a planned pull
    lastCompletedScanAt: '2026-09-29T15:10:00Z',        // 11:10a completed overlay — the latest
    lastLoadScanAt: '2026-09-28T23:00:00Z',             // yesterday evening's roster
  };
  assert.deepEqual(boardAsOfMinute(meta, DATE), { minute: 11 * 60 + 10, at: '2026-09-29T15:10:00Z' });
  assert.equal(boardAsOfMinute({ lastCompletedScanAt: '2026-09-28T21:00:00Z' }, DATE), null, 'nothing has scanned today yet');
  assert.equal(boardAsOfMinute(null, DATE), null);
});

// ── the store and the switch ─────────────────────────────────────────────────

test('STOP_PACE: an explicit off-word turns it off; anything else — a typo included — leaves it on', () => {
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(stopPaceEnabled({ STOP_PACE: v }), false, v);
  for (const v of [undefined, '', 'on', '1', 'of', 'nope']) assert.equal(stopPaceEnabled({ STOP_PACE: v }), true, String(v));
});

test('a day\'s digest is ONE whole document at pace_days/davis__DATE, and a bad day id writes nothing', async () => {
  const writes = [];
  const io = { setDoc: async (path, data) => { writes.push({ path, data }); return true; } };
  const r = await writePaceDigest('davis', DATE, MIXED(), io, '2026-09-30T06:00:00Z');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `${PACE_COLLECTION}/davis__${DATE}`);
  assert.equal(writes[0].path, paceDigestPath('davis', DATE));
  assert.equal(writes[0].data.source, 'sealed');
  assert.equal(writes[0].data.builtAt, '2026-09-30T06:00:00Z');
  assert.equal(r.delivered, writes[0].data.delivered);
  assert.ok(r.bytes < 20000, `a day is small (${r.bytes} bytes)`);
  await assert.rejects(() => writePaceDigest('davis', '2026-9-29', [], io), /not a day id/);
  assert.equal(writes.length, 1);
});

test('reading a range: this tenant only, each day once, inside the range, oldest first', async () => {
  const docs = [
    { _id: 'davis__2026-09-29', date: '2026-09-29', delivered: 5 },
    { _id: 'davis__2026-09-28', date: '2026-09-28', delivered: 4 },
    { _id: 'davis__2026-09-29', date: '2026-09-29', delivered: 5 },          // twice (month windows overlap)
    { _id: 'other__2026-09-29', date: '2026-09-29', delivered: 99 },         // another tenant
    { _id: 'davis__2026-08-01', date: '2026-08-01', delivered: 1 },          // outside the range
  ];
  const queries = [];
  const rows = await readPaceDays('davis', '2026-09-01', '2026-09-30', undefined, { runQuery: async (q) => { queries.push(q); return docs; } });
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-28', '2026-09-29']);
  assert.equal(rows[0]._id, undefined);
  assert.equal(queries[0].from[0].collectionId, PACE_COLLECTION);
  assert.ok(queries[0].select.fields.some((f) => f.fieldPath === 'delivered'));
  assert.ok(!queries[0].select.fields.some((f) => f.fieldPath === 'curve'), 'a trend read never drags 288 buckets a day along');
  assert.deepEqual(await readPaceDays('davis', '2026-09-30', '2026-09-01', undefined, { runQuery: async () => docs }), [], 'a backwards range reads nothing');
});

test('THE NIGHTLY HOOK IS REGISTERED — before the search digest, which stays last — and behind its switch', () => {
  const PS = readFileSync(new URL('../netlify/functions/lib/history-postseal.mts', import.meta.url), 'utf8');
  const hooks = PS.slice(PS.indexOf('const HOOKS'), PS.indexOf('];', PS.indexOf('const HOOKS')));
  const names = [...hooks.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.includes('stop-pace'));
  assert.equal(names[names.length - 1], 'stop-search');
  assert.equal(names[names.length - 2], 'stop-pace');
  const STORE = readFileSync(new URL('../netlify/functions/lib/stop-pace-store.mts', import.meta.url), 'utf8');
  assert.match(STORE, /if \(!stopPaceEnabled\(\)\) return \{ skipped: 'STOP_PACE=off' \};/);
});

test('NO NUVIZZ ON ANY PATH: the endpoint, the rebuild and both libraries import nothing that can reach it', () => {
  for (const f of ['netlify/functions/stop-performance.mts', 'netlify/functions/stop-pace-rebuild.mts', 'netlify/functions/lib/stop-pace.mts', 'netlify/functions/lib/stop-pace-store.mts']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from '[^']*nuvizz[^']*'/i, `${f} imports a NuVizz module`);
    assert.doesNotMatch(src, /scanDate|nuvizzFetch|nuvizz-request/, `${f} names a NuVizz call`);
  }
});

// ── the endpoint's arithmetic ────────────────────────────────────────────────

const params = (o) => new URLSearchParams(o);

test('the query: 30 days ending today by default; a future end, a reversed range and an over-long one are clamped AND said', () => {
  assert.deepEqual(resolvePerformanceQuery(params({}), '2026-09-30'), { from: '2026-09-01', to: '2026-09-30', pool: 40, day: null, clamped: null });
  assert.equal(resolvePerformanceQuery(params({ to: '2026-10-05' }), '2026-09-30').to, '2026-09-30');
  assert.equal(resolvePerformanceQuery(params({ to: '2026-10-05' }), '2026-09-30').clamped, 'to-after-today');
  const rev = resolvePerformanceQuery(params({ from: '2026-09-20', to: '2026-09-10' }), '2026-09-30');
  assert.deepEqual([rev.from, rev.to, rev.clamped], ['2026-09-10', '2026-09-20', 'reversed']);
  const long = resolvePerformanceQuery(params({ from: '2020-01-01', to: '2026-09-30' }), '2026-09-30');
  assert.equal(long.clamped, 'range-too-long');
  assert.equal(long.to, '2026-09-30');
  assert.equal(resolvePerformanceQuery(params({ pool: '999' }), '2026-09-30').pool, 60);
  assert.equal(resolvePerformanceQuery(params({ pool: '1' }), '2026-09-30').pool, 8);
  assert.equal(resolvePerformanceQuery(params({ day: '2026-10-01' }), '2026-09-30').day, null, 'a day that has not happened has no detail');
  assert.equal(resolvePerformanceQuery(params({ day: '2026-09-02' }), '2026-09-30').day, '2026-09-02');
  assert.equal(resolvePerformanceQuery(params({ from: '2026-02-30' }), '2026-09-30').from, '2026-09-01', 'a date that is not on the calendar falls back');
});

test('the warehouse: sealed days, days Davis did not run, and WEEKDAYS with no record at all — weekends are never "uncaptured"', () => {
  const m = (date, o = {}) => ({ _id: `davis__${date}`, date, complete: true, ...o });
  const wh = classifyWarehouse([
    m('2026-09-21'), m('2026-09-22'),
    m('2026-09-24', { no_board: true, complete: false }),    // a tombstone: no board that day
    m('2026-09-25', { complete: false, verified: false }),   // started, never sealed
    { _id: 'uat__2026-09-23', date: '2026-09-23', complete: true },
  ], '2026-09-21', '2026-09-27');
  assert.deepEqual(wh.sealed, ['2026-09-21', '2026-09-22']);
  assert.deepEqual(wh.noBoard, ['2026-09-24']);
  assert.deepEqual(wh.uncaptured, ['2026-09-23', '2026-09-25'], 'Sat 26 and Sun 27 are not on the list');
});
