// netlify/functions/test/ceiling-unknown-release.test.mjs
//
// Audit 2026-09-27 (nuvizz-write-4), this app's half. nuvizz_ops/circuit is ONE document shared
// with dispatch-map, so a release written here frees every instance of both apps. On a cold
// instance whose read of the saved ceiling failed, resolveDailyCeiling fell back to 2,000 with no
// sign it was a guess, and the breaker compared the day's count against that and RELEASED a trip
// Chad's lower saved ceiling had taken. The shared rule says the opposite: when we cannot tell,
// it stays open.
//
// Own file on purpose: the resolved setting is a module singleton, and node --test runs each file
// in a fresh process. Stubbed Firestore — nothing here reaches NuVizz.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nvreq = require('../lib/nuvizz-request.cjs');
const fsdb = require('../lib/firestore.cjs');

function stubFirestore({ saved, readFails, dayCount }) {
  const orig = { readScanConfigCeiling: fsdb.readScanConfigCeiling, readCircuit: fsdb.readCircuit, readCallCounter: fsdb.readCallCounter, setCircuit: fsdb.setCircuit };
  const writes = [];
  fsdb.readScanConfigCeiling = async () => { if (readFails()) throw new Error('firestore 503'); return saved; };
  fsdb.readCircuit = async () => ({ open: true, reason: `daily ceiling ${saved} reached`, day: 'today' });
  fsdb.readCallCounter = async () => dayCount;
  fsdb.setCircuit = async (open, reason) => { writes.push({ open, reason }); };
  return { writes, restore: () => Object.assign(fsdb, orig) };
}

test('Chad lowered the ceiling to 1,500 and it tripped: a cold instance that cannot read the setting keeps the shared breaker shut', async () => {
  let fail = true;
  const fs = stubFirestore({ saved: 1500, readFails: () => fail, dayCount: 1600 });
  try {
    nvreq.__resetCeilingCache();
    assert.equal(await nvreq.breakerTripped(), true, 'an unknown ceiling releases nothing');
    assert.deepEqual(fs.writes, [], 'open:false is never written to the shared document on a guess');
    assert.equal(nvreq.dailyCeilingKnown(), false);

    // The per-call path: a request is refused before it is sent, and nothing is released. The
    // network is stubbed so a regression here fails the test instead of reaching anything real.
    const r = nvreq.createRequester();
    const realFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = async () => { sent += 1; throw new Error('test: nothing may leave this process'); };
    try {
      await assert.rejects(r.request('https://nuvizz.example/x', {}, { route: '/x', tenant: 'DAVIS' }), (e) => e.name === 'NuvizzCircuitOpenError');
    } finally { globalThis.fetch = realFetch; }
    assert.equal(sent, 0, 'nothing was sent');
    assert.deepEqual(fs.writes, []);

    // A good read of his setting settles it — 1,600 is still over 1,500, so still shut.
    fail = false;
    nvreq.__resetCeilingCache();
    assert.equal(await nvreq.breakerTripped(), true);
    assert.equal(nvreq.dailyCeilingKnown(), true);
    assert.deepEqual(fs.writes, []);
  } finally { fs.restore(); nvreq.__resetCeilingCache(); }
});

test('a ceiling that WAS read and has been raised above the day\'s count still releases the breaker', async () => {
  const fs = stubFirestore({ saved: 3000, readFails: () => false, dayCount: 1600 });
  try {
    nvreq.__resetCeilingCache();
    assert.equal(await nvreq.breakerTripped(), false);
    assert.equal(fs.writes.length, 1);
    assert.equal(fs.writes[0].open, false);
    assert.match(fs.writes[0].reason, /\(3000\)/);
  } finally { fs.restore(); nvreq.__resetCeilingCache(); }
});
