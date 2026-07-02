// test/nuvizz-write-import.test.mjs — the NEW async LOAD-IMPORT path (§I).
//
// PURE half (nuvizz-write-ops.mts): buildImportBody hard-validates the silent-failure
// trap (earliest/latest + flat origin fields), refuses an empty stops[] / bare stopNbr
// references / forbidden names; importOk parses the async ack; deliveryOrder is the
// convergence comparator (to.seq order, pickups excluded).
//
// IMPURE half (nuvizz-write.mts): runImportLoad fires ONE import per load and drives it
// to convergence (poll load/info → resend → reverse-then-forward), fully fake-clock
// testable via injected sleep; runCommitImport applies loads sources-before-destinations.
// Both are DOUBLE-GATED: the handler's NUVIZZ_WRITE_ENABLED plus NUVIZZ_LOAD_IMPORT here.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpRequest, parseOpResponse, buildImportBody, buildImportStopRef, importOk, deliveryOrder, normalizeLoad,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runOp, runImportLoad, runCommitImport, loadImportEnabled } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const HEXID = '6a438e9d52ef82bd1ed4516b';

// ── fixtures ──────────────────────────────────────────────────────────────────

const HDR = {
  loadNbr: 'DAVIS000000123', routeName: 'TEST ROUTE 7',
  earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00',
  origin: 'WHSE', originName: 'DAVIS WAREHOUSE', originAddr1: '1 Depot Rd',
  originCity: 'Atlanta', originState: 'GA', originZip: '30303',
};

// A reference-shaped stop (existing order planned by stopNbr + "to" block).
const stopRef = (n) => ({
  stopNbr: String(n), stopType: 'DO',
  to: {
    address: { name: `CONSIGNEE ${n}`, addr1: '2 Main St', city: 'Macon', state: 'GA', zip: '31201', country: 'USA' },
    schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York' },
  },
});

// A scripted requester (same pattern as nuvizz-write-exec.test.mjs).
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

// The async ack NuVizz returns for an ACCEPTED import (it does NOT mean it landed).
const ACK = { json: { status: 'SUCCESS', message: 'Async import is SUCCESS with AppMessageLog Id-9314159' } };

// A load/info doc whose deliveries read back in the given stopNbr order (to.seq 2..N; seq 1 = origin).
const loadDoc = (nbrs) => ({
  json: { Load: {
    loadHeader: { loadId: HEXID, loadNbr: HDR.loadNbr, routeName: HDR.routeName },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    stops: nbrs.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 } } })),
  } },
});

const FAST = { pollMs: 5000, phaseWaitMs: 5000, sleep: async () => {} };  // 1 poll per phase, no real clock

async function withGate(fn) {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  process.env.NUVIZZ_LOAD_IMPORT = 'on';
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.NUVIZZ_LOAD_IMPORT; else process.env.NUVIZZ_LOAD_IMPORT = prev; }
}

// ── PURE: buildImportBody / buildOpRequest('importLoad') ─────────────────────

test('importLoad: builds POST load/update/default with header + stops in exact array order', () => {
  const br = buildOpRequest('importLoad', { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS);
  assert.equal(br.method, 'POST');
  assert.match(br.url, /\/load\/update\/default\/DAVIS$/);
  assert.equal(br.meta.route, '/load/update/default');
  const body = JSON.parse(br.body);
  assert.equal(body.companyCode, 'DAVIS');
  assert.equal(body.loads.length, 1);
  const h = body.loads[0].loadHeader;
  assert.equal(h.loadNbr, HDR.loadNbr);
  assert.equal(h.earliestStartDttm, HDR.earliestStartDttm);
  assert.equal(h.latestStartDttm, HDR.latestStartDttm);
  // The silent-failure trap fields, with defaults applied.
  for (const k of ['origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip']) assert.equal(h[k], HDR[k]);
  assert.equal(h.originCountry, 'USA');
  assert.equal(h.loadTimeZone, 'EST');
  // stops[] array order IS the visit order — preserved verbatim.
  assert.deepEqual(body.loads[0].stops.map((s) => s.stopNbr), ['A', 'B', 'C']);
});

test('importLoad: refuses a header missing ANY silent-failure-trap field', () => {
  for (const missing of ['earliestStartDttm', 'latestStartDttm', 'origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip']) {
    const h = { ...HDR }; delete h[missing];
    assert.throws(() => buildImportBody({ loadHeader: h, stops: [stopRef('A')] }, 'DAVIS'), new RegExp(missing));
  }
});

test('importLoad: refuses scheduleStartDttm in place of earliest/latest (async no-create trap)', () => {
  const h = { loadNbr: HDR.loadNbr, scheduleStartDttm: '2026-07-02T06:00:00', scheduleEndDttm: '2026-07-02T18:00:00' };
  assert.throws(() => buildImportBody({ loadHeader: h, stops: [stopRef('A')] }, 'DAVIS'), /earliestStartDttm \+ latestStartDttm/);
});

test('importLoad: refuses an EMPTY stops[] (emptying a load is load/cancel, never an import)', () => {
  assert.throws(() => buildImportBody({ loadHeader: HDR, stops: [] }, 'DAVIS'), /load\/cancel/);
});

test('importLoad: refuses a bare stopNbr reference (NuVizz rejects it) and defaults stopType', () => {
  assert.throws(() => buildImportBody({ loadHeader: HDR, stops: [{ stopNbr: 'A' }] }, 'DAVIS'), /"to" block/);
  const s = stopRef('B'); delete s.stopType;
  const body = buildImportBody({ loadHeader: HDR, stops: [s] }, 'DAVIS');
  assert.equal(body.loads[0].stops[0].stopType, 'DO');
});

test('importLoad: refuses forbidden names in loadNbr/routeName', () => {
  assert.throws(() => buildImportBody({ loadHeader: { ...HDR, routeName: 'Claude test route' }, stops: [stopRef('A')] }, 'DAVIS'), /never contain/);
  assert.throws(() => buildImportBody({ loadHeader: { ...HDR, loadNbr: 'ANTHROPIC-1' }, stops: [stopRef('A')] }, 'DAVIS'), /never contain/);
});

test('buildImportStopRef: stopNbr + DO + "to" address/schedule (the valid reference shape)', () => {
  const s = buildImportStopRef(
    { stopNbr: '0019385866', name: 'AVRT', addr1: '9 Elm', city: 'Macon', state: 'GA', zip: '31201' },
    { origin: { name: 'W', addr1: '1', city: 'A', state: 'GA', zip: '30303' }, serviceDate: '2026-07-02' },
  );
  assert.equal(s.stopNbr, '0019385866');
  assert.equal(s.stopType, 'DO');
  assert.equal(s.to.address.name, 'AVRT');
  assert.equal(s.to.schedule.timeFrom, '2026-07-02T12:00:00');
  assert.equal(s.from, undefined); // a reference plans an EXISTING stop; no from block needed
});

// ── PURE: importOk / deliveryOrder ────────────────────────────────────────────

test('importOk: parses the async ack — ok + AppMessageLog id, and ok NEVER implies landed', () => {
  const r = importOk(true, ACK.json);
  assert.equal(r.ok, true);
  assert.equal(r.async, true);
  assert.equal(r.appMessageLogId, '9314159');
  assert.equal(r.error, null); // the success message must NOT be misread as an error
});

test('importOk: a non-success body or non-2xx is a failure with a readable error', () => {
  const bad = importOk(true, { status: 'FAILURE', reasons: [{ description: 'Either From or To information should be present' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /From or To/);
  const http = importOk(false, {});
  assert.equal(http.ok, false);
});

test("parseOpResponse('importLoad') routes to importOk", () => {
  const r = parseOpResponse('importLoad', true, ACK.json);
  assert.equal(r.ok, true);
  assert.equal(r.appMessageLogId, '9314159');
});

test('deliveryOrder: sorts by to.seq (never array order) and excludes the pickup', () => {
  const j = {
    Load: { loadHeader: { loadId: HEXID, loadNbr: 'L' }, stops: [
      { stop: { stopId: 'i3', stopNbr: 'C', stopType: 'DO', to: { seq: 4 } } },
      { stop: { stopId: 'i0', stopNbr: 'WH', stopType: 'PU', to: { seq: 1 } } },
      { stop: { stopId: 'i1', stopNbr: 'A', stopType: 'DO', to: { seq: 2 } } },
      { stop: { stopId: 'i2', stopNbr: 'B', stopType: 'DO', to: { seq: 3 } } },
    ] },
  };
  assert.deepEqual(deliveryOrder(normalizeLoad(j)), ['A', 'B', 'C']);
});

// ── IMPURE: the gate ──────────────────────────────────────────────────────────

test('gate: importLoad/commitImport are OFF by default — zero NuVizz calls when disabled', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  delete process.env.NUVIZZ_LOAD_IMPORT;
  try {
    assert.equal(loadImportEnabled(), false);
    const { requester, calls } = stub([ACK]);
    const r1 = await runOp(requester, 'importLoad', { load: { loadHeader: HDR, stops: [stopRef('A')] } }, CREDS);
    const r2 = await runOp(requester, 'commitImport', { loads: [{ loadHeader: HDR, stops: [stopRef('A')] }] }, CREDS);
    assert.equal(r1.ok, false); assert.equal(r1.gated, true); assert.match(r1.error, /NUVIZZ_LOAD_IMPORT/);
    assert.equal(r2.ok, false); assert.equal(r2.gated, true);
    assert.equal(calls.length, 0);
  } finally { if (prev !== undefined) process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

// ── IMPURE: convergence recipe (fake clock — injected sleep, no real waiting) ──

test('runImportLoad: import → first poll converges (1 POST + 1 GET), ok only from the read-back', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([ACK, loadDoc(['A', 'B', 'C'])]);
    const slept = [];
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS,
      { ...FAST, sleep: async (ms) => { slept.push(ms); } });
    assert.equal(r.ok, true);
    assert.equal(r.converged, true);
    assert.equal(r.loadId, HEXID);
    assert.deepEqual(r.requestedOrder, ['A', 'B', 'C']);
    assert.deepEqual(r.seenOrder, ['A', 'B', 'C']);
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET']);
    assert.match(calls[1].url, /\/load\/info\/DAVIS000000123\/DAVIS$/);
    assert.deepEqual(slept, [5000]);   // paced by the injected clock, not a real timer
  });
});

test('runImportLoad: not converged → re-sends the SAME import, then converges', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      ACK, loadDoc(['C', 'B', 'A']),   // phase 1: wrong order read back
      ACK, loadDoc(['A', 'B', 'C']),   // phase 2 (resend): converged
    ]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET', 'POST', 'GET']);
    // The resend is byte-identical in intent: same stops, same order.
    assert.deepEqual(calls[2].body.loads[0].stops.map((s) => s.stopNbr), ['A', 'B', 'C']);
    assert.deepEqual(r.steps.filter((s) => s.op === 'importLoad').map((s) => s.label), ['import', 'resend']);
  });
});

test('runImportLoad: still stuck → REVERSED then desired order (the verified unstick), then converges', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      ACK, loadDoc(['C', 'B', 'A']),   // phase 1
      ACK, loadDoc(['C', 'B', 'A']),   // phase 2 (resend) — still stuck
      ACK,                             // phase 3a: reversed import
      ACK, loadDoc(['A', 'B', 'C']),   // phase 3b: forward import → converged
    ]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 4);
    assert.deepEqual(posts[2].body.loads[0].stops.map((s) => s.stopNbr), ['C', 'B', 'A']); // reversed
    assert.deepEqual(posts[3].body.loads[0].stops.map((s) => s.stopNbr), ['A', 'B', 'C']); // desired
    assert.deepEqual(r.steps.filter((s) => s.op === 'importLoad').map((s) => s.label),
      ['import', 'resend', 'reverse-unstick', 'forward-after-reverse']);
  });
});

test('runImportLoad: never trusts the 200 alone — unconverged after all phases is ok:false', async () => {
  await withGate(async () => {
    const { requester } = stub([ACK, loadDoc(['C', 'B', 'A'])]); // every read stays wrong
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.converged, false);
    assert.deepEqual(r.seenOrder, ['C', 'B', 'A']);
    assert.match(r.error, /did not converge/);
  });
});

test('runImportLoad: a load/info 404 while the async worker creates the load reads as not-yet-converged', async () => {
  await withGate(async () => {
    const { requester } = stub([
      ACK, { status: 404, json: {} },  // phase 1: brand-new load not visible yet
      ACK, loadDoc(['A', 'B']),        // phase 2: created + converged
    ]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
  });
});

test('runImportLoad: a REJECTED import stops immediately (no polls) with the NuVizz reason', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([{ json: { status: 'FAILURE', reasons: [{ description: 'Either From or To information should be present' }] } }]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
    assert.match(r.error, /From or To/);
  });
});

test('runImportLoad: membership must match too — an omitted stop still on the load is NOT converged', async () => {
  await withGate(async () => {
    // Unplan B by omission: request [A, C]; the load still reads [A, B, C] every poll.
    const { requester } = stub([ACK, loadDoc(['A', 'B', 'C'])]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.deepEqual(r.requestedOrder, ['A', 'C']);
  });
});

test('runCommitImport: one import per load, in payload order; a stuck SOURCE halts later loads', async () => {
  await withGate(async () => {
    // Move a stop from load 1 (source, imported WITHOUT it) to load 2 (destination, WITH it).
    const HDR2 = { ...HDR, loadNbr: 'DAVIS000000124', routeName: 'TEST ROUTE 8' };
    const ok2 = {
      json: { Load: { loadHeader: { loadId: 'a1b2c3d4e5f60718293a4b5c', loadNbr: HDR2.loadNbr }, versionId: 'v1', loadExecutionInfo: {}, stops: [
        { stop: { stopId: 'id-B', stopNbr: 'B', stopType: 'DO', to: { seq: 2 } } },
        { stop: { stopId: 'id-X', stopNbr: 'X', stopType: 'DO', to: { seq: 3 } } },
      ] } },
    };
    const { requester, calls } = stub([ACK, loadDoc(['A']), ACK, ok2]);
    const r = await runCommitImport(requester, { loads: [
      { loadHeader: HDR, stops: [stopRef('A')] },                 // source: X omitted → unplanned
      { loadHeader: HDR2, stops: [stopRef('B'), stopRef('X')] },  // destination: X seated last
    ] }, CREDS, FAST);
    assert.equal(r.ok, true);
    assert.equal(r.loads.length, 2);
    assert.equal(r.skipped, 0);
    // Source fired before destination (order preserved).
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts[0].body.loads[0].loadHeader.loadNbr, HDR.loadNbr);
    assert.equal(posts[1].body.loads[0].loadHeader.loadNbr, HDR2.loadNbr);

    // And a source that never converges halts the batch — the destination must not "steal".
    const stuck = stub([ACK, loadDoc(['A', 'X'])]); // X never leaves the source
    const r2 = await runCommitImport(stuck.requester, { loads: [
      { loadHeader: HDR, stops: [stopRef('A')] },
      { loadHeader: HDR2, stops: [stopRef('B'), stopRef('X')] },
    ] }, CREDS, FAST);
    assert.equal(r2.ok, false);
    assert.equal(r2.loads.length, 1);
    assert.equal(r2.skipped, 1);
    assert.ok(!stuck.calls.some((c) => c.method === 'POST' && c.body?.loads?.[0]?.loadHeader?.loadNbr === HDR2.loadNbr));
  });
});

// ── the Compare-panel Save through the import engine (runCommitBoardImport) ──
//
// Same commitBoard payload + result shape as the legacy engine — the Routing tab's
// Beta/LIVE Save flips onto the import path purely via the NUVIZZ_LOAD_IMPORT switch.

import { runCommitBoardImport } from '../netlify/functions/lib/nuvizz-write.mts';
import { importRefFromRaw, assembleImportHeader } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const FROM_ADDR = { name: 'DAVIS WAREHOUSE', addr1: '1 Depot Rd', city: 'Atlanta', state: 'GA', zip: '30303', country: 'USA' };
const toBlock = (n) => ({
  address: { name: `CONSIGNEE ${n}`, addr1: `${n} Main St`, city: 'Macon', state: 'GA', zip: '31201', country: 'USA' },
  schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York' },
});
// A raw load/info doc: header WITHOUT flat origin fields (like a real load), stops carrying
// full from/to blocks — what the import engine echoes back as references.
const rawLoadDoc = (loadNbr, loadId, nbrs) => ({
  json: { Load: {
    loadHeader: { loadId, loadNbr, routeName: `RT ${loadNbr}`, earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00' },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    stops: nbrs.map((n, i) => ({ stop: {
      stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO',
      from: { address: FROM_ADDR },
      to: { seq: i + 2, ...toBlock(n) },
    } })),
  } },
});
const stopDoc = (n, onLoadNbr) => ({
  json: { Stop: {
    stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: toBlock(n) },
    stopExecutionInfo: { stopStatus: 'OP' },
    ...(onLoadNbr ? { load: { loadNbr: onLoadNbr } } : {}),
  } },
});
const NOSLEEP = { pollMs: 5000, phaseWaitMs: 5000, sleep: async () => {} };
const L1 = 'DAVIS000000201', L1ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const L2 = 'DAVIS000000202', L2ID = 'aaaaaaaaaaaaaaaaaaaaaaa2';

test('importRefFromRaw: whitelisted echo of the raw "to" block; null without an address', () => {
  const raw = { stop: { stopNbr: 'A', stopType: 'DO', to: { seq: 5, ...toBlock('A') } } };
  const ref = importRefFromRaw(raw);
  assert.equal(ref.stopNbr, 'A');
  assert.equal(ref.to.address.addr1, 'A Main St');
  assert.equal(ref.to.address.seq, undefined);          // junk fields never echoed
  assert.equal(ref.to.schedule.timeFrom, '2026-07-02T12:00:00');
  assert.equal(importRefFromRaw({ stop: { stopNbr: 'A' } }), null);   // bare reference = invalid
});

test('assembleImportHeader: origin trust order — flat header > stop from-address > client ship-from', () => {
  const base = { loadNbr: L1, routeName: 'RT', earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00' };
  const rawStops = [{ stop: { from: { address: FROM_ADDR } } }];
  const client = { name: 'CLIENT WHSE', addr1: '9 Client Way', city: 'Buford', state: 'GA', zip: '30518' };

  const flat = assembleImportHeader({ ...base, origin: 'WHSE', originName: 'FLAT', originAddr1: 'F1', originCity: 'FC', originState: 'GA', originZip: '1' }, rawStops, client, null);
  assert.equal(flat.originName, 'FLAT');
  const fromStops = assembleImportHeader(base, rawStops, client, null);
  assert.equal(fromStops.originName, 'DAVIS WAREHOUSE');
  const fromClient = assembleImportHeader(base, [], client, null);
  assert.equal(fromClient.originName, 'CLIENT WHSE');
  assert.equal(fromClient.loadTimeZone, 'EST');
  assert.throws(() => assembleImportHeader(base, [], null, null), /origin block/);
  // Dates: header wins; else derived from the fallback service date; else refuse.
  const derived = assembleImportHeader({ loadNbr: L1 }, rawStops, null, '2026-07-03');
  assert.equal(derived.earliestStartDttm, '2026-07-03T06:00:00');
  assert.throws(() => assembleImportHeader({ loadNbr: L1 }, rawStops, null, null), /earliest\/latest/);
});

test('board Save (import mode): reorder = ONE import echoing the load\'s own records + convergence + assign', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B', 'C']),   // fetchLoad (raw to blocks)
      ACK,                                      // the ONE import
      rawLoadDoc(L1, L1ID, ['C', 'A', 'B']),   // poll: converged to the requested order
      { json: { status: 'Success' } },          // assignDriver
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['C', 'A', 'B'], driverId: 77 },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    assert.equal(r.loads.length, 1);
    assert.equal(r.loads[0].ok, true);
    // The import body: stops[] in the DESIRED order, each a reference echoed from load/info,
    // header origin echoed from the stops' from-address (no flat fields on the header).
    const imp = calls.find((c) => /load\/update\/default/.test(c.url));
    assert.deepEqual(imp.body.loads[0].stops.map((s) => s.stopNbr), ['C', 'A', 'B']);
    assert.equal(imp.body.loads[0].stops[0].to.address.addr1, 'C Main St');
    assert.equal(imp.body.loads[0].loadHeader.originName, 'DAVIS WAREHOUSE');
    assert.equal(imp.body.loads[0].loadHeader.earliestStartDttm, '2026-07-02T06:00:00');
    // Steps carry the import + converge trail, then the assign (client "fired" logic keys on ok steps).
    assert.deepEqual(r.loads[0].steps.map((s) => s.op), ['importLoad', 'converge', 'assignDriver']);
    // No anchor-engine calls anywhere: no load/edit, no insertstops.
    assert.ok(!calls.some((c) => /load\/edit|insertstops/.test(c.url)));
  });
});

test('board Save (import mode): planning UNPLANNED orders — refs read via stop/info; empty load origin falls back to the client ship-from', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, []),                 // fetchLoad: an EMPTY load (no stops to echo origin from)
      stopDoc('X'),                             // getStop X (unplanned)
      stopDoc('Y'),                             // getStop Y (unplanned)
      ACK,                                      // import
      rawLoadDoc(L1, L1ID, ['X', 'Y']),         // poll: converged
    ]);
    const r = await runCommitBoardImport(requester, {
      loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['X', 'Y'] }],
      origin: { name: 'CLIENT WHSE', addr1: '9 Client Way', city: 'Buford', state: 'GA', zip: '30518' },
    }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    const imp = calls.find((c) => /load\/update\/default/.test(c.url));
    assert.deepEqual(imp.body.loads[0].stops.map((s) => s.stopNbr), ['X', 'Y']);
    assert.equal(imp.body.loads[0].stops[0].to.address.name, 'CONSIGNEE X');
    assert.equal(imp.body.loads[0].loadHeader.originName, 'CLIENT WHSE');   // client fallback used
  });
});

test('board Save (import mode): steal guard — a stop still planned on a load OUTSIDE the Save is refused', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A']),
      stopDoc('X', 'DAVIS000000999'),           // X is planned on a load not in this Save
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['A', 'X'] },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, false);
    assert.match(r.loads[0].error, /not part of this Save/);
    assert.ok(!calls.some((c) => /load\/update\/default/.test(c.url)));   // nothing imported
  });
});

test('board Save (import mode): cross-load move runs the SOURCE import before the destination', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      // The resolve pass reads loads in PAYLOAD order (destination listed first below):
      rawLoadDoc(L2, L2ID, ['B']),               // fetchLoad L2 (destination)
      stopDoc('X', L1),                          // getStop X for L2's add (source IS in the batch)
      rawLoadDoc(L1, L1ID, ['A', 'X']),          // fetchLoad L1 (source, holds X)
      // …but the IMPORTS must run source-first:
      ACK, rawLoadDoc(L1, L1ID, ['A']),          // L1 import (without X) + converge
      ACK, rawLoadDoc(L2, L2ID, ['B', 'X']),     // L2 import (with X) + converge
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      // Destination listed FIRST on purpose — the engine must still run the source first.
      { loadNbr: L2, loadId: L2ID, orderedStopNbrs: ['B', 'X'] },
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['A'] },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    const imports = calls.filter((c) => /load\/update\/default/.test(c.url)).map((c) => c.body.loads[0].loadHeader.loadNbr);
    assert.deepEqual(imports, [L1, L2]);
  });
});

test('board Save (import mode): driver-only and emptyLoad loads still ride the legacy engine', async () => {
  await withGate(async () => {
    // Driver-only (no order change, trustable loadId): legacy assign — ONE call, no getLoad/import.
    const a = stub([{ json: { status: 'Success' } }]);
    const r1 = await runCommitBoardImport(a.requester, { loads: [{ loadNbr: L1, loadId: L1ID, driverId: 9 }] }, CREDS, NOSLEEP);
    assert.equal(r1.ok, true);
    assert.equal(a.calls.length, 1);
    assert.match(a.calls[0].url, /assignanddispatch/);

    // emptyLoad: the legacy cancel path (getLoad + removeStops), NEVER an empty import.
    const b = stub([
      rawLoadDoc(L1, L1ID, ['A']),
      { json: { status: 'SUCCESS' } },           // load/edit removing the last delivery (cancels)
    ]);
    const r2 = await runCommitBoardImport(b.requester, { loads: [{ loadNbr: L1, loadId: L1ID, emptyLoad: true, orderedStopNbrs: [] }] }, CREDS, NOSLEEP);
    assert.equal(r2.ok, true);
    assert.ok(b.calls.some((c) => /load\/edit/.test(c.url)));
    assert.ok(!b.calls.some((c) => /load\/update\/default/.test(c.url)));
  });
});

test('runOp(commitBoard): the gate is the ONLY switch — off = legacy engine untouched', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  delete process.env.NUVIZZ_LOAD_IMPORT;
  try {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B']),
      { json: { status: 'SUCCESS' } },   // legacy remove
      { json: { status: 'SUCCESS' } },   // legacy insert
    ]);
    const r = await runOp(requester, 'commitBoard', { loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => /load\/edit/.test(c.url)));                       // anchor engine ran
    assert.ok(!calls.some((c) => /load\/update\/default/.test(c.url)));           // import never fired
  } finally { if (prev !== undefined) process.env.NUVIZZ_LOAD_IMPORT = prev; }
});
