// alias-displayname-claims.test.mjs — A5-S30-2.
//
// Name sign-in counts a credential's displayName as a claim on a name, alongside
// its hand-seeded aliases (resolveLoginIdentifier). The add-alias guard and the
// dispatcher's "claimed by more than one driver" warning only looked at aliases.
// So a dispatcher could attach "BRAD GOODROE" to another driver while Brad's own
// credential is NAMED Brad Goodroe: nothing refused it, nothing warned, and the
// next morning Brad's name sign-in came back ambiguous and he could not get in.

import test from 'node:test';
import assert from 'node:assert/strict';

const aliases = await import('../netlify/functions/lib/aliases.mts');

const brad = { driverNumber: '4471', displayName: 'Brad Goodroe', nuvizzAliases: ['BRAD'], active: true };
const other = { driverNumber: '4472', displayName: 'Samuel Osei', nuvizzAliases: [], active: true };

test('attaching another driver\'s NAME as an alias is refused, like attaching their alias', () => {
  const plan = aliases.planAliasAdd(other, 'brad  goodroe', [brad, other]);
  assert.ok('error' in plan, 'must refuse — the name already signs Brad in');
  assert.deepEqual(plan.claimedBy, ['4471']);
});

test('what the guard lets through, name sign-in then resolves to that driver alone', () => {
  // The invariant the guard exists for: an allowed add never makes sign-in ambiguous.
  for (const name of ['Brad Goodroe', 'SAMUEL OSEI', 'SAM O']) {
    const plan = aliases.planAliasAdd(other, name, [brad, other]);
    if ('error' in plan) continue;
    const after = [brad, { ...other, nuvizzAliases: plan.aliases }];
    const r = aliases.resolveLoginIdentifier(name, after);
    assert.equal(r.status, 'resolved', `${name} must still resolve after the add`);
    assert.equal(r.driverNumber, '4472');
  }
});

test('a driver may take their own display name as an alias', () => {
  const plan = aliases.planAliasAdd(brad, 'Brad Goodroe', [brad, other]);
  assert.ok(!('error' in plan));
  assert.deepEqual(plan.aliases, ['BRAD', 'BRAD GOODROE']);
});

test('a DEACTIVATED credential named the same does not block a live driver', () => {
  const dead = { driverNumber: '9001', displayName: 'Alfred Morgan', nuvizzAliases: [], active: false };
  const alfred = { driverNumber: '4480', displayName: 'Al', nuvizzAliases: [], active: true };
  const plan = aliases.planAliasAdd(alfred, 'ALFRED MORGAN', [dead, alfred]);
  assert.ok(!('error' in plan), 'login filters to active, so the dead name contests nothing');
});

test('an alias that is another driver\'s display name is shown to the dispatcher as ambiguous', () => {
  const clash = { ...other, nuvizzAliases: ['BRAD GOODROE'] };
  const found = aliases.findAmbiguousAliases([brad, clash]);
  assert.equal(found.length, 1);
  assert.equal(found[0].alias, 'BRAD GOODROE');
  assert.deepEqual(found[0].driverNumbers.sort(), ['4471', '4472']);
  // And it agrees with what sign-in actually does with that name.
  assert.equal(aliases.resolveLoginIdentifier('Brad Goodroe', [brad, clash]).reason, 'ambiguous');
});

test('a driver whose display name is also one of their own aliases is not ambiguous', () => {
  const self = { ...brad, nuvizzAliases: ['BRAD', 'BRAD GOODROE'] };
  assert.deepEqual(aliases.findAmbiguousAliases([self, other]), []);
});

test('an inactive credential named the same is still not reported', () => {
  const dead = { driverNumber: '9001', displayName: 'Brad Goodroe', nuvizzAliases: [], active: false };
  assert.deepEqual(aliases.findAmbiguousAliases([brad, dead]), []);
});
