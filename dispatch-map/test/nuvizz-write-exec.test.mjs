// test/nuvizz-write-exec.test.mjs — the write executor (runOp) over a stub requester.
// No network: the requester is injected. Verifies single ops, the 2-call removeStops,
// the commitLoad Save-batch ordering + abort-on-failure, and that the REAL requester
// never coalesces (dedupes) a repeated write.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runOp, runCommitLoad } from '../netlify/functions/lib/nuvizz-write.mts';
import { createNuvizzRequester } from '../netlify/functions/lib/nuvizz-request.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };

// A stub requester that records each call and returns scripted JSON bodies in order.
function stub(scripts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        calls.push({ url, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null, meta });
        const s = scripts[Math.min(i, scripts.length - 1)]; i++;
        const status = s.status ?? 200;
        return new Response(JSON.stringify(s.json ?? {}), { status });
      },
    },
  };
}

test('runOp(roster): one POST to user/list, parsed drivers', async () => {
  const { requester, calls } = stub([{ json: { users: [{ userId: 9, userName: 'd', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Driver' }] }] } }]);
  const r = await runOp(requester, 'roster', {}, CREDS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/user\/list\/DAVIS$/);
  assert.equal(r.drivers[0].driverId, 9);
});

test('runOp(insertStops): success summarized from status SUCCESS', async () => {
  const { requester, calls } = stub([{ json: { status: 'SUCCESS' } }]);
  const r = await runOp(requester, 'insertStops', { insertStopIds: ['s1'], loadId: 'L1' }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/load\/insertstops\/DAVIS$/);
});

test('runOp(removeStops): GET load/info first, then POST load/edit echoing header + versionId', async () => {
  const { requester, calls } = stub([
    { json: { Load: { loadHeader: { loadId: 'L1', routeName: 'BEN 2', earliestStartDttm: '2026-06-29T08:00:00' }, versionId: 'v9', loadExecutionInfo: { loadStatus: 'PLANNED' }, stops: [] } } },
    { json: { apiResult: { updated: 1 }, entityInfoList: [{ entityId: 'e1' }] } },
  ]);
  const r = await runOp(requester, 'removeStops', { loadNbr: 'BEN 2', removeStopIds: ['x'] }, CREDS);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/load\/info\/BEN%202\/DAVIS$/);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/load\/edit\/DAVIS$/);
  assert.equal(calls[1].body.versionId, 'v9');
  assert.equal(calls[1].body.loadHeader.seqMode, 'None');
  assert.deepEqual(calls[1].body.removeStopIds, ['x']);
  assert.equal(r.ok, true);
});

test('runCommitLoad: resolves load once, then insert → assign → dispatch in order', async () => {
  const { requester, calls } = stub([
    { json: { Load: { loadHeader: { loadId: 'L1' }, versionId: 'v1', loadExecutionInfo: {}, stops: [] } } }, // getLoad
    { json: { status: 'SUCCESS' } },   // insertStops
    { json: { status: 'Success' } },   // assignDriver
    { json: { status: 'Success' } },   // dispatchLoad
  ]);
  const r = await runCommitLoad(requester, { loadNbr: 'BEN 2', insertStopIds: ['s1', 's2'], driverId: 77, dispatch: true }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'POST', 'POST']);
  assert.match(calls[0].url, /\/load\/info\//);
  assert.match(calls[1].url, /\/load\/insertstops\//);
  assert.match(calls[2].url, /\/load\/assignanddispatch\//);
  assert.equal(calls[2].body.action, 'ASSIGN_DISPATCH');
  assert.equal(calls[2].body.dispatchRoute[0].routeId, 'L1');
  assert.equal(calls[3].body.action, 'DISPATCH');
  assert.equal(r.steps.length, 3); // insert, assign, dispatch (getLoad is resolution, not a step)
});

test('runCommitLoad: aborts the batch on the first failing step (no dispatch after a failed insert)', async () => {
  const { requester, calls } = stub([
    { json: { Load: { loadHeader: { loadId: 'L1' }, versionId: 'v1', loadExecutionInfo: {}, stops: [] } } }, // getLoad
    { json: { reasons: [{ description: 'stop already on another load' }] } },  // insertStops FAILS
  ]);
  const r = await runCommitLoad(requester, { loadNbr: 'BEN 2', insertStopIds: ['s1'], driverId: 77, dispatch: true }, CREDS);
  assert.equal(r.ok, false);
  // getLoad + insert only; assign/dispatch never fired.
  assert.equal(calls.length, 2);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].op, 'insertStops');
  assert.equal(r.steps[0].ok, false);
  assert.match(r.steps[0].error, /another load/);
});

test('runCommitLoad: assign-only needs no getLoad when loadId is already known', async () => {
  const { requester, calls } = stub([{ json: { status: 'Success' } }]);
  const r = await runCommitLoad(requester, { loadNbr: 'BEN 2', loadId: 'L1', driverId: 5 }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /assignanddispatch/);
});

test('the REAL requester never dedupes a repeated WRITE (two identical assigns → two fetches)', async () => {
  let fetches = 0;
  const requester = createNuvizzRequester({
    fetchImpl: async () => { fetches++; return new Response(JSON.stringify({ status: 'Success' }), { status: 200 }); },
    recordCall: async (_m, n) => n,
    isCircuitOpen: async () => false,
    tripCircuit: async () => {},
    log: () => {},
    now: () => 1,
    sleep: async () => {},
  }, { breakerMode: 'monitor' });
  await runOp(requester, 'assignDriver', { loadId: 'L1', driverId: 1 }, CREDS);
  await runOp(requester, 'assignDriver', { loadId: 'L1', driverId: 1 }, CREDS);
  assert.equal(fetches, 2, 'writes must not be coalesced like idempotent GETs');
});

test('runOp surfaces a malformed-payload throw (handler maps to 400)', async () => {
  const { requester } = stub([{ json: {} }]);
  await assert.rejects(() => runOp(requester, 'insertStops', { insertStopIds: [] }, CREDS), /insertStopIds/);
});
