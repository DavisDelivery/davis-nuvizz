// test/day-loads.test.mjs — the day's NuVizz loads as one list for the Routing right rail.
//
// Chad, Jul 31: the right rail's "Loads" column showed "No saved loads yet" while the bottom
// grid beside it listed 99 real loads. Two different things share the word "load": a NuVizz
// LOAD (a route on the board) and a SAVED PLAN (optimizer output). The column was wired to the
// second.
//
// Then, on the two STEVENs: "shouldn't they have different load numbers so for this particular
// day we should display both … the active and canceled one." Right — NuVizz identifies a load
// by its NUMBER, and a name is a label two loads can wear at once. So the ROSTER is the list
// (one row per load, each with its own number and stop count), and board data is merged ONTO
// the row it belongs to, matched by identity.
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
const roster = (over = {}) => ({ name: '1 SATL', loadNbr: 'DAVIS000200168', loadId: 'hex168', status: 'Draft', trips: 0, ...over });

test('every load on the day gets a row, with its own number — built routes and empty Drafts alike', () => {
  const rows = mergeDayLoads(
    [group()],
    [roster({ name: 'TRAILER 6', loadId: 'hex6', loadNbr: 'DAVIS000200600', trips: 12, status: 'Dispatched' }),
     roster({ name: '1 SATL' }), roster({ name: '1 WATL', loadNbr: 'DAVIS000200169', loadId: 'hex169' })],
  );
  assert.equal(rows.length, 3);
  const t6 = rows.find((r) => r.name === 'TRAILER 6');
  assert.equal(t6.count, 12);
  assert.equal(t6.driver, 'Marcus Crumpton', 'board data merged onto the roster row');
  assert.equal(t6.loadNbr, 'DAVIS000200600', 'and it carries the REAL load number, not the route name');
  assert.equal(t6.onBoard, true);
  const satl = rows.find((r) => r.name === '1 SATL');
  assert.equal(satl.empty, true);
  assert.equal(satl.loadNbr, 'DAVIS000200168');
  assert.equal(satl.onBoard, false);
});

test("Chad's two STEVENs: BOTH show, each with its own number and its own status", () => {
  // The whole point: the cancelled one is a real load on the day and must not be hidden
  // behind the live one just because they share a name.
  const rows = mergeDayLoads([], [
    roster({ name: 'STEVEN', loadId: 'hexOLD', loadNbr: 'DAVIS000200100', status: 'Cancelled', trips: 0 }),
    roster({ name: 'STEVEN', loadId: 'hexNEW', loadNbr: 'DAVIS000200400', status: 'Dispatched', trips: 16 }),
  ]);
  assert.equal(rows.length, 2, 'both loads listed');
  const dead = rows.find((r) => r.loadNbr === 'DAVIS000200100');
  const live = rows.find((r) => r.loadNbr === 'DAVIS000200400');
  assert.equal(dead.status, 'Cancelled');
  assert.equal(dead.count, 0);
  assert.equal(live.status, 'Dispatched');
  assert.equal(live.count, 16, "the roster's own trip count per load");
  assert.deepEqual(rows.map((r) => r.loadNbr), ['DAVIS000200400', 'DAVIS000200100'], 'the one with work sorts first');
  // Both are flagged so the UI can say why two rows wear one name.
  assert.ok(dead.ambiguous && live.ambiguous);
});

test('board stops attach to the load they belong to by IDENTITY, never by a contested name', () => {
  const rows = mergeDayLoads(
    [group({ key: 'STEVEN', name: 'STEVEN', loadId: 'hexNEW', count: 16, driver: 'Steven Adjetey', delivered: 0 })],
    [roster({ name: 'STEVEN', loadId: 'hexOLD', loadNbr: 'DAVIS000200100', status: 'Cancelled', trips: 0 }),
     roster({ name: 'STEVEN', loadId: 'hexNEW', loadNbr: 'DAVIS000200400', status: 'Dispatched', trips: 16 })],
  );
  assert.equal(rows.length, 2, 'the board group merged into a load — it did not become a third row');
  const live = rows.find((r) => r.loadId === 'hexNEW');
  assert.equal(live.driver, 'Steven Adjetey');
  assert.equal(live.count, 16);
  assert.equal(rows.find((r) => r.loadId === 'hexOLD').driver, '', 'the cancelled load got none of it');
});

test('board stops that CANNOT be attributed get their own row and say so — never guessed onto a load', () => {
  // The real shape of the bug: the stops feed carries no load number, so an unenriched board
  // group has no id. With two same-named loads, showing 16 orders against the wrong STEVEN is
  // worse than showing them unattached.
  const rows = mergeDayLoads(
    [group({ key: 'STEVEN', name: 'STEVEN', loadId: null, loadNbr: 'STEVEN', count: 16 })],
    [roster({ name: 'STEVEN', loadId: 'hexOLD', loadNbr: 'DAVIS000200100', status: 'Cancelled', trips: 0 }),
     roster({ name: 'STEVEN', loadId: 'hexNEW', loadNbr: 'DAVIS000200400', status: 'Dispatched', trips: 16 })],
  );
  assert.equal(rows.length, 3);
  const orphan = rows.find((r) => r.unattributed);
  assert.ok(orphan, 'the unattributable board work is visible, not silently dropped');
  assert.equal(orphan.count, 16);
  assert.equal(rows.filter((r) => r.fromRoster).length, 2, 'and both real loads still listed');
});

test('an UNCONTESTED name is still a safe join — a board group merges onto its roster row', () => {
  const rows = mergeDayLoads(
    [group({ key: 'SUW 2', name: 'SUW 2', loadId: null, loadNbr: 'SUW 2', count: 9, driver: 'Owusu' })],
    [roster({ name: 'SUW 2', loadId: 'hexSUW', loadNbr: 'DAVIS000200500', status: 'Planned', trips: 9 })],
  );
  assert.equal(rows.length, 1, 'one load, one row — no phantom duplicate');
  assert.equal(rows[0].driver, 'Owusu');
  assert.equal(rows[0].loadNbr, 'DAVIS000200500', 'the row keeps the real number for opening it');
});

test('a load the roster does not know still shows — a stale roster never hides live board work', () => {
  const rows = mergeDayLoads([group({ key: 'GHOST', name: 'GHOST', loadId: 'hexG', count: 4 })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 4);
  assert.equal(rows[0].fromRoster, false);
});

test("Chad's board shape: working routes sort above the Drafts", () => {
  const drafts = ['1 SATL', '1 WATL', '1M', '2 M', 'AB', 'ALLEN C', 'ALPHA', 'ALPHA 2']
    .map((name, i) => roster({ name, loadNbr: `DAVIS00020017${i}`, loadId: `hex17${i}`, trips: 0 }));
  const working = [
    roster({ name: 'SUW 2', loadId: 'hexS', loadNbr: 'DAVIS000200900', status: 'Planned', trips: 9 }),
    roster({ name: 'TRAILER 6', loadId: 'hex6', loadNbr: 'DAVIS000200600', status: 'Dispatched', trips: 12 }),
  ];
  const rows = mergeDayLoads([group({ key: 'SUW 2', name: 'SUW 2', loadId: 'hexS', count: 9 }), group({ loadId: 'hex6' })], [...drafts, ...working]);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.name), ['SUW 2', 'TRAILER 6']);
  assert.ok(rows.slice(2).every((r) => r.empty));
  assert.deepEqual(dayLoadTally(rows), { total: 10, withOrders: 2, empty: 8, stops: 21 });
});

test('junk never becomes a row, and missing inputs are survivable', () => {
  assert.deepEqual(mergeDayLoads(), []);
  assert.deepEqual(mergeDayLoads(null, null), []);
  assert.deepEqual(dayLoadTally(), { total: 0, withOrders: 0, empty: 0, stops: 0 });
  const rows = mergeDayLoads([], [null, undefined, roster({ name: 'OK', loadId: 'hexOK' })]);
  assert.deepEqual(rows.map((r) => r.name), ['OK']);
});

test('a nameless roster load still shows, falling back to its number for display', () => {
  const rows = mergeDayLoads([], [{ name: '', loadNbr: 'DAVIS000200500', loadId: 'hex500', status: 'Draft', trips: 0 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display, 'DAVIS000200500');
  assert.equal(rows[0].ambiguous, false, 'a blank name is never a collision');
});
