// test/derive-fleet.test.mjs — Phase 4: deriving SITE A's canonical fleet shape
// from the normalized stops the sole scanner already produces.
import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveFleetSummary } from '../netlify/functions/lib/nuvizz-scan.mts';

function stop(loadNbr, status, { driverUserName = 'JIM', driverName = 'Jim Smith', routeName = '1 SATL' } = {}) {
  return { stopNbr: String(Math.random()).slice(2, 11), loadNbr, isPlanned: !!loadNbr, normalizedStatus: status, driverUserName, driverName, routeName };
}

test('deriveFleetSummary: groups planned stops into loads with status counts', () => {
  const stops = [
    stop('DAVIS000000001', 'DELIVERED'),
    stop('DAVIS000000001', 'OUT_FOR_DEL'),
    stop('DAVIS000000001', 'EXCEPTION'),
    stop('DAVIS000000002', 'DELIVERED', { driverUserName: 'BOB', driverName: 'Bob Lee', routeName: '2 NATL' }),
    stop('DAVIS000000002', 'SCHEDULED', { driverUserName: 'BOB', driverName: 'Bob Lee', routeName: '2 NATL' }),
    // an unplanned stop must be ignored entirely
    { stopNbr: '999', loadNbr: null, isPlanned: false, normalizedStatus: 'UNPLANNED' },
  ];
  const f = deriveFleetSummary(stops);

  assert.equal(f.loads.length, 2, 'two loads');
  const l1 = f.loads.find((l) => l.loadNbr === 'DAVIS000000001');
  assert.equal(l1.totalStops, 3);
  assert.equal(l1.delivered, 1);
  assert.equal(l1.inProgress, 1);
  assert.equal(l1.exceptions, 1);
  assert.equal(l1.pctComplete, 33, '1/3 delivered ≈ 33%');
  assert.equal(l1.driverUserName, 'JIM');
  assert.equal(l1.route, '1 SATL');

  assert.equal(f.summary.totalLoads, 2);
  assert.equal(f.summary.assignedLoads, 2);
  assert.equal(f.summary.unassignedLoads, 0);
  assert.equal(f.summary.totalStops, 5, 'unplanned stop excluded');
  assert.equal(f.summary.totalDelivered, 2);
  assert.equal(f.summary.uniqueDrivers, 2);

  assert.deepEqual(f.driverIndex.JIM, ['DAVIS000000001']);
  assert.deepEqual(f.driverIndex.BOB, ['DAVIS000000002']);
});

test('deriveFleetSummary: empty / null input is safe', () => {
  for (const input of [[], null, undefined]) {
    const f = deriveFleetSummary(input);
    assert.equal(f.loads.length, 0);
    assert.equal(f.summary.totalLoads, 0);
    assert.equal(f.summary.pctComplete, 0);
    assert.deepEqual(f.driverIndex, {});
  }
});

test('deriveFleetSummary: a load with no driver counts as unassigned', () => {
  const f = deriveFleetSummary([
    { stopNbr: '1', loadNbr: 'DAVIS000000003', isPlanned: true, normalizedStatus: 'SCHEDULED', driverUserName: null, driverName: null, routeName: null },
  ]);
  assert.equal(f.summary.totalLoads, 1);
  assert.equal(f.summary.assignedLoads, 0);
  assert.equal(f.summary.unassignedLoads, 1);
  assert.equal(f.summary.uniqueDrivers, 0);
});
