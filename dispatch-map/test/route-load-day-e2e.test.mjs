// test/route-load-day-e2e.test.mjs
//
// THE WHOLE SCAN, END TO END: an order on a load is filed on that load's day (v1.82.0).
//
// runRefreshStops against a Firestore fake and a NuVizz fake that answers exactly what the
// production scan asks — the two saved searches, the roster (today's "0d" pull and the ±7d window
// the scan keeps day by day), and /load/info — and nothing else: any other vendor call fails the
// test. The shape is Saturday 2026-09-26 with the dates made relative:
//
//   • WHITING TURNER (the 11-skid -1), dated YESTERDAY, planned onto the NEXT business day's MARCUS
//     → filed on that day's board, stamped with that load's number, OFF today's board;
//   • EP HEADCOVERS, dated YESTERDAY, still on YESTERDAY's TERRANCE, no TERRANCE load from today on
//     holds it → on today's board UNPLANNED, heldOn naming yesterday's load;
//   • NUVIZZ_ROUTE_LOAD_DAY=off → exactly the old filing, no load read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
delete process.env.AUTH_REQUIRED;
delete process.env.NUVIZZ_ROUTE_LOAD_DAY;
delete process.env.NUVIZZ_ROUTE_LOAD_HELD;
// "Shown unplanned" (NUVIZZ_ROUTE_LOAD_HELD) is OFF by default; the tests about it turn it on.
const HELD = { NUVIZZ_ROUTE_LOAD_HELD: 'on' };

const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
const { runRefreshStops, scanDatesFrom } = await import('../netlify/functions/lib/refresh-stops-core.mts');

const today = etDayString();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const yesterday = addDays(today, -1);
const nextDay = scanDatesFrom(today, 3)[1];            // the next business day the scan writes
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };

const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime', 'vizzonInfo.stopUpdatedDttm'];
// NuVizz's "Stop Updated" (the last column) is when the order last changed — in the past, before
// this scan: yesterday morning unless a test moves it.
const row = ({ nbr, code = '20', route = '', name = 'CUST', weight = 100, arrival, updated = usFmt(yesterday, '06:00 AM') }) =>
  [nbr, nbr, code, { 10: 'Un-Planned', 20: 'Planned' }[code] || code, name, '1 Main St', 'PALMETTO', '30268', route, '', String(weight), arrival, arrival, updated];
const search = (rows) => ({ filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows });
const ROSTER_COLS = ['loadId', 'name', 'loadNbr', 'status', 'trips', 'schEndTime'];
const grid = (loads) => ({ filterData: [Object.fromEntries(ROSTER_COLS.map((c) => [c, {}]))], values: loads });
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;
const loadInfoOf = (loadNbr, route, nbrs) => ({ Load: { loadHeader: { loadId: `id-${loadNbr}`, loadNbr, routeName: route }, stops: nbrs.map((n, i) => ({ stop: { stopNbr: n, stopType: 'DO', to: { seq: i + 1 } } })) } });

const WHITING = '007182304-1';
const POREX = '007182396';
const HEADCOVERS = '007182123';
const NEXT_MARCUS = 'DAVIS000204645';
const YDAY_MARCUS = 'DAVIS000204535';
const YDAY_TERRANCE = 'DAVIS000204484';
const NEXT_TERRANCE = 'DAVIS000204590';

const pullRows = () => [
  row({ nbr: '007182472', route: 'MARCUS', name: 'BLACK & VEATCH', arrival: usFmt(nextDay, '08:00 AM') }),
  row({ nbr: '007182494', route: 'MARCUS', name: 'DRIVE MEDICAL', arrival: usFmt(nextDay, '08:00 AM') }),
  row({ nbr: WHITING, route: 'MARCUS', name: 'WHITING TURNER', weight: 6496, arrival: usFmt(yesterday, '08:00 AM') }),
  row({ nbr: POREX, route: 'MARCUS', name: 'POREX CORPORATION', weight: 237, arrival: usFmt(yesterday, '08:00 AM') }),
  row({ nbr: HEADCOVERS, route: 'TERRANCE', name: 'EP HEADCOVERS', arrival: usFmt(yesterday, '08:00 AM') }),
  row({ nbr: '007182999', code: '10', name: 'UNPLANNED CUST', arrival: usFmt(today, '08:00 AM') }),
];
// Yesterday's roster is a stored document — the scan never pulls a past day.
const yesterdayRoster = () => ({
  [`nuvizz_load_roster/davis__${yesterday}`]: { tenant: 'davis', date: yesterday, at: `${yesterday}T23:00:00.000Z`, loadsJson: JSON.stringify([
    { loadId: `id-${YDAY_MARCUS}`, name: 'MARCUS', loadNbr: YDAY_MARCUS, status: 'In-Progress', driver: 'Marcus Young', trips: 13 },
    { loadId: `id-${YDAY_TERRANCE}`, name: 'TERRANCE', loadNbr: YDAY_TERRANCE, status: 'Dispatched', driver: 'Terrance Hawk', trips: 9 },
  ]) },
});
// The roster pulls: today's "0d" answers today's loads (none named MARCUS or TERRANCE — Saturday);
// the ±7d window answers every load with its Load Latest Departure, which the scan files by day.
const rosterFor = (body) => {
  const period = JSON.parse(JSON.parse(body || '{}').filterList?.[0]?.value || '{}').period;
  if (period === '0d') return grid([]);
  return grid([
    [`id-${NEXT_MARCUS}`, 'MARCUS', NEXT_MARCUS, 'Draft', 4, usFmt(nextDay, '11:59 PM')],
    [`id-${NEXT_TERRANCE}`, 'TERRANCE', NEXT_TERRANCE, 'Draft', 0, usFmt(nextDay, '11:59 PM')],
  ]);
};
const LOADS = {
  [NEXT_MARCUS]: loadInfoOf(NEXT_MARCUS, 'MARCUS', ['007182472', WHITING, '007182494', POREX]),
  [YDAY_TERRANCE]: loadInfoOf(YDAY_TERRANCE, 'TERRANCE', [HEADCOVERS]),
  [YDAY_MARCUS]: loadInfoOf(YDAY_MARCUS, 'MARCUS', ['007182304']),
  [NEXT_TERRANCE]: loadInfoOf(NEXT_TERRANCE, 'TERRANCE', []),
};

/** Every board day the store holds a copy of this stop on. */
const boardsHolding = (store, nbr) => [...store.keys()]
  .map((k) => /^nuvizz_stop_index\/davis__(\d{4}-\d{2}-\d{2})\/stops\/(.+)$/.exec(k))
  .filter((m) => m && m[2] === nbr).map((m) => m[1]).sort();

async function scenario({ seed = {}, env = {}, rows = pullRows }, inspect) {
  const calls = [];
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  const fake = installFirestoreFake({ ...yesterdayRoster(), ...seed }, async (url, init) => {
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    if (/PkgRoute/.test(url)) return json(rosterFor(init?.body));
    if (/VizzonStop/.test(url)) {
      const id = JSON.parse(init?.body || '{}').customListDefId;
      return json(search(id === 77128 ? rows() : []));
    }
    const m = /\/load\/info\/([^/]+)\//.exec(url);
    if (m) return LOADS[m[1]] ? json(LOADS[m[1]]) : new Response('{}', { status: 404 });
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.ok, true, 'the scan itself succeeded');
    await inspect({
      store: fake.store, body, calls,
      loadReads: calls.filter((c) => /\/load\/info\//.test(c)).map((c) => /\/load\/info\/([^/]+)\//.exec(c)[1]),
      stopReads: calls.filter((c) => /\/stop\/info\//.test(c)).length,
    });
  } finally {
    fake.restore();
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

test('an order dated yesterday and planned on the next business day\'s MARCUS is filed on THAT day\'s board, with that load\'s number — not today\'s', async () => {
  await scenario({ env: HELD }, async ({ store, body, loadReads }) => {
    assert.equal(store.get(stopPath(today, WHITING)), undefined, 'WHITING TURNER is NOT on today\'s board');
    assert.equal(store.get(stopPath(today, POREX)), undefined, 'POREX is NOT on today\'s board');
    const w = store.get(stopPath(nextDay, WHITING));
    assert.ok(w, `WHITING TURNER is on the ${nextDay} board with the rest of its load`);
    assert.equal(w.rosterLoadNbr, NEXT_MARCUS);
    assert.equal(w.rosterLoadId, `id-${NEXT_MARCUS}`);
    assert.equal(w.loadDay, nextDay);
    assert.equal(w.rosterLoadVia, 'membership');
    assert.equal(w.loadNbr, 'MARCUS', 'the route name every screen groups by is untouched');
    // The rest of the next day's MARCUS is named too, from that day's roster, for free.
    const bv = store.get(stopPath(nextDay, '007182472'));
    assert.equal(bv.rosterLoadNbr, NEXT_MARCUS);
    // Reads: the next day's MARCUS (it counted more orders than its board showed); the next day's
    // TERRANCE — its roster count of 0 is the one capture a future day gets, so it answers nothing
    // about an order planned onto it since, and "held" needs EVERY load from today on to answer;
    // then yesterday's TERRANCE for the leftover. Not yesterday's MARCUS — the next day's load
    // already placed those — and nothing twice.
    assert.deepEqual(loadReads.slice().sort(), [YDAY_TERRANCE, NEXT_MARCUS, NEXT_TERRANCE].sort());
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.routeLoadDay.load, 2);
    assert.equal(run.routeLoadDay.held, 1);
    assert.equal(run.routeLoadDay.reads, 3);
  });
});

test('an order still on YESTERDAY\'s TERRANCE, on no load from today on, is on today\'s board UNPLANNED and says which load holds it', async () => {
  await scenario({ env: HELD }, async ({ store }) => {
    const h = store.get(stopPath(today, HEADCOVERS));
    assert.ok(h, 'in today\'s pool, where the day\'s planning happens');
    assert.equal(h.isUnplanned, true);
    assert.equal(h.isPlanned, false);
    assert.equal(h.normalizedStatus, 'UNPLANNED');
    assert.equal(h.loadNbr, null);
    assert.equal(h.heldOn.loadNbr, YDAY_TERRANCE);
    assert.equal(h.heldOn.day, yesterday);
    assert.equal(h.heldOn.route, 'TERRANCE');
    assert.equal(h.status, '20', 'NuVizz\'s own code: the record is still on that load');
  });
});

test('the next scan pays nothing: the memo answers, the filing holds, and the held order is NOT sent to the demotion verify', async () => {
  let carried = {};
  await scenario({ env: HELD }, async ({ store }) => { carried = Object.fromEntries(store); });
  await scenario({ seed: carried, env: HELD }, async ({ store, loadReads, stopReads }) => {
    assert.deepEqual(loadReads, [], 'every load answered from the memo');
    assert.equal(stopReads, 0, 'no /stop/info: the held order is not a "disputed plan" for the verify to put back');
    assert.ok(store.get(stopPath(nextDay, WHITING)));
    assert.equal(store.get(stopPath(today, WHITING)), undefined, 'and it is not carried forward onto today from its old copy');
    assert.equal(store.get(stopPath(today, HEADCOVERS)).isUnplanned, true);
  });
});

test('a board that still holds the OLD filing (planned on today\'s MARCUS) is cleaned: the order moves to its load\'s day and today\'s copy goes', async () => {
  // What a pre-v1.82 scan left behind on today's board.
  const prior = {
    [stopPath(today, WHITING)]: { stopNbr: WHITING, routeName: 'MARCUS', loadNbr: 'MARCUS', isPlanned: true, isUnplanned: false, normalizedStatus: 'SCHEDULED', status: '20', boardDate: yesterday, scheduledDate: today },
    [stopPath(today, HEADCOVERS)]: { stopNbr: HEADCOVERS, routeName: 'TERRANCE', loadNbr: 'TERRANCE', isPlanned: true, isUnplanned: false, normalizedStatus: 'SCHEDULED', status: '20', boardDate: yesterday, scheduledDate: today },
  };
  await scenario({ seed: prior, env: HELD }, async ({ store, stopReads }) => {
    assert.equal(store.get(stopPath(today, WHITING)), undefined, 'gone from today');
    assert.ok(store.get(stopPath(nextDay, WHITING)), 'on its load\'s day');
    assert.equal(store.get(stopPath(today, HEADCOVERS)).isUnplanned, true, 'shown unplanned, not re-planned by the verify');
    assert.equal(stopReads, 0);
  });
});

test('NUVIZZ_ROUTE_LOAD_DAY=off puts every side back: the old filing, no load read, no stamps', async () => {
  await scenario({ env: { NUVIZZ_ROUTE_LOAD_DAY: 'off' } }, async ({ store, loadReads, body }) => {
    const w = store.get(stopPath(today, WHITING));
    assert.ok(w, 'the old rule: an open routed order dated yesterday is filed on today');
    assert.equal(w.rosterLoadNbr, undefined);
    assert.equal(w.isPlanned, true);
    assert.equal(store.get(stopPath(today, HEADCOVERS)).isPlanned, true, 'and the leftover reads planned, as it did');
    assert.deepEqual(loadReads, []);
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.routeLoadDay, undefined);
  });
});

test('the load read FAILS → nothing moves: every carried order keeps the old filing', async () => {
  const saved = LOADS[NEXT_MARCUS];
  const savedT = LOADS[YDAY_TERRANCE];
  delete LOADS[NEXT_MARCUS]; delete LOADS[YDAY_TERRANCE];
  try {
    await scenario({}, async ({ store, body }) => {
      assert.ok(store.get(stopPath(today, WHITING)), 'unresolved → where the old rule put it');
      assert.equal(store.get(stopPath(today, WHITING)).isPlanned, true);
      assert.equal(store.get(stopPath(today, HEADCOVERS)).isPlanned, true);
      const run = (body.dates || []).find((d) => d.date === today);
      assert.equal(run.routeLoadDay.load, 0);
      assert.equal(run.routeLoadDay.held, 0);
    });
  } finally { LOADS[NEXT_MARCUS] = saved; LOADS[YDAY_TERRANCE] = savedT; }
});

test('REVIEW #5: the list alone calling an order on the next day\'s MARCUS un-planned does NOT take it off that card — the verify decides', async () => {
  let carried = {};
  await scenario({}, async ({ store }) => { carried = Object.fromEntries(store); });
  assert.equal(carried[stopPath(nextDay, WHITING)]?.loadDay, nextDay, 'precondition: filed on its load\'s day');
  // The next scan's list says WHITING is un-planned (code 10, no route): list lag after a Save, or a
  // vendor glitch. The next day's MARCUS still holds it — /load/info says so.
  const lagged = () => pullRows().map((r) => (r[0] === WHITING ? row({ nbr: WHITING, code: '10', route: '', name: 'WHITING TURNER', weight: 6496, arrival: usFmt(yesterday, '08:00 AM') }) : r));
  let again = {};
  await scenario({ seed: carried, rows: lagged }, async ({ store, loadReads }) => {
    const w = store.get(stopPath(nextDay, WHITING));
    assert.ok(w, 'still on the next day\'s board');
    assert.equal(w.isPlanned, true, 'held planned: the load itself was asked, and holds it');
    assert.equal(w.loadNbr, 'MARCUS');
    assert.equal(w.loadDay, nextDay, 'the load it is kept on is part of the plan kept');
    assert.ok(loadReads.includes(NEXT_MARCUS), 'the verify read the load (or the load-day pass did, and shared it)');
    // ONE board per order (round 2's blocker): never Monday's card AND an un-planned copy in today's pool.
    assert.deepEqual(boardsHolding(store, WHITING), [nextDay]);
    again = Object.fromEntries(store);
  });
  // …and the scan after that, the list still lagging, keeps it there too (the kept copy carries its load).
  await scenario({ seed: again, rows: lagged }, async ({ store }) => {
    assert.equal(store.get(stopPath(nextDay, WHITING))?.isPlanned, true);
    assert.deepEqual(boardsHolding(store, WHITING), [nextDay]);
  });
});

test('REVIEW #18: a confirmed Save onto JOE five minutes ago outranks the list — and takes the list\'s load stamps with it', async () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const seed = {
    [stopPath(nextDay, WHITING)]: { stopNbr: WHITING, routeName: 'JOE', loadNbr: 'JOE', routeSeq: 1, isPlanned: true, isUnplanned: false, normalizedStatus: 'SCHEDULED', status: '20', boardDate: yesterday, scheduledDate: nextDay, board_write_at: at, board_write_planned: true },
  };
  await scenario({ seed }, async ({ store }) => {
    const w = store.get(stopPath(nextDay, WHITING));
    assert.equal(w.routeName, 'JOE', 'the Save holds');
    assert.equal(w.rosterLoadNbr ?? null, null, 'no MARCUS load number beside Route JOE');
    assert.equal(w.rosterLoadRoute ?? null, null);
    assert.equal(w.loadDay ?? null, null);
  });
});

test('THE DEFAULT (NUVIZZ_ROUTE_LOAD_HELD unset): the headline fix is on; the leftover keeps its old filing and its past load is never read', async () => {
  await scenario({}, async ({ store, body, loadReads }) => {
    assert.ok(store.get(stopPath(nextDay, WHITING)), 'WHITING TURNER is on its load\'s day');
    assert.equal(store.get(stopPath(today, WHITING)), undefined);
    const h = store.get(stopPath(today, HEADCOVERS));
    assert.equal(h.isPlanned, true, 'EP HEADCOVERS reads as it always did');
    assert.equal(h.heldOn ?? null, null);
    assert.ok(!loadReads.includes(YDAY_TERRANCE), 'no call spent on a past load');
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.routeLoadDay.held, 0);
    assert.equal(run.routeLoadDay.heldEnabled, false);
  });
});

test('REVIEW #7 (round 2): a Save onto JOE on the next day\'s board survives the next scan while the list still says MARCUS', async () => {
  let carried = {};
  await scenario({}, async ({ store }) => { carried = Object.fromEntries(store); });
  // The dispatcher Saves WHITING from the next day's MARCUS onto JOE, five minutes ago; NuVizz took it
  // off MARCUS, the list has not caught up.
  const k = stopPath(nextDay, WHITING);
  carried[k] = { ...carried[k], routeName: 'JOE', loadNbr: 'JOE', routeSeq: 1, board_write_at: new Date(Date.now() - 5 * 60_000).toISOString(), board_write_planned: true };
  const saved = LOADS[NEXT_MARCUS];
  LOADS[NEXT_MARCUS] = loadInfoOf(NEXT_MARCUS, 'MARCUS', ['007182472', '007182494', POREX]);
  try {
    await scenario({ seed: carried }, async ({ store, body }) => {
      const w = store.get(stopPath(nextDay, WHITING));
      assert.equal(w?.routeName, 'JOE', 'the Save holds, on the board it was made on');
      assert.deepEqual(boardsHolding(store, WHITING), [nextDay], 'and nothing re-filed it onto today with the old route');
      const run = (body.dates || []).find((d) => d.date === today);
      assert.equal(run.routeLoadDay.pinnedGrace, 1);
    });
  } finally { LOADS[NEXT_MARCUS] = saved; }
});

test('REVIEW #8/#16 (round 2): with no read to spare, the next scan KEEPS the order on its load\'s day — it does not flip back to today', async () => {
  let carried = {};
  await scenario({}, async ({ store }) => { carried = Object.fromEntries(store); });
  // Wipe the memo: only the last scan's verdict (the pool) can keep it — and no reads are allowed.
  delete carried['nuvizz_ops/route_load_day__davis'];
  await scenario({ seed: carried, env: { NUVIZZ_ROUTE_LOAD_DAY_READS: '0' } }, async ({ store, loadReads, body }) => {
    assert.deepEqual(loadReads, []);
    assert.deepEqual(boardsHolding(store, WHITING), [nextDay]);
    assert.equal(store.get(stopPath(nextDay, WHITING)).rosterLoadNbr, NEXT_MARCUS);
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.routeLoadDay.kept, 2, 'WHITING and POREX, kept without a read');
  });
});
