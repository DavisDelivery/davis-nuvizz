// test/tractor-flags.test.mjs
//
// Unit tests for the PURE tractor-location logic (lib/tractor-flags.mts):
// alias normalization, the roster builder (tractor tag + NuVizz alias join),
// the stop matching rule, the aggregation fold — plus matchKey stability for a
// sample location (the join key the map paint depends on).
// Run with: npm test  (node --test strips .mts types natively on Node ≥ 22).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDriverAlias, buildTractorRoster, stopIsTractorDelivery,
  matchedDriverName, aggregateTractorStops, tractorLocId,
} from '../netlify/functions/lib/tractor-flags.mts';
import { normalizeMatchKey } from '../netlify/functions/lib/match-key.mts';

// ── alias normalization ──────────────────────────────────────────────────────

test('normalizeDriverAlias: trim, collapse internal whitespace, uppercase', () => {
  assert.equal(normalizeDriverAlias('  Brent   Boyd '), 'BRENT BOYD');
  assert.equal(normalizeDriverAlias('brent\tboyd'), 'BRENT BOYD');
  assert.equal(normalizeDriverAlias('BRENT BOYD'), 'BRENT BOYD');
  assert.equal(normalizeDriverAlias(''), '');
  assert.equal(normalizeDriverAlias(null), '');
  assert.equal(normalizeDriverAlias(undefined), '');
});

// ── roster builder ───────────────────────────────────────────────────────────

const EMPLOYEES = [
  { fullName: 'Brenton Byrd', vehicleType: 'tractor', externalIds: { nuvizz: 'Brent Boyd' } },
  { fullName: 'Anthony Kostner', vehicleType: 'tractor', externalIds: { nuvizz: 'Anthony Kostner' } },
  { fullName: 'James Davis', vehicleType: 'tractor', externalIds: { nuvizz: '' } },        // no alias → skipped
  { fullName: 'Johnathon Sailors', vehicleType: 'tractor', externalIds: {} },              // missing alias → skipped
  { fullName: 'Box Driver', vehicleType: 'box_truck', externalIds: { nuvizz: 'Box Driver' } }, // not tractor
  { fullName: 'No Type', externalIds: { nuvizz: 'No Type' } },                             // untyped
];

test('buildTractorRoster: only tractor-typed employees with a non-empty alias join', () => {
  const r = buildTractorRoster(EMPLOYEES);
  assert.equal(r.tractorCount, 4);
  assert.equal(r.aliasSet.size, 2);
  assert.ok(r.aliasSet.has('BRENT BOYD'));
  assert.ok(r.aliasSet.has('ANTHONY KOSTNER'));
  assert.ok(!r.aliasSet.has('BOX DRIVER'));
  assert.deepEqual(r.skippedNoAlias.sort(), ['James Davis', 'Johnathon Sailors']);
  // The join uses the ALIAS, never the display name: roster "Brenton Byrd" must
  // NOT be in the set — his NuVizz identity is "Brent Boyd".
  assert.ok(!r.aliasSet.has('BRENTON BYRD'));
  assert.equal(r.aliasToName.get('BRENT BOYD'), 'Brenton Byrd');
});

// ── stop matching rule ───────────────────────────────────────────────────────

const roster = buildTractorRoster(EMPLOYEES);

test('match rule: DELIVERED + driverName in alias set counts', () => {
  assert.ok(stopIsTractorDelivery({ normalizedStatus: 'DELIVERED', driverName: 'Brent Boyd' }, roster.aliasSet));
});

test('match rule: DELIVERED + driverUserName in alias set counts (driverName misses)', () => {
  assert.ok(stopIsTractorDelivery(
    { normalizedStatus: 'DELIVERED', driverName: 'B. BOYD JR', driverUserName: 'Brent Boyd' },
    roster.aliasSet,
  ));
});

test('match rule: case + whitespace variants still match', () => {
  assert.ok(stopIsTractorDelivery({ normalizedStatus: 'DELIVERED', driverName: '  brent   boyd ' }, roster.aliasSet));
  assert.ok(stopIsTractorDelivery({ normalizedStatus: 'DELIVERED', driverUserName: 'ANTHONY  KOSTNER' }, roster.aliasSet));
});

test('match rule: non-DELIVERED statuses are excluded', () => {
  for (const st of ['SCHEDULED', 'OUT_FOR_DEL', 'ARRIVED', 'EXCEPTION', 'UNPLANNED', null, undefined]) {
    assert.ok(!stopIsTractorDelivery({ normalizedStatus: st, driverName: 'Brent Boyd' }, roster.aliasSet), String(st));
  }
});

test('match rule: unknown driver is excluded', () => {
  assert.ok(!stopIsTractorDelivery({ normalizedStatus: 'DELIVERED', driverName: 'Vincent Bonzo' }, roster.aliasSet));
  assert.ok(!stopIsTractorDelivery({ normalizedStatus: 'DELIVERED' }, roster.aliasSet));
});

test('match rule: an employee skipped for an empty alias can never match', () => {
  // "James Davis" is tractor-tagged but has no alias — a NuVizz driver that
  // HAPPENS to share the display name must not count.
  assert.ok(!stopIsTractorDelivery({ normalizedStatus: 'DELIVERED', driverName: 'James Davis' }, roster.aliasSet));
});

test('matchedDriverName resolves to the roster display name', () => {
  assert.equal(matchedDriverName({ driverName: 'brent boyd' }, roster), 'Brenton Byrd');
  assert.equal(matchedDriverName({ driverUserName: 'Anthony Kostner' }, roster), 'Anthony Kostner');
  assert.equal(matchedDriverName({ driverName: 'Nobody' }, roster), null);
});

// ── aggregation fold ─────────────────────────────────────────────────────────

const MK = 'acme__123_n_main_st__duluth__30096';
const stopAt = (date, driver, status = 'DELIVERED', mk = MK) => ({
  normalizedStatus: status, driverName: driver, customerMatchKey: mk,
  date, businessName: 'ACME', city: 'Duluth',
});

test('aggregateTractorStops: folds dates, drivers, and counts per location', () => {
  const agg = aggregateTractorStops([
    stopAt('2026-01-05', 'Brent Boyd'),
    stopAt('2026-03-10', 'Anthony Kostner'),
    stopAt('2026-02-01', 'Brent Boyd', 'EXCEPTION'),           // excluded: not delivered
    stopAt('2026-02-01', 'Vincent Bonzo'),                     // excluded: not a tractor driver
    stopAt('2026-04-01', 'Brent Boyd', 'DELIVERED', 'other__loc__x__1'),
  ], roster);
  assert.equal(agg.size, 2);
  const a = agg.get(MK);
  assert.equal(a.first_tractor_date, '2026-01-05');
  assert.equal(a.last_tractor_date, '2026-03-10');
  assert.equal(a.delivery_count, 2);
  assert.deepEqual([...a.drivers].sort(), ['Anthony Kostner', 'Brenton Byrd']);
});

test('aggregateTractorStops: re-running over the same stops into a FRESH map is stable (rebuild idempotency)', () => {
  const stops = [stopAt('2026-01-05', 'Brent Boyd'), stopAt('2026-03-10', 'Anthony Kostner')];
  const a1 = aggregateTractorStops(stops, roster).get(MK);
  const a2 = aggregateTractorStops(stops, roster).get(MK);
  assert.deepEqual(
    { ...a1, drivers: [...a1.drivers] },
    { ...a2, drivers: [...a2.drivers] },
  );
});

// ── matchKey stability (the join key the paint depends on) ──────────────────

test('matchKey: stable across the naming variants NuVizz produces for one location', () => {
  const a = normalizeMatchKey('Acme Co', '123 North Main Street', 'Duluth', '30096');
  const b = normalizeMatchKey('ACME COMPANY', '123 N Main St', 'Duluth', '30096-1234');
  assert.equal(a, b);
  assert.equal(tractorLocId('davis', a), `davis__${a}`);
});

// ── kill switch ──────────────────────────────────────────────────────────────

test('TRACTOR_FLAGS=off disables the daily pass; default/on enables it', async () => {
  const { tractorFlagsDisabled, updateTractorFlagsForDay } = await import('../netlify/functions/lib/tractor-flags.mts');
  const prev = process.env.TRACTOR_FLAGS;
  try {
    delete process.env.TRACTOR_FLAGS;
    assert.equal(tractorFlagsDisabled(), false);
    process.env.TRACTOR_FLAGS = 'on';
    assert.equal(tractorFlagsDisabled(), false);
    process.env.TRACTOR_FLAGS = 'OFF';
    assert.equal(tractorFlagsDisabled(), true);
    // With the switch off the day pass returns zeros WITHOUT touching the
    // roster or Firestore (no listDocs call is reachable).
    const r = await updateTractorFlagsForDay('davis', '2026-07-09', [
      { normalizedStatus: 'DELIVERED', driverName: 'Brent Boyd', customerMatchKey: 'x__y__z__1', date: '2026-07-09' },
    ]);
    assert.deepEqual(r, { matched: 0, locations: 0, written: 0, disabled: true });
  } finally {
    if (prev === undefined) delete process.env.TRACTOR_FLAGS; else process.env.TRACTOR_FLAGS = prev;
  }
});
