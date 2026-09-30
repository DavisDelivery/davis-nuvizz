// A COMPARE CARD FINDS ITS LOAD BY THE NUMBER ITS OWN STOPS CARRY (lib/wb-stop-load.js).
//
// Chad, 2026-09-30, STEVEN 1 in the Routes panel and the card refusing to open: "STEVEN1 HOW CAN IT
// NOT FIND THE LOAD I LITERALLY SHOWED IT TO YOU IN DISPATCH MAP."
//
// Read off the live records that morning, zero NuVizz calls: STEVEN 1 was built in the portal at
// 5:49 AM ET (the timestamp inside its load id 6abcdb2e…), its 17 orders reached the board on the
// 6:00 scan carrying load number DAVIS000205171, and the roster did not name it until the 6:30
// pull. The card asked the roster only. The order numbers below are illustrative; the load number,
// the route name and the count are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
import { wbStopLoadNbrEnabled, stopLoadNbrIdentity } from '../src/lib/wb-stop-load.js';

installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;
const { LEAN_STOP_FIELDS } = await import('../netlify/functions/lib/board-fields.mts');

const STEVEN_NBR = 'DAVIS000205171';
const steven = Array.from({ length: 17 }, (_, i) => ({
  stopNbr: `0071843${String(i).padStart(2, '0')}`, routeName: 'STEVEN 1', loadNbr: 'STEVEN 1',
  nuvizzLoadNbr: STEVEN_NBR, isPlanned: true, normalizedStatus: 'SCHEDULED',
}));

test('STEVEN 1: every order names DAVIS000205171, so that is the card\'s load', () => {
  assert.deepEqual(stopLoadNbrIdentity(steven), { loadNbr: STEVEN_NBR });
});

test('a row with no number does not vote — the write grace holds a moved order at null, never at the old load', () => {
  const some = steven.map((s, i) => (i % 3 ? s : { ...s, nuvizzLoadNbr: null }));
  assert.deepEqual(stopLoadNbrIdentity(some), { loadNbr: STEVEN_NBR });
  assert.equal(stopLoadNbrIdentity(steven.map((s) => ({ ...s, nuvizzLoadNbr: null }))), null, 'no number anywhere → no identity');
});

test('only a load-number-shaped value counts — never the route NAME that loadNbr holds', () => {
  for (const bad of ['STEVEN 1', 'SUW', '', '   ', '6abcdb2e673007239214be12', 'DAVIS', 'DAVIS0001']) {
    assert.equal(stopLoadNbrIdentity(steven.map((s) => ({ ...s, nuvizzLoadNbr: bad }))), null, JSON.stringify(bad));
  }
  assert.deepEqual(stopLoadNbrIdentity([{ nuvizzLoadNbr: `  ${STEVEN_NBR} ` }]), { loadNbr: STEVEN_NBR }, 'padding is trimmed');
});

test('two loads under one route name → a conflict naming both, never a pick', () => {
  // CLAUDE.md's own case: Friday's MARCUS and Monday's MARCUS read the same by name.
  const marcus = [
    { routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645' },
    { routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204535' },
    { routeName: 'MARCUS', nuvizzLoadNbr: 'DAVIS000204645' },
  ];
  assert.deepEqual(stopLoadNbrIdentity(marcus), { conflict: ['DAVIS000204535', 'DAVIS000204645'] });
});

test('a row our own Save just re-routed does not vote — it can still carry its OLD load\'s number', () => {
  // patchBoardPlan and applyPlanOverlay rewrite the route name and keep the rest of the row, so
  // until the next scan a moved order reads "STEVEN 1" with ENOCK's number on it.
  const movedIn = { stopNbr: 'MOVED', routeName: 'STEVEN 1', nuvizzLoadNbr: 'DAVIS000204733' };
  assert.deepEqual(stopLoadNbrIdentity([...steven, { ...movedIn, board_write_at: '2026-09-30T10:05:00Z' }]), { loadNbr: STEVEN_NBR });
  assert.deepEqual(stopLoadNbrIdentity([...steven, { ...movedIn, planOverlay: true }]), { loadNbr: STEVEN_NBR });
  // A route made only of just-moved rows has no trustworthy number at all: refuse, as before.
  assert.equal(stopLoadNbrIdentity([{ ...movedIn, board_write_at: '2026-09-30T10:05:00Z' }]), null);
  assert.equal(stopLoadNbrIdentity([{ ...movedIn, planOverlay: true }]), null);
});

test('absent and malformed inputs answer null rather than throw', () => {
  for (const bad of [null, undefined, [], [null], [{}], [undefined, { nuvizzLoadNbr: 7 }]]) assert.equal(stopLoadNbrIdentity(bad), null);
});

test('VITE_WB_STOP_LOADNBR: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(wbStopLoadNbrEnabled({}), true);
  assert.equal(wbStopLoadNbrEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(wbStopLoadNbrEnabled({ VITE_WB_STOP_LOADNBR: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(wbStopLoadNbrEnabled({ VITE_WB_STOP_LOADNBR: v }), true, v);
});

// ── the board feed serves the number (it did not: LEAN_STOP_FIELDS forgot it) ────────────────
test('the lean board projection carries nuvizzLoadNbr', () => {
  assert.ok(LEAN_STOP_FIELDS.includes('nuvizzLoadNbr'));
});

test('the Map feed asks Firestore for nuvizzLoadNbr and hands it to the screen — no vendor call', async () => {
  const D = '2026-09-30';
  const seed = {
    [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D, last_scanned_at: `${D}T10:15:23.000Z`, count: 1 },
    [`nuvizz_stop_index/davis__${D}/stops/${steven[0].stopNbr}`]: { ...steven[0], boardDate: D, scheduledDate: D, status: '20', lat: 34.1, lng: -84.0 },
  };
  const fake = installFirestoreFake(seed);   // no onOther → any non-Firestore fetch THROWS
  try {
    const pull = (await import('../netlify/functions/nuvizz-pull-today-stops.mts')).default;
    const res = await pull(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=${D}`));
    const j = await res.json();
    assert.equal(j.ok, true);
    const lists = fake.log.listMasks.filter((l) => new RegExp(`davis__${D}/stops$`).test(l.path));
    assert.ok(lists.length >= 1, 'the day\'s stops were listed');
    for (const l of lists) assert.ok(l.mask.includes('nuvizzLoadNbr'), `${l.path} asks for nuvizzLoadNbr`);
    assert.equal((j.stops || []).find((s) => s.stopNbr === steven[0].stopNbr)?.nuvizzLoadNbr, STEVEN_NBR);
    assert.equal(fake.log.other.length, 0, 'Firestore only');
  } finally { fake.restore(); }
});

// ── the wiring: last resort, after every source that already opens a card ───────────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const BUILD = APP.slice(APP.indexOf('const buildWbCard = useCallback'), APP.indexOf('const ownDayRosterToFetch = useCallback'));

test('buildWbCard asks the stops only after the roster, a stop load id and the own-day look-back all failed', () => {
  const ownDay = BUILD.indexOf('ownDayLoad = held ? ownDayIdentity(');
  const ask = BUILD.indexOf('stopLoad = stopLoadNbrIdentity(routeStops)');
  assert.ok(ownDay > 0 && ask > ownDay, 'the stops are asked after the own-day look-back');
  assert.match(BUILD, /if \(!loadId && !loadNbr && !ownDayLoad && WB_STOP_LOADNBR_ON\) \{/, 'gated on every earlier source failing, and on the switch');
});

test('two numbers refuse and name them; none keeps the old refusal word for word', () => {
  assert.match(BUILD, /if \(stopLoad\?\.conflict\) \{/);
  assert.match(BUILD, /different NuVizz loads \(\$\{stopLoad\.conflict\.join\(', '\)\}\)/);
  assert.match(BUILD, /if \(!loadId && !loadNbr && !ownDayLoad && !stopLoad\) \{/);
  assert.match(BUILD, /has no NuVizz load number or id yet, so a Save would be refused\./);
});

test('the card carries the stops\' number only when nothing earlier named the load', () => {
  assert.match(BUILD, /loadNbr: loadNbr \|\| ownDayLoad\?\.loadNbr \|\| stopLoad\?\.loadNbr \|\| null/);
  assert.match(APP, /const WB_STOP_LOADNBR_ON = wbStopLoadNbrEnabled\(import\.meta\.env\);/);
});
