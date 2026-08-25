// test/owner-route-flags.test.mjs
//
// THE OWNER'S OWN ROUTE IS NOT FLAG MATERIAL.
//
// Chad: "I dont' want orders from the Chad route showing up on my flags list."
//
// It is the same judgement that already silenced the appointment holding pens, applied to the
// other route nobody can act on: a flag is a call to action, and he is the one driving that
// truck. A red telling him his own next stop is running late is the board telling him what he
// can see through the windscreen — and it sits on the panel in the place of a stop where a
// dispatcher could still make a phone call.
//
// The freight is NOT hidden. It comes back at the end of the day report (see
// day-completion.test.mjs), and the route is named in the panel footer, because a set-aside
// route that says nothing is indistinguishable from one the engine simply missed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBoardFlags, isOwnerRoute, isSetAsideRoute, isAppointmentRoute, OWNER_ROUTE_NAMES,
} from '../src/lib/board-flags.js';

const stop = (o) => ({ isPlanned: true, status: '20', ...o });
const board = (rows) => computeBoardFlags({ stops: rows, notes: new Map(), dayKey: 'mon' });

// A stop that WOULD flag if anybody judged it. The first version of this test used a bare
// stop with no note, which raises nothing on any route — so it passed whether or not the
// exclusion worked, and a mutation putting the owner's route back into the judged set went
// straight through it. A test that cannot fail is not a test.
const CLOSED_FRI = { 'ies|k': { closed_days: ['fri'], manual_overrides: { closed_days: true } } };
const FRI = { servedDate: '2026-08-21', dayKey: 'fri', opts: { depot: { lat: 34.1, lng: -84.0 }, departMin: 480, nowMin: 11 * 60 + 34 } };
const closedDayStop = (over) => stop({
  stopNbr: '9', businessName: 'IES COMMUNICATIONS', matchKey: 'ies|k',
  addr1: '1 Main', city: 'Buford', lat: 34.10, lng: -84.00, stopType: 'DO', ...over,
});
const runFri = (rows) => computeBoardFlags({
  stops: rows, notes: new Map(Object.entries(CLOSED_FRI)), rosterRows: [], ...FRI,
});

test('THE CONTROL: this stop really does flag on an ordinary route', () => {
  // Without this the test below proves nothing.
  const f = runFri([closedDayStop({ loadNbr: 'BEN 2', routeName: 'BEN 2', routeSeq: 1 })]);
  assert.equal(f.rows.filter((r) => r.rule === 'closed_today').length, 1);
});

test('the owner\'s route raises no flags at all — the SAME stop, moved to CHAD', () => {
  const f = runFri([closedDayStop({ loadNbr: 'CHAD', routeName: 'CHAD', routeSeq: 1 })]);
  assert.deepEqual(f.rows, [], 'no rule may fire on the owner\'s route');
  assert.equal(f.checked.stops, 0, 'and it is not even in the judged set');
});

test('CHADWICK AND CHATTANOOGA STILL GET JUDGED — matched exactly, never as a substring', () => {
  // A board that quietly stops judging a real truck is the precise failure this is meant to
  // avoid, and it is the trap the day report walked into first.
  const f = board([
    stop({ stopNbr: '6', businessName: 'CHADWICK CO', loadNbr: 'CHADWICK', routeName: 'CHADWICK', routeSeq: 1, driverName: 'Tony' }),
    stop({ stopNbr: '7', businessName: 'LOOBOO', loadNbr: 'CHATTANOOGA', routeName: 'CHATTANOOGA', routeSeq: 1, driverName: 'Rich' }),
    stop({ stopNbr: '8', businessName: 'CHAD 2 CO', loadNbr: 'CHAD 2', routeName: 'CHAD 2', routeSeq: 1, driverName: 'Sam' }),
  ]);
  assert.equal(f.checked.stops, 3, 'all three are real routes and all three are judged');
  assert.deepEqual(f.skipped.routesOwner, [], 'none of them is the owner\'s route');
  assert.ok(!isOwnerRoute('CHADWICK'));
  assert.ok(!isOwnerRoute('CHATTANOOGA'));
  assert.ok(!isOwnerRoute('CHAD 2'), 'a second truck under a similar name is a real truck');
  // Derived, never typed — see no-env-value-literals.test.mjs. Writing this route's name in
  // lower case in a source file is what has stopped production deploying twice.
  const messy = `  ${OWNER_ROUTE_NAMES[0].toLowerCase()}  `;
  assert.ok(isOwnerRoute(messy), 'case and padding do not let it back in');
});

test('THE SILENCE IS REPORTED, and in its own words', () => {
  // Folding it into the appointment list would label it "held for appointments", which is not
  // what happened to it. The footer is how a quiet panel proves it was watched.
  const f = board([
    stop({ stopNbr: '3', loadNbr: 'CHAD', routeName: 'CHAD', routeSeq: 1 }),
    stop({ stopNbr: '5', loadNbr: 'ULINE APPT', routeName: 'ULINE APPT', routeSeq: 1 }),
  ]);
  assert.deepEqual(f.skipped.routesOwner, ['CHAD']);
  assert.deepEqual(f.skipped.routesAppointment, ['ULINE APPT']);
  assert.ok(!f.skipped.routesAppointment.includes('CHAD'), 'not mislabelled as an appointment');
});

test('ONE predicate decides it, so the three set-aside sites cannot disagree', () => {
  // R5's arrival walk, R6's no-driver check and the judged set each drop these routes. They
  // used to test appointment-ness independently; a second rule added to only two of them is
  // how a stop gets judged by one and not another.
  assert.ok(isSetAsideRoute('ULINE APPT'));
  assert.ok(isSetAsideRoute('CHAD'));
  assert.ok(!isSetAsideRoute('BEN 2'));
  assert.ok(isAppointmentRoute('ULINE APPT') && !isOwnerRoute('ULINE APPT'));
  assert.ok(isOwnerRoute('CHAD') && !isAppointmentRoute('CHAD'));
});

test('the shipped list is the one the day report builds on', () => {
  // Two copies of a route name is two things to forget. day-completion.mts imports this and
  // layers DAY_REPORT_EXCLUDE_ROUTES on top; the browser cannot read that env var, so this is
  // the shared floor.
  assert.ok(Array.isArray(OWNER_ROUTE_NAMES) && OWNER_ROUTE_NAMES.length > 0);
  assert.ok(OWNER_ROUTE_NAMES.every((n) => n === n.toUpperCase()), 'stored normalised');
});
