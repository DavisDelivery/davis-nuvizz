// TYPING A DRIVER'S NAME INSTEAD OF SCROLLING PAST 59 OF THEM.
//
// Chad, on the route card's driver control: "i want this to be a search bar as well as a drop
// down." Every test below names how a dispatcher actually types — because the failure mode
// that matters here is not a crash, it is a truck going to the wrong human being.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterDrivers, driverMatches, driverLabel, driverById, nextHighlight, queryWords,
} from '../src/lib/driver-filter.js';

const ROSTER = [
  { driverId: 1, name: 'Michael Frye', userName: 'FRYE' },
  { driverId: 2, name: 'George Leonard', userName: 'GEORGEL' },
  { driverId: 3, name: 'Kobe Boayke', userName: 'KOBEB' },
  { driverId: 4, name: 'Brent Boyd', userName: 'BBOYD' },
  { driverId: 5, name: 'Michelle Frazier', userName: 'MFRAZ' },
];
const names = (q) => filterDrivers(ROSTER, q).map((d) => d.name);

// ── HOW A DISPATCHER TYPES ───────────────────────────────────────────────────

test('an empty box hides nobody — it is a dropdown before it is a search bar', () => {
  assert.equal(filterDrivers(ROSTER, '').length, 5);
  assert.equal(filterDrivers(ROSTER, '   ').length, 5);
});

test('a partial first name finds the driver before you finish typing it', () => {
  assert.deepEqual(names('mic'), ['Michael Frye', 'Michelle Frazier']);
  assert.deepEqual(names('micha'), ['Michael Frye']);
});

test('the last name works on its own — a manifest is read surname first', () => {
  assert.deepEqual(names('frye'), ['Michael Frye']);
  assert.deepEqual(names('boyd'), ['Brent Boyd']);
});

test('surname-first typing finds the same driver as first-name-first', () => {
  assert.deepEqual(names('frye michael'), ['Michael Frye']);
  assert.deepEqual(names('michael frye'), ['Michael Frye']);
});

test('the NuVizz user code works, because that is what is printed on the paperwork', () => {
  assert.deepEqual(names('georgel'), ['George Leonard']);
  assert.deepEqual(names('kobeb'), ['Kobe Boayke']);
});

test('case never matters', () => {
  assert.deepEqual(names('KOBE'), ['Kobe Boayke']);
  assert.deepEqual(names('kObE'), ['Kobe Boayke']);
});

// ── THE RULE THAT STOPS THE BOX BEING A NO-OP ────────────────────────────────

test('a second word NARROWS — every word must hit, or two words widen to everybody', () => {
  // "mic" alone is two drivers. Adding a second word must cut it down, never OR its way back
  // out to the whole roster, which is what an any-word match would do.
  assert.equal(names('mic').length, 2);
  assert.deepEqual(names('mic fra'), ['Michelle Frazier']);
  assert.deepEqual(names('mic fry'), ['Michael Frye']);
});

test('punctuation between words is ignored, not treated as a name', () => {
  assert.deepEqual(names('frye, michael'), ['Michael Frye']);
  assert.deepEqual(names('michael-frye'), ['Michael Frye']);
});

test('a query nobody matches returns nothing rather than falling back to everybody', () => {
  // Falling back to the full roster on a miss is worse than an empty list: the dispatcher
  // believes the box is filtering and picks off an unfiltered list.
  assert.deepEqual(names('zzz'), []);
  assert.deepEqual(names('fyre'), []);   // a typo must MISS, visibly
});

test('matching is by PREFIX, not substring — mid-word hits are not offered', () => {
  // "rye" is not how anyone starts typing Frye; it is most likely a slip. A substring match
  // would offer him anyway, and the same rule would make "eor" offer George and "oay" Kobe —
  // a list whose reasoning a dispatcher cannot follow, on a control that assigns a truck.
  assert.deepEqual(names('rye'), []);
  assert.deepEqual(names('eor'), []);
  assert.deepEqual(names('oay'), []);
  // ...while the prefix of any WORD in the name still works, first or last.
  assert.deepEqual(names('fry'), ['Michael Frye']);
  assert.deepEqual(names('leo'), ['George Leonard']);
});

test('it is not fuzzy on purpose — no near-miss ever offers a different human being', () => {
  assert.deepEqual(names('mrye'), []);
  assert.deepEqual(names('bryd'), []);   // the Brent Boyd/Bryd alias failure, kept honest
});

// ── ORDER ────────────────────────────────────────────────────────────────────

test('matches keep roster order, so a row cannot move under the cursor between keystrokes', () => {
  // The roster is sorted A-Z at the source (v0.32.9). Re-ranking by score would slide a name
  // under the highlight mid-type and Enter would take the wrong one.
  assert.deepEqual(names('m'), ['Michael Frye', 'Michelle Frazier']);
});

// ── THE ABSENT, THE EMPTY, THE MALFORMED ─────────────────────────────────────

test('a missing or malformed roster does not throw', () => {
  assert.deepEqual(filterDrivers(null, 'x'), []);
  assert.deepEqual(filterDrivers(undefined, ''), []);
  assert.deepEqual(filterDrivers([null, {}, { name: '' }], 'x'), []);
  assert.equal(driverMatches(null, 'x'), false);
  assert.equal(driverMatches({}, ''), true);
});

test('a driver with no user code still matches on name alone', () => {
  assert.deepEqual(filterDrivers([{ driverId: 9, name: 'Solo Driver' }], 'solo').map((d) => d.name), ['Solo Driver']);
});

// ── LABEL AND LOOKUP ─────────────────────────────────────────────────────────

test('the label reads the way the old dropdown read — name, then code', () => {
  assert.equal(driverLabel(ROSTER[0]), 'Michael Frye (FRYE)');
  assert.equal(driverLabel({ driverId: 9, name: 'Solo Driver' }), 'Solo Driver');
  assert.equal(driverLabel(null), '');
});

test('a stored id finds its driver ACROSS the number/string boundary', () => {
  // The roster carries numeric ids and every form round-trip turns them into text. A === over
  // that boundary silently finds nobody, and the box would show empty on a route that has a
  // driver assigned.
  assert.equal(driverById(ROSTER, 1)?.name, 'Michael Frye');
  assert.equal(driverById(ROSTER, '1')?.name, 'Michael Frye');
  assert.equal(driverById(ROSTER, ''), null);
  assert.equal(driverById(ROSTER, null), null);
  assert.equal(driverById(ROSTER, 99), null);
});

// ── KEYBOARD ─────────────────────────────────────────────────────────────────

test('arrowing wraps at both ends, so the bottom of 59 names is one key from the top', () => {
  assert.equal(nextHighlight(-1, 1, 5), 0);
  assert.equal(nextHighlight(4, 1, 5), 0);
  assert.equal(nextHighlight(0, -1, 5), 4);
  assert.equal(nextHighlight(2, 1, 5), 3);
  assert.equal(nextHighlight(2, -1, 5), 1);
});

test('arrowing UP from nothing highlighted lands on the LAST row, not off the end', () => {
  assert.equal(nextHighlight(-1, -1, 5), 4);
});

test('an empty list has nothing to highlight — never index 0 of nothing', () => {
  assert.equal(nextHighlight(-1, 1, 0), -1);
  assert.equal(nextHighlight(0, 1, 0), -1);
  assert.equal(nextHighlight(0, 1, NaN), -1);
});

test('a stale highlight past the end of a re-filtered list is brought back in range', () => {
  // Type another letter and the list shrinks under the cursor. Index 7 of a 2-row list must
  // not arrow to 8; it re-enters at a real row.
  const next = nextHighlight(7, 1, 2);
  assert.ok(next >= 0 && next < 2, `expected an in-range row, got ${next}`);
});

test('queryWords drops the noise a name never carries', () => {
  assert.deepEqual(queryWords('  Frye,  Michael  '), ['frye', 'michael']);
  assert.deepEqual(queryWords(null), []);
});
