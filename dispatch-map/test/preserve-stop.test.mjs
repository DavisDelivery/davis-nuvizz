// test/preserve-stop.test.mjs — writeStops preserve-vs-prune rule (Phase 2 safety).
// The data-loss guard for lean discovery: a partial load scan (terminal loads
// skipped) must PRESERVE the planned stops it didn't re-pull, not prune them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { preserveStopOnWrite } from '../netlify/functions/lib/firestore.mts';

const planned = { isPlanned: true };
const unplanned = { isPlanned: false };

test('full scan (loads + unplanned): nothing preserved — un-rescanned stops prune as before', () => {
  const o = { includeUnplanned: true, includeLoads: true };
  assert.equal(preserveStopOnWrite(planned, o), false);
  assert.equal(preserveStopOnWrite(unplanned, o), false);
});

test('load-only run preserves existing unplanned; unplanned-only run preserves existing planned', () => {
  assert.equal(preserveStopOnWrite(unplanned, { includeUnplanned: false, includeLoads: true }), true);
  assert.equal(preserveStopOnWrite(planned, { includeUnplanned: false, includeLoads: true }), false);
  assert.equal(preserveStopOnWrite(planned, { includeUnplanned: true, includeLoads: false }), true);
  assert.equal(preserveStopOnWrite(unplanned, { includeUnplanned: true, includeLoads: false }), false);
});

test('partialLoads (lean): PRESERVES planned stops not re-scanned (terminal-skip safety)', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true };
  assert.equal(preserveStopOnWrite(planned, o), true, 'delivered/terminal planned stop survives the lean cycle');
  // unplanned still follows the unplanned-feed rule (descent ran, so not preserved here)
  assert.equal(preserveStopOnWrite(unplanned, o), false);
});
