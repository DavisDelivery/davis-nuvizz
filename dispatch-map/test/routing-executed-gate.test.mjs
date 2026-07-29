// test/routing-executed-gate.test.mjs — the engine replay's execution-evidence gate.
// Imports the SAME functions the netlify functions ship (no copies).
//
// Regression origin (Chad, Jul 29): "marcus and leroy have never taken 20 stops on one trip
// ever so why in the world would it put that many on them?" The engine's replay of 2026-07-28
// charged Leroy Smith with 19-21 stops / ~4,900 lb and Marcus Crumpton with 20 / 7,966 lb.
// NuVizz's own load records: DAWSONVILLE 14 stops / 2,799 lb, CRUMPTON 13 / 3,716 lb.
//
// The stored day, read back from production (zero NuVizz calls), decomposed EXACTLY:
//   DAWSONVILLE = 14 rows DELIVERED on 07-28 summing to 2,799 lb TO THE POUND
//               +  7 ESTES-* rows SCHEDULED, no delivery stamp, own routeSeq 1-6
//   CRUMPTON    = 13 rows DELIVERED summing to 3,716 lb TO THE POUND
//               +  7 ESTES-* rows SCHEDULED, no stamp
// Every phantom row was confirmed ON THE NEXT DAY'S BOARD, on the next day's same-named run
// (three already delivered 07-29 by mid-morning): the evening's pre-built NEXT-day routes,
// filed onto 07-28 because an Estes import carries no Estimated Arrival, then sealed into
// 07-28's history at capture. "Planned on D's board" is not "ran on D".
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executedOnDate, dropUnexecuted, extractReferenceRoutes,
} from '../netlify/functions/lib/routing-reference.mts';
import { extractDriverDays } from '../netlify/functions/lib/routing-driver-days.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const D = '2026-07-28';
const CFG = engineConfigDefaults({});

const stop = (over = {}) => ({
  stopNbr: over.stopNbr, pro: over.stopNbr, loadNbr: over.loadNbr,
  routeName: over.loadNbr, driverName: over.driverName, driverUserName: over.driverName,
  isPlanned: true, isUnplanned: false, isTerminal: false, isAttempt: false,
  lat: 34.1, lng: -84.0, routeSeq: 1, deliveredDTTM: null, weight: 0, ...over,
});

// The real DAWSONVILLE day, weights as stored: 14 delivered rows = 2,799 lb exactly.
const DAWSONVILLE_DELIVERED = [
  ['007153257', 201, '10:11'], ['007152893', 112, '11:10'], ['007152966', 130, '11:13'],
  ['007153036', 182, '11:35'], ['007153045', 284, '11:40'], ['007153082', 592, '12:01'],
  ['007153043', 195, '12:41'], ['007152965', 128, '13:07'], ['007152665', 95, '13:29'],
  ['007152804', 176, '14:44'], ['007153283', 207, '14:44'], ['007152647', 143, '14:55'],
  ['007152794', 297, '15:29'], ['AVRT-0058118367', 57, '15:30'],
].map(([nbr, w, t], i) => stop({ stopNbr: nbr, loadNbr: 'DAWSONVILLE', driverName: 'Leroy Smith', weight: w, routeSeq: i + 1, deliveredDTTM: `${D}T${t}:00`, lat: 34.1 + i * 0.01, lng: -84.0 + i * 0.01 }));
// The 7 phantoms: tomorrow's freight, SCHEDULED, no stamp, their own seq — 2,451 lb.
const DAWSONVILLE_PHANTOM = [
  ['ESTES-0298260132', 210, 1], ['ESTES-0452271507', 285, 2], ['ESTES-0452271509', 285, 2],
  ['ESTES-0473430465', 168, 4], ['ESTES-0748253915', 583, 4], ['ESTES-1381382724', 440, 5],
  ['ESTES-2958924386', 480, 6],
].map(([nbr, w, seq], i) => stop({ stopNbr: nbr, loadNbr: 'DAWSONVILLE', driverName: 'Leroy Smith', weight: w, routeSeq: seq, deliveredDTTM: null, lat: 34.3 + i * 0.01, lng: -83.8 + i * 0.01 }));

const CRUMPTON_DELIVERED = [
  ['007152695', 107], ['007152713', 158], ['007152878', 137], ['007153181', 350],
  ['007153165', 164], ['007153178', 32], ['007152622', 287], ['007153104', 482],
  ['007152816', 1058], ['007153162', 227], ['007152999', 439], ['007153203', 209], ['007153144', 66],
].map(([nbr, w], i) => stop({ stopNbr: nbr, loadNbr: 'CRUMPTON', driverName: 'Marcus Crumpton', weight: w, routeSeq: i + 1, deliveredDTTM: `${D}T${String(7 + i).padStart(2, '0')}:30:00`, lat: 34.5 + i * 0.01, lng: -84.2 + i * 0.01 }));
const CRUMPTON_PHANTOM = [
  ['ESTES-0408688754', 1073], ['ESTES-0538258981', 100], ['ESTES-1148293099', 491],
  ['ESTES-1171122060', 1550], ['ESTES-1568540623', 581], ['ESTES-2128312018', 230], ['ESTES-2958924692', 225],
].map(([nbr, w], i) => stop({ stopNbr: nbr, loadNbr: 'CRUMPTON', driverName: 'Marcus Crumpton', weight: w, routeSeq: i + 1, deliveredDTTM: null, lat: 34.6 + i * 0.01, lng: -84.3 + i * 0.01 }));

const THE_DAY = [...DAWSONVILLE_DELIVERED, ...DAWSONVILLE_PHANTOM, ...CRUMPTON_DELIVERED, ...CRUMPTON_PHANTOM];

// ── the primitive ───────────────────────────────────────────────────────────

test('executedOnDate: a same-day stamp is the only yes', () => {
  assert.equal(executedOnDate({ deliveredDTTM: '2026-07-28T10:11:00' }, D), true);
  assert.equal(executedOnDate({ deliveredDTTM: '2026-07-29T08:08:00' }, D), false, 'delivered the NEXT day counts on the next day');
  assert.equal(executedOnDate({ deliveredDTTM: null }, D), false);
  assert.equal(executedOnDate({ deliveredDTTM: '' }, D), false);
  assert.equal(executedOnDate({}, D), false);
  assert.equal(executedOnDate(null, D), false);
});

// ── the gate on the real day ────────────────────────────────────────────────

test('DAWSONVILLE: the gate keeps exactly the 14 rows NuVizz counted — 2,799 lb to the pound', () => {
  const { stops: kept, excluded, applied } = dropUnexecuted(THE_DAY, D);
  assert.equal(applied, true);
  assert.equal(excluded, 14, 'the 7+7 phantoms and nothing else');
  const dawson = kept.filter((s) => s.loadNbr === 'DAWSONVILLE');
  assert.equal(dawson.length, 14);
  assert.equal(dawson.reduce((a, s) => a + s.weight, 0), 2799);
  assert.ok(dawson.every((s) => !String(s.stopNbr).startsWith('ESTES-')), 'no next-day Estes freight survives');
});

test('CRUMPTON: 13 rows, 3,716 lb — the numbers Chad read off the portal', () => {
  const { stops: kept } = dropUnexecuted(THE_DAY, D);
  const crump = kept.filter((s) => s.loadNbr === 'CRUMPTON');
  assert.equal(crump.length, 13);
  assert.equal(crump.reduce((a, s) => a + s.weight, 0), 3716);
});

test('the phantoms COUNT on the day they actually ran', () => {
  // The same ESTES rows, replayed as part of 07-29 (stamped there): they are that day's work.
  const nextDay = DAWSONVILLE_PHANTOM.map((s) => ({ ...s, deliveredDTTM: '2026-07-29T09:00:00' }));
  const { stops: kept, applied } = dropUnexecuted(nextDay, '2026-07-29');
  assert.equal(applied, true);
  assert.equal(kept.length, 7, 'excluded from the day they were merely planned, counted on the day they were driven');
});

test('rows the replay never counted anyway pass through untouched', () => {
  const pool = [
    stop({ stopNbr: 'U1', loadNbr: null, routeName: null, driverName: null, isPlanned: false, isUnplanned: true }),
    stop({ stopNbr: 'A1', loadNbr: 'DAWSONVILLE', isAttempt: true }),
  ];
  const { stops: kept } = dropUnexecuted([...DAWSONVILLE_DELIVERED, ...pool], D);
  assert.ok(kept.some((s) => s.stopNbr === 'U1'), 'the unplanned pool is not the gate\'s business');
  assert.ok(kept.some((s) => s.stopNbr === 'A1'), 'attempts are already excluded downstream');
});

// ── the self-disabling guard ────────────────────────────────────────────────

test('a day without delivery stamps is replayed as stored — the gate refuses to erase real work', () => {
  // Legacy captures / a feed that dropped the delivered column: under half the eligible rows
  // stamped → nothing is dropped and the caller is told the gate did not apply.
  const unstamped = DAWSONVILLE_DELIVERED.map((s) => ({ ...s, deliveredDTTM: null }));
  const out = dropUnexecuted([...unstamped, ...DAWSONVILLE_PHANTOM], D);
  assert.equal(out.applied, false);
  assert.equal(out.excluded, 0);
  assert.equal(out.stops.length, 21);
  assert.deepEqual(dropUnexecuted([], D), { stops: [], excluded: 0, applied: false });
  assert.deepEqual(dropUnexecuted(null, D), { stops: [], excluded: 0, applied: false });
});

test('2026-07-28 itself clears the guard with room (715 of 831 stamped)', () => {
  // On the real day 28 of 41 eligible rows here are stamped (68%) — over the 50% bar.
  const { applied } = dropUnexecuted(THE_DAY, D);
  assert.equal(applied, true);
});

// ── through the real consumers ──────────────────────────────────────────────

test('driver-day envelopes: Leroy is 14 stops / 2,799 lb, Marcus 13 / 3,716 — not 21 / 5,250', () => {
  const days = extractDriverDays(THE_DAY, { tenant: 'davis', date: D });
  const leroy = days.find((d) => d.driver_key.includes('LEROY'));
  const marcus = days.find((d) => d.driver_key.includes('MARCUS'));
  assert.equal(leroy.day_totals.stops, 14);
  assert.equal(leroy.day_totals.weight, 2799);
  assert.equal(marcus.day_totals.stops, 13);
  assert.equal(marcus.day_totals.weight, 3716);
});

test('reference mining: the DAWSONVILLE shape is the 14-stop route that ran, seq intact', () => {
  const { routes, unexecuted_excluded } = extractReferenceRoutes(THE_DAY, { tenant: 'davis', date: D, cfg: CFG });
  const dawson = routes.find((r) => r.load_key === 'DAWSONVILLE');
  assert.equal(dawson.stop_count, 14, 'the phantoms\' own seq 1-6 no longer poisons the mined order');
  assert.equal(unexecuted_excluded, 14);
  const crump = routes.find((r) => r.load_key === 'CRUMPTON');
  assert.equal(crump.stop_count, 13);
});

test('a stampless legacy day still mines — the guard keeps old history usable', () => {
  const legacy = DAWSONVILLE_DELIVERED.map((s) => ({ ...s, deliveredDTTM: null }));
  const { routes, unexecuted_excluded } = extractReferenceRoutes(legacy, { tenant: 'davis', date: D, cfg: CFG });
  assert.equal(unexecuted_excluded, 0);
  assert.equal(routes.find((r) => r.load_key === 'DAWSONVILLE')?.stop_count, 14);
});
