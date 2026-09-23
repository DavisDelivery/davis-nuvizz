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

test('A SCANNER-FOUND no_tractor_trailer NOW FLAGS — Chad, 2026-09-21', () => {
  // This test used to assert the opposite, and the assertion was correct until he changed the
  // rule: "It should fire on anything that has this restriction on it as well as the no
  // tractor trailer in address 2." ADVANCED COLOR IMAGING rode TERRANCE, a tractor, wearing
  // exactly this note, and nothing texted. Address 2 is a field Davis types into NuVizz — the
  // mark is only "automatic" in the sense that READING it was.
  const note = {
    equipment_restrictions: ['no_tractor_trailer'],
    auto_sources: { no_tractor_trailer: [{ source: 'addr2', text: 'NO TRACTOR TRAILERS' }] },
  };
  const rows = trailerRows(run([stop()], { acme: note }));
  assert.equal(rows.length, 1, 'the stop Chad found by eye is the stop this now texts about');
  assert.equal(rows[0].blockedVia, 'restriction');
  // And the whole change reverts on one word, on every side at once.
  assert.equal(dispatcherTrailerBlock(note, null, { TRAILER_ALERT_ANY_RESTRICTION: 'off' }).blocked, false);
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

// THE CAPS ARE READ, NEVER RETYPED. These tests were written against 8/4/4 and broke on the
// day Chad moved them to 24/8/8 — not because the reservation arithmetic was wrong, but
// because the fixtures had the old numbers baked in as literals. A cap test that has to be
// edited every time a cap moves is a test that will eventually be edited to go green.
const TRAILERS_OFFERED = TRAILER_SMS_CAP + 2;                        // more than the reservation
const HOURS_OFFERED = SMS_PER_SWEEP_CAP + 2;                         // enough to hit the total

test('neither kind of news can silence the other at the per-sweep cap', () => {
  const trailers = Array.from({ length: TRAILERS_OFFERED }, (_, i) => tRow({
    stopNbr: `T${i}`, routeKey: `R${i}`, routeConflicts: TRAILERS_OFFERED - i,
  }));
  const hours = Array.from({ length: HOURS_OFFERED }, (_, i) => hRow({ stopNbr: `H${i}`, lateBy: i }));
  const picked = selectTextable([...trailers, ...hours]);
  assert.equal(picked.length, SMS_PER_SWEEP_CAP, 'the cap must actually bite for this to mean anything');
  assert.equal(picked.filter((r) => r.rule === 'trailer_conflict').length, TRAILER_SMS_CAP);
  assert.equal(picked.filter((r) => r.rule === 'hours_risk').length, SMS_PER_SWEEP_CAP - TRAILER_SMS_CAP);
  // Worst-first survives the cap: the highest lateBy values, in order, and no arbitrary drop.
  const takenHours = SMS_PER_SWEEP_CAP - TRAILER_SMS_CAP;
  assert.deepEqual(
    picked.filter((r) => r.rule === 'hours_risk').map((r) => r.lateBy),
    Array.from({ length: takenHours }, (_, i) => HOURS_OFFERED - 1 - i),
    'hours still worst-first',
  );
});

test('an unused reservation backfills — a quiet trailer night still texts the full cap of hours rows', () => {
  const hours = Array.from({ length: HOURS_OFFERED }, (_, i) => hRow({ stopNbr: `H${i}`, lateBy: i }));
  assert.equal(selectTextable(hours).length, SMS_PER_SWEEP_CAP);
  // And the reverse: one late stop does not cost the trailer rows their extra room.
  const trailers = Array.from({ length: TRAILERS_OFFERED }, (_, i) => tRow({ stopNbr: `T${i}`, routeKey: `R${i}` }));
  const picked = selectTextable([...trailers, hRow()]);
  assert.equal(picked.filter((r) => r.rule === 'trailer_conflict').length, TRAILERS_OFFERED);
  assert.equal(picked.filter((r) => r.rule === 'hours_risk').length, 1);
});

test('THE CAPS CHAD ASKED FOR, pinned by value so a silent edit cannot lower them', () => {
  // Chad, 2026-09-22: "BUMP UP TO 24 PER SWEEP TRAILER AND BOX CAP TO 8 EACH."
  assert.equal(SMS_PER_SWEEP_CAP, 24);
  assert.equal(TRAILER_SMS_CAP, 8);
  // The two reservations must fit inside the total with room left for hours rows, or a bad
  // trailer night silences every late stop — the failure the reservation exists to prevent.
  assert.ok(TRAILER_SMS_CAP * 2 < SMS_PER_SWEEP_CAP, 'reservations must leave room for hours');
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
    // The separator is a HYPHEN, not an em dash: an em dash is outside GSM-7 and forced the
    // whole message to UCS-2 (70 chars a segment instead of 160). Measured across 15 nights of
    // real rows, that one character was costing 2.55 segments on every hours text and 3.59 on
    // every trailer text. See the note in flag-sms.mts.
    //
    // THE PRO RIDES IT SINCE 2026-09-22. Chad: "on these messages, I would like the pro number
    // to be up there." It is GSM-7 and it is what the reader types next; the length assertion
    // below is what stops it quietly buying a third segment.
    `DDS no-trailer ${DATE}: BEN runs a tractor-trailer - ACME (PRO A1) is marked No tractor trailer by dispatch. +1 more stop on this route. Move it or swap the truck. Auto-alert, reply to Davis dispatch.`,
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

// ── THE ICON MOVED; THE 9PM TEXT DID NOT ────────────────────────────────────
//
// v0.96.0 made a Davis-typed Address 2 mark CONFIRMED, because the map's question is "is this
// restriction real". The overnight text asks a narrower one, and Chad scoped it by hand in
// v0.82.0: "stops we have put on a tractor that have been hardcoded as no tractor trailer by a
// dispatcher. Not the Uline advisory ones that we pick up automatically just the dispatcher
// hardcoded ones." Widening who gets woken at 9pm is his call, so these pin that the icon fix
// did not quietly make it for him.
import { dispatcherOwnsRestriction, dispatcherOwnedBlockerKeys, trailerAlertAnyRestriction } from '../src/lib/trailer-block.js';
import { restrictionConfidence } from '../src/lib/map-legend.js';

// CHAD MADE THAT CALL ON 2026-09-21. ADVANCED COLOR IMAGING rode TERRANCE — a tractor — with
// a hard "No tractor trailer" on the card, and no text was sent: "It should fire on anything
// that has this restriction on it as well as the no tractor trailer in address 2."
// So the Address 2 case now fires, and TRAILER_ALERT_ANY_RESTRICTION=off is the way back.
const OFF = { TRAILER_ALERT_ANY_RESTRICTION: 'off' };

test('THE STOP THAT WENT UNTEXTED: an Address 2 mark now fires, and off puts it back', () => {
  // The note exactly as Firestore holds it for ADVANCED COLOR IMAGING, read 2026-09-21.
  const note = { equipment_restrictions: ['no_tractor_trailer'], auto_sources: { no_tractor_trailer: ['addressLine2'] } };
  assert.equal(restrictionConfidence(note, 'no_tractor_trailer'), 'confirmed', 'the disc fills solid');
  assert.equal(dispatcherOwnsRestriction(note, 'no_tractor_trailer'), false, 'nobody here ticked the list');
  assert.equal(dispatcherTrailerBlock(note).blocked, true, 'and it texts anyway now — Chad 2026-09-21');
  assert.equal(dispatcherTrailerBlock(note).via, 'restriction');
  assert.equal(dispatcherTrailerBlock(note, null, OFF).blocked, false, 'off restores the old scoping');
});

test('ticking the list turns the text on, on either setting', () => {
  const note = {
    equipment_restrictions: ['no_tractor_trailer'],
    auto_sources: { no_tractor_trailer: ['addressLine2'] },
    manual_overrides: { equipment_restrictions: true },
  };
  assert.equal(dispatcherOwnsRestriction(note, 'no_tractor_trailer'), true);
  assert.equal(dispatcherTrailerBlock(note).blocked, true);
  assert.equal(dispatcherTrailerBlock(note, null, OFF).blocked, true, 'the narrow rule always took this one');
});

test('a hand-added blocker with no scanner trail still texts — unknown means a person put it there', () => {
  const note = { equipment_restrictions: ['no_53ft'] };
  assert.deepEqual(dispatcherOwnedBlockerKeys(note, note.equipment_restrictions), ['no_53ft']);
  assert.equal(dispatcherTrailerBlock(note).blocked, true);
  assert.equal(dispatcherTrailerBlock(note, null, OFF).blocked, true);
});

test('ULINE NEVER TEXTS, on either setting — the one exclusion Chad kept', () => {
  const note = { equipment_restrictions: ['uline_straight_truck'], auto_sources: { uline_straight_truck: ['orderInstructions'] } };
  assert.equal(dispatcherOwnsRestriction(note, 'uline_straight_truck'), false);
  assert.equal(restrictionConfidence(note, 'uline_straight_truck'), 'advisory');
  assert.equal(dispatcherTrailerBlock(note).blocked, false, 'widening must not reach somebody else’s order text');
  assert.equal(dispatcherTrailerBlock(note, null, OFF).blocked, false);
  // All four Uline marks measured across 763 real docks keep their own key, so this is the
  // whole of what the widening excludes — checked on the data, not assumed.
  assert.deepEqual(dispatcherOwnedBlockerKeys(note, note.equipment_restrictions), []);
});

test('a dispatcher’s own “a 53 DOES fit” still beats the restriction, on either setting', () => {
  const note = {
    vehicle_eligibility: 'tractor',
    equipment_restrictions: ['no_tractor_trailer'],
    auto_sources: { no_tractor_trailer: ['addressLine2'] },
  };
  assert.equal(dispatcherTrailerBlock(note).blocked, false, 'never tell a dispatcher off for answering the question');
  assert.equal(dispatcherTrailerBlock(note, null, OFF).blocked, false);
});

test('the switch is house shape: default on, off-words off, MALFORMED LEAVES IT ON', () => {
  const addr2 = { equipment_restrictions: ['no_tractor_trailer'], auto_sources: { no_tractor_trailer: ['addressLine2'] } };
  assert.equal(trailerAlertAnyRestriction({}), true, 'unset = on');
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) {
    assert.equal(trailerAlertAnyRestriction({ TRAILER_ALERT_ANY_RESTRICTION: v }), false, `${v} turns it off`);
  }
  for (const v of ['offf', 'nope', 'true', 'yes', '1', 'banana']) {
    assert.equal(trailerAlertAnyRestriction({ TRAILER_ALERT_ANY_RESTRICTION: v }), true, `${v} must NOT silence the alert`);
  }
  // The client half of the same switch — a VITE_ build flag, so both sides revert together.
  assert.equal(trailerAlertAnyRestriction({ VITE_TRAILER_ALERT_ANY_RESTRICTION: 'off' }), false);
  assert.equal(dispatcherTrailerBlock(addr2, null, { VITE_TRAILER_ALERT_ANY_RESTRICTION: 'off' }).blocked, false);
});

// ── ONE DOCK, ONE CARD ──────────────────────────────────────────────────────
//
// Chad, looking at the flags panel: "this Jewel Reign is showing up twice and should only be
// there one time."
//
// A pickup and a delivery at one dock are two orders and ONE place — the fact v0.99.4 had to
// teach the grab, arriving here from the other side. This rule pushed a row per STOP, so two
// orders at one address produced two byte-identical cards.
//
// The duplicate was the visible half. The expensive half was the count: "N other stops carry
// the same mark — check the truck, not just the stop" counted the twin as another stop, and
// that sentence only means anything when genuinely different places are blocked. It rides the
// SMS too ("+N more stops on this route").

const dock = (over = {}) => stop({
  businessName: 'JEWEL REIGN', addr1: '905 MAIN ST', city: 'LAWRENCEVILLE', zip: '30046',
  matchKey: 'jewel_reign', loadNbr: 'DENIS SALKIC', routeName: 'DENIS SALKIC', routeSeq: 2,
  ...over,
});
const NO_TRAILER = { equipment_restrictions: ['no_tractor_trailer'], manual_overrides: { equipment_restrictions: true } };
const runDock = (stops) => trailerRows(run(stops, { jewel_reign: NO_TRAILER, other_co: NO_TRAILER },
  { 'DENIS SALKIC': 'tractor' }));

test('a pickup and a delivery at ONE dock make ONE card, not two', () => {
  const rows = runDock([dock({ stopNbr: 'D1', stopType: 'DO' }), dock({ stopNbr: 'P1', stopType: 'PU' })]);
  assert.equal(rows.length, 1, `two orders at one dock produced ${rows.length} cards`);
  assert.equal(rows[0].ordersHere, 2);
  assert.deepEqual(rows[0].stopNbrs, ['D1', 'P1'], 'and it still knows both orders');
});

test('…and the card SAYS it covers both — a silent merge is the other-direction bug', () => {
  const [r] = runDock([dock({ stopNbr: 'D1', stopType: 'DO' }), dock({ stopNbr: 'P1', stopType: 'PU' })]);
  assert.match(r.detail, /2 orders at this stop \(D1, P1\)/);
  assert.match(r.detail, /one dock, so this is one move/);
});

test('one dock never claims other stops carry the same mark', () => {
  // The sentence that sent a dispatcher to doubt the whole truck over a single address.
  const [r] = runDock([dock({ stopNbr: 'D1', stopType: 'DO' }), dock({ stopNbr: 'P1', stopType: 'PU' })]);
  assert.equal(r.routeConflicts, 1, 'the count is DOCKS, and there is one dock');
  assert.doesNotMatch(r.detail, /other stop/);
  assert.doesNotMatch(r.detail, /check the truck/);
});

test('but two DIFFERENT docks on one route still both flag, and still say "check the truck"', () => {
  // The merge must not swallow the case the count exists for: several places blocked on one
  // load is "the wrong truck is on this route", and that is the whole value of the rule.
  const rows = runDock([
    dock({ stopNbr: 'D1' }),
    dock({ stopNbr: 'X1', businessName: 'OTHER CO', addr1: '12 FAR RD', zip: '30518', matchKey: 'other_co', routeSeq: 5 }),
  ]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.routeConflicts, 2);
    assert.match(r.detail, /1 other stop on DENIS SALKIC carries the same mark/);
  }
});

test('a different SUITE at one street address is a different dock, and flags separately', () => {
  // STE 200 and STE 400 are two stops a driver walks between — the same rule normalizePlaceKey
  // was written to respect for the grab.
  const rows = runDock([
    dock({ stopNbr: 'S2', addr1: '905 MAIN ST STE 200' }),
    dock({ stopNbr: 'S4', addr1: '905 MAIN ST STE 400' }),
  ]);
  assert.equal(rows.length, 2, 'two suites must not be merged into one dock');
});

test('the dismiss identity is the DOCK, so waving the card off keeps it off', () => {
  // Fingerprinted on the stop, the merged card inherited one constituent's identity: dismiss
  // it and it returns on the next rebuild under the other order's key.
  const [r] = runDock([dock({ stopNbr: 'D1', stopType: 'DO' }), dock({ stopNbr: 'P1', stopType: 'PU' })]);
  assert.doesNotMatch(r.fingerprint, /D1|P1/, `fingerprint still keyed on a stop: ${r.fingerprint}`);
  assert.match(r.fingerprint, /905_main_st__30046/);
});

test('order within a dock is deterministic — the dismiss key must not move under a dispatcher', () => {
  const a = runDock([dock({ stopNbr: 'P1', stopType: 'PU' }), dock({ stopNbr: 'D1', stopType: 'DO' })]);
  const b = runDock([dock({ stopNbr: 'D1', stopType: 'DO' }), dock({ stopNbr: 'P1', stopType: 'PU' })]);
  assert.deepEqual(a[0].stopNbrs, b[0].stopNbrs);
  assert.equal(a[0].dismissKey, b[0].dismissKey);
});

// ── R7b: A SCHOOL, A CHURCH OR A COURTHOUSE ON A TRACTOR ─────────────────────
//
// A school car line at 3pm, a church lot and a courthouse are not places a 53' trailer turns
// around in. A dispatcher can now say what kind of place a customer is (Building type on the
// customer's notes), and Chad is trialling Shiplify's location data, which says it too. A stop
// wearing school, church or government counts as NO TRACTOR TRAILER — but it is not an
// equipment restriction: no icon, nothing written into equipment_restrictions, and it never
// texts, emails or reaches flag history. It is a card on the board for the router to look at.
//
// The failure it prevents is R7's: a driver who cannot turn into the lot leaves with the
// pallets still on the trailer. The failure it must NOT cause is crying wolf at a school a
// tractor serves every week — hence the lifts, and hence "not loaded" never reading as "not seen".
import { resolvePlaceMark, tractorSeenAt, tractorPlaceKeys, placeNoTractorReason } from '../src/lib/place-mark.js';
import { normalizeMatchKey } from '../src/lib/matchKey.js';
import { drawnRestrictionKeys } from '../src/lib/map-legend.js';
import { selectAlertable } from '../netlify/functions/lib/flag-alert.mts';
import { mergeSweep } from '../netlify/functions/lib/flag-history.mts';
import { flattenForConsumers } from '../netlify/functions/lib/flag-rows.mts';
import { readPlaceLift, placeRunFields, PLACE_LIFT_READ_CAP } from '../netlify/functions/lib/place-lift.mts';
import { tractorLocPath } from '../netlify/functions/lib/tractor-flags.mts';
import { heldReason } from '../netlify/functions/eta-flag-check.mts';

const runP = (stops, notesObj = {}, placeMarks = undefined, routeClasses = { 'TRACTOR 2': 'tractor', 'BOX 1': 'box' }) =>
  computeBoardFlags({
    stops, notes: new Map(Object.entries(notesObj)), rosterRows: [],
    servedDate: DATE, dayKey: 'tue',
    opts: {
      depot: DEPOT, departMin: 8 * 60,
      travel: { legs: {}, ...(routeClasses ? { routeClasses } : {}) },
      ...(placeMarks !== undefined ? { placeMarks } : {}),
    },
  });
const placeRows = (out) => out.rows.filter((r) => r.rule === 'place_trailer_conflict');
const shiplifyRec = (types, over = {}) => ({ match_key: 'acme', place_key: '', location_types: types, tariff_items: [], ...over });
// The caller shape the board uses: its switch, its per-stop Shiplify lookup, and its tractor map.
const withShiplify = (rec, over = {}) => ({ shiplifyOn: true, shiplifyOf: () => rec, tractorSeenOf: () => false, tractorKnown: true, ...over });

test('A SCHOOL ON A TRACTOR-TRAILER ROUTE FLAGS RED, with its own reason and the dispatcher named', () => {
  const out = runP([stop({ businessName: 'LINCOLN ELEMENTARY' })], { acme: { building_type: 'school' } });
  const rows = placeRows(out);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.tier, 'red');
  assert.equal(r.placeMark, 'school');
  assert.equal(r.placeSource, 'dispatcher');
  assert.equal(r.routeClass, 'tractor');
  assert.equal(r.routeKey, 'TRACTOR 2');
  assert.equal(r.scope, 'occurrence');
  assert.equal(r.title, 'School on a tractor-trailer — LINCOLN ELEMENTARY', 'its own title, never R7\'s "No tractor trailer — …"');
  assert.ok(r.detail.startsWith('TRACTOR 2 is running a tractor-trailer, but this stop is a school (set by dispatch).'), r.detail);
  assert.ok(r.detail.includes('School: no tractor trailer unless Vehicle is Tractor-trailer OK.'), r.detail);
  assert.ok(r.detail.includes('Stop 3 on the route.'), r.detail);
  assert.ok(r.detail.endsWith('Move it to a box truck, or set Vehicle to Tractor-trailer OK if a trailer fits.'), r.detail);
  assert.deepEqual(r.stopNbrs, ['1001']);
  assert.equal(r.ordersHere, 1);
  assert.equal(r.seq, 3);
  assert.equal(out.redCount, 1, 'it counts on the red chip like R7');
  assert.equal(out.checked.placeConflicts, 1);
  assert.deepEqual(trailerRows(out), [], 'it is its own rule, not a trailer_conflict in disguise');
});

test('a CHURCH and a GOVERNMENT building flag too, each with its own reason text', () => {
  for (const [bt, label, noun, title] of [
    ['church', 'Church', 'church', 'Church on a tractor-trailer — ACME'],
    // A noun, not the pin's label: "this stop is a Government" is not a sentence.
    ['government', 'Government', 'government building', 'Government building on a tractor-trailer — ACME'],
  ]) {
    const [r] = placeRows(runP([stop()], { acme: { building_type: bt } }));
    assert.ok(r, `${bt} must flag on a tractor`);
    assert.equal(r.placeMark, bt);
    assert.equal(r.title, title);
    assert.equal(placeNoTractorReason(bt), `${label}: no tractor trailer unless Vehicle is Tractor-trailer OK`);
    assert.ok(r.detail.includes(`this stop is a ${noun} (set by dispatch).`), r.detail);
    assert.ok(r.detail.includes(`${placeNoTractorReason(bt)}.`), r.detail);
  }
});

test('the same school on a BOX-TRUCK route is exactly what it should be on — no card', () => {
  const out = runP([stop({ loadNbr: 'BOX 1', routeName: 'BOX 1' })], { acme: { building_type: 'school' } });
  assert.deepEqual(placeRows(out), []);
  assert.equal(out.checked.placeConflicts, 0);
});

test('a school on a route NOBODY HAS CLASSED is not judged — and says so, never "clean"', () => {
  const out = runP([stop({ loadNbr: 'BRENT', routeName: 'BRENT', driverName: 'Brent  Bryd' })],
    { acme: { building_type: 'school' } }, undefined, { MARCUS: 'tractor' });
  assert.deepEqual(placeRows(out), [], 'not knowing the truck is not knowing it is a tractor');
  assert.deepEqual(out.skipped.routesNoTruckClass, [{ route: 'BRENT', drivers: ['Brent  Bryd'] }]);
  const none = runP([stop()], { acme: { building_type: 'school' } }, undefined, null);
  assert.deepEqual(placeRows(none), []);
  assert.equal(none.skipped.noTruckClasses, true, 'no class map at all is reported as not checked');
});

test('a dispatcher who set Vehicle to "Tractor-trailer OK" lifts it — never told off for answering the question', () => {
  const out = runP([stop()], { acme: { building_type: 'church', vehicle_eligibility: 'tractor' } });
  assert.deepEqual(placeRows(out), []);
  assert.deepEqual(out.placeLiftWanted, [], 'and no tractor record is even asked for');
});

test('A TRACTOR HAS ALREADY DELIVERED HERE (by match key) — the rule stands down', () => {
  const tractorMap = new Map([['acme', { first: '2026-03-02' }]]);
  const seenOf = (s) => tractorSeenAt(s, tractorMap, tractorPlaceKeys(tractorMap)).any;
  const out = runP([stop()], { acme: { building_type: 'school' } }, { tractorSeenOf: seenOf, tractorKnown: true });
  assert.deepEqual(placeRows(out), []);
  assert.equal(out.checked.placeLift, 'tractor_seen');
});

test('…and BY STREET + ZIP under another customer name — the caller decides, the engine obeys', () => {
  // A tractor delivered to "GWINNETT COUNTY SCHOOLS" at 905 Main St; today's order is booked
  // as "LINCOLN ELEMENTARY" at the same building. Different match key, same lot.
  const addr = { addr1: '905 MAIN ST', city: 'LAWRENCEVILLE', zip: '30046' };
  const key = normalizeMatchKey('LINCOLN ELEMENTARY', addr.addr1, addr.city, addr.zip);
  const school = stop({ businessName: 'LINCOLN ELEMENTARY', ...addr, matchKey: key });
  const tractorMap = new Map([[normalizeMatchKey('GWINNETT COUNTY SCHOOLS', addr.addr1, addr.city, addr.zip), { first: '2026-01-05' }]]);
  const seen = tractorSeenAt(school, tractorMap, tractorPlaceKeys(tractorMap));
  assert.equal(seen.byKey, false, 'the fixture must exercise the street + ZIP path, not the key path');
  assert.equal(seen.byPlace, true);
  const notes = { [key]: { building_type: 'school' } };
  assert.equal(placeRows(runP([school], notes)).length, 1, 'without the lift it flags');
  const lifted = runP([school], notes, { tractorSeenOf: (s) => tractorSeenAt(s, tractorMap, tractorPlaceKeys(tractorMap)).any, tractorKnown: true });
  assert.deepEqual(placeRows(lifted), [], 'with it, it does not');
});

test('RESIDENTIAL NEVER FLAGS — a house is a place mark, not a truck rule', () => {
  assert.deepEqual(placeRows(runP([stop()], { acme: { building_type: 'residential' } })), []);
  // Nor a Shiplify residential, switch on.
  const res = shiplifyRec([], { tariff_items: ['RES'] });
  assert.equal(resolvePlaceMark({ shiplify: res, shiplifyOn: true }).mark, 'residential', 'the fixture really is residential');
  assert.deepEqual(placeRows(runP([stop()], {}, withShiplify(res))), []);
});

test('A SHIPLIFY SCHOOL FLAGS ONLY WHILE THE CALLER\'S SWITCH IS ON', () => {
  const rec = shiplifyRec(['School']);
  const on = placeRows(runP([stop()], {}, withShiplify(rec)));
  assert.equal(on.length, 1);
  assert.equal(on[0].placeSource, 'shiplify');
  assert.ok(on[0].detail.includes('this stop is a school (from Shiplify).'), on[0].detail);
  assert.deepEqual(placeRows(runP([stop()], {}, withShiplify(rec, { shiplifyOn: false }))), [], 'switch off');
  assert.deepEqual(placeRows(runP([stop()], {}, withShiplify(rec, { shiplifyOn: undefined }))), [],
    'a caller that did not SAY the trial is on does not get it — only an explicit true counts');
  assert.deepEqual(placeRows(runP([stop()], {})), [], 'no placeMarks at all (a server sweep): never Shiplify');
});

test('the board\'s own { rec, via } lookup shape is read, not silently treated as "no record"', () => {
  const rec = shiplifyRec(['Courthouse']);
  const rows = placeRows(runP([stop()], {}, withShiplify(null, { shiplifyOf: () => ({ rec, via: 'place' }) })));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].placeMark, 'government');
});

test('A DISPATCHER\'S BUILDING TYPE ALWAYS COUNTS — switch off, and with no placeMarks at all', () => {
  const notes = { acme: { building_type: 'government' } };
  assert.equal(placeRows(runP([stop()], notes, { shiplifyOn: false, tractorSeenOf: () => false, tractorKnown: true })).length, 1);
  const serverShape = runP([stop()], notes);
  assert.equal(placeRows(serverShape).length, 1, 'absent placeMarks: dispatcher types still judged');
  assert.equal(serverShape.checked.placeLift, 'none', 'and the reader can see no tractor lift was applied');
  assert.deepEqual(serverShape.placeLiftWanted, ['acme'], 'while naming the key a lift would need');
});

test('"None" HIDES A SHIPLIFY SCHOOL — the dispatcher wins in both directions', () => {
  const out = runP([stop()], { acme: { building_type: 'none' } }, withShiplify(shiplifyRec(['School'])));
  assert.deepEqual(placeRows(out), []);
});

test('NOT LOADED IS NOT "NOT SEEN": tractorKnown false holds every row and says why', () => {
  const out = runP([stop()], { acme: { building_type: 'school' } }, { tractorSeenOf: () => false, tractorKnown: false });
  assert.deepEqual(placeRows(out), [], 'a lift nobody can evaluate would cry wolf on a school a tractor serves weekly');
  assert.equal(out.skipped.placeTractorUnknown, true);
  assert.equal(out.checked.placeLift, 'not_checked');
  const loaded = runP([stop()], { acme: { building_type: 'school' } }, { tractorSeenOf: () => false, tractorKnown: true });
  assert.equal(placeRows(loaded).length, 1, 'the moment the record is known, the card appears');
  assert.equal(loaded.skipped.placeTractorUnknown, false);
});

test('a tractor lookup that THROWS holds that stop and is counted — it does not take the board down', () => {
  const out = runP([stop()], { acme: { building_type: 'school' } }, { tractorSeenOf: () => { throw new Error('boom'); }, tractorKnown: true });
  assert.deepEqual(placeRows(out), []);
  assert.equal(out.skipped.placeLookupErrors, 1);
});

test('A BUILDING TYPE IS NOT AN EQUIPMENT RESTRICTION — no icon, nothing written, R7 untouched', () => {
  const note = { building_type: 'school' };
  const before = structuredClone(note);
  const out = runP([stop()], { acme: note });
  assert.equal(placeRows(out).length, 1);
  assert.deepEqual(note, before, 'the engine only READS the note — equipment_restrictions never appears');
  assert.equal('equipment_restrictions' in note, false);
  assert.deepEqual(drawnRestrictionKeys(note.equipment_restrictions), [], 'so the map draws no restriction icon');
  assert.equal(dispatcherTrailerBlock(note).blocked, false, 'and the dispatcher-block function R7 and the map read is unmoved');
  assert.equal(tractorPaintAllowed(note.vehicle_eligibility ?? null, [], note), true, 'lime paint still allowed');
  // R7 on the SAME board reads exactly as it would with no school on it.
  const board = [
    stop({ stopNbr: 'H1', matchKey: 'hard', businessName: 'HARD NO CO', routeSeq: 1 }),
    stop({ stopNbr: 'S1', matchKey: 'acme', businessName: 'LINCOLN ELEMENTARY', routeSeq: 2 }),
  ];
  const withSchool = runP(board, { hard: HARD_NO.acme, acme: { building_type: 'school' } });
  const without = runP(board, { hard: HARD_NO.acme });
  assert.deepEqual(trailerRows(withSchool), trailerRows(without), 'R7 cards byte-identical');
  assert.equal(withSchool.checked.trailerConflicts, without.checked.trailerConflicts);
});

test('PICKUPS COUNT — a turning radius does not care which way the pallets go', () => {
  assert.equal(placeRows(runP([stop({ stopType: 'PU', routeSeq: null })], { acme: { building_type: 'church' } })).length, 1);
});

const schoolDock = (over = {}) => stop({
  businessName: 'LINCOLN ELEMENTARY', addr1: '905 MAIN ST', city: 'LAWRENCEVILLE', zip: '30046',
  matchKey: 'lincoln', routeSeq: 2, ...over,
});

test('ONE DOCK, ONE CARD: a pickup and a delivery at one school make one card that names both', () => {
  const rows = placeRows(runP(
    [schoolDock({ stopNbr: 'P1', stopType: 'PU' }), schoolDock({ stopNbr: 'D1', stopType: 'DO' })],
    { lincoln: { building_type: 'school' } },
  ));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].stopNbrs, ['D1', 'P1'], 'deterministic order, both orders kept');
  assert.equal(rows[0].ordersHere, 2);
  assert.equal(rows[0].routeConflicts, 1, 'one dock is one conflict');
  assert.match(rows[0].detail, /2 orders at this stop \(D1, P1\) — one dock, so this is one move/);
  assert.doesNotMatch(rows[0].detail, /other stop/);
  assert.equal(rows[0].fingerprint, `place|${DATE}|TRACTOR 2|905_main_st__30046`, 'keyed on the dock, not a stop');
});

test('two different schools on one tractor say "check the truck" — that is the wrong truck', () => {
  const rows = placeRows(runP([
    schoolDock({ stopNbr: 'S1' }),
    schoolDock({ stopNbr: 'C1', businessName: 'GRACE CHURCH', addr1: '12 FAR RD', zip: '30518', matchKey: 'grace', routeSeq: 5 }),
  ], { lincoln: { building_type: 'school' }, grace: { building_type: 'church' } }));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.routeConflicts, 2);
    assert.match(r.detail, /1 other stop on TRACTOR 2 is also a school, church or government stop — check the truck, not just the stop\./);
  }
});

test('A DOCK THAT ALREADY CARRIES THE DISPATCHER\'S OWN "NO TRACTOR TRAILER" GETS NO SECOND CARD', () => {
  // The same school, hard-marked by dispatch AND typed as a school: R7 is the stronger
  // statement about the same single move, and two red cards for one dock is the Jewel Reign
  // duplicate again.
  const out = runP([schoolDock({ stopNbr: 'S1' })], {
    lincoln: { building_type: 'school', ...HARD_NO.acme },
  });
  assert.equal(trailerRows(out).length, 1, 'the dispatcher\'s card stands');
  assert.deepEqual(placeRows(out), [], 'no duplicate');
  assert.equal(out.checked.placeInTrailerCard, 1, 'and the fold is counted, not silent');
  // …including when the hard mark is on ANOTHER customer at the same street + ZIP.
  const twoNames = runP([
    schoolDock({ stopNbr: 'S1' }),
    schoolDock({ stopNbr: 'X1', businessName: 'DISTRICT OFFICE', matchKey: 'district' }),
  ], { lincoln: { building_type: 'school' }, district: HARD_NO.acme });
  assert.equal(trailerRows(twoNames).length, 1);
  assert.deepEqual(placeRows(twoNames), []);
  assert.deepEqual(twoNames.placeLiftWanted, [], 'and nobody reads a tractor doc for a card that cannot appear');
});

// ── IT NEVER TEXTS, EMAILS OR REACHES FLAG HISTORY ───────────────────────────

test('the text, email and history selectors pick NOTHING from a building-type row', () => {
  const out = runP([stop()], { acme: { building_type: 'school' } });
  const place = placeRows(out);
  assert.equal(place.length, 1);
  assert.ok(place[0].stopNbr && place[0].tier === 'red' && place[0].scope === 'occurrence',
    'it has the stop number, tier and scope the text selector filters on — only its rule keeps it out of the texts');
  assert.deepEqual(selectTextable(place, 99, 99, 99), [], 'no 9pm text');
  assert.deepEqual(selectAlertable(place, 600), [], 'no customer-service email');
  assert.deepEqual(selectAlertable(place, null), [], 'with or without a clock');
  const hist = mergeSweep(null, place, { nowMin: 600, atISO: '2026-09-01T14:00:00Z' });
  assert.equal(hist.added, 0);
  assert.deepEqual(hist.rows, {}, 'not recorded in flag history');
  assert.ok(!selectTextable(out.rows, 99, 99, 99).some((r) => r.rule === 'place_trailer_conflict'));
});

test('…AND AFTER THE CAP COLLAPSES THEM: the summary carries placeMark/placeSource, and still texts nobody', () => {
  const stops = Array.from({ length: 14 }, (_, i) => stop({
    stopNbr: `S${i}`, matchKey: `c${i}`, routeSeq: i + 1, loadNbr: `TRACTOR ${i}`, routeName: `TRACTOR ${i}`,
  }));
  const notes = Object.fromEntries(stops.map((s, i) => [`c${i}`, { building_type: 'school' }]));
  const classes = Object.fromEntries(stops.map((s) => [s.loadNbr, 'tractor']));
  const out = runP(stops, notes, undefined, classes);
  const panel = placeRows(out);
  assert.equal(panel.length, 1, 'one summary line on the panel');
  assert.equal(panel[0].collapsed, 14);
  assert.equal(panel[0].title, '14 stops: School, church or government on a tractor-trailer',
    'the summary names the rule — never R7\'s "N stops: No tractor trailer"');
  assert.equal(out.checked.placeConflicts, 14, 'the count is the docks, not the summary');
  const flat = flattenForConsumers(out.rows).filter((r) => r.rule === 'place_trailer_conflict');
  assert.equal(flat.length, 14);
  assert.ok(flat.every((r) => r.placeMark === 'school' && r.placeSource === 'dispatcher'), 'survived the projection');
  assert.ok(flat.every((r) => r.scope === 'occurrence' && r.routeKey), 'as did the filter inputs');
  assert.deepEqual(selectTextable(panel, 99, 99, 99), []);
  assert.deepEqual(selectAlertable(panel, 600), []);
  assert.equal(mergeSweep(null, panel, { nowMin: 600, atISO: '2026-09-01T14:00:00Z' }).added, 0);
});

test('the dry run names the channel: in-app only, never texted', () => {
  const [r] = placeRows(runP([stop()], { acme: { building_type: 'school' } }));
  assert.equal(heldReason(r, false, 600), 'building-type conflict — in-app only, never texted');
});

// ── WHAT THE SWEEPS READ, AND WHAT THEY RECORD ───────────────────────────────

const fakeReader = (docs) => {
  const reads = [];
  return { reads, readDoc: async (p) => { reads.push(p); if (docs.throws?.has(p)) throw new Error('read failed'); return docs.map.get(p) ?? null; } };
};

test('THE SERVER LIFT reads ONLY the tractor docs the first pass named, and the run record counts what is left', async () => {
  // Lincoln (school) and Grace (church) ride TRACTOR 2; a tractor has delivered to Grace.
  // An ordinary stop rides beside them and must cost no read at all.
  const board = [
    schoolDock({ stopNbr: 'S1' }),
    schoolDock({ stopNbr: 'C1', businessName: 'GRACE CHURCH', addr1: '12 FAR RD', zip: '30518', matchKey: 'grace', routeSeq: 5 }),
    stop({ stopNbr: 'O1', matchKey: 'acme', routeSeq: 7 }),
  ];
  const notes = { lincoln: { building_type: 'school' }, grace: { building_type: 'church' } };
  const first = runP(board, notes);
  assert.deepEqual(first.placeLiftWanted, ['grace', 'lincoln']);
  const { reads, readDoc } = fakeReader({ map: new Map([[tractorLocPath('davis', 'grace'), { match_key: 'grace' }]]) });
  const lift = await readPlaceLift(first.placeLiftWanted, readDoc, 'davis');
  assert.deepEqual(reads.sort(), [tractorLocPath('davis', 'grace'), tractorLocPath('davis', 'lincoln')].sort(),
    'two reads, by id, and nothing for the ordinary stop');
  assert.equal(lift.placeMarks.shiplifyOn, false, 'the server never runs the Shiplify trial');
  const final = runP(board, notes, lift.placeMarks);
  assert.deepEqual(placeRows(final).map((r) => r.stopNbr), ['S1'], 'Grace is lifted; Lincoln is not');
  assert.deepEqual(placeRunFields(final, lift), {
    placeConflicts: 1, placeInTrailerCard: 0, placeSources: 'dispatcher_only',
    placeLift: 'match_key', placeLiftWanted: 2, placeLiftRead: 2, placeLiftSeen: 1,
    placeLiftCapped: false, placeLiftErrors: 0,
  });
});

test('a board with no school, church or government on a tractor costs ZERO reads', async () => {
  const first = runP([stop()], {});
  assert.deepEqual(first.placeLiftWanted, []);
  const { reads, readDoc } = fakeReader({ map: new Map() });
  const lift = await readPlaceLift(first.placeLiftWanted, readDoc, 'davis');
  assert.deepEqual(reads, []);
  assert.equal(placeRunFields(runP([stop()], {}, lift.placeMarks), lift).placeConflicts, 0);
});

test('THE READ BOUND IS RECORDED WHEN IT BITES, and a failed read is counted — no silent cap', async () => {
  assert.equal(PLACE_LIFT_READ_CAP, 50);
  const { reads, readDoc } = fakeReader({ map: new Map(), throws: new Set([tractorLocPath('davis', 'a')]) });
  const lift = await readPlaceLift(['c', 'a', 'b', 'a', ''], readDoc, 'davis', 2);
  assert.equal(reads.length, 2, 'the bound held');
  assert.deepEqual(lift.record, {
    placeLift: 'match_key', placeLiftWanted: 3, placeLiftRead: 2, placeLiftSeen: 0,
    placeLiftCapped: true, placeLiftErrors: 1,
  });
  // Without a lift object (the read itself blew up), the record still says what was used.
  assert.equal(placeRunFields(runP([stop()], { acme: { building_type: 'school' } }), null).placeLift, 'none');
});

// ── WHAT THE CARD SAYS, AND WHAT IT SAYS WHEN IT COULD NOT LOOK ──────────────

test('SHIPLIFY NOT LOADED IS SAID, NOT SILENT: shiplifyKnown false judges the dispatcher\'s types only, and says so', () => {
  // The switch is ON and the index is 'loading' or 'error': every Shiplify record reads as
  // null, so a Shiplify school on a tractor cannot raise a card — and a rule that says nothing
  // about that is pixel-identical to a board with no school on a tractor.
  const board = [
    stop({ stopNbr: 'G1', matchKey: 'gov', businessName: 'COUNTY COURTHOUSE', addr1: '1 Court Sq', routeSeq: 1 }),
    stop({ stopNbr: 'S1', matchKey: 'lincoln', businessName: 'LINCOLN ELEMENTARY', addr1: '905 Main St', routeSeq: 2 }),
  ];
  const notes = { gov: { building_type: 'government' } };
  const rec = shiplifyRec(['School']);
  let calls = 0;
  const shiplifyOf = (s) => { calls += 1; return s.matchKey === 'lincoln' ? rec : null; };
  const loading = runP(board, notes, withShiplify(null, { shiplifyOf, shiplifyKnown: false }));
  assert.equal(loading.skipped.placeShiplifyUnknown, true);
  assert.deepEqual(placeRows(loading).map((r) => r.stopNbr), ['G1'], 'the dispatcher\'s own type still flags');
  assert.equal(calls, 0, 'a lookup that cannot answer yet is not asked');
  // Reported even while the tractor record is ALSO missing — two gaps, two words.
  const both = runP(board, notes, withShiplify(null, { shiplifyOf, shiplifyKnown: false, tractorKnown: false }));
  assert.equal(both.skipped.placeShiplifyUnknown, true);
  assert.equal(both.skipped.placeTractorUnknown, true);
  const ready = runP(board, notes, withShiplify(null, { shiplifyOf, shiplifyKnown: true }));
  assert.equal(ready.skipped.placeShiplifyUnknown, false);
  assert.deepEqual(placeRows(ready).map((r) => r.stopNbr).sort(), ['G1', 'S1'], 'loaded, the Shiplify school flags');
  // The switch OFF is not "unknown": the trial was not asked for, so nothing is missing.
  assert.equal(runP(board, notes, withShiplify(null, { shiplifyOf, shiplifyOn: false, shiplifyKnown: false })).skipped.placeShiplifyUnknown, false);
  // A caller that does not pass it keeps exactly what it had.
  const absent = runP(board, notes, withShiplify(null, { shiplifyOf }));
  assert.equal(absent.skipped.placeShiplifyUnknown, false);
  assert.equal(placeRows(absent).length, 2);
});

test('A SHIPLIFY CARD OFFERS "Building type None" — the fix for a wrong type, not a claim that a trailer fits', () => {
  // Shiplify lists a church-run distribution warehouse as 'Place of Worship'. The router knows
  // it is not a church and has never checked whether a 53' fits. "Tractor-trailer OK" would
  // record that it does — and disarm R7 for this customer with it.
  const [shp] = placeRows(runP([stop()], {}, withShiplify(shiplifyRec(['Place of Worship']))));
  assert.equal(shp.placeSource, 'shiplify');
  assert.ok(shp.detail.endsWith(' If Shiplify has the place wrong, set Building type to None.'), shp.detail);
  assert.ok(shp.detail.includes('or set Vehicle to Tractor-trailer OK if a trailer fits.'), 'the trailer-fits answer stays, for when one does');
  // …and None is the right fix: the card goes, and a later hard "no" at the dock still counts,
  // where Tractor-trailer OK would have silenced it.
  assert.deepEqual(placeRows(runP([stop()], { acme: { building_type: 'none' } }, withShiplify(shiplifyRec(['Place of Worship'])))), []);
  assert.equal(dispatcherTrailerBlock({ building_type: 'none', ...HARD_NO.acme }).blocked, true);
  assert.equal(dispatcherTrailerBlock({ vehicle_eligibility: 'tractor', ...HARD_NO.acme }).blocked, false);
  // A dispatcher's own type gets no such line: they set it, and there is nothing to correct.
  const [disp] = placeRows(runP([stop()], { acme: { building_type: 'church' } }));
  assert.doesNotMatch(disp.detail, /Building type to None/);
});

test('R7 AND R7b ARE TOLD APART — a dispatcher\'s hard no and a building type never share a title, one by one or summarised', () => {
  const board = [
    stop({ stopNbr: 'H1', matchKey: 'hard', businessName: 'HARD NO CO', addr1: '2 Elm St', routeSeq: 1 }),
    stop({ stopNbr: 'S1', matchKey: 'lincoln', businessName: 'LINCOLN ELEMENTARY', addr1: '905 Main St', routeSeq: 2 }),
  ];
  const out = runP(board, { hard: HARD_NO.acme, lincoln: { building_type: 'school' } });
  assert.equal(trailerRows(out)[0].title, 'No tractor trailer — HARD NO CO', 'R7 reads as it always has');
  assert.equal(placeRows(out)[0].title, 'School on a tractor-trailer — LINCOLN ELEMENTARY');
  // Past the red cap each rule becomes ONE summary, titled from the words before the dash. A
  // bucket of schools AND churches is summarised by the rule, not by whichever sorted first.
  const stops = [];
  const notes = {};
  const classes = {};
  for (let i = 0; i < 13; i++) {
    const route = `TRACTOR ${i}`;
    classes[route] = 'tractor';
    stops.push(stop({ stopNbr: `H${i}`, matchKey: `h${i}`, addr1: `${i} Hard Rd`, loadNbr: route, routeName: route, routeSeq: 1 }));
    stops.push(stop({ stopNbr: `P${i}`, matchKey: `p${i}`, addr1: `${i} School Rd`, loadNbr: route, routeName: route, routeSeq: 2 }));
    notes[`h${i}`] = HARD_NO.acme;
    notes[`p${i}`] = { building_type: i % 2 ? 'church' : 'school' };
  }
  const big = runP(stops, notes, undefined, classes);
  assert.deepEqual(big.rows.filter((r) => r.collapsed).map((r) => r.title).sort(), [
    '13 stops: No tractor trailer',
    '13 stops: School, church or government on a tractor-trailer',
  ]);
});
