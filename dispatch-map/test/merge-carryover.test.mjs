// test/merge-carryover.test.mjs — mergeCarryover (nuvizz-pull-today-stops.mts).
//
// The read-time fold that carries prior-day orders onto the served board (audit follow-up
// T5), with the Firestore readers + clock injected. Pinned rules, each from a real incident:
//   • still-UNPLANNED prior-day orders fold in, flagged carryover + pinned to the board day
//   • TERMINAL rows never fold — isTerminal flag OR normalizedStatus belt (P4/P7a)
//   • planned prior-day rows never fold EXCEPT a fresh confirmed live Save
//     (board_write_planned within 48h — NOLAN/OWUSU 1), stale stamps age out (F6)
//   • a confirmed plan REPLACES a stale-unplanned today row in place (F2)
//   • the live active-unplanned snapshot prunes closed-since orders — only while FRESH,
//     and never a confirmed-planned row
//   • dedupe by stopNbr across prior days (nearest day wins)
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeCarryover } from '../netlify/functions/nuvizz-pull-today-stops.mts';

const DATE = '2026-07-10';
const D1 = '2026-07-09';
const D2 = '2026-07-08';
const NOW = Date.parse('2026-07-10T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

// io harness: prior-day boards from a plain object, live snapshot optional, frozen clock.
function io(prior = {}, live = null) {
  return {
    readStops: async (_tenant, d) => ({ stops: prior[d] || [] }),
    readActiveUnplannedSet: async () => live,
    now: () => NOW,
  };
}
const unplanned = (nbr, extra = {}) => ({ stopNbr: String(nbr), isPlanned: false, normalizedStatus: 'UNPLANNED', ...extra });

test('carryover: a still-unplanned prior-day order folds in, flagged and pinned to the board day', async () => {
  const stops = [];
  const added = await mergeCarryover(stops, DATE, 2, io({ [D1]: [unplanned('100')] }));
  assert.equal(added, 1);
  assert.equal(stops.length, 1);
  const row = stops[0];
  assert.equal(row.stopNbr, '100');
  assert.equal(row.carryover, true);
  assert.equal(row.scheduledDate, D1, 'remembers its home day');
  assert.equal(row.boardDate, DATE, 'files under the board being served');
});

test('carryover: terminal rows never fold — isTerminal flag OR status belt (P4/P7a)', async () => {
  const stops = [];
  const added = await mergeCarryover(stops, DATE, 1, io({ [D1]: [
    unplanned('110', { isTerminal: true }),
    unplanned('111', { normalizedStatus: 'DELIVERED' }),
    unplanned('112', { normalizedStatus: 'EXCEPTION' }),
    unplanned('113', { normalizedStatus: 'CANCELLED' }),   // the status-99 no-route cancel
  ] }));
  assert.equal(added, 0, 'finished work is not workable carry-over');
  assert.equal(stops.length, 0);
});

test('carryover: planned prior-day rows never fold — except a FRESH confirmed live Save (NOLAN), and stale stamps age out (F6)', async () => {
  const prior = { [D1]: [
    { stopNbr: '120', isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'TAYLOR' },   // that day's own route
    { stopNbr: '121', isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'MONE 1',
      board_write_planned: true, board_write_at: hoursAgo(47) },   // confirmed save, fresh
    { stopNbr: '122', isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'OLD 9',
      board_write_planned: true, board_write_at: hoursAgo(49) },   // stamp aged out
  ] };
  const stops = [];
  const added = await mergeCarryover(stops, DATE, 1, io(prior));
  assert.equal(added, 1, 'only the fresh confirmed plan folds');
  assert.equal(stops[0].stopNbr, '121');
  assert.equal(stops[0].loadNbr, 'MONE 1', 'folds WITH its plan — the route stays visible');
  assert.equal(stops[0].boardDate, DATE);
});

test('carryover: a confirmed plan REPLACES a stale-unplanned today row in place (F2) — but never a row with its own truth', async () => {
  const confirmed = { stopNbr: '130', isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'MONE 1',
    board_write_planned: true, board_write_at: hoursAgo(1) };
  // Case A: today row is pre-fix revert residue (unplanned, no stamp) → replaced in place.
  const stopsA = [unplanned('130')];
  const addedA = await mergeCarryover(stopsA, DATE, 1, io({ [D1]: [confirmed] }));
  assert.equal(addedA, 0, 'a replace is not an add');
  assert.equal(stopsA.length, 1, 'in place — no duplicate row');
  assert.equal(stopsA[0].isPlanned, true, 'the confirmed plan now shows');
  assert.equal(stopsA[0].loadNbr, 'MONE 1');
  assert.equal(stopsA[0].carryover, true);
  assert.equal(stopsA[0].boardDate, DATE);

  // Case B: today row is itself planned → untouched.
  const planned = { stopNbr: '130', isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'JEAN' };
  const stopsB = [{ ...planned }];
  await mergeCarryover(stopsB, DATE, 1, io({ [D1]: [confirmed] }));
  assert.equal(stopsB[0].loadNbr, 'JEAN', 'a planned today row always wins');

  // Case C: today row carries its OWN write stamp (even unplanned — a confirmed removal) → untouched.
  const stamped = unplanned('130', { board_write_at: hoursAgo(1), board_write_planned: false });
  const stopsC = [{ ...stamped }];
  await mergeCarryover(stopsC, DATE, 1, io({ [D1]: [confirmed] }));
  assert.equal(stopsC[0].isPlanned, false, 'a row with its own stamp always wins');
});

test('carryover: the FRESH live snapshot prunes closed-since orders — confirmed plans exempt', async () => {
  const live = { at: hoursAgo(1), windowStart: D2, stopNbrs: new Set(['140']) };
  const prior = { [D1]: [
    unplanned('140'),   // still in the live unplanned set → folds
    unplanned('141'),   // gone from the live set → delivered/planned since → pruned
    { stopNbr: '142', isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'MONE 1',
      board_write_planned: true, board_write_at: hoursAgo(2) },   // absent from the set BECAUSE it just got planned
  ] };
  const stops = [];
  const added = await mergeCarryover(stops, DATE, 1, io(prior, live));
  assert.equal(added, 2);
  const nbrs = stops.map((s) => s.stopNbr).sort();
  assert.deepEqual(nbrs, ['140', '142'], 'pruned the closed one, kept the live one AND the confirmed plan');
});

test('carryover: a STALE snapshot never prunes — fold everything rather than under-count the board', async () => {
  const live = { at: hoursAgo(19), windowStart: D2, stopNbrs: new Set(['150']) };   // >18h old
  const stops = [];
  const added = await mergeCarryover(stops, DATE, 1, io({ [D1]: [unplanned('150'), unplanned('151')] }, live));
  assert.equal(added, 2, 'stale snapshot ignored — both fold');
});

test('carryover: dedupe by stopNbr across prior days — the nearest day wins', async () => {
  const stops = [];
  const added = await mergeCarryover(stops, DATE, 2, io({
    [D1]: [unplanned('160')],
    [D2]: [unplanned('160'), unplanned('161')],
  }));
  assert.equal(added, 2);
  const row160 = stops.find((s) => s.stopNbr === '160');
  assert.equal(row160.scheduledDate, D1, 'yesterday\'s copy outranks the older one');
  assert.ok(stops.find((s) => s.stopNbr === '161'));
});
