// test/nuvizz-write-handler.test.mjs — the op-envelope handler's GUARDS only.
// Every path here is network-free: it returns before any NuVizz call fires (bad
// method/JSON/op, dry-run, and the write-disabled 403). The actual firing path is
// covered by the executor tests (runOp over a stub requester).
import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../netlify/functions/nuvizz-write.mts';

const URL = 'http://localhost/.netlify/functions/nuvizz-write';
const post = (obj, raw) => handler(new Request(URL, { method: 'POST', body: raw ?? JSON.stringify(obj) }));

// Keep the write kill-switch OFF for the whole file unless a test opts in.
const SAVED = process.env.NUVIZZ_WRITE_ENABLED;
test.before(() => { delete process.env.NUVIZZ_WRITE_ENABLED; });
test.after(() => { if (SAVED === undefined) delete process.env.NUVIZZ_WRITE_ENABLED; else process.env.NUVIZZ_WRITE_ENABLED = SAVED; });

test('non-POST → 405', async () => {
  const res = await handler(new Request(URL, { method: 'GET' }));
  assert.equal(res.status, 405);
});

test('OPTIONS → 200 (CORS preflight)', async () => {
  const res = await handler(new Request(URL, { method: 'OPTIONS' }));
  assert.equal(res.status, 200);
});

test('invalid JSON → 400', async () => {
  const res = await post(null, 'not json {');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid JSON/);
});

test('unknown op → 400 with the allowlist', async () => {
  const res = await post({ op: 'frobnicate', payload: {} });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.match(j.error, /unknown op/);
  assert.ok(Array.isArray(j.allowed));
});

test('dryRun commitLoad → ok with a human plan, ZERO NuVizz calls, never gated', async () => {
  const res = await post({ op: 'commitLoad', dryRun: true, payload: { loadNbr: 'BEN 2', insertStopIds: ['s1', 's2'], driverId: 7, driverName: 'DENIS', dispatch: true } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.ok(Array.isArray(j.plan));
  assert.ok(j.plan.some((s) => /assign driver DENIS/.test(s)));
  assert.ok(j.plan.some((s) => /dispatch load BEN 2/.test(s)));
  assert.equal(j.tenant, 'DAVIS');
});

test('dryRun works for a non-mutating op too (getStop)', async () => {
  const res = await post({ op: 'getStop', dryRun: true, payload: { stopNbr: '7' } });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
});

test('mutating op with NUVIZZ_WRITE_ENABLED unset → 403, no fire', async () => {
  delete process.env.NUVIZZ_WRITE_ENABLED;
  const res = await post({ op: 'assignDriver', payload: { loadId: 'L1', driverId: 7 } });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.live, false);
  assert.match(j.error, /NUVIZZ_WRITE_ENABLED/);
});

test('commitLoad (live attempt) is also gated when writes are disabled', async () => {
  delete process.env.NUVIZZ_WRITE_ENABLED;
  const res = await post({ op: 'commitLoad', payload: { loadNbr: 'BEN 2', dispatch: true } });
  assert.equal(res.status, 403);
});

test('the response always reports tenant + live so the UI banner can show PROD state', async () => {
  const res = await post({ op: 'getStop', dryRun: true, payload: { stopNbr: '7' } });
  const j = await res.json();
  assert.equal(typeof j.tenant, 'string');
  assert.equal(typeof j.live, 'boolean');
  assert.ok(j.ops && typeof j.ops.ceiling === 'number');
});
