// test/history-range-future-label.test.mjs — THE HEADER MAY NOT CLAIM TODAY FOR A WINDOW
// THAT DOES NOT HOLD IT.
//
// THE DEFECT (audit 2026-09-27, client-lookup-account-libs-7). rangeLabel's "board ahead"
// branch ran whenever the window ended after today, so a window that also STARTED after today
// — a dispatcher checking tomorrow's queue corrections, Sep 29 – Oct 1 on Sep 28 — was headed
// "Today + the board ahead", and an empty list under it read as covering today too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, rangeLabel, QUEUE_DAYS_AHEAD } from '../src/lib/history-range.js';

const TODAY = '2026-09-28';
const label = (sel) => rangeLabel(resolveRange(sel, TODAY, QUEUE_DAYS_AHEAD), TODAY);

test("a dispatcher checking only the days after today is not told the list covers today", () => {
  assert.equal(label({ kind: 'range', from: '2026-09-29', to: '2026-10-01' }), 'Sep 29 – Oct 1 · 3 days');
  assert.equal(label({ kind: 'range', from: '2026-09-30', to: '2026-10-02' }), 'Sep 30 – Oct 2 · 3 days');
});

test('a window that does hold today still says so', () => {
  assert.equal(label({ kind: 'range', from: '2026-09-28', to: '2026-10-01' }), 'Today + the board ahead');
  assert.equal(label({ kind: 'range', from: '2026-09-27', to: '2026-10-01' }), 'Last 2 days + the board ahead');
  assert.equal(label({ kind: 'days', days: 14 }), 'Last 14 days + the board ahead');
  assert.equal(label({ kind: 'day', date: '2026-09-29' }), 'Sep 29');
});
