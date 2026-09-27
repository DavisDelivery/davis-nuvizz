// test/driver-snapshot-shared-window.test.mjs
//
// THE DEFECT (review 2026-09-03, A1-S4-6). The driver snapshot (desktop sidebar and phone
// drawer — one body serves both) judged every completed stop against its scheduledTime. That
// field is the saved search's "Estimated Arrival", and on most loads it is ONE generic window
// stamped on every stop — twelve consignees do not all book 8:00 AM. So a driver who ran his
// route perfectly read "187 min late ⚠" on stop nine and an on-time rate near zero. The route
// card already knows this (loadDefaultWindow suppresses the shared window there); the snapshot
// now applies the same rule: a stop whose only time is its load's shared window has no
// appointment, so it is neither marked late nor counted in the on-time rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  classifyTimeliness, snapshotSharedWindows, snapshotStopTimeliness, snapshotOnTime,
} from '../src/lib/driver-snapshot-timeliness.js';

const SHARED = '2026-09-22T08:00:00-04:00';
const stop = (pro, loadNbr, scheduledTime, actualArrival, status = 'completed') => ({ pro, loadNbr, scheduledTime, actualArrival, status });

// A 5-stop BRIAN load where the vendor stamped 8:00 on four stops and one customer really
// booked 1:00 PM.
const BRIAN = [
  stop('1', 'BRIAN', SHARED, '2026-09-22T08:40:00-04:00'),
  stop('2', 'BRIAN', SHARED, '2026-09-22T09:30:00-04:00'),
  stop('3', 'BRIAN', SHARED, '2026-09-22T11:07:00-04:00'),
  stop('4', 'BRIAN', SHARED, null, 'pending'),
  stop('5', 'BRIAN', '2026-09-22T13:00:00-04:00', '2026-09-22T13:40:00-04:00'),
];

test('a stop delivered at 11:07 on a load whose stops all carry the shared 8:00 window is not marked late', () => {
  const w = snapshotSharedWindows(BRIAN);
  assert.equal(w.get('BRIAN'), SHARED, 'the load-wide window is detected from the data');
  assert.equal(snapshotStopTimeliness(BRIAN[2], w), null, 'no appointment ⇒ no verdict, no "187 min late ⚠"');
});

test('a real appointment on the same load is still judged — 40 minutes past 1:00 PM is late', () => {
  const t = snapshotStopTimeliness(BRIAN[4], snapshotSharedWindows(BRIAN));
  assert.equal(t.kind, 'late');
  assert.equal(t.deltaMin, 40);
});

test('the on-time rate counts only stops that had an appointment to meet', () => {
  const r = snapshotOnTime(BRIAN, snapshotSharedWindows(BRIAN));
  assert.deepEqual(r, { onTime: 0, total: 1, pct: 0 }, 'one judged stop (the 1:00 PM), and it was late');
  const onlyShared = BRIAN.slice(0, 4);
  assert.equal(snapshotOnTime(onlyShared, snapshotSharedWindows(onlyShared)), null,
    'a route with no appointments has no on-time rate — not 0%');
});

test('each load is judged against its own shared window, not the driver\'s other load', () => {
  const second = [
    stop('6', 'BRIAN 2', '2026-09-22T12:00:00-04:00', '2026-09-22T12:05:00-04:00'),
    stop('7', 'BRIAN 2', '2026-09-22T12:00:00-04:00', '2026-09-22T14:30:00-04:00'),
    stop('8', 'BRIAN 2', '2026-09-22T12:00:00-04:00', '2026-09-22T15:00:00-04:00'),
  ];
  const all = [...BRIAN, ...second];
  const w = snapshotSharedWindows(all);
  assert.equal(w.get('BRIAN'), SHARED);
  assert.equal(w.get('BRIAN 2'), '2026-09-22T12:00:00-04:00');
  assert.equal(snapshotStopTimeliness(second[1], w), null);
  // A shared-looking 8:00 on the OTHER load's stop is judged: it is not that load's window.
  const odd = stop('9', 'BRIAN 2', SHARED, '2026-09-22T09:00:00-04:00');
  assert.equal(snapshotStopTimeliness(odd, snapshotSharedWindows([...all, odd])).kind, 'late');
});

test('a two-stop load that happens to share a time is too small to call a default, and is judged as before', () => {
  const two = [stop('1', 'X', SHARED, '2026-09-22T09:00:00-04:00'), stop('2', 'X', SHARED, '2026-09-22T08:05:00-04:00')];
  const w = snapshotSharedWindows(two);
  assert.equal(w.size, 0);
  assert.equal(snapshotStopTimeliness(two[0], w).kind, 'late');
  assert.deepEqual(snapshotOnTime(two, w), { onTime: 1, total: 2, pct: 50 });
});

test('empty, absent and malformed snapshots do not crash and do not invent a rate', () => {
  assert.equal(snapshotSharedWindows(null).size, 0);
  assert.equal(snapshotOnTime([], new Map()), null);
  assert.equal(snapshotOnTime(null, null), null);
  assert.equal(snapshotStopTimeliness({ status: 'completed' }, null), null);
  assert.equal(classifyTimeliness('not a date', '2026-09-22T09:00:00Z'), null);
});

test('the snapshot body judges through the shared-window rule, not the raw scheduled time', () => {
  const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = APP.indexOf('function DriverSnapshotBody(');
  assert.ok(start > 0);
  const body = APP.slice(start, APP.indexOf('\nfunction ', start + 1));
  assert.doesNotMatch(body, /classifyTimeliness\(s\.scheduledTime/, 'no row or rate is judged against the raw window');
  assert.match(body, /snapshotStopTimeliness\(s, sharedWindows\)/, 'the per-row late marker uses the rule');
  assert.match(body, /snapshotOnTime\(stops, sharedWindows\)/, 'the on-time rate uses the rule');
});
