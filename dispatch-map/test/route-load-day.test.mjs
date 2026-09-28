// test/route-load-day.test.mjs
//
// AN ORDER ON A LOAD IS FILED ON THAT LOAD'S DAY (v1.82.0, lib/route-load-day.mts).
//
// Chad, 2026-09-27, with WHITING TURNER 007182304-1 (11 skids) and POREX on Monday's MARCUS and
// both missing from Monday's MARCUS card: "It shouldn't move the day at all should just show them
// as unplanned. On any given day we could be planning unplanned orders from previous day." Then:
// "I want every part of app to know and use the proper load numbers for the correct day."
//
// The fixtures are the real Saturday 9/26 board, reduced: the load numbers are the rosters'
// (MARCUS Fri DAVIS000204535 / Mon DAVIS000204645, DARVIN Mon DAVIS000204644, TERRANCE Fri
// DAVIS000204484), and the memberships are the ones read on 9/27 — POREX on DAVIS000204645, IES
// on DAVIS000204644, EP HEADCOVERS still on Friday's DAVIS000204484.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  routeLoadDayEnabled, routeLoadDayReadMax, isCarryCandidate, shownCounts, hasRoom, countAgrees, liveLoadsNamed, ownDayLoad, holds, readUsable,
  readsWanted, resolveRow, stampResolution, stampRosterNames, applyRouteLoadDay, membershipFor,
  listStamp, pullStamp, etMinuteOf, coverStamp, memoValidFor,
  ROUTE_LOAD_FIELDS, MEMO_REFRESH_CURRENT_MS, MEMO_MAX_CURRENT_MS, MEMO_MAX_PAST_MS, READ_SETTLE_MS,
} from '../netlify/functions/lib/route-load-day.mts';
import { stampedLoadOf, heldLoadOf } from '../src/lib/route-load-stamp.js';
import { boardDayFor, bucketByDate, dedupeTwoScan, mergeTwoScan, LIVE_LIST_FIELDS, mergeEnrich, absentPlanDemoteCandidate } from '../netlify/functions/lib/nuvizz-list.mts';
import { stopLoadId, dropForeignLoadStops } from '../netlify/functions/lib/nuvizz-loads.mts';
import { LEAN_STOP_FIELDS } from '../netlify/functions/lib/board-fields.mts';
import { POOL_LIVE_FIELDS } from '../netlify/functions/lib/active-pool.mts';

const SAT = '2026-09-26';
const FRI = '2026-09-25';
const MON = '2026-09-28';
const TUE = '2026-09-29';
const HORIZON = [SAT, MON, TUE];
const NOW = Date.parse('2026-09-27T00:30:54.943Z');

// Every list row carries NuVizz's own "Stop Updated" (listUpdatedDTTM, zone-less ET) — here Friday
// 17:56, the minute POREX and 007182396 read on the real 9/26 board: before any read in these tests.
const TOUCHED_FRI = '2026-09-25T17:56:00';
const row = (nbr, route, { own = FRI, status = '20', norm = 'SCHEDULED', seq = null, upd = TOUCHED_FRI, extra = {} } = {}) => ({
  stopNbr: nbr, routeName: route, loadNbr: route, routeSeq: seq, driverName: route ? `${route} DRIVER` : null,
  boardDate: own, scheduledDate: own, status, normalizedStatus: norm, isPlanned: !!route, isUnplanned: !route, listUpdatedDTTM: upd, ...extra,
});

const L = (name, loadNbr, loadId, trips, status = 'Draft') => ({ name, loadNbr, loadId, trips, status, driver: `${name} DRIVER` });
const ROSTERS = () => new Map([
  [FRI, [L('MARCUS', 'DAVIS000204535', 'id-fri-marcus', 13, 'In-Progress'), L('TERRANCE', 'DAVIS000204484', 'id-fri-terrance', 9, 'Dispatched'), L('DARVIN', 'DAVIS000204532', 'id-fri-darvin', 19, 'In-Progress')]],
  [SAT, []],   // NuVizz returned no loads for Saturday
  [MON, [L('MARCUS', 'DAVIS000204645', 'id-mon-marcus', 13), L('DARVIN', 'DAVIS000204644', 'id-mon-darvin', 14), L('TERRANCE', 'DAVIS000204590', 'id-mon-terrance', 0)]],
  [TUE, [L('MARCUS', 'DAVIS000204700', 'id-tue-marcus', 0)]],
]);
const MON_MARCUS = new Set(['007182304-1', '7182304-1', '007182396', '7182396', '007182472', '7182472']);
const MON_DARVIN = new Set(['007182149', '7182149', '007182001', '7182001']);
const FRI_TERRANCE = new Set(['007182123', '7182123']);
const FRI_MARCUS = new Set(['007182304', '7182304']);   // the parent, delivered Friday

const ctx = (members, extra = {}) => ({ today: SAT, horizon: HORIZON, rosters: ROSTERS(), members, ...extra });
// A stored read taken at `atMs`, covering every change NuVizz stamped before `cover`.
const memoOf = (set, { atMs = NOW - 60_000, trips = null, cover = '2026-09-26T20:00' } = {}) => ({ at: new Date(atMs).toISOString(), trips, members: [...set], cover });

test('the switch is house-shaped: default on, off-words off, anything malformed stays on', () => {
  assert.equal(routeLoadDayEnabled({}), true);
  for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(routeLoadDayEnabled({ NUVIZZ_ROUTE_LOAD_DAY: v }), false, v);
  for (const v of ['on', '1', 'yes', 'of', 'nope', '']) assert.equal(routeLoadDayEnabled({ NUVIZZ_ROUTE_LOAD_DAY: v }), true, v);
  assert.equal(routeLoadDayReadMax({}), 4);
  assert.equal(routeLoadDayReadMax({ NUVIZZ_ROUTE_LOAD_DAY_READS: '0' }), 0);
  assert.equal(routeLoadDayReadMax({ NUVIZZ_ROUTE_LOAD_DAY_READS: 'lots' }), 4);
});

test('WHITING TURNER 007182304-1, dated Friday and planned on Monday\'s MARCUS, is filed on MONDAY with DAVIS000204645', () => {
  const r = row('007182304-1', 'MARCUS', { seq: 3 });
  const res = resolveRow(r, ctx(new Map([['DAVIS000204645', MON_MARCUS], ['DAVIS000204700', new Set()]])));
  assert.equal(res.kind, 'load');
  assert.equal(res.day, MON);
  assert.equal(res.load.loadNbr, 'DAVIS000204645');
  stampResolution(r, res);
  assert.equal(r.loadDay, MON);
  assert.equal(r.rosterLoadNbr, 'DAVIS000204645');
  assert.equal(r.rosterLoadId, 'id-mon-marcus');
  assert.equal(r.rosterLoadVia, 'membership');
  assert.equal(r.rosterLoadRoute, 'MARCUS', 'the route the stamp was written for — a Save onto another route voids it');
  // …and the ONE filing authority now puts it there. Before this, boardDayFor said Saturday.
  assert.equal(boardDayFor(r, SAT, null), MON);
  // The route name the whole app groups by is left exactly as it was.
  assert.equal(r.loadNbr, 'MARCUS');
  assert.equal(r.routeName, 'MARCUS');
});

test('THE REGRESSION: without the stamp, the old clamp still files that order on Saturday', () => {
  assert.equal(boardDayFor(row('007182304-1', 'MARCUS'), SAT, null), SAT);
});

test('TERRANCE\'s EP HEADCOVERS, still on Friday\'s load and on no load from today on, is shown UNPLANNED with the load that holds it', () => {
  const r = row('007182123', 'TERRANCE', { seq: 1 });
  const members = new Map([['DAVIS000204590', new Set()], ['DAVIS000204484', FRI_TERRANCE]]);
  const res = resolveRow(r, ctx(members));
  assert.equal(res.kind, 'held');
  stampResolution(r, res);
  assert.equal(r.isPlanned, false);
  assert.equal(r.isUnplanned, true);
  assert.equal(r.normalizedStatus, 'UNPLANNED');
  assert.equal(r.loadNbr, null);
  assert.equal(r.routeName, null);
  assert.equal(r.status, '20', 'NuVizz\'s own status code stays — the record is still on that load');
  assert.deepEqual({ route: r.heldOn.route, loadNbr: r.heldOn.loadNbr, day: r.heldOn.day }, { route: 'TERRANCE', loadNbr: 'DAVIS000204484', day: FRI });
  // In today's pool — the day the dispatcher plans the previous days' leftovers — and its own date is untouched.
  assert.equal(boardDayFor(r, SAT, null), SAT);
  assert.equal(r.boardDate, FRI);
});

test('nothing moves on a guess: an unread load from today on leaves the order exactly where the old rule filed it', () => {
  const r = row('007182304-1', 'MARCUS');
  const res = resolveRow(r, ctx(new Map()));
  assert.equal(res.kind, 'unresolved');
  assert.match(res.reason, /DAVIS000204645/);
  assert.equal(boardDayFor(r, SAT, null), SAT);
});

test('a failed read, or an EMPTY read of a load the roster counts stops on, is not "holds nothing"', () => {
  const r = row('007182304-1', 'MARCUS');
  assert.equal(resolveRow(r, ctx(new Map([['DAVIS000204645', null], ['DAVIS000204700', new Set()]]))).kind, 'unresolved');
  assert.equal(resolveRow(r, ctx(new Map([['DAVIS000204645', new Set()], ['DAVIS000204700', new Set()]]))).kind, 'unresolved');
  assert.equal(readUsable(new Set(), 13), false);
  assert.equal(readUsable(new Set(), 0), true);
  assert.equal(readUsable(null, 0), false);
});

test('"held" needs POSITIVE proof: on no load from today on is not enough without its own past load holding it', () => {
  const r = row('007182777', 'TERRANCE');
  // Friday's TERRANCE was read and does NOT hold it — it is on neither, so nothing is claimed.
  const res = resolveRow(r, ctx(new Map([['DAVIS000204590', new Set()], ['DAVIS000204484', FRI_TERRANCE]])));
  assert.equal(res.kind, 'unresolved');
});

test('a horizon day whose roster was never captured could hold the load — "held" is refused', () => {
  const r = row('007182123', 'TERRANCE');
  const c = ctx(new Map([['DAVIS000204590', new Set()], ['DAVIS000204484', FRI_TERRANCE]]));
  c.rosters.set(TUE, null);
  const res = resolveRow(r, c);
  assert.equal(res.kind, 'unresolved');
  assert.match(res.reason, /no roster captured for 2026-09-29/);
});

test('two LIVE loads under one name on Monday: the read decides, never the name', () => {
  const r = row('007190001', 'ESTES');
  const c = ctx(new Map([['DAVIS000300001', new Set(['7190009'])], ['DAVIS000300002', new Set(['007190001', '7190001'])]]));
  c.rosters.set(MON, [L('ESTES', 'DAVIS000300001', 'e1', 10), L('ESTES', 'DAVIS000300002', 'e2', 7)]);
  const res = resolveRow(r, c);
  assert.equal(res.kind, 'load');
  assert.equal(res.load.loadNbr, 'DAVIS000300002');
});

test('a cancelled load never holds live freight, and is never read', () => {
  const loads = liveLoadsNamed('STEVEN', [MON], new Map([[MON, [L('STEVEN', 'DAVIS1', 'a', 5, 'Cancelled'), L('STEVEN', 'DAVIS2', 'b', 5)]]]));
  assert.deepEqual(loads.map((l) => l.loadNbr), ['DAVIS2']);
});

test('what the rule leaves alone: delivered orders, unrouted orders, orders dated today or later, dispatcher-set dates', () => {
  assert.equal(isCarryCandidate(row('1', 'MARCUS', { norm: 'DELIVERED', status: '90' }), SAT), false);
  assert.equal(isCarryCandidate(row('2', null), SAT), false);
  assert.equal(isCarryCandidate(row('3', 'MARCUS', { own: MON }), SAT), false);
  assert.equal(isCarryCandidate(row('4', 'MARCUS', { own: SAT }), SAT), false);
  assert.equal(isCarryCandidate(row('5', 'MARCUS'), SAT, () => true), false);
  assert.equal(isCarryCandidate(row('6', 'MARCUS'), SAT), true);
  assert.equal(isCarryCandidate(row('7', 'MARCUS', { own: null }), SAT), true, 'a dateless routed order is carried work too');
});

test('reads are asked for loads from today on FIRST, then the past loads — and a past load only once "held" is within reach', () => {
  const rows = [row('007182304-1', 'MARCUS'), row('007182396', 'MARCUS'), row('007182123', 'TERRANCE'), row('007182149', 'DARVIN')];
  const c = ctx(new Map());
  assert.deepEqual(readsWanted(rows, { ...c, phase: 'current' }).map((l) => l.loadNbr), ['DAVIS000204645', 'DAVIS000204700', 'DAVIS000204590', 'DAVIS000204644']);
  assert.deepEqual(readsWanted(rows, { ...c, phase: 'past' }).map((l) => l.loadNbr), [], 'no past read while any load from today on is unknown');
  // Monday's loads read: MARCUS and DARVIN hold theirs, Monday's TERRANCE holds nothing → only
  // Friday's TERRANCE is worth a read. Not Friday's MARCUS or DARVIN: Monday already placed those.
  const read = ctx(new Map([['DAVIS000204645', MON_MARCUS], ['DAVIS000204700', new Set()], ['DAVIS000204590', new Set()], ['DAVIS000204644', MON_DARVIN]]));
  assert.deepEqual(readsWanted(rows, { ...read, phase: 'past' }).map((l) => l.loadNbr), ['DAVIS000204484']);
  assert.deepEqual(readsWanted(rows, { ...read, phase: 'current' }), [], 'nothing read twice');
});

test('read order: a later load with room, then today\'s, then a later load whose frozen count looks full — which is still read', () => {
  const rosters = new Map([[FRI, [L('MARCUS', 'F', 'f', 5)]], [SAT, [L('MARCUS', 'S', 's', 2)]], [MON, [L('MARCUS', 'M', 'm', 1)]], [TUE, [L('MARCUS', 'T', 't', 9)]]]);
  const rows = [row('x', 'MARCUS'), row('m1', 'MARCUS', { own: MON })];
  const shown = shownCounts(rows, (r) => boardDayFor(r, SAT, null));
  const w = readsWanted(rows, { today: SAT, horizon: HORIZON, rosters, members: new Map(), shown, phase: 'current' }).map((l) => l.loadNbr);
  assert.deepEqual(w, ['T', 'S', 'M'], 'Tuesday has room (9 vs 0); Saturday disagrees (2 vs 1); Monday "looks full" (1 vs 1) and is read all the same');
});

test('membership matches raw OR normalised stop numbers, the way the read stores both', () => {
  assert.equal(holds(new Set(['7182304-1']), '007182304-1'), true);
  assert.equal(holds(new Set(['007182304-1']), '007182304-1'), true);
  assert.equal(holds(new Set(['7182304']), '007182304-1'), false);
  assert.equal(holds(null, '007182304-1'), false);
});

test('the own-day load follows the roster\'s own owner rule: a contested name speaks for nobody', () => {
  const r = new Map([[FRI, [L('ULINE APPT', 'A', 'a', 3), L('ULINE APPT', 'B', 'b', 4)]]]);
  assert.equal(ownDayLoad('ULINE APPT', FRI, r), null);
  assert.equal(ownDayLoad('ULINE APPT', '2026-09-24', r), null, 'a roster never captured says nothing');
  assert.equal(ownDayLoad('TERRANCE', FRI, ROSTERS()).loadNbr, 'DAVIS000204484');
});

test('boardDayFor honours a stamp only while the row still says what it was written for', () => {
  const planned = { ...row('9', 'MARCUS'), loadDay: MON, rosterLoadNbr: 'DAVIS000204645', rosterLoadRoute: 'MARCUS' };
  assert.equal(boardDayFor(planned, SAT, null), MON);
  const unplannedNow = { ...planned, isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null };
  assert.equal(boardDayFor(unplannedNow, SAT, null), FRI, 'a stale loadDay on an unplanned row moves nothing');
  const savedOntoJoe = { ...planned, loadNbr: 'JOE', routeName: 'JOE' };
  assert.equal(boardDayFor(savedOntoJoe, SAT, null), SAT, 'a Save onto JOE since the scan: MARCUS\'s load day moves nothing');
  const heldButPlanned = { ...row('10', 'TERRANCE'), heldOn: { loadNbr: 'X' } };
  assert.equal(boardDayFor(heldButPlanned, SAT, null), SAT, 'heldOn on a planned row is ignored (old clamp)');
  const finished = { ...planned, normalizedStatus: 'DELIVERED' };
  assert.equal(boardDayFor(finished, SAT, null), FRI, 'history is never re-filed');
});

test('NUVIZZ_ROUTE_LOAD_DAY=off: every stamp is ignored and filing is exactly the old rule', () => {
  const prev = process.env.NUVIZZ_ROUTE_LOAD_DAY;
  process.env.NUVIZZ_ROUTE_LOAD_DAY = 'off';
  try {
    assert.equal(boardDayFor({ ...row('9', 'MARCUS'), loadDay: MON, rosterLoadNbr: 'DAVIS000204645', rosterLoadRoute: 'MARCUS' }, SAT, null), SAT);
    const held = row('10', null); held.heldOn = { loadNbr: 'X' };
    assert.equal(boardDayFor(held, SAT, null), FRI);
  } finally {
    if (prev === undefined) delete process.env.NUVIZZ_ROUTE_LOAD_DAY; else process.env.NUVIZZ_ROUTE_LOAD_DAY = prev;
  }
});

test('a dispatcher-set board date still outranks everything, stamp included', () => {
  const r = { ...row('11', 'MARCUS'), loadDay: MON, rosterLoadNbr: 'DAVIS000204645', rosterLoadRoute: 'MARCUS' };
  assert.equal(boardDayFor(r, SAT, { '11': TUE }), TUE);
});

test('REVIEW #0/#8: a HELD order with a PAST dispatcher date is on today\'s board, not parked on the past day', () => {
  // Deferred "not until Thursday", rode Friday's TERRANCE, undelivered. The past date no longer
  // governs live work (A3-S18-1) — and a held order IS live work in NuVizz, un-planned row or not.
  const r = row('007000001', 'TERRANCE');
  stampResolution(r, { kind: 'held', load: { day: FRI, loadNbr: 'DAVIS000204484', loadId: 'x', name: 'TERRANCE', status: null, driver: null, trips: 9 }, sources: ['read'] });
  assert.equal(boardDayFor(r, SAT, { '007000001': '2026-09-24' }), SAT);
  assert.deepEqual([...bucketByDate([r], SAT, { '007000001': '2026-09-24' }).keys()], [SAT]);
  // A FUTURE date still governs it, held or not.
  assert.equal(boardDayFor(r, SAT, { '007000001': TUE }), TUE);
});

test('the filing split changes nothing: mergeTwoScan is exactly bucketByDate over dedupeTwoScan', () => {
  const active = [
    { stopNbr: 'A', statusCode: '20', routeName: 'L1', scheduledArrival: '6/24/26 09:00 AM' },
    { stopNbr: 'B', statusCode: '10', scheduledArrival: '6/25/26 09:00 AM' },
  ];
  const completed = [
    { stopNbr: 'A', statusCode: '90', routeName: 'L1', scheduledArrival: '6/24/26 09:00 AM', updatedTime: '6/24/26 02:00 PM' },
    { stopNbr: 'C', statusCode: '80', routeName: 'L1', scheduledArrival: '6/24/26 11:00 AM', updatedTime: '6/24/26 03:00 PM' },
  ];
  const viaMerge = mergeTwoScan(active, completed);
  const viaSplit = bucketByDate(dedupeTwoScan(active, completed));
  const shape = (m) => [...m.entries()].map(([d, rs]) => [d, rs.map((r) => `${r.stopNbr}:${r.normalizedStatus}`).sort()]).sort();
  assert.deepEqual(shape(viaSplit), shape(viaMerge));
  assert.equal(dedupeTwoScan(active, completed).length, 3, 'A is one row — completed replaced active');
});

test('stamps are LIVE: a previous scan\'s answer never rides onto a fresh row', () => {
  for (const k of ROUTE_LOAD_FIELDS) assert.ok(LIVE_LIST_FIELDS.includes(k), `${k} must be a LIVE_LIST_FIELD`);
  const fresh = row('007182304-1', 'MARCUS');           // this scan: not resolved (budget spent)
  const prior = { ...fresh, loadDay: MON, rosterLoadNbr: 'DAVIS000204645', rosterLoadId: 'id', rosterLoadVia: 'membership', heldOn: null, lat: 33.5 };
  mergeEnrich(fresh, prior);
  assert.equal(fresh.loadDay, undefined);
  assert.equal(fresh.rosterLoadNbr, undefined);
  assert.equal(fresh.lat, 33.5, 'static detail still merges');
});

test('the Map feed and the Routing pool carry the load number (every part of the app can read it)', () => {
  for (const k of ROUTE_LOAD_FIELDS) {
    assert.ok(LEAN_STOP_FIELDS.includes(k), `LEAN_STOP_FIELDS lacks ${k}`);
    assert.ok(POOL_LIVE_FIELDS.includes(k), `POOL_LIVE_FIELDS lacks ${k}`);
  }
});

test('a demoted row carries no load it no longer has', () => {
  const c = absentPlanDemoteCandidate({ ...row('1', 'MARCUS'), loadDay: MON, rosterLoadNbr: 'DAVIS000204645', rosterLoadId: 'x', rosterLoadVia: 'membership', rosterLoadRoute: 'MARCUS', heldOn: { loadNbr: 'Y' } });
  for (const k of ROUTE_LOAD_FIELDS) assert.equal(c[k], null, k);
});

test('the load anchor keeps an order filed on Monday\'s load even when its one-time enrichment named Friday\'s', () => {
  // POREX was first read while on Friday's MARCUS: raw.load.loadId is FRIDAY's. The anchor keys on
  // stopLoadId, and on Monday's board a prior-day order with a foreign id is dropped — which would
  // have taken POREX off the very board it was just filed on.
  const porex = { ...row('007182396', 'MARCUS'), raw: { load: { loadId: 'id-fri-marcus' } }, rosterLoadNbr: 'DAVIS000204645', rosterLoadId: 'id-mon-marcus', rosterLoadRoute: 'MARCUS', loadDay: MON };
  assert.equal(stopLoadId(porex), 'id-mon-marcus');
  assert.equal(stopLoadId({ ...porex, routeName: 'JOE', loadNbr: 'JOE' }), 'id-fri-marcus', 'saved onto JOE since: the stamp is not its load any more');
  const kept = dropForeignLoadStops([porex], new Set(['id-mon-marcus']), MON);
  assert.equal(kept.length, 1);
  // Without the stamp, the stale id would have dropped it.
  const bare = { ...porex, rosterLoadNbr: undefined, rosterLoadId: undefined };
  assert.equal(dropForeignLoadStops([bare], new Set(['id-mon-marcus']), MON).length, 0);
});

test('every other routed row is named from the roster of the day it is filed on — only when the roster agrees', () => {
  const mon = [row('a', 'MARCUS', { own: MON }), row('b', 'MARCUS', { own: MON })];
  const n = stampRosterNames(mon, (r) => r.boardDate, ROSTERS());
  assert.equal(n, 2);
  assert.equal(mon[0].rosterLoadNbr, 'DAVIS000204645');
  assert.equal(mon[0].rosterLoadVia, 'roster-name');
  assert.equal(mon[0].rosterLoadRoute, 'MARCUS');
  // More rows than the load counts → name-collision's case, not ours: nothing stamped.
  const tooMany = Array.from({ length: 15 }, (_, i) => row(`x${i}`, 'DARVIN', { own: MON }));
  assert.equal(stampRosterNames(tooMany, (r) => r.boardDate, ROSTERS()), 0);
  // A contested name: nothing stamped.
  const c = new Map([[MON, [L('ESTES', 'A', 'a', 5), L('ESTES', 'B', 'b', 5)]]]);
  assert.equal(stampRosterNames([row('e', 'ESTES', { own: MON })], (r) => r.boardDate, c), 0);
  // A day with no roster: nothing stamped.
  assert.equal(stampRosterNames([row('f', 'MARCUS', { own: '2026-10-05' })], (r) => r.boardDate, ROSTERS()), 0);
});

test('the memo answers for an order only while NuVizz has not touched that order since the read', () => {
  const e = memoOf(MON_MARCUS, { cover: '2026-09-26T20:00' });
  assert.equal(memoValidFor(e, row('007182304-1', 'MARCUS', { upd: '2026-09-26T19:59:00' }), MEMO_MAX_CURRENT_MS, NOW), true);
  assert.equal(memoValidFor(e, row('007182304-1', 'MARCUS', { upd: '2026-09-26T20:00:00' }), MEMO_MAX_CURRENT_MS, NOW), false, 'touched in the minute the read covers up to: read again');
  assert.equal(memoValidFor(e, row('007182304-1', 'MARCUS', { upd: '2026-09-26T21:10:00' }), MEMO_MAX_CURRENT_MS, NOW), false, 'moved after the read: read again');
  assert.equal(memoValidFor(e, row('007182304-1', 'MARCUS', { upd: null }), MEMO_MAX_CURRENT_MS, NOW), false, 'no stamp: the memo cannot vouch for it');
  assert.equal(memoValidFor({ ...e, cover: null }, row('1', 'MARCUS'), MEMO_MAX_CURRENT_MS, NOW), false, 'no cover: nothing');
  assert.equal(memoValidFor({ ...e, at: 'garbage' }, row('1', 'MARCUS'), MEMO_MAX_CURRENT_MS, NOW), false);
  assert.equal(memoValidFor({ ...e, at: new Date(NOW - MEMO_MAX_CURRENT_MS).toISOString() }, row('1', 'MARCUS'), MEMO_MAX_CURRENT_MS, NOW), false, 'past its max age');
  // THE STOP COUNT IS NOT A TEST ANY MORE: a future day's roster is the morning's, a past day's never changes.
  assert.equal(memoValidFor({ ...e, trips: 3 }, row('1', 'MARCUS'), MEMO_MAX_CURRENT_MS, NOW), true);
});

test('what a read covers: the pull\'s newest stamp, or our clock five minutes back in ET — never a stamp from the future', () => {
  assert.equal(listStamp('2026-09-25T17:56:00'), '2026-09-25T17:56');
  assert.equal(listStamp('2026-09-25 17:56'), '2026-09-25T17:56');
  assert.equal(listStamp('9/25/26'), null);
  assert.equal(pullStamp([{ listUpdatedDTTM: '2026-09-26T16:51:00' }, { listUpdatedDTTM: '2026-09-25T17:56:00' }, {}]), '2026-09-26T16:51');
  // NOW is 2026-09-27T00:30:54Z = Saturday 20:30 EDT.
  assert.equal(etMinuteOf(NOW), '2026-09-26T20:30');
  assert.equal(etMinuteOf(Date.parse('2026-12-01T17:00:00Z')), '2026-12-01T12:00', 'EST in winter');
  assert.equal(coverStamp(null, NOW), '2026-09-26T20:25', 'five minutes of settle');
  assert.equal(coverStamp('2026-09-26T20:29', NOW), '2026-09-26T20:29', 'the pull saw a change at 20:29: everything before it is in');
  assert.equal(coverStamp('2026-09-26T19:00', NOW), '2026-09-26T20:25');
  assert.equal(coverStamp('2031-01-01T00:00', NOW), '2026-09-26T20:25', 'a mis-set record from the future is not trusted');
  assert.equal(READ_SETTLE_MS, 5 * 60 * 1000);
});

// ── The whole pass, end to end, with the reads faked ────────────────────────────────────────
const saturdayPull = () => [
  row('007182304-1', 'MARCUS', { seq: 3 }),
  row('007182396', 'MARCUS', { seq: 7 }),
  row('007182149', 'DARVIN', { seq: 8 }),
  row('007182123', 'TERRANCE', { seq: 1 }),
  row('007182472', 'MARCUS', { own: MON, seq: 1 }),
  row('007182999', null, { own: SAT }),
];
const reader = (calls) => async (loadNbr) => {
  calls.push(loadNbr);
  return ({ DAVIS000204645: MON_MARCUS, DAVIS000204644: MON_DARVIN, DAVIS000204484: FRI_TERRANCE, DAVIS000204535: FRI_MARCUS, DAVIS000204700: new Set(), DAVIS000204590: new Set(), DAVIS000204532: new Set(['1']) })[loadNbr] ?? null;
};

test('Saturday 9/26 replayed: MARCUS\'s two and DARVIN\'s one file on Monday; TERRANCE\'s leftover shows unplanned', async () => {
  const rows = saturdayPull();
  const calls = [];
  const rosters = ROSTERS();
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: reader(calls),
    memo: {}, readMax: 10, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  const by = Object.fromEntries(rows.map((r) => [r.stopNbr, r]));
  assert.equal(by['007182304-1'].loadDay, MON);
  assert.equal(by['007182396'].loadDay, MON);
  assert.equal(by['007182149'].loadDay, MON);
  assert.equal(by['007182149'].rosterLoadNbr, 'DAVIS000204644');
  assert.equal(by['007182123'].isUnplanned, true);
  assert.equal(by['007182123'].heldOn.loadNbr, 'DAVIS000204484');
  // The Monday row that was already right is now NAMED too — free, from Monday's roster.
  assert.equal(by['007182472'].rosterLoadNbr, 'DAVIS000204645');
  assert.equal(by['007182472'].rosterLoadVia, 'roster-name');
  assert.equal(by['007182999'].rosterLoadNbr, undefined, 'an unrouted order is named by nobody');
  // Filed: Monday's MARCUS card now holds its three orders, Saturday holds only the leftover + the unrouted one.
  const buckets = bucketByDate(rows, SAT, null);
  assert.deepEqual((buckets.get(MON) || []).map((r) => r.stopNbr).sort(), ['007182149', '007182304-1', '007182396', '007182472']);
  assert.deepEqual((buckets.get(SAT) || []).map((r) => r.stopNbr).sort(), ['007182123', '007182999']);
  assert.equal(out.summary.load, 3);
  assert.equal(out.summary.held, 1);
  assert.equal(out.summary.unresolved, 0);
  // THE COST, pinned: four reads. Monday's MARCUS and DARVIN (their counts disagree with the board);
  // Monday's TERRANCE — its 0 is the morning's capture, frozen, and "held" is the direction that
  // costs a second truck, so it needs every load from today on to answer; then Friday's TERRANCE
  // for the leftover. Not Tuesday's MARCUS — Monday's already placed both MARCUS orders, and the
  // reads are re-planned after each one — and not Friday's MARCUS or DARVIN, for the same reason.
  assert.deepEqual(calls, ['DAVIS000204645', 'DAVIS000204644', 'DAVIS000204590', 'DAVIS000204484']);
  assert.deepEqual([out.summary.phase1Reads, out.summary.phase2Reads], [3, 1]);
  // Every read that came back usable is handed back to be MERGED into the memo; the memo passed in
  // is never written to.
  assert.deepEqual(Object.keys(out.memoUpdates).sort(), calls.slice().sort());
  assert.equal(out.memoUpdates.DAVIS000204645.cover, '2026-09-26T20:25');
  // …and exactly those reads are what the scan may share with name-collision and the verify.
  assert.deepEqual([...out.readThisRun.keys()].sort(), calls.slice().sort());
});

test('the read budget is a hard cap, and an order the budget did not reach keeps its old filing', async () => {
  const rows = saturdayPull();
  const calls = [];
  const rosters = ROSTERS();
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: reader(calls),
    memo: {}, readMax: 1, nowMs: NOW,
  });
  assert.equal(calls.length, 1);
  assert.equal(out.summary.reads, 1);
  assert.ok(out.summary.unresolved >= 1);
  for (const r of rows.filter((x) => x.loadDay === undefined && x.heldOn === undefined && x.boardDate === FRI)) {
    assert.equal(boardDayFor(r, SAT, null), SAT, `${r.stopNbr} keeps the old filing`);
  }
});

test('the memo answers the next scan for nothing, and a spent budget keeps the answer rather than flipping', async () => {
  const memo = {};
  const rosters = ROSTERS();
  const deps = (calls, readMax, nowMs) => ({ today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: reader(calls), memo, readMax, nowMs });
  const first = []; const out1 = await applyRouteLoadDay(saturdayPull(), deps(first, 10, NOW));
  assert.deepEqual(memo, {}, 'the memo passed in is not written to');
  Object.assign(memo, out1.memoUpdates);   // what the scan's merge-write does
  const second = []; const out2 = await applyRouteLoadDay(saturdayPull(), deps(second, 10, NOW + 60_000));
  assert.equal(second.length, 0, 'every load answered from the memo');
  assert.equal(out2.summary.load, 3);
  assert.equal(out2.summary.held, 1);
  assert.equal(out2.readThisRun.size, 0, 'nothing READ this run — nothing to share as a read');
  // Seven hours on: past the refresh age, inside the max age, budget zero — the stored reads still
  // answer for orders NuVizz has not touched, so nothing flips.
  const third = []; const out3 = await applyRouteLoadDay(saturdayPull(), deps(third, 0, NOW + 7 * 60 * 60 * 1000));
  assert.equal(third.length, 0);
  assert.equal(out3.summary.load, 3);
  assert.equal(out3.summary.held, 1);
  assert.ok(out3.summary.staleMemo > 0);
  // …and past the max age they answer for nothing: the old filing, never a guess.
  const fourth = []; const out4 = await applyRouteLoadDay(saturdayPull(), deps(fourth, 0, NOW + MEMO_MAX_PAST_MS + 60_000));
  assert.equal(out4.summary.load + out4.summary.held, 0);
});

test('REVIEW #1/#16 (the blocker): an order MOVED after the read is never answered by it — planned freight is not shown unplanned', async () => {
  // Tuesday: L1 (Monday leftover) was read on Monday's MARCUS at 09:00. At 13:00 the dispatcher
  // moves it onto Wednesday's MARCUS, whose roster (captured once, at dawn) counts 3 while the board
  // shows 5. Before: Monday's memo still "held" it, Wednesday's "full" count ruled its load out
  // unread, and L1 came back UNPLANNED in Tuesday's pool while it sat on Wednesday's truck.
  const TUE_ = '2026-09-29', WED = '2026-09-30', THU = '2026-10-01';
  const rosters = new Map([
    ['2026-09-28', [L('MARCUS', 'MON_M', 'm', 10)]],
    [TUE_, [L('MARCUS', 'TUE_M', 't', 8)]],
    [WED, [L('MARCUS', 'WED_M', 'w', 3)]],
    [THU, [L('OTHER', 'THU_O', 'o', 1)]],
  ]);
  const now = Date.parse('2026-09-29T18:00:00Z');   // 14:00 EDT
  const board = [
    ...Array.from({ length: 8 }, (_, i) => row(`t${i}`, 'MARCUS', { own: TUE_ })),
    ...Array.from({ length: 5 }, (_, i) => row(`w${i}`, 'MARCUS', { own: WED })),
    row('L1', 'MARCUS', { own: '2026-09-28', upd: '2026-09-29T13:00:00' }),
  ];
  const memo = { MON_M: memoOf(new Set(['L1', 'x']), { atMs: Date.parse('2026-09-29T13:00:00Z'), trips: 10, cover: '2026-09-29T08:55' }) };
  const truth = { TUE_M: new Set(board.slice(0, 8).map((r) => r.stopNbr)), WED_M: new Set(['w0', 'w1', 'w2', 'w3', 'w4', 'L1']), MON_M: new Set(['x']) };
  const calls = [];
  const out = await applyRouteLoadDay(board, {
    today: TUE_, horizon: [TUE_, WED, THU], readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => { calls.push(n); return truth[n] ?? null; }, memo, readMax: 4, nowMs: now,
    dayOf: (r) => boardDayFor(r, TUE_, null),
  });
  const l1 = board.find((r) => r.stopNbr === 'L1');
  assert.equal(out.summary.held, 0, 'never "held" on the word of a read taken before the move');
  assert.equal(l1.isPlanned, true);
  assert.equal(l1.loadDay, WED, 'Wednesday\'s load was READ despite its frozen "full" count — and holds it');
  assert.equal(l1.rosterLoadNbr, 'WED_M');
  assert.ok(calls.includes('WED_M'));
  // With no reads to spend, the same order is simply left as filed — still not "held".
  const board2 = board.map((r) => ({ ...r, loadDay: undefined, rosterLoadNbr: undefined, rosterLoadId: undefined, rosterLoadVia: undefined, rosterLoadRoute: undefined, heldOn: undefined, isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS', routeName: 'MARCUS' }));
  const out2 = await applyRouteLoadDay(board2, { today: TUE_, horizon: [TUE_, WED, THU], readRoster: async (d) => rosters.get(d) ?? null, readMembers: async () => null, memo, readMax: 0, nowMs: now });
  assert.equal(out2.summary.held, 0);
  assert.equal(out2.summary.unresolved, 1);
});

test('REVIEW #6: a swap on today\'s load (count unchanged) is seen — the swapped-in order is read again, not "held" from the memo', async () => {
  // 07:00 reads: today's MARCUS A,B,C (3), Friday's MARCUS K,X. 08:00 the dispatcher swaps C off and
  // K on: the count stays 3. K's "Stop Updated" moves to 08:00, after both reads' cover.
  const SUN = '2026-09-27', MON_ = '2026-09-28';
  const rosters = new Map([[FRI, [L('MARCUS', 'F1', 'f', 13)]], [MON_, [L('MARCUS', 'T1', 't', 3)]], [TUE, []], ['2026-09-30', []]]);
  const memo = {
    F1: memoOf(new Set(['K', 'X']), { atMs: Date.parse('2026-09-28T11:00:00Z'), cover: '2026-09-28T06:55' }),
    T1: memoOf(new Set(['A', 'B', 'C']), { atMs: Date.parse('2026-09-28T11:00:00Z'), cover: '2026-09-28T06:55' }),
  };
  const rows = [row('A', 'MARCUS', { own: MON_ }), row('B', 'MARCUS', { own: MON_ }), row('K', 'MARCUS', { upd: '2026-09-28T08:00:00' }), row('X', 'MARCUS')];
  void SUN;
  const out = await applyRouteLoadDay(rows, {
    today: MON_, horizon: [MON_, TUE, '2026-09-30'], readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async () => null, memo, readMax: 0, nowMs: Date.parse('2026-09-28T12:15:00Z'), dayOf: (r) => boardDayFor(r, MON_, null),
  });
  const k = rows.find((r) => r.stopNbr === 'K');
  const x = rows.find((r) => r.stopNbr === 'X');
  assert.equal(k.isPlanned, true, 'K is not shown unplanned on a read that predates its move');
  assert.equal(k.heldOn, undefined);
  assert.equal(x.isUnplanned, true, 'X, untouched since the reads, is still answered by them');
  assert.equal(x.heldOn.loadNbr, 'F1');
  assert.equal(out.summary.held, 1);
});

test('REVIEW #2: a carried order the resolver could not place is never named from the day it was merely filed on', async () => {
  const rosters = new Map([[FRI, [L('MARCUS', 'DAVIS000204535', 'fri', 12)]], [SAT, [L('MARCUS', 'DAVIS000204536', 'sat', 5)]], [MON, [L('MARCUS', 'DAVIS000204645', 'mon', 12)]], [TUE, []]]);
  const rows = [row('A', 'MARCUS', { own: SAT }), row('B', 'MARCUS', { own: SAT }), row('C', 'MARCUS', { own: SAT }), row('WHITING', 'MARCUS')];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: async () => null,
    memo: {}, readMax: 0, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  const w = rows.find((r) => r.stopNbr === 'WHITING');
  assert.equal(out.summary.unresolved, 1);
  assert.equal(w.rosterLoadNbr, undefined, 'no Saturday load number on an order that may be on Monday\'s');
  assert.equal(rows[0].rosterLoadNbr, 'DAVIS000204536', 'Saturday\'s own orders are still named');
  assert.equal(out.summary.rosterNamed, 3);
});

test('REVIEW #3: no past-load read is spent while a load from today on failed to read — it could not change the answer', async () => {
  const rosters = new Map([[FRI, [L('TERRANCE', 'DAVIS1', 'f', 5)]], [SAT, [L('TERRANCE', 'DAVIS3', 's', 4)]], [MON, [L('TERRANCE', 'DAVIS2', 'm', 9)]], [TUE, []]]);
  const rows = [row('S1', 'TERRANCE', { own: SAT }), row('X', 'TERRANCE')];
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => { calls.push(n); return n === 'DAVIS3' ? null : new Set(['other']); },
    memo: {}, readMax: 10, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  assert.ok(!calls.includes('DAVIS1'), `Friday's load not read: ${calls.join(',')}`);
  assert.equal(out.summary.unresolved, 1);
  assert.equal(out.summary.unusableReads, 1);
});

test('REVIEW #11: a read that FAILS falls back to a stored read that still answers for the order, not to the old filing', async () => {
  const rows = [row('007182304-1', 'MARCUS')];
  const rosters = ROSTERS();
  const memo = { DAVIS000204645: memoOf(MON_MARCUS, { atMs: NOW - 7 * 60 * 60 * 1000 }) };   // past refresh age → re-read wanted
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => { calls.push(n); return null; }, memo, readMax: 4, nowMs: NOW,
  });
  assert.ok(calls.includes('DAVIS000204645'), 'the stale read was due a refresh, and the refresh was tried');
  assert.equal(rows[0].loadDay, MON, 'the refresh failed; the stored read still answers');
  assert.equal(out.summary.staleMemo, 1);
});

test('REVIEW #12: an unreadable memo moves nothing and spends nothing — it is never an empty memo', async () => {
  const rows = saturdayPull();
  const rosters = ROSTERS();
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: reader(calls),
    memo: null, readMax: 10, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  assert.equal(calls.length, 0);
  assert.equal(out.summary.memoUnreadable, true);
  assert.equal(out.summary.load + out.summary.held, 0);
  assert.equal(out.memoDirty, false);
  assert.equal(rows.find((r) => r.stopNbr === '007182304-1').rosterLoadNbr, undefined, 'and a carried order is not named by its filed day either');
});

test('REVIEW #14: a morning of planning cannot starve the past-load read — one is kept back for it', async () => {
  // TERRANCE's leftover: Monday's TERRANCE already answers (a stored read), Friday's has never been
  // read. Three other names each want a Monday read. With 2 reads: phase 1 gets one, phase 2 the other.
  const rosters = ROSTERS();
  rosters.set(MON, [...rosters.get(MON), L('JOE', 'J', 'j', 9), L('RAY', 'R', 'r', 9)]);
  const memo = { DAVIS000204590: memoOf(new Set(), { trips: 0 }), DAVIS000204700: memoOf(new Set(), { trips: 0 }) };
  const rows = [row('007182123', 'TERRANCE'), row('j1', 'JOE'), row('r1', 'RAY'), row('m1', 'MARCUS')];
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => { calls.push(n); return n === 'DAVIS000204484' ? FRI_TERRANCE : new Set(['zzz']); },
    memo, readMax: 2, nowMs: NOW,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'DAVIS000204484', 'the second read went to the past load');
  assert.equal(out.summary.held, 1);
  assert.deepEqual([out.summary.phase1Reads, out.summary.phase2Reads], [1, 1]);
});

test('membershipFor: this run\'s read first; else a stored read that answers for THIS row; else unknown', () => {
  const l = { day: MON, loadNbr: 'DAVIS000204645', loadId: null, name: 'MARCUS', status: null, driver: null, trips: 13 };
  const touched = row('007182304-1', 'MARCUS', { upd: '2026-09-26T21:00:00' });
  const quiet = row('007182304-1', 'MARCUS');
  const memo = { DAVIS000204645: memoOf(MON_MARCUS) };
  assert.equal(membershipFor(l, quiet, ctx(new Map(), { memo, nowMs: NOW })).source, 'memo');
  assert.equal(membershipFor(l, touched, ctx(new Map(), { memo, nowMs: NOW })), null);
  assert.equal(membershipFor(l, touched, ctx(new Map([['DAVIS000204645', MON_MARCUS]]), { memo, nowMs: NOW })).source, 'read');
  assert.equal(membershipFor(l, quiet, ctx(new Map([['DAVIS000204645', null]]), { memo, nowMs: NOW })).source, 'memo', 'a failed read falls back');
  assert.equal(membershipFor(l, quiet, ctx(new Map(), { memo: { ['__proto__']: memoOf(MON_MARCUS) }, nowMs: NOW })), null);
});

test('the shared readers honour a stamp only while the row still says what it said', () => {
  const r = row('007182304-1', 'MARCUS');
  stampResolution(r, { kind: 'load', day: MON, load: { day: MON, loadNbr: 'DAVIS000204645', loadId: 'id-mon-marcus', name: 'MARCUS', status: null, driver: null, trips: 13 }, sources: ['read'] });
  assert.deepEqual(stampedLoadOf(r), { loadNbr: 'DAVIS000204645', loadId: 'id-mon-marcus', day: MON, via: 'membership', route: 'MARCUS' });
  assert.equal(stampedLoadOf({ ...r, routeName: 'JOE', loadNbr: 'JOE' }), null, 'saved onto JOE');
  assert.equal(stampedLoadOf({ ...r, isPlanned: false, isUnplanned: true, routeName: null, loadNbr: null }), null, 'un-planned by a Save');
  const h = row('007182123', 'TERRANCE');
  stampResolution(h, { kind: 'held', load: { day: FRI, loadNbr: 'DAVIS000204484', loadId: 'x', name: 'TERRANCE', status: null, driver: null, trips: 9 }, sources: ['read'] });
  assert.equal(heldLoadOf(h).loadNbr, 'DAVIS000204484');
  assert.equal(h.rosterLoadRoute, null);
  assert.equal(heldLoadOf({ ...h, isPlanned: true, isUnplanned: false, routeName: 'JOE' }), null, 'planned since: not "still on" anything');
});

test('a read that throws is a failed read, never a crash', async () => {
  const rows = saturdayPull();
  const rosters = ROSTERS();
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async () => { throw new Error('502'); }, memo: {}, readMax: 10, nowMs: NOW,
  });
  assert.equal(out.summary.load, 0);
  assert.equal(out.summary.held, 0);
  assert.equal(out.summary.unresolved, 4);
});

test('a roster read that throws is a missing roster: nothing is claimed', async () => {
  const rows = saturdayPull();
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async () => { throw new Error('firestore'); },
    readMembers: reader([]), memo: {}, readMax: 10, nowMs: NOW,
  });
  assert.equal(out.summary.load + out.summary.held, 0);
});

test('the free trigger (CLAUDE.md): today\'s count against the board; a later day\'s count orders the reads', () => {
  const rows = [row('a', 'MARCUS', { own: MON }), row('b', 'MARCUS', { own: MON }), row('c', 'MARCUS', { own: FRI }), row('d', null, { own: MON })];
  const shown = shownCounts(rows, (r) => boardDayFor(r, SAT, null));
  assert.equal(shown.get(`${MON}\u0000marcus`), 2, 'two MARCUS orders filed on Monday');
  assert.equal(shown.get(`${SAT}\u0000marcus`), 1, 'the Friday-dated one is filed on Saturday by the old rule');
  const mon = { day: MON, name: 'MARCUS', loadNbr: 'M', loadId: null, status: null, driver: null, trips: 13 };
  assert.equal(hasRoom(mon, shown), true, '13 counted, 2 shown: Monday\'s MARCUS holds orders the board does not show');
  assert.equal(hasRoom({ ...mon, trips: 2 }, shown), false, 'the board already shows all of them');
  assert.equal(hasRoom({ ...mon, trips: null }, shown), true, 'an unknown count cannot rule a load out');
  const sat = { ...mon, day: SAT, trips: 1 };
  assert.equal(countAgrees(sat, shown), true);
  assert.equal(countAgrees({ ...sat, trips: 2 }, shown), false);
});

test('no read of TODAY\'s load when no past load could be holding the order — the answer could only be "where it already is"', async () => {
  // ANNANDALE VILLAGE's shape (name-collision e2e): dated five days back, no roster for that day.
  const rows = [row('007174083-1', 'BUFORD', { own: '2026-09-21' }), ...Array.from({ length: 7 }, (_, i) => row(`b${i}`, 'BUFORD', { own: SAT }))];
  const rosters = new Map([[SAT, [L('BUFORD', 'DAVIS000203661', 'id', 7)]], [MON, []], [TUE, []]]);
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => { calls.push(n); return new Set(); }, memo: {}, readMax: 10, nowMs: NOW,
    dayOf: (r) => boardDayFor(r, SAT, null),
  });
  assert.equal(calls.length, 0);
  assert.equal(out.summary.unresolved, 1);
});

test('a later load whose frozen count "looks full" is READ before anything is called held (REVIEW #7/#17)', async () => {
  const rows = [row('007182123', 'TERRANCE'), row('m1', 'TERRANCE', { own: MON })];
  const rosters = ROSTERS();
  rosters.set(MON, [L('TERRANCE', 'DAVIS000204590', 'mon-t', 1)]);   // the morning count: exactly the one order Monday shows
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => { calls.push(n); return n === 'DAVIS000204590' ? new Set(['m1']) : n === 'DAVIS000204484' ? FRI_TERRANCE : null; },
    memo: {}, readMax: 10, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  assert.deepEqual(calls, ['DAVIS000204590', 'DAVIS000204484']);
  assert.equal(out.summary.held, 1);
  // And when that later load CANNOT be read this run, its "full" morning count is no answer: with
  // Friday's load known from the memo, the order is left as filed — never shown unplanned.
  const rows2 = [row('007182123', 'TERRANCE'), row('m1', 'TERRANCE', { own: MON })];
  const out2 = await applyRouteLoadDay(rows2, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: async () => null,
    memo: { DAVIS000204484: memoOf(FRI_TERRANCE, { trips: 9 }) }, readMax: 0, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  assert.equal(out2.summary.held, 0);
  assert.equal(rows2[0].isPlanned, true);
  assert.match(out2.summary.unresolvedSample[0], /DAVIS000204590/, 'and the run says which load it is waiting on');
});

test('REVIEW #17: planned onto Monday\'s MARCUS AFTER the morning roster capture — still filed on Monday', async () => {
  // Sunday evening: Monday's MARCUS was captured at 15 stops at dawn; the board already shows 17;
  // WHITING and POREX (dated Friday) were planned onto it since.
  const SUN = '2026-09-27';
  const rosters = new Map([[FRI, [L('MARCUS', 'FRI_M', 'f', 12)]], [SUN, []], [MON, [L('MARCUS', 'MON_M', 'm', 15)]], [TUE, []]]);
  const monRows = Array.from({ length: 17 }, (_, i) => row(`m${i}`, 'MARCUS', { own: MON }));
  const rows = [...monRows, row('WHITING', 'MARCUS'), row('POREX', 'MARCUS')];
  const truth = new Set([...monRows.map((r) => r.stopNbr), 'WHITING', 'POREX']);
  const out = await applyRouteLoadDay(rows, {
    today: SUN, horizon: [SUN, MON, TUE], readRoster: async (d) => rosters.get(d) ?? null,
    readMembers: async (n) => (n === 'MON_M' ? truth : new Set()), memo: {}, readMax: 4, nowMs: NOW,
    dayOf: (r) => boardDayFor(r, SUN, null),
  });
  assert.equal(out.summary.load, 2);
  assert.equal(rows.find((r) => r.stopNbr === 'WHITING').loadDay, MON);
  assert.equal(out.summary.reads, 1, 'one read placed both');
});
