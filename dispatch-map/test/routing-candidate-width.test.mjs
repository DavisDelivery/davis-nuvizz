// test/routing-candidate-width.test.mjs
//
// Phase 2.9 — wider candidate sets + employees-roster truck class.
// Leave-day-out on 16 board days measured zone-7/area-5 at 87.1% containment
// vs 82.4% for 5/3 — width raises the CEILING (actual driver reachable) while
// ownership scoring keeps picks concentrated. Class now flows from the
// MarginIQ employees roster (vehicleType) through the NuVizz-alias fold.
import test from 'node:test';
import assert from 'node:assert/strict';

import { territoryMapsAsOf, candidateDriversFor } from '../netlify/functions/lib/routing-envelope.mts';
import { employeeClassMap } from '../netlify/functions/lib/routing-plan-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const ref = (date, drv, pts) => ({ date, driver_user_name: drv, driver_name: drv, stops: pts.map(([lat, lng]) => ({ lat, lng })) });
const Z = [34.15, -83.95];

test('config: candidate width knobs default to the PROVEN 5/3 (2.9.1 revert)', () => {
  // 2.9.0's 7/5 raised containment 68.0→72.8 but cost 1.7pts realized agreement
  // (27.9→26.2) — the narrow sets were doing silent enforcement work. Defaults
  // stay 5/3 until a rank-aware solver makes width pay; the knobs remain.
  const cfg = engineConfigDefaults({});
  assert.equal(cfg.candidate_zone_k, 5);
  assert.equal(cfg.candidate_area_k, 3);
});

test('candidateDriversFor honors zoneK: the 6th and 7th zone drivers are admitted at K=7', () => {
  // Seven drivers with strictly decreasing visit counts in one zone.
  const refs = [];
  const drivers = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
  drivers.forEach((d, i) => {
    for (let v = 0; v < 8 - i; v++) refs.push(ref(`2026-07-0${(v % 7) + 1}`, d, [Z]));
  });
  const maps = territoryMapsAsOf(refs, '2026-07-15');
  const roster = new Set(drivers);
  const k5 = candidateDriversFor(Z[0], Z[1], null, maps, roster, { zoneK: 5, areaK: 3 });
  const k7 = candidateDriversFor(Z[0], Z[1], null, maps, roster, { zoneK: 7, areaK: 5 });
  assert.ok(!k5.includes('D6') && !k5.includes('D7'), 'K=5 clips the cast tail');
  assert.ok(k7.includes('D6') && k7.includes('D7'), 'K=7 admits the tail the data says dispatch uses');
  assert.deepEqual(k7.slice(0, 5), k5.slice(0, 5), 'width never reorders the top of the cast');
});

test('employeeClassMap: vehicleType joins through nuvizz alias / fullName / aliases folds', () => {
  const employees = [
    { fullName: 'Junior Thomas', vehicleType: 'tractor', externalIds: { nuvizz: 'Junior Thomas' } },
    { fullName: 'Aaron Mitchell', vehicleType: 'box_truck', externalIds: { nuvizz: 'Aaron Mitchell' }, aliases: ['A. Mitchell'] },
    { fullName: 'No Type Set', externalIds: { nuvizz: 'No Type Set' } },           // no vehicleType → skipped
    { firstName: 'Che', lastName: 'Roberts', vehicleType: 'box_truck' },           // no nuvizz id → fullName/first+last fold
  ];
  const m = employeeClassMap(employees);
  assert.equal(m.get('JUNIOR_THOMAS'), 'tractor');
  assert.equal(m.get('AARON_MITCHELL'), 'box_truck');
  assert.equal(m.get('A._MITCHELL'), 'box_truck', 'explicit aliases fold in');
  assert.equal(m.get('CHE_ROBERTS'), 'box_truck');
  assert.equal(m.has('NO_TYPE_SET'), false, 'rows without a vehicleType never claim a class');
  assert.deepEqual(employeeClassMap([]), new Map(), 'empty roster → empty map (fallbacks apply)');
});
