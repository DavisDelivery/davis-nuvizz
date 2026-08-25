// Phase 2.13 — the experiment knobs. Every knob defaults OFF and must be
// byte-inert at its default (the 2.9.0 lesson: plausible solver changes lose
// real agreement, so nothing moves the nightly until a labeled replay says so).
// These tests pin the OFF-identity and the ON-direction of each lever, plus the
// tie-margin diagnostic that bounds what any solver can ever agree on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveAssignment, candidateRankFrac, habitShareFor, habitStrength,
} from '../netlify/functions/lib/routing-assignment-solver.mts';
import { territoryMapsAsOf, candidateDriversFor, fleetTripChain } from '../netlify/functions/lib/routing-envelope.mts';
import { habitAsOf } from '../netlify/functions/lib/routing-customer-drivers.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';
import { superOfZone, zoneId } from '../netlify/functions/lib/zones.mts';

const CFG = engineConfigDefaults({});
const PREC = { zone_precision: 6, super_precision: 5, top_precision: 4 };
const DEPOT = { lat: 34.148, lng: -83.959 };

const ENV = () => ({ driver_key: '', source: 'driver', truck_class: null, observed_days: 20, per_trip: { stops_median: 12, stops_p85: 16, pallets_median: 8, pallets_p85: 12, weight_median: 6000, weight_p85: 9000, weight_max: 9500, skid_equiv_p85: null, skid_equiv_max: null }, trips_per_day_propensity: 0.3, start_minute_typical: 240, shift_hours_typical: 10, day_weight_p85: 14000, day_skids_p85: null, day_loose_p85: null });

function drv(key, affinity = new Map()) {
  return { driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck', start_minute: 240, envelope: ENV(), affinity };
}
function aStop(id, o = {}) {
  const lat = o.lat ?? 34.1, lng = o.lng ?? -84.0;
  const z = zoneId(lat, lng, PREC);
  return { id, lat, lng, zone: z, gh5: superOfZone(z, PREC), pallets: o.pallets ?? 2, skids: o.skids ?? 2, loose: 0, weight: o.weight ?? 1000, matchKey: id, strict: false, miles: o.miles ?? 20, blocksTractor: false, habit: o.habit ?? null, candidates: o.candidates };
}
function solve(stops, drivers, cfg) {
  return solveAssignment({ date: '2026-08-20', stops, drivers, fleetChain: fleetTripChain([], '2026-08-20', cfg), cfg, depot: DEPOT, serviceMedianFor: () => 15 });
}
const driverOf = (res, stopId) => {
  for (const sh of res.shifts) for (const t of sh.trips) if (t.stops.some((s) => s.id === stopId)) return sh.driver.driver_key;
  return null;
};

// ── OFF-identity ─────────────────────────────────────────────────────────────

test('knobs OFF: the ranked habit drivers list is INERT — same plan with or without it', () => {
  const gh5 = aStop('x').gh5;
  const A = drv('A', new Map([[gh5, 0.6]]));
  const B = drv('B', new Map([[gh5, 0.4]]));
  const habitBare = { topDriver: 'A', topShare: 0.5, n: 20 };
  const habitRanked = { ...habitBare, drivers: [{ key: 'A', share: 0.5 }, { key: 'B', share: 0.45 }] };
  const mk = (habit) => [aStop('s1', { habit }), aStop('s2', { habit }), aStop('s3')];
  const r1 = solve(mk(habitBare), [A, B], CFG);
  const r2 = solve(mk(habitRanked), [A, B], CFG);
  const shape = (r) => r.shifts.map((sh) => [sh.driver.driver_key, sh.trips.map((t) => t.stops.map((s) => s.id))]);
  assert.deepEqual(shape(r1), shape(r2), 'defaults must not read the new field');
  assert.equal(r1.cost, r2.cost);
});

// ── rank-aware candidate cost ────────────────────────────────────────────────

test('candidateRankFrac: 0 at cast rank 1 → 1 at the tail; off-cast = 1; open cast = 0', () => {
  const s = aStop('x', { candidates: ['A', 'B', 'C'] });
  assert.equal(candidateRankFrac(s, 'A'), 0);
  assert.equal(candidateRankFrac(s, 'B'), 0.5);
  assert.equal(candidateRankFrac(s, 'C'), 1);
  assert.equal(candidateRankFrac(s, 'ZZ'), 1, 'outside a non-empty cast');
  assert.equal(candidateRankFrac(aStop('y', { candidates: [] }), 'A'), 0, 'open cast carries no rank signal');
  assert.equal(candidateRankFrac(aStop('z', { candidates: ['A'] }), 'A'), 0, 'a one-driver cast has no tail');
});

test('w_candidate_rank ON: the cast #1 takes a stop that stray affinity handed to the cast #3', () => {
  // The 2.9.0 failure in miniature: C (cast rank 3) has the affinity edge and
  // wins under binary membership; rank-aware cost hands it back to A (rank 1).
  const gh5 = aStop('x').gh5;
  const A = drv('A', new Map([[gh5, 0.3]]));
  const B = drv('B');
  const C = drv('C', new Map([[gh5, 0.9]]));
  const stops = [aStop('s1', { candidates: ['A', 'B', 'C'] })];
  const off = solve(stops, [A, B, C], CFG);
  assert.equal(driverOf(off, 's1'), 'C', 'binary membership: the affinity edge wins');
  const on = solve(stops, [A, B, C], { ...CFG, w_candidate_rank: 3 });
  assert.equal(driverOf(on, 's1'), 'A', 'rank-aware: the cast #1 wins');
});

// ── habit runner-up ──────────────────────────────────────────────────────────

test('habitShareFor: the driver\'s own share, 0 when unranked or the list is absent', () => {
  const habit = { drivers: [{ key: 'T', share: 0.55 }, { key: 'R', share: 0.4 }] };
  assert.equal(habitShareFor(habit, 'R'), 0.4);
  assert.equal(habitShareFor(habit, 'r'), 0.4, 'case-folded');
  assert.equal(habitShareFor(habit, 'ZZ'), 0);
  assert.equal(habitShareFor({ topDriver: 'T', topShare: 0.5, n: 9 }, 'T'), 0, 'no ranked list = no share');
});

test('habit_rank_aware ON: with the usual driver OUT, the customer goes to their #2, not a stranger', () => {
  // Customer history: T 55%, R 40%. T is not working today. Under top-only habit
  // both R and the stranger X pay the identical full charge, so X's slight
  // affinity edge wins the stop; rank-aware habit knows R is the runner-up.
  const gh5 = aStop('x').gh5;
  const habit = { topDriver: 'T', topShare: 0.55, n: 20, drivers: [{ key: 'T', share: 0.55 }, { key: 'R', share: 0.4 }] };
  const R = drv('R', new Map([[gh5, 0.5]]));
  const X = drv('X', new Map([[gh5, 0.6]]));
  const stops = [aStop('s1', { habit, candidates: ['R', 'X'] })];
  const off = solve(stops, [R, X], CFG);
  assert.equal(driverOf(off, 's1'), 'X', 'top-only habit cannot tell R from a stranger');
  const on = solve(stops, [R, X], { ...CFG, habit_rank_aware: 1 });
  assert.equal(driverOf(on, 's1'), 'R', 'the runner-up keeps their customer');
});

test('habitAsOf: exposes the ranked share list alongside the top fields, leakage guard intact', () => {
  const doc = { obs: [
    { d: '2026-08-01', u: 'T', name: 'T' }, { d: '2026-08-02', u: 'T', name: 'T' },
    { d: '2026-08-03', u: 'R', name: 'R' },
    { d: '2026-08-30', u: 'ZZ', name: 'ZZ' },   // ≥ asOf — must not leak
  ] };
  const h = habitAsOf(doc, '2026-08-20');
  assert.equal(h.topDriver, 'T');
  assert.equal(h.n, 3, 'the future observation is excluded');
  assert.deepEqual(h.drivers.map((d) => d.key), ['T', 'R']);
  assert.ok(h.drivers[0].share > h.drivers[1].share);
});

// ── territory recency decay ──────────────────────────────────────────────────

test('territory_half_life_days: a driver who LEFT the zone loses the top slot to who runs it now', () => {
  const cell = { lat: 34.30, lng: -83.70 };
  const ref = (key, date, n) => ({ tenant: 'davis', date, driver_user_name: key, driver_name: key, stops: Array.from({ length: n }, (_, i) => ({ pro: `${key}${date}${i}`, lat: cell.lat, lng: cell.lng, zone: 'z' })) });
  const refs = [
    ref('OLD_GUY', '2026-04-20', 10),   // 10 visits, ~4 months back
    ref('NEW_GUY', '2026-08-18', 3),    // 3 visits, last week
  ];
  const roster = new Set(['OLD_GUY', 'NEW_GUY']);
  const flat = territoryMapsAsOf(refs, '2026-08-25');
  const decayed = territoryMapsAsOf(refs, '2026-08-25', 30);
  const top = (maps) => candidateDriversFor(cell.lat, cell.lng, null, maps, roster, { zoneK: 2, areaK: 1 })[0];
  assert.equal(top(flat), 'OLD_GUY', 'all-history counts: the departed driver still owns the cell');
  assert.equal(top(decayed), 'NEW_GUY', '30-day half-life: the current cast owns it');
  // halfLife 0 (the default) is byte-identical to the two-arg call
  assert.deepEqual(territoryMapsAsOf(refs, '2026-08-25', 0), flat);
});

// ── tie margin ───────────────────────────────────────────────────────────────

test('tie_margin: a genuine coin flip reads as a near-tie; a one-driver cast records nothing', () => {
  const gh5 = aStop('x').gh5;
  const A = drv('A', new Map([[gh5, 0.5]]));
  const B = drv('B', new Map([[gh5, 0.5]]));   // identical pull — dispatch could pick either
  const near = solve([aStop('s1', { candidates: ['A', 'B'] })], [A, B], CFG);
  assert.equal(near.tie_margin.stops, 1);
  assert.ok(near.tie_margin.mean < 0.01, `identical drivers ⇒ ~0 margin, got ${near.tie_margin.mean}`);
  assert.equal(near.tie_margin.share_lt_05, 1);

  const solo = solve([aStop('s2', { candidates: ['A'] })], [A, B], CFG);
  assert.equal(solo.tie_margin, null, 'one candidate = no margin to measure');

  // Unseen geography: every driver passes the open fallback and the scores
  // differ only by 1e-6 jitter — that is NO SIGNAL, not a coin flip, and it
  // must not inflate the near-tie share the Assist gate reads.
  const open = solve([aStop('s4', { candidates: [] })], [drv('A'), drv('B')], CFG);
  assert.equal(open.tie_margin, null, 'an open cast records no margin');

  const clear = solve([aStop('s3', { habit: { topDriver: 'A', topShare: 0.9, n: 30 }, candidates: ['A', 'B'] })], [A, B], CFG);
  assert.ok(clear.tie_margin.mean > 1, `a strong habit edge is not a tie, got ${clear.tie_margin.mean}`);
});

test('knobs ON stay deterministic: identical runs produce identical plans', () => {
  const gh5 = aStop('x').gh5;
  const A = drv('A', new Map([[gh5, 0.4]]));
  const B = drv('B', new Map([[gh5, 0.6]]));
  const cfg = { ...CFG, w_candidate_rank: 2, habit_rank_aware: 1, territory_half_life_days: 30 };
  const mk = () => solve([aStop('s1', { candidates: ['A', 'B'] }), aStop('s2'), aStop('s3', { candidates: ['B', 'A'] })], [A, B], cfg);
  const shape = (r) => JSON.stringify({ s: r.shifts.map((sh) => [sh.driver.driver_key, sh.trips.map((t) => t.stops.map((x) => x.id))]), c: r.cost, t: r.tie_margin });
  assert.equal(shape(mk()), shape(mk()));
});
