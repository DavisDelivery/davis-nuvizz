// test/active-pool.test.mjs — the open-order pool and the date-window reconcile, pinned to the
// orders that exposed the bug on 2026-09-07 (Routing window 550 unplanned vs Workbench 525).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildActivePool, projectPoolRow, mergeWindowWithPool, pruneWithSnapshot, isTerminalRow, rowDayOf, poolUsable,
} from '../netlify/functions/lib/active-pool.mts';

const POOL_AT = '2026-09-07T15:15:14.301Z';
const row = (over = {}) => ({
  stopNbr: '007170166-1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true,
  loadNbr: null, routeName: null, driverName: null, businessName: 'H&H WORLD GROUP', addr1: '733 PLEASANT HILL ROAD',
  city: 'LILBURN', zip: '30047', weight: 573, cartons: 1, volume: 0, boardDate: '2026-09-01', scheduledDate: '2026-09-01',
  lat: 33.88, lng: -84.14, stopId: '6a9700cd1fe1b7a7d55fa05a', enriched: true, raw: { big: 'x'.repeat(50) },
  ...over,
});
const pool = (rows, over = {}) => ({ at: POOL_AT, windowStart: '2026-08-31', windowEnd: '2026-09-14', count: rows.length, rows, ...over });
const WIN = { from: '2026-09-01', to: '2026-09-08' };

test('isTerminalRow: delivered, refused (80), cancelled (99) are finished; 10/20/40/50 are open', () => {
  assert.equal(isTerminalRow({ status: '90' }), true);
  assert.equal(isTerminalRow({ status: '80' }), true);
  assert.equal(isTerminalRow({ status: '99', normalizedStatus: 'EXCEPTION' }), true);
  assert.equal(isTerminalRow({ normalizedStatus: 'DELIVERED' }), true);
  for (const c of ['10', '20', '40', '50']) assert.equal(isTerminalRow({ status: c, normalizedStatus: 'SCHEDULED' }), false, c);
  assert.equal(isTerminalRow(null), false);
});

test('rowDayOf: the doc day first, then scheduled, then requested; junk is null', () => {
  assert.equal(rowDayOf({ boardDate: '2026-09-01', scheduledDate: '2026-09-02' }), '2026-09-01');
  assert.equal(rowDayOf({ scheduledDate: '2026-09-02' }), '2026-09-02');
  assert.equal(rowDayOf({ requestedDate: '2026-09-03' }), '2026-09-03');
  assert.equal(rowDayOf({ boardDate: 'tomorrow' }), null);
});

test('projectPoolRow: compact — live + static fields, no raw object, comments clipped, day pinned', () => {
  const p = projectPoolRow(row({ orderInstructions: 'y'.repeat(1000) }), '2026-09-01');
  assert.equal(p.day, '2026-09-01');
  assert.equal(p.boardDate, '2026-09-01');
  assert.equal(p.scheduledDate, '2026-09-01');
  assert.equal(p.raw, undefined, 'the raw NuVizz object never rides the pool');
  assert.equal(p.lat, undefined, 'coordinates are the cache\'s, not the pool\'s');
  assert.ok(p.orderInstructions.length <= 401);
  assert.equal(p.pro, '007170166-1');
  assert.deepEqual(p.pros, ['007170166-1']);
  assert.equal(p.source, 'active-pool');
  assert.equal(p.stopId, '6a9700cd1fe1b7a7d55fa05a');
});

test('buildActivePool: every OPEN row across every bucket day; delivered rows stay out; first filing wins', () => {
  const buckets = new Map([
    ['2026-09-01', [row(), row({ stopNbr: '007170329', status: '90', normalizedStatus: 'DELIVERED' })]],
    ['2026-09-09', [row({ stopNbr: 'ESTES-0408710336', businessName: 'MARIA SIMS' }), row()]],  // duplicate nbr on a later day
    ['not-a-day', [row({ stopNbr: 'JUNK' })]],
  ]);
  const p = buildActivePool(buckets, { at: POOL_AT, windowStart: '2026-08-31', windowEnd: '2026-09-14' });
  assert.equal(p.count, 2);
  assert.deepEqual(p.rows.map((r) => [r.stopNbr, r.day]), [['007170166-1', '2026-09-01'], ['ESTES-0408710336', '2026-09-09']]);
  assert.equal(p.windowStart, '2026-08-31');
});

test('H&H WORLD GROUP: unplanned in the frozen 09/01 doc, delivered 09/02 — not in the pool, inside its reach → DROPPED as closed', () => {
  const { rows, stats } = mergeWindowWithPool([row()], pool([]), WIN);
  assert.equal(rows.length, 0);
  assert.equal(stats.closed, 1);
  assert.equal(stats.poolAt, POOL_AT);
});

test('MARIA SIMS: cached under 09/04, NuVizz now says 09/09 — pool lists it OUTSIDE the window → dropped as moved, not shown on the wrong day', () => {
  const cached = row({ stopNbr: 'ESTES-0408710336', boardDate: '2026-09-04', scheduledDate: '2026-09-04' });
  const p = pool([projectPoolRow(cached, '2026-09-09')]);
  const { rows, stats } = mergeWindowWithPool([cached], p, WIN);
  assert.equal(rows.length, 0);
  assert.equal(stats.moved, 1);
  // …and a window that reaches 09/09 shows it THERE, day relabelled, coordinates kept.
  const wide = mergeWindowWithPool([cached], p, { from: '2026-09-01', to: '2026-09-11' });
  assert.equal(wide.rows.length, 1);
  assert.equal(wide.rows[0].boardDate, '2026-09-09');
  assert.equal(wide.rows[0].lat, 33.88);
  assert.equal(wide.stats.synced, 1);
});

test('PRIMARY LOGISTICS: cached planned on MARCUS 2, NuVizz un-planned it Friday — pool overlays the live plan fields, cache keeps coords + enrichment', () => {
  const cached = row({ stopNbr: 'PRIMARY131434870', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS 2', routeName: 'MARCUS 2', driverName: 'Marcus Young', boardDate: '2026-09-02', scheduledDate: '2026-09-02', weight: 10000, cartons: 26 });
  const live = projectPoolRow({ ...cached, status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, driverName: null, listUpdatedDTTM: '2026-09-04T16:02:00' }, '2026-09-02');
  const { rows, stats } = mergeWindowWithPool([cached], pool([live]), WIN);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.status, '10');
  assert.equal(r.isUnplanned, true);
  assert.equal(r.routeName, null);
  assert.equal(r.driverName, null);
  assert.equal(r.listUpdatedDTTM, '2026-09-04T16:02:00');
  assert.equal(r.lat, 33.88, 'coordinates come from the cache');
  assert.equal(r.enriched, true, 'enrichment is kept');
  assert.equal(r.poolSynced, true);
  assert.equal(stats.synced, 1);
});

test('EXPEDITORS 007171664-1: created after its day froze — in the pool, never cached → ADDED without coordinates', () => {
  const live = projectPoolRow(row({ stopNbr: '007171664-1', businessName: 'EXPEDITORS INTERNATIONAL', weight: 848, lat: undefined, lng: undefined }), '2026-09-03');
  const { rows, stats } = mergeWindowWithPool([], pool([live]), WIN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stopNbr, '007171664-1');
  assert.equal(rows[0].lat, null);
  assert.equal(rows[0].poolOnly, true);
  assert.equal(stats.added, 1);
});

test('HIGHLAND FORGE 007171197: cached "unable to deliver" (80) on TAYLOR, re-opened by CS as an ATT attempt — the pool\'s OPEN row is the truth, the cached copy lends its pin (v0.95.0)', () => {
  // Before: the finished copy was served as history and the pool's open row skipped as a
  // duplicate, so the window said "refused" about freight NuVizz was asking to have planned.
  const cached = row({ stopNbr: '007171197', status: '80', normalizedStatus: 'EXCEPTION', isPlanned: true, isUnplanned: false, loadNbr: 'TAYLOR', routeName: 'TAYLOR', boardDate: '2026-09-02', scheduledDate: '2026-09-02' });
  const live = projectPoolRow(row({ stopNbr: '007171197', shipmentNbr: 'ATT007171197', isAttempt: true, weight: 781, cartons: 2, volume: 2 }), '2026-09-02');
  const { rows, stats } = mergeWindowWithPool([cached], pool([live]), WIN);
  assert.equal(rows.length, 1, 'one row per stop number');
  assert.equal(rows[0].status, '10', 'open again');
  assert.equal(rows[0].isUnplanned, true);
  assert.equal(rows[0].shipmentNbr, 'ATT007171197');
  assert.equal(rows[0].reopened, true);
  assert.equal(rows[0].lat, 33.88, 'the cached pin survives');
  assert.equal(stats.reopened, 1);
  // A finished row the pool does NOT list stays history, untouched.
  const { rows: r2 } = mergeWindowWithPool([cached], pool([]), WIN);
  assert.equal(r2[0].status, '80');
});

test('a confirmed Save stamped AFTER the pool was written is held — the pool\'s older "unplanned" must not undo the write-through', () => {
  const cached = row({ status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'CHAD', routeName: 'CHAD', board_write_at: '2026-09-07T15:30:00.000Z', board_write_planned: true });
  const live = projectPoolRow(row(), '2026-09-01');   // pool still says unplanned
  const { rows, stats } = mergeWindowWithPool([cached], pool([live]), WIN);
  assert.equal(rows[0].routeName, 'CHAD');
  assert.equal(rows[0].isPlanned, true);
  assert.equal(stats.held, 1);
  // …and it is not dropped as closed when the pool lacks it either.
  const { rows: r2, stats: s2 } = mergeWindowWithPool([cached], pool([]), WIN);
  assert.equal(r2.length, 1);
  assert.equal(s2.closed, 0);
});

test('delivered rows in the window are history: kept untouched whether or not the pool knows them', () => {
  const done = row({ stopNbr: '007170329', status: '90', normalizedStatus: 'DELIVERED', isUnplanned: false, isPlanned: true, loadNbr: 'GEORGE L', routeName: 'GEORGE L' });
  const { rows, stats } = mergeWindowWithPool([done], pool([]), WIN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, '90');
  assert.equal(stats.closed, 0);
});

test('older than the pool\'s reach: no verdict from the pool — the retired list is the only thing that drops it', () => {
  const old = row({ stopNbr: 'OLD-1', boardDate: '2026-08-20', scheduledDate: '2026-08-20' });
  const kept = mergeWindowWithPool([old], pool([]), { from: '2026-08-15', to: '2026-09-08' });
  assert.equal(kept.rows.length, 1, 'absence from a ±7d pool is not proof for a 2½-week-old order');
  assert.equal(kept.rows[0].unverified, true, 'served, and SAID to be beyond any scan\'s reach (v0.95.0)');
  assert.equal(kept.stats.unverified, 1);
  const gone = mergeWindowWithPool([old], pool([]), { from: '2026-08-15', to: '2026-09-08', retired: { 'OLD-1': '2026-08-21' } });
  assert.equal(gone.rows.length, 0);
  assert.equal(gone.stats.retired, 1);
});

test('no pool at all → rows pass through unchanged (the caller falls back to the snapshot rule)', () => {
  const { rows, stats } = mergeWindowWithPool([row()], null, WIN);
  assert.equal(rows.length, 1);
  assert.equal(stats.poolAt, null);
});

test('the 09/07 reconcile end to end: 30 stale + 3 relabelled + 2 added, from 550 shown to 525 unplanned', () => {
  // 520 shared unplanned rows, 30 stale unplanned rows, 3 rows cached-planned-now-unplanned, 2 pool-only rows.
  const cached = [];
  const live = [];
  for (let i = 0; i < 520; i++) { const c = row({ stopNbr: `S${i}` }); cached.push(c); live.push(projectPoolRow(c, '2026-09-07')); }
  for (let i = 0; i < 30; i++) cached.push(row({ stopNbr: `STALE${i}` }));
  for (const n of ['PRIMARY131434870', '007171307-1', '007171668']) {
    const c = row({ stopNbr: n, status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'X', routeName: 'X', boardDate: '2026-09-03', scheduledDate: '2026-09-03' });
    cached.push(c);
    live.push(projectPoolRow({ ...c, status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null }, '2026-09-03'));
  }
  live.push(projectPoolRow(row({ stopNbr: '007171664-1' }), '2026-09-03'));
  live.push(projectPoolRow(row({ stopNbr: '007171197' }), '2026-09-02'));
  const { rows, stats } = mergeWindowWithPool(cached, pool(live), WIN);
  const unplanned = rows.filter((r) => String(r.status) === '10');
  assert.equal(cached.filter((r) => String(r.status) === '10').length, 550, 'what the window showed');
  assert.equal(unplanned.length, 525, 'what NuVizz shows');
  assert.equal(stats.closed, 30);
  assert.equal(stats.synced, 523);
  assert.equal(stats.added, 2);
});

test('pruneWithSnapshot (no pool yet): a prior-day unplanned row absent from a fresh snapshot that covers its day is dropped; planned rows and today\'s rows are left alone', () => {
  const snap = { at: POOL_AT, windowStart: '2026-08-31', stopNbrs: new Set(['KEEP-1']) };
  const stale = row({ stopNbr: 'STALE-1' });
  const keep = row({ stopNbr: 'KEEP-1' });
  const planned = row({ stopNbr: 'PLAN-1', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'AB', routeName: 'AB' });
  const today = row({ stopNbr: 'TODAY-1', boardDate: '2026-09-07', scheduledDate: '2026-09-07' });
  const older = row({ stopNbr: 'OLD-1', boardDate: '2026-08-20', scheduledDate: '2026-08-20' });
  const { rows, stats } = pruneWithSnapshot([stale, keep, planned, today, older], snap, { 'OLD-1': '2026-08-21' }, { today: '2026-09-07', nowMs: Date.parse(POOL_AT) + 60_000 });
  assert.deepEqual(rows.map((r) => r.stopNbr), ['KEEP-1', 'PLAN-1', 'TODAY-1']);
  assert.equal(stats.closed, 1);
  assert.equal(stats.retired, 1);
});

test('pruneWithSnapshot: a snapshot older than the 7-day backstop is not trusted — nothing is dropped on its say-so', () => {
  const snap = { at: '2026-08-20T12:00:00.000Z', windowStart: '2026-08-13', stopNbrs: new Set(['X']) };
  const { rows, stats } = pruneWithSnapshot([row({ stopNbr: 'STALE-1' })], snap, {}, { today: '2026-09-07', nowMs: Date.parse(POOL_AT) });
  assert.equal(rows.length, 1);
  assert.equal(stats.closed, 0);
});

test('a THIN pool never drops: a cached open row the pool lacks inside its reach is kept, and one the pool files elsewhere is kept too', () => {
  const cached = row({ stopNbr: 'THIN-1' });
  const { rows, stats } = mergeWindowWithPool([cached], pool([], { thin: true }), WIN);
  assert.equal(rows.length, 1);
  assert.equal(stats.closed, 0);
  assert.equal(stats.thin, true);
  const elsewhere = projectPoolRow(row({ stopNbr: 'THIN-1' }), '2026-09-20');
  const { rows: r2, stats: s2 } = mergeWindowWithPool([cached], pool([elsewhere], { thin: true }), WIN);
  assert.equal(r2.length, 1);
  assert.equal(s2.moved, 0);
});

test('poolUsable: no pool, no stamp, older than the backstop, or superseded by a newer board scan → not usable; fresh and within slack → usable', () => {
  const now = Date.parse(POOL_AT) + 30 * 60 * 1000;
  assert.equal(poolUsable(null, { nowMs: now }).ok, false);
  assert.equal(poolUsable(pool([]), { nowMs: now }).ok, false, 'an empty pool has nothing to judge with');
  assert.equal(poolUsable(pool([projectPoolRow(row(), '2026-09-01')]), { nowMs: now }).ok, true);
  assert.equal(poolUsable(pool([projectPoolRow(row(), '2026-09-01')], { at: 'junk' }), { nowMs: now }).ok, false);
  assert.equal(poolUsable(pool([projectPoolRow(row(), '2026-09-01')]), { nowMs: now + 8 * 86400000 }).ok, false);
  const superseded = poolUsable(pool([projectPoolRow(row(), '2026-09-01')]), { nowMs: now, newestDocScanAt: new Date(Date.parse(POOL_AT) + 20 * 60 * 1000).toISOString() });
  assert.equal(superseded.ok, false);
  assert.match(superseded.why, /superseded/);
  const slack = poolUsable(pool([projectPoolRow(row(), '2026-09-01')]), { nowMs: now, newestDocScanAt: new Date(Date.parse(POOL_AT) + 5 * 60 * 1000).toISOString() });
  assert.equal(slack.ok, true, 'the same scan writes both within seconds — slack absorbs it');
});

test('write grace: a confirmed Save inside the hour is held while the pool disagrees, and released the moment the pool agrees', () => {
  const now = Date.parse(POOL_AT) + 10 * 60 * 1000;
  const saved = row({ stopNbr: 'GRACE-1', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'CHAD', routeName: 'CHAD', board_write_at: new Date(Date.parse(POOL_AT) - 5 * 60 * 1000).toISOString(), board_write_planned: true });
  const disagree = projectPoolRow(row({ stopNbr: 'GRACE-1' }), '2026-09-01');   // pool (written after the save) still says unplanned
  const held = mergeWindowWithPool([saved], pool([disagree]), { ...WIN, nowMs: now });
  assert.equal(held.rows[0].routeName, 'CHAD');
  assert.equal(held.stats.held, 1);
  const agree = projectPoolRow(row({ stopNbr: 'GRACE-1', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'CHAD', routeName: 'CHAD' }), '2026-09-01');
  const released = mergeWindowWithPool([saved], pool([agree]), { ...WIN, nowMs: now });
  assert.equal(released.stats.synced, 1);
  assert.equal(released.stats.held, 0);
  // Past the grace, an older stamp yields to the pool.
  const late = mergeWindowWithPool([saved], pool([disagree]), { ...WIN, nowMs: now + 2 * 3600 * 1000 });
  assert.equal(late.rows[0].isPlanned, false);
  assert.equal(late.stats.synced, 1);
});

test('explain: every decision names its stop numbers, so "why did this row vanish" is one read', () => {
  const stale = row({ stopNbr: 'STALE-X' });
  const live = projectPoolRow(row({ stopNbr: 'LIVE-X' }), '2026-09-03');
  const { stats } = mergeWindowWithPool([stale], pool([live]), { ...WIN, explain: true });
  assert.deepEqual(stats.decisions.closed, ['STALE-X']);
  assert.deepEqual(stats.decisions.added, ['LIVE-X']);
});
