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
  buildRosterStatusMap, buildRosterDriverMap, resolveRosterStatus, resolveRosterDriver, resolveNameOwner, isCancelledStatus, rosterDriverOf,
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

// ── THE ROSTER'S DRIVER, WHEN THE STOPS NAME NOBODY ────────────────────────────────────────
//
// Chad: "Our roster scan shows who the driver is for the load, why are we not using that?" The
// Routes cards are built from STOPS, so a load whose stops carry no driver yet derived
// "Unassigned" — beside a Loads row, on the same screen, naming the man on it. The roster map
// answers it, and it is keyed exactly like the status map so the ambiguity guard is the same
// one: putting the wrong driver on a route is a call to somebody forty miles away.
test('the roster names the driver for a load whose stops have not caught up', () => {
  const m = buildRosterDriverMap([
    { loadId: 'hexS', name: 'SHEATS', loadNbr: 'DAVIS000203725', driver: 'Sirdedrick Sheats', trips: 15, status: 'Draft' },
    { loadId: 'hexE', name: 'ESTES', loadNbr: 'DAVIS000203722', driver: '', trips: 8, status: 'Draft' },
  ]);
  assert.equal(resolveRosterDriver({ name: 'SHEATS', loadId: 'hexS' }, m), 'Sirdedrick Sheats');
  assert.equal(resolveRosterDriver({ name: 'SHEATS' }, m), 'Sirdedrick Sheats', 'by name when the name is unique');
  assert.equal(resolveRosterDriver({ loadNbr: 'DAVIS000203725' }, m), 'Sirdedrick Sheats', 'by real load number');
  assert.equal(resolveRosterDriver({ name: 'ESTES', loadId: 'hexE' }, m), '', 'genuinely unassigned stays unassigned');
});

test('two live loads sharing a name: NEITHER driver is handed to a card', () => {
  // Chad's two STEVENs. Guessing here puts a driver on a route he is not running.
  const m = buildRosterDriverMap([
    { loadId: 'hexA', name: 'STEVEN', loadNbr: 'DAVIS000200100', driver: 'Steven Adjetey', trips: 12, status: 'Dispatched' },
    { loadId: 'hexB', name: 'STEVEN', loadNbr: 'DAVIS000200400', driver: 'Somebody Else', trips: 9, status: 'Dispatched' },
  ]);
  assert.equal(resolveRosterDriver({ name: 'STEVEN' }, m), '', 'a contested name may not speak');
  // Identity still settles it — that is the whole reason the id keys exist.
  assert.equal(resolveRosterDriver({ name: 'STEVEN', loadId: 'hexB' }, m), 'Somebody Else');
});

test('a CANCELLED twin never lends its driver to the live load holding the name', () => {
  const m = buildRosterDriverMap([
    { loadId: 'hexOLD', name: 'STEVEN', loadNbr: 'DAVIS000200100', driver: 'Old Hand', trips: 5, status: 'Cancelled' },
    { loadId: 'hexNEW', name: 'STEVEN', loadNbr: 'DAVIS000200400', driver: 'Steven Adjetey', trips: 16, status: 'Dispatched' },
  ]);
  assert.equal(resolveRosterDriver({ name: 'STEVEN' }, m), 'Steven Adjetey');
});

test('a roster with no drivers at all resolves to empty, never undefined or "undefined"', () => {
  // Every cached document from before the driver was captured looks like this.
  const m = buildRosterDriverMap([{ loadId: 'hexA', name: 'BEN 2', loadNbr: 'DAVIS000198197', status: 'Draft' }]);
  assert.equal(resolveRosterDriver({ name: 'BEN 2', loadId: 'hexA' }, m), '');
  assert.equal(resolveRosterDriver({ name: 'NOT ON THE DAY' }, m), '');
  assert.equal(resolveRosterDriver({ name: 'BEN 2' }, null), '', 'no map at all is not a crash');
});

test('the driver map does not disturb the status map — the two are built over the same rows', () => {
  const loads = [{ loadId: 'hexS', name: 'SHEATS', loadNbr: 'DAVIS000203725', driver: 'Sirdedrick Sheats', trips: 15, status: 'Draft' }];
  assert.equal(resolveRosterStatus({ name: 'SHEATS', loadId: 'hexS' }, buildRosterStatusMap(loads)), 'Draft');
  assert.equal(resolveRosterDriver({ name: 'SHEATS', loadId: 'hexS' }, buildRosterDriverMap(loads)), 'Sirdedrick Sheats');
});

// ── A LEFTOVER NAME ON AN EMPTY TRAILER IS NOT AN ASSIGNMENT ───────────────────────────────
//
// Chad, on the Loads panel searched for "sir": MARTIN and TERRY both reading Sirdedrick Sheats.
// "no one assigned sheats to our load."
//
// These four rows are VERBATIM from the live roster that morning. The parser was reading each
// row's own cell correctly — MARTIN and TERRY hold two DIFFERENT spellings, which a misaligned
// column could not produce — and every load carrying freight was right. What is wrong is
// showing a name that NuVizz left on a zero-stop shell.
const LIVE_ROWS = [
  { loadId: 'h1', name: 'ENOCK',   loadNbr: 'DAVIS000203499', driver: 'Enock Akyea',        trips: 18, status: 'Draft' },
  { loadId: 'h2', name: 'WILLIAM', loadNbr: 'DAVIS000203441', driver: 'William Kidd',       trips: 16, status: 'Draft' },
  { loadId: 'h3', name: 'TERRY',   loadNbr: 'DAVIS000203494', driver: 'Sirdedrick Sheets',  trips: 0,  status: 'Draft' },
  { loadId: 'h4', name: 'MARTIN',  loadNbr: 'DAVIS000203490', driver: 'Sirdedrick  Sheats', trips: 0,  status: 'Draft' },
];

test('a load carrying freight keeps its driver; an empty trailer does not borrow one', () => {
  assert.deepEqual(LIVE_ROWS.map((l) => [l.name, rosterDriverOf(l)]), [
    ['ENOCK', 'Enock Akyea'],      // 18 stops — a real assignment, and it was right
    ['WILLIAM', 'William Kidd'],   // 16 stops — likewise
    ['TERRY', ''],                 // 0 stops — Sirdedrick is not running TERRY
    ['MARTIN', ''],                // 0 stops — nor MARTIN
  ]);
});

test('the empty shell reads as unassigned, which is the row the dispatcher is hunting for', () => {
  // The whole case for capturing the driver was that an unstaffed trailer becomes VISIBLE. A
  // leftover name does the opposite, so the rule has to fail toward "nobody".
  assert.equal(rosterDriverOf({ name: 'MARTIN', driver: 'Sirdedrick  Sheats', trips: 0 }), '');
  assert.equal(rosterDriverOf({ name: 'MARTIN', driver: 'Sirdedrick  Sheats' }), '', 'no trips field at all is not freight');
  assert.equal(rosterDriverOf({ name: 'MARTIN', driver: 'Sirdedrick  Sheats', trips: null }), '');
  assert.equal(rosterDriverOf({ name: 'MARTIN', driver: 'Sirdedrick  Sheats', trips: 'x' }), '', 'a non-numeric trip count is not freight');
});

test('no driver stays no driver, whatever the trip count', () => {
  assert.equal(rosterDriverOf({ name: 'ESTES', driver: '', trips: 8 }), '');
  assert.equal(rosterDriverOf({ name: 'ESTES', trips: 8 }), '');
  assert.equal(rosterDriverOf(null), '');
  assert.equal(rosterDriverOf({ name: 'X', driver: '   ', trips: 4 }), '');
});

test('the driver MAP is built on the same rule — an empty shell speaks for nobody', () => {
  const m = buildRosterDriverMap(LIVE_ROWS);
  assert.equal(resolveRosterDriver({ name: 'ENOCK', loadId: 'h1' }, m), 'Enock Akyea');
  assert.equal(resolveRosterDriver({ name: 'MARTIN', loadId: 'h4' }, m), '', 'the Routes card cannot pick it up either');
  assert.equal(resolveRosterDriver({ name: 'TERRY', loadId: 'h3' }, m), '');
});
