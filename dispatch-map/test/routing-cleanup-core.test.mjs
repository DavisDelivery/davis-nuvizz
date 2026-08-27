// End-of-night cleanup: "give it 5 empties and let it route the leftover
// unplanned stops on them." These pin the rules that make the result something a
// dispatcher can act on at 9pm without re-checking it by hand:
//   • every leftover is either ON a truck or in the left-unplanned list, always
//   • a truck is loaded to the profile Chad maintains, never the fleet p95
//   • the trucks he provided get used, instead of one double-loading
//   • it says whether the pool FITS before he stages anything
//   • a tractor-blocked stop never lands on a trailer
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCleanupPlan, engineClassForProfile, CLEANUP_SOLVER_MS,
} from '../netlify/functions/lib/routing-cleanup-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const D = '2026-08-27';

const inputs = () => ({
  driverDaysBefore: [], referencesBefore: [],
  serviceDocByKey: new Map(), fleetServiceDoc: null, habitDocByKey: new Map(),
  notesRestrictions: new Map(), tractorCapable: new Set(), employees: [],
});

// A live board row as the scan writes it (NuVizz's mislabelled freight columns).
const row = (nbr, o = {}) => ({
  stopNbr: nbr, isUnplanned: o.planned ? false : true, isPlanned: !!o.planned,
  businessName: o.name || `BIZ ${nbr}`, addr1: `${nbr} Main St`, city: 'Buford', zip: '30518',
  lat: o.lat === undefined ? 34.05 + (Number(nbr.replace(/\D/g, '')) % 7) * 0.03 : o.lat,
  lng: o.lng === undefined ? -84.05 - Math.floor((Number(nbr.replace(/\D/g, '')) % 21) / 7) * 0.04 : o.lng,
  cartons: o.skids ?? 3, volume: o.loose ?? 0, pallets: o.skids ?? 3, weight: o.weight ?? 700,
  timeConstraint: null, ...o.raw,
});
const shell = (key, o = {}) => ({
  key, name: key, loadNbr: o.loadNbr ?? `L${key}`, loadId: o.loadId ?? null,
  truck_class: o.cls || 'box_truck', max_skids: o.maxSkids ?? null, max_weight_lb: o.maxWeightLb ?? null,
  driver_user_name: o.driver ?? null,
});
const plan = (rows, trucks, extra = {}) => buildCleanupPlan('davis', D, {
  cfg: CFG, inputs: extra.inputs || inputs(), liveStops: rows, meta: null, trucks,
  nowIso: '2026-08-27T01:00:00Z', ...extra,
});

test('engineClassForProfile bridges the browser vehicle profile to the engine vocabulary', () => {
  assert.equal(engineClassForProfile({ capabilities: { tractor: true } }), 'tractor');
  assert.equal(engineClassForProfile({ capabilities: { tractor: false } }), 'box_truck');
  assert.equal(engineClassForProfile({ label: '53ft Trailer' }), 'box_truck', 'the LABEL is not the signal — capabilities are');
  assert.equal(engineClassForProfile(null), 'box_truck', 'unknown reads as the stricter class');
  assert.equal(engineClassForProfile({}), 'box_truck');
});

test('CONSERVATION: every leftover is either on a truck or listed as unplanned — none vanish', () => {
  const rows = [
    ...Array.from({ length: 22 }, (_, i) => row(`U${i}`)),
    row('P1', { planned: true }),                 // already planned — not leftovers
    row('N1', { lat: null, lng: null }),          // no map position
  ];
  const p = plan(rows, [shell('SUW 2'), shell('ALPHA')]);
  const onTrucks = p.trucks.flatMap((t) => t.stops.map((s) => s.stopNbr));
  const listed = p.left_unplanned.map((s) => s.stopNbr);
  const accounted = new Set([...onTrucks, ...listed]);
  const poolIds = rows.filter((r) => r.isUnplanned).map((r) => r.stopNbr);
  for (const id of poolIds) assert.ok(accounted.has(id), `${id} vanished — neither routed nor reported`);
  assert.ok(!accounted.has('P1'), 'an already-planned stop is not cleanup work');
  assert.equal(new Set(onTrucks).size, onTrucks.length, 'no stop is on two trucks');
  assert.equal(p.pool.routed, onTrucks.length);
});

test('a stop with no map position is REPORTED, never placed at 0,0', () => {
  const p = plan([row('N1', { lat: null, lng: null }), row('U1')], [shell('SUW 2')]);
  const n = p.left_unplanned.find((s) => s.stopNbr === 'N1');
  assert.equal(n?.reason, 'no_coords');
  assert.equal(p.pool.no_coords, 1);
  assert.ok(!p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'N1')));
});

test('a truck is loaded to the profile Chad maintains, not the fleet p95', () => {
  // 20 stops x 3 skids = 60 skid-equivalents at one box shell.
  const rows = Array.from({ length: 20 }, (_, i) => row(`U${i}`, { skids: 3 }));
  const classCap = plan(rows, [shell('SUW 2')]);
  const profileCap = plan(rows, [shell('SUW 2', { maxSkids: 14 })]);
  assert.equal(classCap.trucks[0].cap.skids, 22, 'no profile stated → the class bound');
  assert.equal(profileCap.trucks[0].cap.skids, 14, 'profile stated → the dispatcher\'s number');
  assert.equal(profileCap.trucks[0].cap.source, 'profile');
  assert.ok(profileCap.trucks[0].skid_equiv <= 14 + 1e-9,
    `loaded ${profileCap.trucks[0].skid_equiv} onto a 14-skid truck`);
  assert.ok(profileCap.trucks[0].skid_equiv < classCap.trucks[0].skid_equiv, 'the tighter profile really binds');
});

test('a profile can only TIGHTEN — a 40-skid claim on a box truck is not honoured', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`U${i}`, { skids: 3 }));
  const p = plan(rows, [shell('SUW 2', { maxSkids: 40 })]);
  assert.equal(p.trucks[0].cap.skids, 22, 'the class bound still wins');
  assert.ok(p.trucks[0].skid_equiv <= 22 + 1e-9);
});

test('the trucks Chad provided get used — no shell sits empty while another double-loads', () => {
  // 5 shells x 14 skids = 70 of capacity; 20 stops x 3 skids = 60 — a pool that
  // genuinely fits, so every shell should get work and nothing should spill.
  const rows = Array.from({ length: 20 }, (_, i) => row(`U${i}`, { skids: 3 }));
  const trucks = ['SUW 2', 'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'].map((k) => shell(k, { maxSkids: 14 }));
  const p = plan(rows, trucks);
  assert.equal(p.trucks.length, 5, 'every picked shell is reported, even an empty one');
  const used = p.trucks.filter((t) => t.stop_count > 0).length;
  assert.ok(used >= 4, `only ${used}/5 shells used: [${p.trucks.map((t) => t.stop_count)}]`);
  assert.equal(p.pool.routed, 20, 'a pool this size fits and should be fully routed');
  assert.equal(p.left_unplanned.length, 0);
});

test('FIT is answered before anything is staged, and overflow is listed not hidden', () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(`U${i}`, { skids: 4 }));  // 160 skid-eq
  const p = plan(rows, [shell('SUW 2', { maxSkids: 14 }), shell('ALPHA', { maxSkids: 14 })]);  // 28
  assert.equal(p.fit.fits, false);
  assert.equal(p.fit.capacity_skid_equiv, 28);
  assert.equal(p.fit.pool_skid_equiv, 160);
  assert.ok(p.fit.shortfall_skid_equiv > 100);
  assert.ok(p.fit.trucks_needed_estimate >= 11, `estimate ${p.fit.trucks_needed_estimate}`);
  assert.ok(p.notes.some((n) => /roughly \d+ trucks/.test(n)), 'and it says so in words');
  const over = p.left_unplanned.filter((s) => s.reason === 'over_capacity');
  assert.ok(over.length > 0, 'the freight that did not fit is listed');
  const routed = p.trucks.reduce((a, t) => a + t.stop_count, 0);
  assert.equal(routed + p.left_unplanned.length, 40, 'routed + reported = the whole pool');
});

test('one shell is ONE truckload — a second load never appears as a silent extra trip', () => {
  const rows = Array.from({ length: 24 }, (_, i) => row(`U${i}`, { skids: 4 }));
  const p = plan(rows, [shell('SUW 2', { maxSkids: 10 })]);
  const t = p.trucks[0];
  assert.ok(t.skid_equiv <= 10 + 1e-9, `one truckload only, got ${t.skid_equiv}`);
  assert.ok(t.skid_equiv <= t.cap.skids + 1e-9, 'and never past its own cap');
  const over = p.left_unplanned.filter((s) => s.reason === 'over_capacity');
  assert.ok(over.length > 0, 'the freight that did not fit is declared, not dropped');
  assert.equal(
    t.stop_count + p.left_unplanned.length, 24,
    'and every stop is either on the truck or in the left-unplanned list',
  );
});

test('a tractor-blocked customer never lands on a trailer', () => {
  const inp = inputs();
  // The restriction is keyed by the customer match key the mapping computes.
  const blocked = row('B1', { name: 'NARROW DOCK' });
  const mk = 'narrow_dock__b1_main_st__buford__30518';
  inp.notesRestrictions.set(mk, ['no_tractor_trailer']);
  const p = plan([blocked, row('U1'), row('U2')], [shell('TRAILER 6', { cls: 'tractor' })], { inputs: inp });
  assert.ok(!p.trucks[0].stops.some((s) => s.stopNbr === 'B1'), 'not on the trailer');
  assert.equal(p.left_unplanned.find((s) => s.stopNbr === 'B1')?.reason, 'equipment');
});

test('stops already staged on an open card are excluded, and counted', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(`U${i}`));
  const p = plan(rows, [shell('SUW 2')], { excludeStopNbrs: ['U0', 'U1'] });
  const onTrucks = p.trucks.flatMap((t) => t.stops.map((s) => s.stopNbr));
  assert.ok(!onTrucks.includes('U0') && !onTrucks.includes('U1'), 'held stops are not re-routed');
  assert.equal(p.pool.excluded_held, 2);
  assert.ok(!p.left_unplanned.some((s) => s.stopNbr === 'U0'), 'and they are not reported as leftovers either');
});

test('an empty board says so instead of producing an empty plan silently', () => {
  const p = plan([row('P1', { planned: true })], [shell('SUW 2')]);
  assert.equal(p.pool.unplanned, 0);
  assert.equal(p.pool.routed, 0);
  assert.ok(p.notes.some((n) => /nothing.*unplanned/i.test(n)));
});

test('deterministic: the same board, date and shells produce the identical plan', () => {
  const rows = Array.from({ length: 18 }, (_, i) => row(`U${i}`));
  const trucks = [shell('SUW 2', { maxSkids: 14 }), shell('ALPHA', { maxSkids: 14 })];
  const strip = (p) => JSON.stringify({ ...p, ms: 0 });
  assert.equal(strip(plan(rows, trucks)), strip(plan(rows, trucks)));
});

test('the solve is bounded so a waiting dispatcher always gets an answer', () => {
  assert.ok(CLEANUP_SOLVER_MS <= 20_000, 'must stay well inside the 26s function timeout');
  const rows = Array.from({ length: 60 }, (_, i) => row(`U${i}`));
  const t0 = Date.now();
  const p = plan(rows, ['A', 'B', 'C', 'D', 'E'].map((k) => shell(k, { maxSkids: 14 })));
  const ms = Date.now() - t0;
  assert.ok(ms < CLEANUP_SOLVER_MS + 8000, `took ${ms}ms`);
  assert.ok(p.ms >= 0);
});

test('each truck reports its sequencing mode honestly', () => {
  const p = plan(Array.from({ length: 8 }, (_, i) => row(`U${i}`)), [shell('SUW 2')]);
  const t = p.trucks[0];
  assert.ok(t.mode === 'guided' || t.mode === 'unguided');
  // No reference library in these fixtures ⇒ unguided, and it must not claim otherwise.
  assert.equal(t.mode, 'unguided');
  assert.equal(t.references_used, 0);
  assert.ok(Number.isFinite(t.travel_min_est));
});

test('GEOGRAPHY: five clean clusters land as five clean trucks, not straddled routes', () => {
  // The rule this pins, learned the hard way: the assignment solver's seed is a
  // DRIVER-ownership score (habit, affinity, learned territory), and every one of
  // those reads zero for an unnamed empty shell — so without a geometric seed the
  // seed is jitter. Measured before the sweep: 4 of 5 trucks came back straddling
  // two towns, one running Gainesville AND Conyers, 46 miles apart.
  const towns = {
    MARIETTA: [33.95, -84.55], CONYERS: [33.67, -84.02], GAINESVILLE: [34.30, -83.82],
    NEWNAN: [33.38, -84.80], ALPHARETTA: [34.07, -84.29],
  };
  const rows = [];
  let i = 0;
  for (const [town, [lat, lng]] of Object.entries(towns)) {
    for (let k = 0; k < 4; k++, i++) {
      rows.push({
        stopNbr: `${town}_${k}`, isUnplanned: true, businessName: town, addr1: `${i} Main St`,
        city: town, zip: '30518', lat: lat + (k % 2) * 0.012, lng: lng + Math.floor(k / 2) * 0.012,
        cartons: 3, volume: 0, pallets: 3, weight: 700, timeConstraint: null,
      });
    }
  }
  const p = plan(rows, ['A', 'B', 'C', 'D', 'E'].map((k) => shell(k, { maxSkids: 14 })));
  const straddlers = p.trucks.filter((t) => new Set(t.stops.map((s) => s.city)).size > 1);
  assert.equal(straddlers.length, 0,
    `these trucks cross towns: ${straddlers.map((t) => `${t.key}=[${[...new Set(t.stops.map((s) => s.city))]}]`).join(' ')}`);
  assert.equal(p.pool.routed, 20, 'and the whole pool still lands');
});

test('a stop at 0,0 is bad geocoding, not a delivery in the Gulf of Guinea', () => {
  const p = plan([row('Z1', { lat: 0, lng: 0 }), row('U1')], [shell('SUW 2')]);
  assert.equal(p.left_unplanned.find((s) => s.stopNbr === 'Z1')?.reason, 'no_coords');
  assert.ok(!p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'Z1')));
});

test('stops with no freight numbers still cost capacity, and the estimate is declared', () => {
  // Un-enriched rows read 0/0/0. Free against the caps, they would let an
  // unbounded number ride one truck while the panel showed "0 of 14 skids".
  const rows = Array.from({ length: 30 }, (_, i) => row(`U${i}`, { skids: 0, loose: 0, raw: { pallets: 0 } }));
  const p = plan(rows, [shell('SUW 2', { maxSkids: 6 })]);
  assert.equal(p.pool.unknown_freight, 30);
  assert.ok(p.trucks[0].stop_count <= 6, `${p.trucks[0].stop_count} un-enriched stops on a 6-skid truck`);
  assert.ok(p.notes.some((n) => /estimate/i.test(n)), 'and the panel is told the totals are an estimate');
  assert.ok(p.left_unplanned.length > 0, 'the rest is reported, not silently loaded');
});

test('a stale board is called out by age — warned, never silently trusted', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(`U${i}`));
  const old = buildCleanupPlan('davis', D, {
    cfg: CFG, inputs: inputs(), liveStops: rows, trucks: [shell('SUW 2')],
    meta: { lastUnplannedScanAt: '2026-08-26T17:00:00Z' },   // ~8h before nowIso
    nowIso: '2026-08-27T01:00:00Z',
  });
  assert.equal(old.staleness.stale, true);
  assert.ok(old.staleness.pool_age_min >= 470, `age ${old.staleness.pool_age_min}`);
  assert.ok(old.notes.some((n) => /last scanned 8h/.test(n)), `notes: ${old.notes}`);
  assert.ok(old.trucks[0].stop_count > 0, 'but it still produces a plan — a dark scanner must not block Sunday-night planning');

  const fresh = buildCleanupPlan('davis', D, {
    cfg: CFG, inputs: inputs(), liveStops: rows, trucks: [shell('SUW 2')],
    meta: { lastUnplannedScanAt: '2026-08-27T00:40:00Z' },   // 20 min
    nowIso: '2026-08-27T01:00:00Z',
  });
  assert.equal(fresh.staleness.stale, false);
  assert.equal(fresh.staleness.pool_age_min, 20);
  assert.ok(!fresh.notes.some((n) => /last scanned/.test(n)));
});

// ── capacity is a WALL here, not a learned preference ─────────────────────────
// Found by a randomized sweep over 3,000 synthetic boards, not by reading: the
// solver's trip splitter puts a stop bigger than a driver's cap in a trip by
// ITSELF rather than drop it. That is right for the nightly plan, where the cap
// is a learned typical load. It is wrong here, where Chad has named the trucks
// and told us what they hold.

test('a stop bigger than EVERY truck he picked is named, not forced onto one', () => {
  // One consignee with 10 skids, one 6-skid straight truck. The freight will not
  // go on that truck at the dock, so the plan must not claim it does.
  const rows = [row('BIG', { skids: 10, weight: 6000 }), row('SMALL', { skids: 1, weight: 300 })];
  const p = plan(rows, [shell('BOX1', { maxSkids: 6 })]);
  const big = p.left_unplanned.find((s) => s.stopNbr === 'BIG');
  assert.equal(big?.reason, 'too_big', 'a 10-skid stop on a 6-skid truck is not a routing problem');
  assert.match(big.detail, /bigger truck or splitting/);
  // AND the expensive half: the oversized stop must not crowd out freight that
  // fits. Before this fix BIG took the truck and SMALL was reported as needing a
  // second one — telling Chad to roll a truck he does not need.
  const onBox = p.trucks[0].stops.map((s) => s.stopNbr);
  assert.deepEqual(onBox, ['SMALL'], 'the 1-skid stop rides; it was never the problem');
  assert.ok(p.fit.fits, 'the freight that CAN go fits on one truck — say so');
});

test('a stop that fits the big truck but not the small one rides the big one', () => {
  // 10 skids, a 6-skid box and a 14-skid box. This is routable — it just has to
  // land on the right truck. It must never be reported as too_big.
  const rows = [row('BIG', { skids: 10, weight: 4000 })];
  const p = plan(rows, [shell('SMALLBOX', { maxSkids: 6 }), shell('BIGBOX', { maxSkids: 14 })]);
  assert.equal(p.left_unplanned.length, 0, `nothing should be left over: ${JSON.stringify(p.left_unplanned)}`);
  const carrier = p.trucks.find((t) => t.stops.some((s) => s.stopNbr === 'BIG'));
  assert.equal(carrier?.key, 'BIGBOX', 'it goes on the truck that can hold it');
});

test('NO TRUCK IS EVER OVER ITS CAP — the reported load always fits the reported truck', () => {
  // The invariant a dispatcher reads off the card. Tight caps and lumpy freight
  // are exactly the shape that broke it.
  const rows = [
    row('A', { skids: 7 }), row('B', { skids: 5 }), row('C', { skids: 4 }),
    row('D', { skids: 3 }), row('E', { skids: 2 }), row('F', { skids: 1 }),
  ];
  const p = plan(rows, [shell('T1', { maxSkids: 8 }), shell('T2', { maxSkids: 8 })]);
  for (const t of p.trucks) {
    assert.ok(t.skid_equiv <= t.cap.skids + 1e-6, `${t.key} loaded ${t.skid_equiv} past its ${t.cap.skids} cap`);
  }
  // and nothing vanished on the way
  const seen = new Set([...p.trucks.flatMap((t) => t.stops.map((s) => s.stopNbr)), ...p.left_unplanned.map((s) => s.stopNbr)]);
  for (const r of rows) assert.ok(seen.has(r.stopNbr), `${r.stopNbr} vanished`);
});

test('the weight rating is a wall too, and a non-positive rating is NO gate', () => {
  // 4 stops x 1200 lb against a 3000 lb rating: at most two ride.
  const rows = Array.from({ length: 4 }, (_, i) => row(`W${i}`, { skids: 1, weight: 1200 }));
  const p = plan(rows, [shell('LIGHT', { maxSkids: 20, maxWeightLb: 3000 })]);
  assert.ok(p.trucks[0].weight_lb <= 3000, `loaded ${p.trucks[0].weight_lb} lb past a 3000 lb rating`);
  // A single stop heavier than the only truck's rating is named, not loaded.
  const heavy = plan([row('H1', { skids: 1, weight: 9000 })], [shell('LIGHT', { maxSkids: 20, maxWeightLb: 3000 })]);
  assert.equal(heavy.left_unplanned[0]?.reason, 'too_big');
  assert.match(heavy.left_unplanned[0].detail, /lb/);
});

test('an oversized stop that no truck can take on EQUIPMENT grounds still reads as equipment', () => {
  // Precedence matters: a tractor-blocked customer with 40 skids, offered only a
  // trailer, is an EQUIPMENT refusal. Reporting "needs a bigger truck" would send
  // Chad to find one — and the bigger truck is the very trailer the customer bars.
  const inp = inputs();
  inp.notesRestrictions.set('narrow_dock__b1_main_st__buford__30518', ['no_tractor_trailer']);
  const p = plan([row('B1', { name: 'NARROW DOCK', skids: 40 })], [shell('TRAILER 6', { cls: 'tractor' })], { inputs: inp });
  const l = p.left_unplanned.find((s) => s.stopNbr === 'B1');
  assert.equal(l?.reason, 'equipment', 'equipment beats size — the size is not the reason it cannot go');
  assert.ok(!p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'B1')), 'never on the trailer');
});

test('the same stop number twice on the board is ONE stop, not two', () => {
  // A vendor board that repeats a stopNbr must not put the same delivery on a
  // truck twice — the driver would show up for freight that is already gone, and
  // the fill numbers on the card would be overstated.
  const p = plan([row('DUP'), row('DUP'), row('X')], [shell('T1')]);
  const on = p.trucks.flatMap((t) => t.stops.map((s) => s.stopNbr));
  assert.equal(on.filter((id) => id === 'DUP').length, 1, `DUP appears ${on.filter((i) => i === 'DUP').length} times`);
  assert.equal(p.pool.duplicates, 1, 'and the collapse is declared, not silent');
});

test('GEOGRAPHY: a big truck does not straddle the map just because it has room', () => {
  // Four leftovers: one 10-skid stop 30 miles NORTH, three small ones 30 miles
  // SOUTH. A 6-skid box and a 14-skid box. The 10-skid stop can only ride the big
  // truck. The textbook sweep fills the big truck to 14 — so it takes the north
  // stop AND two southern ones, running a 60-mile straddle, while the small truck
  // does a single delivery. The right answer is one truck north, one truck south.
  const rows = [
    row('N1', { skids: 10, lat: 34.60, lng: -83.95 }),
    row('S1', { skids: 2, lat: 33.70, lng: -83.95 }),
    row('S2', { skids: 2, lat: 33.72, lng: -83.90 }),
    row('S3', { skids: 2, lat: 33.68, lng: -84.00 }),
  ];
  const p = plan(rows, [shell('A_SMALL', { maxSkids: 6 }), shell('B_BIG', { maxSkids: 14 })]);
  const big = p.trucks.find((t) => t.key === 'B_BIG');
  const small = p.trucks.find((t) => t.key === 'A_SMALL');
  assert.deepEqual(big.stops.map((s) => s.stopNbr), ['N1'], 'the big truck runs the north stop only');
  assert.deepEqual(small.stops.map((s) => s.stopNbr).sort(), ['S1', 'S2', 'S3'], 'the small truck runs the south');
  // stated as the rule, not the arrangement: no truck spans both ends of the map
  for (const t of p.trucks) {
    if (t.stops.length < 2) continue;
    const lats = t.stops.map((s) => s.lat);
    assert.ok(Math.max(...lats) - Math.min(...lats) < 0.5,
      `${t.key} spans ${(Math.max(...lats) - Math.min(...lats)).toFixed(2)}° of latitude — that is a straddle`);
  }
});

// ── the clock and the dock: what a refused delivery actually looks like ───────
// A cleanup route is built at night for the next day. Capacity was already a
// wall; these pin the two facts that decide whether the freight can be DELIVERED
// once it is on the truck, which is the half that costs a redelivery.

const MK = 'narrow_dock__b1_main_st__buford__30518';   // matchKey the mapper computes for row('B1', {name:'NARROW DOCK'})

test('a customer CLOSED on the served day is never routed — nobody is there to take it', () => {
  // 2026-08-27 is a Thursday.
  const inp = inputs();
  inp.noteByKey = new Map([[MK, { closed_days: ['thu'], manual_overrides: { closed_days: true } }]]);
  const p = plan([row('B1', { name: 'NARROW DOCK' }), row('U1')], [shell('T1')], { inputs: inp });
  const l = p.left_unplanned.find((s) => s.stopNbr === 'B1');
  assert.equal(l?.reason, 'closed_today');
  assert.match(l.detail, /closed Thursdays/);
  assert.ok(!p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'B1')), 'never on a truck');
  assert.equal(p.pool.closed_today, 1);
  assert.ok(p.notes.some((n) => /closed on Thursdays/.test(n)), 'and it is said out loud, not just listed');
  // the stop that IS open still rides
  assert.ok(p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'U1')));
});

test('a customer closed on a DIFFERENT day rides normally', () => {
  const inp = inputs();
  inp.noteByKey = new Map([[MK, { closed_days: ['sun'], manual_overrides: { closed_days: true } }]]);
  const p = plan([row('B1', { name: 'NARROW DOCK' })], [shell('T1')], { inputs: inp });
  assert.equal(p.pool.closed_today, 0);
  assert.ok(p.trucks[0].stops.some((s) => s.stopNbr === 'B1'));
});

test('the dock CLOSE TIME reaches the card — a dispatcher cannot judge a sequence without it', () => {
  const inp = inputs();
  inp.noteByKey = new Map([[MK, { receiving_hours: { thu: '8AM-2PM' } }]]);
  const p = plan([row('B1', { name: 'NARROW DOCK' }), row('U1')], [shell('T1')], { inputs: inp });
  const card = p.trucks.flatMap((t) => t.stops).find((s) => s.stopNbr === 'B1');
  assert.equal(card.close_min, 14 * 60, '2PM');
  assert.equal(card.close_label, '2:00p');
  assert.equal(card.early_close, true, 'shuts before 3pm');
  // a stop with nothing on file claims NO deadline — never a midnight one
  const bare = p.trucks.flatMap((t) => t.stops).find((s) => s.stopNbr === 'U1');
  assert.equal(bare.close_min, null, 'no hours on file is not a 00:00 deadline');
  assert.equal(bare.early_close, false);
});

test('an early-closing dock sequenced into the back half is CALLED OUT, not buried', () => {
  const inp = inputs();
  // Put the early closer far out so the sequencer puts it late.
  const far = 'far_dock__f1_main_st__dalton__30518';
  inp.noteByKey = new Map([[far, { receiving_hours: { thu: '8AM-1PM' } }]]);
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row(`U${i}`, { lat: 34.10 + i * 0.01, lng: -84.00 })),
    { ...row('F1', { name: 'FAR DOCK' }), city: 'Dalton', addr1: 'F1 Main St', lat: 34.77, lng: -84.97 },
  ];
  const p = plan(rows, [shell('T1')], { inputs: inp });
  const t = p.trucks[0];
  const idx = t.stops.findIndex((s) => s.stopNbr === 'F1');
  if (idx >= Math.floor(t.stops.length / 2)) {
    assert.ok(p.notes.some((n) => /shuts early/.test(n)), `late early-closer must be named; notes were ${JSON.stringify(p.notes)}`);
  }
  // whatever the sequence, the clock is on the card so he can see it
  assert.equal(t.stops[idx].close_label, '1:00p');
});

test('a liftgate customer is not loaded onto a trailer that has none', () => {
  const inp = inputs();
  inp.notesRestrictions.set(MK, ['liftgate_required']);
  const p = plan([row('B1', { name: 'NARROW DOCK' }), row('U1')], [shell('TRAILER', { cls: 'tractor' })], { inputs: inp });
  const l = p.left_unplanned.find((s) => s.stopNbr === 'B1');
  assert.equal(l?.reason, 'equipment');
  assert.match(l.detail, /liftgate/);
  assert.ok(!p.trucks.some((t) => t.stops.some((s) => s.stopNbr === 'B1')), 'the driver could not get it on the ground');
});

test('the same liftgate customer rides when a picked load HAS a liftgate', () => {
  const inp = inputs();
  inp.notesRestrictions.set(MK, ['liftgate_required']);
  const withGate = { ...shell('BOX1'), liftgate: true };
  const p = plan([row('B1', { name: 'NARROW DOCK' })], [withGate], { inputs: inp });
  assert.equal(p.left_unplanned.length, 0, JSON.stringify(p.left_unplanned));
  assert.ok(p.trucks[0].stops.some((s) => s.stopNbr === 'B1'));
});

test('a pickup is MARKED on the card, so "check they belong" is something he can act on', () => {
  const p = plan([row('P1', { raw: { stopType: 'PU' } }), row('D1')], [shell('T1')]);
  const cards = p.trucks.flatMap((t) => t.stops);
  assert.equal(cards.find((s) => s.stopNbr === 'P1')?.pickup, true);
  assert.equal(cards.find((s) => s.stopNbr === 'D1')?.pickup, false);
});
