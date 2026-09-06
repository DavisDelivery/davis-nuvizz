// test/enrich-budget.test.mjs — THE ENRICHMENT BACKSTOP MUST BOUND THE RUN, NOT THE DATE.
//
// ENRICH_MAX is the guard against the one unbounded amplifier in the scanner: one /stop/info per
// genuinely-new PRO, and a registry that is cold or keyed wrong makes EVERY stop look new. Its
// env var is named NUVIZZ_ENRICH_MAX_PER_SCAN and its comment promised "even a cold/empty
// registry can never burst more than ENRICH_MAX calls in one scan".
//
// It was applied inside `for (const date of targets)`, so it was really a per-DATE cap and the
// true bound was ENRICH_MAX x the horizon. Measured against the real scanner with a stubbed
// vendor, three dates each carrying more new PROs than the cap:
//
//     before      400/date -> 750 /stop/info      250/date -> 750      100/date -> 300
//     after       400/date -> 250                 250/date -> 250      100/date -> 250
//
// 750 is 37.5% of the enforced 2,000/day ceiling in a single fire. And it is NOT a property of
// the manual button — `isManual` appears nowhere between the date loop and the enrichment block,
// so a scheduled tick on a cold registry pays exactly the same. That is the burst this backstop
// exists to prevent, arriving through the backstop itself.
//
// These tests drive the REAL runRefreshStops. A shape test could not have caught this: the cap
// was present, correct-looking and in the wrong scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1';
process.env.NUVIZZ_TWO_SCAN = 'on';
process.env.NUVIZZ_ENRICH = 'on';

const ENRICH_MAX = 250;                                    // the shipped default
const DATES = ['2026-09-06', '2026-09-07', '2026-09-08'];
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime'];

// DISJOINT stop numbers per date, so each date genuinely presents `perDate` NEW PROs. Sharing
// numbers across dates would let the registry absorb the second and third date and the test
// would pass against the broken code.
async function pressWith(perDate) {
  const rows = DATES.flatMap((d, di) => Array.from({ length: perDate }, (_, i) => {
    const n = di * 100000 + i;
    return [`S${n}`, `SH${n}`, '20', 'Planned', `C${n}`, `${n} Main St`, 'Atlanta', '30301',
      `RT-${di}`, `PRO${n}`, usFmt(d, '10:00 AM'), usFmt(d, '6:00 AM')];
  }));
  const stops = { filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows };
  const loads = {
    filterData: [Object.fromEntries(['loadId', 'name', 'loadNbr', 'status', 'trips'].map((c) => [c, {}]))],
    values: [['L1', 'RT-0', 'DAVIS000200601', 'Draft', 0]],
  };
  const calls = [];
  const { restore } = installFirestoreFake({}, async (input) => {
    const url = String(input?.url ?? input);
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    return new Response(JSON.stringify(/PkgRoute/.test(url) ? loads : stops),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  try {
    const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
    await runRefreshStops(new Request(
      'https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
  } finally { restore?.(); }
  return calls.filter((u) => /\/stop\/info\//.test(u)).length;
}

test('ONE RUN NEVER SPENDS MORE THAN ENRICH_MAX, however many dates it covers', async () => {
  // The defect, stated as a number: this returned 750 before the budget was hoisted out of the
  // date loop. Anything above ENRICH_MAX here means the cap is back in the wrong scope.
  const n = await pressWith(400);
  assert.equal(n, ENRICH_MAX, `${n} /stop/info in one run — the cap is per-date again`);
});

test('...and exactly at the cap per date, which is the boundary that hid it', async () => {
  // 250/date also produced 750: every date got a fresh allowance, so the cap never appeared to
  // bind and the warning never fired. Sitting exactly ON the boundary is the case a test written
  // from the code (rather than from a measurement) would most likely have chosen and passed.
  const n = await pressWith(250);
  assert.equal(n, ENRICH_MAX);
});

test('the budget is SHARED across dates, not reset — 100/date is 250, not 300', async () => {
  // Three dates wanting 100 each need 300; the run may only spend 250, so the third date is
  // partly deferred to the next tick. This is the documented behaviour ("a cold board backfills
  // over a few ticks") finally being true.
  const n = await pressWith(100);
  assert.equal(n, ENRICH_MAX);
});

test('a run under the budget still enriches everything — no new throttle on a normal day', async () => {
  // The ordinary case must not regress: 50 x 3 = 150 is inside the budget and all of it lands.
  const n = await pressWith(50);
  assert.equal(n, 150, 'a light board must enrich every new PRO in one pass');
});
