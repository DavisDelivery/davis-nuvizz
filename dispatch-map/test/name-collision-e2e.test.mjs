// test/name-collision-e2e.test.mjs — BUFORD, 2026-09-15, RUN THROUGH THE REAL SCANNER (v1.31.0).
//
// Chad: "why do these 2 loads not match — nuvizz shows one thing so i did a refresh of our
// board to make sure it was correct then our board still shows something different." NuVizz's
// BUFORD (DAVIS000203661, the 9/15 roster: Draft, 7 trips) held seven orders. Our board held
// eight under the name: the seven plus 007174083-1 (ANNANDALE VILLAGE), a re-delivery with a
// 9/10 arrival sitting on the 9/14 BUFORD (DAVIS000203544). The list says "BUFORD" for all
// eight, boardDayFor clamps the old arrival onto today, and no refresh could change that
// answer. runRefreshStops runs here against an in-memory Firestore and a stubbed vendor that
// throws on any URL it was not given, so the cost of each scenario is exactly the calls named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
delete process.env.AUTH_REQUIRED;
delete process.env.NUVIZZ_NAME_COLLISION;

const { etDayString, readPlanVerdicts, readNameCollisionMemo } = await import('../netlify/functions/lib/firestore.mts');
const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
const explain = (await import('../netlify/functions/nuvizz-stop-explain.mts')).default;

const today = etDayString();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime', 'vizzonInfo.stopUpdatedDttm'];
const row = ({ nbr, ship = nbr, code, route = '', name = 'CUST', weight = 100, arrival, created, updated }) =>
  [nbr, ship, code, { 10: 'Un-Planned', 20: 'Planned', 90: 'Completed', 80: 'Unable' }[code] || code, name, '1 Main St', 'BUFORD', '30518', route, '', String(weight), arrival, created || arrival, updated || arrival];
const search = (rows) => ({ filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows });
const rosterOf = (loads) => ({ filterData: [Object.fromEntries(['loadId', 'name', 'loadNbr', 'status', 'trips'].map((c) => [c, {}]))], values: loads });
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;

const SEVEN = ['007175989', '007176033', '007176123', '007176621', '007176729', '007176367', '007176121'];
const STRAY = '007174083-1';
const TODAY_NBR = 'DAVIS000203661';
const OLD_NBR = 'DAVIS000203544';
const fiveDaysAgo = addDays(today, -5);

// The 9/15 pull as NuVizz's list gives it: eight rows named BUFORD, one of them with an arrival
// five days back (the clamp files it on today). Nothing else on the board, so the day is small.
const pullRows = (extra = []) => [
  ...SEVEN.map((n) => row({ nbr: n, code: '20', route: 'BUFORD', arrival: usFmt(today, '08:00 AM') })),
  row({ nbr: STRAY, code: '20', route: 'BUFORD', name: 'ANNANDALE VILLAGE', weight: 29, arrival: usFmt(fiveDaysAgo, '12:00 PM') }),
  ...extra,
];
const loadInfoOf = (nbrs) => ({ Load: { loadHeader: { loadId: '6aa17df75b97db56e47c358c', loadNbr: TODAY_NBR, routeName: 'BUFORD' }, stops: nbrs.map((n, i) => ({ stop: { stopNbr: n, stopType: 'DO', to: { seq: i + 1 } } })) } });
// The 9/14 roster in the cache, as the scan's own hourly roster pull left it — where the other
// BUFORD lives, for the ledger's wording. Zero vendor calls: it is a cached document.
const yesterdayRoster = () => ({
  [`nuvizz_load_roster/davis__${addDays(today, -1)}`]: { tenant: 'davis', date: addDays(today, -1), at: `${addDays(today, -1)}T23:00:00.000Z`, loadsJson: JSON.stringify([{ loadId: '6aa01b395b97db56e47bff61', name: 'BUFORD', loadNbr: OLD_NBR, status: 'Draft', driver: '', trips: 1 }]) },
});

async function scenario({ seed = {}, roster, loadInfo, active, env = {} }, inspect) {
  const calls = [];
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  const fake = installFirestoreFake({ ...yesterdayRoster(), ...seed }, async (url, init) => {
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    if (/PkgRoute/.test(url)) return json(rosterOf(roster));
    if (/VizzonStop/.test(url)) {
      const id = JSON.parse(init?.body || '{}').customListDefId;
      return json(search(id === 77128 ? active : []));
    }
    if (/\/load\/info\//.test(url)) return loadInfo ? json(loadInfo) : new Response('{}', { status: 404 });
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.ok, true, 'the scan itself succeeded');
    await inspect({ store: fake.store, body, calls, loadReads: calls.filter((c) => /\/load\/info\//.test(c)).length });
  } finally {
    fake.restore();
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

test('BUFORD: 8 rows under a name the roster gives one load of 7 → ONE load read, the stray comes off today, the seven stay, the ledger and the explain say why', async () => {
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: loadInfoOf(SEVEN),
    active: pullRows(),
  }, async ({ store, body, calls, loadReads }) => {
    for (const n of SEVEN) assert.ok(store.get(stopPath(today, n)), `${n} is on today's board`);
    assert.equal(store.get(stopPath(today, STRAY)), undefined, 'ANNANDALE VILLAGE is NOT on today\'s board');
    assert.equal(loadReads, 1, 'exactly one /load/info was spent');
    assert.equal(calls.filter((c) => /\/stop\/info\//.test(c)).length, 0, 'no stop-record read — the load answered');

    const run = (body.dates || []).find((d) => d.date === today);
    assert.deepEqual(run.nameCollisions, { checked: 1, reads: 1, memoHits: 0, dropped: 1, held: 0, skipped: 0, sample: [`${STRAY}<BUFORD`] });
    assert.equal(run.count, 7, 'the day landed with seven rows');

    const ledger = await readPlanVerdicts('davis', today);
    assert.equal(ledger.length, 1);
    const v = ledger[0];
    assert.equal(v.stopNbr, STRAY);
    assert.equal(v.route, 'BUFORD');
    assert.equal(v.verdict, 'dropped');
    assert.equal(v.basis, 'name-collision');
    assert.equal(v.listStatus, '20');
    assert.match(v.detail, new RegExp(`^not on ${TODAY_NBR} \\(BUFORD, 7 stops on the ${today} roster\\) — the load's own membership read at .* does not list it; another load named BUFORD is on the ${addDays(today, -1)} roster \\(${OLD_NBR}, Draft, 1 stop\\) — its own day is ${fiveDaysAgo}, so it stays on that day's board and comes off ${today}$`));
    assert.deepEqual(v.path, [`roster ${today}: BUFORD → ${TODAY_NBR}, 7 stops; the board held 8 rows under the name`, `membership read: ${TODAY_NBR} holds 7 of them`]);

    const memo = await readNameCollisionMemo('davis');
    assert.ok(memo[TODAY_NBR], 'the read is memoised for the next scan');
    assert.equal(memo[TODAY_NBR].trips, 7);
    assert.equal(memo[TODAY_NBR].rows, 8);
    assert.ok(memo[TODAY_NBR].members.includes('007175989'));

    // THE EXPLAIN, from the same documents, spends nothing and names the cause.
    const j = await (await explain(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-stop-explain?stop=${STRAY}&date=${today}`))).json();
    assert.equal(j.ok, true);
    assert.equal(j.served.source, 'none');
    const findings = j.findings.join('\n');
    assert.match(findings, /is on NO board document for today/);
    assert.match(findings, new RegExp(`the scan left it OFF the ${today} board — not on ${TODAY_NBR} \\(BUFORD, 7 stops on the ${today} roster\\)`));
    assert.match(findings, new RegExp(`another load named BUFORD is on the ${addDays(today, -1)} roster \\(${OLD_NBR}, Draft, 1 stop\\)`));
    assert.equal(j.recentScans[0].nameCollisions[0].dropped, 1, 'the run ledger carries it too');
    assert.equal(calls.some((c) => /explain/.test(c)), false, 'the explain made no vendor call');
  });
});

test('the SECOND scan of the same collision spends NO load read — the memo answers — and the stray stays off', async () => {
  // Seed the second run with the first run's store, memo and all.
  let carried = {};
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: loadInfoOf(SEVEN),
    active: pullRows(),
  }, async ({ store }) => { carried = Object.fromEntries(store); });
  await scenario({
    seed: carried,
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: null,                                            // a read now would 404 — and there is none
    active: pullRows(),
  }, async ({ store, body, loadReads }) => {
    assert.equal(loadReads, 0, 'memo hit: no /load/info');
    assert.equal(store.get(stopPath(today, STRAY)), undefined, 'still off today');
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.nameCollisions.memoHits, 1);
    assert.equal(run.nameCollisions.reads, 0);
    assert.equal(run.nameCollisions.dropped, 1);
  });
});

test('the roster now counts one more (an order moved onto today\'s BUFORD): 8 rows vs 8 trips is no collision — no read, and the moved order stays', async () => {
  let carried = {};
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: loadInfoOf(SEVEN),
    active: pullRows(),
  }, async ({ store }) => { carried = Object.fromEntries(store); });
  await scenario({
    seed: carried,
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 8]],
    loadInfo: loadInfoOf([...SEVEN, STRAY]),                  // NuVizz now holds it on today's load
    active: pullRows(),
  }, async ({ store, body, loadReads }) => {
    assert.equal(loadReads, 0, '8 rows vs 8 trips and no sequence clash: no collision to ask about');
    assert.ok(store.get(stopPath(today, STRAY)), 'the order is back on today\'s board — the load holds it now');
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.nameCollisions, undefined, 'nothing to report');
  });
});

test('the load read FAILS → nothing is dropped, nothing is ledgered, the run says skipped', async () => {
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: null,
    active: pullRows(),
  }, async ({ store, body, loadReads }) => {
    assert.equal(loadReads, 1, 'it tried once');
    assert.ok(store.get(stopPath(today, STRAY)), 'a failed read never takes a row off the board');
    assert.equal((await readPlanVerdicts('davis', today)).length, 0);
    const run = (body.dates || []).find((d) => d.date === today);
    assert.deepEqual(run.nameCollisions, { checked: 1, reads: 1, memoHits: 0, dropped: 0, held: 0, skipped: 1 });
    assert.deepEqual(await readNameCollisionMemo('davis'), {}, 'a failed read is not memoised');
  });
});

test('a stray whose own day is TODAY is kept (never hides today\'s freight) and ledgered HELD', async () => {
  const todayStray = row({ nbr: '007177000', code: '20', route: 'BUFORD', name: 'TODAY MISFILED', arrival: usFmt(today, '09:00 AM') });
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: loadInfoOf(SEVEN),
    active: pullRows([todayStray]),
  }, async ({ store, body }) => {
    assert.ok(store.get(stopPath(today, '007177000')), 'today\'s order stays on today\'s board');
    assert.equal(store.get(stopPath(today, STRAY)), undefined, 'the past-day stray still comes off');
    const run = (body.dates || []).find((d) => d.date === today);
    assert.equal(run.nameCollisions.dropped, 1);
    assert.equal(run.nameCollisions.held, 1);
    const held = (await readPlanVerdicts('davis', today)).find((r) => r.stopNbr === '007177000');
    assert.equal(held.verdict, 'held');
    assert.equal(held.basis, 'name-collision');
    assert.match(held.detail, new RegExp(`its own day is ${today}, so it stays on this board rather than vanish$`));
  });
});

test('NUVIZZ_NAME_COLLISION=off puts it back: no load read, all eight rows on the board', async () => {
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7]],
    loadInfo: loadInfoOf(SEVEN),
    active: pullRows(),
    env: { NUVIZZ_NAME_COLLISION: 'off' },
  }, async ({ store, body, loadReads }) => {
    assert.equal(loadReads, 0);
    assert.ok(store.get(stopPath(today, STRAY)));
    assert.equal((body.dates || []).find((d) => d.date === today).nameCollisions, undefined);
  });
});

test('two loads named BUFORD on the SAME day\'s roster: nobody is judged, no read is spent', async () => {
  await scenario({
    roster: [['6aa17df75b97db56e47c358c', 'BUFORD', TODAY_NBR, 'Draft', 7], ['6aa01b395b97db56e47bff61', 'BUFORD', OLD_NBR, 'Draft', 1]],
    loadInfo: loadInfoOf(SEVEN),
    active: pullRows(),
  }, async ({ store, loadReads }) => {
    assert.equal(loadReads, 0);
    assert.ok(store.get(stopPath(today, STRAY)), 'a contested name is the §S case — left to the board\'s own ambiguity rules');
  });
});
