// test/closed-days-switch-cost.test.mjs — asking the closed-days switch must cost two key lookups.
//
// closedDaysFromOrderEnabled() is asked per stop, per rule, per scoring. The first cut copied the whole
// environment into a new object on every call: profiled 87% of a route preflight, 33x slower (0.12 ms ->
// 3.96 ms a scoring on an 18-stop card). Pinned as a STRUCTURAL fact, not a timing: enumerating
// process.env is what was wrong, and a Proxy can see that deterministically on any machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closedDaysFromOrderEnabled } from '../src/lib/closed-days.js';

test('reading the switch never enumerates the environment', () => {
  const real = process.env;
  let enumerated = 0;
  process.env = new Proxy(real, { ownKeys(t) { enumerated += 1; return Reflect.ownKeys(t); } });
  try {
    for (let i = 0; i < 50; i += 1) closedDaysFromOrderEnabled();
  } finally { process.env = real; }
  assert.equal(enumerated, 0, 'process.env was enumerated — the switch copies the environment again');
});

test('the switch still answers as before: default on, off-words off, a typo on, process.env read live', () => {
  assert.equal(closedDaysFromOrderEnabled({}), true);
  for (const off of ['off', '0', 'false', 'no', ' OFF ']) {
    assert.equal(closedDaysFromOrderEnabled({ CLOSED_DAYS_FROM_ORDER: off }), false, off);
    assert.equal(closedDaysFromOrderEnabled({ VITE_CLOSED_DAYS_FROM_ORDER: off }), false, `VITE_ ${off}`);
  }
  assert.equal(closedDaysFromOrderEnabled({ CLOSED_DAYS_FROM_ORDER: 'of' }), true);
  const prev = process.env.CLOSED_DAYS_FROM_ORDER;
  try {
    process.env.CLOSED_DAYS_FROM_ORDER = 'off';
    assert.equal(closedDaysFromOrderEnabled(), false, 'read at call time from process.env');
    delete process.env.CLOSED_DAYS_FROM_ORDER;
    assert.equal(closedDaysFromOrderEnabled(), true);
  } finally { if (prev === undefined) delete process.env.CLOSED_DAYS_FROM_ORDER; else process.env.CLOSED_DAYS_FROM_ORDER = prev; }
});
