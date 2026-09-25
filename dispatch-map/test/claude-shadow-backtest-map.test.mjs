// test/claude-shadow-backtest-map.test.mjs — THE CLAUDE-vs-DISPATCH MAP SHOWS EXACTLY WHAT WAS MEASURED.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch." What these pin:
// the map is built from the stops STORED with the backtest and the result's own per-load orders (so
// it can never drift from the scorecard); a day with no backtest, or whose stored stops are gone,
// says so instead of drawing something; each stop's truck under each plan is right; and colour
// follows the truck, eight at a time, never repainting one you are looking at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBacktestProblem, compareBacktest, backtestMapPayload } from '../netlify/functions/lib/claude-shadow/backtest-core.mts';
import { backtestMap, jobPath, resultPath } from '../netlify/functions/lib/claude-shadow/backtest.mts';
import { effectiveEngineConfig } from '../netlify/functions/lib/routing-engine-config.mts';
import {
  whereIs, planLoads, truckRows, stopStory, storiesAt, orderNote, toggleTruck, pickTrucks, planGeo, boundsOf, MAX_SELECTED, SELECT_COLORS,
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
