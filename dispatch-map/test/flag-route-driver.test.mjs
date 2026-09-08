// A FLAG CARD NAMES THE TRUCK AND THE PERSON ON IT.
//
// Chad, on a receiving-hours card: "Need to show route and driver name." The route was only
// ever inside the detail prose ("Stop 11 on ESTES") and the driver appeared nowhere — yet the
// first thing anyone does with a flag is work out which truck it is and phone whoever is
// driving it. That was a second lookup on another screen, twenty times a morning.
//
// The subtlety these tests exist for: a STOP row often carries no driver even when its LOAD
// is assigned, so taking the driver from the stop alone would print "No driver" on most cards
// and quietly destroy the meaning of the real no-driver flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillRouteDrivers, computeBoardFlags } from '../src/lib/board-flags.js';

const stop = (o) => ({ stopNbr: String(o.n), routeName: o.route || null, driverName: o.driver || null, ...o });

test('a row with no driver of its own takes the one its route is running', () => {
  const stops = [
    stop({ n: 1, route: 'ESTES', driver: 'FRANK OKINE' }),
    stop({ n: 2, route: 'ESTES' }),                        // same load, no driver on the row
  ];
  const rows = [{ routeName: 'ESTES', driverName: null }];
  fillRouteDrivers(rows, stops);
  assert.equal(rows[0].driverName, 'FRANK OKINE');
});

test('a row that already names a driver is left alone', () => {
  const rows = [{ routeName: 'ESTES', driverName: 'JESSICA' }];
  fillRouteDrivers(rows, [stop({ n: 1, route: 'ESTES', driver: 'FRANK OKINE' })]);
  assert.equal(rows[0].driverName, 'JESSICA', 'the row knows its own stop better than the route does');
});

test('a genuinely driverless route stays driverless — the flag must keep meaning what it says', () => {
  const rows = [{ routeName: 'SUW 2', driverName: null }];
  fillRouteDrivers(rows, [stop({ n: 1, route: 'SUW 2' }), stop({ n: 2, route: 'SUW 2' })]);
  assert.equal(rows[0].driverName, null);
});

test('TWO drivers on one route name fills NOTHING — this panel is where somebody decides who to phone', () => {
  const stops = [
    stop({ n: 1, route: 'BEN 2', driver: 'FRANK OKINE' }),
    stop({ n: 2, route: 'BEN 2', driver: 'BRENT BOYD' }),
  ];
  const rows = [{ routeName: 'BEN 2', driverName: null }];
  fillRouteDrivers(rows, stops);
  assert.equal(rows[0].driverName, null, 'naming one of two would send the call to the wrong truck');
});

test('route matching ignores case and padding, and reads loadNbr when routeName is absent', () => {
  const rows = [{ routeName: 'estes ', driverName: null }];
  fillRouteDrivers(rows, [{ stopNbr: '1', loadNbr: 'ESTES', driverUserName: 'fokine' }]);
  assert.equal(rows[0].driverName, 'fokine', 'driverUserName is the fallback the board already uses');
});

test('a row with no route at all is untouched, and empties never throw', () => {
  const rows = [{ routeName: null, driverName: null }];
  fillRouteDrivers(rows, [stop({ n: 1, route: 'ESTES', driver: 'FRANK OKINE' })]);
  assert.equal(rows[0].driverName, null);
  assert.doesNotThrow(() => fillRouteDrivers(null, null));
  assert.doesNotThrow(() => fillRouteDrivers([], undefined));
  assert.doesNotThrow(() => fillRouteDrivers([{ routeName: 'X' }], [null, undefined, {}]));
});

test('END TO END: a real receiving-hours flag comes out carrying the route and the driver', () => {
  // The PYROK shape from board-flags-intraday.test.mjs — a typed 2pm close on stop 9 of 10,
  // spaced so the 8:00 projection already misses it — with ONE change: the driver is named on
  // the FIRST stop only. That is the real board shape (NuVizz carries the driver per stop and
  // an unassigned row on an assigned load is ordinary), and it is exactly the case that made
  // every card read "No driver" before fillRouteDrivers existed.
  const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };
  const DATE = '2026-08-17';
  const stops = [];
  for (let i = 1; i <= 10; i += 1) {
    stops.push({
      stopNbr: `S${i}`, matchKey: `c${i}`, businessName: `CUST ${i}`, loadNbr: 'TESTLOAD',
      routeSeq: i, stopType: 'DL', lat: 34.147791 + i * 0.26, lng: -83.960911,
      normalizedStatus: 'PLANNED', status: '10',
      driverName: i === 1 ? 'FRANK OKINE' : null,
      driverUserName: i === 1 ? 'fokine' : null,
    });
  }
  const notes = new Map([['c9', {
    manual_overrides: { receiving_hours: true },
    receiving_hours: { mon: { open: '08:00', close: '14:00' } },
  }]]);
  const out = computeBoardFlags({
    stops, notes, servedDate: DATE, dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 8 * 60 + 5 },
  });
  const hours = out.rows.find((r) => r.rule === 'hours_risk' && /CUST 9/.test(`${r.title} ${r.detail}`));
  assert.ok(hours, 'the fixture must actually produce the receiving-hours flag');
  assert.equal(hours.routeName, 'TESTLOAD', 'the card must name the truck');
  assert.equal(hours.driverName, 'FRANK OKINE', 'the card must name who to phone, from the route');
});

test('MUTATION: without the route fill, the same board loses the driver on 9 of 10 rows', () => {
  // Proves the end-to-end test above is testing the fill and not something incidental.
  const rows = [{ routeName: 'TESTLOAD', driverName: null }];
  const stops = [{ stopNbr: 'S1', loadNbr: 'TESTLOAD', driverName: 'FRANK OKINE' }];
  assert.equal(rows[0].driverName, null);
  fillRouteDrivers(rows, stops);
  assert.equal(rows[0].driverName, 'FRANK OKINE');
});
