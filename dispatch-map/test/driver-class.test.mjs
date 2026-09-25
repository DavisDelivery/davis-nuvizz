// test/driver-class.test.mjs — THE CLASS RULE MOVED, IT DID NOT CHANGE.
//
// employeeClassMap and CLASS_OVERRIDE moved out of routing-plan-core.mts (v1.70.0) so the Claude
// shadow can share the learned engine's truck-class rule without the engine's import graph. The
// engine must keep using the very same objects, and the rule must read a roster exactly as before:
// a driver whose MarginIQ Vehicle Type says tractor is a tractor on both sides of the comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../netlify/functions/lib/routing-plan-core.mts';
import { employeeClassMap, CLASS_OVERRIDE } from '../netlify/functions/lib/driver-class.mts';

test('routing-plan-core re-exports the SAME function and map — one rule, not two copies', () => {
  assert.equal(core.employeeClassMap, employeeClassMap);
  assert.equal(core.CLASS_OVERRIDE, CLASS_OVERRIDE);
});

test('a tractor driver in MarginIQ is a tractor under every name the roster knows them by', () => {
  const m = employeeClassMap([
    { vehicleType: 'Tractor', externalIds: { nuvizz: 'ben.p' }, fullName: 'Ben  Paintsil', aliases: ['BEN P'] },
    { vehicleType: 'box_truck', firstName: 'Aaron', lastName: 'Mitchell' },
    { vehicleType: 'van', fullName: 'Not A Class' },
    { vehicleType: '', fullName: 'Blank' },
  ]);
  assert.equal(m.get('BEN.P'), 'tractor');
  assert.equal(m.get('BEN_PAINTSIL'), 'tractor', 'doubled spaces fold to one underscore');
  assert.equal(m.get('BEN_P'), 'tractor');
  assert.equal(m.get('AARON_MITCHELL'), 'box_truck');
  assert.equal(m.has('NOT_A_CLASS'), false, 'only tractor and box_truck are classes');
  assert.equal(m.has('BLANK'), false);
});

test('the first record to claim a name keeps it, and the one pin is JUNIOR_THOMAS → tractor', () => {
  const m = employeeClassMap([{ vehicleType: 'tractor', fullName: 'Sam X' }, { vehicleType: 'box_truck', fullName: 'Sam X' }]);
  assert.equal(m.get('SAM_X'), 'tractor');
  assert.deepEqual([...CLASS_OVERRIDE], [['JUNIOR_THOMAS', 'tractor']]);
  assert.deepEqual(employeeClassMap(null), new Map());
});
