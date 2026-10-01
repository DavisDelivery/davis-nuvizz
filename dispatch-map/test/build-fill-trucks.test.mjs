// test/build-fill-trucks.test.mjs — A TRUCK WITH ROOM TAKES A WHOLE GROUP OF THE ORDERS LEFT OFF
// (routing-assign-ends step 6, ROUTING_BUILD_FILL_TRUCKS).
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
import { assignLeavingOffEnds } from '../netlify/functions/lib/routing-assign-ends.mts';

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

const DALTON_FOUR = STOPS.filter((s) => s.group === 'OFF' && s.town === 'DALTON').map((s) => s.stopNbr).sort();
const SUNDAY = '007185025', FIELDTURF = '007184708';
const pipeStop = (s, reqs = []) => ({ stopNbr: s.stopNbr, lat: s.lat, lng: s.lng, ...buildFreightFields({ cartons: s.sk, pallets: s.sk, weight: s.lb, weightUOM: 'LB', stopDetails: [] }, { countSkids: true }), equipmentReqs: reqs, ...(s.tr ? { timeRestriction: s.tr } : {}) });
const boardStops = (stops) => stops.map((s) => pipeStop(s, equipmentReqsFrom(null, { tractorOnlyGreen: true, panelGreen: GREEN.has(s.stopNbr) })));
const pipe = (stops, trucks, { strategy = 'MIN_DISTANCE', fillTrucks = true, windowMode = 'advisory' } = {}) => runPipeline({ stops, trucks, depot: dock, strategy, date: D, matrixMode: 'haversine', windowMode, leaveOffEnds: true, fillTrucks },
  { buildMatrix: async (d, pts) => resolveMatrix(d, pts, 'haversine') });
const onTruck = (p) => new Map(p.routes.flatMap((r) => r.orderedStopIds.map((id) => [id, r.truckId])));

test('the switch has the house shape: on by default, an off-word turns it off, a typo leaves it ON — and it is off whenever the ends rule is', () => {
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
  assert.equal(r.meta.groupFill, null);
});

for (const strategy of ['MIN_DISTANCE', 'FARTHEST_FIRST', 'CLOSEST_FIRST']) {
  test(`CHAD'S 09-30 BOARD, NOW (${strategy}): SCOTT takes the four Dalton orders together, and the Calhoun carton on its way — only Sunday c/o Encore's 6 pallets are left off, because they do not fit`, async () => {
    const { r, stops } = await boardBuild({ strategy });
    assert.equal(r.buildRules.fillTrucks, true, 'the result says the rule ran');
    const scott = new Set(r.routes.find((x) => x.truckId === 'SCOTT').orderedStopIds);
    for (const id of [...DALTON_FOUR, FIELDTURF]) assert.ok(scott.has(id), `${stops.find((s) => s.stopNbr === id).name} is on SCOTT`);
    assert.equal(skidsOn(r, stops, 'SCOTT'), 13);
    assert.deepEqual(r.unassigned.map((u) => u.stopId), [SUNDAY], 'one order left off');
    assert.ok(r.unassigned[0].reasons.some((x) => /over skid capacity/.test(x)), `and it says why: ${r.unassigned[0].reasons.join('; ')}`);
    assert.deepEqual(r.meta.groupFill.taken.map((t) => [t.truckId, [...t.stopIds].sort()]), [['SCOTT', DALTON_FOUR]], 'the job says which group went on which truck');
    // what the switched-off Build carried is still carried, on the same truck
    const before = await boardBuild({ strategy, env: { ROUTING_BUILD_FILL_TRUCKS: 'off' } });
    const was = new Map(before.r.routes.flatMap((x) => x.orderedStopIds.map((id) => [id, x.truckId]))), now = new Map(r.routes.flatMap((x) => x.orderedStopIds.map((id) => [id, x.truckId])));
    for (const [id, t] of was) assert.equal(now.get(id), t, `${id} stays on ${t}`);
  });
}

test('ON 120 PLACEMENTS OF THE SAME 42 STOPS: nothing the old Build carried is left off, never fewer skids — and wherever SCOTT had room for the four Dalton orders, it now carries them', async () => {
  let roomy = 0, carried = 0, runs = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const strategy of ['MIN_DISTANCE', 'FARTHEST_FIRST', 'CLOSEST_FIRST']) {
      const stops = placed(seed);
      const on = await pipe(boardStops(stops), TRUCKS, { strategy }), off = await pipe(boardStops(stops), TRUCKS, { strategy, fillTrucks: false });
      runs++;
      const offLeft = new Set(off.unassigned.map((u) => u.stopId));
      for (const u of on.unassigned) assert.ok(offLeft.has(u.stopId), `seed ${seed} ${strategy}: ${u.stopId} was carried before and is left off now`);
      const sk = (p) => p.routes.reduce((a, x) => a + skidsOn(p, stops, x.truckId), 0);
      assert.ok(sk(on) >= sk(off), `seed ${seed} ${strategy}: skids ${sk(off)} → ${sk(on)}`);
      if (DALTON_FOUR.every((id) => offLeft.has(id)) && 14 - skidsOn(off, stops, 'SCOTT') >= 4) {
        roomy++;
        const scott = new Set(on.routes.find((x) => x.truckId === 'SCOTT').orderedStopIds);
        if (DALTON_FOUR.every((id) => scott.has(id))) carried++;
      }
    }
  }
  assert.ok(roomy > 0, 'some placements give SCOTT room for the group');
  assert.equal(carried, roomy, `SCOTT carries the Dalton group on ${carried} of the ${roomy} placements that give it room`);
});

// ── the rule's edges, on small boards through the real pipeline ─────────────────────────────────
const at = (id, lat, lng, sk = 1) => ({ stopNbr: id, lat, lng, sk, lb: 300 });
const near = (tag, lat, lng, n, sk = 1) => Array.from({ length: n }, (_, i) => at(`${tag}${String(i).padStart(2, '0')}`, lat + ((i * 37) % 11 - 5) * 0.003, lng + ((i * 53) % 11 - 5) * 0.003, sk));
const BOX_ONLY = ['box_truck_only'];

// Chad's shape on a small board: a box's town (Cartersville, 9 × 1 skid), a 6-pallet order beyond it
// toward Calhoun, and something farther still. The ends rule sheds the far end, then the 6 pallets,
// and the box is left at 9 with 5 skids of room.
const HOME = near('C', 34.165, -84.80, 9), BIG = at('BIG', 34.40, -84.93, 6);

test('ONE ORDER ALONE is still not a trip across town: a box with room leaves a single far order off and says how far', async () => {
  const p = await pipe([...HOME, BIG, at('ROME', 34.257, -85.165)].map((s) => pipeStop(s, BOX_ONLY)), [box('BOX', 14)]);
  assert.deepEqual(p.unassigned.map((u) => u.stopId).sort(), ['BIG', 'ROME']);
  assert.match(p.unassigned.find((u) => u.stopId === 'ROME').reasons[0], /out of its way/);
  assert.deepEqual(p.meta.groupFill.taken, []);
});

test('A GROUP TOO FAR stays off: two orders 100+ miles out cost the box far more per order than its own stops', async () => {
  const p = await pipe([...HOME, BIG, ...near('R', 34.68, -85.60, 2)].map((s) => pipeStop(s, BOX_ONLY)), [box('BOX', 14)]);
  assert.deepEqual(p.unassigned.map((u) => u.stopId).sort(), ['BIG', 'R00', 'R01']);
  for (const u of p.unassigned.filter((x) => x.stopId[0] === 'R')) assert.match(u.reasons[0], /out of its way/);
  assert.deepEqual(p.meta.groupFill.taken, []);
});

test('WINDOWS: on Chad\'s board with the four Dalton orders due by 9:00, SCOTT does not take them (it cannot get there in time), the reason says so, and nothing the old Build carried comes off', async () => {
  const stops = placed(7);
  const due = { openMin: 420, closeMin: 540, closedToday: false, sources: ['test'], label: '7:00a–9:00a' };
  const withWindows = stops.map((s) => (DALTON_FOUR.includes(s.stopNbr) ? { ...s, tr: due } : s));
  for (const windowMode of ['advisory', 'strict']) {
    const p = await pipe(boardStops(withWindows), TRUCKS, { windowMode }), off = await pipe(boardStops(withWindows), TRUCKS, { windowMode, fillTrucks: false });
    const scott = new Set(p.routes.find((x) => x.truckId === 'SCOTT').orderedStopIds);
    for (const id of DALTON_FOUR) assert.ok(!scott.has(id), `${windowMode}: ${id} is not on SCOTT`);
    for (const id of DALTON_FOUR) {
      const u = p.unassigned.find((x) => x.stopId === id);
      assert.ok(u && u.reasons.some((x) => /miss its window|appointment window/.test(x)), `${windowMode} ${id}: ${u ? u.reasons.join('; ') : 'not listed'}`);
    }
    assert.deepEqual(p.meta.groupFill.refused.map((r) => [r.truckId, [...r.stopIds].sort()]), [['SCOTT', DALTON_FOUR]], `${windowMode}: the job says which group was refused for the clock`);
    const was = onTruck(off), now = onTruck(p);
    for (const [id, t] of was) assert.equal(now.get(id), t, `${windowMode}: ${id} stays on ${t}`);
  }
});

test('HARD RULES on 80 random overloaded boards (green rule on and off, both strategies): every order the old Build carried rides the same truck, every group added is a whole area of what it left off, no truck over skids or pounds, nothing box-only on a tractor, the same answer twice', async () => {
  let seed = 31337; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let groups = 0;
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
    const p = await pipe(stops, trucks, { strategy }), again = await pipe(stops, trucks, { strategy }), off = await pipe(stops, trucks, { strategy, fillTrucks: false });
    assert.deepEqual(again.routes.map((r) => r.orderedStopIds), p.routes.map((r) => r.orderedStopIds), `board ${b}: deterministic`);
    assert.deepEqual(again.unassigned, p.unassigned, `board ${b}: deterministic`);
    const by = new Map(rows.map((r) => [r.stopNbr, r]));
    const was = onTruck(off), now = onTruck(p);
    for (const [id, t] of was) assert.equal(now.get(id), t, `board ${b}: ${id} stays on ${t}`);
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
    // each group the rule took is two or more orders, and no order chained within 15 km of it was left behind
    const left = p.unassigned.map((u) => by.get(u.stopId));
    for (const g of p.meta.groupFill?.taken || []) {
      groups++;
      assert.ok(g.stopIds.length >= 2, `board ${b}: a group of ${g.stopIds.length}`);
      for (const id of g.stopIds) for (const l of left) assert.ok(hav(by.get(id), l) >= 15000, `board ${b}: ${l.stopNbr} left behind ${Math.round(hav(by.get(id), l))} m from ${id}, which went on ${g.truckId}`);
    }
  }
  assert.ok(groups > 0, 'the rule took at least one group across these boards');
});

test('A BOARD THE ENDS RULE PLANS WITHOUT LEAVING ANYTHING OFF is unchanged: the step does not run', async () => {
  const stops = near('A', 34.30, -84.40, 10).map((s) => pipeStop(s));
  const on = await pipe(stops, [box('B1'), box('B2')]), off = await pipe(stops, [box('B1'), box('B2')], { fillTrucks: false });
  assert.deepEqual(on.routes.map((r) => [r.truckId, r.orderedStopIds]), off.routes.map((r) => [r.truckId, r.orderedStopIds]));
  assert.equal(on.meta.groupFill, null);
  assert.equal(on.meta.fillTrucks, true);
});

test('THE WIRING: the Build passes the switch to the pipeline, the pipeline the clock to the solver, the solver both to the ends rule', () => {
  const bg = readFileSync(new URL('../netlify/functions/routing-build-background.mts', import.meta.url), 'utf8');
  assert.match(bg, /fillTrucks: rules\.fillTrucks,/);
  const pipeSrc = readFileSync(new URL('../netlify/functions/lib/routing-pipeline.mts', import.meta.url), 'utf8');
  assert.match(pipeSrc, /fillTrucks: req\.fillTrucks === true,/);
  assert.match(pipeSrc, /\{ runClock: runClockFor\(solverInput\) \}/);
  const solver = readFileSync(new URL('../netlify/functions/lib/routing-solver.mts', import.meta.url), 'utf8');
  assert.match(solver, /\{ fillTrucks: input\.fillTrucks === true, runClock: opts\?\.runClock \}/);
  const ends = readFileSync(new URL('../netlify/functions/lib/routing-assign-ends.mts', import.meta.url), 'utf8');
  assert.match(ends, /if \(opts\?\.fillTrucks && leftOff\.length\)/);
  assert.equal(typeof assignLeavingOffEnds, 'function');
});
