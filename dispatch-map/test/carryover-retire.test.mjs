// test/carryover-retire.test.mjs
//
// The phantom-unplanned fix. Chad, on a 650-order Uline day whose board read 548 unplanned:
// "I can't drop the carry over setting … but it's showing more than that and we need a
// permanent and correct fix for that so I can trust the numbers."
//
// Measured on the live board (Jul 30): 199 carried rows — 41 genuinely open, 44 correctly
// exempt (planned), and 114 from Jul 16-21 folding as UNPLANNED that nothing could retire.
// Prior-day board docs are frozen, and the live active-unplanned snapshot only reaches back
// ~7 days, so mergeCarryover rightly refuses to judge anything older. The immutable history
// warehouse has no window — the scan proves against it, the read path consumes the result.
//
// The invariant these tests exist to hold: a row is dropped ONLY on positive proof it
// finished. Every failure mode (no map, unreadable day, spent budget) leaves it folding.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeCarryover } from '../netlify/functions/nuvizz-pull-today-stops.mts';
import { pruneCarryoverRetired } from '../netlify/functions/lib/firestore.mts';
import {
  carryoverRetirementCandidates, retirementSearchDates,
  makeHistoryTerminalLookup, isTerminalHistoryStatus,
} from '../netlify/functions/lib/refresh-stops-core.mts';

const FRESH = new Date('2026-07-30T01:00:00Z').getTime();
const NOW = () => new Date('2026-07-30T02:00:00Z').getTime();
const row = (nbr, over = {}) => ({
  stopNbr: nbr, isUnplanned: true, isPlanned: false, normalizedStatus: 'UNPLANNED', ...over,
});
// A snapshot that reaches back only to the 22nd — the real ±7d saved-search window.
const liveSet = (nbrs) => async () => ({
  at: new Date(FRESH).toISOString(), windowStart: '2026-07-22', stopNbrs: new Set(nbrs.map(String)),
});

function io({ prior, live, retired }) {
  return {
    readStops: async (_t, d) => ({ stops: prior[d] || [] }),
    readActiveUnplannedSet: live,
    readCarryoverRetired: async () => retired || {},
    now: NOW,
  };
}

// ── the read path ────────────────────────────────────────────────────────────

test('a row PROVEN finished retires at any age — even far outside the snapshot window', async () => {
  // '900' is from the 17th: too old for the snapshot to judge, so before this fix it folded
  // forever. History sealed it, so it now retires.
  const prior = { '2026-07-17': [row('900')], '2026-07-29': [row('901')] };
  const stops = [];
  const added = await mergeCarryover(stops, '2026-07-30', 14,
    io({ prior, live: liveSet(['901']), retired: { 900: '2026-07-19' } }));
  assert.equal(added, 1, 'only the genuinely-open one folds');
  assert.deepEqual(stops.map((s) => s.stopNbr), ['901']);
});

test('an UNPROVEN old row still folds — absence of proof is never proof of absence', async () => {
  const prior = { '2026-07-17': [row('900')] };
  const stops = [];
  const added = await mergeCarryover(stops, '2026-07-30', 14,
    io({ prior, live: liveSet([]), retired: {} }));
  assert.equal(added, 1, 'no history verdict ⇒ it keeps showing (the old over-count, on purpose)');
  assert.equal(stops[0].stopNbr, '900');
});

test('an unreadable retirement map degrades to the old behaviour, never to hiding work', async () => {
  const prior = { '2026-07-17': [row('900')] };
  const stops = [];
  const added = await mergeCarryover(stops, '2026-07-30', 14, {
    readStops: async (_t, d) => ({ stops: prior[d] || [] }),
    readActiveUnplannedSet: liveSet([]),
    readCarryoverRetired: async () => { throw new Error('firestore down'); },
    now: NOW,
  });
  assert.equal(added, 1);
});

test('the in-window snapshot prune still works, and the two rules compose', async () => {
  // '901' (28th, in window, absent from the live set) → pruned by the snapshot.
  // '900' (17th, out of window, proven) → retired by history.
  // '902' (17th, out of window, unproven) → still folds.
  const prior = { '2026-07-17': [row('900'), row('902')], '2026-07-28': [row('901')] };
  const stops = [];
  const added = await mergeCarryover(stops, '2026-07-30', 14,
    io({ prior, live: liveSet(['902']), retired: { 900: '2026-07-19' } }));
  assert.equal(added, 1);
  assert.deepEqual(stops.map((s) => s.stopNbr), ['902']);
});

test('a confirmed-planned carry-over is never retired by the map', async () => {
  // It's absent from the unplanned snapshot because it just got PLANNED. Dropping it would
  // vanish the order off the board while NuVizz's load still holds it (the OWUSU 1 case).
  const planned = row('900', {
    isUnplanned: false, isPlanned: true, normalizedStatus: 'SCHEDULED',
    board_write_planned: true, board_write_at: new Date(NOW() - 3600e3).toISOString(),
  });
  const stops = [];
  const added = await mergeCarryover(stops, '2026-07-30', 14,
    io({ prior: { '2026-07-17': [planned] }, live: liveSet([]), retired: { 900: '2026-07-19' } }));
  assert.equal(added, 1, 'a confirmed plan outranks a retirement record');
});

// ── what the scan offers up for proving ──────────────────────────────────────

test('candidates: exactly the rows the snapshot is not entitled to judge', () => {
  const prior = [
    { date: '2026-07-17', stops: [row('900')] },                                  // out of window → candidate
    { date: '2026-07-28', stops: [row('901')] },                                  // in window → snapshot's job
    { date: '2026-07-17', stops: [row('902', { isPlanned: true, isUnplanned: false })] },   // planned → not ours
    { date: '2026-07-17', stops: [row('903', { normalizedStatus: 'DELIVERED' })] },         // never folds anyway
    { date: '2026-07-16', stops: [row('904')] },                                  // out of window → candidate
  ];
  const live = { windowStart: '2026-07-22', stopNbrs: new Set(['901']) };
  const got = carryoverRetirementCandidates(prior, live, {});
  assert.deepEqual(got.map((c) => c.nbr).sort(), ['900', '904']);
});

test('candidates: an already-proven row is never re-proved, and dupes cost one slot', () => {
  const prior = [
    { date: '2026-07-17', stops: [row('900'), row('900')] },
    { date: '2026-07-16', stops: [row('900')] },
  ];
  const live = { windowStart: '2026-07-22', stopNbrs: new Set() };
  assert.equal(carryoverRetirementCandidates(prior, live, {}).length, 1, 'deduped');
  assert.deepEqual(carryoverRetirementCandidates(prior, live, { 900: '2026-07-19' }), []);
});

test('candidates: with NO usable snapshot every open row is a candidate', () => {
  // Nothing is vouched for, so history is the only evidence available — ask about all of it.
  const prior = [{ date: '2026-07-28', stops: [row('901')] }, { date: '2026-07-17', stops: [row('900')] }];
  assert.equal(carryoverRetirementCandidates(prior, null, {}).length, 2);
  assert.equal(carryoverRetirementCandidates(prior, { windowStart: '2026-07-22', stopNbrs: new Set() }, {}).length, 2,
    'an EMPTY snapshot vouches for nothing either');
});

test('retirementSearchDates: the row\'s own day → yesterday, newest first, never past it', () => {
  assert.deepEqual(retirementSearchDates('2026-07-28', '2026-07-30', 21), ['2026-07-29', '2026-07-28']);
  assert.deepEqual(retirementSearchDates('2026-07-30', '2026-07-30', 21), [], 'nothing to search for today');
  assert.equal(retirementSearchDates('2026-07-01', '2026-07-30', 5).length, 5, 'capped');
  // Newest first is what makes the common case one read.
  assert.equal(retirementSearchDates('2026-07-20', '2026-07-30', 21)[0], '2026-07-29');
});

// ── the proving itself ───────────────────────────────────────────────────────

test('history lookup: a sealed terminal proves it; an open record does not', async () => {
  const warehouse = { '2026-07-19': { 900: { normalizedStatus: 'DELIVERED' } }, '2026-07-18': { 901: { normalizedStatus: 'UNPLANNED' } } };
  let reads = 0;
  const l = makeHistoryTerminalLookup({
    readStop: async (d, n) => { reads++; return warehouse[d]?.[n] ?? null; },
    dates: ['2026-07-19', '2026-07-18'], isTerminal: isTerminalHistoryStatus, readCap: 50,
  });
  assert.ok(await l.lookup('900'), 'delivered → proven');
  assert.equal(await l.lookup('901'), null, 'still open → not proven');
  const before = reads;
  await l.lookup('900');
  assert.equal(reads, before, 'memoized — a repeated candidate is free');
});

test('history lookup: a spent budget HOLDS the row rather than dropping it', async () => {
  const l = makeHistoryTerminalLookup({
    readStop: async () => ({ normalizedStatus: 'DELIVERED' }),
    dates: ['2026-07-29'], isTerminal: isTerminalHistoryStatus, readCap: 0,
  });
  assert.equal(await l.lookup('900'), null, 'no budget ⇒ no verdict ⇒ it keeps folding');
  assert.equal(l.reads(), 0);
});

test('isTerminalHistoryStatus: only genuinely finished states retire a row', () => {
  for (const s of ['DELIVERED', 'EXCEPTION', 'CANCELLED']) assert.equal(isTerminalHistoryStatus({ normalizedStatus: s }), true, s);
  for (const s of ['UNPLANNED', 'SCHEDULED', 'OUT_FOR_DEL', 'ARRIVED', '', null]) {
    assert.equal(isTerminalHistoryStatus({ normalizedStatus: s }), false, String(s));
  }
});

test('pruneCarryoverRetired: entries older than the carry window are dead weight', () => {
  const map = { a: '2026-07-10', b: '2026-07-19', c: '2026-07-29', d: 'nope', '': '2026-07-29' };
  assert.deepEqual(pruneCarryoverRetired(map, '2026-07-16'), { b: '2026-07-19', c: '2026-07-29' });
  assert.deepEqual(pruneCarryoverRetired(null, '2026-07-16'), {});
});
