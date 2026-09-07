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

// ── ONLY DRIVERS WHO HAVE ACTUALLY RUN ──────────────────────────────────────
//
// Chad, on the first draft: "terry hasn't ran for me in a long time ... just guys that have ran
// in last 4 weeks." A trainee handed a sheet listing somebody who left learns a territory that
// does not exist, and will try to give that person freight.
import { activeDrivers, driverCircles, haversineKm } from '../src/lib/driver-territory.js';

test('a driver below the floor is EXCLUDED — and named, not silently dropped', () => {
  // Silently missing is indistinguishable from never there, which is the same absent-is-not-zero
  // mistake in a different coat. The sheet has to be able to say who it left out.
  const stops = [
    ...many(40, '30518', 'Buford', 'VINCENT'),
    ...many(2, '30518', 'Buford', 'TERRY'),          // two stops in the whole window
  ];
  const { active, excluded } = activeDrivers(stops, { minStops: 5 });
  assert.deepEqual([...active], ['VINCENT']);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].label, 'TERRY');
  assert.equal(excluded[0].stops, 2);
});

test('…and the last day they ran is carried, so the sheet can say WHEN', () => {
  const stops = [
    S('30518', 'Buford', 'TERRY', 'TERRY', { boardDate: '2026-08-04' }),
    S('30518', 'Buford', 'TERRY', 'TERRY', { boardDate: '2026-08-11' }),
  ];
  const { excluded } = activeDrivers(stops, { minStops: 5 });
  assert.equal(excluded[0].lastSeen, '2026-08-11', 'the LATEST date, not the first');
});

test('one stop is not a territory — the floor is what stops a circle round a single point', () => {
  const { active, excluded } = activeDrivers([S('30518', 'Buford', 'ONEOFF')], { minStops: 5 });
  assert.equal(active.size, 0);
  assert.equal(excluded[0].stops, 1);
});

// ── CIRCLES THAT CANNOT LIE ─────────────────────────────────────────────────
//
// Chad: "I think big circles will work better than dots." Built as asked — but one circle PER
// CLUSTER, because a single circle over a two-cluster driver is centred on ground he never
// touches, which is the one thing the dots were guarding against.

const at = (lat, lng, user) => ({ zip: '30518', city: 'X', driverUserName: user, driverName: user, lat, lng });
const blob = (n, lat, lng, user, spread = 0.02) =>
  Array(n).fill(0).map((_, i) => at(lat + ((i % 7) - 3) * spread, lng + ((i % 5) - 2) * spread, user));

test('A COMPACT DRIVER GETS ONE BIG CIRCLE — exactly what Chad pictured', () => {
  const [d] = driverCircles(blob(60, 34.12, -84.00, 'VINCENT'));
  assert.equal(d.circles.length, 1);
  assert.ok(d.circles[0].share > 0.9);
  assert.ok(d.circles[0].radiusKm > 0, 'and it has a real radius');
});

test('THE RASKO CASE: two clusters give TWO circles, never one centred between them', () => {
  // Buford and Athens are ~55km apart. One circle would sit on farmland in the middle covering
  // both, implying a territory nobody works. This is the whole reason the clustering exists.
  const stops = [...blob(40, 34.12, -84.00, 'RASKO'), ...blob(40, 33.95, -83.38, 'RASKO')];
  const [d] = driverCircles(stops);
  assert.equal(d.circles.length, 2, 'two clusters, two circles');
  const mid = { lat: (34.12 + 33.95) / 2, lng: (-84.00 + -83.38) / 2 };
  for (const c of d.circles) {
    assert.ok(haversineKm(c, mid) > 15, `a circle centred at ${c.lat},${c.lng} is sitting in the empty middle`);
  }
});

test('a lone outlier does not inflate a circle — the radius is a percentile, not the max', () => {
  // One favour taken 60km away must not draw a circle covering sixty kilometres of ground.
  const tight = blob(50, 34.12, -84.00, 'V', 0.01);
  const withOutlier = [...tight, at(34.60, -84.60, 'V')];
  const [a] = driverCircles(tight);
  const [b] = driverCircles(withOutlier);
  assert.ok(b.circles[0].radiusKm < a.circles[0].radiusKm * 2,
    `radius went ${a.circles[0].radiusKm.toFixed(1)}km → ${b.circles[0].radiusKm.toFixed(1)}km on one outlier`);
});

test('what the circles do NOT cover is reported, not left to the eye', () => {
  const stops = [...blob(50, 34.12, -84.00, 'V'), at(35.5, -85.5, 'V'), at(35.6, -85.6, 'V')];
  const [d] = driverCircles(stops);
  assert.ok(d.outsideShare > 0, 'stray work outside every circle must be stated as a number');
  assert.equal(d.plotted, 52);
});

test('circles need coordinates, and a driver without them is absent rather than at 0,0', () => {
  // Coordinates are geocoded and partial. Defaulting a missing one to zero would drop a circle
  // in the Atlantic; the honest answer is that this driver cannot be drawn.
  const out = driverCircles([S('30518', 'Buford', 'NOCOORDS')]);
  assert.deepEqual(out, []);
});

test('the active filter feeds the circles — an inactive driver is not drawn', () => {
  const stops = [...blob(40, 34.12, -84.00, 'VINCENT'), ...blob(2, 33.95, -83.38, 'TERRY')];
  const { active } = activeDrivers(stops, { minStops: 5 });
  const drawn = driverCircles(stops, { active });
  assert.deepEqual(drawn.map((d) => d.key), ['VINCENT']);
});

test('clustering is deterministic — the same data draws the same map twice', () => {
  const stops = [...blob(40, 34.12, -84.00, 'A'), ...blob(30, 33.95, -83.38, 'A')];
  assert.deepEqual(driverCircles(stops), driverCircles(stops));
});

// ── THE TWO THINGS THE FIRST DRAFT GOT WRONG, PINNED ────────────────────────

test('A DRIVER WHO STOPPED RUNNING IS EXCLUDED even with plenty of stops', () => {
  // Chad's actual case: "terry hasn't ran for me in a long time". Terry did 70 stops at the
  // START of the window and nothing since. Any count test passes him; only recency catches it.
  const stops = [
    ...many(70, '30071', 'Norcross', 'TERRY').map((s, i) => ({ ...s, boardDate: i < 35 ? '2026-08-10' : '2026-08-11' })),
    ...many(40, '30518', 'Buford', 'VINCENT').map((s) => ({ ...s, boardDate: '2026-09-04' })),
  ];
  const { active, excluded } = activeDrivers(stops, { minStops: 5, staleDays: 14 });
  assert.deepEqual([...active], ['VINCENT']);
  const t = excluded.find((e) => e.key === 'TERRY');
  assert.ok(t, 'Terry must be excluded');
  assert.equal(t.why, 'stopped running', 'and for the RIGHT reason — not "too few"');
  assert.equal(t.stops, 70, 'he has plenty of stops; that was never the problem');
  assert.ok(t.daysSince >= 24);
});

test('recency is measured against the WINDOW END, not a wall clock', () => {
  // Re-printing last month's sheet must give last month's answer, not a page where everybody
  // looks lapsed because time has passed since.
  const stops = [
    ...many(20, '30518', 'Buford', 'A').map((s) => ({ ...s, boardDate: '2020-01-02' })),
    ...many(20, '30518', 'Buford', 'B').map((s) => ({ ...s, boardDate: '2020-01-10' })),
  ];
  const { active } = activeDrivers(stops, { minStops: 5, staleDays: 14 });
  assert.deepEqual([...active].sort(), ['A', 'B'], 'a 2020 window still has active drivers in it');
});

test('SCATTERED WORK GETS NO CIRCLE AT ALL — the Rasko rule, stated as a refusal', () => {
  // Eight thin scatters across the metro. The first draft chained them through one-stop cells
  // into ONE circle 60km across covering ground he never touches — the exact failure circles
  // were meant to avoid, arriving through the clustering. Now: no circles, and a flag saying so.
  const pts = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 5; j++) pts.push(at(33.7 + i * 0.11, -84.5 + i * 0.14 + j * 0.01, 'RASKO'));
  }
  const [d] = driverCircles(pts);
  assert.equal(d.noFixedArea, true, 'a driver with no patch must be flagged, not drawn');
  assert.deepEqual(d.circles, [], 'and no circle is drawn for him');
  assert.ok(d.covered < 0.55);
});

test('…while a genuinely two-area driver still GETS both circles', () => {
  // The refusal must not swallow the honest two-cluster case, which is the whole point of
  // per-cluster circles. Two dense blobs, well apart: two circles, and neither in the middle.
  const stops = [...blob(40, 34.12, -84.00, 'PAT', 0.012), ...blob(40, 33.95, -83.38, 'PAT', 0.012)];
  const [d] = driverCircles(stops);
  assert.equal(d.noFixedArea, false);
  assert.equal(d.circles.length, 2);
});

test('a sparse trail cannot bridge two dense areas into one circle', () => {
  // The bridging bug directly: two tight blobs plus a thin line of single stops between them.
  const bridge = [];
  for (let i = 1; i < 12; i++) bridge.push(at(34.12 - i * 0.015, -84.00 + i * 0.05, 'B'));
  const stops = [...blob(40, 34.12, -84.00, 'B', 0.012), ...blob(40, 33.95, -83.38, 'B', 0.012), ...bridge];
  const [d] = driverCircles(stops);
  assert.ok(d.circles.length >= 2, `the bridge merged them into ${d.circles.length} circle(s)`);
  for (const c of d.circles) assert.ok(c.radiusKm < 25, `a ${c.radiusKm.toFixed(0)}km circle is the merged blob again`);
});

test('A CIRCLE TOO BIG IS NOT A TERRITORY — the rule a measurement found, not a guess', () => {
  // The rule I got wrong twice. Coverage cannot catch a scattered driver: once the metro is
  // dense his stops all sit in ONE connected region, so the single cluster covered 99% of his
  // work and passed every earlier test — as a 23km circle swallowing four other drivers' areas.
  // What separates a patch from a smear is SIZE, and only measuring the radii showed that.
  const wide = [];
  for (let i = 0; i < 90; i++) {
    // A broad, evenly dense smear ~40km across: genuinely one cluster, genuinely not a patch.
    wide.push(at(33.80 + (i % 10) * 0.045, -84.40 + Math.floor(i / 10) * 0.055, 'SMEAR'));
  }
  const [d] = driverCircles(wide);
  assert.ok(d.candidateCircles.length, 'it does form one big cluster — that was never in doubt');
  assert.ok(d.candidateCircles[0].radiusKm > 15, `the cluster is ${d.candidateCircles[0].radiusKm.toFixed(0)}km wide`);
  assert.equal(d.noFixedArea, true, 'so it must not be drawn');
  assert.deepEqual(d.circles, []);
});

test('…and a tight patch of the same stop count still draws', () => {
  // The size rule must not simply refuse busy drivers. Same 90 stops, packed into ~6km.
  const tight = [];
  for (let i = 0; i < 90; i++) tight.push(at(34.12 + (i % 10) * 0.006, -84.00 + Math.floor(i / 10) * 0.007, 'TIGHT'));
  const [d] = driverCircles(tight);
  assert.equal(d.noFixedArea, false);
  assert.equal(d.circles.length, 1);
  assert.ok(d.circles[0].radiusKm <= 15);
});
