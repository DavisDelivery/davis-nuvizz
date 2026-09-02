// A 53-FOOTER ROUTED TO A DOCK A DISPATCHER SAID CANNOT TAKE ONE.
//
// Chad: "stops we have put on a tractor that have been hardcoded as no tractor trailer by a
// dispatcher. Not the Uline advisory ones that we pick up automatically just the dispatcher
// hardcoded ones."
//
// Two halves, and both are ways to be confidently wrong:
//   * WHO SAID NO. A scanner reading Uline's order text is not a dispatcher, and the whole
//     ask was to tell them apart. Every exclusion below names the mark it protects against.
//   * WHAT TRUCK IS ON IT. "We do not know" is not "it is a box truck" — a rule that blurs
//     those is silent on exactly the loads nobody has typed a vehicle onto yet.
//
// The failure this prevents is not a late delivery. A driver who cannot turn a 53' trailer
// into the lot leaves with the pallets still on it: a refusal, plus a redelivery on our dime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags } from '../src/lib/board-flags.js';
import { dispatcherTrailerBlock, trailerBlockerLabels } from '../src/lib/trailer-block.js';
import { tractorPaintAllowed, TRAILER_BLOCKER_KEYS } from '../src/lib/map-legend.js';
import { selectTextable, smsText, smsClaimPath, TRAILER_SMS_CAP, SMS_PER_SWEEP_CAP } from '../netlify/functions/lib/flag-sms.mts';
import { buildRouteClasses } from '../netlify/functions/lib/route-classes.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DATE = '2026-09-01';

const stop = (over = {}) => ({
  stopNbr: '1001', businessName: 'ACME', addr1: '1 Main', city: 'Buford',
  lat: 34.10, lng: -84.00, matchKey: 'acme',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'TRACTOR 2', routeName: 'TRACTOR 2', routeSeq: 3, stopType: 'DO',
  ...over,
});

const run = (stops, notesObj = {}, routeClasses = { 'TRACTOR 2': 'tractor', 'BOX 1': 'box' }) =>
  computeBoardFlags({
    stops, notes: new Map(Object.entries(notesObj)), rosterRows: [],
    servedDate: DATE, dayKey: 'tue',
    opts: {
      depot: DEPOT, departMin: 8 * 60,
      travel: { legs: {}, ...(routeClasses ? { routeClasses } : {}) },
    },
  });
const trailerRows = (out) => out.rows.filter((r) => r.rule === 'trailer_conflict');

// ── WHO SAID NO ──────────────────────────────────────────────────────────────

test('a dispatcher-ticked "No tractor trailer" on a tractor route flags RED', () => {
  const out = run([stop()], {
    acme: {
      equipment_restrictions: ['no_tractor_trailer'],
      manual_overrides: { equipment_restrictions: true },
    },
  });
  const rows = trailerRows(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'red');
  assert.equal(rows[0].stopNbr, '1001');
  assert.equal(rows[0].routeKey, 'TRACTOR 2');
  assert.deepEqual(rows[0].blockers, ['no_tractor_trailer']);
  assert.equal(rows[0].blockedVia, 'restriction');
  assert.match(rows[0].detail, /No tractor trailer/);
});

test('THE ULINE ADVISORY DOES NOT FLAG — this is the exclusion Chad asked for by name', () => {
  // uline_straight_truck lifted out of somebody else's order text by the scanner. It IS a
  // trailer blocker for map-drawing (the amber icon) and it is NOT a dispatcher saying no.
  const out = run([stop()], {
    acme: {
      equipment_restrictions: ['uline_straight_truck'],
      auto_sources: { uline_straight_truck: [{ source: 'orderInstructions', text: 'STRAIGHT TRUCK ONLY' }] },
    },
  });
  assert.deepEqual(trailerRows(out), []);
  assert.ok(TRAILER_BLOCKER_KEYS.has('uline_straight_truck'), 'still a blocker on the map — just not a human');
});

test('a scanner-found no_tractor_trailer is advisory too — nobody confirmed it', () => {
  const out = run([stop()], {
    acme: {
      equipment_restrictions: ['no_tractor_trailer'],
      auto_sources: { no_tractor_trailer: [{ source: 'addr2', text: 'NO TRACTOR TRAILERS' }] },
    },
  });
  assert.deepEqual(trailerRows(out), []);
});

test('the Routing box-only paint flags — a dropdown only a dispatcher can reach', () => {
  const rows = trailerRows(run([stop()], { acme: { vehicle_eligibility: 'box_only' } }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blockedVia, 'eligibility');
  assert.match(rows[0].detail, /painted box-truck only/);
});

test('a dispatcher who painted the stop TRACTOR-OK is not told off for answering the question', () => {
  // Same override the map honours (drawnRestrictionKeys drops every blocker behind it).
  const out = run([stop()], {
    acme: {
      vehicle_eligibility: 'tractor',
      equipment_restrictions: ['no_tractor_trailer'],
      manual_overrides: { equipment_restrictions: true },
    },
  });
  assert.deepEqual(trailerRows(out), []);
});

test('an unaliased spelling a dispatcher can actually tick still blocks — no_53ft, 26ft max', () => {
  for (const key of ['no_53ft', '26ft_max', 'box_truck_only', 'no_overhead_clearance']) {
    const out = run([stop()], {
      acme: { equipment_restrictions: [key], manual_overrides: { equipment_restrictions: true } },
    });
    assert.equal(trailerRows(out).length, 1, `${key} must block a 53-footer`);
  }
});

test('a restriction that says nothing about a trailer does not flag', () => {
  const out = run([stop()], {
    acme: { equipment_restrictions: ['liftgate_required'], manual_overrides: { equipment_restrictions: true } },
  });
  assert.deepEqual(trailerRows(out), []);
});

test('dispatcherTrailerBlock and the map\'s own paint override agree about the same note', () => {
  // The two functions answer the same question in opposite polarity, off the same module.
  // They disagreeing is the v0.76.4 bug in a new hat, so pin them together.
  const cases = [
    { equipment_restrictions: ['no_tractor_trailer'], manual_overrides: { equipment_restrictions: true } },
    { equipment_restrictions: ['uline_straight_truck'], auto_sources: { uline_straight_truck: [{ source: 'x' }] } },
    { vehicle_eligibility: 'box_only' },
    { equipment_restrictions: ['liftgate_required'] },
    { equipment_restrictions: ['no_53ft'] },
  ];
  for (const note of cases) {
    const blocked = dispatcherTrailerBlock(note).blocked;
    const paint = tractorPaintAllowed(note.vehicle_eligibility ?? null, note.equipment_restrictions || [], note);
    assert.equal(blocked, !paint, `disagreement on ${JSON.stringify(note)}`);
  }
});

// ── WHAT TRUCK IS ON IT ──────────────────────────────────────────────────────

const HARD_NO = { acme: { equipment_restrictions: ['no_tractor_trailer'], manual_overrides: { equipment_restrictions: true } } };

test('the same stop on a BOX route is not a conflict', () => {
  const out = run([stop({ loadNbr: 'BOX 1', routeName: 'BOX 1' })], HARD_NO);
  assert.deepEqual(trailerRows(out), []);
});

test('NO TRUCK-CLASS MAP REPORTS "not checked", never "clean"', () => {
  // A pre-day board at 8pm before anybody has typed a vehicle onto a load. Silence here is
  // legitimate; silence that looks like a clean board is not.
  const out = run([stop()], HARD_NO, null);
  assert.deepEqual(trailerRows(out), []);
  assert.equal(out.skipped.noTruckClasses, true);
  assert.equal(out.checked.tractorRoutes, 0);
});

test('a class map that does not name THIS route leaves it unjudged', () => {
  const out = run([stop()], HARD_NO, { 'SOME OTHER LOAD': 'tractor' });
  assert.deepEqual(trailerRows(out), []);
  assert.equal(out.skipped.noTruckClasses, false, 'the map existed — this route just was not in it');
});

test('a delivered stop is not a problem, and neither is one on the Uline APPT parking lot', () => {
  assert.deepEqual(trailerRows(run([stop({ normalizedStatus: 'DELIVERED', status: '90' })], HARD_NO)), []);
  const appt = run(
    [stop({ loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' })], HARD_NO,
    { 'ULINE APPT': 'tractor' },
  );
  assert.deepEqual(trailerRows(appt), []);
});

test('A PICKUP COUNTS — a turning radius does not care which way the pallets go', () => {
  // Deliberately unlike every receiving-hours rule in this engine, which exempts pickups
  // because a pickup has no freight to take IN. Physical access is not that question.
  const out = run([stop({ stopType: 'PU', routeSeq: null })], HARD_NO);
  assert.equal(trailerRows(out).length, 1);
});

test('several conflicts on one load are counted per ROUTE — that is the wrong TRUCK, not N wrong stops', () => {
  const stops = [
    stop({ stopNbr: 'A', matchKey: 'acme', routeSeq: 1 }),
    stop({ stopNbr: 'B', matchKey: 'beta', routeSeq: 2 }),
    stop({ stopNbr: 'C', matchKey: 'gamma', routeSeq: 3, loadNbr: 'TRACTOR 9', routeName: 'TRACTOR 9' }),
  ];
  const notes = {
    acme: HARD_NO.acme, beta: { vehicle_eligibility: 'box_only' }, gamma: HARD_NO.acme,
  };
  const out = run(stops, notes, { 'TRACTOR 2': 'tractor', 'TRACTOR 9': 'tractor' });
  const rows = trailerRows(out);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.filter((r) => r.routeKey === 'TRACTOR 2').map((r) => r.routeConflicts), [2, 2]);
  assert.deepEqual(rows.filter((r) => r.routeKey === 'TRACTOR 9').map((r) => r.routeConflicts), [1]);
  assert.match(rows.find((r) => r.stopNbr === 'A').detail, /1 other stop on TRACTOR 2/);
  assert.doesNotMatch(rows.find((r) => r.stopNbr === 'C').detail, /other stop/, 'never "+0 more"');
  assert.equal(out.checked.tractorRoutes, 2);
  assert.equal(out.checked.trailerConflicts, 3);
});

test('the flag counts as RED on the board chip', () => {
  const out = run([stop()], HARD_NO);
  assert.equal(out.redCount, 1);
  assert.equal(out.criticalCount, 0, 'critical is the hours model\'s error-band word — this rule has no error band');
});

test('dismissal is scoped to the DAY and the LOAD — moving the stop retires the row', () => {
  const a = trailerRows(run([stop()], HARD_NO))[0];
  const b = trailerRows(run([stop({ loadNbr: 'TRACTOR 9', routeName: 'TRACTOR 9' })], HARD_NO,
    { 'TRACTOR 9': 'tractor' }))[0];
  assert.equal(a.scope, 'occurrence');
  assert.notEqual(a.dismissKey, b.dismissKey, 'a dismissal on one load must not follow the stop to another');
});

// ── WHICH TRUCK RUNS EACH ROUTE ──────────────────────────────────────────────

test('the load header outranks the roster, and an unknown route gets NO class', () => {
  const loads = [
    { loadNbr: 'TRACTOR 2', routeName: 'BEN', vehicleType: '53ft Trailer' },
    { loadNbr: 'BOX 1', routeName: 'DJ', vehicleType: 'Box Truck' },
    { loadNbr: 'MYSTERY', routeName: 'NOBODY', vehicleType: '' },
  ];
  const stops = [
    { loadNbr: 'TRACTOR 2', driverName: 'BOXY BOB', stopType: 'DO' },
    { loadNbr: 'ROSTER ONLY', driverName: 'BOXY BOB', stopType: 'DO' },
    { loadNbr: 'MYSTERY', driverName: 'UNKNOWN PERSON', stopType: 'DO' },
  ];
  const roster = { aliasToVehicle: new Map([['BOXY BOB', { vehicleType: 'box', name: 'Bob' }]]) };
  const rc = buildRouteClasses(loads, stops, roster);
  assert.equal(rc.classes['TRACTOR 2'], 'tractor', 'the header wins over the roster');
  assert.equal(rc.sourceByRoute['TRACTOR 2'], 'load_header');
  assert.equal(rc.classes['BOX 1'], 'box');
  assert.equal(rc.classes['ROSTER ONLY'], 'box');
  assert.equal(rc.sourceByRoute['ROSTER ONLY'], 'roster');
  assert.equal('MYSTERY' in rc.classes, false, 'no vehicle typed and no rostered driver = no claim');
  assert.equal(rc.source, 'header+roster');
});

test('a pickup and an appointment route never vote — same electorate as the calibration', () => {
  const roster = { aliasToVehicle: new Map([['T DRIVER', { vehicleType: 'tractor', name: 'T' }]]) };
  const rc = buildRouteClasses([], [
    { loadNbr: 'PU ONLY', driverName: 'T DRIVER', stopType: 'PU' },
    { loadNbr: 'ULINE APPTS', driverName: 'T DRIVER', stopType: 'DO' },
  ], roster);
  assert.deepEqual(rc.classes, {});
  assert.equal(rc.source, 'none');
});

// ── WHAT REACHES A PHONE ─────────────────────────────────────────────────────

const tRow = (over = {}) => ({
  rule: 'trailer_conflict', tier: 'red', scope: 'occurrence', stopNbr: 'A',
  customer: 'ACME', routeKey: 'TRACTOR 2', routeName: 'TRACTOR 2',
  blockers: ['no_tractor_trailer'], blockedVia: 'restriction', routeConflicts: 1, ...over,
});
const hRow = (over = {}) => ({
  rule: 'hours_risk', tier: 'red', scope: 'occurrence', stopNbr: 'H',
  closeMin: 660, lateBy: 40, etaMin: 700, ...over,
});

test('a trailer conflict texts — and is NOT filtered out for having no receiving close', () => {
  // The hours selector requires a finite closeMin. A trailer row has none and never will:
  // it is not a prediction against a clock. Reusing that filter would have dropped every one.
  const picked = selectTextable([tRow(), hRow()]);
  assert.deepEqual(picked.map((r) => r.stopNbr), ['A', 'H']);
});

test('ONE TEXT PER TRACTOR LOAD, not one per box-only stop on it', () => {
  const rows = [
    tRow({ stopNbr: 'A', routeConflicts: 3 }),
    tRow({ stopNbr: 'B', routeConflicts: 3 }),
    tRow({ stopNbr: 'C', routeConflicts: 3 }),
    tRow({ stopNbr: 'D', routeKey: 'TRACTOR 9', routeConflicts: 1 }),
  ];
  const picked = selectTextable(rows);
  assert.deepEqual(picked.map((r) => r.routeKey), ['TRACTOR 2', 'TRACTOR 9'], 'worst route first, one row each');
});

test('ambers and a collapsed summary never text', () => {
  assert.deepEqual(selectTextable([tRow({ tier: 'amber' })]), []);
  assert.deepEqual(selectTextable([tRow({ stopNbr: null, collapsed: 4 })]), []);
});

test('THE COLLAPSE CARRIES R7 FORWARD — routeKey and the count survive the cap', () => {
  // board-flags collapses a rule+tier bucket past its cap into one summary row. Every field a
  // consumer FILTERS on has to survive that projection, and this rule groups by routeKey. The
  // last time a field was dropped here, thirteen reds texted nobody.
  const stops = Array.from({ length: 14 }, (_, i) => stop({
    stopNbr: `S${i}`, matchKey: `c${i}`, routeSeq: i + 1,
    loadNbr: `TRACTOR ${i}`, routeName: `TRACTOR ${i}`,
  }));
  const notes = Object.fromEntries(stops.map((s, i) => [`c${i}`, HARD_NO.acme]));
  const classes = Object.fromEntries(stops.map((s) => [s.loadNbr, 'tractor']));
  const out = run(stops, notes, classes);
  const panel = trailerRows(out);
  assert.equal(panel.length, 1, 'the panel gets one summary line');
  assert.equal(panel[0].collapsed, 14);
  const picked = selectTextable(out.rows, 99, 99);
  assert.equal(picked.length, 14, 'the text path sees through the collapse');
  assert.ok(picked.every((r) => r.routeKey), 'routeKey survived — the per-route grouping depends on it');
  assert.ok(picked.every((r) => Number.isFinite(r.routeConflicts)), 'and the count the text prints survived too');
  assert.ok(picked.every((r) => Array.isArray(r.blockers)), 'and the mark the text quotes');
});

test('neither kind of news can silence the other at the per-sweep cap', () => {
  const trailers = Array.from({ length: 6 }, (_, i) => tRow({ stopNbr: `T${i}`, routeKey: `R${i}`, routeConflicts: 6 - i }));
  const hours = Array.from({ length: 10 }, (_, i) => hRow({ stopNbr: `H${i}`, lateBy: i }));
  const picked = selectTextable([...trailers, ...hours]);
  assert.equal(picked.length, SMS_PER_SWEEP_CAP);
  assert.equal(picked.filter((r) => r.rule === 'trailer_conflict').length, TRAILER_SMS_CAP);
  assert.equal(picked.filter((r) => r.rule === 'hours_risk').length, SMS_PER_SWEEP_CAP - TRAILER_SMS_CAP);
  assert.deepEqual(picked.filter((r) => r.rule === 'hours_risk').map((r) => r.lateBy), [9, 8, 7, 6], 'hours still worst-first');
});

test('an unused reservation backfills — a quiet trailer night still texts eight hours rows', () => {
  const hours = Array.from({ length: 10 }, (_, i) => hRow({ stopNbr: `H${i}`, lateBy: i }));
  assert.equal(selectTextable(hours).length, SMS_PER_SWEEP_CAP);
  // And the reverse: one late stop does not cost the trailer rows their extra room.
  const trailers = Array.from({ length: 6 }, (_, i) => tRow({ stopNbr: `T${i}`, routeKey: `R${i}` }));
  const picked = selectTextable([...trailers, hRow()]);
  assert.equal(picked.filter((r) => r.rule === 'trailer_conflict').length, 6);
  assert.equal(picked.filter((r) => r.rule === 'hours_risk').length, 1);
});

test('the text names the route first, quotes the mark, and counts the rest of the load', () => {
  const t = smsText(tRow({ routeConflicts: 4 }), DATE);
  assert.ok(t.includes(DATE), 'board day named');
  assert.ok(t.startsWith('DDS no-trailer'), t);
  assert.ok(t.includes('TRACTOR 2 runs a tractor-trailer'), t);
  assert.ok(t.includes('ACME is marked No tractor trailer by dispatch'), t);
  assert.ok(t.includes('+3 more stops on this route'), t);
  assert.ok(!t.includes('est '), 'no ETA — this row has no clock and must not print one');
});

test('the box-only paint is described as the paint, and a lone conflict says no "+0 more"', () => {
  const t = smsText(tRow({ blockedVia: 'eligibility', blockers: [] }), DATE);
  assert.ok(t.includes('painted box-truck only by dispatch'), t);
  assert.ok(!t.includes('more stop'), t);
});

test('an hours text is untouched by any of this', () => {
  const t = smsText({ customer: 'AWC INC', routeName: 'KOSTNER', etaMin: 785, closeMin: 660, lateBy: 125 }, DATE);
  assert.ok(t.startsWith('DDS flag'), t);
  assert.ok(t.includes('est 1:05p vs close 11:00a'), t);
});

test('a stop that is BOTH late and on the wrong truck sends BOTH — the claim is per rule', () => {
  const hoursKey = smsClaimPath('davis', DATE, '9001');
  assert.equal(hoursKey, `eta_flag_sms/davis__${DATE}__9001`, 'the hours key is unchanged — tonight\'s claims still count');
  assert.equal(smsClaimPath('davis', DATE, '9001', 'hours_risk'), hoursKey);
  assert.notEqual(smsClaimPath('davis', DATE, 'TRACTOR 2', 'trailer_conflict'), hoursKey);
});

test('a co-driver load name cannot break the claim doc id', () => {
  // "COLIN/DJ 1" — a slash is a path segment in Firestore, not a character. v0.50.8.
  const p = smsClaimPath('davis', DATE, 'COLIN/DJ 1', 'trailer_conflict');
  assert.equal(p.split('/').length, 2, `one collection, one doc id: ${p}`);
  assert.ok(p.endsWith('__trailer'));
});

test('the labels are the dispatcher\'s own dropdown words, deduped, unknowns kept', () => {
  assert.deepEqual(trailerBlockerLabels(['no_tractor_trailer', 'straight_truck_only', 'box_truck_only']),
    ['No tractor trailer', 'Box truck only']);
  assert.deepEqual(trailerBlockerLabels(['mystery_key']), ['mystery_key'], 'a mark nobody can name is still a mark');
  assert.deepEqual(trailerBlockerLabels(null), []);
});

test('the card and the text say the ROUTE NAME; the load number stays the grouping key', () => {
  // routeKeyOf is loadNbr-first because that is the identity every rule groups on. A router
  // reading a phone at 9pm is looking at a board full of names, not load numbers.
  const out = run([stop({ loadNbr: '77421', routeName: 'BEN' })], HARD_NO, { 77421: 'tractor' });
  const r = trailerRows(out)[0];
  assert.equal(r.routeKey, '77421', 'grouped and claimed on the identity');
  assert.match(r.detail, /^BEN is running a tractor-trailer/, r.detail);
  assert.doesNotMatch(r.detail, /77421/);
  assert.match(smsText(r, DATE), /BEN runs a tractor-trailer/);
});

test('END TO END: the real engine feeds the real selector feeds the real text', () => {
  // Every test above holds one seam. This one holds the whole chain, because the seams are
  // where a field quietly stops being carried — which is the only way this feature can fail
  // silently: a board that flags correctly and a phone that never rings.
  const stops = [
    stop({ stopNbr: 'A1', matchKey: 'acme', businessName: 'ACME', loadNbr: 'L1', routeName: 'BEN', routeSeq: 4 }),
    stop({ stopNbr: 'A2', matchKey: 'beta', businessName: 'BETA', loadNbr: 'L1', routeName: 'BEN', routeSeq: 6 }),
    stop({ stopNbr: 'U1', matchKey: 'uline', businessName: 'ULINE ADV', loadNbr: 'L1', routeName: 'BEN', routeSeq: 8 }),
  ];
  const notes = {
    acme: HARD_NO.acme,
    beta: { vehicle_eligibility: 'box_only' },
    uline: { equipment_restrictions: ['uline_straight_truck'], auto_sources: { uline_straight_truck: [{ source: 'orderInstructions' }] } },
  };
  const out = run(stops, notes, { L1: 'tractor' });
  const picked = selectTextable(out.rows);
  assert.equal(picked.length, 1, 'one load, one text — not one per stop, and not one for the advisory');
  const text = smsText(picked[0], DATE);
  assert.equal(
    text,
    `DDS no-trailer ${DATE}: BEN runs a tractor-trailer — ACME is marked No tractor trailer by dispatch. +1 more stop on this route. Move it or swap the truck. Auto-alert, reply to Davis dispatch.`,
  );
  assert.ok(text.length < 320, `two SMS segments at most: ${text.length} chars`);
});

test('A ROUTE THE CLASS MAP DOES NOT COVER IS NAMED, WITH ITS DRIVER — the Evans hole, made visible', () => {
  // BRENT with a hard-coded no-trailer stop, but no class for BRENT in the map. The old
  // behaviour was silence indistinguishable from "checked and fine".
  const out = run(
    [stop({ loadNbr: 'BRENT', routeName: 'BRENT', driverName: 'Brent  Bryd', driverUserName: 'Brent  Bryd' })],
    HARD_NO, { MARCUS: 'tractor' },
  );
  assert.deepEqual(trailerRows(out), [], 'not judged — and that is the honest answer');
  assert.deepEqual(out.skipped.routesNoTruckClass, [{ route: 'BRENT', drivers: ['Brent  Bryd'] }]);
  assert.equal(out.skipped.noTruckClasses, false, 'a map existed; this route was simply not in it');
});

test('a covered route is never listed as unknown, and a driverless one is listed with no name', () => {
  const out = run([
    stop({ stopNbr: 'A', matchKey: 'acme', loadNbr: 'MARCUS', routeName: 'MARCUS', driverName: 'Marcus Young' }),
    stop({ stopNbr: 'B', matchKey: 'beta', loadNbr: 'TRAILER 4', routeName: 'TRAILER 4', driverName: '', driverUserName: '' }),
  ], HARD_NO, { MARCUS: 'tractor' });
  assert.deepEqual(out.skipped.routesNoTruckClass, [{ route: 'TRAILER 4', drivers: [] }]);
});
