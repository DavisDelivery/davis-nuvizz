// test/nuvizz-write-board.test.mjs — the panel-level Save (runCommitBoard), §10 two-phase.
// No network: the requester is a stub recording calls + returning scripted bodies in order.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommitBoard } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };

function stub(scripts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        calls.push({ url, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null, meta });
        const s = scripts[Math.min(i, scripts.length - 1)]; i++;
        return new Response(JSON.stringify(s.json ?? {}), { status: s.status ?? 200 });
      },
    },
  };
}
const loadDoc = (loadId, versionId, deliveries) => ({ json: { Load: {
  loadHeader: { loadId, routeName: loadId }, versionId, loadExecutionInfo: { loadStatus: 'PLANNED' },
  stops: deliveries.map((id, k) => ({ stop: { stopId: id, stopNbr: id, stopSeq: k + 1, stopType: 'DO' } })),
} } });
const ok = () => ({ json: { status: 'SUCCESS' } });

test('commitBoard: single-load reorder → getLoad, then anchor-remove, then ordered one-at-a-time inserts', async () => {
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B', 'C']),   // Phase 0 getLoad
    ok(),                                     // Phase 1 load/edit (remove A,B)
    ok(),                                     // Phase 2 insert B
    ok(),                                     // Phase 2 insert A
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['C', 'B', 'A'] }] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'POST', 'POST']);
  assert.match(calls[0].url, /\/load\/info\//);
  assert.match(calls[1].url, /\/load\/edit\//);
  assert.deepEqual(calls[1].body.removeStopIds, ['A', 'B'], 'remove every delivery except the anchor C');
  assert.match(calls[2].url, /\/load\/insertstops\//);
  assert.deepEqual(calls[2].body.insertStopIds, ['B']);
  assert.deepEqual(calls[3].body.insertStopIds, ['A'], 'one-at-a-time, in order → [C,B,A]');
});

test('commitBoard: cross-load move A→B removes from the SOURCE before inserting to the TARGET', async () => {
  // Load1 [A,B] → [A] (B departs). Load2 [C] → [C,B] (B joins).
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B']),  // Phase 0 getLoad BEN1
    loadDoc('L2', 'v2', ['C']),       // Phase 0 getLoad BEN2
    ok(),                              // Phase 1 load/edit BEN1 (remove B)
    ok(),                              // Phase 2 insertstops BEN2 (B)
  ]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'BEN 1', orderedStopIds: ['A'] },
    { loadNbr: 'BEN 2', orderedStopIds: ['C', 'B'] },
  ] }, CREDS);
  assert.equal(r.ok, true);
  // Phase ordering: both getLoads, THEN the remove (frees B), THEN the insert (B onto L2).
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'POST', 'POST']);
  assert.match(calls[2].url, /\/load\/edit\//);
  assert.deepEqual(calls[2].body.removeStopIds, ['B']);
  assert.match(calls[3].url, /\/load\/insertstops\//);
  assert.deepEqual(calls[3].body.insertStopIds, ['B']);
  assert.equal(calls[3].body.loadId, 'L2', 'B is inserted onto the target load');
});

test('commitBoard: assign/dispatch-only load with a known loadId skips getLoad entirely', async () => {
  const { requester, calls } = stub([ok(), ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 3', loadId: 'L9', driverId: 5, dispatch: true }] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST'], 'no getLoad');
  assert.match(calls[0].url, /assignanddispatch/);
  assert.equal(calls[0].body.action, 'ASSIGN_DISPATCH');
  assert.equal(calls[0].body.dispatchRoute[0].assignDtls.driverId, 5);
  assert.equal(calls[1].body.action, 'DISPATCH');
});

test('commitBoard: a refused load (new stop first) is reported but does NOT block other loads', async () => {
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B']),  // getLoad for the bad load
    loadDoc('L2', 'v2', ['C']),       // getLoad for the good load
    ok(),                              // good load insert (D)
  ]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'BAD', orderedStopIds: ['X', 'A'] },   // X not on load → refuse
    { loadNbr: 'GOOD', orderedStopIds: ['C', 'D'] },  // add D
  ] }, CREDS);
  assert.equal(r.ok, false, 'overall not ok because one load failed');
  const bad = r.loads.find((l) => l.loadNbr === 'BAD');
  const good = r.loads.find((l) => l.loadNbr === 'GOOD');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /anchor-not-on-load/);
  assert.equal(good.ok, true, 'the good load still committed');
  assert.deepEqual(good.steps.map((s) => s.op), ['insertStops']);
});

test('commitBoard: empty payload → ok with no loads, zero calls', async () => {
  const { requester, calls } = stub([ok()]);
  const r = await runCommitBoard(requester, { loads: [] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.loads, []);
  assert.equal(calls.length, 0);
});

test('commitBoard: a Phase-1 remove failure aborts THAT load before any insert', async () => {
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B', 'C']),                 // getLoad
    { json: { reasons: [{ description: 'version conflict' }] } }, // load/edit FAILS
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['C', 'A', 'B'] }] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2, 'getLoad + failed load/edit only — no inserts after a failed remove');
  assert.equal(r.loads[0].steps[0].op, 'removeStops');
  assert.equal(r.loads[0].steps[0].ok, false);
});
