// test/driver-aliases.test.mjs — ONE MAN, ONE KEY, FROM THE ROSTER RATHER THAN A HARDCODED PAIR.
//
// Chad, asked whether two spellings were the same person: "Yes same man."
//
// NuVizz renamed Brenton Byrd from "Brent  Boyd" to "Brent  Bryd" on 2026-08-27. Anything keyed
// on the name sees two people from that day: on the driver-area sheet that is one man showing
// half a territory twice, AND the retired spelling reads as somebody who stopped running, so he
// is also dropped for inactivity. One typo, two wrong answers, and a trainee cannot see either.
//
// The fix reads his employees card, where a person already recorded it — alias "Brent Bryd"
// with "Brent Boyd" kept in aliases[]. So the NEXT rename is fixed by editing the card, the way
// the last one was, rather than by a deploy or by somebody remembering to tell me.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDriverAliases } from '../netlify/functions/lib/marginiq.mts';
import { applyAliases, driverKeyOf, driverCore, activeDrivers, possibleSameDriver } from '../src/lib/driver-territory.js';

const BRENT = {
  fullName: 'Brenton Byrd', firstName: 'Brenton', lastName: 'Byrd',
  externalIds: { nuvizz: 'Brent  Bryd' }, aliases: ['Brent Boyd', 'Brent  Bryd'],
};

test('THE RENAME COMES OFF HIS CARD — no hardcoded pair anywhere', () => {
  const pairs = buildDriverAliases([BRENT]);
  assert.ok(pairs.some((p) => p.from === 'BRENT_BOYD' && p.to === 'BRENT_BRYD'),
    `the Boyd→Bryd fold is missing: ${JSON.stringify(pairs)}`);
});

test('the canonical name is the one the BOARD shows, not the payroll one', () => {
  // externalIds.nuvizz is the spelling the dispatch board displays. A trainee has to learn the
  // name they will actually see on a load, so the sheet must agree with the screen.
  const pairs = buildDriverAliases([BRENT]);
  assert.ok(pairs.every((p) => p.to === 'BRENT_BRYD'));
  assert.ok(pairs.some((p) => p.from === 'BRENTON_BYRD'), 'even his real name folds to the board name');
});

test('a name is never an alias of itself, and blanks are not aliases at all', () => {
  const pairs = buildDriverAliases([{ fullName: 'Vincent', externalIds: { nuvizz: 'Vincent' }, aliases: ['Vincent', '', null] }]);
  assert.deepEqual(pairs, [], 'an employee with no OTHER spellings contributes nothing');
});

test('an employee with no usable name contributes nothing rather than a null key', () => {
  assert.deepEqual(buildDriverAliases([{ aliases: ['X'] }, {}, null]), []);
});

test('ONE TERRITORY, NOT TWO HALVES — the whole point, end to end', () => {
  const S = (u, d) => ({ zip: '30043', city: 'Lawrenceville', driverUserName: u, driverName: u, boardDate: d });
  const stops = [
    // 2026-08-14, not the 08-20 this test first used: that is exactly 14 days before the window
    // end, and the staleness rule is `gap > staleDays`, so it sits precisely ON the boundary and
    // he is NOT dropped. The test was wrong, not the code — an off-by-one in the fixture would
    // have "proved" a bug that does not exist.
    ...Array(22).fill(0).map(() => S('Brent  Boyd', '2026-08-14')),   // before the rename
    ...Array(18).fill(0).map(() => S('Brent  Bryd', '2026-09-03')),   // after it
  ];
  // Before folding: two drivers, and the older spelling looks lapsed.
  const before = driverCore(stops);
  assert.equal(before.length, 2, 'the premise — unfolded, he is two people');
  const staleBefore = activeDrivers(stops, { minStops: 5, staleDays: 14 }).excluded;
  assert.ok(staleBefore.some((e) => e.key === 'BRENT_BOYD' && e.why === 'stopped running'),
    'and half of him is dropped as a driver who quit');

  // After: one man, all forty stops, still running.
  const folded = applyAliases(stops, buildDriverAliases([BRENT]));
  const after = driverCore(folded);
  assert.equal(after.length, 1, `still split: ${after.map((d) => d.key).join(', ')}`);
  assert.equal(after[0].key, 'BRENT_BRYD');
  assert.equal(after[0].total, 40, 'both spellings counted');
  assert.deepEqual(activeDrivers(folded, { minStops: 5, staleDays: 14 }).excluded, [],
    'and he is no longer mistaken for somebody who stopped');
});

test('…and the sheet stops ASKING once they are folded', () => {
  // possibleSameDriver flags the pair before folding; after, there is nothing left to ask about,
  // so the "Same person?" banner disappears on its own rather than nagging forever.
  const S = (u) => ({ zip: '30043', city: 'L', driverUserName: u, driverName: u, boardDate: '2026-09-03' });
  const stops = [...Array(12).fill(0).map(() => S('Brent  Boyd')), ...Array(12).fill(0).map(() => S('Brent  Bryd'))];
  assert.equal(possibleSameDriver(stops).length, 1, 'asked before');
  assert.equal(possibleSameDriver(applyAliases(stops, buildDriverAliases([BRENT]))).length, 0, 'silent after');
});

test('folding rewrites BOTH name fields, so whichever one is read lands on the same man', () => {
  const folded = applyAliases([{ driverUserName: 'Brent  Boyd', driverName: 'Brent  Boyd', zip: '30043' }],
    buildDriverAliases([BRENT]));
  assert.equal(driverKeyOf(folded[0]), 'BRENT_BRYD');
  assert.equal(folded[0].driverName, 'BRENT_BRYD');
  assert.equal(folded[0].driverUserName, 'BRENT_BRYD');
});

test('no aliases means the stops come back untouched, not copied or reshaped', () => {
  const stops = [{ driverUserName: 'VINCENT', zip: '30518' }];
  assert.equal(applyAliases(stops, []), stops, 'same array reference — nothing to do, nothing done');
  assert.equal(applyAliases(stops, null), stops);
});
