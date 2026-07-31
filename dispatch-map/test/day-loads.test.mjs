// test/day-loads.test.mjs — the day's NuVizz loads as one list for the Routing right rail.
//
// Chad, Jul 31: the right rail's "Loads" column showed "No saved loads yet" while the bottom
// grid beside it listed 99 real loads. Two different things share the word "load": a NuVizz
// LOAD (a route on the board) and a SAVED PLAN (optimizer output). The column was wired to the
// second. These pin the list that now backs it.
//
// The load-bearing case is the shape of Chad's actual board: 99 loads, nearly all empty Drafts
// with "No orders yet". Empty loads have NO stops, so they exist only in the roster — if the
// merge drops them the column shows a handful of routes and looks just as broken as before.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeDayLoads, dayLoadTally } from '../src/lib/day-loads.js';

// A routeGroups entry as computeRouteGroups builds it (trimmed to what the merge reads).
const group = (over = {}) => ({
  key: 'TRAILER 6', name: 'TRAILER 6', loadNbr: 'TRAILER 6', loadId: 'hex6',
  driver: 'Marcus Crumpton', count: 12, locCount: 11, delivered: 3, exceptions: 0,
  skids: 26, loose: 21, weight: 3716, status: 'Dispatched', rosterStatus: 'DISPATCHED', ...over,
});
// A roster entry as nuvizz-loads-roster returns it.
const roster = (over = {}) => ({ name: '1 SATL', loadNbr: 'DAVIS000200168', loadId: 'hex168', status: 'Draft', ...over });

test('loads WITH orders and empty Drafts both appear — the empties come only from the roster', () => {
  const rows = mergeDayLoads(
    [group()],
    [roster({ name: '1 SATL' }), roster({ name: '1 WATL', loadNbr: 'DAVIS000200169' })],
  );
  assert.equal(rows.length, 3);
  const t6 = rows.find((r) => r.name === 'TRAILER 6');
  assert.equal(t6.empty, false);
  assert.equal(t6.count, 12);
  assert.equal(t6.driver, 'Marcus Crumpton');
  assert.equal(t6.weight, 3716);
  const satl = rows.find((r) => r.name === '1 SATL');
  assert.equal(satl.empty, true, 'a Draft with no orders is still a load on the day');
  assert.equal(satl.count, 0);
  assert.equal(satl.loadNbr, 'DAVIS000200168', 'the real NuVizz number rides along');
  assert.equal(satl.loadId, 'hex168');
  assert.equal(satl.status, 'Draft');
});

test('a load the board already accounts for is NOT duplicated by its roster row', () => {
  // The same load reached us twice: grouped from its stops, and again in the roster.
  const rows = mergeDayLoads(
    [group({ name: 'TRAILER 6' })],
    [roster({ name: 'trailer 6', loadNbr: 'DAVIS000200999' }), roster({ name: 'ALPHA' })],
  );
  assert.equal(rows.filter((r) => r.name.toLowerCase() === 'trailer 6').length, 1, 'matched case-insensitively');
  assert.equal(rows.find((r) => r.name === 'TRAILER 6').count, 12, 'the stop-derived row wins — it has the real freight');
  assert.equal(rows.length, 2);
});

test("Chad's board: 99 loads, nearly all empty — the working routes sort FIRST, not buried under the Drafts", () => {
  const drafts = ['1 SATL', '1 WATL', '1M', '2 M', 'AB', 'ALLEN C', 'ALPHA', 'ALPHA 2']
    .map((name, i) => roster({ name, loadNbr: `DAVIS00020017${i}`, loadId: `hex17${i}` }));
  const working = [group({ key: 'SUW 2', name: 'SUW 2', count: 9 }), group({ key: 'TRAILER 6', name: 'TRAILER 6', count: 12 })];
  const rows = mergeDayLoads(working, drafts);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.name), ['SUW 2', 'TRAILER 6'], 'built routes first, alphabetical');
  assert.ok(rows.slice(2).every((r) => r.empty), 'every Draft sits below the working routes');
  assert.deepEqual(rows.slice(2).map((r) => r.name), ['1 SATL', '1 WATL', '1M', '2 M', 'AB', 'ALLEN C', 'ALPHA', 'ALPHA 2']);

  const tally = dayLoadTally(rows);
  assert.deepEqual(tally, { total: 10, withOrders: 2, empty: 8, stops: 21 });
});

test('a name carried by two roster loads is FLAGGED, never silently deduped', () => {
  // Identity consumers already refuse ambiguous names; hiding one behind the other is how a
  // card ends up wearing the other load's number.
  const rows = mergeDayLoads([], [
    roster({ name: 'ALPHA', loadId: 'hexA' }),
    roster({ name: 'ALPHA', loadId: 'hexB' }),
    roster({ name: 'BETA', loadId: 'hexC' }),
  ]);
  const alphas = rows.filter((r) => r.name === 'ALPHA');
  assert.equal(alphas.length, 1, 'one row per NAME');
  assert.equal(alphas[0].ambiguous, true, 'but the collision is surfaced');
  assert.equal(rows.find((r) => r.name === 'BETA').ambiguous, false);
});

test('a load with a stop-derived group ALSO gets the ambiguous flag when the roster double-names it', () => {
  const rows = mergeDayLoads([group({ name: 'ALPHA', key: 'ALPHA' })], [
    roster({ name: 'ALPHA', loadId: 'hexA' }), roster({ name: 'ALPHA', loadId: 'hexB' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ambiguous, true, 'the working row is warned too — its identity is not safe');
});

test('junk never becomes a row, and missing inputs are survivable', () => {
  assert.deepEqual(mergeDayLoads(), []);
  assert.deepEqual(mergeDayLoads(null, null), []);
  assert.deepEqual(dayLoadTally(), { total: 0, withOrders: 0, empty: 0, stops: 0 });
  // A roster entry with no name, number OR id identifies nothing — it must not render.
  const rows = mergeDayLoads([], [{ status: 'Draft' }, { name: '', loadNbr: null, loadId: null }, roster({ name: 'OK' })]);
  assert.deepEqual(rows.map((r) => r.name), ['OK']);
});

test('a nameless roster load still shows when it has a number — it falls back for display', () => {
  const rows = mergeDayLoads([], [{ name: '', loadNbr: 'DAVIS000200500', loadId: 'hex500', status: 'Draft' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display, 'DAVIS000200500', 'the number stands in for the missing name');
  assert.equal(rows[0].loadId, 'hex500');
  assert.equal(rows[0].ambiguous, false, 'a blank name is never treated as a name collision');
});

test('a load with zero orders counts as empty in the tally even if it came from a group', () => {
  const rows = mergeDayLoads([group({ name: 'GHOST', count: 0 })], []);
  assert.deepEqual(dayLoadTally(rows), { total: 1, withOrders: 0, empty: 1, stops: 0 });
});
