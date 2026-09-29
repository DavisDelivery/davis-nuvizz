// The words on a stop's preflight badge — preflightBadgeWords.
//
// Chad, 2026-09-28, once a can't-make row carried its hours on their own line (v1.85.1): "If
// there's not enough room on the can't make 12 p.m. line to put the amount of time it would be
// late, then I think I'd rather have the amount of time the system's going to think it's going to
// be late than the can't make it tag."
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightBadgeWords, compareUnreachableLateEnabled } from '../src/lib/route-preflight.js';

// GENESIS BIOSCIENCES on SUW, 2026-09-28: 8:00a–12:00p, judged from a 12:02p departure.
const GENESIS = { late: true, hopeless: true, lateBy: 124, closeMin: 720, tier: 'red' };

test('a can\'t-make row that shows its hours says HOW LATE, not "can\'t make 12:00p"', () => {
  assert.equal(preflightBadgeWords(GENESIS, { lateOverCantMake: true }), '2h 4m late');
});

test('a can\'t-make row with NO hours line keeps "can\'t make" — there the close would be printed nowhere', () => {
  assert.equal(preflightBadgeWords(GENESIS), 'can’t make 12:00p');
  assert.equal(preflightBadgeWords(GENESIS, { lateOverCantMake: false }), 'can’t make 12:00p');
});

test('no lateness on the verdict → "can\'t make", never "0m late" or "NaN late"', () => {
  assert.equal(preflightBadgeWords({ ...GENESIS, lateBy: null }, { lateOverCantMake: true }), 'can’t make 12:00p');
  assert.equal(preflightBadgeWords({ ...GENESIS, lateBy: 'x' }, { lateOverCantMake: true }), 'can’t make 12:00p');
});

test('a merely late stop is unchanged: "19m late", "2h 0m late"', () => {
  assert.equal(preflightBadgeWords({ late: true, hopeless: false, lateBy: 19, closeMin: 840 }), '19m late');
  assert.equal(preflightBadgeWords({ late: true, hopeless: false, lateBy: 120, closeMin: 840 }, { lateOverCantMake: true }), '2h 0m late');
});

test('a stop that makes its window has no badge', () => {
  assert.equal(preflightBadgeWords({ late: false }), null);
  assert.equal(preflightBadgeWords(null), null);
});

test('VITE_COMPARE_UNREACHABLE_LATE: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(compareUnreachableLateEnabled({}), true);
  for (const off of ['off', '0', 'false', 'no']) assert.equal(compareUnreachableLateEnabled({ VITE_COMPARE_UNREACHABLE_LATE: off }), false, off);
  assert.equal(compareUnreachableLateEnabled({ VITE_COMPARE_UNREACHABLE_LATE: 'of' }), true);
});
