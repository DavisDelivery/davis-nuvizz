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
  readsWanted, resolveRow, stampResolution, stampRosterNames, memoFresh, memoSameCount, applyRouteLoadDay,
  ROUTE_LOAD_FIELDS, MEMO_TTL_CURRENT_MS, MEMO_TTL_PAST_MS,
} from '../netlify/functions/lib/route-load-day.mts';
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

const row = (nbr, route, { own = FRI, status = '20', norm = 'SCHEDULED', seq = null, extra = {} } = {}) => ({
  stopNbr: nbr, routeName: route, loadNbr: route, routeSeq: seq, driverName: route ? `${route} DRIVER` : null,
  boardDate: own, scheduledDate: own, status, normalizedStatus: norm, isPlanned: !!route, isUnplanned: !route, ...extra,
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

const ctx = (members) => ({ today: SAT, horizon: HORIZON, rosters: ROSTERS(), members });

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

test('reads are asked for loads from today on FIRST, then the past loads, each once', () => {
  const rows = [row('007182304-1', 'MARCUS'), row('007182396', 'MARCUS'), row('007182123', 'TERRANCE'), row('007182149', 'DARVIN')];
  const w = readsWanted(rows, { today: SAT, horizon: HORIZON, rosters: ROSTERS() }).map((l) => l.loadNbr);
  assert.deepEqual(w, ['DAVIS000204645', 'DAVIS000204700', 'DAVIS000204590', 'DAVIS000204644', 'DAVIS000204535', 'DAVIS000204484', 'DAVIS000204532']);
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
  const planned = { ...row('9', 'MARCUS'), loadDay: MON };
  assert.equal(boardDayFor(planned, SAT, null), MON);
  const unplannedNow = { ...planned, isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null };
  assert.equal(boardDayFor(unplannedNow, SAT, null), FRI, 'a stale loadDay on an unplanned row moves nothing');
  const heldButPlanned = { ...row('10', 'TERRANCE'), heldOn: { loadNbr: 'X' } };
  assert.equal(boardDayFor(heldButPlanned, SAT, null), SAT, 'heldOn on a planned row is ignored (old clamp)');
  const finished = { ...planned, normalizedStatus: 'DELIVERED' };
  assert.equal(boardDayFor(finished, SAT, null), FRI, 'history is never re-filed');
});

test('NUVIZZ_ROUTE_LOAD_DAY=off: every stamp is ignored and filing is exactly the old rule', () => {
  const prev = process.env.NUVIZZ_ROUTE_LOAD_DAY;
  process.env.NUVIZZ_ROUTE_LOAD_DAY = 'off';
  try {
    assert.equal(boardDayFor({ ...row('9', 'MARCUS'), loadDay: MON }, SAT, null), SAT);
    const held = row('10', null); held.heldOn = { loadNbr: 'X' };
    assert.equal(boardDayFor(held, SAT, null), FRI);
  } finally {
    if (prev === undefined) delete process.env.NUVIZZ_ROUTE_LOAD_DAY; else process.env.NUVIZZ_ROUTE_LOAD_DAY = prev;
  }
});

test('a dispatcher-set board date still outranks everything, stamp included', () => {
  const r = { ...row('11', 'MARCUS'), loadDay: MON };
  assert.equal(boardDayFor(r, SAT, { '11': TUE }), TUE);
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
  const c = absentPlanDemoteCandidate({ ...row('1', 'MARCUS'), loadDay: MON, rosterLoadNbr: 'DAVIS000204645', rosterLoadId: 'x', rosterLoadVia: 'membership', heldOn: { loadNbr: 'Y' } });
  for (const k of ROUTE_LOAD_FIELDS) assert.equal(c[k], null, k);
});

test('the load anchor keeps an order filed on Monday\'s load even when its one-time enrichment named Friday\'s', () => {
  // POREX was first read while on Friday's MARCUS: raw.load.loadId is FRIDAY's. The anchor keys on
  // stopLoadId, and on Monday's board a prior-day order with a foreign id is dropped — which would
  // have taken POREX off the very board it was just filed on.
  const porex = { ...row('007182396', 'MARCUS'), raw: { load: { loadId: 'id-fri-marcus' } }, rosterLoadId: 'id-mon-marcus', loadDay: MON };
  assert.equal(stopLoadId(porex), 'id-mon-marcus');
  const kept = dropForeignLoadStops([porex], new Set(['id-mon-marcus']), MON);
  assert.equal(kept.length, 1);
  // Without the stamp, the stale id would have dropped it.
  const bare = { ...porex, rosterLoadId: undefined };
  assert.equal(dropForeignLoadStops([bare], new Set(['id-mon-marcus']), MON).length, 0);
});

test('every other routed row is named from the roster of the day it is filed on — only when the roster agrees', () => {
  const mon = [row('a', 'MARCUS', { own: MON }), row('b', 'MARCUS', { own: MON })];
  const n = stampRosterNames(mon, (r) => r.boardDate, ROSTERS());
  assert.equal(n, 2);
  assert.equal(mon[0].rosterLoadNbr, 'DAVIS000204645');
  assert.equal(mon[0].rosterLoadVia, 'roster-name');
  // More rows than the load counts → name-collision's case, not ours: nothing stamped.
  const tooMany = Array.from({ length: 15 }, (_, i) => row(`x${i}`, 'DARVIN', { own: MON }));
  assert.equal(stampRosterNames(tooMany, (r) => r.boardDate, ROSTERS()), 0);
  // A contested name: nothing stamped.
  const c = new Map([[MON, [L('ESTES', 'A', 'a', 5), L('ESTES', 'B', 'b', 5)]]]);
  assert.equal(stampRosterNames([row('e', 'ESTES', { own: MON })], (r) => r.boardDate, c), 0);
  // A day with no roster: nothing stamped.
  assert.equal(stampRosterNames([row('f', 'MARCUS', { own: '2026-10-05' })], (r) => r.boardDate, ROSTERS()), 0);
});

test('memo: a stored read stands in only for the same stop count and inside its TTL; past loads keep longer', () => {
  const e = { at: new Date(NOW - 60_000).toISOString(), trips: 13, members: ['1'] };
  assert.equal(memoFresh(e, 13, false, NOW), true);
  assert.equal(memoFresh(e, 14, false, NOW), false, 'the load changed');
  const old = { ...e, at: new Date(NOW - MEMO_TTL_CURRENT_MS - 1).toISOString() };
  assert.equal(memoFresh(old, 13, false, NOW), false);
  assert.equal(memoFresh(old, 13, true, NOW), true);
  assert.equal(memoFresh({ ...e, at: new Date(NOW - MEMO_TTL_PAST_MS - 1).toISOString() }, 13, true, NOW), false);
  assert.equal(memoSameCount(old, 13), true);
  assert.equal(memoSameCount(old, 12), false);
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
  // THE COST, pinned: three reads, each one a load whose count disagreed with the board — Monday's
  // MARCUS (13 vs 1 shown here) and DARVIN, then Friday's TERRANCE for the leftover only. Not
  // Tuesday's MARCUS or Monday's TERRANCE (0 stops: nothing to hold), not Friday's MARCUS or DARVIN
  // (Monday's loads already placed those orders — a past read would buy nothing).
  assert.deepEqual(calls.slice().sort(), ['DAVIS000204484', 'DAVIS000204644', 'DAVIS000204645']);
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

test('the memo answers the next scan for nothing, and a spent budget falls back to a same-count read rather than flipping', async () => {
  const memo = {};
  const rosters = ROSTERS();
  const deps = (calls, readMax, nowMs) => ({ today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: reader(calls), memo, readMax, nowMs });
  const first = []; await applyRouteLoadDay(saturdayPull(), deps(first, 10, NOW));
  const second = []; const out2 = await applyRouteLoadDay(saturdayPull(), deps(second, 10, NOW + 60_000));
  assert.equal(second.length, 0, 'every load answered from the memo');
  assert.equal(out2.summary.load, 3);
  // Seven hours on: the current loads' memo has aged out, the budget is zero — same-count stale reads hold the answer.
  const third = []; const rows3 = saturdayPull();
  const out3 = await applyRouteLoadDay(rows3, deps(third, 0, NOW + 7 * 60 * 60 * 1000));
  assert.equal(third.length, 0);
  assert.equal(out3.summary.load, 3);
  assert.ok(out3.summary.staleMemo > 0);
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

test('the free trigger (CLAUDE.md): a load is read only when its roster count disagrees with the board', () => {
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

test('a later load whose count the board already fills is ruled out without a read, and "held" still needs its past load to say so', async () => {
  const rows = [row('007182123', 'TERRANCE'), row('m1', 'TERRANCE', { own: MON })];
  const rosters = ROSTERS();
  rosters.set(MON, [L('TERRANCE', 'DAVIS000204590', 'mon-t', 1)]);   // Monday's TERRANCE holds exactly the one order Monday shows
  const calls = [];
  const out = await applyRouteLoadDay(rows, {
    today: SAT, horizon: HORIZON, readRoster: async (d) => rosters.get(d) ?? null, readMembers: reader(calls),
    memo: {}, readMax: 10, nowMs: NOW, dayOf: (r) => boardDayFor(r, SAT, null),
  });
  assert.deepEqual(calls, ['DAVIS000204484'], 'only Friday\'s load was read');
  assert.equal(out.summary.held, 1);
});
