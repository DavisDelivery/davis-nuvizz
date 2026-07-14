// Regression tests for the seal + paint hardening (completes the #450 path-safety
// fix). The class of bug: a name/key with a Firestore-illegal char (a '/') becomes
// a doc-id path segment and THROWS — aborting the night (pre-seal) or silently
// dropping that day's tractor paint / customer rollup (post-seal).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMatchKey } from '../src/lib/matchKey.js';
import { normalizeMatchKey as normalizeMatchKeyServer } from '../netlify/functions/lib/match-key.mts';
import { histDocId } from '../netlify/functions/lib/history-store.mts';
import { tractorLocId } from '../netlify/functions/lib/tractor-flags.mts';
import { rollupId } from '../netlify/functions/lib/history-customers.mts';
import { driverDayId } from '../netlify/functions/lib/routing-driver-days.mts';

test('histDocId: no-op for clean ids (existing docs keep their exact key)', () => {
  assert.equal(histDocId('12345'), '12345');           // numeric stopNbr
  assert.equal(histDocId('acme__123_main_st__atlanta__30301'), 'acme__123_main_st__atlanta__30301');
});

test('histDocId: maps path separators and dodges reserved/empty ids', () => {
  assert.equal(histDocId('COLIN/DJ 1'), 'COLIN_DJ 1'); // the load that broke six nights
  assert.equal(histDocId('a\\b'), 'a_b');
  assert.equal(histDocId(''), 'id_0');
  assert.equal(histDocId('.'), 'id_1');
  assert.match(histDocId('__weird__'), /^x__weird__$/); // reserved __…__ dodged
  assert.doesNotMatch(histDocId('x'.repeat(2000)), /.{1401}/); // capped under the 1500-byte limit
});

test('normalizeMatchKey: a slashed zip can never smuggle a / into the key', () => {
  const k = normalizeMatchKey('ACME CO', '123 MAIN ST', 'ATLANTA', '3/456');
  assert.ok(!k.includes('/'), `match key must not contain a slash: ${k}`);
});

test('normalizeMatchKey: normal zips are unchanged (key continuity preserved)', () => {
  // digits are word chars → no-op; ZIP+4 dash falls past position 5 → still 30301.
  const a = normalizeMatchKey('ACME CO', '123 MAIN ST', 'ATLANTA', '30301');
  const b = normalizeMatchKey('ACME CO', '123 MAIN ST', 'ATLANTA', '30301-1234');
  assert.ok(a.endsWith('__30301'), a);
  assert.ok(b.endsWith('__30301'), b);
  assert.equal(a, b);
});

test('tractorLocId (PAINT): a slash-bearing matchKey yields a legal single-segment id', () => {
  const id = tractorLocId('davis', 'a/b__c/d__e__f');
  assert.ok(!id.includes('/'), `tractor loc id must not contain a slash: ${id}`);
  // clean key is byte-identical (no id churn for existing painted locations)
  assert.equal(tractorLocId('davis', 'acme__st__city__30301'), 'davis__acme__st__city__30301');
});

test('rollupId (customer history): same slash safety + clean-key no-op', () => {
  const id = rollupId('davis', 'a/b__c__d__e');
  assert.ok(!id.includes('/'), `rollup id must not contain a slash: ${id}`);
  assert.equal(rollupId('davis', 'acme__st__city__30301'), 'davis__acme__st__city__30301');
});

test('driverDayId: a slash-bearing co-driver key yields a legal single-segment id', () => {
  const id = driverDayId('davis', '2026-07-10', 'COLIN/DJ 1');
  assert.ok(!id.includes('/'), `driver-day id must not contain a slash: ${id}`);
  // clean driverKey unchanged (no doc-id churn)
  assert.equal(driverDayId('davis', '2026-07-10', 'SCOTT_HART'), 'davis__2026-07-10__SCOTT_HART');
});

test('match key: client and server normalizers agree, and neither smuggles a slash', () => {
  // Parity: the browser copy (src/lib/matchKey.js) and the server copy
  // (netlify/functions/lib/match-key.mts) must compute the SAME key — else a
  // malformed zip would make the frontend look up a doc the capture never wrote.
  const args = ['ACME CO', '123 MAIN ST', 'ATLANTA', '3/456'];
  const c = normalizeMatchKey(...args);
  const s = normalizeMatchKeyServer(...args);
  assert.equal(c, s, `client/server match keys must match: ${c} vs ${s}`);
  assert.ok(!s.includes('/'), `server match key must not contain a slash: ${s}`);
  // normal zip parity unchanged
  assert.equal(
    normalizeMatchKey('ACME CO', '123 MAIN ST', 'ATLANTA', '30301-1234'),
    normalizeMatchKeyServer('ACME CO', '123 MAIN ST', 'ATLANTA', '30301-1234'),
  );
});
