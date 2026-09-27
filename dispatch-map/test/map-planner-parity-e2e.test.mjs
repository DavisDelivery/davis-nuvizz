// test/map-planner-parity-e2e.test.mjs — THE SAME RULE AS THE MAP, END TO END (v1.77.0 audit fix).
//
// The Claude shadow's planner plans "the board the Map shows". What holds the two together is
// this file, and it runs the REAL entry points of both sides against one in-memory Firestore
// (test/_firestore-fake.mjs), the way board-invariants-e2e runs the scan and the feed:
//
//   the Map      nuvizz-pull-today-stops.mts's default export, ?date=…&carryDays=N — the handler
//                a dispatcher's board polls, with its own reads, its own clock and its own steps
//   the planner  lib/claude-shadow/plan.mts readBoard (the rows a plan, its preview and its stop
//                map are built from) and readPlanDay, with LIVE_BOARD_READS — firestore.mts's own
//                readers, the ones production passes
//
// over boards that carry every judge the carry-over fold has (the open-order pool, a pool a later
// board scan superseded, the unplanned snapshot, nothing), a retired order, yesterday's stale copies
// of today's cancelled order and of a mis-filed delivery (which make the ORDER of the steps visible),
// and a clock that moves while the judges and the look-back are read. It compares what each side
// SERVES — the rows, the carry-over numbers and the fields each side asks Firestore for — so a
// change to either side's reads, steps or step order that makes Claude plan a board the dispatcher
// is not looking at fails here.
//
// It replaces a test of the same name in claude-shadow-plan.test.mjs that hand-copied the Map's
// steps and built the planner's fold inputs itself (retired always {}), so it could not see either
// side drift (audit feed-refactor F1).
//
// No network: the fake throws on any URL that is not Firestore, so every run below also proves
// neither side made a NuVizz call, and each checks that nothing was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;
delete process.env.MAP_FEED_FULL;
delete process.env.BOARD_DROP_CANCELLED;

const pullStops = (await import('../netlify/functions/nuvizz-pull-today-stops.mts')).default;
const { readBoard, readPlanDay } = await import('../netlify/functions/lib/claude-shadow/plan.mts');
const { routerSettingsFrom } = await import('../netlify/functions/lib/claude-shadow/backtest.mts');
const { getDoc, listDocs } = await import('../netlify/functions/lib/firestore.mts');

const D = '2026-09-28';
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const D1 = addDays(D, -1), D2 = addDays(D, -2), D3 = addDays(D, -3);
const T0 = Date.parse('2026-09-28T12:00:00.000Z');   // 8am ET on the board day
const HOUR = 3600e3, DAY = 24 * HOUR, WEEK = 7 * DAY;
const iso = (ms) => new Date(ms).toISOString();
const READ_MS = 2000;   // how long each prior day's read takes on the clock below
const JUDGE_MS = 3000;  // how long EACH of the three judge documents takes to come back
const JUDGES_IN = 3 * JUDGE_MS;  // the clock once all three are in

const row = (nbr, day, o = {}) => ({
  stopNbr: nbr, stopType: 'DO', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true,
  boardDate: day, scheduledDate: day, businessName: `CUST ${nbr}`, addr1: `${nbr} MAIN ST`, city: 'GAINESVILLE', zip: '30501',
  lat: 34.3, lng: -83.8, cartons: 2, weight: 500, ...o,
});
const plannedOn = (route) => ({ status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, routeName: route, loadNbr: route });
const poolRow = (nbr, day, o = {}) => ({ stopNbr: nbr, day, status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, ...o });

/**
 * One board day and its look-back, as the scans store them. Every row is named for what the fold
 * must do with it, and each judge that is passed is written where firestore.mts reads it.
 */
function seedBoard({ scanAt, pool = null, poolAt = scanAt, snapshot = false, snapAt = scanAt, confirmedStampAt = T0 - HOUR, graceStampAt = null }) {
  const seed = {};
  const day = (d, rows, meta = {}) => {
    seed[`nuvizz_stop_index/davis__${d}`] = { tenant: 'davis', date: d, last_scanned_at: scanAt, lastUnplannedScanAt: scanAt, count: rows.length, ...meta };
    for (const r of rows) seed[`nuvizz_stop_index/davis__${d}/stops/${r.stopNbr}`] = r;
  };
  day(D, [
    row('TODAY-U1', D),
    row('TODAY-P1', D, plannedOn('SCOTT')),
    // cancelled in NuVizz: off the board on both sides (BOARD_DROP_CANCELLED)
    row('TODAY-CXL', D, { raw: { stopExecutionInfo: { cancellation: { cancelDTTM: iso(T0 - 2 * HOUR), reasonCode: 'CANCELLED' } } } }),
    // a prior-day delivery mis-filed onto this board: the read-time day filter keeps it off
    row('TODAY-BLEED', D1, { status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false }),
  ]);
  day(D1, [
    row('OPEN-1', D1),                                   // still open on a past day: folds
    row('CLOSED-1', D1),                                 // inside every judge's reach, listed by none: closed since
    row('MOVED-1', D1),                                  // the pool files it on today now: today's own row
    row('DLV-1', D1, { status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false }),   // history: never folds
    row('TODAY-U1', D1),                                 // already on today's board: not twice
    // a Save routed it onto a load that runs today; the stamp is the write-through's
    row('CONFIRMED-1', D1, { ...plannedOn('SCOTT'), board_write_planned: true, board_write_at: iso(confirmedStampAt), board_write_from: null }),
    // Yesterday's frozen copies of two of today's rows, still UNPLANNED as that day's last scan left
    // them. They are what make the ORDER of the Map's steps visible — without them a side that ran
    // its steps in another order served the same board and every check below passed (audit review):
    row('TODAY-CXL', D1),     // today's cancelled order: the fold sees it on today's board BEFORE the cancel
                              // drop takes it off, so its stale copy never comes back as carry-over
    row('TODAY-BLEED', D1),   // the mis-filed delivery: the day filter takes it off today's board BEFORE the
                              // fold, so its stale copy is judged like any other prior-day order
  ]);
  // A Save routed it onto a load; NuVizz has un-planned it since, and the pool lists it open on a
  // past day. Only seeded by the write-grace test.
  if (graceStampAt != null) seed[`nuvizz_stop_index/davis__${D1}/stops/GRACE-1`] = row('GRACE-1', D1, { ...plannedOn('JAMES'), board_write_planned: true, board_write_at: iso(graceStampAt), board_write_from: null });
  day(D2, [row('OPEN-2', D2)]);
  day(D3, [
    row('RETIRED-3', D3),                                // older than any judge's reach; history sealed it: retired
    row('OLD-3', D3),                                    // older than any judge's reach, unproven: served, and said so
  ]);
  if (pool) {
    const rows = [poolRow('OPEN-1', D1), poolRow('MOVED-1', D), poolRow('OPEN-2', D2), poolRow('TODAY-U1', D), poolRow('CONFIRMED-1', D, plannedOn('SCOTT'))];
    if (graceStampAt != null) rows.push(poolRow('GRACE-1', D1));
    seed['nuvizz_active_pool/davis'] = { tenant: 'davis', at: poolAt, windowStart: D2, windowEnd: addDays(D, 7), count: rows.length, chunks: 1, thin: false, prevCount: null };
    seed['nuvizz_active_pool/davis/chunks/000'] = { i: 0, at: poolAt, count: rows.length, rowsJson: JSON.stringify(rows) };
  }
  if (snapshot) {
    const nbrs = ['OPEN-1', 'OPEN-2', 'TODAY-U1'];
    seed['nuvizz_active_set/davis'] = { tenant: 'davis', at: snapAt, windowStart: D2, count: nbrs.length, thin: false, reach: 7, stopNbrsJson: JSON.stringify(nbrs) };
  }
  // The history warehouse proved RETIRED-3 delivered.
  seed['nuvizz_carryover_retired/davis'] = { retiredJson: JSON.stringify({ 'RETIRED-3': D3 }) };
  return seed;
}

/**
 * Both sides over one seeded Firestore, on one clock. The clock starts at T0 for each side and
 * moves as reads come back — a Firestore read takes time, and the fold's verdicts depend on when
 * the clock is read relative to those reads:
 *   JUDGE_MS  as each of the three judge documents comes back (the retired list, the pool's meta,
 *             the snapshot). Both sides read each exactly once, in one Promise.all, so a side that
 *             reads the judges' clock before them sees T0, and one that reads it once they are all
 *             in sees T0 + JUDGES_IN.
 *   READ_MS   as each prior day's stops come back.
 * Each side's charges are counted and checked, so the clock cannot silently stop modelling them.
 */
async function bothSides(seed, carryDays) {
  const fake = installFirestoreFake(seed);
  const priorList = new RegExp(`/documents/nuvizz_stop_index/davis__(\\d{4}-\\d{2}-\\d{2})/stops`);
  const judgeGets = { retired: /\/documents\/nuvizz_carryover_retired\/davis(\?|$)/, pool: /\/documents\/nuvizz_active_pool\/davis(\?|$)/, snapshot: /\/documents\/nuvizz_active_set\/davis(\?|$)/ };
  const clock = { t: T0, judges: 0, priors: 0, each: {} };
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await inner(input, init);
    const url = decodeURIComponent(String(input?.url ?? input));
    const m = priorList.exec(url);
    if (m && m[1] < D) { clock.t += READ_MS; clock.priors++; }
    for (const [k, re] of Object.entries(judgeGets)) if (re.test(url)) { clock.t += JUDGE_MS; clock.judges++; clock.each[k] = (clock.each[k] || 0) + 1; }
    return res;
  };
  const start = () => { clock.t = T0; clock.judges = 0; clock.priors = 0; clock.each = {}; return fake.log.listMasks.length; };
  const charged = (who) => {
    assert.deepEqual(clock.each, carryDays > 0 ? { retired: 1, pool: 1, snapshot: 1 } : {}, `${who} read each judge once (the clock charges JUDGE_MS on each)`);
    assert.equal(clock.priors, carryDays, `${who} read each look-back day once (the clock charges READ_MS on each)`);
  };
  // The stop lists each side asked for, and with which fields: the fake returns the same object
  // for a masked and a whole-document read, so rows alone cannot show a side that stops masking.
  const stopLists = (from, to) => fake.log.listMasks.slice(from, to)
    .filter((l) => /^nuvizz_stop_index\//.test(l.path)).map((l) => `${l.path} [${[...l.mask].sort().join(',')}]`).sort();
  const realNow = Date.now;
  Date.now = () => clock.t;
  const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    // THE MAP: the handler the board polls.
    const m0 = start();
    const res = await pullStops(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=${D}&carryDays=${carryDays}`));
    const map = await res.json();
    assert.equal(map.ok, true, `the Map feed answered: ${map.error ?? ''}`);
    assert.equal(map.source, 'firestore', 'the Map served the stored board, not its fixture');
    charged('the Map');
    // THE PLANNER: its real board read, with production's readers and a wall clock like production's.
    const deps = {
      getDoc, listDocs, env: process.env, now: () => new Date(Date.now()),
      shadowSet: async () => { throw new Error('the board read wrote'); }, shadowPatch: async () => { throw new Error('the board read wrote'); }, shadowCreate: async () => { throw new Error('the board read wrote'); },
    };
    const p0 = start();
    const plan = await readBoard({ date: D, lookbackDays: carryDays }, deps);
    charged('the planner\u2019s board read');
    const q0 = start();
    const planDay = await readPlanDay({ date: D, lookbackDays: carryDays, scope: 'open', picks: [{ kind: 'truck', route: 'SPARE BOX', driver: null, cls: 'box_truck', loadNbr: null }], after: null, section: null }, routerSettingsFrom(null), deps);
    charged('the planner\u2019s plan day');
    const mapLists = stopLists(m0, p0);
    assert.ok(mapLists.length === carryDays + 1, `the Map listed the board day and each look-back day: ${mapLists.join(' | ')}`);
    assert.deepEqual(stopLists(p0, q0), mapLists, 'the planner reads the same days with the same fields as the Map');
    assert.deepEqual(stopLists(q0), mapLists, 'and so does the plan it builds');
    assert.deepEqual(fake.log.other, [], 'neither side called anything but Firestore — no NuVizz call');
    assert.deepEqual([fake.log.sets, fake.log.commits, fake.log.deletes, fake.log.patches ?? []].map((l) => l.length), [0, 0, 0, 0], 'neither side wrote a document');
    return { map, plan, planDay, logs };
  } finally {
    console.log = realLog;
    Date.now = realNow;
    fake.restore();
  }
}

const served = (rows) => (rows || []).map((r) => String(r.stopNbr));

/** THE PARITY: the planner's rows are the Map's served rows, and both report the same carry-over. */
function assertSameBoard({ map, plan, planDay }, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(plan.rows)), map.stops, `${label}: the planner reads the rows the Map serves`);
  assert.deepEqual(plan.carry ? { ...plan.carry } : null, map.carryover, `${label}: the same carry-over verdict, count for count`);
  assert.deepEqual(planDay.carry ? { ...planDay.carry } : null, map.carryover, `${label}: the plan is built on that same verdict`);
  assert.equal(plan.cancelled, map.cancelledDropped, `${label}: the same cancelled stops come off`);
  assert.equal(map.carryoverCount, map.carryover ? map.carryover.added : 0, `${label}: the Map's own count agrees with its verdict`);
}

test('THE SAME RULE AS THE MAP — the open-order pool judges: the planner reads the rows the Map serves, a retired order pruned on both', async () => {
  const scanAt = iso(T0 - 30 * 60e3);
  const r = await bothSides(seedBoard({ scanAt, pool: true, snapshot: true }), 3);
  assertSameBoard(r, 'pool');
  const c = r.map.carryover;
  assert.equal(c.basis, 'pool');
  // closed: CLOSED-1, and yesterday's copy of the mis-filed delivery (the pool lists neither)
  assert.deepEqual([c.closed, c.moved, c.retired, c.unverified], [2, 1, 1, 1], JSON.stringify(c));
  const rows = served(r.map.stops);
  for (const n of ['OPEN-1', 'OPEN-2', 'OLD-3', 'CONFIRMED-1', 'TODAY-U1', 'TODAY-P1']) assert.ok(rows.includes(n), `${n} is on the board`);
  for (const n of ['RETIRED-3', 'CLOSED-1', 'MOVED-1', 'DLV-1', 'TODAY-CXL', 'TODAY-BLEED']) assert.ok(!rows.includes(n), `${n} is not`);
  assert.equal(rows.filter((n) => n === 'TODAY-U1').length, 1, 'an order on today’s board is not carried in twice');
  assert.equal(r.map.stops.find((s) => s.stopNbr === 'OLD-3').unverified, true, 'older than the pool can see: served, and said so');
});

test('THE SAME RULE AS THE MAP — a pool a later board scan never rewrote is superseded: both fall back to the snapshot, and retire the same order', async () => {
  const scanAt = iso(T0 - 30 * 60e3);
  const r = await bothSides(seedBoard({ scanAt, pool: true, poolAt: iso(T0 - 3 * HOUR), snapshot: true }), 3);
  assertSameBoard(r, 'superseded pool');
  const c = r.map.carryover;
  assert.equal(c.basis, 'snapshot');
  assert.match(c.poolWhy, /superseded/);
  assert.equal(c.retired, 1);
  assert.ok(!served(r.map.stops).includes('RETIRED-3'));
});

test('THE SAME RULE AS THE MAP — the unplanned snapshot alone, and no judge at all', async () => {
  const scanAt = iso(T0 - 30 * 60e3);
  const snap = await bothSides(seedBoard({ scanAt, snapshot: true }), 3);
  assertSameBoard(snap, 'snapshot only');
  assert.equal(snap.map.carryover.basis, 'snapshot');
  assert.equal(snap.map.carryover.retired, 1);
  const none = await bothSides(seedBoard({ scanAt }), 3);
  assertSameBoard(none, 'no judge');
  assert.equal(none.map.carryover.basis, 'none');
  assert.equal(none.map.carryover.retired, 1, 'the history warehouse retires an order with no judge at all');
  assert.ok(served(none.map.stops).includes('CLOSED-1'), 'with no judge nothing inside the window is pruned — over-count, never hide');
  assert.ok(!served(none.map.stops).includes('TODAY-CXL'), 'but a cancelled order\u2019s stale copy from yesterday still does not come back');
  // No look-back: nothing is folded on either side, and both still serve the same day.
  const off = await bothSides(seedBoard({ scanAt, pool: true, snapshot: true }), 0);
  assertSameBoard(off, 'look-back 0');
  assert.equal(off.map.carryover, null);
  assert.ok(!served(off.map.stops).includes('OPEN-1'));
});

test('A CANCELLED ORDER\u2019S STALE COPY FROM YESTERDAY NEVER COMES BACK AS CARRY-OVER, and a delivery mis-filed onto today is off the board before the fold judges — the Map\u2019s step order, on both sides', async () => {
  // The Map turns a stored day into its board in one order (lib/board-rows.mts): the day filter,
  // then the carry-over fold, then the cancel drop. Yesterday's frozen copies of TODAY-CXL and
  // TODAY-BLEED are what that order decides, so a side that runs its steps in another order serves
  // the dispatcher a different board, and the parity below fails:
  //   TODAY-CXL    is still on today's board when the fold looks, so its stale copy counts as
  //                already served and never folds; the cancel drop then takes today's row off.
  //                Drop it first and the stale copy comes back as carry-over whenever no judge
  //                can prune it: a cancelled order back on the Map.
  //   TODAY-BLEED  is already off today's board when the fold looks, so its stale copy is judged
  //                like any prior-day order: the pool no longer lists it, so it is closed.
  //                Filter after the fold and the pool is never asked about it.
  const scanAt = iso(T0 - 30 * 60e3);
  const pool = await bothSides(seedBoard({ scanAt, pool: true, snapshot: true }), 3);
  assertSameBoard(pool, 'step order, under the pool');
  assert.equal(pool.map.carryover.closed, 2, 'CLOSED-1 and yesterday\u2019s copy of the mis-filed delivery: the pool lists neither');
  assert.ok(!served(pool.map.stops).includes('TODAY-BLEED'), 'the mis-filed delivery is not on the board, as today\u2019s row or as yesterday\u2019s copy');
  const none = await bothSides(seedBoard({ scanAt }), 3);
  assertSameBoard(none, 'step order, with no judge');
  for (const [label, r] of [['under the pool', pool], ['with no judge', none]]) {
    assert.ok(!served(r.map.stops).includes('TODAY-CXL'), `${label}: the cancelled order is not on the board, as today\u2019s row or as yesterday\u2019s copy`);
  }
});

test('A WEEK-OLD JUDGE AT ITS 7-DAY EDGE is judged on the clock read BEFORE the look-back is read, as the Map did before v1.77.0 — on both sides', async () => {
  // A week with no scan: the pool, the snapshot and the board were all written 1s inside the 7-day
  // backstop once the judges are in, and the three look-back days take 2s each to read. Before v1.77.0
  // the Map read the clock for these two checks before those reads and kept the pool as judge; v1.77.0
  // read it after them, the pool had aged past the backstop by then, and the fold judged nothing:
  // on the real 09-28 board that served eight closed or moved orders as carry-over (audit F2).
  const edge = iso(T0 + JUDGES_IN - WEEK + 1000);
  const r = await bothSides(seedBoard({ scanAt: edge, pool: true, snapshot: true, confirmedStampAt: T0 - DAY }), 3);
  assertSameBoard(r, 'the 7-day edge');
  assert.equal(r.map.carryover.basis, 'pool', `the pool still judges: ${r.map.carryover.poolWhy}`);
  assert.equal(r.map.carryover.closed, 2, 'CLOSED-1 and yesterday\u2019s copy of the mis-filed delivery');
  assert.ok(!served(r.map.stops).includes('CLOSED-1'), 'an order the pool no longer lists stays off the board');
  // The snapshot alone, at the same edge: it judges too.
  const s = await bothSides(seedBoard({ scanAt: edge, snapshot: true, confirmedStampAt: T0 - DAY }), 3);
  assertSameBoard(s, 'the snapshot at the 7-day edge');
  assert.equal(s.map.carryover.basis, 'snapshot');
});

test('A CONFIRMED PLAN WHOSE 48-HOUR STAMP RUNS OUT WHILE THE LOOK-BACK IS READ no longer folds — the per-row clock is still read after the reads, as it always was', async () => {
  // The other half of the same rule: only the two 7-day checks moved back before the reads. The
  // confirmed-plan stamp (48h) and the write grace (60 min) are judged row by row, after the reads,
  // before v1.77.0 and now. Freezing the whole fold on the early clock would keep this stale Save on
  // the board for one more read-duration — a new change, in the other direction.
  // 1s inside 48h when the judges' clock is read, 48h and 5s by the time the fold judges the row.
  const r = await bothSides(seedBoard({ scanAt: iso(T0 - 30 * 60e3), pool: true, snapshot: true, confirmedStampAt: T0 + JUDGES_IN - 48 * HOUR + 1000 }), 3);
  assertSameBoard(r, 'the 48h edge');
  assert.ok(!served(r.map.stops).includes('CONFIRMED-1'), 'its stamp was 48h and 5s old when the fold judged it');
});

test('A WEEK-OLD JUDGE THAT CROSSES ITS 7-DAY EDGE WHILE THE JUDGES ARE READ is past it — the clock is read once they are in, not before, as the Map did before v1.77.0 — on both sides', async () => {
  // The other end of the same clock read. Before v1.77.0 the Map read it after its three judge
  // documents were in; read before them, a judge that turns a week old while they come back would
  // still be trusted to prune for one more feed read. Stamped 1s inside 7 days when the feed starts
  // and 1s past it once the judges are in: neither side may judge by it.
  const past = iso(T0 + JUDGES_IN - WEEK - 1000);
  const r = await bothSides(seedBoard({ scanAt: past, pool: true, snapshot: true, confirmedStampAt: T0 - DAY }), 3);
  assertSameBoard(r, 'a pool past 7 days once the judges are in');
  assert.equal(r.map.carryover.basis, 'none', `neither judge is trusted: pool ${r.map.carryover.poolWhy}`);
  assert.match(r.map.carryover.poolWhy, /pool is 168h old/);
  assert.ok(served(r.map.stops).includes('CLOSED-1'), 'with no judge nothing is pruned — over-count, never hide');
  const s = await bothSides(seedBoard({ scanAt: past, snapshot: true, confirmedStampAt: T0 - DAY }), 3);
  assertSameBoard(s, 'a snapshot past 7 days once the judges are in');
  assert.equal(s.map.carryover.basis, 'none');
});

test('A SAVE 60 MINUTES OLD WHEN THE FOLD JUDGES IT no longer outranks the pool — the write grace is judged after the look-back is read, as it always was — on both sides', async () => {
  // A dispatcher's Save put GRACE-1 on a load; NuVizz has un-planned it since, and the pool lists it
  // open on a past day. Inside the 60-minute write grace the Save holds its place against the pool;
  // past it, the pool's live view wins. The Save is 1s inside the grace when the judges' clock is
  // read, and 60 minutes and 5s old by the time the fold reaches the row. Only the two 7-day
  // backstops moved to the judges' clock; judging the grace on it would hold a stale Save a
  // read-duration longer — a change nobody asked for.
  const r = await bothSides(seedBoard({ scanAt: iso(T0 - 30 * 60e3), pool: true, graceStampAt: T0 + JUDGES_IN - HOUR + 1000 }), 3);
  assertSameBoard(r, 'the write-grace edge');
  assert.equal(r.map.carryover.basis, 'pool');
  assert.equal(r.map.carryover.held, 0, 'the Save is past its grace: not held against the pool');
  const g = r.map.stops.find((x) => x.stopNbr === 'GRACE-1');
  assert.ok(g, 'GRACE-1 is still on the board');
  assert.equal(g.poolSynced, true, 'served with the pool\u2019s live fields');
  assert.equal(g.isPlanned, false, 'as NuVizz has it now: unplanned');
});
