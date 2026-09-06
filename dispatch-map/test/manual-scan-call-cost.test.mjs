// test/manual-scan-call-cost.test.mjs — WHAT DOES ONE PRESS OF "SCAN NOW" ACTUALLY COST?
//
// Chad: "i want you to check and see why each manual refresh is calling the api so many times
// i think we may be double calling each refresh."
//
// I answered that question twice from the code and got it wrong the first time. Reading
// refresh-stops-core there are TWO persistLoadRoster call sites — the loop at the top of the
// run, and one inside scanAndWrite — and the obvious conclusion is that every date's roster is
// pulled twice. It is not: list discovery (the default, and the only path a manual press can
// reach) never enters scanAndWrite at all, so the second site is dead on the shipped path. A
// plausible story that fits the symptom is the most dangerous thing this repo produces, and
// the only thing that caught it was RUNNING the scan and counting.
//
// So this test is that count, pinned. It drives the real runRefreshStops against an in-memory
// Firestore and a stubbed vendor, and asserts the shape of the bill:
//
//   FIXED   2 saved-search pulls (active + completed) + 1 roster pull PER SCAN DATE
//   VARIABLE 1 /stop/info per genuinely NEW PRO — cached forward, so each order costs one once
//
// Three scan dates and six new orders is 5 + 6 = 11. "Fourteen calls" is this, with nine new
// orders on the board — not a doubled anything. Verified the other way too: duplicate the
// roster loop and tests 1 and 3 go red naming the count, which is the only thing that makes a
// green run mean anything.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1';
process.env.NUVIZZ_TWO_SCAN = 'on';
process.env.NUVIZZ_ENRICH = 'on';

import { installFirestoreFake } from './_firestore-fake.mjs';

// Saturday 2026-09-05 → today + the next two BUSINESS days (Labor Day Monday included; the
// horizon is business-day stepped, not weekday-filtered). Asserted below rather than assumed.
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const STOP_COLS = [
  'vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime',
];
const LOAD_COLS = ['loadId', 'name', 'loadNbr', 'status', 'trips'];

function stubbedScan(dates) {
  const stopRow = (n, date, route) => [
    `S${n}`, `SH${n}`, '20', 'Planned', `CUST ${n}`, `${n} Main St`, 'Atlanta', '30301',
    route, `PRO${n}`, usFmt(date, '10:00 AM'), usFmt(date, '6:00 AM'),
  ];
  const stops = {
    filterData: [Object.fromEntries(STOP_COLS.map((c) => [c, {}]))],
    values: dates.flatMap((d, i) => [stopRow(100 + i * 2, d, `RT-${i}`), stopRow(101 + i * 2, d, `RT-${i}`)]),
  };
  const loads = {
    filterData: [Object.fromEntries(LOAD_COLS.map((c) => [c, {}]))],
    values: [['L1', 'RT-0', 'DAVIS000200601', 'Draft', 0], ['L2', 'RT-1', 'DAVIS000200602', 'Draft', 0]],
  };
  const calls = [];
  const { restore } = installFirestoreFake({}, async (input) => {
    const url = String(input?.url ?? input);
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    const body = /PkgRoute/.test(url) ? loads : stops;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { calls, restore };
}

// The vendor routes, told apart by their URL. PkgRoute IS the roster list (customListDefId
// 35833); VizzonStop is the saved stop search; /stop/info is per-PRO enrichment.
const tally = (calls) => ({
  roster: calls.filter((u) => /entity\/filterdata\/PkgRoute/.test(u)).length,
  list: calls.filter((u) => /entity\/filterdata\/VizzonStop/.test(u)).length,
  enrich: calls.filter((u) => /\/stop\/info\//.test(u)).length,
  firestore: calls.filter((u) => /\/v1\/projects\//.test(u)).length,
});

async function runManualScan() {
  const { calls, restore } = stubbedScan(['2026-09-05', '2026-09-07', '2026-09-08']);
  try {
    const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
    const res = await runRefreshStops(new Request(
      'https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' },
    ));
    return { body: await res.json(), t: tally(calls) };
  } finally { restore?.(); }
}

test('ONE MANUAL REFRESH: exactly one roster pull per scan date — not two', () => {
  // The whole question Chad asked. persistLoadRoster runs once, from the loop at the top of
  // the run, for every date in the horizon. Anything that makes this 6 is the double-call.
  return runManualScan().then(({ body, t }) => {
    assert.equal(body.ok, true, JSON.stringify(body).slice(0, 300));
    assert.equal(body.dates.length, 3, 'three scan dates is the premise of the counts below');
    assert.equal(t.roster, 3, `roster pulled ${t.roster}× for 3 dates`);
  });
});

test('…and exactly TWO saved-search pulls for the whole run, not two per date', () => {
  // The two-saved-search source is one ACTIVE pull + one COMPLETED pull, merged and bucketed
  // by date. Per-date list pulls would be the other way this bill triples without anyone
  // noticing — the pre-TWO_SCAN behaviour.
  return runManualScan().then(({ t }) => assert.equal(t.list, 2, `${t.list} saved-search pulls`));
});

test('THE FIXED COST OF A PRESS IS FIVE CALLS; the rest is one per NEW order', () => {
  return runManualScan().then(({ t }) => {
    assert.equal(t.roster + t.list, 5, 'two saved searches + three rosters');
    // Six stops across three dates, every PRO new to this cold index → six enrichments.
    // Enriched detail is carried forward in the index, so the SECOND press of the day pays
    // only for orders that arrived in between. That is why a busy morning reads as "14 calls":
    // five fixed plus nine new PROs, each of which is a real new order.
    assert.equal(t.enrich, 6, `${t.enrich} /stop/info for 6 new PROs`);
    assert.equal(t.roster + t.list + t.enrich, 11);
  });
});
