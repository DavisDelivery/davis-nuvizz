// test/roster-shells.test.mjs — THE STANDARD SHELLS FOR A DAY NUVIZZ HAS NOT CREATED YET.
//
// Chad, Sunday Sep 6 2026, the board on Tue Sep 8: "I want to build loads on the weekend for
// next week and if I put the map on the date I want to build on and do a manual scan the loads
// should show up even if on the weekend." The one call he approved said why they did not: NuVizz
// held ZERO loads for Tuesday (21 column defs, 0 rows). A scan cannot show a load the vendor has
// not created — so the app offers the standard route names from the last captured delivery
// days, and Save creates the one he builds onto (Chad's own Aug 3 New-route design).
//
// Every rule that decides WHICH names and WHEN is here, on data, with the real-world day named.
import test from 'node:test';
import assert from 'node:assert/strict';

import { shellLookbackDates, standardShellNames, shouldOfferShells, looksGenerated, pickShellSources, closedDayReason, SHELL_LOOKBACK_DAYS } from '../netlify/functions/lib/roster-shells.mts';

const L = (...names) => names.map((name, i) => ({ loadId: `id${i}`, name, loadNbr: `DAVIS0002000${i}`, status: 'Draft', trips: 0 }));

test('the look-back from Tue Sep 8 skips the weekend and stays in the past: Mon 7, Fri 4, Thu 3, Wed 2 …', () => {
  const d = shellLookbackDates('2026-09-08');
  assert.deepEqual(d.slice(0, 5), ['2026-09-07', '2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01']);
  assert.ok(!d.includes('2026-09-06') && !d.includes('2026-09-05'), 'Saturday and Sunday are never asked — nothing was captured');
  assert.ok(!d.includes('2026-09-08'), 'the viewed day itself is not a source for its own shells');
  assert.equal(d.length, 10, `${SHELL_LOOKBACK_DAYS} calendar days back hold 10 weekdays`);
});

test('a garbled date looks back at nothing', () => {
  assert.deepEqual(shellLookbackDates('not a date'), []);
  assert.deepEqual(shellLookbackDates(''), []);
  assert.deepEqual(shellLookbackDates(undefined), []);
});

test('a name on two of the last three days is a standard shell; a one-day name is a one-off and is left out', () => {
  const names = standardShellNames([
    { date: '2026-09-04', loads: L('SUW 2', 'ATL', 'DIXON', 'BRETT SPRADLEY') },  // Friday: Brett ran his own trailer
    { date: '2026-09-03', loads: L('SUW 2', 'ATL', 'DIXON') },
    { date: '2026-09-02', loads: L('SUW 2', 'ATL', 'TRAILER 3') },
  ]);
  assert.deepEqual(names, ['ATL', 'DIXON', 'SUW 2']);
});

test('built loads count as much as empties — DIXON carried 11 stops on Sep 2 and is still a recurring route', () => {
  const built = { loadId: 'x', name: 'DIXON', loadNbr: 'DAVIS000203100', status: 'In-Progress', trips: 11 };
  const names = standardShellNames([
    { date: '2026-09-04', loads: [built, ...L('SUW 2')] },
    { date: '2026-09-03', loads: [built, ...L('SUW 2')] },
  ]);
  assert.deepEqual(names, ['DIXON', 'SUW 2']);
});

test('with ONE captured day every name on it counts — one day is all the evidence there is', () => {
  assert.deepEqual(standardShellNames([{ date: '2026-09-04', loads: L('SUW 2', 'ATL') }]), ['ATL', 'SUW 2']);
});

test('names match case-insensitively and trimmed; the first spelling seen is the one offered', () => {
  const names = standardShellNames([
    { date: '2026-09-04', loads: L('Suw 2 ', 'ATL') },
    { date: '2026-09-03', loads: L('SUW 2', 'atl') },
  ]);
  assert.deepEqual(names, ['ATL', 'Suw 2']);
});

test('a day that lists the same name twice (a cancelled and a rebuilt STEVEN) counts it once for that day', () => {
  const names = standardShellNames([
    { date: '2026-09-04', loads: L('STEVEN', 'STEVEN') },
    { date: '2026-09-03', loads: L('ATL') },
    { date: '2026-09-02', loads: L('ATL') },
  ]);
  assert.deepEqual(names, ['ATL'], 'two STEVENs on one day are not two days of STEVEN');
});

test('the order is numeric-aware — SUW 2 before SUW 10', () => {
  const names = standardShellNames([{ date: '2026-09-04', loads: L('SUW 10', 'SUW 2', 'SUW 1') }]);
  assert.deepEqual(names, ['SUW 1', 'SUW 2', 'SUW 10']);
});

test('nothing captured → nothing standard; garbage sources are ignored', () => {
  assert.deepEqual(standardShellNames([]), []);
  assert.deepEqual(standardShellNames([null, { date: 'x' }, { date: 'y', loads: 'nope' }]), []);
  assert.deepEqual(standardShellNames([{ date: '2026-09-04', loads: [{ name: '' }, { name: null }, {}] }]), []);
});

const STD = ['ATL', 'DIXON', 'SUW 2', 'SUW 3'];
const BUILT = (...names) => names.map((name, i) => ({ loadId: `b${i}`, name, loadNbr: `${name.replace(/\W+/g, '')}-0908`, status: 'Draft', trips: 5 + i }));
// A GENERATED day: Draft shells at zero trips, some of them filled.
const GENERATED = (...names) => names.map((name, i) => ({ loadId: `g${i}`, name, loadNbr: `DAVIS0002033${i}`, status: i % 2 ? 'In-Progress' : 'Draft', trips: i % 2 ? 9 : 0 }));

test("CHAD'S SUNDAY: Tue Sep 8 viewed from Sun Sep 6, NuVizz answered zero rows → offer every standard shell", () => {
  const v = shouldOfferShells('2026-09-08', '2026-09-06', [], STD);
  assert.equal(v.offer, true);
  assert.deepEqual(v.missing, STD);
});

test('an hour later: he saved SUW 2 and the scan captured it — the other three are still offered', () => {
  const v = shouldOfferShells('2026-09-08', '2026-09-06', BUILT('SUW 2'), STD);
  assert.equal(v.offer, true);
  assert.deepEqual(v.missing, ['ATL', 'DIXON', 'SUW 3']);
});

test('SUNDAY EVENING, 51 OF 100 BUILT AND CAPTURED — the other 49 are still offered (the review found the first rule hid them)', () => {
  const std = Array.from({ length: 100 }, (_, i) => `ROUTE ${i + 1}`);
  const built = BUILT(...std.slice(0, 51));
  const v = shouldOfferShells('2026-09-08', '2026-09-06', built, std);
  assert.equal(v.offer, true, 'a day with no empty load is a day nobody generated, however many routes he has built');
  assert.equal(v.missing.length, 49);
});

test('an ORDINARY morning: NuVizz generated the day and one route is cancelled — nothing is offered (that would be noise)', () => {
  const day = GENERATED('ATL', 'DIXON', 'SUW 2');          // Draft shells present ⇒ generated
  const v = shouldOfferShells('2026-09-09', '2026-09-09', day, STD);
  assert.equal(v.offer, false, 'one missing of four on a generated day is a normal day, not an uncreated one');
  assert.deepEqual(v.missing, ['SUW 3']);
});

test('a generated day whose capture caught generation half-way (more than half missing) is still offered', () => {
  const v = shouldOfferShells('2026-09-09', '2026-09-09', GENERATED('ATL'), STD);
  assert.equal(v.offer, true);
});

test('a generated day missing exactly half is an ordinary day', () => {
  assert.equal(shouldOfferShells('2026-09-09', '2026-09-09', GENERATED('ATL', 'DIXON'), STD).offer, false);
});

test('nothing missing → nothing offered, whatever the shape', () => {
  assert.equal(shouldOfferShells('2026-09-08', '2026-09-06', BUILT(...STD), STD).offer, false);
});

test('TODAY counts — a 4am weekday board before the shells are generated may offer them', () => {
  assert.equal(shouldOfferShells('2026-09-09', '2026-09-09', [], STD).offer, true);
});

test('a PAST day is never offered shells — nothing gets built onto yesterday', () => {
  assert.equal(shouldOfferShells('2026-09-04', '2026-09-06', [], STD).offer, false);
});

test('a CLOSED day is never offered shells: Sat Sep 12, Sun Sep 13, and Labor Day Mon Sep 7 2026', () => {
  assert.equal(closedDayReason('2026-09-12'), 'Saturday');
  assert.equal(closedDayReason('2026-09-13'), 'Sunday');
  assert.equal(closedDayReason('2026-09-07'), 'Labor Day');
  assert.equal(closedDayReason('2026-09-08'), null);
  assert.equal(closedDayReason('garbage'), null);
  for (const d of ['2026-09-12', '2026-09-13', '2026-09-07']) {
    const v = shouldOfferShells(d, '2026-09-06', [], STD);
    assert.equal(v.offer, false, `${d} is ${v.closed}`);
    assert.ok(v.closed, 'and it says why');
  }
  assert.equal(shouldOfferShells('2026-09-08', '2026-09-06', [], STD).closed, null);
});

test('the closed reason can be injected for a pure test, and an open day passes it through as null', () => {
  assert.equal(shouldOfferShells('2026-09-08', '2026-09-06', [], STD, 'Davis closed').offer, false);
  assert.equal(shouldOfferShells('2026-09-08', '2026-09-06', [], STD, null).offer, true);
});

test('no standard names → nothing to offer, whatever the day', () => {
  assert.equal(shouldOfferShells('2026-09-08', '2026-09-06', [], []).offer, false);
  assert.equal(shouldOfferShells('2026-09-08', '2026-09-06', [], null).offer, false);
});

test('roster rows without names do not count as holding anything', () => {
  const v = shouldOfferShells('2026-09-08', '2026-09-06', [{ loadId: 'x' }, { name: '' }], STD);
  assert.equal(v.offer, true);
  assert.deepEqual(v.missing, STD);
});

test('looksGenerated: a Draft shell at zero trips is the signature of a generated day; routes with stops are not', () => {
  assert.equal(looksGenerated(GENERATED('ATL', 'DIXON')), true);
  assert.equal(looksGenerated(BUILT('ATL', 'DIXON')), false);
  assert.equal(looksGenerated([]), false);
  assert.equal(looksGenerated(null), false);
  assert.equal(looksGenerated([{ name: '', trips: 0 }, { trips: 0 }]), false, 'a nameless zero is not a shell');
  assert.equal(looksGenerated([{ name: 'ATL', trips: 'garbage' }]), true, 'an unreadable trip count reads as zero — a shell, never a built route');
});

test('A HALF-BUILT MONDAY MUST NOT SHRINK TUESDAY\'S LIST: only generated-looking days are sources', () => {
  const candidates = [
    { date: '2026-09-09', loads: BUILT('SUW 2', 'ATL') },                       // Chad built two by hand
    { date: '2026-09-08', loads: BUILT(...Array.from({ length: 60 }, (_, i) => `R${i}`)) },  // and sixty
    { date: '2026-09-07', loads: [] },                                           // Labor Day, nothing
    { date: '2026-09-04', loads: GENERATED('SUW 2', 'ATL', 'DIXON', 'SUW 3') },
    { date: '2026-09-03', loads: GENERATED('SUW 2', 'ATL', 'DIXON', 'SUW 3') },
    { date: '2026-09-02', loads: GENERATED('SUW 2', 'ATL', 'DIXON') },
    { date: '2026-09-01', loads: GENERATED('SUW 2') },
  ];
  const picked = pickShellSources(candidates);
  assert.deepEqual(picked.map((c) => c.date), ['2026-09-04', '2026-09-03', '2026-09-02']);
  assert.deepEqual(standardShellNames(picked), ['ATL', 'DIXON', 'SUW 2', 'SUW 3']);
});

test('pickShellSources tolerates garbage and honours the cap', () => {
  assert.deepEqual(pickShellSources([null, { date: 'x' }, { date: 'y', loads: 'nope' }]), []);
  const many = Array.from({ length: 6 }, (_, i) => ({ date: `2026-08-2${i}`, loads: GENERATED('ATL') }));
  assert.equal(pickShellSources(many, 2).length, 2);
});
