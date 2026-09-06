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

import { shellLookbackDates, standardShellNames, shouldOfferShells, SHELL_LOOKBACK_DAYS } from '../netlify/functions/lib/roster-shells.mts';

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

test("CHAD'S SUNDAY: Tue Sep 8 viewed from Sun Sep 6, NuVizz answered zero rows → offer every standard shell", () => {
  const v = shouldOfferShells('2026-09-08', '2026-09-06', [], STD);
  assert.equal(v.offer, true);
  assert.deepEqual(v.missing, STD);
});

test('an hour later: he saved SUW 2 and the scan captured it — the other three are still offered', () => {
  const v = shouldOfferShells('2026-09-08', '2026-09-06', L('SUW 2'), STD);
  assert.equal(v.offer, true);
  assert.deepEqual(v.missing, ['ATL', 'DIXON', 'SUW 3']);
});

test('an ORDINARY morning: NuVizz generated the day and one route is cancelled — nothing is offered (that would be noise)', () => {
  const v = shouldOfferShells('2026-09-09', '2026-09-09', L('ATL', 'DIXON', 'SUW 2'), STD);
  assert.equal(v.offer, false, 'one missing of four is a normal day, not an uncreated one');
  assert.deepEqual(v.missing, ['SUW 3']);
});

test('the line is MORE THAN HALF missing: exactly half is still an ordinary day', () => {
  assert.equal(shouldOfferShells('2026-09-09', '2026-09-09', L('ATL', 'DIXON'), STD).offer, false);
  assert.equal(shouldOfferShells('2026-09-09', '2026-09-09', L('ATL'), STD).offer, true);
});

test('TODAY counts — a 4am board before the shells are generated may offer them', () => {
  assert.equal(shouldOfferShells('2026-09-09', '2026-09-09', [], STD).offer, true);
});

test('a PAST day is never offered shells — nothing gets built onto yesterday', () => {
  assert.equal(shouldOfferShells('2026-09-04', '2026-09-06', [], STD).offer, false);
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
