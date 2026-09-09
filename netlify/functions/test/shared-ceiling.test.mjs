// netlify/functions/test/shared-ceiling.test.mjs
//
// Pins ONE rule, across BOTH apps: the number Chad saves in dispatch-map's Diagnostics page
// is the number that ends the calls here too.
//
// Chad, 2026-09-09: "I want the number I set in diagnostics to be the number ... Whatever
// number it's set to is where I want the calls to end."
//
// This app never read nuvizz_ops/scan_config. Its ceiling came from NUVIZZ_DAILY_CEILING
// with a 12,000 default that matched nothing else in the system. It was only PARTLY covered
// by the shared plumbing: both apps increment one counter and read one breaker, so once
// dispatch-map noticed the shared count cross the setting it tripped and this app stopped
// too — but that check only happens when dispatch-map itself makes a call. Between its scans
// (up to half an hour) this app alone could run past the setting toward 12,000.
//
// Own file on purpose: the resolved setting is cached in a module singleton, and node --test
// runs each file in a fresh process. Stubbed Firestore — nothing here reaches NuVizz.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nvreq = require('../lib/nuvizz-request.cjs');
const fsdb = require('../lib/firestore.cjs');

test('the default is 2,000 — the SAME number dispatch-map falls back to, not the old 12,000', () => {
  assert.equal(nvreq.DEFAULT_DAILY_CEILING, 2000);
  assert.notEqual(nvreq.DEFAULT_DAILY_CEILING, 12000, 'a number that appeared nowhere else');
  assert.equal(nvreq.parseCeiling(undefined), 2000);
  assert.equal(nvreq.parseCeiling(''), 2000);
});

test('savedCeiling mirrors the .mts twin: his number verbatim, junk to the DEFAULT', () => {
  for (const n of [1, 500, 2000, 3000, 3001, 12_000, 20_000, 200_000]) {
    assert.equal(nvreq.savedCeiling(n), n, `saved ${n} must mean ${n}`);
  }
  assert.equal(nvreq.savedCeiling(1_000_001), nvreq.CEILING_SANITY_MAX, 'arithmetic sanity only');
  for (const junk of [0, -5, NaN, Infinity, null, undefined, '', 'lots', {}]) {
    assert.equal(nvreq.savedCeiling(junk), 2000, String(junk), 'junk must not buy headroom');
  }
});

test('THE RULE: this app resolves the SAVED setting, not its own env fallback', async () => {
  const orig = fsdb.readScanConfigCeiling;
  try {
    // What the Diagnostics page wrote.
    fsdb.readScanConfigCeiling = async () => 5000;
    nvreq.__resetCeilingCache();
    // The fallback passed in is this app's own configured number; the SAVED one must win.
    assert.equal(await nvreq.resolveDailyCeiling(12_000), 5000, 'his 5,000 ends the calls, not 12,000');

    // A lower save binds just as hard — the setting is not a floor either.
    fsdb.readScanConfigCeiling = async () => 800;
    nvreq.__resetCeilingCache();
    assert.equal(await nvreq.resolveDailyCeiling(12_000), 800);

    // Nobody has decided → this app's own fallback, unchanged.
    fsdb.readScanConfigCeiling = async () => undefined;
    nvreq.__resetCeilingCache();
    assert.equal(await nvreq.resolveDailyCeiling(2000), 2000);
  } finally {
    fsdb.readScanConfigCeiling = orig;
    nvreq.__resetCeilingCache();
  }
});

test('a Firestore blip KEEPS the resolved ceiling rather than silently cutting the budget', async () => {
  const orig = fsdb.readScanConfigCeiling;
  try {
    fsdb.readScanConfigCeiling = async () => 5000;
    nvreq.__resetCeilingCache();
    assert.equal(await nvreq.resolveDailyCeiling(2000), 5000);
    // Read fails; the last known good value stands. Dropping to the fallback here would cut
    // him from 5,000 to 2,000 mid-day on a hiccup, which is the failure this whole change ends.
    fsdb.readScanConfigCeiling = async () => { throw new Error('firestore 503'); };
    assert.equal(await nvreq.resolveDailyCeiling(2000), 5000, 'still enforcing what he saved');
  } finally {
    fsdb.readScanConfigCeiling = orig;
    nvreq.__resetCeilingCache();
  }
});

test('raising the ceiling releases a breaker this app tripped at the old number', () => {
  // The breaker doc is shared, so a stale latch in EITHER app halts the fleet until ET
  // midnight. Same predicate as dispatch-map's circuitStillBinding.
  assert.equal(nvreq.circuitStillBinding(true, 2000, 3000), false, 'count under the new ceiling: released');
  assert.equal(nvreq.circuitStillBinding(true, 4999, 5000), false);
  assert.equal(nvreq.circuitStillBinding(true, 5000, 5000), true, 'at it, still binding');
  assert.equal(nvreq.circuitStillBinding(true, 9000, 5000), true);
  assert.equal(nvreq.circuitStillBinding(true, 2000, 1000), true, 'lowering it binds harder');
  assert.equal(nvreq.circuitStillBinding(false, 9999, 10), false, 'a closed breaker is closed');
});

test('an unreadable count or ceiling leaves the breaker OPEN — the mistakes are not symmetrical', () => {
  // Releasing on a bad read means uncapped vendor spend; staying halted means a late board.
  for (const bad of [NaN, Infinity, undefined, null]) {
    assert.equal(nvreq.circuitStillBinding(true, bad, 3000), true, `count=${String(bad)}`);
    assert.equal(nvreq.circuitStillBinding(true, 10, bad), true, `ceiling=${String(bad)}`);
  }
  assert.equal(nvreq.circuitStillBinding(true, 10, 0), true, 'a zero ceiling is not "no limit"');
});
