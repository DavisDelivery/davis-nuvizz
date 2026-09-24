// test/claude-shadow-learn.test.mjs — WHAT THE CLAUDE SHADOW LEARNS FROM THE SEALED HISTORY.
//
// Chad, 2026-09-24: "truck capacity should be learned from all the data we have", learned "from
// the routes they're assigned to", and loose pieces count: "if they put 17 skids on a box truck,
// you then can't put 30 bags of peanuts as well." Every test names the dock-side mistake it
// prevents: a truck learned twice its size, a cap from three trips, a pickup counted as outbound
// freight, a rolled order counted as carried, a write that lands outside claude_shadow_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  LEARN_VERSION, LEARN_DAYS_COLLECTION, CAPACITY_PATH, LEARN_LAST_PATH, SETTINGS_PATH, HISTORY_STOP_MASK,
  num, tidy, isPickup, rowKind, quantile, sealedDaysFrom, daysToLearn, rosterLoadsOf, rosterNamesFrom, sharedVerdict,
  learnDay, buildCapacityModel, skidSpots, MIN_TRIPS_FOR_CAP, CAP_QUANTILE, RELEARN_RECENT_DAYS,
} from '../netlify/functions/lib/claude-shadow/learn-core.mts';
import { runLearn, planLearn, learnRefusal, loosePerSkidFrom } from '../netlify/functions/lib/claude-shadow/learn.mts';

const row = (o) => ({ status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, stopType: 'DO', routeName: 'BEN 1', loadNbr: 'BEN 1', driverName: 'Ben  Paintsil', driverUserName: 'Ben  Paintsil', ...o });
const roster = (loads) => ({ loadsJson: JSON.stringify(loads) });

// ── what counts as freight that went out ─────────────────────────────────────

test('what a row\u2019s status says: delivered (90/91), unable to deliver (80), still open at the seal (40/50), never left (20/10/99)', () => {
  for (const c of ['90', '91']) assert.equal(rowKind({ status: c }), 'delivered', c);
  assert.equal(rowKind({ status: '80' }), 'unable');
  for (const c of ['40', '50']) assert.equal(rowKind({ status: c }), 'open', c);
  for (const c of ['20', '10', '99']) assert.equal(rowKind({ status: c }), 'neverLeft', c);
  assert.equal(rowKind({ status: '99', normalizedStatus: 'DELIVERED' }), 'neverLeft', 'the raw code wins over the normalised word');
});

test('a row with no raw code falls back on the normalised status, and an unknown code is not guessed at', () => {
  assert.equal(rowKind({ normalizedStatus: 'DELIVERED' }), 'delivered');
  assert.equal(rowKind({ normalizedStatus: 'SCHEDULED' }), 'neverLeft');
  assert.equal(rowKind({ status: '77', normalizedStatus: 'DELIVERED' }), 'unknown');
});

test('a PICKUP takes no outbound room: RA… numbers and stopType PU are left out of a truck’s load', () => {
  assert.equal(isPickup({ stopNbr: 'RA56488430' }), true);
  assert.equal(isPickup({ stopNbr: '007174397', stopType: 'PU' }), true);
  assert.equal(isPickup({ stopNbr: '007174397', stopType: 'DO' }), false);
});

test('num(): no skids recorded is null, never 0 — Number(null) is 0 and 0 is finite', () => {
  for (const v of [null, undefined, '', '  ', 'n/a']) assert.equal(num(v), null, JSON.stringify(v));
  assert.equal(num(0), 0);
  assert.equal(num('17'), 17);
  assert.equal(tidy('Ben  Paintsil '), 'Ben Paintsil', 'NuVizz display names carry doubled spaces');
});

// ── one sealed day → its truck trips ─────────────────────────────────────────

test('CHAD’S PEANUTS: 17 skids and 30 loose bags on one truck are ONE trip of 17 skids + 30 loose', () => {
  const d = learnDay([row({ stopNbr: 'A', cartons: 17 }), row({ stopNbr: 'B', volume: 30 })], '2026-09-23', 's', null, 'now');
  assert.equal(d.trips.length, 1);
  assert.deepEqual({ skids: d.trips[0].skids, loose: d.trips[0].loose, stops: d.trips[0].stops, freightStops: d.trips[0].freightStops }, { skids: 17, loose: 30, stops: 2, freightStops: 2 });
});

test('a trip counts only what rode the truck: the pickup, the rolled order and the cancelled one are out; unable-to-deliver is in', () => {
  const d = learnDay([
    row({ stopNbr: 'A', cartons: 4, deliveredDTTM: '2026-09-23T10:00:00' }),
    row({ stopNbr: 'RA1', stopType: 'PU', cartons: 50 }),
    row({ stopNbr: 'R', status: '20', normalizedStatus: 'SCHEDULED', cartons: 50 }),
    row({ stopNbr: 'X', status: '99', normalizedStatus: 'EXCEPTION', cartons: 50 }),
    row({ stopNbr: 'U', status: '80', normalizedStatus: 'EXCEPTION', cartons: 2, listUpdatedDTTM: '2026-09-23T15:00:00' }),
  ], '2026-09-23', 's', null, 'now');
  assert.equal(d.trips[0].skids, 6);
  assert.equal(d.trips[0].stops, 2);
  assert.deepEqual({ rows: d.counts.rows, pickups: d.counts.pickups, neverLeft: d.counts.neverLeft, ran: d.counts.ran }, { rows: 5, pickups: 1, neverLeft: 2, ran: 2 });
});

test('THE ESTES CARRY-OVER: an order still out-for-delivery at the seal, and one delivered on ANOTHER day, do not ride today\u2019s truck', () => {
  // Tuesday's ESTES order nobody closed keeps its route and driver and is re-filed onto Wednesday;
  // a row stamped delivered on the 27th sealed into the 28th is the next door over.
  const d = learnDay([
    row({ stopNbr: 'A', routeName: 'ESTES', cartons: 10, deliveredDTTM: '2026-07-28T11:00:00' }),
    row({ stopNbr: 'B', routeName: 'ESTES', cartons: 6, status: '40', normalizedStatus: 'OUT_FOR_DEL' }),
    row({ stopNbr: 'C', routeName: 'ESTES', cartons: 4, deliveredDTTM: '2026-07-27T16:00:00' }),
    row({ stopNbr: 'D', routeName: 'ESTES', cartons: 2, deliveredDTTM: '2026-07-28T13:00:00' }),
  ], '2026-07-28', 's', null, 'now');
  assert.equal(d.stampGate, 'applied');
  assert.equal(d.trips[0].skids, 12, 'only the two rows delivered on the 28th');
  assert.deepEqual({ openAtSeal: d.counts.openAtSeal, otherDay: d.counts.otherDay }, { openAtSeal: 1, otherDay: 1 });
});

test('the stamp test SWITCHES ITSELF OFF on a day where most delivered rows carry no same-day stamp — and says so', () => {
  const d = learnDay([
    row({ stopNbr: 'A', cartons: 10 }), row({ stopNbr: 'B', cartons: 10 }), row({ stopNbr: 'C', cartons: 10, deliveredDTTM: '2026-07-28T11:00:00' }),
  ], '2026-07-28', 's', null, 'now');
  assert.equal(d.stampGate, 'off');
  assert.equal(d.trips[0].skids, 30);
});

test('unable-to-deliver counts only when its last update is on the day: an 80 closed out on another day did not ride this truck', () => {
  const d = learnDay([
    row({ stopNbr: 'A', cartons: 10, deliveredDTTM: '2026-09-23T10:00:00' }),
    row({ stopNbr: 'U', status: '80', cartons: 5, listUpdatedDTTM: '2026-09-22T17:00:00' }),
  ], '2026-09-23', 's', null, 'now');
  assert.equal(d.trips[0].skids, 10);
  assert.equal(d.counts.otherDay, 1);
});

test('two DRIVERS under one route name are two trucks, not one — the list scan stores the route name as the load number', () => {
  const d = learnDay([
    row({ stopNbr: 'A', routeName: 'SUW 2', driverName: 'John Smith', cartons: 10 }),
    row({ stopNbr: 'B', routeName: 'SUW 2', driverName: 'Jane Roe', cartons: 12 }),
  ], '2026-09-23', 's', null, 'now');
  assert.deepEqual(d.trips.map((t) => [t.driver, t.skids]), [['Jane Roe', 12], ['John Smith', 10]]);
});

test('ONE driver, TWO loads under one name (the roster shows two live SUW 2 loads, the history one trip): shared, kept out of capacity', () => {
  const rows = [row({ stopNbr: 'A', routeName: 'SUW 2', cartons: 16 }), row({ stopNbr: 'B', routeName: 'SUW 2', cartons: 16 })];
  const two = roster([{ name: 'SUW 2', trips: 8, status: 'Dispatched' }, { name: 'SUW 2', trips: 9, status: 'Draft' }]);
  assert.equal(learnDay(rows, '2026-09-23', 's', two, 'now').trips[0].shared, true);
  const oneLive = roster([{ name: 'SUW 2', trips: 8, status: 'Dispatched' }, { name: 'SUW 2', trips: 3, status: 'Cancelled' }, { name: 'suw 2', trips: 0, status: 'Draft' }]);
  assert.equal(learnDay(rows, '2026-09-23', 's', oneLive, 'now').trips[0].shared, false, 'a cancelled or empty twin is not a second truck');
});

test('TWO drivers each on their own ESTES load: the history already has two trips, so neither is thrown out', () => {
  const rows = [row({ stopNbr: 'A', routeName: 'ESTES', driverName: 'Trevor Seyers', cartons: 15 }), row({ stopNbr: 'B', routeName: 'ESTES', driverName: 'Mike Ross', cartons: 20 })];
  const two = roster([{ name: 'ESTES', trips: 5, status: 'Dispatched' }, { name: 'ESTES', trips: 5, status: 'Dispatched' }]);
  assert.deepEqual(learnDay(rows, '2026-09-23', 's', two, 'now').trips.map((t) => t.shared), [false, false]);
});

test('WHEN THE ROSTER CANNOT SAY, the trip is unknown (null), never assumed clean: no roster, an empty one, a missing stop count, a name not on it', () => {
  const rows = [row({ stopNbr: 'A', routeName: 'SUW 2', cartons: 16 })];
  const none = learnDay(rows, '2026-06-10', 's', null, 'now');
  assert.equal(none.trips[0].shared, null);
  assert.equal(none.roster, 'none');
  const empty = learnDay(rows, '2026-09-23', 's', roster([]), 'now');
  assert.equal(empty.trips[0].shared, null);
  assert.equal(empty.roster, 'none', 'an empty capture is not a roster');
  const blind = roster([{ name: 'SUW 2', trips: null, status: 'Dispatched' }, { name: 'SUW 2', trips: null, status: 'Draft' }, { name: 'BEN 1', trips: 4, status: 'Dispatched' }]);
  assert.equal(learnDay(rows, '2026-09-23', 's', blind, 'now').trips[0].shared, null, 'a load whose stop count did not resolve could be a second truck');
  const elsewhere = roster([{ name: 'BEN 1', trips: 4, status: 'Dispatched' }]);
  assert.equal(learnDay(rows, '2026-09-23', 's', elsewhere, 'now').trips[0].shared, null, 'a name not on the roster is not vouched for');
});

test('MORE trips than live loads under a name (a driver swap mid-route, or a stray row) is not a clean truck either', () => {
  const names = rosterNamesFrom([{ name: 'SUW 2', trips: 8, status: 'Dispatched' }]);
  assert.equal(sharedVerdict(names, 'SUW 2', 2), null);
  assert.equal(sharedVerdict(names, 'SUW 2', 1), false);
});

test('a malformed roster document reads as NO roster', () => {
  assert.equal(rosterLoadsOf({ loadsJson: '{not json' }), null);
  assert.equal(rosterLoadsOf(null), null);
  assert.equal(rosterNamesFrom(null), null);
  assert.equal(rosterNamesFrom([]), null);
});

test('ROUTE ORDER: planned order when every stop carries its Display Seq; driven order from the delivered times', () => {
  const d = learnDay([
    row({ stopNbr: 'C', routeSeq: 3, deliveredDTTM: '2026-09-23T09:10:00', zip: '30024' }),
    row({ stopNbr: 'A', routeSeq: 1, deliveredDTTM: '2026-09-23T10:40:00', zip: '30518' }),
    row({ stopNbr: 'B', routeSeq: 2, deliveredDTTM: '2026-09-23T08:05:00', zip: '30519' }),
  ], '2026-09-23', 's', null, 'now');
  assert.equal(d.orders[0].planned, true);
  assert.deepEqual(d.orders[0].stops.map((s) => s.n), ['A', 'B', 'C'], 'the dispatcher’s order');
  assert.deepEqual(d.orders[0].driven, ['B', 'C', 'A'], 'the order the driver actually ran');
  assert.equal(d.counts.withSeq, 1);
});

test('a HALF-numbered route is not an order: planned is false when any stop lacks its Display Seq (June had none at all)', () => {
  const d = learnDay([row({ stopNbr: 'A', routeSeq: 1 }), row({ stopNbr: 'B', routeSeq: null })], '2026-06-10', 's', null, 'now');
  assert.equal(d.orders[0].planned, false);
  assert.equal(d.orders[0].driven, null, 'no delivered times, no driven order');
  assert.equal(d.counts.withSeq, 0);
});

test('a row with no route is not a truck, and is counted rather than dropped silently', () => {
  const d = learnDay([row({ stopNbr: 'A', routeName: '', loadNbr: null })], '2026-09-23', 's', null, 'now');
  assert.equal(d.trips.length, 0);
  assert.equal(d.counts.noRoute, 1);
});

// ── the capacity model ───────────────────────────────────────────────────────

const day = (date, trips) => ({ date, learnVersion: LEARN_VERSION, roster: 'read', trips });
const trip = (o) => ({ route: 'BEN 1', driver: 'Ben Paintsil', stops: 20, skids: 10, loose: 0, weight: 5000, freightStops: 20, uncountedStops: 0, shared: false, ...o });

test('SKID SPOTS: 17 skids + 30 loose at 10 loose a spot is 20 spots; at 5 a spot it is 23 — the ratio is a setting, applied when the model is built', () => {
  assert.equal(skidSpots(17, 30, 10), 20);
  assert.equal(skidSpots(17, 30, 5), 23);
  assert.equal(skidSpots(17, 30, 0), 47, 'a ratio below 1 never divides by less than 1');
  const m10 = buildCapacityModel([day('2026-09-23', [trip({ skids: 17, loose: 30 })])], { loosePerSkid: 10 }, 'now');
  const m5 = buildCapacityModel([day('2026-09-23', [trip({ skids: 17, loose: 30 })])], { loosePerSkid: 5 }, 'now');
  assert.equal(m10.drivers[0].max, 20);
  assert.equal(m5.drivers[0].max, 23);
  assert.deepEqual(m10.drivers[0].fullest, { date: '2026-09-23', route: 'BEN 1', driver: 'Ben Paintsil', skids: 17, loose: 30, spots: 20 });
});

test(`NO CAP UNTIL ${MIN_TRIPS_FOR_CAP} TRIPS — below that the 95th percentile IS the single fullest trip, and one bad day would set it`, () => {
  assert.ok(Math.ceil(CAP_QUANTILE * MIN_TRIPS_FOR_CAP) < MIN_TRIPS_FOR_CAP, 'at the minimum, the percentile is below the top trip');
  assert.equal(Math.ceil(CAP_QUANTILE * (MIN_TRIPS_FOR_CAP - 1)), MIN_TRIPS_FOR_CAP - 1, 'one fewer and it would be the top trip');
  // 19 ordinary 12-spot days plus one mis-keyed 40: the cap is the ordinary load, not the 40.
  const days = (n, outlier) => Array.from({ length: n }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, [trip({ skids: i === 0 && outlier ? 40 : 12 })]));
  assert.equal(buildCapacityModel(days(MIN_TRIPS_FOR_CAP - 1, true), { loosePerSkid: 10 }, 'now').drivers[0].cap, null);
  const m = buildCapacityModel(days(MIN_TRIPS_FOR_CAP, true), { loosePerSkid: 10 }, 'now');
  assert.equal(m.drivers[0].cap, 12);
  assert.equal(m.drivers[0].max, 40, 'the fullest trip is shown beside it, not used as the cap');
  assert.equal(m.drivers[0].trips, MIN_TRIPS_FOR_CAP);
});

test('A TRUCK LEARNED TWICE ITS SIZE is prevented: a shared or unvouched trip, a half-counted one, and a countless one are left out AND counted', () => {
  const m = buildCapacityModel([day('2026-09-23', [
    trip({ skids: 32, shared: true }),
    trip({ skids: 24, shared: null }),
    trip({ skids: 8, uncountedStops: 8 }),
    trip({ skids: 16 }),
    trip({ skids: 0, loose: 0, freightStops: 0 }),
    trip({ driver: '(no driver)' }),
  ])], { loosePerSkid: 10 }, 'now');
  assert.equal(m.drivers[0].max, 16);
  assert.deepEqual(m.trips, { total: 6, used: 1, skipped: { shared: 1, rosterUnknown: 1, uncounted: 1, noFreight: 1, noDriver: 1 } });
});

test('a JUNE day with no roster cannot put a double truck into the cap', () => {
  const july = Array.from({ length: 20 }, (_, i) => day(`2026-07-${String(i + 1).padStart(2, '0')}`, [trip({ skids: 12 })]));
  const june = [day('2026-06-10', [trip({ skids: 24, shared: null })]), day('2026-06-11', [trip({ skids: 24, shared: null })])].map((d) => ({ ...d, roster: 'none' }));
  const m = buildCapacityModel([...july, ...june], { loosePerSkid: 10 }, 'now');
  assert.equal(m.drivers[0].cap, 12);
  assert.equal(m.drivers[0].max, 12);
  assert.equal(m.days.noRoster, 2);
  assert.equal(m.trips.skipped.rosterUnknown, 2);
});

test('a trip with some stops carrying NO count is short by an unknown amount — it is recorded and kept out of capacity', () => {
  const d = learnDay([row({ stopNbr: 'A', cartons: 2 }), row({ stopNbr: 'B', cartons: null, volume: null }), row({ stopNbr: 'C', cartons: 0, volume: 0 })], '2026-09-23', 's', null, 'now');
  assert.deepEqual({ skids: d.trips[0].skids, freightStops: d.trips[0].freightStops, uncountedStops: d.trips[0].uncountedStops }, { skids: 2, freightStops: 1, uncountedStops: 1 });
});

test('learned PER DRIVER, PER ROUTE and PER DRIVER-ON-A-ROUTE, from the same trips', () => {
  const m = buildCapacityModel([
    day('2026-09-21', [trip({ route: 'BEN 1', skids: 12 }), trip({ route: 'SUW 9', driver: 'John Smith', skids: 20 })]),
    day('2026-09-22', [trip({ route: 'SUW 9', skids: 18 })]),
  ], { loosePerSkid: 10 }, 'now');
  assert.deepEqual(m.drivers.map((d) => [d.name, d.trips, d.max]), [['Ben Paintsil', 2, 18], ['John Smith', 1, 20]]);
  assert.deepEqual(m.routes.map((r) => [r.name, r.trips, r.max]), [['BEN 1', 1, 12], ['SUW 9', 2, 20]]);
  assert.deepEqual(m.pairs.map((p) => [p.driver, p.route, p.trips]), [['Ben Paintsil', 'BEN 1', 1], ['Ben Paintsil', 'SUW 9', 1], ['John Smith', 'SUW 9', 1]]);
  assert.deepEqual(m.drivers[0].routes, [{ name: 'BEN 1', trips: 1 }, { name: 'SUW 9', trips: 1 }]);
  assert.deepEqual(m.days, { count: 2, first: '2026-09-21', last: '2026-09-22', noRoster: 0, stampGateOff: 0 });
});

test('a day learned by an older LEARN_VERSION is not mixed into the model', () => {
  const m = buildCapacityModel([{ ...day('2026-09-21', [trip()]), learnVersion: LEARN_VERSION - 1 }], { loosePerSkid: 10 }, 'now');
  assert.equal(m.days.count, 0);
  assert.equal(m.drivers.length, 0);
});

test('quantile is nearest-rank, and an empty list has no quantile (not 0)', () => {
  assert.equal(quantile([], 0.95), null);
  assert.equal(quantile([5], 0.95), 5);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
});

// ── which days to learn ──────────────────────────────────────────────────────

test('only SEALED days are learned: a no-board tombstone, an unverified or incomplete capture, and another tenant are not', () => {
  const s = sealedDaysFrom([
    { _id: 'davis__2026-09-23', complete: true, verified: true, captured_at: 'c1' },
    { _id: 'davis__2026-09-22', complete: true, verified: true, captured_at: 'c0', healed_at: 'h1' },
    { _id: 'davis__2026-09-10', complete: false, verified: false },
    { _id: 'davis__2026-09-19', no_board: true, complete: true, verified: true },
    { _id: 'other__2026-09-23', complete: true, verified: true },
    { _id: 'davis__bad', complete: true, verified: true },
  ]);
  assert.deepEqual(s, [{ date: '2026-09-22', stamp: 'h1' }, { date: '2026-09-23', stamp: 'c1' }]);
});

test('a sealed day is learned ONCE — again only if healed or the learning version moves — and the newest few are always re-read', () => {
  const sealed = ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23'].map((date, i) => ({ date, stamp: `s${i}` }));
  const learned = sealed.map((s) => ({ _id: `davis__${s.date}`, learnVersion: LEARN_VERSION, sourceStamp: s.stamp }));
  learned[1] = { ...learned[1], sourceStamp: 'OLD' };             // 09-17 healed since
  learned[0] = { ...learned[0], learnVersion: LEARN_VERSION - 1 }; // 09-16 learned by old rules
  const r = daysToLearn(sealed, learned.filter((l) => !l._id.endsWith('09-23')));
  assert.deepEqual(r.toLearn, ['2026-09-16', '2026-09-17', '2026-09-23']);
  assert.deepEqual(r.refresh, ['2026-09-21', '2026-09-22'], `the newest ${RELEARN_RECENT_DAYS} are re-read even when unchanged (a stop filed in later moves no stamp)`);
});

// ── the run ──────────────────────────────────────────────────────────────────

const ENV_KEYS = ['CLAUDE_SHADOW', 'FIRESTORE_DATABASE'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function seedHistory() {
  return {
    'history_days/davis__2026-09-22': { complete: true, verified: true, captured_at: '2026-09-23T06:00:00Z' },
    'history_days/davis__2026-09-23': { complete: true, verified: true, captured_at: '2026-09-24T06:00:00Z' },
    'history_days/davis__2026-09-19': { no_board: true },
    'history_days/davis__2026-09-22/stops/A': row({ stopNbr: 'A', cartons: 17, routeSeq: 1 }),
    'history_days/davis__2026-09-22/stops/B': row({ stopNbr: 'B', volume: 30, routeSeq: 2 }),
    'history_days/davis__2026-09-23/stops/C': row({ stopNbr: 'C', cartons: 12 }),
    'history_days/davis__2026-09-23/stops/RA9': row({ stopNbr: 'RA9', stopType: 'PU', cartons: 40 }),
    'nuvizz_load_roster/davis__2026-09-22': roster([{ name: 'BEN 1', trips: 2, status: 'Dispatched' }]),
    'nuvizz_load_roster/davis__2026-09-23': roster([{ name: 'BEN 1', trips: 1, status: 'Dispatched' }]),
  };
}

test('THE RUN learns every sealed day, builds the model, and writes ONLY claude_shadow_* — zero calls off-box', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const r = await runLearn({ trigger: 'manual', by: 'dispatcher' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.learned, ['2026-09-22', '2026-09-23']);
      assert.equal(r.sealedDays, 2);
      assert.equal(r.nuvizzCalls, 0);
      for (const k of fake.store.keys()) {
        if (!k.startsWith('history_days/') && !k.startsWith('nuvizz_load_roster/')) assert.ok(k.startsWith('claude_shadow_'), `wrote ${k}`);
      }
      const model = fake.store.get(CAPACITY_PATH);
      assert.equal(model.drivers[0].name, 'Ben Paintsil');
      assert.equal(model.drivers[0].max, 20, '17 skids + 30 loose = 20 spots at the default ratio');
      assert.equal(model.loosePerSkidSource, 'default');
      assert.equal(model.days.noRoster, 0);
      assert.equal(model.trips.used, 2);
      const d22 = fake.store.get(`${LEARN_DAYS_COLLECTION}/davis__2026-09-22`);
      assert.deepEqual(d22.orders[0].stops.map((s) => s.n), ['A', 'B']);
      assert.equal(fake.store.get(LEARN_LAST_PATH).trigger, 'manual');
      assert.ok(fake.log.listMasks.some((m) => JSON.stringify(m).includes('cartons')), 'the stops are read masked, not whole');
    } finally { fake.restore(); }
  });
});

test('THE NEXT RUN learns nothing new when nothing new sealed, and re-reads only the newest few days', async () => {
  await withEnv({}, async () => {
    const seed = seedHistory();
    for (let d = 10; d <= 18; d++) {
      seed[`history_days/davis__2026-09-${d}`] = { complete: true, verified: true, captured_at: `c${d}` };
      seed[`history_days/davis__2026-09-${d}/stops/X${d}`] = row({ stopNbr: `X${d}`, cartons: 5 });
    }
    const fake = installFirestoreFake(seed, () => { throw new Error('no call off-box expected'); });
    try {
      await runLearn({ trigger: 'manual' });
      const before = fake.log.lists.length;
      const r = await runLearn({ trigger: 'nightly' });
      assert.deepEqual(r.learned, []);
      assert.equal(r.refreshed.length, RELEARN_RECENT_DAYS);
      const stopLists = fake.log.lists.slice(before).filter((u) => String(u).includes('/stops'));
      assert.equal(stopLists.length, RELEARN_RECENT_DAYS, 'only the newest days were re-read, not all eleven');
      assert.equal(r.ok, true);
    } finally { fake.restore(); }
  });
});

test('a settings read that FAILS keeps the previous model and marks the run failed — it is not "default"', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake({ ...seedHistory(), [SETTINGS_PATH]: { loosePerSkid: 5 } }, () => { throw new Error('no call off-box expected'); });
    try {
      await runLearn({ trigger: 'manual' });
      const good = fake.store.get(CAPACITY_PATH);
      const f = await import('../netlify/functions/lib/firestore.mts');
      const s = await import('../netlify/functions/lib/claude-shadow/store.mts');
      const r = await runLearn({ trigger: 'nightly' }, {
        getDoc: (p) => (p === SETTINGS_PATH ? Promise.reject(new Error('503')) : f.getDoc(p)),
        listDocs: f.listDocs, shadowSet: s.shadowSet, now: () => new Date('2026-09-25T08:30:00Z'),
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /settings read failed/);
      assert.equal(r.modelWritten, false);
      assert.deepEqual(fake.store.get(CAPACITY_PATH), good, 'the model built at the saved ratio is still there');
    } finally { fake.restore(); }
  });
});

test('a UAT-pointed site with no database of its own writes NOTHING — not even the run record, which could only land on production', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    const saved = process.env.NUVIZZ_BASE_URL;
    process.env.NUVIZZ_BASE_URL = 'https://uat.nuvizz.com/deliverit/openapi/v7';
    try {
      const r = await runLearn({ trigger: 'nightly' });
      assert.match(r.refused, /Firestore is not usable/);
      assert.equal(fake.log.sets.length + fake.log.commits.length, 0);
      assert.equal(fake.log.lists.length, 0);
    } finally { process.env.NUVIZZ_BASE_URL = saved; fake.restore(); }
  });
});

test('a SAVED loose-per-skid setting is used when the model is built, and the model says it came from the setting', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake({ ...seedHistory(), [SETTINGS_PATH]: { loosePerSkid: 5 } }, () => { throw new Error('no call off-box expected'); });
    try {
      await runLearn({ trigger: 'manual' });
      const m = fake.store.get(CAPACITY_PATH);
      assert.equal(m.loosePerSkid, 5);
      assert.equal(m.loosePerSkidSource, 'setting');
      assert.equal(m.drivers[0].max, 23);
    } finally { fake.restore(); }
  });
});

test('loosePerSkidFrom: an absent or out-of-range setting is the default, and says so', () => {
  assert.deepEqual(loosePerSkidFrom(null), { value: 10, source: 'default' });
  for (const bad of [0, -3, 500, 'abc', '', null]) assert.deepEqual(loosePerSkidFrom({ loosePerSkid: bad }), { value: 10, source: 'default' }, JSON.stringify(bad));
  assert.deepEqual(loosePerSkidFrom({ loosePerSkid: '6' }), { value: 6, source: 'setting' });
});

test('CLAUDE_SHADOW=off: the run READS NOTHING and records that it refused — the switch puts every side back', async () => {
  await withEnv({ CLAUDE_SHADOW: 'off' }, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const r = await runLearn({ trigger: 'nightly' });
      assert.equal(r.refused, 'CLAUDE_SHADOW is off');
      assert.equal(fake.log.lists.length, 0);
      assert.equal(fake.store.get(LEARN_LAST_PATH).refused, 'CLAUDE_SHADOW is off');
      assert.equal(fake.store.get(CAPACITY_PATH), undefined);
    } finally { fake.restore(); }
  });
});

test('on a MIRROR database the run refuses: the UAT site copies production’s environment and would learn a copy', () => {
  assert.match(learnRefusal({ FIRESTORE_DATABASE: 'uat-mirror' }), /uat-mirror/);
  assert.equal(learnRefusal({ FIRESTORE_DATABASE: '(default)' }), null);
  assert.equal(learnRefusal({}), null);
});

test('one day that fails to read is recorded as failed; the other days are still learned and the model still built', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const deps = {
        getDoc: (p) => import('../netlify/functions/lib/firestore.mts').then((f) => f.getDoc(p)),
        listDocs: async (p, o) => {
          if (p.includes('2026-09-22/stops')) throw new Error('read failed');
          return (await import('../netlify/functions/lib/firestore.mts')).listDocs(p, o);
        },
        shadowSet: (p, d) => import('../netlify/functions/lib/claude-shadow/store.mts').then((s) => s.shadowSet(p, d)),
        now: () => new Date('2026-09-24T08:30:00Z'),
      };
      const r = await runLearn({ trigger: 'nightly' }, deps);
      assert.equal(r.ok, false);
      assert.deepEqual(r.failed.map((f) => f.date), ['2026-09-22']);
      assert.deepEqual(r.learned, ['2026-09-23']);
      assert.ok(fake.store.get(CAPACITY_PATH), 'the model is built from the days that were learned');
    } finally { fake.restore(); }
  });
});

test('THE DRY RUN names the days a run would read and writes nothing', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const handler = (await import('../netlify/functions/claude-shadow.mts')).default;
      const j = await (await handler(new Request('https://x/.netlify/functions/claude-shadow?view=learn-plan'))).json();
      assert.equal(j.dry, true);
      assert.deepEqual(j.toLearn, ['2026-09-22', '2026-09-23']);
      assert.deepEqual(j.wouldLearn, ['2026-09-22', '2026-09-23']);
      assert.equal(j.deferred, 0);
      assert.equal(j.sealedDays, 2);
      assert.equal(fake.log.sets.length + fake.log.commits.length + fake.log.deletes.length, 0);
    } finally { fake.restore(); }
  });
});

test('THE TAB reads the learned model and the last run back from the status GET', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      await runLearn({ trigger: 'manual' });
      const handler = (await import('../netlify/functions/claude-shadow.mts')).default;
      const j = await (await handler(new Request('https://x/.netlify/functions/claude-shadow'))).json();
      assert.equal(j.learned.drivers[0].name, 'Ben Paintsil');
      assert.equal(j.learnLast.trigger, 'manual');
      assert.equal(j.learnedNote, null);
      assert.equal(j.learnRefused, null);
    } finally { fake.restore(); }
  });
});

test('"Learn now" RUNS on the endpoint and answers with what the run DID — 200 with the record, or 409 with the reason', async () => {
  const post = (b) => new Request('https://x/.netlify/functions/claude-shadow', { method: 'POST', body: JSON.stringify(b) });
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const handler = (await import('../netlify/functions/claude-shadow.mts')).default;
      const res = await handler(post({ action: 'learn' }));
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.deepEqual(j.learned, ['2026-09-22', '2026-09-23']);
      assert.equal(j.trigger, 'manual');
      assert.equal(j.calls, 0);
      assert.equal(fake.store.get(LEARN_LAST_PATH).trigger, 'manual');
      for (const k of fake.store.keys()) {
        if (!k.startsWith('history_days/') && !k.startsWith('nuvizz_load_roster/')) assert.ok(k.startsWith('claude_shadow_'), `wrote ${k}`);
      }
    } finally { fake.restore(); }
  });
  await withEnv({ CLAUDE_SHADOW: 'off' }, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const handler = (await import('../netlify/functions/claude-shadow.mts')).default;
      const off = await handler(post({ action: 'learn' }));
      assert.equal(off.status, 409);
      assert.match((await off.json()).error, /CLAUDE_SHADOW is off/);
      assert.equal(fake.log.lists.length, 0, 'refused before reading anything');
    } finally { fake.restore(); }
  });
});

test('Learn now\u2019s TIME BUDGET: days it did not reach are LEFT FOR LATER and counted, never dropped, and the run is not ok', async () => {
  await withEnv({}, async () => {
    const fake = installFirestoreFake(seedHistory(), () => { throw new Error('no call off-box expected'); });
    try {
      const f = await import('../netlify/functions/lib/firestore.mts');
      const st = await import('../netlify/functions/lib/claude-shadow/store.mts');
      let t = Date.parse('2026-09-24T12:00:00Z');
      const deps = { getDoc: f.getDoc, listDocs: f.listDocs, shadowSet: st.shadowSet, now: () => new Date((t += 10_000)) };
      const r = await runLearn({ trigger: 'manual', budgetMs: 15_000 }, deps);
      assert.ok(r.deferred >= 1, JSON.stringify(r));
      assert.equal(r.ok, false);
      assert.equal(r.learned.length + r.deferred, 2, 'every sealed day is either learned or left for later');
      const next = await runLearn({ trigger: 'nightly' });
      assert.equal(next.deferred, 0);
      assert.equal(next.ok, true);
    } finally { fake.restore(); }
  });
});

test('the nightly run is scheduled after the warehouse seals (06:00 UTC) and the engine’s own run (07:30 UTC)', async () => {
  const mod = await import('../netlify/functions/claude-shadow-learn-nightly-background.mts');
  assert.equal(mod.config.schedule, '30 8 * * *');
});

test('the history read is masked to the fields learning uses — no raw NuVizz object comes back', () => {
  assert.ok(!HISTORY_STOP_MASK.includes('raw'));
  for (const f of ['cartons', 'volume', 'routeSeq', 'deliveredDTTM', 'status', 'stopType', 'routeName', 'driverName']) assert.ok(HISTORY_STOP_MASK.includes(f), f);
});
