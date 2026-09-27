// test/refiled-open-thin-pull.test.mjs — A TRUNCATED PULL DOES NOT TAKE A PAST-DUE OPEN ORDER OFF TODAY'S BOARD.
//
// The frozen-day pass files an open order onto TODAY's board (refiledOpen) when no past day
// holds an open copy of it — a "-1" duplicate created after its day froze, say. That copy is the
// ONLY place the order lives: the Map's carry-over fold has no frozen copy to fold.
//
// When the active saved search came back AT the row cap (its tail cut off) the scan already says
// "absence is not evidence this scan" — it stamps the pool and snapshot thin and carries every
// other absent row forward. The refiledOpen branch alone dropped the order on absence, so for one
// scan interval it was on no board, no Map and no Routing window, and nobody could plan it.
//
// Runs the REAL scan against the in-memory Firestore with the list cap at 3 rows.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NUVIZZ_LIST_MAX_RESULT = '3';          // read at module load, before the imports below
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
delete process.env.AUTH_REQUIRED;

const { etDayString, readStops, readActivePool } = await import('../netlify/functions/lib/firestore.mts');
const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');

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

// TODAY's board holds REF-1, filed here earlier by the frozen-day pass, plus two ordinary rows.
const seed = () => ({
  [`nuvizz_stop_index/davis__${today}`]: { tenant: 'davis', date: today, last_scanned_at: today + 'T12:00:00.000Z', count: 3, lastUnplannedScanAt: today + 'T12:00:00.000Z' },
  [`nuvizz_stop_index/davis__${today}/stops/REF-1`]: { stopNbr: 'REF-1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, boardDate: today, scheduledDate: today, refiledOpen: true, refiledFrom: D1, carryover: true, businessName: 'REFILED OPEN CO' },
  [`nuvizz_stop_index/davis__${today}/stops/T-0`]: { stopNbr: 'T-0', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, boardDate: today, scheduledDate: today },
  [`nuvizz_stop_index/davis__${today}/stops/T-1`]: { stopNbr: 'T-1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, boardDate: today, scheduledDate: today },
});

async function scan(activeRows) {
  const fake = installFirestoreFake(seed(), async (url, init) => {
    if (/PkgRoute/.test(url)) return json(loads);
    if (/VizzonStop/.test(url)) { const id = JSON.parse(init?.body || '{}').customListDefId; return json(search(id === 77128 ? activeRows : [])); }
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const j = await res.json();
    const board = await readStops('davis', today);
    const pool = await readActivePool('davis');
    return { ok: j.ok, poolThin: pool?.thin === true, board: board.stops, nbrs: board.stops.map((s) => s.stopNbr).sort() };
  } finally { fake.restore(); }
}

test('a past-due open order filed onto today stays on today\'s board when the pull comes back truncated at the row cap', async () => {
  // AT the cap (3 rows): REF-1 is in the tail NuVizz cut off.
  const r = await scan([row('T-0', usFmt(today, '08:00 AM')), row('T-1', usFmt(today, '08:00 AM')), row('X-9', usFmt(today, '09:00 AM'))]);
  assert.equal(r.ok, true);
  assert.equal(r.poolThin, true, 'precondition: the scan judged this pull thin');
  assert.ok(r.nbrs.includes('REF-1'), `REF-1 must still be on today's board: [${r.nbrs.join(', ')}]`);
  const ref = r.board.find((s) => s.stopNbr === 'REF-1');
  assert.equal(ref.refiledOpen, true, 'carried as it was, so the next complete pull decides it');
  assert.equal(ref.businessName, 'REFILED OPEN CO');
});

test('a complete pull that no longer lists the order still takes it off today\'s board', async () => {
  const r = await scan([row('T-0', usFmt(today, '08:00 AM')), row('T-1', usFmt(today, '08:00 AM'))]);
  assert.equal(r.ok, true);
  assert.equal(r.poolThin, false);
  assert.ok(!r.nbrs.includes('REF-1'), `a whole pull without REF-1 is evidence it closed: [${r.nbrs.join(', ')}]`);
});

test('a complete pull that still lists the order open on yesterday re-files it from the live row, as before', async () => {
  const r = await scan([row('T-0', usFmt(today, '08:00 AM')), row('REF-1', usFmt(D1, '08:00 AM'))]);
  assert.equal(r.ok, true);
  assert.ok(r.nbrs.includes('REF-1'));
  assert.equal(r.board.find((s) => s.stopNbr === 'REF-1').refiledOpen, true);
});
