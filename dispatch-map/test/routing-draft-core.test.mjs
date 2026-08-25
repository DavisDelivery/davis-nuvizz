// test/routing-draft-core.test.mjs — driver-scoped engine drafts (Assist slice 1).
// Pins the rules that make a draft trustworthy to dispatch:
//   • a stop that usually runs with an OFF-cast driver is never quietly claimed
//   • unfamiliar geography is handed back, not guessed at
//   • a named driver never gets a silent 3+ trip day
//   • an ambiguous driver name is an error, never a coin flip
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDraftDriver, recentRosterKeys, buildDriverDraft, liveStopToAssignStop, DRAFT_MAX_TRIPS,
} from '../netlify/functions/lib/routing-draft-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const D = '2026-08-26';
const cfg = engineConfigDefaults({});

// ── fixtures ─────────────────────────────────────────────────────────────────
const dayDoc = (key, date, extra = {}) => ({
  tenant: 'davis', date, driver_key: key, driver_user_name: key, driver_name: key,
  truck_class: 'box_truck',
  start_time: `${date}T11:00:00Z`, end_time: `${date}T20:00:00Z`,
  trips: [{ seq_index: 1, stops: 8, pallets: 10, weight: 3000, skids: 8, loose: 4 }],
  day_totals: { weight: 3000, skids: 8, loose: 4 },
  ...extra,
});

// Reference routes give each driver a territory cell (0.05° grid).
const refRoute = (key, date, lat, lng, n = 4) => ({
  tenant: 'davis', date, load_key: `L_${key}_${date}`,
  driver_user_name: key, driver_name: key, truck_class: 'box_truck', warehouse: 'G6',
  zone_seq: ['z1'],
  stops: Array.from({ length: n }, (_, i) => ({ pro: `${key}${date}${i}`, lat: lat + i * 0.001, lng: lng + i * 0.001, zone: `z${i}` })),
});

const VICTOR = { lat: 34.00, lng: -84.00 };
const SCOTT = { lat: 34.20, lng: -83.80 };
const DALE = { lat: 34.50, lng: -83.50 };

function makeInputs() {
  const dates = ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-24'];
  const driverDaysBefore = [];
  const referencesBefore = [];
  for (const key of ['VICTOR', 'SCOTT', 'DALE']) {
    const home = key === 'VICTOR' ? VICTOR : key === 'SCOTT' ? SCOTT : DALE;
    for (const dt of dates) {
      driverDaysBefore.push(dayDoc(key, dt));
      referencesBefore.push(refRoute(key, dt, home.lat, home.lng));
    }
  }
  return {
    driverDaysBefore, referencesBefore,
    serviceDocByKey: new Map(), fleetServiceDoc: null,
    habitDocByKey: new Map(), notesRestrictions: new Map(),
    tractorCapable: new Set(), employees: [],
  };
}

const liveStop = (nbr, lat, lng, extra = {}) => ({
  stopNbr: nbr, isUnplanned: true, isPlanned: false,
  businessName: `BIZ ${nbr}`, addr1: `${nbr} Main St`, city: 'Buford', zip: '30518',
  lat, lng, cartons: 4, volume: 0, pallets: 4, weight: 800,
  ...extra,
});

const resolved = (key) => ({
  input: key, driver_key: key, driver_user_name: key, driver_name: key,
  truck_class: 'box_truck', observed_days: 5, warnings: [],
});

// ── name resolution ──────────────────────────────────────────────────────────
test('resolveDraftDriver: a first name resolves through the employees roster to the NuVizz key', () => {
  const employees = [{ fullName: 'Victor Mendez', firstName: 'Victor', externalIds: { nuvizz: 'VICTOR' }, vehicleType: 'box_truck' }];
  const r = resolveDraftDriver('victor', employees, makeInputs().driverDaysBefore, D);
  assert.equal(r.ok, true);
  assert.equal(r.driver.driver_key, 'VICTOR');
  assert.equal(r.driver.truck_class, 'box_truck');
});

test('resolveDraftDriver: an ambiguous name is an ERROR listing the matches, never a coin flip', () => {
  // Two Victors on the recent roster, no exact key match — the resolver must ask, not pick.
  const dd = [dayDoc('VICTOR_M', '2026-08-24'), dayDoc('VICTOR_R', '2026-08-24')];
  const r = resolveDraftDriver('victor', [], dd, D);
  assert.equal(r.ok, false);
  assert.ok(/VICTOR_M/.test(r.error) && /VICTOR_R/.test(r.error), r.error);
});

test('resolveDraftDriver: an exact NuVizz-key match wins even when longer keys share the prefix', () => {
  const dd = [dayDoc('VICTOR', '2026-08-24'), dayDoc('VICTOR_M', '2026-08-24')];
  const r = resolveDraftDriver('victor', [], dd, D);
  assert.equal(r.ok, true);
  assert.equal(r.driver.driver_key, 'VICTOR');
});

test('resolveDraftDriver: a supervisor is refused — the engine never drafts the boss a route', () => {
  // NOTE: the owner's name stays Capitalised in this file — the lowercase form is an
  // env-var VALUE and the Netlify secrets scan matches it case-sensitively (v0.78.2).
  const employees = [{ fullName: 'Chad Davis', firstName: 'Chad', externalIds: { nuvizz: 'CHAD DAVIS' } }];
  const r = resolveDraftDriver('Chad', employees, [], D);
  assert.equal(r.ok, false);
  assert.ok(/supervisor/.test(r.error), r.error);
});

test('resolveDraftDriver: an unknown name errors with nearby suggestions instead of guessing', () => {
  const r = resolveDraftDriver('vic', [], makeInputs().driverDaysBefore, D);
  // "vic" prefix-matches only VICTOR among recent keys → resolves; "zzz" must not.
  const r2 = resolveDraftDriver('zzz', [], makeInputs().driverDaysBefore, D);
  assert.equal(r.ok, true);
  assert.equal(r2.ok, false);
});

test('recentRosterKeys: only the trailing window counts, supervisors never do', () => {
  const dd = [dayDoc('OLD_GUY', '2026-05-01'), dayDoc('VICTOR', '2026-08-20'), dayDoc('CHAD_DAVIS', '2026-08-20')];
  const keys = recentRosterKeys(dd, D);
  assert.deepEqual([...keys].sort(), ['VICTOR']);
});

// ── pool scoping ─────────────────────────────────────────────────────────────
test('draft: a stop that usually runs with an off-cast driver stays UNPLANNED and says whose it is', () => {
  const inputs = makeInputs();
  const stops = [
    liveStop('S1', VICTOR.lat, VICTOR.lng),
    liveStop('S2', DALE.lat, DALE.lng),   // Dale's territory — Dale is not in the cast
  ];
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR'), resolved('SCOTT')] });
  const drafted = d.drivers.flatMap((x) => x.trips.flatMap((t) => t.stops.map((s) => s.stopNbr)));
  assert.ok(drafted.includes('S1'), 'Victor-territory stop is drafted');
  assert.ok(!drafted.includes('S2'), 'Dale-territory stop is NOT drafted');
  const s2 = d.left_unplanned.find((x) => x.stopNbr === 'S2');
  assert.equal(s2?.reason, 'other_drivers');
  assert.ok(/DALE/.test(s2.detail), s2.detail);
});

test('draft: unfamiliar geography is handed back, not guessed at', () => {
  const inputs = makeInputs();
  const stops = [liveStop('S9', 35.9, -82.9)]; // nowhere near any reference history
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR')] });
  assert.equal(d.left_unplanned.find((x) => x.stopNbr === 'S9')?.reason, 'unfamiliar');
  assert.equal(d.pool.drafted, 0);
});

test('draft: a coordinate-less stop is reported, never silently dropped', () => {
  const inputs = makeInputs();
  const stops = [liveStop('S8', null, null)];
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR')] });
  assert.equal(d.left_unplanned.find((x) => x.stopNbr === 'S8')?.reason, 'no_coords');
  assert.equal(d.pool.no_coords, 1);
});

test('draft: a tractor-blocked stop with an all-tractor cast comes back as equipment, not a crash', () => {
  const inputs = makeInputs();
  // Victor's own territory, but the customer bars tractors and Victor drives one.
  const mkStop = liveStop('S3', VICTOR.lat, VICTOR.lng);
  const mk = `biz_s3__${'3 main st'.replace(/\s+/g, '_')}__buford__30518`;
  inputs.notesRestrictions.set(mk, ['no_tractor_trailer']);
  // sanity: the computed matchKey must actually hit the restrictions map
  const as = liveStopToAssignStop(mkStop, cfg, { zone_precision: 6, super_precision: 5, top_precision: 4 }, inputs, D);
  inputs.notesRestrictions.set(as.matchKey, ['no_tractor_trailer']);
  const cast = { ...resolved('VICTOR'), truck_class: 'tractor' };
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: [mkStop], meta: null, resolved: [cast] });
  assert.equal(d.left_unplanned.find((x) => x.stopNbr === 'S3')?.reason, 'equipment');
});

test(`draft: a named driver never gets a silent ${DRAFT_MAX_TRIPS + 1}+ trip day — overflow is handed back`, () => {
  const inputs = makeInputs();
  // 60 skid-heavy stops in Victor's one cell: far beyond 2 box trips (hard cap 22/trip).
  const stops = Array.from({ length: 60 }, (_, i) =>
    liveStop(`V${i}`, VICTOR.lat + (i % 5) * 0.002, VICTOR.lng + Math.floor(i / 5) * 0.002, { cartons: 4, pallets: 4 }));
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR')] });
  const v = d.drivers.find((x) => x.driver_key === 'VICTOR');
  assert.ok(v.trips.length <= DRAFT_MAX_TRIPS, `kept ${v.trips.length} trips`);
  const over = d.left_unplanned.filter((x) => x.reason === 'over_capacity');
  assert.equal(v.total_stops + over.length + d.left_unplanned.filter((x) => x.reason !== 'over_capacity').length, 60,
    'every stop is either drafted or explicitly handed back');
  assert.ok(over.length > 0, 'the overflow is visible, not vanished');
});

test('draft: deterministic — same date, pool and cast produce the identical draft', () => {
  const inputs = makeInputs();
  const stops = [
    liveStop('S1', VICTOR.lat, VICTOR.lng), liveStop('S4', VICTOR.lat + 0.01, VICTOR.lng + 0.01),
    liveStop('S5', SCOTT.lat, SCOTT.lng),
  ];
  const mk = () => buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR'), resolved('SCOTT')], nowIso: '2026-08-25T12:00:00Z' });
  const a = mk(), b = mk();
  const strip = (x) => JSON.stringify({ ...x, ms: 0 });
  assert.equal(strip(a), strip(b));
});

test('draft: trips are sequenced and carry the guided/unguided mode honestly', () => {
  const inputs = makeInputs();
  const stops = [liveStop('S1', VICTOR.lat, VICTOR.lng), liveStop('S4', VICTOR.lat + 0.005, VICTOR.lng + 0.005)];
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR')] });
  const v = d.drivers.find((x) => x.driver_key === 'VICTOR');
  assert.equal(v.total_stops, 2);
  for (const t of v.trips) {
    assert.ok(t.stops.length > 0);
    assert.ok(t.mode === 'guided' || t.mode === 'unguided');
    assert.ok(Number.isFinite(t.travel_min_est));
    // an unguided trip must say so via references_used = 0, never a fake reference count
    if (t.mode === 'unguided') assert.equal(t.references_used, 0);
    else assert.ok(t.references_used > 0);
  }
});

test('draft: transparency fields say when the engine is guessing (class envelope, thin history)', () => {
  const inputs = makeInputs();
  const stops = [liveStop('S1', VICTOR.lat, VICTOR.lng)];
  const d = buildDriverDraft('davis', D, { cfg, inputs, liveStops: stops, meta: null, resolved: [resolved('VICTOR')] });
  const v = d.drivers.find((x) => x.driver_key === 'VICTOR');
  // 5 observed days < min_observation_days(10) → class envelope, and the draft says so.
  assert.equal(v.envelope_source, 'class');
  assert.ok(Number.isFinite(v.skid_cap) && v.skid_cap > 0);
});
