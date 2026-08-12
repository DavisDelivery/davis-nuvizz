// test/routing-loads.test.mjs — pure helpers for the Shared Loads view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDateTime, tsToMillis, loadTruckCount, loadStopCount, loadSummary, buildLoadAutoName,
} from '../src/lib/routing-loads.js';

test('formatDateTime renders the standard ET format', () => {
  // 2026-06-05T18:14:00Z = 2:14 PM EDT (UTC-4)
  assert.equal(formatDateTime(Date.parse('2026-06-05T18:14:00Z')), 'Jun 5, 2026 2:14p');
  // 2026-01-05T13:05:00Z = 8:05 AM EST (UTC-5)
  assert.equal(formatDateTime(Date.parse('2026-01-05T13:05:00Z')), 'Jan 5, 2026 8:05a');
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime('not a date'), '');
});

test('tsToMillis normalizes Firestore Timestamp / millis / Date / ISO', () => {
  assert.equal(tsToMillis({ toMillis: () => 1717610040000 }), 1717610040000);
  assert.equal(tsToMillis({ seconds: 1717610040, nanoseconds: 0 }), 1717610040000);
  assert.equal(tsToMillis(new Date(1717610040000)).valueOf(), 1717610040000);
  assert.equal(tsToMillis(1717610040000), 1717610040000);
  assert.equal(tsToMillis(null), null);
});

const result = {
  routes: [
    { truckId: 'A', orderedStopIds: ['1', '2', '3'] },
    { truckId: 'B', orderedStopIds: ['4', '5'] },
  ],
  unassigned: [{ stopId: '9', reasons: ['x'] }],
};

test('truck/stop counts and summary', () => {
  assert.equal(loadTruckCount(result), 2);
  assert.equal(loadStopCount(result), 5);
  assert.equal(loadSummary(result), '2 trucks · 5 stops · 1 spilled');
  assert.equal(loadSummary({ routes: [{ truckId: 'A', orderedStopIds: ['1'] }] }), '1 truck · 1 stop');
  assert.equal(loadSummary({}), '0 trucks · 0 stops');
});

test('buildLoadAutoName combines time + summary (no spill in the name)', () => {
  assert.equal(
    buildLoadAutoName(result, Date.parse('2026-06-05T18:14:00Z')),
    'Jun 5, 2026 2:14p · 2 trucks · 5 stops',
  );
});

// ── load identity: the guard that stops a write hitting the wrong truck ───────
//
// A board stop's `loadNbr` is the route NAME, not a load number (nuvizz-list toBoardStop sets
// it from routeName), and the real per-day loadId lives on the roster — STEVEN is a different
// loadId every day. So every write resolves identity through the roster, and the case that
// matters is two live loads sharing one name: picking either is silent and irreversible in
// NuVizz, so the only safe answer is to refuse.
import { buildLoadRosterIndex, resolveLoadIdentity, loadIdentityRefusal } from '../src/lib/routing-loads.js';
import { resolveNameOwner } from '../src/lib/route-status.js';

const L = (over) => ({ loadId: '6a7c3673aaaa', name: 'STEVEN', loadNbr: 'DAVIS000201463', status: 'Dispatched', ...over });
const idxOf = (rows) => buildLoadRosterIndex(rows, resolveNameOwner);
const looksLikeNbr = (v) => /^DAVIS\d+$/i.test(String(v ?? ''));

test('a route name resolves to that day\'s loadId and real load number', () => {
  const idx = idxOf([L()]);
  const got = resolveLoadIdentity({ key: 'STEVEN', name: 'STEVEN' }, idx, looksLikeNbr);
  assert.deepEqual(got, { loadId: '6a7c3673aaaa', loadNbr: 'DAVIS000201463', ambiguous: false });
});

test('lookup is case- and whitespace-insensitive, and works by loadId or load number too', () => {
  const idx = idxOf([L()]);
  assert.ok(resolveLoadIdentity({ name: '  steven ' }, idx, looksLikeNbr));
  assert.ok(resolveLoadIdentity({ name: '6a7c3673aaaa' }, idx, looksLikeNbr));
  assert.ok(resolveLoadIdentity({ name: 'DAVIS000201463' }, idx, looksLikeNbr));
});

test('THE GUARD: two LIVE loads sharing a name refuse to resolve', () => {
  const idx = idxOf([L({ loadId: 'aaa' }), L({ loadId: 'bbb' })]);
  assert.equal(resolveLoadIdentity({ key: 'STEVEN', name: 'STEVEN' }, idx, looksLikeNbr), null,
    'a write must never pick one of two live loads with the same name');
  assert.match(loadIdentityRefusal({ name: 'STEVEN' }, idx), /two live loads/i);
});

test('a CANCELLED twin is not a contest — the live load owns the name', () => {
  const idx = idxOf([L({ loadId: 'dead', status: 'Cancelled' }), L({ loadId: 'live', status: 'Dispatched' })]);
  const got = resolveLoadIdentity({ key: 'STEVEN', name: 'STEVEN' }, idx, looksLikeNbr);
  assert.equal(got?.loadId, 'live', 'a cancelled load holds no work and must not block the live one');
});

test('no loadId anywhere ⇒ refuse, with a reason a dispatcher can act on', () => {
  const idx = idxOf([]);
  assert.equal(resolveLoadIdentity({ key: 'NEW ROUTE', name: 'NEW ROUTE' }, idx, looksLikeNbr), null);
  assert.match(loadIdentityRefusal({ name: 'NEW ROUTE' }, idx), /load id has not loaded/i);
});

test('a route NAME in loadNbr is not sent as a load number', () => {
  // Stops carry "SUW" in loadNbr. Sending that where NuVizz wants DAVIS000201463 fails oddly.
  const idx = idxOf([L({ name: 'SUW', loadNbr: 'DAVIS000201999', loadId: 'suwid' })]);
  const got = resolveLoadIdentity({ key: 'SUW', name: 'SUW', loadNbr: 'SUW' }, idx, looksLikeNbr);
  assert.equal(got.loadNbr, 'DAVIS000201999', 'the roster\'s real number wins over the route name');
});

test('a group that already carries its own loadId resolves even with an empty roster', () => {
  const got = resolveLoadIdentity({ key: 'X', name: 'X', loadId: 'known' }, new Map(), looksLikeNbr);
  assert.equal(got.loadId, 'known');
});

test('buildLoadRosterIndex tolerates junk rows without throwing', () => {
  const idx = buildLoadRosterIndex([null, {}, { name: '   ' }, L()], resolveNameOwner);
  assert.ok(resolveLoadIdentity({ name: 'STEVEN' }, idx, looksLikeNbr));
});
