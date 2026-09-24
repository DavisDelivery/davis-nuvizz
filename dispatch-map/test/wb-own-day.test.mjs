// A ROUTE IN THE ROUTES PANEL OPENS IN COMPARE, EVEN WHEN NUVIZZ DATED IT YESTERDAY.
//
// Chad, 2026-09-24, with ESTES APPT in the Routes panel and the Compare card refusing it:
// "if its panel for routes it should load."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { wbOwnDayRosterEnabled, routeOwnDay, ownDayIdentity } from '../src/lib/wb-own-day.js';

// The real case, read off the stored board and rosters on 2026-09-24.
const BOARD = '2026-09-24';
const estesAppt = ['ESTES-0408714489', 'ESTES-0498235193', 'ESTES-0538261676', 'ESTES-2288345625']
  .map((n) => ({ stopNbr: n, routeName: 'ESTES APPT', loadNbr: 'ESTES APPT', boardDate: '2026-09-23', scheduledDate: BOARD, normalizedStatus: 'SCHEDULED' }));
const ROSTER_0923 = [
  { loadId: 'id-appt', name: 'ESTES APPT', loadNbr: 'DAVIS000204757', status: 'Draft', trips: 5 },
  { loadId: 'id-estes', name: 'ESTES', loadNbr: 'DAVIS000204659', status: 'Completed', trips: 4 },
];

test('ESTES APPT: its stops say 9/23, and 9/23\'s roster has exactly one ESTES APPT — that is its load', () => {
  const day = routeOwnDay(estesAppt, BOARD);
  assert.equal(day, '2026-09-23');
  assert.deepEqual(ownDayIdentity(ROSTER_0923, 'ESTES APPT'),
    { loadId: 'id-appt', loadNbr: 'DAVIS000204757', name: 'ESTES APPT', status: 'Draft' });
});

test('the look-back never opens a card on the wrong same-named load', () => {
  // Stops spread over two NuVizz days: which day's load would it be? Refuse.
  assert.equal(routeOwnDay([...estesAppt, { ...estesAppt[0], stopNbr: 'X', boardDate: '2026-09-22' }], BOARD), null);
  // Two LIVE loads by the name on that day: nobody speaks for it — the screen's own rule.
  assert.equal(ownDayIdentity([...ROSTER_0923, { loadId: 'id-appt-2', name: 'ESTES APPT', loadNbr: 'DAVIS000204800', status: 'Draft' }], 'ESTES APPT'), null);
  // No load by the name at all.
  assert.equal(ownDayIdentity(ROSTER_0923, 'ESTES APPT 2'), null);
  // A cancelled load never speaks for live freight.
  assert.equal(ownDayIdentity([{ loadId: 'c', name: 'ESTES APPT', loadNbr: 'DAVIS0001', status: 'Cancelled' }], 'ESTES APPT'), null);
  // A roster row with no number and no id is no identity.
  assert.equal(ownDayIdentity([{ name: 'ESTES APPT', status: 'Draft' }], 'ESTES APPT'), null);
});

test('a cancelled twin loses to the live load, exactly as it does on today\'s roster', () => {
  const r = [...ROSTER_0923, { loadId: 'dead', name: 'ESTES APPT', loadNbr: 'DAVIS000204700', status: 'Cancelled' }];
  assert.equal(ownDayIdentity(r, 'ESTES APPT')?.loadNbr, 'DAVIS000204757');
});

test('only an EARLIER own day counts, and finished stops do not vote', () => {
  assert.equal(routeOwnDay(estesAppt.map((s) => ({ ...s, boardDate: BOARD })), BOARD), null, 'same day: today\'s roster is the answer');
  assert.equal(routeOwnDay(estesAppt.map((s) => ({ ...s, boardDate: '2026-09-25' })), BOARD), null, 'a later day is not a rolled-over route');
  // One stop delivered today is pinned to today; it says nothing about which load the rest are on.
  const oneDone = [...estesAppt, { stopNbr: 'D', routeName: 'ESTES APPT', boardDate: BOARD, normalizedStatus: 'DELIVERED' }];
  assert.equal(routeOwnDay(oneDone, BOARD), '2026-09-23');
  assert.equal(routeOwnDay(estesAppt.map((s) => ({ ...s, normalizedStatus: 'DELIVERED' })), BOARD), null, 'nothing open, nothing to plan');
});

test('absent and malformed inputs refuse rather than guess', () => {
  for (const bad of [null, undefined, [], [{}], [null]]) assert.equal(routeOwnDay(bad, BOARD), null);
  assert.equal(routeOwnDay(estesAppt, ''), null);
  assert.equal(routeOwnDay(estesAppt, 'tomorrow'), null);
  assert.equal(routeOwnDay(estesAppt.map((s) => ({ ...s, boardDate: '9/23' })), BOARD), null);
  assert.equal(ownDayIdentity(null, 'ESTES APPT'), null);
  assert.equal(ownDayIdentity(ROSTER_0923, ''), null);
});

test('VITE_WB_OWN_DAY_ROSTER: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(wbOwnDayRosterEnabled({}), true);
  assert.equal(wbOwnDayRosterEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(wbOwnDayRosterEnabled({ VITE_WB_OWN_DAY_ROSTER: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(wbOwnDayRosterEnabled({ VITE_WB_OWN_DAY_ROSTER: v }), true, v);
});

// ── the roster read it makes can never spend a NuVizz call ─────────────────────
// The in-memory Firestore has no vendor stub: any NuVizz fetch THROWS. So a 200 here is proof.
const rosterDoc = (date, loads) => ({
  tenant: 'davis', date, at: `${date}T23:00:00Z`, count: loads.length, loadsJson: JSON.stringify(loads), emptyStreak: 0, emptyAt: null,
  pullJson: JSON.stringify({ period: '0d', httpStatus: 200, cols: 21, rows: loads.length, kept: loads.length }),
});
async function read(seed, qs) {
  const { restore } = installFirestoreFake(seed);
  try {
    const mod = await import('../netlify/functions/nuvizz-loads-roster.mts');
    const res = await mod.default(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-loads-roster?${qs}`));
    return { status: res.status, body: await res.json() };
  } finally { restore?.(); }
}

test('cacheOnly=1 serves the stored roster of an earlier day', async () => {
  const { status, body } = await read({ 'nuvizz_load_roster/davis__2026-09-23': rosterDoc('2026-09-23', ROSTER_0923) }, 'date=2026-09-23&cacheOnly=1');
  assert.equal(status, 200);
  assert.equal(body.source, 'cache');
  assert.equal(body.loads.find((l) => l.name === 'ESTES APPT')?.loadNbr, 'DAVIS000204757');
});

test('cacheOnly=1 on a day nothing stored answers "none" and does NOT go to NuVizz', async () => {
  const { status, body } = await read({}, 'date=2026-09-01&cacheOnly=1');
  assert.equal(status, 200, 'a live pull would have thrown here');
  assert.equal(body.source, 'none');
  assert.deepEqual(body.loads, []);
});

test('cacheOnly wins over live=1 — it is the promise not to call', async () => {
  const { status, body } = await read({}, 'date=2026-09-01&cacheOnly=1&live=1');
  assert.equal(status, 200);
  assert.equal(body.source, 'none');
});

// ── the wiring: the Compare card uses it, and only the stored copy ──────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('opening a card fetches the earlier day\'s roster with cacheOnly=1, never a plain read', () => {
  const body = APP.slice(APP.indexOf('const fetchOwnDayRoster = useCallback'), APP.indexOf('const openRouteInWorkbench = useCallback'));
  assert.match(body, /nuvizz-loads-roster\?date=\$\{encodeURIComponent\(day\)\}&cacheOnly=1/);
});

test('the card refuses exactly as before unless the earlier day named the load', () => {
  const body = APP.slice(APP.indexOf('const buildWbCard = useCallback'), APP.indexOf('const ownDayRosterToFetch = useCallback'));
  assert.match(body, /if \(!loadId && !loadNbr && !ownDayLoad\) \{/);
  assert.match(body, /WB_OWN_DAY_ROSTER_ON && !rosterEntry0\?\.ambiguous/, 'switch off, or an ambiguous name today → old behaviour');
  assert.match(body, /has no NuVizz load number or id yet, so a Save would be refused\./, 'the original refusal is kept word for word');
  const open = APP.slice(APP.indexOf('const openRouteInWorkbench = useCallback'));
  assert.match(open.slice(0, 1500), /NuVizz still dates this load and its stops/, 'a card on yesterday\'s load says so');
});
