// test/pull-truncation.test.mjs — THE ONE HAZARD OF A WIDER ARRIVAL WINDOW (v0.95.1).
//
// Chad asked for 30 days "if it's no extra nuvizz calls so everything self heals correctly".
// It is no extra calls — a saved search is ONE request whose result set is asked for whole, so
// the period is a filter value inside a call we already make. The cost is response SIZE, and
// the API has no paging here: a result set past `maxResult` comes back as a full-looking list
// with its tail missing and nothing saying so. Every reader downstream treats "not in the pull"
// as "NuVizz no longer lists it", so a silent truncation is how a wider window could delete
// open orders off the board as closed.
//
// So a pull that comes back AT the cap is reported truncated, and the scan stamps its pool and
// snapshot thin: absence stops being evidence for that scan. These tests run the REAL scan and
// the REAL Map feed against an in-memory Firestore with the cap set to 3 rows.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NUVIZZ_LIST_MAX_RESULT = '3';          // read at module load, before the imports below
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
delete process.env.AUTH_REQUIRED;

const { etDayString, readActivePool, readActiveUnplannedSet } = await import('../netlify/functions/lib/firestore.mts');
const { activeArrivalReachDays, SAVED_SEARCHES, LIST_MAX_RESULT } = await import('../netlify/functions/lib/nuvizz-list.mts');
const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
const pullStops = (await import('../netlify/functions/nuvizz-pull-today-stops.mts')).default;

const today = etDayString();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const D1 = addDays(today, -1);
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime', 'vizzonInfo.stopUpdatedDttm'];
const row = (nbr, arrival) => [nbr, nbr, '10', 'Un-Planned', 'CUST', '1 Main St', 'ATLANTA', '30303', '', '', '100', arrival, arrival, arrival];
const search = (rows) => ({ filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows });
const loads = { filterData: [Object.fromEntries(['loadId', 'name', 'loadNbr', 'status', 'trips'].map((c) => [c, {}]))], values: [['L1', 'BEN 1', 'DAVIS000202683', 'Dispatched', 0]] };
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;
const meta = (d) => ({ tenant: 'davis', date: d, last_scanned_at: d + 'T23:35:00.000Z', count: 1, lastUnplannedScanAt: d + 'T23:35:00.000Z' });
// A prior-day unplanned order sitting on a frozen board — the kind of row the pool prunes as
// "closed since" when the pull no longer lists it.
const seed = () => ({
  [`nuvizz_stop_index/davis__${D1}`]: meta(D1),
  [stopPath(D1, 'KEEP-1')]: { stopNbr: 'KEEP-1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, boardDate: D1, scheduledDate: D1, businessName: 'STILL OPEN CO', lat: 33.9, lng: -84.1, enriched: true },
});

/** Run the real scan with an active pull of `n` rows (the cap is 3), then read the Map. */
async function scanWith(n) {
  const rows = Array.from({ length: n }, (_, i) => row(`FILL-${i}`, usFmt(today, '08:00 AM')));
  const fake = installFirestoreFake(seed(), async (url, init) => {
    if (/PkgRoute/.test(url)) return json(loads);
    if (/VizzonStop/.test(url)) {
      const id = JSON.parse(init?.body || '{}').customListDefId;
      return json(search(id === 77128 ? rows : []));
    }
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    assert.equal((await res.json()).ok, true);
    const pool = await readActivePool('davis');
    const snap = await readActiveUnplannedSet('davis');
    const board = await (await pullStops(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=${today}&carryDays=7`))).json();
    return { pool, snap, board };
  } finally { fake.restore(); }
}

test('the arrival windows reach 30 days, and the completed search is still clamped to what NuVizz touched today', () => {
  assert.equal(activeArrivalReachDays(), 30, 'the pool, the snapshot and the frozen-day pass all judge 30 days either side');
  const period = (def, sequence) => JSON.parse(def.filterList.find((f) => f.sequence === sequence).value).period;
  assert.equal(period(SAVED_SEARCHES.active, 10), '+/-30d');
  assert.equal(period(SAVED_SEARCHES.completed, 10), '+/-30d', 'a stop that arrived three weeks ago and delivers today is now seen finished');
  assert.equal(period(SAVED_SEARCHES.completed, 11), '0d', 'the UPDATED axis is what decides the pull SIZE — unchanged until its grammar is verified live');
});

test('a pull that comes back AT the row cap is truncated: the pool and snapshot are stamped thin and the Map keeps a prior-day order the pull does not mention', async () => {
  const { pool, snap, board } = await scanWith(LIST_MAX_RESULT);        // exactly at the cap → truncated
  assert.equal(pool.thin, true, 'the pool says it cannot be trusted to say what is gone');
  assert.equal(snap.thin, true);
  assert.ok(board.stops.find((s) => String(s.stopNbr) === 'KEEP-1'), 'the open order the truncated list omitted is still on the board');
  assert.equal(board.carryover.thin, true);
  assert.equal(board.carryover.closed, 0, 'nothing was dropped as closed on a truncated list\'s word');
});

test('CONTROL — the same pull one row short of the cap is complete, and then absence IS evidence: the prior-day order is pruned as closed', async () => {
  const { pool, board } = await scanWith(LIST_MAX_RESULT - 1);
  assert.equal(pool.thin, false);
  assert.equal(board.stops.find((s) => String(s.stopNbr) === 'KEEP-1'), undefined, 'NuVizz no longer lists it → closed since');
  assert.equal(board.carryover.closed, 1);
});
