// test/roster-shells-endpoint.test.mjs — THE ROSTER ENDPOINT OFFERS THE SHELLS, AT ZERO VENDOR COST.
//
// Driven through the REAL nuvizz-loads-roster handler against the in-memory Firestore. The
// vendor fetch is not stubbed — it THROWS — so every assertion here also proves that finding
// the standard shells never reaches NuVizz. That is the whole bargain: Chad's Sunday planning
// costs Firestore reads and nothing from the 2,000-call ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { shellLookbackDates, closedDayReason } from '../netlify/functions/lib/roster-shells.mts';

const etDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = etDay(new Date());
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// The next weekday after today — "the day I want to build on", viewed from whatever today is.
const VIEWED = (() => { let d = addDays(TODAY, 1); while (closedDayReason(d)) d = addDays(d, 1); return d; })();
// The next Saturday on or after today — a day Davis does not run.
const SATURDAY = (() => { let d = TODAY; while (new Date(d + 'T00:00:00Z').getUTCDay() !== 6) d = addDays(d, 1); return d; })();
// The three captured delivery days before it, as the endpoint will find them.
const SOURCES = shellLookbackDates(VIEWED).slice(0, 3);
const PAST = addDays(SOURCES[2], -7);

const load = (name, i, trips = 0) => ({ loadId: `id-${name}-${i}`, name, loadNbr: `DAVIS0002${String(i).padStart(5, '0')}`, status: trips ? 'Dispatched' : 'Draft', trips });
const rosterDoc = (date, loads, at) => ({
  tenant: 'davis', date, at, count: loads.length, loadsJson: JSON.stringify(loads), emptyStreak: 0, emptyAt: null,
  pullJson: JSON.stringify({ period: '0d', httpStatus: 200, cols: 21, rows: loads.length, kept: loads.length }),
});
const NOW = new Date().toISOString();
const ZERO_PULL = { period: '+2d', httpStatus: 200, cols: 21, rows: 0, kept: 0 };
const emptyDoc = (date) => ({ tenant: 'davis', date, at: NOW, count: 0, loadsJson: '[]', emptyStreak: 1, emptyAt: NOW, pullJson: JSON.stringify(ZERO_PULL) });

const seedWeek = () => ({
  [`nuvizz_load_roster/davis__${SOURCES[0]}`]: rosterDoc(SOURCES[0], [load('SUW 2', 1), load('ATL', 2), load('DIXON', 3, 11), load('BRETT SPRADLEY', 4, 6)], `${SOURCES[0]}T16:00:00Z`),
  [`nuvizz_load_roster/davis__${SOURCES[1]}`]: rosterDoc(SOURCES[1], [load('SUW 2', 5), load('ATL', 6), load('DIXON', 7)], `${SOURCES[1]}T16:00:00Z`),
  [`nuvizz_load_roster/davis__${SOURCES[2]}`]: rosterDoc(SOURCES[2], [load('SUW 2', 8), load('ATL', 9), load('TRAILER 3', 10)], `${SOURCES[2]}T16:00:00Z`),
});

async function read(seed, date) {
  const { restore, log } = installFirestoreFake(seed);   // no onOther → any vendor fetch THROWS
  try {
    const mod = await import('../netlify/functions/nuvizz-loads-roster.mts');
    mod._resetShellMemo();                                 // each test seeds its own week
    const res = await mod.default(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-loads-roster?date=${date}`));
    return { status: res.status, body: await res.json(), log };
  } finally { restore?.(); }
}

test("CHAD'S SUNDAY: the viewed day's capture is empty → the envelope carries the shells the last three days agree on", async () => {
  const { status, body } = await read({ ...seedWeek(), [`nuvizz_load_roster/davis__${VIEWED}`]: emptyDoc(VIEWED) }, VIEWED);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.source, 'cache', 'an empty capture taken today is served, free');
  assert.equal(body.count, 0);
  assert.deepEqual(body.pull, ZERO_PULL, 'what the capture saw rides along, so the line can say "NuVizz answered 0 rows"');
  assert.deepEqual(body.shells.names, ['ATL', 'DIXON', 'SUW 2'], 'BRETT SPRADLEY and TRAILER 3 were one-day names');
  assert.deepEqual(body.shells.from, SOURCES, 'and it says which days it took them from');
});

test('after he saved SUW 2 and the scan captured it, the other shells are still offered', async () => {
  const doc = rosterDoc(VIEWED, [load('SUW 2', 99, 4)], NOW);
  const { body } = await read({ ...seedWeek(), [`nuvizz_load_roster/davis__${VIEWED}`]: doc }, VIEWED);
  assert.equal(body.count, 1);
  assert.deepEqual(body.shells.names, ['ATL', 'DIXON', 'SUW 2'], 'the full standard list is sent; the screen subtracts what it shows');
});

test('an ORDINARY day — NuVizz generated the roster — carries no shells', async () => {
  const full = rosterDoc(VIEWED, [load('SUW 2', 21), load('ATL', 22), load('DIXON', 23)], NOW);
  const { body } = await read({ ...seedWeek(), [`nuvizz_load_roster/davis__${VIEWED}`]: full }, VIEWED);
  assert.equal(body.count, 3);
  assert.equal(body.shells, null);
});

test('a PAST day is never offered shells, even when its capture is empty', async () => {
  const { body } = await read({ ...seedWeek(), [`nuvizz_load_roster/davis__${PAST}`]: emptyDoc(PAST) }, PAST);
  assert.equal(body.ok, true);
  assert.equal(body.shells, null);
});

test('with nothing captured in the look-back window there is nothing to offer — and still no vendor call', async () => {
  const { body } = await read({ [`nuvizz_load_roster/davis__${VIEWED}`]: emptyDoc(VIEWED) }, VIEWED);
  assert.equal(body.ok, true);
  assert.equal(body.shells, null);
});

test('automatic reads switched off (NUVIZZ_ROSTER_AUTO_LIVE=0): a never-captured day answers source:none and NO shells — nothing verified, nothing offered', async () => {
  process.env.NUVIZZ_ROSTER_AUTO_LIVE = '0';
  try {
    const { body } = await read(seedWeek(), VIEWED);
    assert.equal(body.ok, true);
    assert.equal(body.source, 'none');
    assert.equal(body.shells, null, 'the endpoint has not asked NuVizz about this day, so it may not call anything "not in NuVizz yet"');
  } finally { delete process.env.NUVIZZ_ROSTER_AUTO_LIVE; }
});

test('A HALF-BUILT DAY IS NOT A SOURCE: the sixty routes he built by hand do not outvote the forty he did not', async () => {
  // The most recent captured weekday holds only built routes (no Draft shell at zero trips):
  // it is skipped, and the three generated days behind it decide the list.
  const built = Array.from({ length: 3 }, (_, i) => load(`HAND ${i}`, 40 + i, 7));
  const hand = rosterDoc(SOURCES[0], built, `${SOURCES[0]}T16:00:00Z`);
  const seed = { ...seedWeek(), [`nuvizz_load_roster/davis__${SOURCES[0]}`]: hand,
    [`nuvizz_load_roster/davis__${shellLookbackDates(VIEWED)[3]}`]: rosterDoc(shellLookbackDates(VIEWED)[3], [load('SUW 2', 50), load('ATL', 51), load('DIXON', 52, 11)], `${shellLookbackDates(VIEWED)[3]}T16:00:00Z`),
    [`nuvizz_load_roster/davis__${VIEWED}`]: emptyDoc(VIEWED) };
  const { body } = await read(seed, VIEWED);
  assert.deepEqual(body.shells.names, ['ATL', 'DIXON', 'SUW 2']);
  assert.ok(!body.shells.from.includes(SOURCES[0]), 'the hand-built day is not among the sources');
  assert.ok(!body.shells.names.some((n) => /^HAND/.test(n)));
});

test('a CLOSED day (the next Saturday) gets no shells even with an empty capture from today', async () => {
  const { body } = await read({ ...seedWeek(), [`nuvizz_load_roster/davis__${SATURDAY}`]: emptyDoc(SATURDAY) }, SATURDAY);
  assert.equal(body.ok, true);
  assert.equal(body.shells, null);
});
