// test/build-leave-off-ends.test.mjs — WHEN THE TRUCKS ARE FULL, WHAT COMES OFF IS THE END OF A
// ROUTE, NEVER A STOP A TRUCK DRIVES PAST.
//
// Chad, 2026-09-29: "has to be logic to both tractor and box truck being full can't just take random
// stops till it's full has to be route of some kind. Can't have the middle of the selection not being
// routed to where 2 trucks may end up next door because the system thought the one was full so it just
// left a neighbor off. Basically the routes need to be optimized and things left off the beginning or
// end".
//
// A HOLE, as these tests measure it: a stop left off whose cheapest place in the route of a truck
// ALLOWED to carry it is between two of that truck's stops, less than 3 km out of the way — the truck
// drives right past it. Everything runs the real pipeline (and, for Chad's board, the real Build
// handler on an in-memory Firestore with every other network call refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;

import routingBuild from '../netlify/functions/routing-build-background.mts';
import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';
import { resolveMatrix } from '../netlify/functions/google-route-matrix.mts';
import { DEPOT } from '../netlify/functions/lib/routing-types.mts';
import { equipmentReqsFrom } from '../netlify/functions/lib/routing-equipment.mts';
import { buildFreightFields, buildRules } from '../netlify/functions/lib/routing-build-rules.mts';
import { assignLeavingOffEnds } from '../netlify/functions/lib/routing-assign-ends.mts';
import { solveRouting } from '../netlify/functions/lib/routing-solver.mts';
import { repair } from '../netlify/functions/lib/routing-repair.mts';
import { normalizeMatchKey } from '../src/lib/matchKey.js';

const D = '2026-09-30';
const dock = { lat: DEPOT.lat, lng: DEPOT.lng };
const hav = (a, b) => {
  const R = 6371000, t = (d) => (d * Math.PI) / 180;
  const dl = t(b.lat - a.lat), dn = t(b.lng - a.lng);
  const s = Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const box = (id, maxSkids = 14) => ({ id, label: id, maxSkids, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } });
const tractor = (id, maxSkids = 28) => ({ id, label: id, maxSkids, maxWeightLbs: 30000, deckLengthIn: 636, capabilities: { liftgate: false, tractor: true, lengthClassFt: 53, overheadClearance: true } });

// The stops a truck drives past and still left off.
function holes(plan, rows, trucks, canCarry) {
  const by = new Map(rows.map((r) => [r.stopNbr, r]));
  const truckOf = new Map(trucks.map((t) => [t.id, t]));
  const out = [];
  for (const u of plan.unassigned) {
    const s = by.get(u.stopId);
    let best = Infinity, interior = false;
    for (const r of plan.routes) {
      if (!canCarry(u.stopId, truckOf.get(r.truckId))) continue;
      const pts = [dock, ...r.orderedStopIds.map((id) => by.get(id)), dock];
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = hav(pts[i], s) + hav(s, pts[i + 1]) - hav(pts[i], pts[i + 1]);
        if (d < best) { best = d; interior = i > 0 && i + 1 < pts.length - 1; }
      }
    }
    if (interior && best < 3000) out.push(u.stopId);
  }
  return out;
}
const skidsOf = (plan, rows, truckId) => {
  const by = new Map(rows.map((r) => [r.stopNbr, r]));
  return (plan.routes.find((r) => r.truckId === truckId)?.orderedStopIds || []).reduce((a, id) => a + by.get(id).cartons, 0);
};
const idsOf = (plan, truckId) => plan.routes.find((r) => r.truckId === truckId)?.orderedStopIds || [];

async function plan(rows, trucks, { greenOnly = false, green = new Set(), leaveOffEnds = true, strategy = 'FARTHEST_FIRST' } = {}) {
  const stops = rows.map((s) => ({ stopNbr: s.stopNbr, lat: s.lat, lng: s.lng, ...buildFreightFields(s, { countSkids: true }),
    equipmentReqs: equipmentReqsFrom(null, { tractorOnlyGreen: greenOnly, panelGreen: green.has(s.stopNbr) }) }));
  const reqs = new Map(stops.map((s) => [s.stopNbr, s.equipmentReqs]));
  const p = await runPipeline({ stops, trucks, depot: dock, strategy, date: D, matrixMode: 'haversine', windowMode: 'advisory', leaveOffEnds },
    { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
  p.canCarry = (id, t) => !(reqs.get(id).includes('box_truck_only') && t.capabilities.tractor);
  return p;
}

// ── Chad's board, through the real Build handler ──────────────────────────────────────────────
const TOWNS = [[34.165, -84.800], [34.283, -84.745], [34.502, -84.951], [34.369, -84.934], [34.770, -84.970]];
const WEIGHTS = [408, 134, 2271, 67, 86, 183, 165, 404, 385, 162, 66, 151, 264, 752, 889, 454, 300, 520, 610, 240, 380, 290, 410, 330, 420, 257];
const SKIDS = [1, 1, 3, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 3, 3, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1];
const sid = (i) => `0071830${String(i).padStart(2, '0')}`;
const GREEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 14];
const boardRow = (i) => {
  const [la, ln] = TOWNS[i % TOWNS.length];
  return {
    stopNbr: sid(i), businessName: `CUSTOMER ${i}`, addr1: `${100 + i} Main St`, city: 'CARTERSVILLE', zip: '30120',
    lat: la + ((i * 37) % 11 - 5) * 0.006, lng: ln + ((i * 53) % 11 - 5) * 0.006,
    cartons: SKIDS[i], pallets: SKIDS[i] * 4, weight: WEIGHTS[i], weightUOM: 'LB', isUnplanned: true,
    stopDetails: [{ quantity: SKIDS[i] * 6, quantityUOM: 'CTN', weight: WEIGHTS[i], weightUOM: 'LB' }],
  };
};
const CHE = tractor('CHE');
const SCOTT = box('SCOTT');

async function runChadBoard(env) {
  const rows = WEIGHTS.map((_, i) => boardRow(i));
  const request = {
    tenant: 'davis', date: D, selectedStopIds: rows.map((r) => r.stopNbr), trucks: [CHE, SCOTT], plannedLoads: [{ key: 'CHE' }, { key: 'SCOTT' }],
    strategy: 'FARTHEST_FIRST', matrixMode: 'haversine', tractorOnlyGreen: true, windowMode: 'advisory', panelGreenStopIds: GREEN.map(sid),
  };
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D }, 'routing_jobs/job_ends': { id: 'job_ends', status: 'queued', request } };
  for (const r of rows) seed[`nuvizz_stop_index/davis__${D}/stops/${r.stopNbr}`] = r;
  const hand = rows[14];
  seed[`customer_notes/${normalizeMatchKey(hand.businessName, hand.addr1, hand.city, hand.zip)}`] = { vehicle_eligibility: 'tractor' };
  const saved = process.env.ROUTING_BUILD_LEAVE_OFF_ENDS;
  if (env === undefined) delete process.env.ROUTING_BUILD_LEAVE_OFF_ENDS; else process.env.ROUTING_BUILD_LEAVE_OFF_ENDS = env;
  const fake = installFirestoreFake(seed);
  try {
    const res = await routingBuild(new Request('https://x.test/.netlify/functions/routing-build-background', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job_ends' }),
    }));
    assert.equal(res.status, 202);
    const job = fake.store.get('routing_jobs/job_ends');
    assert.equal(job.status, 'done', job.error);
    return { r: job.result, rows };
  } finally {
    fake.restore();
    if (saved === undefined) delete process.env.ROUTING_BUILD_LEAVE_OFF_ENDS; else process.env.ROUTING_BUILD_LEAVE_OFF_ENDS = saved;
  }
}
const greenIds = new Set(GREEN.map(sid));
const boardCanCarry = (id, t) => !(t.capabilities.tractor && !greenIds.has(id));

test('the switch has the house shape: on by default, an off-word turns it off, a typo leaves it ON', () => {
  assert.equal(buildRules({}).leaveOffEnds, true);
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(buildRules({ ROUTING_BUILD_LEAVE_OFF_ENDS: off }).leaveOffEnds, false, off);
  for (const on of ['of', 'on', 'yes', 'maybe', '']) assert.equal(buildRules({ ROUTING_BUILD_LEAVE_OFF_ENDS: on }).leaveOffEnds, true, on);
});

test('CHAD\'S BOARD (CHE + SCOTT, only green on a 53′): SCOTT stops at 14 and leaves off the far end of its run — not stops it drives past', async () => {
  const { r, rows } = await runChadBoard(undefined);
  assert.equal(r.buildRules.leaveOffEnds, true, 'the result says the rule ran');
  assert.equal(skidsOf(r, rows, 'SCOTT'), 14, 'the box is full');
  for (const id of idsOf(r, 'CHE')) assert.ok(greenIds.has(id), `${id} on the 53′ is green`);
  const placed = r.routes.flatMap((x) => x.orderedStopIds);
  assert.equal(placed.length + r.unassigned.length, rows.length, 'every stop is on a truck or on the list');
  assert.equal(new Set(placed).size, placed.length, 'no stop on two trucks');
  assert.deepEqual(holes(r, rows, [CHE, SCOTT], boardCanCarry), [], 'nothing left off is a stop SCOTT drives past');
  for (const u of r.unassigned) assert.ok(u.reasons.includes('over skid capacity'), `${u.stopId}: ${u.reasons}`);
});

test('…and switched OFF the Build is exactly the old one: SCOTT left stops it drives past', async () => {
  const { r, rows } = await runChadBoard('off');
  assert.equal(r.buildRules.leaveOffEnds, false);
  assert.ok(holes(r, rows, [CHE, SCOTT], boardCanCarry).length >= 1, 'the old assignment\'s holes are back');
});

// ── the corridor: 30 one-skid stops strung up the road from the dock, two 12-skid boxes ──────────
const corridor = Array.from({ length: 30 }, (_, i) => ({
  stopNbr: `C${String(i).padStart(2, '0')}`, lat: 34.12 + (i + 1) * 0.027, lng: -83.99 + (i + 1) * 0.024 + ((i % 3) - 1) * 0.01,
  cartons: 1, pallets: 1, weight: 300, weightUOM: 'LB', stopDetails: [],
}));

for (const strategy of ['FARTHEST_FIRST', 'MIN_DISTANCE']) {
  test(`THE CORRIDOR (${strategy}): each box runs one stretch of road, neither reaches back past the other, and the far end is what comes off`, async () => {
    const p = await plan(corridor, [box('BOX1', 12), box('BOX2', 12)], { strategy });
    for (const t of ['BOX1', 'BOX2']) {
      const n = idsOf(p, t).map((id) => Number(id.slice(1))).sort((a, b) => a - b);
      assert.equal(n.length, 12, `${t} is full`);
      assert.equal(n[n.length - 1] - n[0], 11, `${t} runs one unbroken stretch: ${n}`);
    }
    assert.deepEqual(p.unassigned.map((u) => u.stopId).sort(), ['C24', 'C25', 'C26', 'C27', 'C28', 'C29'], 'the far end of the road comes off');
    const old = await plan(corridor, [box('BOX1', 12), box('BOX2', 12)], { strategy, leaveOffEnds: false });
    const km = (x) => x.routes.reduce((a, r) => a + r.legs.reduce((b, l) => b + l.distanceMeters, 0), 0);
    assert.ok(km(p) < km(old), `fewer miles than the old split (${Math.round(km(p) / 1000)} vs ${Math.round(km(old) / 1000)} km)`);
  });
}

// ── two towns 25 km apart, mostly box-only freight, two boxes and a tractor ─────────────────────
const town = (tag, lat, lng) => Array.from({ length: 12 }, (_, i) => ({
  stopNbr: `${tag}${String(i).padStart(2, '0')}`, lat: lat + ((i * 37) % 11 - 5) * 0.008, lng: lng + ((i * 53) % 11 - 5) * 0.008,
  cartons: 1 + (i % 2), pallets: 2, weight: 400, weightUOM: 'LB', stopDetails: [],
}));
const twoTowns = [...town('W', 34.30, -84.40), ...town('E', 34.30, -84.10)];
const twoGreen = new Set(['W00', 'W01', 'E00', 'E01']);

for (const strategy of ['FARTHEST_FIRST', 'MIN_DISTANCE']) {
  test(`TWO TOWNS (${strategy}): each box runs one town — no box does both — and nothing left off is a stop a box drives past`, async () => {
    const trucks = [box('BOX1'), box('BOX2'), tractor('TRL')];
    const p = await plan(twoTowns, trucks, { greenOnly: true, green: twoGreen, strategy });
    for (const t of ['BOX1', 'BOX2']) {
      const towns = new Set(idsOf(p, t).map((id) => id[0]));
      assert.equal(towns.size, 1, `${t} runs one town: ${idsOf(p, t)}`);
    }
    assert.notEqual(idsOf(p, 'BOX1')[0][0], idsOf(p, 'BOX2')[0][0], 'the two boxes run different towns');
    for (const id of idsOf(p, 'TRL')) assert.ok(twoGreen.has(id), `${id} on the tractor is green`);
    assert.deepEqual(holes(p, twoTowns, trucks, p.canCarry), []);
    const old = await plan(twoTowns, trucks, { greenOnly: true, green: twoGreen, strategy, leaveOffEnds: false });
    assert.ok(['BOX1', 'BOX2'].some((t) => new Set(idsOf(old, t).map((id) => id[0])).size === 2), 'the old assignment sent a box to both towns');
  });
}

test('A BOX WITH A SKID TO SPARE DOES NOT CROSS TOWN FOR IT — the leftover room is not filled with a stop 25 km into the other box\'s town', async () => {
  const trucks = [box('BOX1'), box('BOX2'), tractor('TRL')];
  const p = await plan(twoTowns, trucks, { greenOnly: true, green: twoGreen, strategy: 'FARTHEST_FIRST' });
  for (const t of ['BOX1', 'BOX2']) assert.ok(skidsOf(p, twoTowns, t) <= 14);
  const eastBox = idsOf(p, 'BOX1')[0][0] === 'E' ? 'BOX1' : 'BOX2';
  assert.ok(idsOf(p, eastBox).every((id) => id[0] === 'E'), `the east box took no west stop: ${idsOf(p, eastBox)}`);
});

// ── a dense town and three far outliers, one box ──────────────────────────────────────────────
test('A DENSE TOWN AND FAR OUTLIERS: the outliers come off — never the stops the truck drives through', async () => {
  const dense = Array.from({ length: 16 }, (_, i) => ({ stopNbr: `T${String(i).padStart(2, '0')}`, lat: 34.45 + ((i * 7) % 5) * 0.006, lng: -84.25 + ((i * 3) % 4) * 0.006, cartons: 1, pallets: 1, weight: 300, weightUOM: 'LB', stopDetails: [] }));
  const outliers = [0, 1, 2].map((k) => ({ stopNbr: `O${k}`, lat: 34.70 + k * 0.01, lng: -84.55 - k * 0.01, cartons: 1, pallets: 1, weight: 300, weightUOM: 'LB', stopDetails: [] }));
  const rows = [...dense, ...outliers];
  for (const strategy of ['FARTHEST_FIRST', 'MIN_DISTANCE']) {
    const p = await plan(rows, [box('B', 14)], { strategy });
    assert.equal(skidsOf(p, rows, 'B'), 14, 'the box is full');
    assert.deepEqual(holes(p, rows, [box('B', 14)], () => true), [], `${strategy}: nothing left off that the truck drives past`);
    assert.ok(p.unassigned.some((u) => u.stopId.startsWith('O')), `${strategy}: an outlier comes off: ${p.unassigned.map((u) => u.stopId)}`);
  }
});

// ── a flexible stop moves to a truck with room before box-only freight is left off ───────────────
test('A STOP THE TRACTOR CAN TAKE MOVES TO THE TRACTOR before box-only freight is pushed off the box', () => {
  const S = (id, lat, lng, skids, reqs) => ({ id, lat, lng, skids, weightLbs: 300, linearFeetIn: 0, serviceMin: 15, equipmentReqs: reqs });
  // eight box-only skids and one green skid, all in one town; a 8-skid box and a tractor
  const stops = [...Array.from({ length: 8 }, (_, i) => S(`B${i}`, 34.3 + i * 0.002, -84.1, 1, ['box_truck_only'])), S('G0', 34.301, -84.101, 1, [])];
  const r = assignLeavingOffEnds(stops, [box('BOX', 8), tractor('TRL')], dock);
  assert.deepEqual(r.byTruck.get('BOX').map((s) => s.id).sort(), ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
  assert.deepEqual(r.byTruck.get('TRL').map((s) => s.id), ['G0']);
  assert.deepEqual(r.unassigned, []);
});

test('WHEN "BOX-ONLY FIRST" AND "NO HOLES" COLLIDE, NO HOLES WINS: the box keeps the green stop it drives past and the far box-only stop comes off the end', () => {
  const S = (id, lat, skids, reqs) => ({ id, lat, lng: -83.96, skids, weightLbs: 300, linearFeetIn: 0, serviceMin: 15, equipmentReqs: reqs });
  // up the road from the dock: a box-only stop farthest out, two green ones just short of it, three box-only nearer in;
  // a 4-skid box and a 1-skid tractor — one stop has to come off, and the tractor is full.
  const stops = [S('B0', 34.60, 1, ['box_truck_only']), S('G0', 34.58, 1, []), S('G1', 34.56, 1, []),
    S('B1', 34.50, 1, ['box_truck_only']), S('B2', 34.48, 1, ['box_truck_only']), S('B3', 34.46, 1, ['box_truck_only'])];
  const r = assignLeavingOffEnds(stops, [box('BOX', 4), tractor('TRL', 1)], dock);
  assert.deepEqual(r.unassigned.map((u) => u.stopId), ['B0'], 'the far end of the box\'s run comes off');
  assert.deepEqual(r.byTruck.get('BOX').map((s) => s.id).sort(), ['B1', 'B2', 'B3', 'G0'], 'the green stop it drives past stays on');
  assert.equal(r.byTruck.get('TRL').length, 1);
});

test('A SKID OR TWO OF ROOM IS NOT FILLED BY CROSSING TOWN: the east box keeps its spare room rather than drive 25 km west for one skid', () => {
  const S = (id, lat, lng, skids) => ({ id, lat, lng, skids, weightLbs: 300, linearFeetIn: 0, serviceMin: 15, equipmentReqs: [] });
  // west town: 15 one-skid stops for a 14-skid box (one too many); east town: 12 one-skid stops and a 3-skid stop farther out,
  // 15 skids for the other 14-skid box — so the east box sheds the 3-skid stop and has 2 skids spare.
  const west = Array.from({ length: 15 }, (_, i) => S(`W${String(i).padStart(2, '0')}`, 34.30 + ((i * 37) % 11 - 5) * 0.004, -84.40 + ((i * 53) % 11 - 5) * 0.004, 1));
  const east = Array.from({ length: 12 }, (_, i) => S(`E${String(i).padStart(2, '0')}`, 34.30 + ((i * 37) % 11 - 5) * 0.004, -84.10 + ((i * 53) % 11 - 5) * 0.004, 1));
  const r = assignLeavingOffEnds([...west, ...east, S('EFAR', 34.42, -84.10, 3)], [box('BOXW', 14), box('BOXE', 14)], dock);
  const eastBox = r.byTruck.get('BOXE').some((s) => s.id.startsWith('E')) ? 'BOXE' : 'BOXW';
  const westBox = eastBox === 'BOXE' ? 'BOXW' : 'BOXE';
  assert.ok(r.byTruck.get(eastBox).every((s) => s.id.startsWith('E')), `the east box took no west stop: ${r.byTruck.get(eastBox).map((s) => s.id)}`);
  assert.equal(r.byTruck.get(westBox).reduce((a, s) => a + s.skids, 0), 14, 'the west box is full');
  assert.equal(r.byTruck.get(eastBox).reduce((a, s) => a + s.skids, 0), 12, 'the east box keeps its two skids spare');
  assert.deepEqual(r.unassigned.map((u) => u.stopId).sort(), ['EFAR', r.unassigned.find((u) => u.stopId.startsWith('W')).stopId].sort());
});

// ── the hard rules, on seeded random overloaded boards ────────────────────────────────────────
test('HARD RULES on 80 random overloaded boards: nothing lost or doubled, no truck over, nothing box-only on a tractor — and far fewer holes, the same freight', async () => {
  let seed = 424242; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let oldHoles = 0, newHoles = 0, oldSkids = 0, newSkids = 0;
  for (let b = 0; b < 80; b++) {
    const trucks = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => (rnd() < 0.3 ? tractor(`T${i}`) : box(`B${i}`)));
    const cap = trucks.reduce((a, t) => a + t.maxSkids, 0);
    const centres = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => [34.15 + (rnd() - 0.3) * 0.9, -83.96 + (rnd() - 0.6) * 1.2]);
    const rows = []; let sk = 0;
    while (sk < cap * (1.1 + rnd() * 0.9)) {
      const [la, ln] = centres[Math.floor(rnd() * centres.length)];
      const c = rnd() < 0.7 ? 1 : (rnd() < 0.7 ? 2 : 3);
      rows.push({ stopNbr: `X${rows.length}`, lat: la + (rnd() - 0.5) * 0.12, lng: ln + (rnd() - 0.5) * 0.12, cartons: c, pallets: c, weight: 300, weightUOM: 'LB', stopDetails: [] });
      sk += c;
    }
    const greenOnly = rnd() < 0.5;
    const green = new Set(rows.filter(() => rnd() < 0.4).map((r) => r.stopNbr));
    const strategy = rnd() < 0.5 ? 'FARTHEST_FIRST' : 'MIN_DISTANCE';
    for (const leaveOffEnds of [false, true]) {
      const p = await plan(rows, trucks, { greenOnly, green, strategy, leaveOffEnds });
      const seen = new Map();
      for (const r of p.routes) for (const id of r.orderedStopIds) seen.set(id, (seen.get(id) || 0) + 1);
      for (const u of p.unassigned) seen.set(u.stopId, (seen.get(u.stopId) || 0) + 1);
      for (const r of rows) assert.equal(seen.get(r.stopNbr), 1, `board ${b}: ${r.stopNbr} seen ${seen.get(r.stopNbr) || 0}x`);
      for (const r of p.routes) {
        const t = trucks.find((x) => x.id === r.truckId);
        assert.ok(skidsOf(p, rows, t.id) <= t.maxSkids, `board ${b}: ${t.id} over`);
        if (greenOnly && t.capabilities.tractor) for (const id of r.orderedStopIds) assert.ok(green.has(id), `board ${b}: box-only ${id} on ${t.id}`);
      }
      const h = holes(p, rows, trucks, p.canCarry).length;
      const s = p.routes.reduce((a, r) => a + skidsOf(p, rows, r.truckId), 0);
      if (leaveOffEnds) { newHoles += h; newSkids += s; } else { oldHoles += h; oldSkids += s; }
    }
  }
  assert.ok(newHoles * 3 < oldHoles, `holes: ${oldHoles} → ${newHoles}`);
  assert.ok(newSkids >= oldSkids * 0.99, `skids routed: ${oldSkids} → ${newSkids}`);
});

// ── repair keeps the solver's choice ──────────────────────────────────────────────────────────
test('REPAIR KEEPS THE SOLVER\'S CHOICE: a stop the solver left off is not stuffed into whichever truck has a skid spare — with the rule off, it still is', () => {
  const st = (id, lat) => ({ id, lat, lng: -84.1, skids: 1, weightLbs: 100, linearFeetIn: 0, oversize: false, serviceMin: 0, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: [] });
  const stops = [st('A', 34.3), st('B', 34.301), st('C', 34.9), st('D', 34.302)];
  const n = stops.length + 1;
  const pts = [dock, ...stops];
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => hav(pts[i], pts[j])));
  const trucks = [box('T1', 2), box('T2', 2)];
  const output = {
    routes: [
      { truckId: 'T1', orderedStopIds: ['A', 'B'] },
      { truckId: 'T2', orderedStopIds: ['C'] },
    ],
    unassigned: [{ stopId: 'D', reasons: ['over skid capacity'] }],
    meta: {},
  };
  const base = { stops, trucks, depot: dock, matrix: { distanceMeters: m, durationSec: m }, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0 };
  const kept = repair({ ...base, leaveOffEnds: true }, output);
  assert.deepEqual(kept.unassigned.map((u) => u.stopId), ['D'], 'the solver left D off; repair leaves it off');
  const old = repair(base, output);
  assert.deepEqual(old.unassigned, [], 'with the rule off, repair re-inserts it as before');
});

test('THE WIRING: the Build passes the switch to the solver, the solver picks the assignment by it, the job says which ran', () => {
  const bg = readFileSync(new URL('../netlify/functions/routing-build-background.mts', import.meta.url), 'utf8');
  assert.match(bg, /leaveOffEnds: rules\.leaveOffEnds,/);
  const pipe = readFileSync(new URL('../netlify/functions/lib/routing-pipeline.mts', import.meta.url), 'utf8');
  assert.match(pipe, /leaveOffEnds: req\.leaveOffEnds === true,/);
  const solver = readFileSync(new URL('../netlify/functions/lib/routing-solver.mts', import.meta.url), 'utf8');
  assert.match(solver, /input\.leaveOffEnds\s*\?\s*assignLeavingOffEnds\(/);
  // An input that does not ask gets the original assignment, byte for byte.
  const st = (id, lat) => ({ id, lat, lng: -84.1, skids: 1, weightLbs: 100, linearFeetIn: 0, oversize: false, serviceMin: 0, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: [] });
  const stops = [st('A', 34.3), st('B', 34.31)];
  const pts = [dock, ...stops];
  const m = pts.map((a) => pts.map((b) => hav(a, b)));
  const input = { stops, trucks: [box('T1')], depot: dock, matrix: { distanceMeters: m, durationSec: m }, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 } };
  assert.deepEqual(solveRouting(input).routes[0].orderedStopIds.sort(), ['A', 'B']);
});
