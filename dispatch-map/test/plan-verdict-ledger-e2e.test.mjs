// test/plan-verdict-ledger-e2e.test.mjs — THE CASE, RUN (v1.4.0).
//
// Chad, 2026-09-10, AVRT-0170416694 and RA5732712 sitting in the Routing selection while NuVizz
// held them on WILLIAM and JOE: "figure out why and make sure it doesn't happen again." The
// REAL scan (runRefreshStops) runs here against an in-memory Firestore and a stubbed vendor, in
// the two shapes that matter:
//
//   1. the board holds the stop planned on WILLIAM (a confirmed save two hours ago, so the write
//      grace has lapsed), the planned/un-planned pull no longer returns it, the day's roster has
//      NO load named WILLIAM (the load was created after the last roster pull), and NuVizz's stop
//      record — the only evidence left — reads un-planned. The scan drops the plan. Before v1.4.0
//      that decision went to a console line; now the ledger says exactly that, and the explain
//      endpoint answers "why" from it, for free.
//   2. the same, but the roster HAS WILLIAM and the load's own read lists the stop: the plan is
//      KEPT on the load's word, verified, and the ledger says so.
//
// The fake throws on any URL not stubbed, so the cost of each scenario is exactly the calls it
// names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
delete process.env.AUTH_REQUIRED;

const { etDayString, readPlanVerdicts } = await import('../netlify/functions/lib/firestore.mts');
const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
const explain = (await import('../netlify/functions/nuvizz-stop-explain.mts')).default;

const today = etDayString();
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime', 'vizzonInfo.stopUpdatedDttm'];
const row = ({ nbr, ship = nbr, code, route = '', name = 'CUST', weight = 100, arrival, created, updated }) =>
  [nbr, ship, code, { 10: 'Un-Planned', 20: 'Planned', 90: 'Completed', 80: 'Unable' }[code] || code, name, '1 Main St', 'MCDONOUGH', '30252', route, '', String(weight), arrival, created || arrival, updated || arrival];
const search = (rows) => ({ filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows });
const rosterOf = (loads) => ({ filterData: [Object.fromEntries(['loadId', 'name', 'loadNbr', 'status', 'trips'].map((c) => [c, {}]))], values: loads });
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;
const AVRT = 'AVRT-0170416694';
const WILLIAM_NBR = 'DAVIS000203001';
const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

// Today's board as it stood before the scan: AVRT planned on WILLIAM by a confirmed save whose
// grace has lapsed, plus one filler so the pull does not look thin against the prior board.
const priorBoard = () => ({
  [`nuvizz_stop_index/davis__${today}`]: { tenant: 'davis', date: today, last_scanned_at: twoHoursAgo, count: 2, lastUnplannedScanAt: twoHoursAgo },
  [stopPath(today, AVRT)]: { stopNbr: AVRT, stopId: '6a63c5844524f7f7b8ab5410', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: 'WILLIAM', routeName: 'WILLIAM', routeSeq: 11, driverName: 'William Kidd', boardDate: today, scheduledDate: today, businessName: 'RODERICL CONEY', addr1: '1 Main St', city: 'MCDONOUGH', zip: '30252', lat: 33.45, lng: -84.15, enriched: true, weight: 318, board_write_at: twoHoursAgo, board_write_planned: true },
  [stopPath(today, 'FILL-1')]: { stopNbr: 'FILL-1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, boardDate: today, scheduledDate: today, businessName: 'FILLER', lat: 33.4, lng: -84.1, enriched: true },
});
const filler = row({ nbr: 'FILL-1', code: '10', arrival: usFmt(today, '08:00 AM') });

async function scenario({ roster, loadInfo, stopInfo, active = [filler] }, inspect) {
  const calls = [];
  const fake = installFirestoreFake(priorBoard(), async (url, init) => {
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    if (/PkgRoute/.test(url)) return json(rosterOf(roster));
    if (/VizzonStop/.test(url)) {
      const id = JSON.parse(init?.body || '{}').customListDefId;
      if (id === 77128) return json(search(active));
      return json(search([]));
    }
    if (/\/load\/info\//.test(url)) return loadInfo ? json(loadInfo) : new Response('{}', { status: 404 });
    if (/\/stop\/info\//.test(url)) return stopInfo ? json(stopInfo) : new Response('{}', { status: 404 });
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.ok, true, 'the scan itself succeeded');
    await inspect({ store: fake.store, body, calls });
  } finally { fake.restore(); }
}

test('1  absent from the pull, roster has no WILLIAM, stop record reads un-planned → DROPPED, and the ledger + explain say on whose word', async () => {
  await scenario({
    roster: [['L2', 'JOE', 'DAVIS000203002', 'Draft', 10]],   // WILLIAM was created after this roster was captured
    loadInfo: null,
    stopInfo: { Stop: { stop: { stopNbr: AVRT, stopId: '6a63c5844524f7f7b8ab5410', status: '10', stopType: 'DO', to: { address: { name: 'RODERICL CONEY', addr1: '1 Main St', city: 'MCDONOUGH', zip: '30252' } } }, stopExecutionInfo: {}, load: {} } },
  }, async ({ store, body, calls }) => {
    const copy = store.get(stopPath(today, AVRT));
    assert.equal(copy.isPlanned, false, 'the plan came off');
    assert.equal(copy.isUnplanned, true);
    assert.equal(copy.absentFromPull, true, 'the row says it was a carried candidate, not a list verdict');
    assert.equal(copy.loadNbr, null);

    const ledger = await readPlanVerdicts('davis', today);
    assert.equal(ledger.length, 1, 'one verdict, for the one disputed stop');
    const v = ledger[0];
    assert.equal(v.stopNbr, AVRT);
    assert.equal(v.route, 'WILLIAM');
    assert.equal(v.verdict, 'dropped');
    assert.equal(v.basis, 'record', 'decided by the stop record, because the load could not be asked');
    assert.equal(v.absent, true);
    assert.equal(v.listStatus, null, 'the list said nothing about it');
    assert.deepEqual(v.path, ['roster (1 load): no load named WILLIAM', 'stop record: UNPLANNED, on no load']);
    assert.ok(v.at, 'stamped with the scan');

    const run = (body.dates || []).find((d) => d.date === today);
    assert.deepEqual(run.planVerdicts, { disputed: 1, kept: 0, held: 0, dropped: 1, graceHeld: 0 }, 'the run row carries the counts');

    assert.equal(calls.filter((c) => /\/stop\/info\//.test(c)).length, 1, 'exactly one record read was spent');
    assert.equal(calls.filter((c) => /\/load\/info\//.test(c)).length, 0, 'no load read — there was no load number to read');

    // THE EXPLAIN, from the same documents, spends nothing and names the cause.
    const j = await (await explain(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-stop-explain?stop=${AVRT}&date=${today}`))).json();
    assert.equal(j.ok, true);
    assert.equal(j.plan.isPlanned, false);
    assert.equal(j.verdicts.length, 1);
    assert.equal(j.roster.resolution, 'no-such-load');
    const findings = j.findings.join('\n');
    assert.match(findings, /did NOT get AVRT-0170416694 back from NuVizz's planned\/un-planned saved search/);
    assert.match(findings, /took it OFF WILLIAM — stop record: UNPLANNED, on no load \(steps: roster \(1 load\): no load named WILLIAM → stop record: UNPLANNED, on no load\)/);
    assert.match(findings, /roster .* has NO load named WILLIAM: the verify cannot ask the load itself/);
    assert.equal(calls.some((c) => /explain/.test(c)), false, 'the explain made no vendor call');
  });
});

test('2  absent from the pull, roster HAS WILLIAM, the load lists the stop → KEPT on the load\'s word, verified, ledgered', async () => {
  await scenario({
    roster: [['L1', 'WILLIAM', WILLIAM_NBR, 'Dispatched', 11], ['L2', 'JOE', 'DAVIS000203002', 'Draft', 10]],
    loadInfo: { Load: { loadHeader: { loadId: 'L1', loadNbr: WILLIAM_NBR, routeName: 'WILLIAM' }, stops: [{ stop: { stopNbr: '007174539', stopType: 'DO', to: { seq: 2 } } }, { stop: { stopNbr: AVRT, stopType: 'DO', to: { seq: 11 } } }] } },
    stopInfo: null,
  }, async ({ store, calls }) => {
    const copy = store.get(stopPath(today, AVRT));
    assert.equal(copy.isPlanned, true, 'the plan stayed');
    assert.equal(copy.loadNbr, 'WILLIAM');
    assert.equal(copy.routeSeq, 11);
    assert.ok(copy.plan_verified_at, 'NuVizz itself confirmed it');
    const ledger = await readPlanVerdicts('davis', today);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].verdict, 'kept');
    assert.equal(ledger[0].basis, 'load-member');
    assert.equal(ledger[0].detail, `load ${WILLIAM_NBR} (WILLIAM) still holds it`);
    assert.equal(calls.filter((c) => /\/load\/info\//.test(c)).length, 1, 'one load read covered it');
    assert.equal(calls.filter((c) => /\/stop\/info\//.test(c)).length, 0, 'the record was never needed');

    const j = await (await explain(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-stop-explain?stop=${AVRT}&date=${today}`))).json();
    assert.equal(j.plan.isPlanned, true);
    assert.equal(j.roster.resolution, 'resolved');
    assert.match(j.findings.join('\n'), /reads PLANNED on WILLIAM \(stop 11\), William Kidd/);
    assert.match(j.findings.join('\n'), /A confirmed Save stamped it planned on WILLIAM .* since had NuVizz confirm the plan/);
  });
});

test('3  a quiet scan (nothing disputed) writes NO ledger document', async () => {
  await scenario({
    roster: [['L1', 'WILLIAM', WILLIAM_NBR, 'Dispatched', 11]],
    loadInfo: null, stopInfo: null,
    // The pull returns AVRT planned on WILLIAM, exactly as the board holds it.
    active: [filler, row({ nbr: AVRT, code: '20', route: 'WILLIAM', name: 'RODERICL CONEY', weight: 318, arrival: usFmt(today, '09:00 AM') })],
  }, async ({ store, body, calls }) => {
    assert.equal(store.get(stopPath(today, AVRT)).isPlanned, true);
    assert.equal(store.has(`nuvizz_ops/plan_verdicts__davis__${today}`), false, 'no dispute, no document');
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.planVerdicts, undefined);
    assert.equal(calls.some((c) => /\/(stop|load)\/info\//.test(c)), false, 'and nothing was spent asking');
  });
});
