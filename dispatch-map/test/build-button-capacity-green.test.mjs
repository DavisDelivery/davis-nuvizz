// test/build-button-capacity-green.test.mjs — THE BUILD BUTTON FILLS A TRUCK TO WHAT IT CAN CARRY,
// AND "GREEN" MEANS WHAT THE SELECTED PANEL PAINTS.
//
// Chad, 2026-09-28, after a Build onto CHE (a 53′) and SCOTT (a 26′ box) put 24 stops and 30
// skids on the box and one stop on the trailer, with the Selected panel reading "leaves 11 a
// tractor can run": "a 14 skid box truck stops with 14 skids and if not enough green stops to fit
// on a tractor then it stops there too or at 30 skids either one. then lists everything that
// didn't fit."
//
// These run the REAL Build handler (routing-build-background) against an in-memory Firestore and
// a fetch that THROWS on anything that is not Firestore — so the board, the notes and the job are
// real documents, and "no NuVizz / Google / model call was made" is proven, not asserted.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;

import routingBuild from '../netlify/functions/routing-build-background.mts';
import {
  buildRules, buildFreightFields, trucksWithRoomLeft, withExistingFreight, LOAD_FULL_ROOM,
} from '../netlify/functions/lib/routing-build-rules.mts';
import { equipmentReqsFrom } from '../netlify/functions/lib/routing-equipment.mts';
import { buildCleanupPlan } from '../netlify/functions/lib/routing-cleanup-core.mts';
import { liveMatchKey } from '../netlify/functions/lib/routing-draft-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { normalizeMatchKey } from '../src/lib/matchKey.js';
import { readFileSync } from 'node:fs';

const D = '2026-09-29';
const SWITCHES = ['ROUTING_BUILD_COUNT_SKIDS', 'ROUTING_BUILD_GREEN_MATCHES_PANEL', 'ROUTING_BUILD_COUNTS_EXISTING'];

// ── CHAD'S BOARD, IN SHAPE: 26 stops round Cartersville / White / Calhoun / Adairsville /
// Dalton, 36 skids and 10,601 lb. One stop is hand-painted green, ten more are green only by the
// badge or a tractor's history (the panel counts all eleven as "a tractor can run"), fifteen are
// plain. The lines are itemised in CARTONS, so before this change the Build counted 0 skids. ──
const TOWNS = [[34.165, -84.800], [34.283, -84.745], [34.502, -84.951], [34.369, -84.934], [34.770, -84.970]];
const WEIGHTS = [408, 134, 2271, 67, 86, 183, 165, 404, 385, 162, 66, 151, 264, 752, 889, 454, 300, 520, 610, 240, 380, 290, 410, 330, 420, 257];
const SKIDS = [1, 1, 3, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 3, 3, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1];
const id = (i) => `0071830${String(i).padStart(2, '0')}`;
const HAND_GREEN = 14;                                  // CORE MARK, the one CHE got
const BADGE_GREEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];     // green on the panel, not on the note
const boardRow = (i) => {
  const [la, ln] = TOWNS[i % TOWNS.length];
  return {
    stopNbr: id(i), businessName: `CUSTOMER ${i}`, addr1: `${100 + i} Main St`, city: 'CARTERSVILLE', zip: '30120',
    lat: la + ((i * 37) % 11 - 5) * 0.006, lng: ln + ((i * 53) % 11 - 5) * 0.006,
    cartons: SKIDS[i], pallets: SKIDS[i] * 4, weight: WEIGHTS[i], weightUOM: 'LB', isUnplanned: true,
    stopDetails: [{ quantity: SKIDS[i] * 6, quantityUOM: 'CTN', weight: WEIGHTS[i], weightUOM: 'LB' }],
  };
};
const CHE = { id: 'CHE', label: 'CHE', maxSkids: 28, maxWeightLbs: 30000, deckLengthIn: 636, capabilities: { tractor: true, liftgate: false, lengthClassFt: 53, overheadClearance: true } };
const SCOTT = { id: 'SCOTT', label: 'SCOTT', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { tractor: false, liftgate: true, lengthClassFt: 26, overheadClearance: true } };

function seedFor({ rows, request }) {
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D } };
  for (const r of rows) seed[`nuvizz_stop_index/davis__${D}/stops/${r.stopNbr}`] = r;
  const hand = rows.find((r) => r.stopNbr === id(HAND_GREEN));
  if (hand) seed[`customer_notes/${normalizeMatchKey(hand.businessName, hand.addr1, hand.city, hand.zip)}`] = { vehicle_eligibility: 'tractor' };
  seed['routing_jobs/job_ownerboard'] = { id: 'job_ownerboard', status: 'queued', request };
  return seed;
}

async function runBuild({ rows, request, env = {} }) {
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  const fake = installFirestoreFake(seedFor({ rows, request }));
  try {
    const res = await routingBuild(new Request('https://x.test/.netlify/functions/routing-build-background', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job_ownerboard' }),
    }));
    assert.equal(res.status, 202);
    const job = fake.store.get('routing_jobs/job_ownerboard');
    assert.equal(job.status, 'done', job.error);
    return job.result;
  } finally {
    fake.restore();
    for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const boardRequest = (extra = {}) => ({
  tenant: 'davis', date: D, selectedStopIds: WEIGHTS.map((_, i) => id(i)),
  trucks: [CHE, SCOTT], plannedLoads: [{ key: 'CHE' }, { key: 'SCOTT' }],
  strategy: 'MIN_DISTANCE', matrixMode: 'haversine', tractorOnlyGreen: true, windowMode: 'advisory',
  panelGreenStopIds: [...BADGE_GREEN, HAND_GREEN].map(id),
  ...extra,
});
const routeOf = (result, truck) => result.routes.find((r) => r.truckId === truck) || { orderedStopIds: [] };
const realSkids = (ids) => ids.reduce((a, s) => a + SKIDS[WEIGHTS.findIndex((_, i) => id(i) === s)], 0);

test('the three switches have the house shape: on by default, an explicit off-word turns each off, a typo leaves it ON', () => {
  assert.deepEqual(buildRules({}), { countSkids: true, greenMatchesPanel: true, countsExisting: true });
  for (const k of SWITCHES) {
    for (const off of ['off', 'OFF ', '0', 'false', 'no']) assert.equal(Object.values(buildRules({ [k]: off })).filter((v) => !v).length, 1, `${k}=${off}`);
    for (const on of ['of', 'yes', 'on', '1', 'maybe']) assert.deepEqual(buildRules({ [k]: on }), { countSkids: true, greenMatchesPanel: true, countsExisting: true }, `${k}=${on}`);
  }
});

test('CHAD\'S BOARD, AS IT WAS: CHE gets the one hand-painted stop and SCOTT, a 14-skid box, gets 30+ skids — the Build counted none', async () => {
  const r = await runBuild({ rows: WEIGHTS.map((_, i) => boardRow(i)), request: boardRequest(),
    env: { ROUTING_BUILD_COUNT_SKIDS: 'off', ROUTING_BUILD_GREEN_MATCHES_PANEL: 'off', ROUTING_BUILD_COUNTS_EXISTING: 'off' } });
  assert.deepEqual(routeOf(r, 'CHE').orderedStopIds, [id(HAND_GREEN)], 'only the painted stop rode the 53′');
  assert.ok(realSkids(routeOf(r, 'SCOTT').orderedStopIds) > 14, `SCOTT carried ${realSkids(routeOf(r, 'SCOTT').orderedStopIds)} real skids on a 14-skid box`);
  assert.equal(routeOf(r, 'SCOTT').load.skids, 0, 'and the Build counted 0 of them');
  assert.deepEqual(r.buildRules, { countSkids: false, greenMatchesPanel: false, countsExisting: false, panelGreenStops: null, existing: {} });
});

test('CHAD\'S RULE: the box stops at 14 skids, the 53′ takes the green the panel paints (and nothing else), everything else is listed', async () => {
  const r = await runBuild({ rows: WEIGHTS.map((_, i) => boardRow(i)), request: boardRequest() });
  const che = routeOf(r, 'CHE').orderedStopIds, scott = routeOf(r, 'SCOTT').orderedStopIds;
  const green = new Set([...BADGE_GREEN, HAND_GREEN].map(id));
  assert.ok(che.length > 1, `CHE got ${che.length} stops`);
  for (const s of che) assert.ok(green.has(s), `${s} rode the 53′ but the panel does not paint it green`);
  assert.deepEqual(new Set(che), green, 'all eleven green stops fit a 28-skid trailer, so all eleven ride it');
  assert.ok(realSkids(scott) <= 14, `SCOTT carries ${realSkids(scott)} real skids on a 14-skid box`);
  assert.equal(routeOf(r, 'SCOTT').load.skids, realSkids(scott), 'the Build now counts the skids it loads');
  // Everything that did not fit is listed, with a reason, and nothing vanished.
  const placed = new Set([...che, ...scott]);
  const listed = new Set(r.unassigned.map((u) => u.stopId));
  for (let i = 0; i < WEIGHTS.length; i++) assert.ok(placed.has(id(i)) !== listed.has(id(i)), `${id(i)} is placed or listed, exactly once`);
  assert.ok(r.unassigned.length > 0, 'fifteen plain stops of 17 skids cannot all fit a 14-skid box');
  for (const u of r.unassigned) assert.ok(u.reasons.length > 0, `${u.stopId} is listed without a reason`);
  assert.equal(r.buildRules.panelGreenStops, 11);
});

test('a TRACTOR stops at its own profile too — green freight beyond its skids is listed, never forced on', async () => {
  const small = { ...CHE, maxSkids: 6 };
  const r = await runBuild({ rows: WEIGHTS.map((_, i) => boardRow(i)), request: boardRequest({ trucks: [small, SCOTT] }) });
  assert.ok(realSkids(routeOf(r, 'CHE').orderedStopIds) <= 6);
  assert.ok(r.unassigned.some((u) => [...BADGE_GREEN, HAND_GREEN].map(id).includes(u.stopId)), 'green that did not fit the trailer is listed');
});

test('WHAT IS ALREADY ON THE LOAD COUNTS: a box already carrying 5 skids is offered 9, and the result shows the whole truck', async () => {
  const onBoard = [
    { ...boardRow(0), stopNbr: 'EX1', isUnplanned: false, cartons: 3, weight: 1200, stopDetails: [] },
    { ...boardRow(1), stopNbr: 'EX2', isUnplanned: false, cartons: 2, weight: 800, stopDetails: [] },
  ];
  const rows = [...WEIGHTS.map((_, i) => boardRow(i)), ...onBoard];
  const r = await runBuild({ rows, request: boardRequest({ tractorOnlyGreen: false, existingByTruck: { SCOTT: { stopNbrs: ['EX1', 'EX2'] } } }) });
  const scott = routeOf(r, 'SCOTT');
  assert.ok(realSkids(scott.orderedStopIds) <= 9, `offered 9, loaded ${realSkids(scott.orderedStopIds)}`);
  assert.equal(scott.capacity.skids, 14, 'the card shows the whole truck, not "9 / 9"');
  assert.equal(scott.load.skids, realSkids(scott.orderedStopIds) + 5, 'its load includes the 5 already on it');
  assert.deepEqual(scott.existing, { stops: 2, skids: 5, weightLbs: 2000, unread: 0, full: false });
  // Switched off, the load is offered the whole truck again.
  const off = await runBuild({ rows, request: boardRequest({ tractorOnlyGreen: false, existingByTruck: { SCOTT: { stopNbrs: ['EX1', 'EX2'] } } }), env: { ROUTING_BUILD_COUNTS_EXISTING: 'off' } });
  assert.ok(realSkids(routeOf(off, 'SCOTT').orderedStopIds) > 9);
});

test('the panel\'s green lifts ONLY the tick — a red Box-only stop and a hand-ticked restriction still keep a 53′ away', () => {
  assert.deepEqual(equipmentReqsFrom(null, { tractorOnlyGreen: true, panelGreen: true }), []);
  assert.deepEqual(equipmentReqsFrom(null, { tractorOnlyGreen: true }), ['box_truck_only']);
  assert.deepEqual(equipmentReqsFrom({ vehicle_eligibility: 'box_only' }, { tractorOnlyGreen: true, panelGreen: true }), ['box_truck_only']);
  assert.deepEqual(equipmentReqsFrom({ equipment_restrictions: ['no_tractor_trailer'] }, { tractorOnlyGreen: true, panelGreen: true }), ['no_tractor_trailer']);
  assert.deepEqual(equipmentReqsFrom({ equipment_restrictions: ['uline_straight_truck'] }, { tractorOnlyGreen: false, panelGreen: true }), ['uline_straight_truck'], 'the panel\'s green is not a mark and lifts no restriction');
});

test('freight fields: cartons go through only while skids are counted, and a missing count stays missing', () => {
  assert.equal(buildFreightFields({ cartons: 4 }, { countSkids: true }).cartons, 4);
  assert.equal('cartons' in buildFreightFields({ cartons: 4 }, { countSkids: false }), false);
  assert.equal('cartons' in buildFreightFields({ cartons: null }, { countSkids: true }), false, 'Number(null) is 0 — a stop with no count must not read as 0 skids');
});

test('room left: a full load is a sliver nothing fits in, never 0 (which the solver reads as no limit); a stop nobody can read takes a position', () => {
  const box = { id: 'B', maxSkids: 14, maxWeightLbs: 10000 };
  const board = new Map([['A', { cartons: 14, weight: 900 }]]);
  const full = trucksWithRoomLeft([box], { B: { stopNbrs: ['A'] } }, board, { countSkids: true });
  assert.ok(full.trucks[0].maxSkids > 0 && full.trucks[0].maxSkids < 0.01, `a sliver, never 0 — the solver reads 0 as NO LIMIT: ${full.trucks[0].maxSkids}`);
  assert.equal(full.trucks[0].maxSkids, LOAD_FULL_ROOM);
  assert.equal(full.existing.B.full, true);
  const ghost = trucksWithRoomLeft([box], { B: { stopNbrs: ['NOPE'] } }, new Map(), { countSkids: true });
  assert.equal(ghost.trucks[0].maxSkids, 13);
  assert.equal(ghost.existing.B.unread, 1);
  const none = trucksWithRoomLeft([{ id: 'T', maxSkids: null, maxWeightLbs: 30000 }], { T: { stopNbrs: ['A'] } }, board, { countSkids: true });
  assert.equal(none.trucks[0].maxSkids, null, 'no stated cap stays no cap');
  assert.equal(trucksWithRoomLeft([box], {}, board, { countSkids: true }).trucks[0], box, 'a load with nothing on it is untouched');
});

test('the result says what is on the truck: "tight on" is rewritten from the true total, not the room', () => {
  const plan = {
    routes: [{ truckId: 'B', load: { skids: 9, weightLbs: 3000 }, capacity: { skids: 9, weightLbs: 8000 }, orderedStopIds: ['X'] }],
    riskFlags: ['Truck B: tight on skids (9/9).', 'Stop X is outside its time window — kept on the route as advisory.'],
  };
  const out = withExistingFreight(plan, { B: { stops: 2, skids: 5, weightLbs: 2000 } }, [{ id: 'B', fullMaxSkids: 14, fullMaxWeightLbs: 10000 }]);
  assert.deepEqual(out.routes[0].load, { skids: 14, weightLbs: 5000 });
  assert.deepEqual(out.routes[0].capacity, { skids: 14, weightLbs: 10000 });
  assert.deepEqual(out.riskFlags, ['Stop X is outside its time window — kept on the route as advisory.', 'Truck B: tight on skids (14/14, 5 already on it).']);
});

test('ONE GREEN, TWO BUILDERS: Fill my loads reads the panel\'s green under the same tick and the same switch', () => {
  const CFG = engineConfigDefaults({});
  const rows = [
    { stopNbr: 'G1', isUnplanned: true, businessName: 'BADGE GREEN', addr1: '1 A St', city: 'X', zip: '30120', lat: 34.2, lng: -84.8, cartons: 2, volume: 0, pallets: 2, weight: 300 },
    { stopNbr: 'P1', isUnplanned: true, businessName: 'PLAIN', addr1: '2 B St', city: 'X', zip: '30120', lat: 34.21, lng: -84.81, cartons: 2, volume: 0, pallets: 2, weight: 300 },
  ];
  const inputs = { driverDaysBefore: [], referencesBefore: [], serviceDocByKey: new Map(), fleetServiceDoc: null, habitDocByKey: new Map(), notesRestrictions: new Map(), noteByKey: new Map(), tractorCapable: new Set(), employees: [] };
  const trl = { key: 'TRL', name: 'TRL', loadNbr: 'L1', loadId: null, truck_class: 'tractor', max_skids: 28, max_weight_lb: 30000, liftgate: false, capabilities: { tractor: true, liftgate: false, lengthClassFt: 53, overheadClearance: true }, existing_stop_nbrs: null, driver_user_name: null };
  const plan = (extra) => buildCleanupPlan('davis', D, { cfg: CFG, inputs, liveStops: rows, meta: null, trucks: [trl], nowIso: `${D}T01:00:00Z`, rules: 'build', tractorOnlyGreen: true, ...extra });
  const on = plan({ panelGreenStopNbrs: ['G1'] });
  assert.deepEqual(on.trucks[0].stops.map((s) => s.stopNbr), ['G1'], 'the panel-green stop rides the 53′; the plain one is held off it');
  assert.equal(on.rules_detail.green_matches_panel, true);
  const handOnly = plan({ panelGreenStopNbrs: null });
  assert.equal(handOnly.trucks[0].stop_count, 0, 'without the panel\'s list only a painted mark counts, as before');
  void liveMatchKey;
});

test('THE BROWSER SENDS THE PANEL\'S OWN GREEN — the same function on the same data the Selected panel paints with', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const panelGreenIds = useCallback\(\s*\(stops\) => \(stops \|\| \[\]\)\.filter\(\(s\) => stopTractorFriendly\(s, notes, tractorLocs\)\)/);
  assert.match(src, /<RoutingSelectionFloatPanel selectedStops=\{selectedStops\} notes=\{notes\} tractorLocs=\{tractorLocs\}/, 'the panel is fed the same three');
  assert.match(src, /panelGreenStopIds: panelGreenIds\(selectedStops\),/, 'the Build sends the selection\'s green');
  assert.match(src, /existingByTruck: Object\.fromEntries\(planTargets\.map\(\(t\) => \{\s*const ids = loadExistingIds\(t\);/, 'and what each picked load carries');
  assert.match(src, /green_stop_nbrs: trailerGreenOnly \? panelGreenIds\(/, 'Fill my loads sends the same green for its pool');
});

test('a box that is ALREADY FULL gets nothing from the Build — the stops are listed, not piled on top', async () => {
  const onBoard = [{ ...boardRow(0), stopNbr: 'FULL1', isUnplanned: false, cartons: 14, weight: 2000, stopDetails: [] }];
  const rows = [...WEIGHTS.map((_, i) => boardRow(i)), ...onBoard];
  const r = await runBuild({ rows, request: boardRequest({ tractorOnlyGreen: false, trucks: [SCOTT], plannedLoads: [{ key: 'SCOTT' }], existingByTruck: { SCOTT: { stopNbrs: ['FULL1'] } } }) });
  assert.equal(routeOf(r, 'SCOTT').orderedStopIds.length, 0, `a full box took ${routeOf(r, 'SCOTT').orderedStopIds.length} more stops`);
  assert.equal(r.unassigned.length, WEIGHTS.length, 'every selected stop is listed');
  assert.equal(r.buildRules.existing.SCOTT.full, true);
});

test('a stop that is ALREADY on the load AND selected again is counted once — as a stop being re-planned, not as freight already aboard', () => {
  const box = { id: 'B', maxSkids: 14, maxWeightLbs: 10000 };
  const board = new Map([['A', { cartons: 4, weight: 900 }], ['C', { cartons: 3, weight: 500 }]]);
  const r = trucksWithRoomLeft([box], { B: { stopNbrs: ['A', 'C'] } }, board, { countSkids: true }, ['A']);
  assert.equal(r.trucks[0].maxSkids, 11, 'only C (3 skids) is already aboard; A is in the build');
  assert.deepEqual(r.existing.B, { stops: 1, skids: 3, weightLbs: 500, unread: 0, full: false });
});
