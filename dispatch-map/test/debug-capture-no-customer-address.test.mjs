// test/debug-capture-no-customer-address.test.mjs
//
// THE DEFECT (review 2026-09-03, A1-S4-10). "Debug this view" tells the dispatcher it sends
// "data only — no customer names or addresses", and files the capture as a GitHub issue. But
// every scrubbed stop still carried `matchKey`, which IS the customer's name and street:
// normalizeMatchKey(businessName, addr1, city, zip) → "acme supply|1200 peachtree ind blvd|
// buford|30518". Every capture of a busy board put hundreds of customer names and addresses
// into the issue tracker under a promise that it would not. The key is now replaced by a
// one-way digest: two stops at the same location still carry the same value (the join a
// reviewer needs), and the text is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { scrubStop, matchKeyDigest } from '../src/lib/debug-capture-scrub.js';

const ACME = {
  stopNbr: '007176371', pro: '007176371', loadNbr: 'SCOTT', status: '20', lat: 34.1, lng: -84.0,
  businessName: 'ACME SUPPLY CO', addr1: '1200 Peachtree Ind Blvd', addr2: 'Dock 4', city: 'Buford', state: 'GA', zip: '30518',
  contact: { name: 'Pat Jones', phone: '770-555-0101' },
  matchKey: 'acme supply|1200 peachtree ind blvd|buford|30518',
  raw: { stop: { to: { name: 'ACME SUPPLY CO' } } },
};

test('a debug capture of a stop carries no customer name, street, city or zip', () => {
  const out = JSON.stringify(scrubStop(ACME, 0, { priority_flag: 'red' })).toLowerCase();
  for (const leak of ['acme', 'peachtree', 'buford', '30518', 'pat jones', '770-555']) {
    assert.ok(!out.includes(leak), `"${leak}" leaked into the capture: ${out}`);
  }
  assert.ok(!('matchKey' in scrubStop(ACME, 0, null)), 'the readable key is not shipped at all');
});

test('two stops at the same customer location still join in the capture; different locations do not', () => {
  const a = scrubStop(ACME, 0, null);
  const b = scrubStop({ ...ACME, stopNbr: '007176372', pro: '007176372' }, 1, null);
  const c = scrubStop({ ...ACME, matchKey: 'other co|5 main st|duluth|30096' }, 2, null);
  assert.match(a.matchKeyDigest, /^[0-9a-f]{16}$/);
  assert.equal(a.matchKeyDigest, b.matchKeyDigest, 'same location, same digest');
  assert.notEqual(a.matchKeyDigest, c.matchKeyDigest);
});

test('a stop with no location key gets no digest rather than a digest of the empty string', () => {
  assert.equal(matchKeyDigest(''), null);
  assert.equal(matchKeyDigest(null), null);
  assert.equal(scrubStop({ ...ACME, matchKey: undefined }, 0, null).matchKeyDigest, null);
  assert.equal(scrubStop(null, 0, null), null);
});

test('the operational fields a reviewer needs are still in the capture', () => {
  const out = scrubStop(ACME, 3, { priority_flag: 'red' });
  assert.equal(out.seq, 3);
  assert.equal(out.stopNbr, '007176371');
  assert.equal(out.loadNbr, 'SCOTT');
  assert.equal(out.lat, 34.1);
  assert.equal(out.hasNote, true);
  assert.equal(out.flag, 'red');
});

test('the capture no longer tells the reviewer the readable matchKey is in it', () => {
  const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.ok(!APP.includes('only the join matchKey + coords remain'), 'the bundle note describes what is actually shipped');
  assert.ok(!/^function scrubStop\(/m.test(APP), 'App.jsx uses the one tested scrubber, not a second copy');
});
