// test/area-select-planned.test.mjs — A BOX OVER A SENT ROUTE PICKS UP NONE OF ITS STOPS (v1.36.3)
//
// Chad, Sep 15, with CHE and MARCUS sent to NuVizz and their stops coming back up in a
// box-select: "its letting me select stops that are already on routes that have been sent to
// nuvizz". The area tools (box / lasso / Add in view) skipped only stops on an open Compare
// card or staged on another device; a stop the board held PLANNED on a load with no card open
// rode into the selection. These pin the rule that fixes it, and the wiring that reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { areaSelectPartition, areaSelectMessage, areaSelectLoadsText, areaSelectSkipsPlanned } from '../src/lib/routing-select.js';

// The CHE stops from Chad's screenshot, as the board serves them after the 8:29 PM Send
// (007176785 reads PLANNED on CHE, stop 11, per the explain endpoint — zero NuVizz calls).
const che = (n, seq) => ({ stopNbr: n, isPlanned: true, isUnplanned: false, routeName: 'CHE', loadNbr: 'DAVIS000203820', routeSeq: seq });
const marcus = (n, seq) => ({ stopNbr: n, isPlanned: true, isUnplanned: false, routeName: 'MARCUS', loadNbr: 'DAVIS000203825', routeSeq: seq });
const pool = (n) => ({ stopNbr: n, isPlanned: false, isUnplanned: true, routeName: null, loadNbr: null });
const none = { staged: new Map(), claims: new Map() };

test('CHE sent and its card closed — a box over Dalton picks up none of CHE\'s stops', () => {
  const inside = [che('007176785', 11), che('007176798', 3), che('007176800', 5), che('007176815', 10)];
  const part = areaSelectPartition(inside, none);
  assert.deepEqual(part.take, []);
  assert.equal(part.onLoads.length, 4);
  assert.deepEqual([...part.loads], [['CHE', 4]]);
  assert.equal(areaSelectMessage(part, inside.length), 'All 4 stops are already on CHE');
});

test('a mixed box takes the pool stops and names the loads it left, biggest first', () => {
  const inside = [pool('A'), che('C1', 1), marcus('M1', 1), che('C2', 2), pool('B'), che('C3', 3), marcus('M2', 2)];
  const part = areaSelectPartition(inside, none);
  assert.deepEqual(part.take.map((s) => s.stopNbr), ['A', 'B']);
  assert.equal(part.onLoads.length, 5);
  assert.equal(areaSelectMessage(part, inside.length), 'Added 2 stops · skipped 5 already on loads (CHE 3, MARCUS 2)');
});

test('a stop on an OPEN Compare card is still skipped, and reported as on a card — not as on a load', () => {
  // The card's stops are planned too; "already on open cards" is the line that says use Ninja.
  const inside = [che('C1', 1), che('C2', 2), pool('A')];
  const part = areaSelectPartition(inside, { staged: new Map([['C1', 'CHE'], ['C2', 'CHE']]), claims: new Map() });
  assert.deepEqual(part.take.map((s) => s.stopNbr), ['A']);
  assert.equal(part.onCards.length, 2);
  assert.equal(part.onLoads.length, 0);
  assert.equal(areaSelectMessage(part, 3), 'Added 1 stop · skipped 2 already on open cards');
});

test('a stop the OTHER dispatcher\'s device is staging is still skipped (presence layer)', () => {
  const inside = [pool('A'), pool('B')];
  const part = areaSelectPartition(inside, { staged: new Map(), claims: new Map([['B', 'Eugene']]) });
  assert.deepEqual(part.take.map((s) => s.stopNbr), ['A']);
  assert.equal(part.onPeer.length, 1);
  assert.equal(areaSelectMessage(part, 2), 'Added 1 stop · skipped 1 staged on another device');
});

test('nothing to take, one reason — the pre-v1.36.3 wordings are unchanged', () => {
  const cards = areaSelectPartition([pool('A'), pool('B'), pool('C')], { staged: new Map([['A', 'k'], ['B', 'k'], ['C', 'k']]), claims: new Map() });
  assert.equal(areaSelectMessage(cards, 3), 'All 3 stops are already on open Compare cards');
  const peer = areaSelectPartition([pool('A'), pool('B')], { staged: new Map(), claims: new Map([['A', 'x'], ['B', 'x']]) });
  assert.equal(areaSelectMessage(peer, 2), 'All 2 stops are being staged on another device');
});

test('nothing to take, several reasons — every reason is on the line', () => {
  const part = areaSelectPartition([pool('A'), pool('B'), che('C', 1)], { staged: new Map([['A', 'k']]), claims: new Map([['B', 'x']]) });
  assert.equal(part.take.length, 0);
  assert.equal(areaSelectMessage(part, 3), 'All 3 stops are already on open Compare cards or being staged on another device or already on CHE');
});

test('singular grammar: one stop, one load', () => {
  const part = areaSelectPartition([che('C', 1)], none);
  assert.equal(areaSelectMessage(part, 1), 'All 1 stop is already on CHE');
});

test('isUnplanned WINS over a stale routeName — the write-through\'s own precedence — so the stop is taken', () => {
  // A stop that just came OFF a load: the un-plan stamp sets isUnplanned and a stale name can linger.
  const stale = { stopNbr: 'S', isUnplanned: true, isPlanned: false, routeName: 'TREVARR' };
  const part = areaSelectPartition([stale], none);
  assert.deepEqual(part.take.map((s) => s.stopNbr), ['S']);
  assert.equal(part.onLoads.length, 0);
});

test('a row carrying only a route/load name (older cache shape) still counts as on that load', () => {
  const part = areaSelectPartition([{ stopNbr: 'X', routeName: 'BEN 2' }, { stopNbr: 'Y', loadNbr: 'DAVIS000198668' }], none);
  assert.equal(part.take.length, 0);
  assert.deepEqual([...part.loads], [['BEN 2', 1], ['DAVIS000198668', 1]]);
});

test('a planned stop with no name at all reads as "a load" rather than a blank', () => {
  const part = areaSelectPartition([{ stopNbr: 'Z', isPlanned: true }], none);
  assert.equal(areaSelectMessage(part, 1), 'All 1 stop is already on a load');
});

test('the loads text: one load names itself, many name three and count the rest', () => {
  assert.equal(areaSelectLoadsText(new Map([['CHE', 9]])), 'CHE');
  assert.equal(areaSelectLoadsText(new Map([['CHE', 9], ['MARCUS', 4]])), 'loads (CHE 9, MARCUS 4)');
  assert.equal(areaSelectLoadsText(new Map([['A', 1], ['B', 5], ['C', 2], ['D', 3], ['E', 1]])), 'loads (B 5, D 3, C 2, +2 more)');
  assert.equal(areaSelectLoadsText(new Map()), 'loads');
});

test('empty and malformed input: no stops → "No stops in that area"; null rows are ignored', () => {
  assert.equal(areaSelectMessage(areaSelectPartition([], none), 0), 'No stops in that area');
  const part = areaSelectPartition([null, undefined, pool('A')], none);
  assert.deepEqual(part.take.map((s) => s.stopNbr), ['A']);
});

test('THE SWITCH — house shape: on unless an explicit off-word, and a typo leaves it ON', () => {
  for (const v of [undefined, null, '', '  ', 'on', 'true', '1', 'yes', 'bogus', 'of', 'disabled']) assert.equal(areaSelectSkipsPlanned(v), true, `expected ON for ${JSON.stringify(v)}`);
  for (const v of ['off', 'OFF', ' Off ', '0', 'false', 'FALSE', 'no', 'No']) assert.equal(areaSelectSkipsPlanned(v), false, `expected OFF for ${JSON.stringify(v)}`);
});

test('with the switch OFF the old rule is back exactly: planned stops ride in, cards and peers still skipped', () => {
  const inside = [che('C1', 1), marcus('M1', 1), pool('A'), pool('B')];
  const part = areaSelectPartition(inside, { staged: new Map([['A', 'k']]), claims: new Map([['B', 'x']]), skipPlanned: false });
  assert.deepEqual(part.take.map((s) => s.stopNbr), ['C1', 'M1']);
  assert.equal(part.onLoads.length, 0);
  assert.equal(areaSelectMessage(part, 4), 'Added 2 stops · skipped 1 already on open cards · skipped 1 staged on another device');
});

// ── WIRING PINS: the rule is read by the screen, through the switch, by all three tools ──
const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
// The changelog rows are prose about the code — strip them so a pin reads the app, not the story.
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('addEnclosed reads areaSelectPartition with the switch, and box / lasso / Add in view all go through addEnclosed', () => {
  const m = /const addEnclosed = useCallback\(\(arr\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(code);
  assert.ok(m, 'addEnclosed is no longer defined in the shape the rule expects');
  const body = m[1];
  assert.ok(/areaSelectPartition\(arr, \{ staged: wbStagedRef\.current, claims: peerClaimsRef\.current, skipPlanned: AREA_SELECT_SKIPS_PLANNED \}\)/.test(body), 'addEnclosed no longer reads the tested rule with the switch');
  assert.ok(/setLastAction\(areaSelectMessage\(part, arr\.length\)\)/.test(body), 'the action line no longer comes from areaSelectMessage');
  assert.ok(!/staged\.has\(String\(s\.stopNbr\)\) && !claims\.has/.test(body), 'the old inline filter is back — two copies of the rule is two chances to disagree');
  // Every area tool funnels through addEnclosed over the positioned list — none grew its own filter.
  const calls = code.match(/addEnclosed\(positionedRef\.current\.filter\(/g) || [];
  assert.ok(calls.length >= 3, `expected box, lasso and Add-in-view to call addEnclosed over positionedRef; found ${calls.length}`);
  assert.ok(/const enclosed = positionedRef\.current\.filter\(\(s\) => pointInPolygon\(s\.lat, s\.lng, poly\)\);\n\s*addEnclosed\(enclosed\);/.test(code), 'finishLasso no longer goes through addEnclosed');
});

test('the switch is the named env var, read through the house-shape parser, and defaults ON on any error', () => {
  assert.ok(/const AREA_SELECT_SKIPS_PLANNED = \(\(\) => \{\n\s*try \{ return areaSelectSkipsPlanned\(import\.meta\.env\.VITE_ROUTING_AREA_SELECT_SKIPS_PLANNED\); \} catch \{ return true; \}/.test(code), 'VITE_ROUTING_AREA_SELECT_SKIPS_PLANNED is not read through areaSelectSkipsPlanned with an ON fallback');
  // Pinned as MEMBERSHIP, not as the tail of the line: the three names must come from the
  // tested module, but a later import added beside them is not a broken rule. The first shape
  // of this failed on v1.36.5, which appended highlightedForSelection to the same statement.
  const imp = /import \{([^}]*)\} from '\.\/lib\/routing-select\.js'/.exec(code);
  assert.ok(imp, 'nothing imports lib/routing-select.js any more');
  const imported = imp[1].split(',').map((n) => n.trim());
  for (const fn of ['areaSelectPartition', 'areaSelectMessage', 'areaSelectSkipsPlanned']) {
    assert.ok(imported.includes(fn), `${fn} is not imported from the tested module`);
  }
});
