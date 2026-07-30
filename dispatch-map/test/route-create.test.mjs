// test/route-create.test.mjs — deriving a load number for a NEW route, and the form's
// pre-flight. Imports the SAME functions App.jsx ships (no copy).
//
// The thing these pin: a route has TWO identifiers. The dispatcher types the NAME
// ("TRAILER 6"); NuVizz needs a LOAD NUMBER, unique to the business, capped at 20 chars.
// The date rides in the number because TRAILER 6 runs most days — without it, tomorrow's
// create would collide with today's route and be refused by the server's collision guard.
import test from 'node:test';
import assert from 'node:assert/strict';

import { routeLoadNbr, routeNameSlug, validateNewRoute, ROUTE_FIELD_MAX } from '../src/lib/route-create.js';

test('the load number is the name slug plus the day', () => {
  assert.equal(routeLoadNbr('TRAILER 6', '2026-07-31'), 'TRAILER6-0731');
  assert.equal(routeLoadNbr('SUW 2', '2026-08-01'), 'SUW2-0801');
  assert.equal(routeLoadNbr('DAWSONVILLE', '2026-12-25'), 'DAWSONVILLE-1225');
  // Punctuation and case are not load-number characters.
  assert.equal(routeLoadNbr('  st. marys / #3 ', '2026-07-31'), 'STMARYS3-0731');
});

test('the same route on two days gets two DIFFERENT numbers — recurring routes must not collide', () => {
  const a = routeLoadNbr('TRAILER 6', '2026-07-31');
  const b = routeLoadNbr('TRAILER 6', '2026-08-01');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('TRAILER6-') && b.startsWith('TRAILER6-'));
});

test('the 20-char cap is respected and the DAY is never what gets cut', () => {
  const long = routeLoadNbr('NORTH ATLANTA EXPRESS RUN', '2026-07-31');
  assert.ok(long.length <= ROUTE_FIELD_MAX, `${long} is ${long.length}`);
  assert.ok(long.endsWith('-0731'), 'the day survives truncation — it is what makes the number unique');
  assert.equal(long, 'NORTHATLANTAEXP-0731');
  assert.equal(long.length, ROUTE_FIELD_MAX, 'the cap is used fully, not undershot');
});

test('unusable input yields no number rather than a bad one', () => {
  for (const [n, d] of [['', '2026-07-31'], ['TRAILER 6', ''], ['TRAILER 6', '07/31/2026'], ['   ', '2026-07-31'], ['!!!', '2026-07-31'], [null, null]]) {
    assert.equal(routeLoadNbr(n, d), '', `${JSON.stringify(n)} / ${JSON.stringify(d)}`);
  }
  assert.equal(routeNameSlug('#$%'), '');
});

test('the form pre-flight catches what would otherwise cost a NuVizz round-trip', () => {
  const ok = validateNewRoute({ routeName: 'TRAILER 6', date: '2026-07-31' });
  assert.equal(ok.ok, true);
  assert.equal(ok.loadNbr, 'TRAILER6-0731');

  assert.match(validateNewRoute({ routeName: '', date: '2026-07-31' }).error, /Give the route a name/);
  assert.match(validateNewRoute({ routeName: 'X'.repeat(21), date: '2026-07-31' }).error, /caps a route name at 20/);
  assert.match(validateNewRoute({ routeName: '###', date: '2026-07-31' }).error, /at least one letter or number/);
  assert.match(validateNewRoute({ routeName: 'TRAILER 6', date: '' }).error, /Pick the day/);
  assert.match(validateNewRoute({ routeName: 'TRAILER 6', date: '2026-07-31', hasOrigin: false }).error, /ship-from address/);
  // Every failure yields no load number — nothing half-formed can reach the server.
  for (const bad of [{ routeName: '', date: '2026-07-31' }, { routeName: 'A', date: 'nope' }]) {
    assert.equal(validateNewRoute(bad).loadNbr, '');
  }
});

test('a name already on that day is refused before sending — and case does not hide it', () => {
  const existing = ['SUW 2', 'trailer 6', 'DAWSONVILLE'];
  const r = validateNewRoute({ routeName: 'TRAILER 6', date: '2026-07-31', existingNames: existing });
  assert.equal(r.ok, false);
  assert.match(r.error, /already on the board for that day/);
  assert.match(r.error, /open it from the Routes list/);
  // A genuinely new name on the same day is fine.
  assert.equal(validateNewRoute({ routeName: 'TRAILER 7', date: '2026-07-31', existingNames: existing }).ok, true);
  // Blank/garbage entries in the board list never block a create.
  assert.equal(validateNewRoute({ routeName: 'TRAILER 7', date: '2026-07-31', existingNames: [null, '', undefined] }).ok, true);
});
