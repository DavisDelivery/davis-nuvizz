// test/history-terminal-lookup.test.mjs
//
// Unit tests for the history-terminal cross-check that fixes the stale-"Scheduled"
// appointment stop (lib/refresh-stops-core.mts): the pure terminal test, the bounded
// look-back window, and the memoized/read-capped lookup factory with getStop injected
// (no Firestore). Run with: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isTerminalHistoryStatus, historyLookbackDates, makeHistoryTerminalLookup } from '../netlify/functions/lib/refresh-stops-core.mts';

test('isTerminalHistoryStatus: DELIVERED / EXCEPTION / CANCELLED are terminal, open states are not', () => {
  assert.equal(isTerminalHistoryStatus({ normalizedStatus: 'DELIVERED' }), true);
  assert.equal(isTerminalHistoryStatus({ normalizedStatus: 'EXCEPTION' }), true);
  assert.equal(isTerminalHistoryStatus({ normalizedStatus: 'CANCELLED' }), true);
  assert.equal(isTerminalHistoryStatus({ normalizedStatus: 'delivered' }), true); // case-insensitive
  assert.equal(isTerminalHistoryStatus({ normalizedStatus: 'SCHEDULED' }), false);
  assert.equal(isTerminalHistoryStatus({ normalizedStatus: 'OUT_FOR_DEL' }), false);
  assert.equal(isTerminalHistoryStatus({}), false);
  assert.equal(isTerminalHistoryStatus(null), false);
});

test('historyLookbackDates: yesterday back N days from today (UTC), never includes today', () => {
  assert.deepEqual(historyLookbackDates('2026-07-16', 4), ['2026-07-15', '2026-07-14', '2026-07-13', '2026-07-12']);
  assert.deepEqual(historyLookbackDates('2026-07-16', 1), ['2026-07-15']);
  assert.deepEqual(historyLookbackDates('2026-07-16', 0), []);
  // crosses a month boundary correctly
  assert.deepEqual(historyLookbackDates('2026-08-01', 2), ['2026-07-31', '2026-07-30']);
});

test('makeHistoryTerminalLookup: returns the first sealed terminal record found walking back', async () => {
  const calls = [];
  const store = { '2026-07-15': { X: { normalizedStatus: 'DELIVERED', stopNbr: 'X' } } };
  const lk = makeHistoryTerminalLookup({
    readStop: async (d, nbr) => { calls.push(d); return store[d]?.[nbr] ?? null; },
    dates: ['2026-07-15', '2026-07-14', '2026-07-13'],
    isTerminal: isTerminalHistoryStatus,
    readCap: 100,
  });
  const rec = await lk.lookup('X');
  assert.equal(rec?.normalizedStatus, 'DELIVERED');
  assert.deepEqual(calls, ['2026-07-15']); // stopped at the first hit; no wasted reads
});

test('makeHistoryTerminalLookup: walks past non-terminal / missing days to a terminal one', async () => {
  const store = {
    '2026-07-15': { X: null },                                   // no record that day
    '2026-07-14': { X: { normalizedStatus: 'SCHEDULED' } },      // present but not terminal
    '2026-07-13': { X: { normalizedStatus: 'DELIVERED' } },      // the sealed delivery
  };
  const lk = makeHistoryTerminalLookup({
    readStop: async (d, nbr) => store[d]?.[nbr] ?? null,
    dates: ['2026-07-15', '2026-07-14', '2026-07-13'],
    isTerminal: isTerminalHistoryStatus,
    readCap: 100,
  });
  assert.equal((await lk.lookup('X'))?.normalizedStatus, 'DELIVERED');
});

test('makeHistoryTerminalLookup: no terminal anywhere → null (the stop is HELD/re-carried, not dropped)', async () => {
  let reads = 0;
  const lk = makeHistoryTerminalLookup({
    readStop: async () => { reads++; return { normalizedStatus: 'SCHEDULED' }; },
    dates: ['2026-07-15', '2026-07-14'],
    isTerminal: isTerminalHistoryStatus,
    readCap: 100,
  });
  assert.equal(await lk.lookup('X'), null);
  assert.equal(reads, 2); // searched the whole window
});

test('makeHistoryTerminalLookup: memoized per stopNbr — a repeated candidate costs no extra reads', async () => {
  let reads = 0;
  const lk = makeHistoryTerminalLookup({
    readStop: async () => { reads++; return null; },
    dates: ['2026-07-15', '2026-07-14', '2026-07-13'],
    isTerminal: isTerminalHistoryStatus,
    readCap: 100,
  });
  await lk.lookup('X');
  await lk.lookup('X');
  await lk.lookup('X');
  assert.equal(reads, 3);          // three window reads, ONCE
  assert.equal(lk.reads(), 3);
});

test('makeHistoryTerminalLookup: read cap holds a miss (never a false drop) instead of over-reading', async () => {
  let reads = 0;
  const lk = makeHistoryTerminalLookup({
    readStop: async () => { reads++; return null; },
    dates: ['d1', 'd2', 'd3', 'd4', 'd5'],
    isTerminal: isTerminalHistoryStatus,
    readCap: 2,
  });
  const rec = await lk.lookup('X');
  assert.equal(rec, null);   // capped → held (the caller re-carries the open row, no false drop)
  assert.equal(reads, 2);    // stopped at the cap
});

test('makeHistoryTerminalLookup: a readStop throw is swallowed, search continues', async () => {
  const lk = makeHistoryTerminalLookup({
    readStop: async (d) => { if (d === '2026-07-15') throw new Error('firestore blip'); return { normalizedStatus: 'DELIVERED' }; },
    dates: ['2026-07-15', '2026-07-14'],
    isTerminal: isTerminalHistoryStatus,
    readCap: 100,
  });
  assert.equal((await lk.lookup('X'))?.normalizedStatus, 'DELIVERED'); // recovered on the next day
});
