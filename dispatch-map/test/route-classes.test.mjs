// WHICH TRUCK RUNS EACH ROUTE — and what happens when the roster cannot say.
//
// Every name in here is real. Evans Contracting (PRO 7171235, 2026-09-02) sat on BRENT with a
// hard-coded no-tractor-trailer mark and never texted, because NuVizz spells the driver
// "Brent  Bryd" and the roster alias reads "Brent Boyd". The exact join returned nothing, the
// route got no class, and nothing on any screen said so. These tests pin the two answers: a
// one-letter difference resolves when it is unambiguous, and every route that still cannot be
// classed is NAMED with the driver on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteClasses, nearestRosterAlias, nearMatchEnabled, editDistance } from '../netlify/functions/lib/route-classes.mts';
import { buildVehicleRoster } from '../netlify/functions/lib/tractor-flags.mts';

// A slice of the live MarginIQ roster, as stored (fullName / vehicleType / externalIds.nuvizz).
const EMPLOYEES = [
  { fullName: 'Brenton Byrd', vehicleType: 'tractor', externalIds: { nuvizz: 'Brent Boyd' } },
  { fullName: 'Brent Dixon', vehicleType: 'box_truck', externalIds: {} },            // no NuVizz alias
  { fullName: 'Trevor Syers', vehicleType: 'box_truck', externalIds: { nuvizz: 'Trevor Brent' } },
  { fullName: 'Marcus Young', vehicleType: 'tractor', externalIds: { nuvizz: 'Marcus Young' } },
  { fullName: 'Anthony Kostner', vehicleType: 'tractor', externalIds: { nuvizz: 'Anthony Kostner' } },
];
const roster = () => buildVehicleRoster(EMPLOYEES);
const stop = (route, driverName, over = {}) => ({ loadNbr: route, routeName: route, driverName, driverUserName: driverName, stopType: 'DO', ...over });

test('THE EVANS CASE: "Brent  Bryd" resolves to the roster alias "Brent Boyd" and BRENT reads as a tractor', () => {
  const rc = buildRouteClasses([], [stop('BRENT', 'Brent  Bryd')], roster(), { nearMatch: true });
  assert.equal(rc.classes.BRENT, 'tractor');
  assert.equal(rc.sourceByRoute.BRENT, 'roster_near', 'recorded as the near rule, never as an exact join');
  assert.deepEqual(rc.nearMatches, [{ route: 'BRENT', driver: 'Brent  Bryd', alias: 'BRENT BOYD', employee: 'Brenton Byrd', vehicleType: 'tractor' }]);
  assert.deepEqual(rc.unclassed, []);
});

test('with the near-match OFF the same board leaves BRENT unclassed — and SAYS so, with the driver name', () => {
  const rc = buildRouteClasses([], [stop('BRENT', 'Brent  Bryd')], roster(), { nearMatch: false });
  assert.equal('BRENT' in rc.classes, false);
  assert.equal(rc.unclassed.length, 1);
  const u = rc.unclassed[0];
  assert.equal(u.route, 'BRENT');
  assert.deepEqual(u.drivers, ['Brent  Bryd']);
  assert.equal(u.reason, 'not_on_roster');
  assert.match(u.hint, /"BRENT BOYD" \(Brenton Byrd, tractor\)/, 'the hint names the alias to fix');
});

test('an exact match is never downgraded to a near one', () => {
  const rc = buildRouteClasses([], [stop('MARCUS', 'Marcus Young')], roster());
  assert.equal(rc.classes.MARCUS, 'tractor');
  assert.equal(rc.sourceByRoute.MARCUS, 'roster');
  assert.deepEqual(rc.nearMatches, []);
});

test('"Trevor Seyers" does NOT match an alias reading "Trevor Brent" — a wrong alias is reported, not guessed around', () => {
  assert.equal(nearestRosterAlias('Trevor Seyers', roster()), null);
  const rc = buildRouteClasses([], [stop('TREVOR', 'Trevor Seyers')], roster());
  assert.equal('TREVOR' in rc.classes, false);
  assert.match(rc.unclassed[0].hint, /"TREVOR BRENT" \(Trevor Syers, box_truck\)/);
});

test('a rostered employee with NO NuVizz alias is never matched on display name — the hint says which field to fill', () => {
  // tractor-flags.mts: "NEVER the display name". The alias exists because the two differ.
  const rc = buildRouteClasses([], [stop('DIXON', 'Brent Dixon')], roster());
  assert.equal('DIXON' in rc.classes, false, 'no alias, no class');
  assert.equal(rc.unclassed[0].hint, 'roster "Brent Dixon" (box_truck) has no NuVizz alias — add "Brent Dixon"');
});

test('the first name must match exactly; a different first name is not "close"', () => {
  // "Brenton Boyd" vs alias "BRENT BOYD": surname identical, first name differs — refused.
  assert.equal(nearestRosterAlias('Brenton Boyd', roster()), null);
});

test('TWO candidates within one letter is "I do not know", never "pick one"', () => {
  const two = buildVehicleRoster([
    { fullName: 'A', vehicleType: 'tractor', externalIds: { nuvizz: 'Sam Boyd' } },
    { fullName: 'B', vehicleType: 'box_truck', externalIds: { nuvizz: 'Sam Bond' } },
  ]);
  assert.equal(nearestRosterAlias('Sam Byrd', two), null, 'BYRD is one edit from BOYD and from BOND');
  const rc = buildRouteClasses([], [stop('SAM', 'Sam Byrd')], two);
  assert.equal('SAM' in rc.classes, false);
});

test('a short surname cannot near-match — three letters is not enough evidence', () => {
  const r = buildVehicleRoster([{ fullName: 'X', vehicleType: 'tractor', externalIds: { nuvizz: 'Bo Lee' } }]);
  assert.equal(nearestRosterAlias('Bo Lea', r), null);
});

test('the switch reads the env: only an explicit off-word disables it, a malformed value does not', () => {
  assert.equal(nearMatchEnabled({}), true);
  assert.equal(nearMatchEnabled({ ROUTE_CLASS_NEAR_MATCH: 'off' }), false);
  assert.equal(nearMatchEnabled({ ROUTE_CLASS_NEAR_MATCH: '0' }), false);
  assert.equal(nearMatchEnabled({ ROUTE_CLASS_NEAR_MATCH: 'yes please' }), true, 'a typo must not silently switch the rule off');
});

test('routes with no driver, tied votes, and the appointment lot are each reported for what they are', () => {
  const tie = buildVehicleRoster([
    { fullName: 'T', vehicleType: 'tractor', externalIds: { nuvizz: 'Tee Driver' } },
    { fullName: 'B', vehicleType: 'box_truck', externalIds: { nuvizz: 'Bee Driver' } },
  ]);
  const rc = buildRouteClasses([], [
    stop('DULUTH', ''),
    stop('SPLIT', 'Tee Driver'), stop('SPLIT', 'Bee Driver'),
    stop('ULINE APPT', ''),
  ], tie);
  const by = Object.fromEntries(rc.unclassed.map((u) => [u.route, u.reason]));
  assert.deepEqual(by, { DULUTH: 'no_driver', SPLIT: 'tie', 'ULINE APPT': 'appointment_route' });
  assert.equal('SPLIT' in rc.sourceByRoute, false, 'a tie leaves no source behind either');
});

test('the load header still outranks everything, and is never counted as unclassed', () => {
  const rc = buildRouteClasses([{ loadNbr: 'BRENT', routeName: 'BRENT', vehicleType: 'STRAIGHT TRUCK' }], [stop('BRENT', 'Brent  Bryd')], roster());
  assert.equal(rc.classes.BRENT, 'box', 'the header says box; the roster near-match says tractor; the header wins');
  assert.equal(rc.sourceByRoute.BRENT, 'load_header');
  assert.deepEqual(rc.unclassed, []);
});

test('editDistance counts an adjacent swap as ONE — Byrd and Bryd are one typo apart', () => {
  assert.equal(editDistance('BRYD', 'BOYD'), 1);
  assert.equal(editDistance('BYRD', 'BRYD'), 1, 'a transposed pair is one edit, not two');
  assert.equal(editDistance('SEYERS', 'BRENT'), 5);
  assert.equal(editDistance('', 'ABC'), 3);
  assert.equal(editDistance('SAME', 'SAME'), 0);
});

test('a card saved as "Brent Byrd" still resolves a NuVizz "Brent  Bryd" — with no aliases[] to lean on', () => {
  const r = buildVehicleRoster([{ fullName: 'Brenton Byrd', vehicleType: 'tractor', externalIds: { nuvizz: 'Brent Byrd' } }]);
  assert.equal(nearestRosterAlias('Brent  Bryd', r), 'BRENT BYRD');
  const rc = buildRouteClasses([], [stop('BRENT', 'Brent  Bryd')], r);
  assert.equal(rc.classes.BRENT, 'tractor');
  assert.equal(rc.sourceByRoute.BRENT, 'roster_near');
});

test('THE REAL CHAIN: NuVizz renamed him, the card kept both names, and the roster honours both — exactly, no near-match needed', () => {
  // employees/brenton_byrd as stored after the 2026-09-02 save: alias "Brent Bryd",
  // aliases ["Brent Boyd"]. NuVizz sent "Brent  Boyd" through Aug 26 and "Brent  Bryd" since.
  const card = [{ fullName: 'Brenton Byrd', vehicleType: 'tractor', externalIds: { nuvizz: 'Brent Bryd' }, aliases: ['Brent Boyd'] }];
  const r = buildVehicleRoster(card);
  for (const asSent of ['Brent  Bryd', 'Brent  Boyd']) {
    const rc = buildRouteClasses([], [stop('BRENT', asSent)], r, { nearMatch: false });
    assert.equal(rc.classes.BRENT, 'tractor', `${JSON.stringify(asSent)} must resolve with the near-match OFF`);
    assert.equal(rc.sourceByRoute.BRENT, 'roster', 'an exact join, recorded as one');
    assert.deepEqual(rc.nearMatches, []);
  }
});

test('a card with only aliases[] and no primary NuVizz alias is still a rostered driver', () => {
  const r = buildVehicleRoster([{ fullName: 'X', vehicleType: 'box_truck', externalIds: {}, aliases: ['Ex Driver'] }]);
  assert.equal(r.aliasToVehicle.get('EX DRIVER')?.vehicleType, 'box_truck');
  assert.deepEqual(r.skippedNoAlias, []);
});

test('two cards claiming one name: the card whose PRIMARY alias it is wins', () => {
  const r = buildVehicleRoster([
    { fullName: 'A', vehicleType: 'box_truck', externalIds: {}, aliases: ['Shared Name'] },
    { fullName: 'B', vehicleType: 'tractor', externalIds: { nuvizz: 'Shared Name' } },
  ]);
  // Order-independent: B's primary claim wins whichever card is listed first.
  const r2 = buildVehicleRoster([
    { fullName: 'B', vehicleType: 'tractor', externalIds: { nuvizz: 'Shared Name' } },
    { fullName: 'A', vehicleType: 'box_truck', externalIds: {}, aliases: ['Shared Name'] },
  ]);
  assert.equal(r2.aliasToVehicle.get('SHARED NAME')?.name, 'B');
  assert.equal(r.aliasToVehicle.get('SHARED NAME')?.name, 'A', 'first writer wins today — pinned so a change here is deliberate');
});
