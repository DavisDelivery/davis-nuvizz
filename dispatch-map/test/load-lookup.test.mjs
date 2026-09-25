// A driver's week of loads — src/lib/load-lookup.js.
//
// Chad, 2026-09-25: "evaluate a weeks worth of a drivers loads … want milage of load earnings of
// load cost of load stops ect". The failures that matter here are the quiet ones: an order's
// price counted twice (a redelivery, a split Uline order), a delivery time read four hours early,
// a rate printed off a partial sum, a man split in two by a load name.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weekOf, weekLabel, addDays, wallTime, wallMinutes, totalAmounts, sealPrice, orderPrice, baseOrderNbr,
  driversOfWeek, resolveDriver, deliveredRun, milesPath, routeChunks, pathFingerprint, buildLoad,
  pricedRows, driverWeek, withMiles, toMiles, YARD, MAX_INTERMEDIATES, COST_NOT_RECORDED,
} from '../src/lib/load-lookup.js';

const row = (stopNbr, extra = {}) => ({
  stopNbr, date: '2026-09-23', stopType: 'DO', businessName: `CONSIGNEE ${stopNbr}`, city: 'ATLANTA', zip: '30318',
  lat: 33.75, lng: -84.39, routeName: 'COLIN 1', loadNbr: 'COLIN 1', driverName: 'COLIN', driverUserName: 'COLIN',
  normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-09-23T09:00:00', routeSeq: 1, cartons: 1, volume: 0, weight: 100,
  ...extra,
});

test('the week runs Monday to Sunday — a Saturday load belongs to the week it was run in', () => {
  assert.deepEqual(weekOf('2026-09-25'), {
    from: '2026-09-21', to: '2026-09-27',
    dates: ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'],
  });
  assert.equal(weekOf('2026-09-27').from, '2026-09-21', 'Sunday closes the week, it does not open the next one');
  assert.equal(weekOf('2026-09-28').from, '2026-09-28');
  assert.equal(weekOf('09/25/2026'), null);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(weekLabel(weekOf('2026-09-25')), 'Sep 21 – 27');
  assert.equal(weekLabel(weekOf('2026-10-01')), 'Sep 28 – Oct 4');
  assert.equal(weekLabel(weekOf('2026-12-31')), 'Dec 28, 2026 – Jan 3, 2027');
});

test('a delivery stamp is read on its digits — never four hours early, never on the wrong day', () => {
  // The board stores Eastern wall clock with no zone. Date.parse would call it UTC.
  assert.equal(wallTime('2026-09-23T14:19:00'), '2026-09-23T14:19');
  assert.equal(wallTime('2026-09-23T00:30:00'), '2026-09-23T00:30', 'a 12:30am delivery stays on its own day');
  assert.equal(wallTime('2026-07-27T08:00:00:00'), '2026-07-27T08:00', 'NuVizz\'s own odd shape');
  // A stamp that DOES carry a zone is converted to Eastern.
  assert.equal(wallTime('2026-09-23T18:19:00Z'), '2026-09-23T14:19');
  assert.equal(wallTime('2026-09-23T03:30:00Z'), '2026-09-22T23:30', '3:30 UTC is the evening before in Atlanta');
  assert.equal(wallTime('2026-09-23'), null, 'a day with no time is not a delivery time');
  assert.equal(wallTime(null), null);
  assert.equal(wallMinutes('2026-09-23T07:42', '2026-09-23T15:12'), 450);
});

test('ULINE\'S TOTAL-AMOUNT is the order\'s price — in every shape the board carries it', () => {
  // The list text (a live field): one run-on string.
  assert.deepEqual(orderPrice({ orderInstructions: 'TOTAL-AMOUNT : 84.21 LIFT GATE NEEDED INSIDE DELIVERY' }), { amount: 84.21, source: 'uline' });
  // The enriched copy: one SPL-INSTR line per comment.
  assert.equal(orderPrice({ signalSources: { orderInstructions: 'SPL-INSTR-TEXT: RH 8-12\nSPL-INSTR-TEXT: TOTAL-AMOUNT : 55.90' } }).amount, 55.9);
  assert.equal(orderPrice({ allComments: [{ text: 'TOTAL-AMOUNT : 203.62' }] }).amount, 203.62);
  assert.deepEqual(totalAmounts('TOTAL-AMOUNT: $1,234.5'), [1234.5]);
  // The same figure twice (list text AND comments) is one price, not a conflict.
  assert.equal(orderPrice({ orderInstructions: 'TOTAL-AMOUNT : 84.21', allComments: [{ text: 'TOTAL-AMOUNT : 84.21' }] }).amount, 84.21);
});

test('two DIFFERENT TOTAL-AMOUNT figures price nothing — one of them may be the correction', () => {
  const p = orderPrice({ orderInstructions: 'TOTAL-AMOUNT : 84.21', allComments: [{ text: 'TOTAL-AMOUNT : 91.00' }] });
  assert.equal(p.amount, null);
  assert.match(p.conflict, /\$84\.21 and \$91\.00/);
});

test('the Seal # is a price only when it is written like one', () => {
  // Order 007152286 as NuVizz returned it (Chad's HAR capture): Seal # "$55.86", TOTAL-AMOUNT 55.86.
  assert.deepEqual(orderPrice({ raw: { stop: { sealNbr: '$55.86' } } }), { amount: 55.86, source: 'seal' });
  assert.deepEqual(sealPrice('163.18'), { amount: 163.18 });
  assert.deepEqual(sealPrice('$1,250'), { amount: 1250 });
  // A bare whole number could be a price typed without cents or a real trailer seal. Nothing says which.
  assert.deepEqual(sealPrice('1234567'), { amount: null, unreadable: '1234567' });
  assert.deepEqual(orderPrice({ raw: { stop: { sealNbr: 'SEAL 4471' } } }), { amount: null, source: null, unreadable: 'SEAL 4471' });
  assert.equal(sealPrice(''), null);
  // Both present: Uline's live line wins, and a disagreement is recorded rather than hidden.
  const both = orderPrice({ orderInstructions: 'TOTAL-AMOUNT : 55.86', raw: { stop: { sealNbr: '$60.00' } } });
  assert.equal(both.amount, 55.86);
  assert.equal(both.sealDiffers, 60);
  assert.deepEqual(orderPrice({}), { amount: null, source: null });
});

test('one order is one order — pieces and zero-padding fold, carrier PROs keep their dash', () => {
  assert.equal(baseOrderNbr('007157687-1'), '7157687');
  assert.equal(baseOrderNbr('007157687-2'), '7157687');
  assert.equal(baseOrderNbr('7157687'), '7157687');
  assert.equal(baseOrderNbr('ESTES-0538243875'), 'ESTES-0538243875');
  assert.equal(baseOrderNbr('AVRT-0170416694'), 'AVRT-0170416694');
});

test('COLIN/DJ 1 is Colin\'s second load, and a NuVizz rename is one man — the territory sheet\'s rule', () => {
  const stops = [
    row('1', { driverName: 'COLIN', driverUserName: 'COLIN', routeName: 'COLIN 1', loadNbr: 'COLIN 1' }),
    row('2', { driverName: 'COLIN/DJ 1', driverUserName: 'COLIN/DJ 1', routeName: 'COLIN/DJ 1', loadNbr: 'COLIN/DJ 1' }),
    row('3', { driverName: 'Brent  Boyd', driverUserName: 'Brent  Boyd', routeName: 'BRENT', loadNbr: 'BRENT', date: '2026-09-21' }),
    row('4', { driverName: 'Brent  Bryd', driverUserName: 'Brent  Bryd', routeName: 'BRENT', loadNbr: 'BRENT', date: '2026-09-22' }),
    row('5', { driverName: null, driverUserName: null, routeName: null, loadNbr: null, normalizedStatus: 'UNPLANNED' }),
  ];
  const d = driversOfWeek(stops, [{ from: 'BRENT_BOYD', to: 'BRENT_BRYD' }]);
  assert.deepEqual(d.map((x) => [x.key, x.loads, x.days]), [['BRENT_BRYD', 2, 2], ['COLIN', 2, 1]]);
  assert.equal(d[0].label, 'Brent Bryd', 'a name a person would write, not the machine key');
});

test('a typed name: exact wins, one hit answers, two Anthonys is a choice for the person', () => {
  const drivers = [
    { key: 'ANTHONY_BENNETT', label: 'Anthony Bennett' }, { key: 'ANTHONY_WELLS', label: 'Anthony Wells' },
    { key: 'COLIN', label: 'COLIN' }, { key: 'ENOCK_AKYEA', label: 'ENOCK AKYEA' },
  ];
  assert.equal(resolveDriver(drivers, 'colin').match.key, 'COLIN');
  assert.equal(resolveDriver(drivers, 'COLIN 2').match.key, 'COLIN', 'a trailing load index is not part of the name');
  assert.equal(resolveDriver(drivers, 'akyea').match.key, 'ENOCK_AKYEA');
  const two = resolveDriver(drivers, 'anthony');
  assert.equal(two.match, null);
  assert.deepEqual(two.candidates.map((x) => x.key), ['ANTHONY_BENNETT', 'ANTHONY_WELLS']);
  assert.deepEqual(resolveDriver(drivers, 'zed').candidates, []);
  assert.equal(resolveDriver(drivers, '').candidates.length, 4, 'no name asks for the whole list');
});

test('THE RUN is the order the truck went — by delivery time, a strip mall is one stop, the unplaceable are counted not guessed', () => {
  const rows = [
    row('A', { deliveredDTTM: '2026-09-23T11:05:00', routeSeq: 1, lat: 34.0, lng: -84.0 }),       // dispatched first, delivered third
    row('B', { deliveredDTTM: '2026-09-23T08:10:00', routeSeq: 2, lat: 34.1, lng: -84.1 }),
    row('C1', { deliveredDTTM: '2026-09-23T09:30:00', routeSeq: 3, lat: 34.20001, lng: -84.20001, businessName: 'SUITE 100' }),
    row('C2', { deliveredDTTM: '2026-09-23T09:34:00', routeSeq: 3, lat: 34.2, lng: -84.2, businessName: 'SUITE 200' }),
    row('X', { normalizedStatus: 'EXCEPTION', deliveredDTTM: null, lat: 34.3, lng: -84.3 }),   // unable to deliver
    row('N', { deliveredDTTM: null, executed: {}, lat: 34.4, lng: -84.4 }),                     // delivered, no time on it
    row('P', { deliveredDTTM: '2026-09-23T12:00:00', lat: null, lng: null }),                   // no pin
  ];
  const { run, noTime, noPin } = deliveredRun(rows);
  assert.deepEqual(run.map((p) => [p.n, p.stopNbrs.join('+'), p.at]), [
    [1, 'B', '2026-09-23T08:10'], [2, 'C1+C2', '2026-09-23T09:30'], [3, 'A', '2026-09-23T11:05'],
  ]);
  assert.deepEqual(run[1].names, ['SUITE 100', 'SUITE 200']);
  assert.equal(noTime, 1);
  assert.equal(noPin, 1);
});

test('the miles path is yard → the run → yard, a repeated point adds no road, and no run is no path', () => {
  const run = [{ lat: 34.2, lng: -84.2 }, { lat: 34.2, lng: -84.2 }, { lat: 34.3, lng: -84.3 }];
  const path = milesPath(run);
  assert.equal(path.length, 4);
  assert.deepEqual(path[0], { lat: YARD.lat, lng: YARD.lng });
  assert.deepEqual(path[3], { lat: YARD.lat, lng: YARD.lng });
  assert.deepEqual(milesPath([]), [], 'a load that delivered nothing has no distance to measure');
  assert.notEqual(pathFingerprint(path), pathFingerprint(milesPath(run.slice().reverse())), 'the same stops in another order is another drive');
  assert.equal(pathFingerprint(path), pathFingerprint(milesPath(run)));
  assert.equal(toMiles(160934.4), 100);
});

test('a long load is cut into requests Google will take, chained end to start, no point dropped', () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ lat: 34 + i / 100, lng: -84 }));
  const chunks = routeChunks(pts);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].intermediates.length, MAX_INTERMEDIATES);
  assert.equal(chunks[0].destination, pts[26]);
  assert.equal(chunks[1].origin, pts[26], 'the second leg starts where the first ended');
  assert.equal(chunks[1].destination, pts[29]);
  const covered = [chunks[0].origin, ...chunks.flatMap((c) => [...c.intermediates, c.destination])];
  assert.deepEqual(covered, pts);
  assert.deepEqual(routeChunks([pts[0]]), []);
});

test('A REDELIVERY IS PRICED ONCE — on the load that delivered it, and the failed attempt says where it went', () => {
  const week = [
    row('007174397', { date: '2026-09-21', routeName: 'COLIN 1', loadNbr: 'COLIN 1', normalizedStatus: 'EXCEPTION', deliveredDTTM: null, orderInstructions: 'TOTAL-AMOUNT : 84.21' }),
    row('007174397', { date: '2026-09-23', routeName: 'COLIN 1', loadNbr: 'COLIN 1', isAttempt: true, orderInstructions: 'TOTAL-AMOUNT : 84.21' }),
  ];
  const w = driverWeek(week, 'COLIN');
  const [mon, wed] = w.loads;
  assert.equal(mon.price.orders, 0);
  assert.equal(mon.price.elsewhere, 1);
  assert.deepEqual(mon.rows[0].countedOn, { date: '2026-09-23', load: 'COLIN 1', stopNbr: '007174397' });
  assert.equal(wed.price.delivered, 84.21);
  assert.equal(wed.attempts, 1);
  assert.equal(w.totals.price.delivered, 84.21, 'the week counts the order once');
});

test('a split Uline order is priced once; pieces that disagree are left unpriced and say why', () => {
  const same = buildLoad('2026-09-23', 'COLIN 1', [
    row('007157687-1', { orderInstructions: 'TOTAL-AMOUNT : 129.79' }),
    row('007157687-2', { orderInstructions: 'TOTAL-AMOUNT : 129.79' }),
  ]);
  assert.equal(same.price.delivered, 129.79);
  assert.equal(same.price.orders, 1);
  const differ = buildLoad('2026-09-23', 'COLIN 1', [
    row('007157688-1', { orderInstructions: 'TOTAL-AMOUNT : 10.00' }),
    row('007157688-2', { orderInstructions: 'TOTAL-AMOUNT : 12.00' }),
  ]);
  assert.equal(differ.price.delivered, 0);
  assert.equal(differ.price.unpriced, 1);
  assert.equal(differ.price.conflicts, 1);
  assert.match(differ.rows.find((r) => r.priceNote).priceNote, /pieces of this order carry different prices/);
});

test('a rate is printed only when every order behind it is priced — never a partial sum dressed as a rate', () => {
  const full = buildLoad('2026-09-23', 'COLIN 1', [
    row('1', { orderInstructions: 'TOTAL-AMOUNT : 100.00', deliveredDTTM: '2026-09-23T08:00:00', lat: 34.0, lng: -84.0 }),
    row('2', { orderInstructions: 'TOTAL-AMOUNT : 60.00', deliveredDTTM: '2026-09-23T10:00:00', lat: 34.1, lng: -84.1 }),
  ]);
  const a = withMiles(full, { meters: 80467.2, source: 'google' });  // 50 miles
  assert.equal(a.miles.miles, 50);
  assert.equal(a.perMile, 3.2);
  assert.equal(a.perStop, 80);
  const gap = buildLoad('2026-09-24', 'COLIN 1', [
    row('3', { date: '2026-09-24', orderInstructions: 'TOTAL-AMOUNT : 100.00' }),
    row('4', { date: '2026-09-24', lat: 34.5, lng: -84.5 }),                        // no price anywhere
  ]);
  const b = withMiles(gap, { meters: 80467.2, source: 'google' });
  assert.equal(b.perMile, null);
  assert.equal(b.priceComplete, false);
  const w = driverWeek([
    row('1', { orderInstructions: 'TOTAL-AMOUNT : 100.00', deliveredDTTM: '2026-09-23T08:00:00', lat: 34.0, lng: -84.0 }),
    row('2', { orderInstructions: 'TOTAL-AMOUNT : 60.00', deliveredDTTM: '2026-09-23T10:00:00', lat: 34.1, lng: -84.1 }),
    row('3', { date: '2026-09-24', orderInstructions: 'TOTAL-AMOUNT : 100.00' }),
    row('4', { date: '2026-09-24', lat: 34.5, lng: -84.5 }),
  ], 'COLIN', { miles: { '2026-09-23|COLIN 1': { meters: 80467.2 }, '2026-09-24|COLIN 1': { meters: 80467.2 } } });
  assert.equal(w.totals.miles, 100);
  assert.equal(w.totals.ratedLoads, 1, 'the rate is over the one load that can carry it, and says so');
  assert.equal(w.totals.perMile, 3.2);
  assert.equal(w.totals.price.delivered, 260);
  assert.equal(w.totals.price.unpriced, 1);
});

test('A LOAD, COUNTED THE WAY A DOCK COUNTS IT — orders vs stops, delivered vs not, cancelled off, the truck of THAT day', () => {
  const CANCELLED = { raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '2026-09-23T06:00:00Z', reasonCode: 'CANCELLED' } } } };
  const w = driverWeek([
    row('1', { deliveredDTTM: '2026-09-23T07:42:00', cartons: 2, volume: 1, weight: 1240, lat: 34.0, lng: -84.0 }),
    row('2', { deliveredDTTM: '2026-09-23T07:50:00', lat: 34.0, lng: -84.0 }),                     // same dock
    row('3', { deliveredDTTM: '2026-09-23T15:12:00', lat: 34.2, lng: -84.2 }),
    row('4', { normalizedStatus: 'EXCEPTION', deliveredDTTM: null, lat: 34.3, lng: -84.3 }),
    row('5', { normalizedStatus: 'SCHEDULED', deliveredDTTM: null, lat: 34.4, lng: -84.4 }),
    row('RA5732712', { stopType: 'PU', deliveredDTTM: '2026-09-23T12:00:00', lat: 34.1, lng: -84.1 }),
    row('6', CANCELLED),
    row('7', { driverName: 'ENOCK AKYEA', driverUserName: 'ENOCK AKYEA', routeName: 'NOR 2', loadNbr: 'NOR 2' }),
  ], 'COLIN', { classes: { '2026-09-23': { 'COLIN 1': 'tractor' } } });
  assert.equal(w.cancelledOff, 1);
  assert.equal(w.loads.length, 1, 'another driver\'s load is not his');
  const l = w.loads[0];
  assert.equal(l.truck, 'tractor');
  assert.deepEqual([l.orders, l.deliveries, l.pickups, l.stops], [6, 5, 1, 5]);
  assert.deepEqual([l.delivered, l.notDelivered, l.open], [4, 1, 1]);
  assert.deepEqual([l.firstAt, l.lastAt, l.spanMin], ['2026-09-23T07:42', '2026-09-23T15:12', 450]);
  assert.deepEqual(l.run.map((p) => p.stopNbrs.join('+')), ['1+2', 'RA5732712', '3']);
  assert.equal(l.weight, 1740);
  assert.equal(l.skids, 7);
  assert.equal(l.path.length, 5, 'yard, three stops, yard');
  assert.equal(w.driver.label, 'COLIN');
  // A day with no truck map reads unknown — never another day's trucks.
  assert.equal(driverWeek([row('1', { date: '2026-09-24' })], 'COLIN', { classes: { '2026-09-23': { 'COLIN 1': 'tractor' } } }).loads[0].truck, null);
});

test('cost is not invented', () => {
  assert.equal(driverWeek([row('1')], 'COLIN').totals.cost, null);
  assert.match(COST_NOT_RECORDED, /no record of what a load costs/);
});
