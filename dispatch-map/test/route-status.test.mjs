// test/route-status.test.mjs — which roster row may speak for a route's STATUS.
//
// Chad, Jul 31, portal open beside the app: "why are we showing this load canceled its not
// canceled in nuvizz." STEVEN — 16 orders, a driver, 52 miles, plainly alive in NuVizz — wore
// a red CANCELLED badge on our board.
//
// Cause: the roster status map was keyed by NAME with last-write-wins, and the lookup asked
// the name BEFORE the load id — even for a route whose id came from its own stops. A second
// roster row named STEVEN (a cancelled instance) therefore decided the live route's badge.
//
// Then Chad: "shouldn't they have different load numbers so for this particular day we should
// display both … the active and canceled one." Right on both counts, and the second half is
// the real rule: a CANCELLED load holds no planned work, so when one of two same-named loads
// is cancelled there is no contest at all — the live one owns the name. Merely refusing to
// guess (the first cut) was correct but useless: it cost the badge AND the ability to save the
// card. A genuine contest — two LIVE loads sharing a name — still refuses.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRosterStatusMap, resolveRosterStatus, resolveNameOwner, isCancelledStatus,
  rosterIdKey, rosterAmbiguousKey,
} from '../src/lib/route-status.js';

// Chad's actual day: STEVEN was cancelled and rebuilt, so the roster carries both.
const STEVEN_DAY = [
  { loadId: 'hexOLD', name: 'STEVEN', loadNbr: 'DAVIS000200100', status: 'Cancelled' },
  { loadId: 'hexNEW', name: 'STEVEN', loadNbr: 'DAVIS000200400', status: 'Dispatched' },
  { loadId: 'hexSUW', name: 'SUW 2', loadNbr: 'DAVIS000200500', status: 'Planned' },
];
// A genuine contest: two loads named ZULU, both alive.
const CONTESTED = [
  { loadId: 'hexZ1', name: 'ZULU', loadNbr: 'DAVIS000300001', status: 'Planned' },
  { loadId: 'hexZ2', name: 'ZULU', loadNbr: 'DAVIS000300002', status: 'Dispatched' },
];

test("Chad's STEVEN: the live route keeps its own status even though a cancelled load shares the name", () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  // Identified by the id derived from its own stops — the route actually on screen.
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: 'hexNEW', loadNbr: 'STEVEN' }, map), 'Dispatched');
  // And the genuinely cancelled one still reads cancelled.
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: 'hexOLD' }, map), 'Cancelled');
});

test("…and it works with NO id at all — a cancelled load can't hold planned stops, so it can't own the name", () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  // This is the case that actually bit: board stops carried no load id, so identity couldn't
  // settle it. Refusing (null) was safe but left the route unusable; the live load owns it.
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: null, loadNbr: null }, map), 'Dispatched');
  assert.equal(map.get(rosterAmbiguousKey('STEVEN')), undefined, 'not a contest — one of them is cancelled');
});

test('two LIVE loads sharing a name still refuse — that is a real contest', () => {
  const map = buildRosterStatusMap(CONTESTED);
  assert.equal(map.get(rosterAmbiguousKey('ZULU')), true);
  assert.equal(resolveRosterStatus({ name: 'ZULU', loadId: null }, map), null, 'no guess; caller derives from stops');
  // Identity still settles it when the caller has one.
  assert.equal(resolveRosterStatus({ name: 'ZULU', loadId: 'hexZ2' }, map), 'Dispatched');
});

test('the result is ORDER-INDEPENDENT — the vendor listing rows differently must not change a badge', () => {
  const a = buildRosterStatusMap(STEVEN_DAY);
  const b = buildRosterStatusMap([...STEVEN_DAY].reverse());
  for (const map of [a, b]) {
    assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: null }, map), 'Dispatched');
    assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: 'hexOLD' }, map), 'Cancelled');
  }
  // The old code took the name key last-write-wins, which flipped with row order — the whole bug.
  assert.equal(a.get('steven'), b.get('steven'), 'the name key no longer depends on row order');
});

test('resolveNameOwner states the rule directly', () => {
  assert.equal(resolveNameOwner('STEVEN', STEVEN_DAY).load.loadId, 'hexNEW');
  assert.equal(resolveNameOwner('STEVEN', STEVEN_DAY).ambiguous, false);
  assert.equal(resolveNameOwner('SUW 2', STEVEN_DAY).load.loadId, 'hexSUW');
  assert.equal(resolveNameOwner('ZULU', CONTESTED).load, null);
  assert.equal(resolveNameOwner('ZULU', CONTESTED).ambiguous, true);
  // Every candidate cancelled → no live owner, and it is not a contest either.
  const allDead = [{ loadId: 'a', name: 'X', status: 'Cancelled' }, { loadId: 'b', name: 'X', status: 'Cancelled' }];
  assert.equal(resolveNameOwner('X', allDead).ambiguous, true, 'nothing live to pick — refuse rather than guess');
  assert.equal(resolveNameOwner('', STEVEN_DAY).ambiguous, false);
  assert.equal(resolveNameOwner('NOPE', STEVEN_DAY).load, null);
});

test('cancelled is matched however NuVizz spells it', () => {
  for (const s of ['Cancelled', 'CANCELED', 'cancel', 'Route Cancelled', 'CANCELLED_BY_USER']) {
    assert.equal(isCancelledStatus(s), true, s);
  }
  for (const s of ['Planned', 'Dispatched', 'Completed', '', null, undefined]) {
    assert.equal(isCancelledStatus(s), false, String(s));
  }
});

test('a real load NUMBER resolves too — it is as unambiguous as the id', () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: null, loadNbr: 'DAVIS000200400' }, map), 'Dispatched');
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: null, loadNbr: 'DAVIS000200100' }, map), 'Cancelled');
});

test('the same load listed twice is NOT a name collision', () => {
  const map = buildRosterStatusMap([
    { loadId: 'hexA', name: 'ALPHA', status: 'Planned' },
    { loadId: 'hexA', name: 'ALPHA', status: 'Planned' },
  ]);
  assert.equal(map.get(rosterAmbiguousKey('ALPHA')), undefined);
  assert.equal(resolveRosterStatus({ name: 'ALPHA', loadId: null }, map), 'Planned');
});

test('an id with no roster row falls through to the name rather than answering nothing', () => {
  const map = buildRosterStatusMap([{ loadId: 'hexZ', name: 'ZULU', status: 'In-Transit' }]);
  assert.equal(resolveRosterStatus({ name: 'ZULU', loadId: 'hexMISSING' }, map), 'In-Transit');
});

test('junk in, no crash out', () => {
  assert.equal(resolveRosterStatus({ name: 'X' }, null), null);
  assert.equal(resolveRosterStatus(null, buildRosterStatusMap([])), null);
  assert.equal(resolveRosterStatus({}, buildRosterStatusMap([])), null);
  const map = buildRosterStatusMap([null, undefined, {}, { name: '  ' }]);
  assert.equal(resolveRosterStatus({ name: '' }, map), null);
  assert.equal(rosterIdKey('abc'), '#id:abc');
});
