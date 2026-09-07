// test/driver-territory.test.mjs — WHOSE AREA IS THIS?
//
// The rules behind a sheet a TRAINEE is handed on paper. That is the highest-stakes place a
// wrong fact can land in this system: nobody reviews a printout, it has no freshness line, and
// a trainee has no way to tell a confident wrong answer from a right one.
//
// Chad asked for "circles or ovals of where their general work area is", and named the failure
// himself: "there are a few drivers this probably won't work great for like rasko or chris."
// These tests pin the answer to that — never fit a shape; ask each PLACE who serves it, and let
// a scattered driver come out looking scattered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zipOf, driverKeyOf, isDriver, zipOwnership, driverCore, territoryCoverage,
} from '../src/lib/driver-territory.js';

const S = (zip, city, user, name = user, extra = {}) =>
  ({ zip, city, driverUserName: user, driverName: name, ...extra });
const many = (n, ...a) => Array(n).fill(0).map(() => S(...a));

// ── placing and attributing a stop ──────────────────────────────────────────

test('ZIP+4 and stray whitespace collapse to the 5-digit ZIP, so one place is one row', () => {
  // NuVizz carries both forms. Left alone, "30518" and "30518-1234" become two different
  // places on the sheet, each with half the evidence — and the shares of both are wrong.
  assert.equal(zipOf({ zip: '30518' }), '30518');
  assert.equal(zipOf({ zip: '30518-1234' }), '30518');
  assert.equal(zipOf({ zip: '  30518  ' }), '30518');
});

test('anything that is not a real ZIP places nothing — never a bucket called ""', () => {
  for (const bad of ['', null, undefined, 'N/A', '3051', '305188', 'ABCDE', '30518-12']) {
    assert.equal(zipOf({ zip: bad }), null, `zip=${JSON.stringify(bad)}`);
  }
});

test('a driver is keyed on the STABLE username, not the display name', () => {
  // driverName is the field that has arrived as a bare ObjectId before (#254), and two people
  // can share a first name. driverUserName is what the history warehouse itself keys on.
  assert.equal(driverKeyOf({ driverUserName: 'vincent', driverName: 'Vincent P' }), 'VINCENT');
  assert.equal(driverKeyOf({ driverUserName: '  de nis ' }), 'DE_NIS');
  assert.equal(driverKeyOf({ driverName: 'DENIS' }), 'DENIS', 'falls back to the name when there is no username');
  assert.equal(driverKeyOf({}), null, 'no driver at all places nothing');
});

// ── a carrier is not a driver ───────────────────────────────────────────────

test('WITH a roster, a line-haul carrier is not shown as a person with a patch', () => {
  // "ESTES" on a sheet reads as somebody a trainee could hand a stop to. It is a carrier.
  const roster = new Set(['VINCENT', 'DENIS']);
  assert.equal(isDriver('VINCENT', roster), true);
  assert.equal(isDriver('ESTES', roster), false);
  const rows = zipOwnership([...many(3, '30601', 'Athens', 'ESTES'), ...many(2, '30518', 'Buford', 'VINCENT')], { roster });
  assert.deepEqual(rows.map((r) => r.zip), ['30518'], 'the carrier ZIP is not on the sheet at all');
});

test('WITHOUT a roster nothing is guessed away — keeping a carrier beats dropping a driver', () => {
  // The asymmetry decides it. A carrier shown is a question a trainee asks once. A real driver
  // silently missing is a territory nobody learns, and nothing on the page admits the gap.
  assert.equal(isDriver('ESTES', null), true);
  assert.equal(territoryCoverage([S('30518', 'Buford', 'VINCENT')]).rosterApplied, false,
    'and the sheet is told the list is unfiltered so it can say so');
});

// ── ownership ───────────────────────────────────────────────────────────────

test('OWNERSHIP IS PER PLACE: the ZIP names who runs it most, and how dominantly', () => {
  const rows = zipOwnership([...many(20, '30518', 'Buford', 'VINCENT'), ...many(5, '30518', 'Buford', 'DENIS')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, 'VINCENT');
  assert.equal(rows[0].ownerStops, 20);
  assert.equal(rows[0].total, 25);
  assert.equal(Math.round(rows[0].share * 100), 80);
  assert.equal(rows[0].contested, true, 'and it says somebody else runs here too');
  assert.deepEqual(rows[0].others.map((o) => o.key), ['DENIS']);
});

test('a share is REPORTED, never thresholded away — "contested" is the useful answer', () => {
  // 51/49 must not render the same as 100/0. A trainee reading a pale ZIP and asking somebody
  // is the correct outcome; a cutoff would turn that into a false certainty.
  const rows = zipOwnership([...many(51, '30045', 'Lawrenceville', 'A'), ...many(49, '30045', 'Lawrenceville', 'B')]);
  assert.equal(rows[0].owner, 'A');
  assert.equal(Math.round(rows[0].share * 100), 51);
  assert.equal(rows[0].contested, true);
});

test('a ZIP with no history is ABSENT from the output, never a zero row', () => {
  // "Nobody covers this ZIP" and "we have never been to this ZIP" are opposite facts, and this
  // repo has now been bitten by conflating them in four places.
  const rows = zipOwnership([S('30518', 'Buford', 'VINCENT')]);
  assert.deepEqual(rows.map((r) => r.zip), ['30518']);
  assert.equal(rows.find((r) => r.zip === '30043'), undefined);
});

test('a blank city never overwrites a real one', () => {
  const rows = zipOwnership([S('30518', '', 'VINCENT'), S('30518', 'Buford', 'VINCENT'), S('30518', '', 'VINCENT')]);
  assert.equal(rows[0].city, 'Buford');
});

// ── the core, and the drivers Chad said this would not work for ─────────────

test('A COMPACT DRIVER GETS A SMALL CORE — the "oval" Chad pictured, without a shape', () => {
  const stops = [...many(40, '30518', 'Buford', 'VINCENT'), ...many(10, '30519', 'Buford', 'VINCENT')];
  const [d] = driverCore(stops);
  assert.equal(d.total, 50);
  assert.deepEqual(d.core.map((c) => c.zip), ['30518'], '40/50 is already 80%');
  assert.ok(d.coreShare >= 0.8);
  assert.equal(d.concentrated, true);
  assert.deepEqual(d.tail.map((t) => t.zip), ['30519'], 'and the rest is named, not hidden');
});

test('THE RASKO CASE: a scattered driver reports a WIDE core and says so — no invented patch', () => {
  // Ten ZIPs, ten stops each. There is no compact area, and a circle would have drawn one
  // anyway, centred on whatever the mean happened to be. The core needs 8 of the 10 ZIPs to
  // reach 80%, `concentrated` is false, and the sheet can print "no fixed patch" honestly.
  const stops = [];
  for (let i = 0; i < 10; i++) stops.push(...many(10, `3060${i}`, `Town${i}`, 'RASKO'));
  const [d] = driverCore(stops);
  assert.equal(d.total, 100);
  assert.equal(d.zipCount, 10);
  assert.equal(d.core.length, 8, '80% of an even spread takes 8 of 10 ZIPs');
  assert.equal(d.concentrated, false, 'so the sheet must NOT claim a work area');
});

test('the ZIP that CROSSES the threshold is inside the core, not outside it', () => {
  // Stopping before it would print a core that covers less than the coverage it claims —
  // a number on a page that is quietly untrue.
  const stops = [...many(7, '30518', 'Buford', 'V'), ...many(3, '30043', 'Lawrenceville', 'V')];
  const [d] = driverCore(stops);           // 7/10 = 70%, so 30043 must be pulled in
  assert.deepEqual(d.core.map((c) => c.zip), ['30518', '30043']);
  assert.ok(d.coreShare >= 0.8, `coreShare ${d.coreShare} must actually reach the coverage claimed`);
});

test('one driver, one stop: a core of one ZIP at 100%, and zipCount says not to trust it', () => {
  const [d] = driverCore([S('30518', 'Buford', 'NEWGUY')]);
  assert.equal(d.total, 1);
  assert.equal(d.coreShare, 1);
  assert.equal(d.zipCount, 1);
});

// ── the coverage line the printout has to carry ─────────────────────────────

test('COVERAGE IS REPORTED, because a sheet built from three days looks like one built from three months', () => {
  const stops = [
    S('30518', 'Buford', 'VINCENT', 'VINCENT', { boardDate: '2026-09-01', lat: 34.1, lng: -83.9 }),
    S('30518', 'Buford', 'VINCENT', 'VINCENT', { boardDate: '2026-09-02' }),
    S('', 'Nowhere', 'VINCENT'),
    { zip: '30043', city: 'Lawrenceville' },      // no driver at all
  ];
  const c = territoryCoverage(stops);
  assert.equal(c.stops, 4);
  assert.equal(c.usable, 2);
  assert.equal(c.days, 2);
  assert.equal(c.noZip, 1);
  assert.equal(c.noDriver, 1);
  assert.equal(c.withCoords, 1);
  assert.equal(Math.round(c.coordShare * 100), 25, 'so a dot map can say what fraction it can plot');
});

test('empty and malformed input produce empty output, never a throw on a page render', () => {
  for (const bad of [[], null, undefined, [null, undefined, {}]]) {
    assert.deepEqual(zipOwnership(bad), []);
    assert.deepEqual(driverCore(bad), []);
  }
  assert.equal(territoryCoverage(null).stops, 0);
});
