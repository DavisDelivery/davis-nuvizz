// loaded-sequence-mount.test.mjs — reopening a half-loaded truck keeps the route
// order it was loaded against.
//
// The trailer is a physical record of one route order, so the order in force at
// the first piece is stamped and the screen keeps showing it (with a warning) if
// dispatch resequences mid-load. An EMPTY trailer drops the stamp — nothing to
// protect. But ScanScreen decided "empty" from its `scans` / `handConfirms`
// React state, which starts as [] and is only filled by refreshLocal a moment
// later. The effect's first run always saw an empty truck and deleted the stamp,
// so every time a loader reopened the screen (app restart, truck switch, phone
// asleep) the freeze guard reset and a resequence went unannounced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { queueHasFreightAboard } from '../src/lib/scan-logic.js';

const scanRow = (og, extra = {}) => ({ key: `STEVEN::${og}`, loadNbr: 'STEVEN', date: '2026-09-15', og, pro: '7173250', stopNbr: '4', ...extra });
const handRow = { key: 'STEVEN::HAND::9', kind: 'hand', loadNbr: 'STEVEN', date: '2026-09-15', stopNbr: '9', pieces: 3 };

test('a truck with a skid in the queue has freight aboard, whatever React has rendered yet', () => {
  assert.equal(queueHasFreightAboard([scanRow('OG6028250001')]), true);
});

test('a truck whose only freight is a hand-confirmed stop has freight aboard', () => {
  assert.equal(queueHasFreightAboard([handRow]), true);
});

test('a truck whose every piece was taken back is empty — the stamp may go', () => {
  assert.equal(queueHasFreightAboard([scanRow('OG6028250001', { voidedAt: '2026-09-15T02:00:00Z' })]), false);
  assert.equal(queueHasFreightAboard([]), false);
  assert.equal(queueHasFreightAboard(null), false);
});

test('reopening the scan screen judges "empty trailer" from the queue, never from unhydrated state', async () => {
  // The effect is React + IndexedDB and cannot run here, so its input is pinned on
  // the source: the clear must be decided by the queue read, not by `scans`.
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const v = await store.getLoadedSequence(activeLoad, date);');
  const end = app.indexOf('await store.clearLoadedSequence(activeLoad, date);', start);
  assert.ok(start > 0 && end > start, 'the stamp read and its clear are both still there');
  const decision = app.slice(start, end);
  assert.match(decision, /queueHasFreightAboard\(await store\.queuedFor\(activeLoad, date\)\)/);
  assert.doesNotMatch(decision, /activeScans\(scans\)|handConfirms\.length/, 'not from React state that starts empty');
});
