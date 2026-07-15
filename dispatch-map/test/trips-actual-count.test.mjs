// Regression: trips_actual reported 0 on EVERY scored day because plan-core
// filtered trips with `t.stops.length` — but DriverTrip.stops is a COUNT (a
// number), and `.length` on a number is undefined, so every trip was dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractDriverDays } from '../netlify/functions/lib/routing-driver-days.mts';

const stop = (loadNbr, driver, nbr, delivered) => ({
  stopNbr: String(nbr), isPlanned: true, loadNbr,
  driverUserName: driver, driverName: driver,
  lat: 34.1, lng: -84.0, pallets: 1, weight: 100,
  deliveredDTTM: delivered,
});

test('DriverTrip.stops is a count, and the plan-core predicate counts trips correctly', () => {
  const stops = [
    stop('LOAD A', 'SHART', 1, '2026-07-14T12:00:00Z'),
    stop('LOAD A', 'SHART', 2, '2026-07-14T13:00:00Z'),
    stop('LOAD B', 'SHART', 3, '2026-07-14T16:00:00Z'),
  ];
  const days = extractDriverDays(stops, { tenant: 'davis', date: '2026-07-14' });
  assert.equal(days.length, 1);
  const trips = days[0].trips;
  assert.equal(trips.length, 2);
  assert.equal(typeof trips[0].stops, 'number', 'stops is a COUNT, not an array');

  // the fixed predicate finds both trips…
  assert.equal(trips.filter((t) => t.stops > 0).length, 2);
  // …while the old broken predicate (`.length` on a number) found none.
  assert.equal(trips.filter((t) => t.stops.length).length, 0);
});

test('plan-core uses the count predicate, never .length on the trip count', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/routing-plan-core.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /t\.stops\.length/, 'trips must be filtered on the count (t.stops > 0)');
  assert.match(src, /t\.stops > 0/);
});
