// test/route-status.test.mjs — which roster row may speak for a route's STATUS.
//
// Chad, Jul 31, portal open beside the app: "why are we showing this load canceled its not
// canceled in nuvizz." STEVEN — 16 orders, a driver, 52 miles, plainly alive in NuVizz — wore
// a red CANCELLED badge on our board.
//
// Cause: the roster status map was keyed by NAME with last-write-wins, and the lookup asked
// the name BEFORE the load id — even for a route whose id came from its own stops. A second
// roster row named STEVEN (a cancelled instance) therefore decided the live route's badge.
// The identity index built on the very next line already refused ambiguous names; the status
// path was the one consumer that never did.
//
// Newly easy to hit: cancel a route and rebuild it under the same name — exactly what
// v0.54.19–v0.54.22 made possible — and the day carries two STEVENs, one Cancelled.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRosterStatusMap, resolveRosterStatus, rosterIdKey, rosterAmbiguousKey } from '../src/lib/route-status.js';

// The day Chad hit: STEVEN was cancelled and rebuilt, so the roster carries both.
const STEVEN_DAY = [
  { loadId: 'hexOLD', name: 'STEVEN', loadNbr: 'DAVIS000200100', status: 'Cancelled' },
  { loadId: 'hexNEW', name: 'STEVEN', loadNbr: 'DAVIS000200400', status: 'Dispatched' },
  { loadId: 'hexSUW', name: 'SUW 2', loadNbr: 'DAVIS000200500', status: 'Planned' },
];

test("Chad's STEVEN: the LIVE route keeps its own status even though a cancelled load shares the name", () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  // The board group carries the id derived from its OWN stops — that is the route on screen.
  const live = resolveRosterStatus({ name: 'STEVEN', loadId: 'hexNEW', loadNbr: 'STEVEN' }, map);
  assert.equal(live, 'Dispatched', 'identity wins — never the other STEVEN\'s Cancelled');
  // And the genuinely cancelled one still reads cancelled.
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: 'hexOLD' }, map), 'Cancelled');
});

test('an ambiguous name may NOT decide a status when the route has no id — null, so the caller derives from the stops', () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  // No id to identify it: guessing between two STEVENs is exactly how a live route got a red
  // CANCELLED badge. Answer nothing and let the execution-derived status stand.
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: null, loadNbr: null }, map), null);
  // An unambiguous name is still perfectly usable.
  assert.equal(resolveRosterStatus({ name: 'SUW 2', loadId: null, loadNbr: null }, map), 'Planned');
});

test('the old NAME-FIRST behaviour is what produced the wrong badge — pinned so it cannot come back', () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  // What the buggy lookup did: name first, last-write-wins.
  const nameFirst = map.get('steven');
  assert.equal(nameFirst, 'Dispatched', 'the raw name key is still last-write-wins…');
  // …which is precisely why the resolver must not consult it while the name is ambiguous.
  assert.equal(map.get(rosterAmbiguousKey('STEVEN')), true, 'the collision is recorded');
  // With the roster in the other order, the name key would have said Cancelled — order of the
  // vendor's rows must never change what the board shows.
  const flipped = buildRosterStatusMap([...STEVEN_DAY].reverse());
  assert.equal(flipped.get('steven'), 'Cancelled', 'name key flips with row order — untrustworthy');
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: 'hexNEW' }, flipped), 'Dispatched',
    'the resolver is order-independent because it uses identity');
});

test('a real load NUMBER resolves too — it is as unambiguous as the id', () => {
  const map = buildRosterStatusMap(STEVEN_DAY);
  assert.equal(resolveRosterStatus({ name: 'STEVEN', loadId: null, loadNbr: 'DAVIS000200400' }, map), 'Dispatched');
});

test('the same load listed twice is NOT a name collision', () => {
  const map = buildRosterStatusMap([
    { loadId: 'hexA', name: 'ALPHA', status: 'Planned' },
    { loadId: 'hexA', name: 'ALPHA', status: 'Planned' },
  ]);
  assert.equal(map.get(rosterAmbiguousKey('ALPHA')), undefined, 'one load, listed twice — no ambiguity');
  assert.equal(resolveRosterStatus({ name: 'ALPHA', loadId: null }, map), 'Planned');
});

test('an id with no roster row falls through to an unambiguous name rather than answering nothing', () => {
  const map = buildRosterStatusMap([{ loadId: 'hexZ', name: 'ZULU', status: 'In-Transit' }]);
  assert.equal(resolveRosterStatus({ name: 'ZULU', loadId: 'hexMISSING' }, map), 'In-Transit');
});

test('an EMPTY roster status is a real answer, not a miss — it must not fall through to the name', () => {
  // A load whose status column is blank is identified; answering '' lets the caller derive
  // from execution. Falling through to a same-named load's status would reintroduce the bug.
  const map = buildRosterStatusMap([
    { loadId: 'hexA', name: 'ECHO', status: '' },
    { loadId: 'hexB', name: 'ECHO', status: 'Cancelled' },
  ]);
  assert.equal(resolveRosterStatus({ name: 'ECHO', loadId: 'hexA' }, map), '', 'its own blank status');
  assert.equal(map.get(rosterAmbiguousKey('ECHO')), true);
});

test('junk in, no crash out', () => {
  assert.equal(resolveRosterStatus({ name: 'X' }, null), null);
  assert.equal(resolveRosterStatus(null, buildRosterStatusMap([])), null);
  assert.equal(resolveRosterStatus({}, buildRosterStatusMap([])), null);
  const map = buildRosterStatusMap([null, undefined, {}, { name: '  ' }]);
  assert.equal(resolveRosterStatus({ name: '' }, map), null);
  assert.equal(rosterIdKey('abc'), '#id:abc');
});
