// netlify/functions/test/breaker-refusal.test.mjs
//
// Pins ONE rule: a scan the circuit breaker refuses is an error, never an empty board.
// scanFleet used to swallow NuvizzCircuitOpenError per probe and return [] — 601
// "empty" probes → totalLoads:0 → persisted over the last good summary and returned
// ok:true, and the cron logged it as a healthy refresh.
//
// Own file on purpose: nuvizz.cjs holds a module-singleton requester that caches the
// breaker read for 5s, so any earlier test in the same process that made a request
// would pin it CLOSED. node --test runs each file in a fresh process.
// No env, stubbed fetch — nothing here can reach NuVizz or Firestore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nuvizz = require('../nuvizz.cjs');
const fsdb = require('../lib/firestore.cjs');

test('__refreshFleet with the breaker OPEN is 503, makes no NuVizz call and persists nothing', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"Load":{}}', { status: 200 }); };
  const origCircuit = fsdb.readCircuit;
  // The requester reads the breaker through the module object, so this is what it sees.
  fsdb.readCircuit = async () => ({ open: true, reason: 'test', day: fsdb.etDayString() });
  process.env.NUVIZZ_DAVIS_USER = 'test-user';
  process.env.NUVIZZ_DAVIS_PASS = 'test-pass';
  delete process.env.NUVIZZ_CONSOLIDATED;
  delete process.env.NUVIZZ_SCANS_ENABLED;
  delete process.env.FIREBASE_SA;
  const origLog = console.log, origErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const r = await nuvizz.handler({ httpMethod: 'GET', queryStringParameters: { path: '__refreshFleet', date: '2026-09-02' }, body: null });
    assert.equal(r.statusCode, 503, r.body);
    const body = JSON.parse(r.body);
    assert.match(body.error, /circuit breaker open/);
    assert.equal('summary' in body, false, 'no zeroed summary is returned');
    assert.equal(body.ok, undefined);
    assert.equal(calls.length, 0, 'no NuVizz probe and no Firestore write');

    // The same refusal on the read endpoints: an error, not a cached empty board.
    for (const path of ['__fleet', '__fleetstops']) {
      const rr = await nuvizz.handler({ httpMethod: 'GET', queryStringParameters: { path, date: '2026-09-02', nocache: '1' }, body: null });
      assert.equal(rr.statusCode, 503, `${path}: ${rr.body}`);
    }
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = origFetch; fsdb.readCircuit = origCircuit; console.log = origLog; console.error = origErr;
  }
});
