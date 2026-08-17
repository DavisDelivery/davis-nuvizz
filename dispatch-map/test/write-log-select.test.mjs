// test/write-log-select.test.mjs
//
// The ledger is the only record of what a Save actually sent, so during an
// incident it is the evidence. On 2026-08-17 it could not size an address
// corruption because it returned the last 25 rows of EVERYTHING and 23 of them
// were an unrelated bulk push. These tests pin the property that fixes that:
// FILTER FIRST, CUT SECOND — and say honestly when the cut hid something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWriteOps, countWriteOps } from '../netlify/functions/lib/write-log-select.mts';

const row = (at, op, status) => ({ at, op, status, clientOpId: `op_${at}` });

// A realistic afternoon: two damaging date writes with a bulk push landing
// BETWEEN them, which is what pushes the earlier one out of a 25-row window.
const LEDGER = [
  row('2026-08-17T20:09:28Z', 'setStopDate', 'failed'),
  ...Array.from({ length: 30 }, (_, i) => row(`2026-08-17T18:${String(i).padStart(2, '0')}:00Z`, 'createStop', 'succeeded')),
  row('2026-08-17T17:37:12Z', 'setStopDate', 'failed'),
  row('2026-08-10T09:00:00Z', 'setStopDate', 'succeeded'),
];

test('the incident question is answerable: every failed setStopDate, unburied', () => {
  const ops = selectWriteOps(LEDGER, { op: 'setStopDate', status: 'failed', limit: 25 });
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map((o) => o.at), ['2026-08-17T20:09:28Z', '2026-08-17T17:37:12Z']);
});

test('WITHOUT filtering, a bulk push buries a damaging write — the bug this fixes', () => {
  // The old behaviour: newest 25 rows of EVERYTHING. The 17:37 date write falls
  // off the end behind 30 routine creates, so the damage reads as half its size.
  const ops = selectWriteOps(LEDGER, { limit: 25 });
  assert.equal(ops.length, 25);
  assert.equal(ops.filter((o) => o.op === 'setStopDate').length, 1, 'only the newest date write survives the cut');
  // Filtering first recovers both, at the same limit.
  assert.equal(selectWriteOps(LEDGER, { op: 'setStopDate', status: 'failed', limit: 25 }).length, 2);
});

test('newest first, always', () => {
  const ops = selectWriteOps(LEDGER, { limit: 100 });
  const ats = ops.map((o) => o.at);
  assert.deepEqual(ats, [...ats].sort().reverse());
});

test('filters are case-insensitive — nobody types the op name exactly', () => {
  assert.equal(selectWriteOps(LEDGER, { op: 'SETSTOPDATE', limit: 50 }).length, 3);
  assert.equal(selectWriteOps(LEDGER, { status: 'FAILED', limit: 50 }).length, 2);
});

test('since trims by instant', () => {
  assert.equal(selectWriteOps(LEDGER, { op: 'setStopDate', since: '2026-08-17', limit: 50 }).length, 2);
  assert.equal(selectWriteOps(LEDGER, { op: 'setStopDate', since: '2026-08-01', limit: 50 }).length, 3);
});

test('matched counts what the limit hid, so a caller knows to widen', () => {
  assert.equal(countWriteOps(LEDGER, { op: 'createStop' }), 30);
  const ops = selectWriteOps(LEDGER, { op: 'createStop', limit: 5 });
  assert.equal(ops.length, 5);
  assert.ok(countWriteOps(LEDGER, { op: 'createStop' }) > ops.length, 'truncation is detectable');
});

test('rows with no timestamp are dropped rather than ordered arbitrarily', () => {
  const ops = selectWriteOps([{ op: 'setStopDate' }, null, undefined, row('2026-08-17T20:00:00Z', 'setStopDate', 'failed')], { limit: 10 });
  assert.equal(ops.length, 1);
});

test('an empty or junk ledger returns nothing rather than throwing', () => {
  for (const junk of [[], null, undefined, 'nope', 42]) {
    assert.deepEqual(selectWriteOps(junk, { limit: 5 }), []);
  }
});
