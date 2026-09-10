// test/window-pull-once.test.mjs — THE ROUTING DATE WINDOW IS PULLED ONCE, AND CHEAPLY (v1.5.0).
//
// Chad, Sep 10 2026, on the bottom grid's Status filter over a "Last 7 days" window: "once these
// stops load, every time I change a filter it shouldn't have to reload them from Firestore — it
// should load them all one time in the beginning and then the filter just filters what is shown
// in the panel, to save time."
//
// He was describing real waste. The client sent the ticked statuses with the pull AND kept
// `statusSel` in the fetch effect's dependency list, so every tick re-read up to 62 day documents
// and re-reconciled the open-order pool — to compute a subset the client then computed again
// anyway (filteredRows has always re-applied the status check post-overlay, because the server's
// copy ran before the plan overlay and was wrong about a just-saved row).
//
// Two properties make dropping it safe, and they are what these tests pin:
//   1. the endpoint serves EVERY status when none are asked for, so the client has the whole
//      window to filter — an all-status pull that silently trimmed would hide freight;
//   2. it reads those day documents through the Map feed's LEAN field mask, so the one
//      all-status pull costs less than the filtered pulls it replaces (the raw NuVizz object is
//      ~55% of a full stop and nothing in the grid reads it).
// And `statusCodes` still filters when it IS sent, because Check vs NuVizz sends it deliberately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;

const explorer = (await import('../netlify/functions/nuvizz-stop-explorer.mts')).default;
const { LEAN_STOP_FIELDS } = await import('../netlify/functions/lib/board-fields.mts');
const { etDayString } = await import('../netlify/functions/lib/firestore.mts');

const today = etDayString();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const D1 = addDays(today, -1);

const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;
const row = (nbr, over = {}) => ({
  stopNbr: nbr, businessName: 'CUST ' + nbr, addr1: '1 Main St', city: 'ATLANTA', zip: '30303',
  boardDate: over.day || today, scheduledDate: over.day || today, lat: 33.7, lng: -84.4, weight: 100,
  status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, ...over,
});

// A board carrying one row of each status the grid's buckets cover, across two days.
const seed = () => ({
  [`nuvizz_stop_index/davis__${today}`]: { tenant: 'davis', date: today, last_scanned_at: today + 'T10:00:00.000Z' },
  [stopPath(today, 'U1')]: row('U1'),
  [stopPath(today, 'P1')]: row('P1', { status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, routeName: 'WILLIAM', loadNbr: 'WILLIAM' }),
  [stopPath(today, 'T1')]: row('T1', { status: '40', normalizedStatus: 'OUT_FOR_DEL', isPlanned: true, isUnplanned: false, routeName: 'JOE', loadNbr: 'JOE' }),
  [stopPath(today, 'C1')]: row('C1', { status: '90', normalizedStatus: 'DELIVERED', isPlanned: true, isUnplanned: false, routeName: 'JOE', loadNbr: 'JOE' }),
  [`nuvizz_stop_index/davis__${D1}`]: { tenant: 'davis', date: D1, last_scanned_at: D1 + 'T23:00:00.000Z' },
  [stopPath(D1, 'U2')]: row('U2', { day: D1 }),
});

const POST = (body) => new Request('https://x.netlify.app/.netlify/functions/nuvizz-stop-explorer', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
/** The cache path is chosen by a wide window; a date range is always cache-served. */
const range = (extra = {}) => POST({ fromDate: D1, toDate: today, page: 1, pageSize: 2000, ...extra });

async function withStore(fn) {
  const fake = installFirestoreFake(seed());   // no onOther → any non-Firestore fetch THROWS
  try { return await fn(fake); } finally { fake.restore(); }
}
const nbrs = (j) => (j.rows || []).map((r) => String(r.stopNbr)).sort();

test('NO statusCodes → every status in the window comes back, so the panel has something to filter', async () => {
  await withStore(async (fake) => {
    const j = await (await explorer(range())).json();
    assert.equal(j.ok, true);
    assert.equal(j.source, 'cache', 'a date range is served from our own day documents');
    assert.deepEqual(nbrs(j), ['C1', 'P1', 'T1', 'U1', 'U2'], 'un-planned, planned, in-transit and completed alike');
    assert.equal(fake.log.other.length, 0, 'and not one vendor call — this is Firestore only');
  });
});

test('the day documents are read through the LEAN mask — the one all-status pull is cheaper than the filtered ones it replaces', async () => {
  await withStore(async (fake) => {
    await (await explorer(range())).json();
    const stopLists = fake.log.listMasks.filter((l) => /\/stops$/.test(l.path));
    assert.equal(stopLists.length, 2, 'one list per day in the range');
    for (const l of stopLists) {
      assert.deepEqual(l.mask, LEAN_STOP_FIELDS, `${l.path} must ask for the lean projection, not the whole document`);
    }
    // The raw NuVizz object is the bulk of a stored stop and nothing in the grid or on the map
    // reads it whole; only these three slices are load-bearing.
    assert.ok(!LEAN_STOP_FIELDS.includes('raw'), 'never the whole raw object');
    for (const k of ['raw.load', 'raw.stop.from', 'raw.stopExecutionInfo']) {
      assert.ok(LEAN_STOP_FIELDS.includes(k), `${k} is still served`);
    }
  });
});

test('the lean projection still carries every field the window rows are read for', async () => {
  // The window feeds the grid, the plan overlay, the board reflect AND the Routing map's
  // selectable markers. A field dropped here is a column that goes blank or a pin that vanishes.
  for (const f of [
    'stopNbr', 'businessName', 'addr1', 'city', 'zip', 'lat', 'lng',        // grid + marker
    'status', 'normalizedStatus', 'isPlanned', 'isUnplanned',               // the status filter
    'routeName', 'loadNbr', 'routeSeq', 'driverName',                       // plan + search hay
    'board_write_at', 'board_write_planned',                                // the confirmed-save hold
    'boardDate', 'scheduledDate', 'requestedDate', 'stopId',                // pool reconcile
    'weight', 'cartons', 'volume',                                          // the header totals
  ]) assert.ok(LEAN_STOP_FIELDS.includes(f), `${f} must survive the mask`);
});

test('statusCodes STILL filters when it is sent — Check vs NuVizz depends on that', async () => {
  await withStore(async () => {
    const j = await (await explorer(range({ statusCodes: ['10'] }))).json();
    assert.deepEqual(nbrs(j), ['U1', 'U2'], 'only the un-planned rows');
    const two = await (await explorer(range({ statusCodes: ['10', '20'] }))).json();
    assert.deepEqual(nbrs(two), ['P1', 'U1', 'U2']);
  });
});

test('the filtered pull and the all-status pull read the SAME documents — the filter never saved a read', async () => {
  // This is the arithmetic behind the change: filtering server-side trimmed the RESPONSE and
  // nothing else, so paying for it on every status tick bought a smaller payload at the price of
  // the whole read. Same lists either way; the client can filter what it already holds.
  const listsFor = async (body) => {
    const fake = installFirestoreFake(seed());
    try { await (await explorer(body)).json(); return fake.log.lists.filter((p) => /\/stops$/.test(p)).sort(); }
    finally { fake.restore(); }
  };
  assert.deepEqual(await listsFor(range({ statusCodes: ['10'] })), await listsFor(range()));
});
