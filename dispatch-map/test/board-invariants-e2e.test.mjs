// test/board-invariants-e2e.test.mjs — THE INVARIANT CHAD ASKED FOR, END TO END (v0.95.0).
//
// Chad: "make sure that these issues don't happen again … we should only be showing the stops
// that the scans pick up." So: the REAL scan (runRefreshStops), the REAL Map feed
// (nuvizz-pull-today-stops) and the REAL Routing window (nuvizz-stop-explorer) run against an
// in-memory Firestore and a stubbed NuVizz, for the five orders that exposed each gap on 09/07.
// No network: the fake throws on any URL that is not stubbed, and /stop/info is stubbed to THROW,
// so "zero extra NuVizz calls" is proven, not asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
delete process.env.AUTH_REQUIRED;

const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
const pullStops = (await import('../netlify/functions/nuvizz-pull-today-stops.mts')).default;
const explorer = (await import('../netlify/functions/nuvizz-stop-explorer.mts')).default;

const today = etDayString();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const D1 = addDays(today, -1), D2 = addDays(today, -2);
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime', 'vizzonInfo.stopUpdatedDttm'];
const row = ({ nbr, ship = nbr, code, route = '', name = 'CUST', weight = 100, arrival, created, updated }) =>
  [nbr, ship, code, { 10: 'Un-Planned', 20: 'Planned', 90: 'Completed', 80: 'Unable' }[code] || code, name, '1 Main St', 'ATLANTA', '30303', route, '', String(weight), arrival, created || arrival, updated || arrival];
const search = (rows) => ({ filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows });
const loads = { filterData: [Object.fromEntries(['loadId', 'name', 'loadNbr', 'status', 'trips'].map((c) => [c, {}]))], values: [['L1', 'BEN 1', 'DAVIS000202683', 'Dispatched', 0], ['L2', 'TAYLOR', 'DAVIS000202684', 'Dispatched', 0], ['L3', 'CHAD', 'DAVIS000202685', 'Dispatched', 0]] };
const filler = row({ nbr: 'FILL-1', code: '10', arrival: usFmt(today, '08:00 AM') });   // today's bucket must not be empty
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const meta = (d) => ({ tenant: 'davis', date: d, last_scanned_at: d + 'T23:35:00.000Z', count: 1, lastUnplannedScanAt: d + 'T23:35:00.000Z' });
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;
const WINDOW = [addDays(today, -4), addDays(today, 1)];

/** One scenario: seed the boards, stub the two saved searches, run the scan, hand back the readers. */
async function scenario(seed, { active = [], completed = [] }, inspect) {
  const calls = [];
  const fake = installFirestoreFake(seed, async (url, init) => {
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    if (/PkgRoute/.test(url)) return json(loads);
    if (/VizzonStop/.test(url)) {
      const id = JSON.parse(init?.body || '{}').customListDefId;
      if (id === 77128) return json(search([filler, ...active]));
      if (id === 77131) return json(search(completed));
      return json(search([]));
    }
    if (/\/stop\/info\//.test(url)) throw new Error('a /stop/info call was spent: ' + url);
    throw new Error('unexpected vendor call: ' + url);
  });
  const scan = async () => {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.ok, true, 'the scan itself succeeded');
    return body;
  };
  try {
    const body = await scan();
    const board = async (date, carry) => (await pullStops(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=${date}&carryDays=${carry}`))).json();
    const window = async () => (await explorer(new Request('https://x.netlify.app/.netlify/functions/nuvizz-stop-explorer', { method: 'POST', body: JSON.stringify({ fromDate: WINDOW[0], toDate: WINDOW[1] }) }))).json();
    await inspect({ store: fake.store, board, window, log: fake.log, body, calls, scan });
    assert.equal(calls.some((c) => /\/stop\/info\//.test(c)), false, 'no per-stop NuVizz call was spent');
  } finally { fake.restore(); }
}
const find = (rows, nbr) => (rows || []).find((s) => String(s.stopNbr) === nbr) || null;

test('A  007170166-1 — unplanned on the frozen board, delivered TODAY on BEN 1: filed on today (pinned), the frozen copy healed, Map and window agree', async () => {
  await scenario({
    [`nuvizz_stop_index/davis__${D1}`]: meta(D1),
    [stopPath(D1, '007170166-1')]: { stopNbr: '007170166-1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, boardDate: D1, scheduledDate: D1, businessName: 'H&H WORLD GROUP', addr1: '733 PLEASANT HILL ROAD', city: 'LILBURN', zip: '30047', lat: 33.88, lng: -84.14, enriched: true, weight: 573, shipmentNbr: 'FF007170166', listUpdatedDTTM: D1 + 'T14:12:00' },
  }, { completed: [row({ nbr: '007170166-1', ship: 'FF007170166', code: '90', route: 'BEN 1', name: 'H&H WORLD GROUP', weight: 573, arrival: usFmt(D1, '08:00 AM'), updated: usFmt(today, '11:11 AM') })] },
  async ({ store, board, window, body, scan, log }) => {
    const todayCopy = store.get(stopPath(today, '007170166-1'));
    assert.ok(todayCopy, 'the delivery is on today\'s board');
    assert.equal(todayCopy.normalizedStatus, 'DELIVERED');
    assert.equal(todayCopy.boardDate, today, 'pinned to the day it was recorded');
    assert.equal(todayCopy.refiledFrom, D1);
    const frozen = store.get(stopPath(D1, '007170166-1'));
    assert.equal(frozen.normalizedStatus, 'DELIVERED', 'the frozen copy no longer calls it open');
    assert.equal(frozen.frozen_heal_reason, 'finished');
    assert.equal(frozen.closedOnBoard, today);
    assert.equal(frozen.boardDate, D1, 'a heal never moves a row');
    assert.equal(frozen.lat, 33.88, 'a heal never touches the pin');
    const b = await board(today, 7);
    assert.equal(find(b.stops, '007170166-1').normalizedStatus, 'DELIVERED');
    assert.equal(b.unplannedCount, 1, 'only the filler is unplanned');
    assert.equal(b.carryover.basis, 'pool');
    const w = await window();
    assert.equal(find(w.rows, '007170166-1').normalizedStatus, 'DELIVERED');
    assert.equal(w.reconciled.basis, 'pool');
    const run1 = (body.dates || []).find((d) => d.date === today);
    assert.equal(run1.frozen.filedFinished, 1);
    assert.equal(run1.frozen.healsQueued, 1);
    // SECOND SCAN, same world: nothing is filed twice, the ledger remembers, no frozen copy is re-read.
    const getsBefore = log.gets.filter((p) => p === stopPath(D1, '007170166-1')).length;
    const body2 = await scan();
    const run2 = (body2.dates || []).find((d) => d.date === today);
    assert.equal(run2.frozen.memoized, 1, 'the ledger answered');
    assert.equal(run2.frozen.reads, 0);
    assert.equal(log.gets.filter((p) => p === stopPath(D1, '007170166-1')).length, getsBefore, 'the frozen copy was not read again');
    const b2 = await board(today, 7);
    assert.equal(b2.stops.filter((s) => String(s.stopNbr) === '007170166-1').length, 1, 'one row, not two');
    assert.equal(find(b2.stops, '007170166-1').normalizedStatus, 'DELIVERED');
  });
});

test('B  PRIMARY LOGISTICS — frozen copy PLANNED on MARCUS 2 (clamped onto a later doc), NuVizz un-planned it: the copy is healed and it shows as UNPLANNED work on the Map and in the window', async () => {
  const copy = { stopNbr: 'PRIMARY131434870', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'MARCUS 2', routeName: 'MARCUS 2', driverName: 'Marcus Young', boardDate: D2, businessName: 'PRIMARY LOGISTICS', weight: 10000, cartons: 26, lat: 33.38, lng: -84.79, enriched: true, listUpdatedDTTM: D1 + 'T21:02:00' };
  const live = row({ nbr: 'PRIMARY131434870', code: '10', name: 'PRIMARY LOGISTICS', weight: 10000, arrival: usFmt(D2, '09:00 AM'), updated: usFmt(today, '09:00 AM') });
  for (const docDay of [D1, D2]) {   // as measured (the copy sits on the day AFTER its bucket day) and the control
    await scenario({ [`nuvizz_stop_index/davis__${docDay}`]: meta(docDay), [stopPath(docDay, 'PRIMARY131434870')]: { ...copy, scheduledDate: docDay } },
      { active: [live] }, async ({ store, board, window }) => {
        const healed = store.get(stopPath(docDay, 'PRIMARY131434870'));
        assert.equal(healed.isPlanned, false, `copy on ${docDay} healed`);
        assert.equal(healed.routeName, null);
        assert.equal(healed.frozen_heal_reason, 'plan');
        assert.equal(healed.lat, 33.38);
        const b = await board(today, 7);
        const m = find(b.stops, 'PRIMARY131434870');
        assert.ok(m, 'on the Map as carry-over');
        assert.equal(m.isUnplanned, true);
        assert.equal(m.carryover, true);
        const w = await window();
        const r = find(w.rows, 'PRIMARY131434870');
        assert.equal(r.isPlanned, false);
        assert.equal(r.status, '10');
      });
  }
});

test('C  HIGHLAND FORGE 007171197 — frozen copy REFUSED on TAYLOR, NuVizz lists the same number OPEN (ATT re-attempt): re-opened on today\'s board, the copy healed, unplanned on the Map and in the window', async () => {
  await scenario({
    [`nuvizz_stop_index/davis__${D1}`]: meta(D1),
    [stopPath(D1, '007171197')]: { stopNbr: '007171197', status: '80', normalizedStatus: 'EXCEPTION', isPlanned: true, isUnplanned: false, loadNbr: 'TAYLOR', routeName: 'TAYLOR', boardDate: D1, scheduledDate: D1, shipmentNbr: '007171197', businessName: 'HIGHLAND FORGE', lat: 33.72, lng: -84.41, enriched: true, listUpdatedDTTM: D1 + 'T14:19:00' },
  }, { active: [row({ nbr: '007171197', ship: 'ATT007171197', code: '10', name: 'HIGHLAND FORGE', weight: 781, arrival: usFmt(D1, '08:00 AM'), updated: usFmt(today, '10:06 AM') })] },
  async ({ store, board, window }) => {
    const t = store.get(stopPath(today, '007171197'));
    assert.ok(t, 'filed onto today as an open carry-over');
    assert.equal(t.normalizedStatus, 'UNPLANNED');
    assert.equal(t.refiledOpen, true);
    const f = store.get(stopPath(D1, '007171197'));
    assert.equal(f.normalizedStatus, 'UNPLANNED', 'the frozen refusal is re-opened');
    assert.equal(f.frozen_heal_reason, 'reopen');
    assert.equal(f.shipmentNbr, 'ATT007171197');
    const b = await board(today, 7);
    assert.equal(find(b.stops, '007171197').isUnplanned, true);
    assert.equal(b.unplannedCount, 2);
    const w = await window();
    assert.equal(find(w.rows, '007171197').status, '10');
  });
});

test('D  a rolled delivery re-touched today (terminal copy on the day it ran, OPEN copy on its arrival day): the open twin is healed, NOTHING is filed on today', async () => {
  await scenario({
    [`nuvizz_stop_index/davis__${D2}`]: meta(D2),
    [stopPath(D2, 'ROLL-1')]: { stopNbr: 'ROLL-1', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'CHAD', routeName: 'CHAD', boardDate: D2, scheduledDate: D2, businessName: 'ROLLED CUST', lat: 33.9, lng: -84.1, enriched: true },
    [`nuvizz_stop_index/davis__${D1}`]: meta(D1),
    [stopPath(D1, 'ROLL-1')]: { stopNbr: 'ROLL-1', status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false, loadNbr: 'CHAD', routeName: 'CHAD', boardDate: D1, scheduledDate: D1, deliveredDTTM: D1 + 'T14:00:00', businessName: 'ROLLED CUST', lat: 33.9, lng: -84.1, enriched: true },
  }, { completed: [row({ nbr: 'ROLL-1', code: '90', route: 'CHAD', name: 'ROLLED CUST', arrival: usFmt(D2, '08:00 AM'), updated: usFmt(today, '09:30 AM') })] },
  async ({ store, board }) => {
    assert.equal(store.get(stopPath(today, 'ROLL-1')), undefined, 'a POD re-touch is history, not today\'s work');
    assert.equal(store.get(stopPath(D2, 'ROLL-1')).normalizedStatus, 'DELIVERED', 'the open twin on the arrival day is closed');
    assert.equal(store.get(stopPath(D2, 'ROLL-1')).frozen_heal_reason, 'finished');
    assert.equal(store.get(stopPath(D1, 'ROLL-1')).frozen_heal_reason, undefined, 'the copy that was already right is untouched');
    const b = await board(today, 7);
    assert.equal(find(b.stops, 'ROLL-1'), null, 'not on today\'s Map');
  });
});

test('E  EXPEDITORS 007171664-1 — created after its day froze, no copy on any board: filed onto today so the Map shows it; the window lists it', async () => {
  await scenario({ [`nuvizz_stop_index/davis__${D1}`]: meta(D1) },
    { active: [row({ nbr: '007171664-1', ship: 'FF007171664', code: '10', name: 'EXPEDITORS INTERNATIONAL', weight: 848, arrival: usFmt(D1, '08:00 AM'), updated: usFmt(today, '12:01 PM') })] },
    async ({ store, board, window, scan }) => {
      const t = store.get(stopPath(today, '007171664-1'));
      assert.ok(t);
      assert.equal(t.refiledOpen, true);
      assert.equal(t.carryover, true);
      assert.equal(store.get(stopPath(D1, '007171664-1')), undefined, 'the frozen day is never written');
      const b = await board(today, 7);
      assert.equal(find(b.stops, '007171664-1').isUnplanned, true);
      const w = await window();
      assert.equal(find(w.rows, '007171664-1').status, '10');
      // Next scan, still open on its past day: re-filed from the live pull, once.
      await scan();
      const b2 = await board(today, 7);
      assert.equal(b2.stops.filter((s) => String(s.stopNbr) === '007171664-1').length, 1);
    });
});

test('F  a re-filed open carry-over leaves today\'s board the moment NuVizz stops listing it (delivered elsewhere / cancelled)', async () => {
  // Scan 1 lists it open on a past day → filed onto today. Scan 2 lists it FINISHED → the
  // finish is filed in its place. Scan 3 lists nothing → the finished row carries as history.
  const calls = [];
  let phase = 1;
  const fake = installFirestoreFake({ [`nuvizz_stop_index/davis__${D1}`]: meta(D1) }, async (url, init) => {
    calls.push(url);
    if (/PkgRoute/.test(url)) return json(loads);
    if (/VizzonStop/.test(url)) {
      const id = JSON.parse(init?.body || '{}').customListDefId;
      const open = row({ nbr: 'GONE-1', code: '10', name: 'GONE CUST', arrival: usFmt(D1, '08:00 AM'), updated: usFmt(today, '08:30 AM') });
      const done = row({ nbr: 'GONE-1', code: '90', route: 'CHAD', name: 'GONE CUST', arrival: usFmt(D1, '08:00 AM'), updated: usFmt(today, '13:30 PM') });
      if (id === 77128) return json(search(phase === 1 ? [filler, open] : [filler]));
      if (id === 77131) return json(search(phase === 2 ? [done] : []));
      return json(search([]));
    }
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const scan = async () => { const r = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' })); assert.equal((await r.json()).ok, true); };
    await scan();
    assert.equal(fake.store.get(stopPath(today, 'GONE-1'))?.refiledOpen, true);
    phase = 2; await scan();
    assert.equal(fake.store.get(stopPath(today, 'GONE-1'))?.normalizedStatus, 'DELIVERED', 'the finish replaced the open carry-over');
    phase = 3; await scan();
    assert.equal(fake.store.get(stopPath(today, 'GONE-1'))?.normalizedStatus, 'DELIVERED', 'history carries');
    const b = await (await pullStops(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=${today}&carryDays=7`))).json();
    assert.equal(b.unplannedCount, 1, 'only the filler is unplanned');
  } finally { fake.restore(); }
});
