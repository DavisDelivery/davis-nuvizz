// test/list-load-number.test.mjs
//
// THE STOP LIST CARRIES THE LOAD NUMBER NOW. Chad, 2026-09-28: "Yes the load number is now on
// every scan so set it up whatever needs it to use it." He added a Load Number column to the stop
// saved search (77128). Before that, a stop row named its load by route NAME only — and Friday's
// MARCUS (DAVIS000204535) and Monday's MARCUS (DAVIS000204645) read the same, which is how WHITING
// TURNER 007182304-1 and POREX landed on the wrong card.
//
// What these pin: the column is found whatever key NuVizz gives it, the number rides every routed
// order as `nuvizzLoadNbr` beside the route name (which stays in `loadNbr`, as the whole app reads
// it), it stays with the route it was read with through every path that copies a plan, and the
// scan records what it found for free.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listLoadNbrColumn, listLoadNbrSeen, normalize, toBoardStop, mergeEnrich, applyBoardWriteGrace,
  applyDemotionVerify, absentPlanDemoteCandidate, PLAN_FIELDS, LIVE_LIST_FIELDS,
} from '../netlify/functions/lib/nuvizz-list.mts';
import { healFields } from '../netlify/functions/lib/refile-core.mts';
import { projectPoolRow } from '../netlify/functions/lib/active-pool.mts';
import { describe as describeRow } from '../netlify/functions/lib/stop-explain.mts';

// The 25 columns saved search 77128 returned on 2026-09-27 (stored from that call) — no load number.
const COLS_0927 = [
  'KeyColumn', 'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.createdTime',
  'vizzonInfo.shipmentInfo.shipmentNbr', 'route.driver.driverId', 'route.name', 'vizzonInfo.destination.address.name',
  'vizzonInfo.destination.address.line1', 'vizzonInfo.destination.address.line2', 'vizzonInfo.destination.address.city',
  'vizzonInfo.destination.address.zipCode', 'vizzonInfo.shipmentInfo.cartons', 'vizzonInfo.shipmentInfo.volume',
  'vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.sealNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.updatedTime', 'comments.commentList.commentText', 'vizzonInfo.shipmentInfo.laneNbr',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.destination.dispSeq', 'shipmentDetail.productId',
  'shipmentDetail.estEarlyDTTM', 'canSelect',
];
const LABELS = { 'route.name': 'Load Name', 'vizzonInfo.destination.dispSeq': 'ShipTo - Display Seq', 'vizzonInfo.shipmentInfo.laneNbr': 'Lane Number', 'vizzonInfo.shipmentInfo.sealNbr': 'Seal Number' };
const grid = (extra = []) => ({
  filterData: [Object.fromEntries([...COLS_0927.map((k) => [k, { columnName: LABELS[k] ?? k }]), ...extra.map(([k, label]) => [k, { columnName: label }])])],
  values: [],
});
// One stop row in 77128's column order, plus whatever the extra columns carry.
function row({ nbr, status, route, arrival, extra = [] }) {
  const v = Object.fromEntries(COLS_0927.map((k) => [k, '']));
  Object.assign(v, {
    KeyColumn: `k-${nbr}`, 'default_vizzonInfo.shipmentInfo.status': status, 'vizzonInfo.shipmentInfo.stopNbr': nbr,
    'route.name': route, 'vizzonInfo.destination.earliestSchTime': arrival, 'vizzonInfo.updatedTime': '9/26/26 04:51 PM',
  });
  return [...COLS_0927.map((k) => v[k]), ...extra];
}

test('the 2026-09-27 column set has no Load Number column, and nothing in it is mistaken for one', () => {
  // "Load Name" (the route name), "Lane Number", "Seal Number" and the Display Seq all stay out.
  assert.equal(listLoadNbrColumn(grid()), null);
});

test('the Load Number column is found by its LABEL whatever key NuVizz gives it', () => {
  for (const [key, label] of [
    ['route.loadNbr', 'Load Number'],
    ['route.rteNbr', 'Load Number'],
    ['x.opaque.path', 'Load Number'],
    ['route.loadNbr', ''],
    ['route.rteNbr', ''],
    ['c27', 'Load No.'],
    ['c28', 'Load #'],
  ]) {
    const col = listLoadNbrColumn(grid([[key, label]]));
    assert.deepEqual(col, { key, label }, `${key} / "${label}"`);
  }
  // A load TIME or a load SEQUENCE is not the load number.
  assert.equal(listLoadNbrColumn(grid([['route.loadNbrDttm', 'Load Number Updated Dttm']])), null);
});

test('MARCUS on Friday and MARCUS on Monday: same route name, different load numbers, both kept', () => {
  const j = grid([['route.loadNbr', 'Load Number']]);
  j.values = [
    row({ nbr: '007182304', status: '90', route: 'MARCUS', arrival: '9/25/26 10:00 AM', extra: ['DAVIS000204535'] }),
    row({ nbr: '007182304-1', status: '20', route: 'MARCUS', arrival: '9/25/26 02:00 PM', extra: ['DAVIS000204645'] }),
  ];
  const [fri, mon] = normalize(j).map(toBoardStop);
  assert.equal(fri.loadNbr, 'MARCUS', 'loadNbr still holds the route NAME — every consumer reads it that way');
  assert.equal(mon.loadNbr, 'MARCUS');
  assert.equal(fri.nuvizzLoadNbr, 'DAVIS000204535');
  assert.equal(mon.nuvizzLoadNbr, 'DAVIS000204645', 'the -1 re-delivery is on MONDAY\'s MARCUS, and the row now says so');
});

test('the number is kept only on a routed order, and only when it looks like a load number', () => {
  const j = grid([['route.loadNbr', 'Load Number']]);
  j.values = [
    row({ nbr: '007182396', status: '10', route: '', arrival: '9/25/26 10:00 AM', extra: ['DAVIS000204645'] }),   // unplanned
    row({ nbr: '007182397', status: '20', route: 'DARVIN', arrival: '9/25/26 10:00 AM', extra: ['DARVIN'] }),     // a name, not a number
    row({ nbr: '007182398', status: '20', route: 'DARVIN', arrival: '9/25/26 10:00 AM', extra: ['6ab29f8f96c7f0f093e02599'] }),   // a load id
    row({ nbr: '007182399', status: '20', route: 'DARVIN', arrival: '9/25/26 10:00 AM', extra: ['{"colmnLinkId":"x","columnValue":"DAVIS000204650"}'] }),
  ];
  const [unplanned, named, hashed, linked] = normalize(j).map(toBoardStop);
  assert.equal(unplanned.nuvizzLoadNbr, null, 'an order on no load carries no load number');
  assert.equal(named.nuvizzLoadNbr, null);
  assert.equal(hashed.nuvizzLoadNbr, null);
  assert.equal(linked.nuvizzLoadNbr, 'DAVIS000204650', 'a link-object cell is unwrapped like every other column');
});

test('no column → every order reads null, never a guess', () => {
  const j = grid();
  j.values = [row({ nbr: '007182304-1', status: '20', route: 'MARCUS', arrival: '9/25/26 02:00 PM' })];
  assert.equal(toBoardStop(normalize(j)[0]).nuvizzLoadNbr, null);
});

test('LIVE: the list\'s number (or its absence) wins over a stored copy every scan', () => {
  assert.ok(LIVE_LIST_FIELDS.includes('nuvizzLoadNbr'));
  const moved = mergeEnrich({ stopNbr: 'A', routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645' }, { stopNbr: 'A', routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204535', enriched: true });
  assert.equal(moved.nuvizzLoadNbr, 'DAVIS000204645');
  const unplanned = mergeEnrich({ stopNbr: 'A', routeName: null, nuvizzLoadNbr: null }, { stopNbr: 'A', routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204535' });
  assert.equal(unplanned.nuvizzLoadNbr, null, 'taken off its load → no stored number sneaks back');
});

test('write grace: the number survives only when the list already names the route the Save did', () => {
  const at = '2026-09-28T12:00:00Z', now = Date.parse('2026-09-28T12:10:00Z');
  // The Save moved it A → B; the list still says A (A's number). The held row is on B, number unknown.
  const fresh = { stopNbr: 'S', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'ALPHA', routeName: 'ALPHA', nuvizzLoadNbr: 'DAVIS000000001' };
  const prior = { stopNbr: 'S', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'BRAVO', routeName: 'BRAVO', nuvizzLoadNbr: 'DAVIS000000001', board_write_at: at, board_write_planned: true };
  assert.equal(applyBoardWriteGrace(fresh, prior, now), true);
  assert.equal(fresh.routeName, 'BRAVO');
  assert.equal(fresh.nuvizzLoadNbr, null, 'never ALPHA\'s number on BRAVO');
  // The Save un-planned it; the list still has it on ALPHA. Held unplanned, no number.
  const fresh2 = { ...fresh, loadNbr: 'ALPHA', routeName: 'ALPHA', nuvizzLoadNbr: 'DAVIS000000001' };
  const prior2 = { stopNbr: 'S', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, board_write_at: at, board_write_planned: false };
  assert.equal(applyBoardWriteGrace(fresh2, prior2, now), true);
  assert.equal(fresh2.nuvizzLoadNbr, null);
});

test('demotion verify: a kept plan keeps its own number; an absent row\'s candidate carries none', async () => {
  assert.ok(PLAN_FIELDS.includes('nuvizzLoadNbr'));
  const p = { stopNbr: 'S', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS', routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645', routeSeq: 3 };
  const s = { stopNbr: 'S', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, nuvizzLoadNbr: null };
  const r = await applyDemotionVerify([{ s, p }], { max: 5, scannedAt: 'now', lookup: async () => true });
  assert.equal(r.kept, 1);
  assert.equal(s.nuvizzLoadNbr, 'DAVIS000204645');
  assert.equal(absentPlanDemoteCandidate(p).nuvizzLoadNbr, null);
});

test('the frozen-day heal and the open-order pool carry the number with the route', () => {
  const live = { stopNbr: 'S', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS', routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645' };
  assert.equal(healFields(live, { today: '2026-09-28', at: 'now', reason: 'plan' }).nuvizzLoadNbr, 'DAVIS000204645');
  assert.equal(healFields({ ...live, isPlanned: false, loadNbr: null, routeName: null, nuvizzLoadNbr: null }, { today: '2026-09-28', at: 'now', reason: 'plan' }).nuvizzLoadNbr, null, 'a heal to unplanned clears it');
  assert.equal(projectPoolRow(live, '2026-09-28').nuvizzLoadNbr, 'DAVIS000204645');
});

test('stop-explain names the load number beside the route', () => {
  assert.match(describeRow({ isPlanned: true, normalizedStatus: 'SCHEDULED', loadNbr: 'MARCUS', routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645', routeSeq: 8 }), /PLANNED on MARCUS \(DAVIS000204645\) \(stop 8\)/);
});

test('each pull records what it found, for nothing: the column, and how many routed orders had a number', () => {
  const j = grid([['route.loadNbr', 'Load Number']]);
  j.values = [
    row({ nbr: '1', status: '20', route: 'MARCUS', arrival: '9/28/26 10:00 AM', extra: ['DAVIS000204645'] }),
    row({ nbr: '2', status: '20', route: 'DARVIN', arrival: '9/28/26 10:00 AM', extra: [''] }),
    row({ nbr: '3', status: '10', route: '', arrival: '9/28/26 10:00 AM', extra: [''] }),
  ];
  assert.deepEqual(listLoadNbrSeen(j, normalize(j)), { column: 'route.loadNbr (Load Number)', routed: 2, withNumber: 1 });
  // No column: the record lists every column it WAS offered, so a label the pattern misses is a
  // one-line fix read off a stored document — not a NuVizz call.
  const none = grid();
  none.values = [row({ nbr: '1', status: '20', route: 'MARCUS', arrival: '9/28/26 10:00 AM' })];
  const seen = listLoadNbrSeen(none, normalize(none));
  assert.equal(seen.column, null);
  assert.equal(seen.withNumber, 0);
  assert.ok(seen.columns.includes('route.name=Load Name'));
  assert.equal(seen.columns.length, COLS_0927.length);
});
