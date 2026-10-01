// test/build-fill-trucks.test.mjs — WHEN THE TRUCKS CANNOT CARRY EVERYTHING: FILL THEM, AND WHAT IS
// LEFT OFF IS ONE GROUP — THE RUN ONE MORE TRUCK WOULD MAKE — WITH NO NEIGHBOUR LEFT OFF, AND EACH
// TRUCK JUDGED AS IT WILL SHIP: WINDOWS AND THE DRIVER'S DAY INCLUDED.
//
// Chad, 2026-09-30, on a Build onto CHE, SCOTT and TRAILER 1: "worked better but still left orders
// off the loads that only one was full and didn't have any logic to how it left them off they were
// orders scattered across 3 towns so i would have sent an additional truck to cover this".
//
// His board is rebuilt here from the screenshot: the names, stop numbers, towns, skids, loose
// pieces, windows and card weights as shown. The pins are town centres moved by a seeded offset of
// up to 4 km (the real pins are in Firestore); placement 7 reproduces his screen order for order on
// the code before this change, and the first test below pins exactly that. Everything runs the real
// pipeline, and the board runs the real Build handler on an in-memory Firestore with every other
// network call refused.
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
import { settleLeftOff, extraTruckM, FILL_RULE } from '../netlify/functions/lib/routing-fill-leftover.mts';

const D = '2026-10-01';
const dock = { lat: DEPOT.lat, lng: DEPOT.lng };
const hav = (a, b) => {
  const R = 6371000, t = (d) => (d * Math.PI) / 180;
  const dl = t(b.lat - a.lat), dn = t(b.lng - a.lng);
  const s = Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const box = (id, maxSkids = 14, maxWeightLbs = 10000) => ({ id, label: id, maxSkids, maxWeightLbs, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true } });
const tractor = (id, maxSkids = 28) => ({ id, label: id, maxSkids, maxWeightLbs: 30000, deckLengthIn: 636, capabilities: { liftgate: false, tractor: true, lengthClassFt: 53, overheadClearance: true } });

// ── Chad's 2026-09-30 board ────────────────────────────────────────────────────────────────────
const TOWN = { CARTERSVILLE: [34.1651, -84.7999], WHITE: [34.2832, -84.7466], RYDAL: [34.3354, -84.7163], ADAIRSVILLE: [34.3687, -84.9341], CALHOUN: [34.5026, -84.9511], DALTON: [34.7698, -84.9702] };
const S = (stopNbr, name, town, sk, loose, lb, group) => ({ stopNbr, name, town, sk, loose, lb, group });
const STOPS = [
  S('007184761', 'AROMATIC FRAGRANCE', 'CARTERSVILLE', 1, 0, 230, 'CHE'), S('007184565', 'POLYVENTIVE', 'CALHOUN', 1, 0, 230, 'CHE'),
  S('007185127', 'TRINSEO', 'DALTON', 1, 0, 230, 'CHE'), S('007184818', 'ESSENTIA PROTEIN SOL', 'DALTON', 1, 0, 230, 'CHE'),
  S('007184825', 'PRECISION PRODUCTS', 'DALTON', 1, 1, 230, 'CHE'), S('007184756', 'BCF PHELPS MFG', 'DALTON', 1, 0, 230, 'CHE'),
  S('007184627', 'IVC US STOCK ROOM', 'DALTON', 1, 0, 230, 'CHE'), S('007184812', 'RE CARROLL INC', 'DALTON', 1, 0, 230, 'CHE'),
  S('007184542', 'ADVANCED ADHESIVE', 'DALTON', 1, 0, 230, 'CHE'), S('007184548', 'FLOOR PRODUCTIONS', 'DALTON', 0, 4, 216, 'CHE'),
  S('007184686', 'HANWHA Q CELLS', 'WHITE', 1, 0, 415, 'SCOTT'), S('007184743', 'ATKORE', 'WHITE', 2, 0, 420, 'SCOTT'),
  S('007184512', 'DBM FACILITY SOLUTIONS', 'CARTERSVILLE', 1, 0, 415, 'SCOTT'), S('007184677', 'NEW STAR ADHESIVES', 'CARTERSVILLE', 1, 0, 415, 'SCOTT'),
  S('007184601', 'EROSION COMPANY', 'CARTERSVILLE', 1, 0, 415, 'SCOTT'), S('007185082', 'PULSE CENTERS', 'CARTERSVILLE', 1, 0, 415, 'SCOTT'),
  S('007184771', 'OAK VALLEY DESIGNS', 'CARTERSVILLE', 1, 0, 415, 'SCOTT'), S('007184883', 'PHOENIX AIR GROUP', 'CARTERSVILLE', 1, 0, 435, 'SCOTT'),
  S('007184613', 'TRENDSPOT INC', 'CARTERSVILLE', 1, 3, 620, 'TRAILER 1'), S('007184918', 'AQUAFIL USA', 'CARTERSVILLE', 1, 1, 620, 'TRAILER 1'),
  S('007185090', 'GRAY CONSTRUCTION', 'WHITE', 1, 0, 620, 'TRAILER 1'), S('007184578', 'MORGAN TRUCK BODY', 'RYDAL', 1, 0, 620, 'TRAILER 1'),
  S('007184903', 'VANDERLANDE INDUSTRIES', 'WHITE', 1, 0, 620, 'TRAILER 1'), S('007184947', 'VANDERLANDE INDUSTRIES 2', 'WHITE', 2, 0, 620, 'TRAILER 1'),
  S('007184574', 'HANWHA ADVANCED MAT', 'WHITE', 1, 0, 620, 'TRAILER 1'), S('007185047', 'VOESTALPINE AUTO', 'WHITE', 1, 1, 620, 'TRAILER 1'),
  S('007184829', 'ERNESTA HOME INC', 'WHITE', 2, 0, 620, 'TRAILER 1'), S('007184989', 'ASTA AMERICA', 'CARTERSVILLE', 3, 0, 620, 'TRAILER 1'),
  S('007184805', 'VISTA METALS GEORGIA', 'ADAIRSVILLE', 1, 0, 620, 'TRAILER 1'), S('007184641', 'EAE USA', 'ADAIRSVILLE', 7, 0, 620, 'TRAILER 1'),
  S('R_T13', 'CFL USA (below fold)', 'CARTERSVILLE', 1, 1, 620, 'TRAILER 1'), S('R_T14', '(below fold)', 'CARTERSVILLE', 1, 0, 620, 'TRAILER 1'),
  S('R_T15', '(below fold)', 'WHITE', 1, 0, 620, 'TRAILER 1'), S('R_T16', '(below fold)', 'WHITE', 1, 0, 600, 'TRAILER 1'),
  S('R_T17', '(below fold)', 'ADAIRSVILLE', 1, 0, 600, 'TRAILER 1'), S('R_T18', '(below fold)', 'CARTERSVILLE', 1, 0, 612, 'TRAILER 1'),
  // the six his Selected panel shows left off ("Drop 6 non-tractor · leaves 0 a tractor can run")
  S('007184673', 'GREIF PACKAGING', 'DALTON', 1, 0, 272, 'OFF'), S('007184708', 'FIELDTURF USA', 'CALHOUN', 0, 1, 23, 'OFF'),
  S('007184862', 'CHARLES CAMPBELL', 'DALTON', 1, 0, 106, 'OFF'), S('007184962', 'AG PRO', 'DALTON', 1, 0, 153, 'OFF'),
  S('007185015', 'NORTH GEORGIA EMC', 'DALTON', 1, 0, 77, 'OFF'), S('007185025', 'SUNDAY C/O ENCORE', 'CARTERSVILLE', 6, 0, 2724, 'OFF'),
];
const CHADS_SIX = STOPS.filter((s) => s.group === 'OFF').map((s) => s.stopNbr).sort();
// The cards prove CHE's and TRAILER 1's stops are green (only green on a 53′); the panel says the six are not.
const GREEN = new Set(STOPS.filter((s) => s.group === 'CHE' || s.group === 'TRAILER 1').map((s) => s.stopNbr));
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function placed(seed, R = 4) {
  const r = rng(seed);
  return STOPS.map((s) => { const [la, ln] = TOWN[s.town]; const ang = r() * 2 * Math.PI, d = Math.sqrt(r()) * R; return { ...s, lat: la + (d / 111) * Math.cos(ang), lng: ln + (d / 92) * Math.sin(ang) }; });
}
const TRUCKS = [tractor('CHE'), box('SCOTT'), tractor('TRAILER 1')];

async function boardBuild({ seed = 7, strategy = 'MIN_DISTANCE', env = {} } = {}) {
  const stops = placed(seed);
  const rows = stops.map((s, i) => ({ stopNbr: s.stopNbr, businessName: s.name, addr1: `${i} Industrial Dr`, city: s.town, zip: '30120', lat: s.lat, lng: s.lng,
    cartons: s.sk, pallets: s.sk, weight: s.lb, weightUOM: 'LB', isUnplanned: true, stopDetails: [] }));
  const request = { tenant: 'davis', date: D, selectedStopIds: rows.map((r) => r.stopNbr), trucks: TRUCKS, plannedLoads: TRUCKS.map((t) => ({ key: t.id })),
    strategy, matrixMode: 'haversine', tractorOnlyGreen: true, windowMode: 'advisory', panelGreenStopIds: [...GREEN] };
  const seedDocs = { [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D }, 'routing_jobs/job_fill': { id: 'job_fill', status: 'queued', request } };
  for (const r of rows) seedDocs[`nuvizz_stop_index/davis__${D}/stops/${r.stopNbr}`] = r;
  const saved = { ROUTING_BUILD_FILL_TRUCKS: process.env.ROUTING_BUILD_FILL_TRUCKS, ROUTING_BUILD_LEAVE_OFF_ENDS: process.env.ROUTING_BUILD_LEAVE_OFF_ENDS };
  delete process.env.ROUTING_BUILD_FILL_TRUCKS; delete process.env.ROUTING_BUILD_LEAVE_OFF_ENDS;
  Object.assign(process.env, env);
  const fake = installFirestoreFake(seedDocs);
  try {
    const res = await routingBuild(new Request('https://x.test/.netlify/functions/routing-build-background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job_fill' }) }));
    assert.equal(res.status, 202);
    const job = fake.store.get('routing_jobs/job_fill');
    assert.equal(job.status, 'done', job.error);
    return { r: job.result, stops };
  } finally {
    fake.restore();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const skidsOn = (r, stops, truckId) => {
  const by = new Map(stops.map((s) => [s.stopNbr, s]));
  return (r.routes.find((x) => x.truckId === truckId)?.orderedStopIds || []).reduce((a, id) => a + by.get(id).sk, 0);
};
// a truck that could still take a listed stop it is allowed to carry (skids AND pounds)
function roomWhileListed(r, stops) {
  const by = new Map(stops.map((s) => [s.stopNbr, s]));
  const out = [];
  for (const u of r.unassigned) {
    const s = by.get(u.stopId);
    for (const t of TRUCKS) {
      if (t.capabilities.tractor && !GREEN.has(s.stopNbr)) continue;
      const ids = r.routes.find((x) => x.truckId === t.id)?.orderedStopIds || [];
      const sk = ids.reduce((a, id) => a + by.get(id).sk, 0), lb = ids.reduce((a, id) => a + by.get(id).lb, 0);
      if (sk + s.sk <= t.maxSkids && lb + s.lb <= t.maxWeightLbs) { out.push(`${s.name} fits ${t.id}`); break; }
    }
  }
  return out;
}
const spreadKm = (pts) => (pts.length > 1 ? Math.max(...pts.flatMap((a) => pts.map((b) => hav(a, b)))) / 1000 : 0);
// AREAS, as the rule defines them: stops chained within 15 km of each other
function areas(pts) {
  const seen = new Set(); let n = 0;
  for (const p0 of pts) { if (seen.has(p0)) continue; n++; seen.add(p0); const q = [p0]; while (q.length) { const x = q.pop(); for (const y of pts) if (!seen.has(y) && hav(x, y) < 15000) { seen.add(y); q.push(y); } } }
  return n;
}

test('the switch has the house shape: on by default, an off-word turns it off, a typo leaves it ON', () => {
  assert.equal(buildRules({}).fillTrucks, true);
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' No ']) assert.equal(buildRules({ ROUTING_BUILD_FILL_TRUCKS: off }).fillTrucks, false, off);
  for (const on of ['of', 'on', 'yes', '1', 'maybe', '']) assert.equal(buildRules({ ROUTING_BUILD_FILL_TRUCKS: on }).fillTrucks, true, on);
  // a step of the ends rule: with that off it cannot run, and the result must not say it did
  assert.equal(buildRules({ ROUTING_BUILD_LEAVE_OFF_ENDS: 'off' }).fillTrucks, false);
});

test('CHAD\'S 09-30 BOARD, AS IT WAS (switched off): the same six left off in three towns, SCOTT stopped at 9 of 14 — his screen, order for order', async () => {
  const { r, stops } = await boardBuild({ env: { ROUTING_BUILD_FILL_TRUCKS: 'off' } });
  assert.equal(r.buildRules.fillTrucks, false);
  assert.deepEqual(r.unassigned.map((u) => u.stopId).sort(), CHADS_SIX, 'the six on his Selected panel');
  assert.equal(skidsOn(r, stops, 'CHE'), 9);
  assert.equal(skidsOn(r, stops, 'SCOTT'), 9, 'SCOTT, the only box, at 9 of 14');
  assert.equal(skidsOn(r, stops, 'TRAILER 1'), 28, 'TRAILER 1 the only one full');
  assert.equal(new Set(r.unassigned.map((u) => stops.find((s) => s.stopNbr === u.stopId).town)).size, 3, 'Dalton, Calhoun and Cartersville');
  assert.ok(roomWhileListed(r, stops).length > 0, 'and SCOTT had room for orders it left off');
  assert.equal(r.meta.leftOffGroup, null);
});

for (const strategy of ['MIN_DISTANCE', 'FARTHEST_FIRST', 'CLOSEST_FIRST']) {
  test(`CHAD'S 09-30 BOARD, NOW (${strategy}): SCOTT is full, no truck with room leaves a stop it may carry, and what is left off is one area — the run one more truck would make`, async () => {
    const { r, stops } = await boardBuild({ strategy });
    const by = new Map(stops.map((s) => [s.stopNbr, s]));
    assert.equal(r.buildRules.fillTrucks, true, 'the result says the rule ran');
    assert.equal(skidsOn(r, stops, 'SCOTT'), 14, 'the box stops at 14 skids');
    assert.deepEqual(roomWhileListed(r, stops), [], 'nothing listed that a truck with room may carry');
    // nothing that is not green rides a 53′ (the hard rule the step works under)
    for (const t of ['CHE', 'TRAILER 1']) for (const id of r.routes.find((x) => x.truckId === t)?.orderedStopIds || []) assert.ok(GREEN.has(id), `${id} on ${t} is green`);
    const tractorMi = (res) => ['CHE', 'TRAILER 1'].reduce((a, t) => a + (res.routes.find((x) => x.truckId === t)?.legs || []).reduce((b, l) => b + l.distanceMeters, 0), 0);
    const off = r.unassigned.map((u) => by.get(u.stopId));
    assert.ok(off.length > 0, 'the freight is more than the trucks: something is left off');
    for (const s of off) assert.ok(!GREEN.has(s.stopNbr), `${s.name} left off is box-only (CHE has room for anything green)`);
    assert.equal(areas(off), 1, `what is left off is one area: ${off.map((s) => `${s.name} (${s.town})`).join(', ')} — ${spreadKm(off).toFixed(1)} km across`);
    for (const u of r.unassigned) assert.ok(u.reasons.length && u.reasons.every((x) => x.trim()), `${u.stopId} says why`);
    // the one more truck it implies drives less than the one his screen implied
    const before = await boardBuild({ strategy, env: { ROUTING_BUILD_FILL_TRUCKS: 'off' } });
    const extra = (res) => extraTruckM(res.r.unassigned.map((u) => ({ ...by.get(u.stopId), id: u.stopId })), dock);
    assert.ok(extra({ r }) < extra(before) - 50000, `the extra truck: ${Math.round(extra(before) / 1000)} km → ${Math.round(extra({ r }) / 1000)} km`);
    assert.ok(tractorMi(r) <= tractorMi(before.r) + 1000, `the two 53′s drive no more than before: ${Math.round(tractorMi(before.r) / 1000)} → ${Math.round(tractorMi(r) / 1000)} km`);
    assert.ok(r.meta.leftOffGroup && r.meta.leftOffGroup.moves > 0 && r.meta.leftOffGroup.leftOffStops === r.unassigned.length, 'the job says what the step did');
    assert.equal(r.meta.leftOffGroup.leftOffAreas, 1, 'and that what is left off is one area');
  });
}

test('ON 120 PLACEMENTS OF THE SAME 42 STOPS: never a truck with room while a stop it may carry is listed, SCOTT always at 14, and what is left off is always one area', async () => {
  let room = 0, split = 0, runs = 0, scattered = 0, light = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const strategy of ['MIN_DISTANCE', 'FARTHEST_FIRST', 'CLOSEST_FIRST']) {
      const stops = placed(seed);
      const p = await runPipeline({ stops: stops.map((s) => ({ stopNbr: s.stopNbr, lat: s.lat, lng: s.lng, ...buildFreightFields({ cartons: s.sk, pallets: s.sk, weight: s.lb, weightUOM: 'LB', stopDetails: [] }, { countSkids: true }),
        equipmentReqs: equipmentReqsFrom(null, { tractorOnlyGreen: true, panelGreen: GREEN.has(s.stopNbr) }) })), trucks: TRUCKS, depot: dock, strategy, date: D, matrixMode: 'haversine', windowMode: 'advisory', leaveOffEnds: true, fillTrucks: true },
      { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
      runs++;
      if (roomWhileListed(p, stops).length) room++;
      const off = p.unassigned.map((u) => stops.find((s) => s.stopNbr === u.stopId));
      const towns = new Set(off.map((s) => s.town));
      if ((towns.has('DALTON') || towns.has('CALHOUN')) && (towns.has('CARTERSVILLE') || towns.has('WHITE'))) split++;
      if (areas(off) > 1) scattered++;
      if (skidsOn(p, stops, 'SCOTT') !== 14) light++;
    }
  }
  assert.equal(room, 0, `${room} of ${runs} runs left a stop off that a truck with room may carry`);
  assert.equal(scattered, 0, `${scattered} of ${runs} runs left off stops in two or more areas`);
  assert.equal(light, 0, `${light} of ${runs} runs left SCOTT below 14`);
  assert.equal(split, 0, `${split} of ${runs} runs left stops off both up in Dalton/Calhoun and down in Cartersville/White`);
});

// ── the step on its own (lib/routing-fill-leftover.mts) ─────────────────────────────────────────
const P = (id, lat, lng, skids = 1, weightLbs = 300, reqs = []) => ({ id, lat, lng, skids, weightLbs, linearFeetIn: 0, serviceMin: 15, equipmentReqs: reqs });
const town = (tag, lat, lng, n, skids = 1, reqs = []) => Array.from({ length: n }, (_, i) => P(`${tag}${String(i).padStart(2, '0')}`, lat + ((i * 37) % 11 - 5) * 0.003, lng + ((i * 53) % 11 - 5) * 0.003, skids, 300, reqs));
const sk = (xs) => xs.reduce((a, s) => a + s.skids, 0);

test('FILL: a truck with room takes a stop that was left off, even out of its way — it is not left for another truck', () => {
  const A = town('A', 34.30, -84.40, 10);
  const far = P('FAR', 34.62, -84.95);   // ~60 km past the town
  const r = settleLeftOff(new Map([['BOX', A]]), [far], [box('BOX', 14)], dock);
  assert.deepEqual(r.leftOff, []);
  assert.equal(r.byTruck.get('BOX').length, 11);
  assert.ok(r.costAfterM < r.costBeforeM);
});

test('WHOLE SKIDS: a 6-skid order goes on in place of five 1-skid ones, so the box ends at 14, not 13', () => {
  const A = town('A', 34.30, -84.40, 13);   // 13 one-skid stops on a 14-skid box
  const big = P('BIG', 34.301, -84.401, 6, 2724);
  const r = settleLeftOff(new Map([['BOX', A]]), [big], [box('BOX', 14)], dock);
  assert.equal(sk(r.byTruck.get('BOX')), 14);
  assert.ok(r.byTruck.get('BOX').includes(big));
  assert.equal(sk(r.leftOff), 5);
});

test('EJECT: a green stop on the box moves to the tractor with room, so a box-only stop left off fits the box', () => {
  const boxOnly = ['box_truck_only'];
  const onBox = [...town('B', 34.30, -84.40, 7, 1, boxOnly), P('G0', 34.302, -84.402)];
  const onTrl = town('T', 34.31, -84.41, 4);
  const left = P('L0', 34.303, -84.399, 1, 300, boxOnly);
  const r = settleLeftOff(new Map([['BOX', onBox], ['TRL', onTrl]]), [left], [box('BOX', 8), tractor('TRL')], dock);
  assert.deepEqual(r.leftOff, []);
  assert.ok(r.byTruck.get('BOX').includes(left), 'the box-only stop is on the box');
  assert.ok(r.byTruck.get('TRL').some((s) => s.id === 'G0'), 'the green one moved to the tractor');
  for (const s of r.byTruck.get('TRL')) assert.ok(!s.equipmentReqs.includes('box_truck_only'), `${s.id} on the tractor is not box-only`);
});

test('ONE AREA: when the box must leave five skids off, they come off together in one town — not four up north and one down south', () => {
  const boxOnly = ['box_truck_only'];
  // south (Cartersville): 9 one-skid box-only stops; north (Dalton, 60 km up the road): 4. A 9-skid box.
  const south = town('S', 34.165, -84.80, 9, 1, boxOnly);
  const north = town('N', 34.77, -84.97, 4, 1, boxOnly);
  // start from the split answer: the box runs the south but one, and one south + all north are left off
  const r = settleLeftOff(new Map([['BOX', south.slice(0, 8)]]), [south[8], ...north], [box('BOX', 9)], dock);
  assert.equal(sk(r.byTruck.get('BOX')), 9, 'the box is still full');
  assert.equal(r.leftOff.length, 4);
  assert.ok(spreadKm(r.leftOff) < 15, `left off together: ${r.leftOff.map((s) => s.id).join(',')}`);
  assert.ok(r.costAfterM < r.costBeforeM);
});

test('STOPS NO TRUCK CAN CARRY never move, and what else is left off gathers round them', () => {
  // a 10-skid tractor, 6 one-skid stops in each of two towns 50 km apart, and a liftgate stop no
  // truck here can carry in the first town: the extra truck goes there anyway, so that is where
  // the two skids that do not fit come off — starting from the plan that left them in the other town
  const lift = P('LIFT', 34.60, -84.20, 1, 300, ['liftgate_required']);
  const tp = town('P', 34.60, -84.20, 6), tq = town('Q', 34.25, -84.70, 6);
  const r = settleLeftOff(new Map([['TRL', [...tp, ...tq.slice(0, 4)]]]), [tq[4], tq[5]], [tractor('TRL', 10)], dock, [lift]);
  assert.ok(!r.leftOff.includes(lift), 'a pinned stop is not returned as movable');
  assert.ok(![...r.byTruck.values()].flat().includes(lift), 'and is never put on a truck that cannot carry it');
  assert.equal(r.leftOff.length, 2);
  for (const s of r.leftOff) assert.ok(s.id.startsWith('P'), `${s.id} is left off beside the liftgate stop`);
  assert.equal(r.leftOffAreas, 1, 'one area, the pinned stop included');
});

test('MAKE ROOM: green freight on the box moves to a tractor, which hands its own on to the other tractor, so the box-only order left off goes on the box — every truck full', () => {
  const bo = ['box_truck_only'];
  // box 8: a 6-skid green order and two 1-skid box-only; tractor T1 7 (4 green, room 3); T2 5 (2 green, room 3)
  const B = [P('G6', 34.30, -84.40, 6), P('b1', 34.301, -84.401, 1, 300, bo), P('b2', 34.302, -84.399, 1, 300, bo)];
  const T1 = town('g', 34.305, -84.405, 4), T2 = [P('g5', 34.298, -84.402), P('g6', 34.299, -84.398)];
  const L6 = P('L6', 34.303, -84.403, 6, 900, bo);
  const r = settleLeftOff(new Map([['B', B], ['T1', T1], ['T2', T2]]), [L6], [box('B', 8), tractor('T1', 7), tractor('T2', 5)], dock);
  assert.deepEqual(r.leftOff, [], 'nothing left off');
  assert.ok(r.byTruck.get('B').includes(L6), 'the box-only order is on the box');
  assert.equal(sk(r.byTruck.get('B')), 8); assert.equal(sk(r.byTruck.get('T1')), 7); assert.equal(sk(r.byTruck.get('T2')), 5);
  for (const t of ['T1', 'T2']) for (const s of r.byTruck.get(t)) assert.ok(!s.equipmentReqs.includes('box_truck_only'), `${s.id} on ${t} is green`);
});

test('NO TRIP FOR A CARTON: a 53′ does not drive to a far town for one loose-only order the extra truck is going there for anyway', () => {
  // the extra truck must go to Dalton (a liftgate stop no truck here can carry); a loose carton sits
  // beside it. The tractor works 80 km away with all the room in the world.
  const pin = P('FARLIFT', 34.771, -84.971, 1, 300, ['liftgate_required']);
  const carton = P('CARTON', 34.77, -84.97, 0, 40);
  const r = settleLeftOff(new Map([['TRL', town('H', 34.05, -84.10, 5)]]), [carton], [tractor('TRL', 28)], dock, [pin]);
  assert.deepEqual(r.leftOff.map((s) => s.id), ['CARTON'], 'the carton rides with the extra truck');
});

test('NEXT DOOR: a box does not drive to Dalton for one order while the extra truck goes there for the other four', () => {
  // 13 one-skid box-only orders in Cartersville, 5 in Dalton (69 km on), a 14-skid box
  const bo = ['box_truck_only'];
  const C = town('C', 34.165, -84.80, 13, 1, bo), Dl = town('D', 34.77, -84.97, 5, 1, bo);
  // start from the plan that did exactly that: the box with all of Cartersville and one Dalton order
  const r = settleLeftOff(new Map([['BOX', [...C, Dl[0]]]]), Dl.slice(1), [box('BOX', 14)], dock);
  const boxTowns = new Set(r.byTruck.get('BOX').map((s) => s.id[0])), leftTowns = new Set(r.leftOff.map((s) => s.id[0]));
  assert.equal(sk(r.byTruck.get('BOX')), 14, 'the box is still full');
  assert.ok(!(boxTowns.has('D') && leftTowns.has('D')), `the box and the extra truck do not both go to Dalton: box ${[...boxTowns]}, left off ${[...leftTowns]}`);
  assert.equal(r.leftOffAreas, 1);
});

// ── windows and the day: the step asks routing-repair what the shipped run would be ───────────
test('WINDOWS (strict): a stop the shipped run would reach after its close stays off the truck — it would only be taken off again', () => {
  const A = town('A', 34.30, -84.40, 5), X = P('X', 34.302, -84.401);
  const late = (stops) => ({ excessM: 0, late: stops.filter((s) => s.id === 'X'), overDaySec: 0 });
  const strict = settleLeftOff(new Map([['BOX', A]]), [X], [box('BOX', 14)], dock, [], { windowCost: late, strict: true });
  assert.deepEqual(strict.leftOff.map((s) => s.id), ['X']);
  const none = settleLeftOff(new Map([['BOX', A]]), [X], [box('BOX', 14)], dock, []);
  assert.deepEqual(none.leftOff, [], 'without the window it goes on');
});

test('WINDOWS: the extra driving a window order costs counts — a stop that would bend the run 400 km is not taken for one skid', () => {
  const A = town('A', 34.30, -84.40, 5), X = P('X', 34.302, -84.401);
  const bend = (stops) => ({ excessM: stops.some((s) => s.id === 'X') ? 400000 : 0, late: [], overDaySec: 0 });
  const r = settleLeftOff(new Map([['BOX', A]]), [X], [box('BOX', 14)], dock, [], { windowCost: bend });
  assert.deepEqual(r.leftOff.map((s) => s.id), ['X']);
});

test('THE DAY: a truck does not take an order that keeps its driver three hours past the day', () => {
  const A = town('A', 34.30, -84.40, 5), X = P('X', 34.302, -84.401);
  const longDay = (stops) => ({ excessM: 0, late: [], overDaySec: stops.some((s) => s.id === 'X') ? 3 * 3600 : 0 });
  const r = settleLeftOff(new Map([['BOX', A]]), [X], [box('BOX', 14)], dock, [], { windowCost: longDay });
  assert.deepEqual(r.leftOff.map((s) => s.id), ['X']);
});

test('CHAD\'S BOARD WITH A 1–2 PM APPOINTMENT ON SUNDAY C/O ENCORE (advisory): the box still fills, meets it, is done by 6 PM on every placement, and the appointment bends its run by tens of km, not hundreds', async () => {
  // The first version planned on straight tours and shipped the window order: the box averaged
  // 485 km against 265 and finished after 6 PM on a third of placements.
  const sunday = '007185025';
  let after6 = 0, light = 0, late = 0, runs = 0, bend = 0;
  const scottKm = (p) => (p.routes.find((x) => x.truckId === 'SCOTT')?.legs || []).reduce((a, l) => a + l.distanceMeters, 0) / 1000;
  for (let seed = 1; seed <= 15; seed++) {
    for (const strategy of ['MIN_DISTANCE', 'FARTHEST_FIRST', 'CLOSEST_FIRST']) {
      const stops = placed(seed);
      const build = (withWindow) => runPipeline({ stops: stops.map((s) => ({ stopNbr: s.stopNbr, lat: s.lat, lng: s.lng, ...buildFreightFields({ cartons: s.sk, pallets: s.sk, weight: s.lb, weightUOM: 'LB', stopDetails: [] }, { countSkids: true }),
        equipmentReqs: equipmentReqsFrom(null, { tractorOnlyGreen: true, panelGreen: GREEN.has(s.stopNbr) }),
        ...(withWindow && s.stopNbr === sunday ? { timeRestriction: { openMin: 780, closeMin: 840, closedToday: false, sources: ['test'], label: '1:00p–2:00p' } } : {}) })),
        trucks: TRUCKS, depot: dock, strategy, date: D, matrixMode: 'haversine', windowMode: 'advisory', leaveOffEnds: true, fillTrucks: true },
      { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
      const p = await build(true), plain = await build(false);
      runs++;
      const scott = p.routes.find((x) => x.truckId === 'SCOTT');
      bend += scottKm(p) - scottKm(plain);
      const lastHour = (scott.etas[scott.etas.length - 1] % 86400) / 3600;
      if (lastHour >= 18) after6++;
      if (skidsOn(p, stops, 'SCOTT') !== 14) light++;
      late += p.routes.reduce((a, r) => a + (r.windowViolatedIds || []).length, 0);
    }
  }
  assert.equal(after6, 0, `${after6} of ${runs} placements: SCOTT's last delivery after 6 PM`);
  assert.equal(late, 0, `${late} deliveries past their close`);
  assert.equal(light, 0, `${light} of ${runs}: SCOTT below 14`);
  // measured: 38 km on average (the window order keeps the strategy's order and slots the
  // appointment in — routing-repair's insertByWindow, which this step does not choose)
  assert.ok(bend / runs < 60, `the appointment adds ${(bend / runs).toFixed(1)} km to SCOTT's run on average`);
});

test('STRICT WINDOWS on Chad\'s board (Dalton orders due by noon, Sunday 1–2 PM): the box still ends at 14, no stop is carried late, and no more skids are left off than with the step off', async () => {
  // The first version filled the box with stops the window check then took off: SCOTT finished
  // below 14 where the Build without the step reached it, on 23 of 480 placements.
  const W = { '007184862': [420, 720], '007184962': [420, 720], '007185025': [780, 840] };
  let light = 0, worse = 0, runs = 0;
  for (let seed = 1; seed <= 10; seed++) {
    for (const strategy of ['MIN_DISTANCE', 'FARTHEST_FIRST', 'CLOSEST_FIRST']) {
      const stops = placed(seed);
      const build = (fillTrucks) => runPipeline({ stops: stops.map((s) => ({ stopNbr: s.stopNbr, lat: s.lat, lng: s.lng, ...buildFreightFields({ cartons: s.sk, pallets: s.sk, weight: s.lb, weightUOM: 'LB', stopDetails: [] }, { countSkids: true }),
        equipmentReqs: equipmentReqsFrom(null, { tractorOnlyGreen: true, panelGreen: GREEN.has(s.stopNbr) }),
        ...(W[s.stopNbr] ? { timeRestriction: { openMin: W[s.stopNbr][0], closeMin: W[s.stopNbr][1], closedToday: false, sources: ['test'], label: 'window' } } : {}) })),
        trucks: TRUCKS, depot: dock, strategy, date: D, matrixMode: 'haversine', windowMode: 'strict', leaveOffEnds: true, fillTrucks },
      { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
      const p = await build(true), off = await build(false);
      runs++;
      const offSk = (x) => x.unassigned.reduce((a, u) => a + stops.find((s) => s.stopNbr === u.stopId).sk, 0);
      if (skidsOn(p, stops, 'SCOTT') !== 14) light++;
      if (offSk(p) > offSk(off)) worse++;
      for (const r of p.routes) assert.deepEqual(r.windowViolatedIds || [], [], `${r.truckId}: nothing late on a strict Build`);
    }
  }
  assert.equal(light, 0, `${light} of ${runs}: SCOTT below 14`);
  assert.equal(worse, 0, `${worse} of ${runs}: more skids left off than with the step off`);
});

test('HARD RULES on 80 random overloaded boards (green rule on and off, both strategies): nothing lost or doubled, no truck over skids or pounds, nothing box-only on a tractor, the same answer twice — and never fewer skids carried than with the step off', async () => {
  let seed = 31337; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let skOn = 0, skOff = 0;
  for (let b = 0; b < 80; b++) {
    const trucks = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => (rnd() < 0.35 ? tractor(`T${i}`) : box(`B${i}`, 14, rnd() < 0.3 ? 6000 : 10000)));
    const cap = trucks.reduce((a, t) => a + t.maxSkids, 0);
    const centres = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => [34.15 + (rnd() - 0.3) * 0.8, -84.2 + (rnd() - 0.5) * 1.0]);
    const rows = []; let tot = 0;
    while (tot < cap * (1.1 + rnd() * 0.8)) {
      const [la, ln] = centres[Math.floor(rnd() * centres.length)];
      const c = rnd() < 0.65 ? 1 : (rnd() < 0.6 ? 2 : (rnd() < 0.5 ? 0 : 6));
      rows.push({ stopNbr: `X${rows.length}`, lat: la + (rnd() - 0.5) * 0.12, lng: ln + (rnd() - 0.5) * 0.12, cartons: c, weight: rnd() < 0.2 ? 2500 : 300 });
      tot += c;
    }
    const greenOnly = rnd() < 0.5;
    const green = new Set(rows.filter(() => rnd() < 0.4).map((r) => r.stopNbr));
    const strategy = rnd() < 0.5 ? 'FARTHEST_FIRST' : 'MIN_DISTANCE';
    const stops = rows.map((s) => ({ stopNbr: s.stopNbr, lat: s.lat, lng: s.lng, ...buildFreightFields({ cartons: s.cartons, pallets: s.cartons, weight: s.weight, weightUOM: 'LB', stopDetails: [] }, { countSkids: true }),
      equipmentReqs: equipmentReqsFrom(null, { tractorOnlyGreen: greenOnly, panelGreen: green.has(s.stopNbr) }) }));
    const run = (fillTrucks) => runPipeline({ stops, trucks, depot: dock, strategy, date: D, matrixMode: 'haversine', windowMode: 'advisory', leaveOffEnds: true, fillTrucks },
      { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
    const p = await run(true), again = await run(true), off = await run(false);
    assert.deepEqual(again.routes.map((r) => r.orderedStopIds), p.routes.map((r) => r.orderedStopIds), `board ${b}: deterministic`);
    assert.deepEqual(again.unassigned, p.unassigned, `board ${b}: deterministic`);
    const by = new Map(rows.map((r) => [r.stopNbr, r]));
    const seen = new Map();
    for (const r of p.routes) for (const id of r.orderedStopIds) seen.set(id, (seen.get(id) || 0) + 1);
    for (const u of p.unassigned) seen.set(u.stopId, (seen.get(u.stopId) || 0) + 1);
    for (const r of rows) assert.equal(seen.get(r.stopNbr), 1, `board ${b}: ${r.stopNbr} seen ${seen.get(r.stopNbr) || 0}x`);
    for (const r of p.routes) {
      const t = trucks.find((x) => x.id === r.truckId);
      assert.ok(r.orderedStopIds.reduce((a, id) => a + by.get(id).cartons, 0) <= t.maxSkids, `board ${b}: ${t.id} over skids`);
      assert.ok(r.orderedStopIds.reduce((a, id) => a + by.get(id).weight, 0) <= t.maxWeightLbs, `board ${b}: ${t.id} over pounds`);
      if (greenOnly && t.capabilities.tractor) for (const id of r.orderedStopIds) assert.ok(green.has(id), `board ${b}: box-only ${id} on ${t.id}`);
    }
    for (const u of p.unassigned) assert.ok(u.reasons.length > 0 && u.reasons.every((x) => x.trim()), `board ${b}: ${u.stopId} says why`);
    const carried = (x) => x.routes.reduce((a, r) => a + r.orderedStopIds.reduce((c, id) => c + by.get(id).cartons, 0), 0);
    skOn += carried(p); skOff += carried(off);
  }
  assert.ok(skOn >= skOff, `skids carried: ${skOff} with the step off → ${skOn} on`);
});

test('A BOARD THE ENDS RULE PLANS WITHOUT LEAVING ANYTHING OFF is unchanged: the step does not run', async () => {
  const stops = town('A', 34.30, -84.40, 10).map((s) => ({ stopNbr: s.id, lat: s.lat, lng: s.lng, ...buildFreightFields({ cartons: 1, pallets: 1, weight: 300, weightUOM: 'LB', stopDetails: [] }, { countSkids: true }), equipmentReqs: [] }));
  const run = (fillTrucks) => runPipeline({ stops, trucks: [box('B1'), box('B2')], depot: dock, strategy: 'MIN_DISTANCE', date: D, matrixMode: 'haversine', windowMode: 'advisory', leaveOffEnds: true, fillTrucks },
    { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
  const on = await run(true), off = await run(false);
  assert.deepEqual(on.routes.map((r) => [r.truckId, r.orderedStopIds]), off.routes.map((r) => [r.truckId, r.orderedStopIds]));
  assert.equal(on.meta.leftOffGroup, null);
  assert.equal(on.meta.fillTrucks, true);
});

test('THE WIRING: the Build passes the switch to the pipeline, the pipeline to the solver, the solver to the ends rule', () => {
  const bg = readFileSync(new URL('../netlify/functions/routing-build-background.mts', import.meta.url), 'utf8');
  assert.match(bg, /fillTrucks: rules\.fillTrucks,/);
  const pipe = readFileSync(new URL('../netlify/functions/lib/routing-pipeline.mts', import.meta.url), 'utf8');
  assert.match(pipe, /fillTrucks: req\.fillTrucks === true,/);
  const solver = readFileSync(new URL('../netlify/functions/lib/routing-solver.mts', import.meta.url), 'utf8');
  assert.match(pipe, /windowCost: windowCostFor\(solverInput, FILL_RULE\.DAY_HOURS\)/, 'the pipeline hands the solver the shipped-run cost');
  assert.match(solver, /\{ fillTrucks: input\.fillTrucks === true, windowCost: opts\?\.windowCost, strictWindows: input\.windowMode === 'strict' \}/);
  const ends = readFileSync(new URL('../netlify/functions/lib/routing-assign-ends.mts', import.meta.url), 'utf8');
  assert.match(ends, /if \(opts\?\.fillTrucks && leftOff\.length\)/);
  assert.match(ends, /settleLeftOff\(byTruck, leftOff, trucks, depot, noTruck, \{ windowCost: opts\.windowCost, strict: opts\.strictWindows === true \}\)/);
  for (const k of ['SKID_KM', 'AREA_PENALTY_KM', 'HOLE_KM', 'OVER_DAY_KM_PER_HOUR', 'ADVISORY_LATE_KM']) assert.ok(FILL_RULE[k] > 0, k);
});
