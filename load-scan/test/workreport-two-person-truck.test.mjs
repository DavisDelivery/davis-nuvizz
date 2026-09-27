// workreport-two-person-truck.test.mjs — A6-S31-5.
//
// Two loaders on one truck is the normal case at 5am. The shift report judged
// each person's row against the WHOLE load: two people who loaded 5 pieces each
// onto a 10-piece truck both read "short 5", the truck was counted as started
// twice and complete zero times, and the manager's first look at the night said
// a full truck went out half empty. Short and complete are facts about the
// TRUCK; each person's row now carries the truck's verdict, and the totals count
// trucks, not rows.

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildShiftReport } = await import('../netlify/functions/lib/workreport.mts');

const DAY = '2026-08-07';
const board = [{ loadNbr: 'STEVEN', routeName: 'STEVEN', expectedPieces: 10, stopCount: 6 }];
const session = (worker, pieces, closedOut = true) => ({
  id: `${worker}__STEVEN`,
  worker,
  workerName: worker,
  role: 'loader',
  loadNbr: 'STEVEN',
  startedAt: '2026-08-07T01:00:00.000Z',
  finishedAt: '2026-08-07T01:40:00.000Z',
  closedOut,
  pieces,
  source: 'derived',
});

test('two loaders who put all 10 pieces on a 10-piece truck both read complete, not short', () => {
  const r = buildShiftReport(DAY, [session('A', 5), session('B', 5)], {}, board);
  for (const row of r.rows) {
    assert.equal(row.short, 0, `${row.worker} is not short — the truck is full`);
    assert.equal(row.status, 'complete');
  }
  assert.equal(r.totals.loadsStarted, 1, 'one truck, however many people worked it');
  assert.equal(r.totals.loadsComplete, 1);
});

test('a two-person truck that really is short reads short by the truck\'s shortfall on both rows', () => {
  const r = buildShiftReport(DAY, [session('A', 4), session('B', 4)], {}, board);
  for (const row of r.rows) {
    assert.equal(row.short, 2, 'the truck is 2 short, not each person 6 short');
    assert.equal(row.status, 'short');
  }
  assert.equal(r.totals.loadsStarted, 1);
  assert.equal(r.totals.loadsComplete, 0);
});

test('one loader on one truck is judged exactly as before', () => {
  const full = buildShiftReport(DAY, [session('A', 10)], {}, board);
  assert.equal(full.rows[0].status, 'complete');
  assert.equal(full.rows[0].short, 0);
  const short = buildShiftReport(DAY, [session('A', 8)], {}, board);
  assert.equal(short.rows[0].status, 'short');
  assert.equal(short.rows[0].short, 2);
  const open = buildShiftReport(DAY, [session('A', 3, false)], {}, board);
  assert.equal(open.rows[0].status, 'in_progress', 'not closed out, so not short yet');
  assert.equal(open.rows[0].short, 0);
});

test('two sign-ins on ONE phone cannot make a short truck read complete', () => {
  // The closer's phone total includes the other person's scans (the local queue
  // is per device), so adding the two people's pieces counts those twice. The
  // session record's own count for the truck is the truth when there is one.
  const sharedPhone = [session('A', 4), session('B', 8)];
  const r = buildShiftReport(DAY, sharedPhone, {}, [{ ...board[0], scannedPieces: 8 }]);
  for (const row of r.rows) {
    assert.equal(row.short, 2, 'the truck has 8 of 10 aboard');
    assert.equal(row.status, 'short');
  }
});

test('each person still gets credit for their own pieces', () => {
  const r = buildShiftReport(DAY, [session('A', 7), session('B', 3)], {}, board);
  const byWorker = Object.fromEntries(r.workers.map((w) => [w.worker, w.pieces]));
  assert.deepEqual(byWorker, { A: 7, B: 3 });
  assert.equal(r.totals.pieces, 10);
});
