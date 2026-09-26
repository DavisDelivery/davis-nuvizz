// test/claude-shadow-backtest-map.test.mjs — THE CLAUDE-vs-DISPATCH MAP SHOWS EXACTLY WHAT WAS MEASURED.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch." What these pin:
// the map is built from the stops STORED with the backtest and the result's own per-load orders (so
// it can never drift from the scorecard); a day with no backtest, or whose stored stops are gone,
// says so instead of drawing something; each stop's truck under each plan is right; and colour
// follows the truck, eight at a time, never repainting one you are looking at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBacktestProblem, compareBacktest, backtestMapPayload, tourLegs, tourCost } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { backtestMap, jobPath, resultPath } from '../netlify/functions/lib/claude-shadow/backtest.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';
import {
  whereIs, planLoads, truckRows, stopStory, storiesAt, orderNote, toggleTruck, pickTrucks, planGeo, boundsOf, MAX_SELECTED, SELECT_COLORS,
  routeCompare, routeRows, sortRoutes, freightOf, customerSplits, focusBounds, focusPicks, fmtHm,
} from '../src/shadow/backtest-map-core.js';

const D = '2026-09-23';
const CFG = { ...effectiveEngineConfig(null, {}), solver_ms_cap: 200 };
const DEPOT = { lat: 34.14838, lng: -83.95948 };
let seq = 0;
const row = (route, driver, lat, lng) => ({
  stopNbr: `S${String(++seq).padStart(3, '0')}`, stopType: 'DO', status: '90', normalizedStatus: 'DELIVERED', isPlanned: true,
  routeName: route, loadNbr: route, driverName: driver, driverUserName: driver, cartons: 2, volume: 0, weight: 500, routeSeq: seq,
  deliveredDTTM: `${D}T1${seq % 10}:00:00`, listUpdatedDTTM: `${D}T18:00:00`, zip: '30501', city: 'GAINESVILLE',
  customerMatchKey: `C${seq}`, businessName: `CUSTOMER ${seq}`, lat, lng,
});
function day() {
  seq = 0;
  // Dispatch crossed two trucks: each carries two stops from the other's area.
  return [
    row('NORTH', 'Ann Lee', 34.30, -83.82), row('NORTH', 'Ann Lee', 34.31, -83.83), row('NORTH', 'Ann Lee', 34.00, -84.14), row('NORTH', 'Ann Lee', 34.01, -84.13),
    row('SOUTH', 'Bo Tan', 34.02, -84.12), row('SOUTH', 'Bo Tan', 34.03, -84.11), row('SOUTH', 'Bo Tan', 34.32, -83.84), row('SOUTH', 'Bo Tan', 34.33, -83.85),
  ];
}
function built() {
  const p = buildBacktestProblem({
    date: D, rows: day(), roster: null, stamp: 'x', learnDaysBefore: [], caps: null, loosePerSkid: 10, capRule: 'tighter',
    employees: [], notes: new Map(), depot: DEPOT, at: '2026-09-25T00:00:00Z', cfg: CFG,
  });
  // Claude straightens them: every northern stop on L1, every southern stop on L2.
  const north = p.stops.filter((s) => s.lat > 34.2).map((s) => s.id), south = p.stops.filter((s) => s.lat < 34.2).map((s) => s.id);
  const plan = { loads: [{ load: 'L1', stops: north }, { load: 'L2', stops: south }], unplanned: [] };
  const r = { ...compareBacktest(p, plan, CFG, { perMile: null, perDriveHour: null }), at: '2026-09-25T16:16:26Z', jobId: 'bt__x' };
  return { p, r };
}

test('the map is the stored stops and the result’s own orders — never a re-derivation that could drift from the scorecard', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r);
  assert.equal(m.stops.length, 8);
  assert.deepEqual(m.depot, DEPOT);
  for (const l of r.loads) {
    assert.deepEqual(m.plans.driven[l.id], l.driven.order, `${l.id} dispatch order`);
    if (l.claude) assert.deepEqual(m.plans.claude[l.id], l.claude.order, `${l.id} Claude order`);
  }
  const st = m.stops.find((s) => s.n === 'S001');
  assert.equal(st.lat, 34.30);
  assert.equal(st.name, 'CUSTOMER 1');
});

test('a day with no backtest, or whose stored stops are gone, says so instead of drawing something', async () => {
  const { p, r } = built();
  const docs = new Map();
  const deps = { getDoc: async (path) => docs.get(path) ?? null };
  assert.equal((await backtestMap('nope', deps)).status, 400);
  assert.equal((await backtestMap(D, deps)).status, 404);
  docs.set(resultPath(D), r);
  const gone = await backtestMap(D, deps);
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /not on file/);
  docs.set(`${jobPath('bt__x')}/data/problem`, { problemJson: JSON.stringify(p) });
  const ok = await backtestMap(D, deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.nuvizzCalls, 0);
  assert.equal(ok.body.map.stops.length, 8);
});

test('each stop’s truck under each plan: a crossed stop moves trucks, and its place in each truck’s order is right', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r);
  const crossed = m.stops.find((s) => s.n === 'S003');           // a southern stop dispatch put on NORTH
  const story = stopStory(m, crossed.id);
  assert.equal(story.driven.route, 'NORTH');
  assert.equal(story.claude.route, 'SOUTH');
  assert.equal(story.sameTruck, false);
  const w = whereIs(m, 'driven').get(crossed.id);
  assert.equal(m.plans.driven[w.loadId][w.seq - 1], crossed.id);
  assert.equal(w.of, 4);
  const rows = truckRows(m);
  assert.deepEqual(rows.map((x) => [x.route, x.driven, x.claude]), [['NORTH', 4, 4], ['SOUTH', 4, 4]]);
  assert.equal(planLoads(m, 'claude').reduce((a, l) => a + l.stops, 0), 8);
  assert.equal(stopStory(m, 9999), null);
});

test('colour follows the truck: picks take fixed slots, a truck keeps its colour while picked, and a ninth pick is refused — never repainting', () => {
  let sel = new Map();
  for (let i = 1; i <= MAX_SELECTED; i++) sel = toggleTruck(sel, `L${i}`).next;
  assert.equal(sel.size, SELECT_COLORS.length);
  assert.equal(sel.get('L1'), 0);
  assert.equal(sel.get('L8'), 7);
  const ninth = toggleTruck(sel, 'L9');
  assert.equal(ninth.refused, true);
  assert.equal(ninth.next, sel, 'nothing repainted');
  // Freeing slot 2 (L3): the next pick takes slot 2; everyone else keeps theirs.
  sel = toggleTruck(sel, 'L3').next;
  sel = toggleTruck(sel, 'L9').next;
  assert.equal(sel.get('L9'), 2);
  assert.equal(sel.get('L8'), 7);
  // Picking a stop's two trucks keeps what is already picked.
  const both = pickTrucks(new Map([['L1', 0]]), ['L1', 'L2']);
  assert.deepEqual([...both.next.entries()], [['L1', 0], ['L2', 1]]);
});

test('the drawing: each route starts at Buford, coordinates are [lng, lat], every stop is a point, the box holds them all', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r);
  const g = planGeo(m, 'claude');
  const routes = g.features.filter((f) => f.properties.kind === 'route');
  assert.equal(routes.length, 2);
  for (const rt of routes) assert.deepEqual(rt.geometry.coordinates[0], [DEPOT.lng, DEPOT.lat]);
  assert.equal(g.features.filter((f) => f.properties.kind === 'stop').length, 8);
  assert.equal(g.features.filter((f) => f.properties.kind === 'depot').length, 1);
  const b = boundsOf(m);
  assert.ok(b.north >= 34.33 && b.south <= 34.00 && b.west <= -84.14 && b.east >= -83.82);
});

// ── review of the map (2026-09-25) ──

test('REVIEW: a stop Claude left unplanned is still on Claude’s map — a hollow ring with the reason — and is named by its NuVizz number, not a renumbering', () => {
  const { p } = built();
  const north = p.stops.filter((s) => s.lat > 34.2).map((s) => s.id), south = p.stops.filter((s) => s.lat < 34.2).map((s) => s.id);
  const left = south[0];
  const plan = { loads: [{ load: 'L1', stops: north }, { load: 'L2', stops: south.slice(1) }], unplanned: [{ stop: left, reason: 'no box truck has room' }] };
  const r = { ...compareBacktest(p, plan, CFG, { perMile: null, perDriveHour: null }), at: 'x', jobId: 'bt__x' };
  const stored = r.unplanned[0];
  assert.equal(stored.n, p.stops.find((s) => s.id === left).n, 'the stored result names the stop by its own number');
  assert.equal(stored.name, p.stops.find((s) => s.id === left).name);
  const m = backtestMapPayload(p, r);
  assert.deepEqual(m.unplanned, [{ id: left, reason: 'no box truck has room' }]);
  const claude = planGeo(m, 'claude').features;
  const ring = claude.filter((f) => f.properties.kind === 'unplanned');
  assert.equal(ring.length, 1);
  assert.equal(ring[0].properties.stopId, left);
  assert.match(ring[0].properties.title, /left unplanned by Claude: no box truck has room/);
  // Every stop of the day is on Claude's map, planned or not.
  assert.equal(claude.filter((f) => f.properties.kind === 'stop' || f.properties.kind === 'unplanned').length, 8);
  assert.equal(planGeo(m, 'driven').features.filter((f) => f.properties.kind === 'unplanned').length, 0, 'dispatch delivered it — no ring there');
  const story = stopStory(m, left);
  assert.deepEqual(story.claude, { unplanned: true, reason: 'no box truck has room' });
  assert.equal(story.sameTruck, false);
  assert.ok(story.driven?.route, 'and dispatch’s truck for it is still told');
});

test('REVIEW: a dispatch truck drawn in its PLANNED order says so — in the payload, the list, the stop, and one sentence over the map', () => {
  const { p, r } = built();
  const m0 = backtestMapPayload(p, r);
  assert.deepEqual(m0.loads.map((l) => l.orderSource), p.loads.map((l) => l.orderSource), 'carried through as stored');
  assert.equal(orderNote(m0), null, 'every line is as driven: nothing to say');
  const south = p.loads.find((l) => l.route === 'SOUTH');
  south.orderSource = 'planned';
  const m = backtestMapPayload(p, r);
  assert.match(orderNote(m), /^1 dispatch truck had no delivery times, so its line follows the planned order, not the order delivered: SOUTH\.$/);
  assert.equal(truckRows(m).find((x) => x.route === 'SOUTH').orderSource, 'planned');
  const sStop = m.stops.find((s) => m.plans.driven[south.id].includes(s.id));
  assert.equal(stopStory(m, sStop.id).driven.orderSource, 'planned');
  const title = planGeo(m, 'driven').features.find((f) => f.properties.kind === 'stop' && f.properties.loadId === south.id).properties.title;
  assert.match(title, /SOUTH \(Bo Tan\), stop 1 of 4, planned order$/);
  // Claude's plan is the engine's order — no "planned order" there.
  assert.doesNotMatch(planGeo(m, 'claude').features.find((f) => f.properties.kind === 'stop').properties.title, /planned order/);
});

test('REVIEW: one customer’s orders at one spot — a tap lists every one of them, so a split Claude made is visible', () => {
  const m = {
    depot: DEPOT,
    stops: [
      { id: 1, n: 'S002', lat: 34.3, lng: -83.8, name: 'ACME', city: 'GAINESVILLE', spots: 1, lbs: 100 },
      { id: 2, n: 'S001', lat: 34.3, lng: -83.8, name: 'ACME', city: 'GAINESVILLE', spots: 1, lbs: 100 },
      { id: 3, n: 'S003', lat: 34.0, lng: -84.1, name: 'OTHER', city: 'DULUTH', spots: 1, lbs: 100 },
    ],
    loads: [{ id: 'L1', route: 'NORTH', driver: 'Ann Lee', cls: 'box_truck' }, { id: 'L2', route: 'SOUTH', driver: 'Bo Tan', cls: 'box_truck' }],
    plans: { driven: { L1: [1, 2], L2: [3] }, claude: { L1: [1], L2: [2, 3] } },
    unplanned: [],
  };
  const here = storiesAt(m, 1);
  assert.deepEqual(here.map((x) => x.stop.id), [1, 2], 'the tapped stop first, then the other order at that point');
  assert.deepEqual(here.map((x) => [x.driven.route, x.claude.route]), [['NORTH', 'NORTH'], ['NORTH', 'SOUTH']]);
  assert.deepEqual(storiesAt(m, 3).map((x) => x.stop.id), [3], 'a stop alone at its point is just itself');
  assert.deepEqual(storiesAt(m, 99), []);
});

test('REVIEW: every stop’s title names its truck and driver — colour alone never identifies one', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r);
  for (const plan of ['driven', 'claude']) {
    for (const f of planGeo(m, plan).features.filter((x) => x.properties.kind === 'stop')) {
      const l = m.loads.find((x) => x.id === f.properties.loadId);
      assert.ok(f.properties.title.includes(`${l.route} (${l.driver})`), f.properties.title);
    }
  }
});

// ── ROUTE BY ROUTE (v1.73.0). Chad: "a way to pull up one route and see the differences on a route by
// route basis … the routes, the stop counts on them, the skid counts on them, the weights, the loose
// pieces, everything." What these pin: every number on a route is the STORED measurement or a sum
// of stored stops; the leg-by-leg walk adds back up to the scored miles and minutes; a crossed stop
// shows where it went and where it came from; and the routes are walked problems-first.

test('ROUTES: each route’s numbers per plan are the stored measurement, and every stop carries its skids, loose pieces and customer key', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  for (const l of r.loads) {
    const ml = m.loads.find((x) => x.id === l.id);
    for (const col of ['driven', 'reseq', 'claude']) {
      if (!l[col]) { assert.equal(ml.cols[col], null); continue; }
      for (const k of ['stops', 'spots', 'cap', 'weight', 'miles', 'driveMin', 'routeMin', 'driverMin', 'maxMin', 'overTime', 'maxLbs', 'overWeight']) {
        assert.deepEqual(ml.cols[col][k], l[col][k], `${l.id} ${col} ${k}`);
      }
    }
    assert.equal(ml.cap, p.loads.find((x) => x.id === l.id).cap);
  }
  const s0 = p.stops[0], ms0 = m.stops.find((x) => x.id === s0.id);
  assert.equal(ms0.skids, s0.skids);
  assert.equal(ms0.loose, s0.loose);
  assert.equal(ms0.k, s0.k);
  assert.equal(m.serviceMin, p.serviceMin);
});

test('ROUTES: the leg-by-leg walk of a stored order adds back up to the scored miles and drive minutes, exactly', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  for (const l of m.loads) {
    for (const col of ['driven', 'claude']) {
      const c = l.cols[col];
      if (!c) continue;
      assert.equal(c.legsOk, true, `${l.id} ${col} legs add up`);
      assert.equal(c.legs.length, c.stops);
      const order = m.plans[col][l.id];
      const t = tourLegs(p, order, CFG), cost = tourCost(p, order, CFG);
      assert.equal(t.miles, cost.miles);
      assert.equal(t.driveMin, cost.driveMin);
      assert.ok(c.homeMi > 0, 'the drive home is shown');
    }
  }
  // Without the run's own config there are no legs — never a walk with today's settings instead.
  const bare = backtestMapPayload(p, r);
  assert.equal(bare.loads[0].cols.driven.legs, undefined);
});

test('ROUTES: one route both ways — a crossed stop shows where it went, where Claude’s came from, and the trade partner', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  const north = m.loads.find((l) => l.route === 'NORTH');
  const cmp = routeCompare(m, north.id);
  assert.equal(cmp.change, 'traded');
  assert.equal(cmp.kept, 2);
  assert.equal(cmp.removed.length, 2);
  assert.equal(cmp.added.length, 2);
  for (const x of cmp.removed) { assert.equal(x.status.kind, 'moved'); assert.equal(x.status.to.route, 'SOUTH'); }
  for (const x of cmp.added) { assert.equal(x.status.kind, 'added'); assert.equal(x.status.from.route, 'SOUTH'); }
  assert.deepEqual(cmp.partners.map((x) => [x.route, x.gave, x.took]), [['SOUTH', 2, 2]]);
  // Freight is the sum of the stored stops on each version.
  const sum = (ids, k) => ids.reduce((a, id) => a + (m.stops.find((s) => s.id === id)[k] || 0), 0);
  assert.equal(cmp.freight.driven.lbs, sum(m.plans.driven[north.id], 'lbs'));
  assert.equal(cmp.freight.claude.skids, sum(m.plans.claude[north.id], 'skids'));
  assert.equal(cmp.freight.driven.orders, 4);
  // Elapsed = drive so far + the on-site minutes of the stops before it (not a clock time).
  const legs = north.cols.driven.legs;
  assert.equal(cmp.dispatch[0].elapsedMin, Math.round(legs[0].min));
  assert.equal(cmp.dispatch[2].elapsedMin, Math.round(legs[0].min + legs[1].min + legs[2].min + m.serviceMin * 2));
  // Kept stops name their place on the other side.
  const k = cmp.dispatch.find((x) => x.status.kind === 'kept');
  assert.equal(m.plans.claude[north.id][k.status.otherSeq - 1], k.stop.id);
  assert.equal(routeCompare(m, 'nope'), null);
});

test('ROUTES: a truck Claude parked, a stop it left unplanned, a customer it split — each flagged on the route', () => {
  const { p } = built();
  const all = p.stops.map((s) => s.id);
  const left = all[0];
  const plan = { loads: [{ load: 'L1', stops: all.filter((id) => id !== left) }], unplanned: [{ stop: left, reason: 'no room' }] };
  const r = { ...compareBacktest(p, plan, CFG, { perMile: null, perDriveHour: null }), at: 'x', jobId: 'bt__x' };
  const m = backtestMapPayload(p, r, CFG);
  const parked = routeCompare(m, 'L2');
  assert.equal(parked.change, 'parked');
  assert.ok(parked.flags.some((f) => f.key === 'parked'));
  const owner = m.loads.find((l) => m.plans.driven[l.id].includes(left));
  assert.ok(routeCompare(m, owner.id).flags.some((f) => f.key === 'unplanned' && f.level === 'red'));
  // A customer split: give two of L1's stops one customer key, then put one of them on L2.
  const m2 = JSON.parse(JSON.stringify(backtestMapPayload(p, r, CFG)));
  const [a, b] = m2.plans.claude.L1;
  m2.stops.find((s) => s.id === a).k = 'SAME DOCK';
  m2.stops.find((s) => s.id === b).k = 'SAME DOCK';
  m2.plans.claude.L1 = m2.plans.claude.L1.filter((id) => id !== b);
  m2.plans.claude.L2 = [b];
  assert.deepEqual(customerSplits(m2, 'claude').get('SAME DOCK'), ['L1', 'L2']);
  assert.ok(routeCompare(m2, 'L1').flags.some((f) => f.key === 'split'));
});

test('ROUTES: near and over a limit are flagged on Claude’s version — 95% is amber, over is red', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  const L = m.loads[0];
  L.cols.claude = { ...L.cols.claude, spots: 0.96 * L.cols.claude.cap, over: false, weight: 100, maxLbs: 10000, overWeight: false, driverMin: 100, maxMin: 600, overTime: false };
  const near = routeCompare(m, L.id).flags.find((f) => f.key === 'cap');
  assert.equal(near.level, 'amber');
  L.cols.claude = { ...L.cols.claude, overWeight: true, weight: 10400, overTime: true, driverMin: 700 };
  const f = routeCompare(m, L.id).flags;
  assert.equal(f.find((x) => x.key === 'lbs').level, 'red');
  assert.equal(f.find((x) => x.key === 'day').level, 'red');
});

test('ROUTES: freight counts orders AND addresses, and says how many orders had no count recorded', () => {
  const m = {
    stops: [
      { id: 1, k: 'ACME', lat: 1, lng: 1, skids: 2, loose: 10, spots: 3, lbs: 500 },
      { id: 2, k: 'ACME', lat: 1, lng: 1, skids: 0, loose: 0, spots: 0, lbs: 0 },
      { id: 3, k: 'OTHER', lat: 2, lng: 2, skids: 1.5, loose: 0, spots: 1.5, lbs: 250 },
    ],
  };
  assert.deepEqual(freightOf(m, [1, 2, 3]), { orders: 3, addresses: 2, skids: 3.5, loose: 10, spots: 4.5, lbs: 750, noCount: 1 });
});

test('ROUTES: walked problems first — red, then amber, then most traded, then order-only, then unchanged; ties by miles saved', () => {
  const row = (id, o) => ({ id, route: id, driver: '', inn: 0, out: 0, deltaMi: 0, red: 0, amber: 0, change: 'same', ...o });
  const rows = [
    row('SAME'), row('ORDER', { change: 'reordered', deltaMi: -9 }), row('TRADE2', { change: 'traded', inn: 1, out: 1 }),
    row('TRADE9', { change: 'traded', inn: 5, out: 4 }), row('AMBER', { amber: 1, change: 'traded', inn: 1 }), row('RED', { red: 1 }),
  ];
  assert.deepEqual(sortRoutes(rows).map((x) => x.id), ['RED', 'AMBER', 'TRADE9', 'TRADE2', 'ORDER', 'SAME']);
  assert.deepEqual(sortRoutes(rows, 'route').map((x) => x.id), ['AMBER', 'ORDER', 'RED', 'SAME', 'TRADE2', 'TRADE9']);
  assert.equal(sortRoutes(rows, 'miles')[0].id, 'ORDER');
  assert.equal(sortRoutes(rows, 'traded')[0].id, 'TRADE9');
});

test('ROUTES: opening a route colours it first and its biggest trade partners after, and says how many got no colour', () => {
  const partners = Array.from({ length: 10 }, (_, i) => ({ loadId: `P${i}`, gave: 10 - i, took: 0 }));
  const f = focusPicks({ load: { id: 'ME' }, partners });
  assert.equal(f.next.get('ME'), 0);
  assert.equal(f.next.size, MAX_SELECTED);
  assert.equal(f.next.get('P0'), 1);
  assert.equal(f.left, 3);
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  const b = focusBounds(m, m.loads[0].id);
  assert.ok(b.north > b.south && b.east > b.west);
  assert.equal(fmtHm(125), '2:05');
  // Missing is never zero (Number(null) is 0, and 0 is finite — CLAUDE.md's own example).
  for (const v of [null, undefined, '', 'x']) assert.equal(fmtHm(v), '—', String(v));
  assert.equal(fmtHm(0), '0:00');
});

test('ROUTES: every route becomes one row with both versions’ freight and the scored numbers', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  const rows = routeRows(m);
  assert.equal(rows.length, m.loads.length);
  for (const row of rows) {
    const L = m.loads.find((l) => l.id === row.id);
    assert.equal(row.d.miles, L.cols.driven.miles);
    assert.equal(row.c.miles, L.cols.claude.miles);
    assert.equal(row.deltaMi, Math.round((L.cols.claude.miles - L.cols.driven.miles) * 10) / 10);
    assert.equal(row.inn + row.out, 4);
  }
});

// ── review of the route view (2026-09-26): what a dispatcher would have been misled by ──

test('REVIEW ROUTES: near a limit only counts when Claude made it tighter — the same load as yours is information, and does not sort first', () => {
  const { p, r } = built();
  const m = backtestMapPayload(p, r, CFG);
  const L = m.loads[0];
  L.cols.driven = { ...L.cols.driven, spots: 0.97 * L.cols.driven.cap, cap: L.cols.driven.cap };
  L.cols.claude = { ...L.cols.claude, spots: 0.97 * L.cols.claude.cap, over: false };
  const same = routeCompare(m, L.id).flags.find((f) => f.key === 'cap');
  assert.equal(same.level, 'info');
  assert.match(same.text, /no tighter than yours/);
  L.cols.claude = { ...L.cols.claude, spots: 0.99 * L.cols.claude.cap };
  assert.equal(routeCompare(m, L.id).flags.find((f) => f.key === 'cap').level, 'amber');
});

test('REVIEW ROUTES: a customer split you also split is information; a split only Claude made is flagged', () => {
  const { p, r } = built();
  const m = JSON.parse(JSON.stringify(backtestMapPayload(p, r, CFG)));
  const [a] = m.plans.claude.L1, [b] = m.plans.claude.L2;
  m.stops.find((s) => s.id === a).k = 'SAME DOCK';
  m.stops.find((s) => s.id === b).k = 'SAME DOCK';
  const dispatchSplitToo = customerSplits(m, 'driven').has('SAME DOCK');
  const f = routeCompare(m, 'L1').flags.find((x) => x.key === 'split');
  assert.equal(f.level, dispatchSplitToo ? 'info' : 'amber');
  // Put both on one dispatch truck: now the split is Claude's alone.
  for (const [id, ids] of Object.entries(m.plans.driven)) m.plans.driven[id] = ids.filter((x) => x !== a && x !== b);
  m.plans.driven.L1.push(a, b);
  assert.equal(routeCompare(m, 'L1').flags.find((x) => x.key === 'split').level, 'amber');
});

test('REVIEW ROUTES: a parked truck with a stop left unplanned says both, and a parked truck is not "most miles saved"', () => {
  const { p } = built();
  const all = p.stops.map((s) => s.id);
  const owner = p.loads.find((l) => l.route === 'SOUTH');
  const left = owner.dispatch[0];
  const plan = { loads: [{ load: p.loads.find((l) => l.route === 'NORTH').id, stops: all.filter((id) => id !== left) }], unplanned: [{ stop: left, reason: 'no room' }] };
  const r = { ...compareBacktest(p, plan, CFG, { perMile: null, perDriveHour: null }), at: 'x', jobId: 'bt__x' };
  const m = backtestMapPayload(p, r, CFG);
  const parked = routeCompare(m, owner.id);
  const f = parked.flags.find((x) => x.key === 'parked');
  assert.match(f.text, /3 of its 4 orders ride other trucks, 1 left unplanned/);
  const rows = routeRows(m);
  assert.equal(rows.find((x) => x.id === owner.id).deltaMi, null, 'no comparable miles for a parked truck');
  assert.notEqual(sortRoutes(rows, 'miles')[0].id, owner.id);
});

test('REVIEW ROUTES: a stop on none of Claude’s trucks (and not unplanned) is a change and a red flag — never "same stops"', () => {
  const { p, r } = built();
  const m = JSON.parse(JSON.stringify(backtestMapPayload(p, r, CFG)));
  // Claude's L1 = dispatch's L1 exactly, but one of dispatch's L1 stops is dropped from every Claude truck.
  const d1 = m.plans.driven.L1;
  for (const id of Object.keys(m.plans.claude)) m.plans.claude[id] = m.plans.claude[id].filter((x) => !d1.includes(x));
  m.plans.claude.L1 = d1.slice(1);
  const cmp = routeCompare(m, 'L1');
  assert.notEqual(cmp.change, 'same');
  assert.notEqual(cmp.change, 'reordered');
  assert.equal(cmp.removed.length, 1);
  assert.equal(cmp.removed[0].status.kind, 'missing');
  assert.ok(cmp.flags.some((x) => x.key === 'missing' && x.level === 'red'));
});

test('REVIEW ROUTES: an order with no map point is tied to ITS truck — even when two drivers ran one route name', () => {
  seq = 0;
  const rows = [
    row('ATL1', 'Ann Lee', 34.30, -83.82), row('ATL1', 'Ann Lee', 34.31, -83.83), { ...row('ATL1', 'Ann Lee', null, null) },
    row('ATL1', 'Bo Tan', 34.02, -84.12), row('ATL1', 'Bo Tan', 34.03, -84.11),
  ];
  const p = buildBacktestProblem({
    date: D, rows, roster: null, stamp: 'x', learnDaysBefore: [], caps: null, loosePerSkid: 10, capRule: 'tighter',
    employees: [], notes: new Map(), depot: DEPOT, at: '2026-09-25T00:00:00Z', cfg: CFG,
  });
  const ann = p.loads.find((l) => l.driver === 'Ann Lee'), bo = p.loads.find((l) => l.driver === 'Bo Tan');
  assert.equal(p.excluded.noCoords.length, 1);
  assert.equal(p.excluded.noCoords[0].load, ann.id);
  const plan = { loads: [{ load: ann.id, stops: ann.dispatch }, { load: bo.id, stops: bo.dispatch }], unplanned: [] };
  const r = { ...compareBacktest(p, plan, CFG, { perMile: null, perDriveHour: null }), at: 'x', jobId: 'bt__x' };
  const m = backtestMapPayload(p, r, CFG);
  assert.equal(routeCompare(m, ann.id).noCoords.length, 1);
  assert.equal(routeCompare(m, bo.id).noCoords.length, 0, 'Bo’s truck does not inherit Ann’s unmapped order');
  // A day stored before the load id was recorded: matched by name, and the flag says it cannot tell which truck.
  const old = JSON.parse(JSON.stringify(m));
  delete old.excluded.noCoords[0].load;
  const f = routeCompare(old, bo.id).flags.find((x) => x.key === 'nocoords');
  assert.match(f.text, /2 trucks ran ATL1, and the stored record cannot say which/);
});
