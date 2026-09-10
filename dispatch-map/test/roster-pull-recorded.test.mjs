// test/roster-pull-recorded.test.mjs
//
// THE SCANNER RECORDS WHAT EACH ROSTER PULL SAW, so "0 loads · cached just now" can never again
// hide which of three different things happened. Driven through the REAL runRefreshStops against
// the in-memory Firestore and a stubbed vendor, then the stored document is read back — the same
// harness as test/manual-scan-call-cost.test.mjs, because a shape test could not catch a pull
// that was recorded in the wrong place or not at all.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'off';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { etDayString } from '../netlify/functions/lib/firestore.mts';

const STOP_COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr', 'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status', 'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1', 'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode', 'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime'];
const LOAD_COLS = ['loadId', 'name', 'loadNbr', 'status', 'trips'];
// TODAY, off the same ET clock the scanner keys its documents by — NOT a date typed into the
// file. This was '2026-09-08' and passed exactly once: from 2026-09-09 the scan had no roster
// to write for a date already in the past, `store.get` came back empty, and all three cases
// here failed on main and on every PR opened against it. A test that only passes on the day it
// was written is a scheduled outage with a green tick on it.
const VIEWED = etDayString();

async function manualScan(rosterBody) {
  const stops = { filterData: [Object.fromEntries(STOP_COLS.map((c) => [c, {}]))], values: [] };
  const { store, restore } = installFirestoreFake({}, async (input) => {
    const url = String(input?.url ?? input);
    return new Response(JSON.stringify(/PkgRoute/.test(url) ? rosterBody : stops), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[roster]')) lines.push(s); };
  try {
    const { runRefreshStops } = await import('../netlify/functions/lib/refresh-stops-core.mts');
    const res = await runRefreshStops(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1&viewedDate=${VIEWED}`, { method: 'POST' }));
    assert.equal((await res.json()).ok, true);
    const doc = store.get(`nuvizz_load_roster/davis__${VIEWED}`);
    return { doc, pull: doc?.pullJson ? JSON.parse(doc.pullJson) : null, lines };
  } finally { console.log = realLog; restore?.(); }
}

test('VENDOR SAID NONE: 5 column defs and zero rows — recorded as rows 0 / kept 0, period beside it', async () => {
  const { doc, pull, lines } = await manualScan({ filterData: [Object.fromEntries(LOAD_COLS.map((c) => [c, {}]))], values: [] });
  assert.ok(doc, 'the empty answer over an absent cache is written (nothing to lose)');
  assert.equal(doc.count, 0);
  assert.deepEqual({ cols: pull.cols, rows: pull.rows, kept: pull.kept, http: pull.httpStatus }, { cols: 5, rows: 0, kept: 0, http: 200 });
  // The period is whatever today makes it — the test cannot know the calendar — but it must be
  // the vendor's relative form, so a reader can see "+2d" against the date on screen.
  assert.match(pull.period, /^(0d|[+-]\d+d)$/);
  const line = lines.find((l) => l.startsWith(`[roster] ${VIEWED} `));
  assert.ok(line, `one log line per pull; got ${JSON.stringify(lines)}`);
  assert.match(line, /rows=0 kept=0/);
  assert.doesNotMatch(line, /PARSER KEPT NONE|NO COLUMN DEFS/, 'a genuine zero is not flagged as a parser fault');
});

test('PARSER KEPT NONE: rows came back with no column defs — recorded as rows 3 / kept 0, and flagged', async () => {
  const { doc, pull, lines } = await manualScan({ values: [['a', 'X', 'DAVIS000000001', 'Draft', 0], ['b', 'Y', 'DAVIS000000002', 'Draft', 0], ['c', 'Z', 'DAVIS000000003', 'Draft', 0]] });
  assert.ok(doc);
  assert.deepEqual({ cols: pull.cols, rows: pull.rows, kept: pull.kept }, { cols: 0, rows: 3, kept: 0 });
  const line = lines.find((l) => l.startsWith(`[roster] ${VIEWED} `));
  assert.match(line, /rows=3 kept=0/);
  assert.match(line, /NO COLUMN DEFS/);
  assert.match(line, /ROWS CAME BACK AND THE PARSER KEPT NONE/);
});

test('a working pull records kept-of-rows and the stored roster carries it', async () => {
  const { doc, pull } = await manualScan({ filterData: [Object.fromEntries(LOAD_COLS.map((c) => [c, {}]))], values: [['L1', 'BEN 2', 'DAVIS000198197', 'Draft', 0], ['L2', 'SUW 2', 'DAVIS000198198', 'Draft', 0]] });
  assert.equal(doc.count, 2);
  assert.deepEqual({ cols: pull.cols, rows: pull.rows, kept: pull.kept }, { cols: 5, rows: 2, kept: 2 });
});

test('…and ?explain=1 reads it back in words, at zero call cost', async () => {
  const { readLoadRoster } = await import('../netlify/functions/lib/firestore.mts');
  const { explainRosterRow } = await import('../netlify/functions/lib/roster-write.mts');
  const { store, restore } = installFirestoreFake({}, async () => { throw new Error('no vendor call allowed here'); });
  try {
    const { writeLoadRoster } = await import('../netlify/functions/lib/firestore.mts');
    await writeLoadRoster('davis', VIEWED, [], '2026-09-06T15:37:00Z', { emptyStreak: 1, emptyAt: '2026-09-06T15:37:00Z', pull: { period: '+2d', httpStatus: 200, cols: 21, rows: 0, kept: 0 } });
    const cached = await readLoadRoster('davis', VIEWED);
    assert.deepEqual(cached.pull, { period: '+2d', httpStatus: 200, cols: 21, rows: 0, kept: 0 });
    const row = explainRosterRow(VIEWED, cached);
    assert.match(row.pullNote, /vendor answered ZERO rows for period \+2d/);
    assert.ok(store.size >= 1);
  } finally { restore?.(); }
});

// ── THE DRIVER SURVIVES THE WHOLE PATH, NOT JUST THE PARSER ────────────────────────────────
//
// Chad: "Our roster scan shows who the driver is for the load, why are we not using that?" A
// unit test on normalizeLoads proves the parser reads the column; it cannot prove the field
// reaches the document the board actually reads. Between the two sit a write that REPLACES, a
// JSON-stringified loads array, and a read that parses it back — three places a new field can
// be quietly dropped. So this drives the real runRefreshStops and reads the stored roster back.
test('the driver NuVizz already has on a load reaches the stored roster — parser to Firestore, end to end', async () => {
  const { doc, pull } = await manualScan({
    filterData: [{
      loadId: { columnName: 'Key' },
      name: { columnName: 'Load Name' },
      loadNbr: { columnName: 'Load Number' },
      status: { columnName: 'Load Status' },
      'route.driver.name': { columnName: 'Driver Name' },
      trips: { columnName: 'No Of Trips' },
    }],
    values: [
      ['hex_SHEATS', 'SHEATS', 'DAVIS000203725', 'Draft', 'Sirdedrick Sheats', 8],
      ['hex_ESTES', 'ESTES', 'DAVIS000203722', 'Draft', '', 8],
      ['hex_ALPHA2', 'ALPHA 2', 'DAVIS000203707', 'Draft', 'Enter driver name', 0],
    ],
  });
  const loads = JSON.parse(doc.loadsJson);
  assert.deepEqual(loads.map((l) => [l.name, l.driver]), [
    ['SHEATS', 'Sirdedrick Sheats'],
    ['ESTES', ''],        // genuinely nobody on it — the row a dispatcher needs to find
    ['ALPHA 2', ''],      // the grid's placeholder is not a person
  ]);
  // And the pull records how many carried one, so a saved search that loses the Driver Name
  // column is a number that changes rather than a board that quietly empties.
  assert.equal(pull.drivers, 1);
  assert.equal(pull.kept, 3);
});

test('a load list with NO driver column still scans clean, and the pull says nobody was driving', async () => {
  const { doc, pull, lines } = await manualScan({
    filterData: [{ loadId: {}, name: {}, loadNbr: {}, status: {}, trips: {} }],
    values: [['hex_A', 'BEN 2', 'DAVIS000198197', 'Draft', 0]],
  });
  assert.equal(JSON.parse(doc.loadsJson)[0].driver, '', 'absent column is unknown, never a guess');
  assert.equal(pull.drivers, 0);
  // The log line names it rather than leaving a reader to notice a blank column on the board.
  const line = lines.find((l) => l.startsWith(`[roster] ${VIEWED} `));
  assert.match(line, /drivers=0/);
  assert.match(line, /lost its Driver Name column/);
});
