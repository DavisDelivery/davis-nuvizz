// ONE PRO, ONE ROW — the WINTERS INDUSTRIES card that started this.
//
// The card printed PRO 007142362 three times: twice under "Recent PROs at this
// customer" (07/07/26 and 07/06/26, no driver) and once under "Recent deliveries
// here" (07/06/26, Enock Akyea). Two of those three were note-SAVE dates from
// customer_notes.pro_history, which has never carried a driver and de-dupes only
// against the row before it. These tests pin the merge rule that leaves one row
// per PRO, the delivered fact winning wherever there is one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStopHistory } from '../src/lib/stop-history.js';

// The real card, transcribed from the screenshot.
const WINTERS_DELIVERED = [{ pro: '007142362', date: '2026-07-06', driver: 'Enock Akyea' }];
const WINTERS_PRO_HISTORY = [                       // oldest first, as bumpProHistory appends
  { pro: '007142362', date: '2026-07-06' },
  { pro: '007142362', date: '2026-07-07' },
  { pro: '007175139', date: '2026-09-10' },
];

test('WINTERS INDUSTRIES: the card shows ONE row, the delivery, with its driver', () => {
  const { delivered, seen } = mergeStopHistory(WINTERS_DELIVERED, WINTERS_PRO_HISTORY, ['007175139']);
  assert.deepEqual(delivered, [{ pro: '007142362', date: '2026-07-06', driver: 'Enock Akyea' }]);
  assert.deepEqual(seen, [], 'the open order on this very card is not this customer\'s history');
});

test('the note-save twin never outranks the delivery it duplicates', () => {
  // 07/07 is the day somebody SAVED the note, not a second delivery. If it survived
  // it would sit above the real 07/06 row and answer "when were you last here?" wrong.
  const { delivered, seen } = mergeStopHistory(WINTERS_DELIVERED, WINTERS_PRO_HISTORY, []);
  assert.equal(delivered.length, 1);
  assert.ok(!seen.some((r) => r.pro === '007142362'), 'a delivered PRO never also appears as merely seen');
});

test('a PRO with no delivery on file is kept, and kept as SEEN — never as a delivery', () => {
  const { delivered, seen } = mergeStopHistory(WINTERS_DELIVERED, WINTERS_PRO_HISTORY, []);
  assert.deepEqual(seen, [{ pro: '007175139', date: '2026-09-10' }]);
  assert.ok(!delivered.some((r) => r.pro === '007175139'));
});

test('a customer served before the warehouse existed still shows what we have', () => {
  // The whole reason pro_history cannot simply be deleted: for a customer whose
  // deliveries predate capture, these rows are the only trace we were ever there.
  const { delivered, seen } = mergeStopHistory([], [
    { pro: '006100001', date: '2026-03-11' },
    { pro: '006100001', date: '2026-03-12' },
    { pro: '006100044', date: '2026-04-02' },
  ], []);
  assert.deepEqual(delivered, []);
  assert.deepEqual(seen, [
    { pro: '006100044', date: '2026-04-02' },
    { pro: '006100001', date: '2026-03-12' },   // the LAST save for that PRO, not the first
  ]);
});

test('the same order padded one place and bare in another is ONE order', () => {
  const { delivered, seen } = mergeStopHistory(
    [{ pro: '007142362', date: '2026-07-06', driver: 'Enock Akyea' }],
    [{ pro: '7142362', date: '2026-07-07' }],
    [],
  );
  assert.equal(delivered.length, 1);
  assert.deepEqual(seen, [], 'the bare form is the same PRO as the padded one');
});

test('deliveries read newest first', () => {
  const { delivered } = mergeStopHistory([
    { pro: 'A', date: '2026-05-01', driver: 'Jeff' },
    { pro: 'C', date: '2026-08-20', driver: 'Victor' },
    { pro: 'B', date: '2026-07-04', driver: 'Colin' },
  ], [], []);
  assert.deepEqual(delivered.map((r) => r.pro), ['C', 'B', 'A']);
});

test('a duplicate in the rollup itself is still printed once', () => {
  // The rollup de-dupes on write (mergeProEntries), but it is written by another
  // process — trusting that and printing a twin is exactly the bug being fixed.
  const { delivered } = mergeStopHistory([
    { pro: '007142362', date: '2026-07-06', driver: 'Enock Akyea' },
    { pro: '007142362', date: '2026-07-06', driver: 'Enock Akyea' },
  ], [], []);
  assert.equal(delivered.length, 1);
});

test('a delivery with no driver recorded still shows — it is a fact with a gap, not a non-event', () => {
  const { delivered } = mergeStopHistory([{ pro: 'X', date: '2026-07-06', driver: null }], [], []);
  assert.deepEqual(delivered, [{ pro: 'X', date: '2026-07-06', driver: '' }]);
});

test('empty, absent and malformed inputs produce two empty lists, never a throw', () => {
  for (const args of [[null, null, null], [undefined, undefined, undefined], [[], [], []],
    [[{}, { pro: '' }, null], [{ pro: null }, 'junk'], [null, '']]]) {
    const out = mergeStopHistory(...args);
    assert.deepEqual(out.delivered, []);
    assert.deepEqual(out.seen, []);
  }
});

test('every PRO on a multi-PRO stop is dropped from its own history', () => {
  const { seen } = mergeStopHistory([], [
    { pro: '007175139', date: '2026-09-10' },
    { pro: '007175140', date: '2026-09-10' },
    { pro: '006100001', date: '2026-03-11' },
  ], ['007175139', '007175140']);
  assert.deepEqual(seen, [{ pro: '006100001', date: '2026-03-11' }]);
});
