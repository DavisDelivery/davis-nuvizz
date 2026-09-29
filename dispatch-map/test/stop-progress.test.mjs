import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStopProgress } from '../src/lib/stop-progress.js';

const isDelivered = (s) => s.done === true;
const stop = (routeName, done = false, extra = {}) => ({ routeName, loadNbr: routeName, done, ...extra });

test('Chad route and ULINE APPT stops leave the count entirely — numerator and denominator', () => {
  const p = computeStopProgress([
    stop('MARCUS', true), stop('MARCUS', false), stop('DARVIN', true), stop('DARVIN', false),
    stop('CHAD', true), stop('CHAD', true), stop('ULINE APPT', false), stop('ULINE APPT', false),
  ], { isDelivered });
  assert.deepEqual(p, { total: 4, completed: 2, setAside: 4, pct: 50 });
});

test('CHADWICK and CHATTANOOGA are real trucks and still count', () => {
  const p = computeStopProgress([stop('CHADWICK', true), stop('CHATTANOOGA', false)], { isDelivered });
  assert.equal(p.total, 2);
  assert.equal(p.setAside, 0);
});

test('unplanned stops are on nobody\'s truck and do not hold the percentage down', () => {
  const p = computeStopProgress([
    stop('MARCUS', true),
    { routeName: '', loadNbr: '', done: false },
    stop('', false, { isPlanned: false }),
  ], { isDelivered });
  assert.deepEqual(p, { total: 1, completed: 1, setAside: 0, pct: 100 });
});

test('a route-keyed ULINE APPT row whose loadNbr is a number is still set aside by its name', () => {
  const p = computeStopProgress([
    { loadNbr: 'DAVIS000204700', routeName: 'ULINE APPT', isPlanned: true, done: false },
    stop('MARCUS', true),
  ], { isDelivered });
  assert.equal(p.total, 1);
  assert.equal(p.setAside, 1);
});

test('an empty board, or a board of only set-aside routes, shows nothing rather than 0%', () => {
  assert.equal(computeStopProgress([], { isDelivered }), null);
  assert.equal(computeStopProgress(null, { isDelivered }), null);
  assert.equal(computeStopProgress([stop('CHAD', true), stop('ULINE APPT')], { isDelivered }), null);
});
