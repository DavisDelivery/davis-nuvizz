// test/nuvizz-write-inline-create.test.mjs — work item A (inline stop creation on new-load builds):
// a board Save may carry per-load `newStops` (StopRow rows for orders that do NOT exist in NuVizz
// yet). Those ride the import's stops[] as FULL payloads — the §10.1 create-with-order contract
// makes ONE import create the load AND its stops. Asserted here ON THE WIRE (recorded stub
// requests): ZERO stop/sync/update pre-creates, ZERO stop/info echo reads for inline rows, one
// load/update per load, stopIds harvested off the convergence read at zero extra call cost.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommitBoardImport } from '../netlify/functions/lib/nuvizz-write.mts';
import { priorShortCircuits } from '../netlify/functions/lib/write-registries.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const noSleep = async () => {};
const PACING = { pollMs: 1, phaseWaitMs: 1, quick: true, sleep: noSleep };

function stub(scripts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null });
        const s = scripts[Math.min(i, scripts.length - 1)]; i++;
        return new Response(JSON.stringify(s.json ?? {}), { status: s.status ?? 200 });
      },
    },
  };
}

const SETTINGS = { origin: { name: 'ULINE BUFORD', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518' }, serviceDate: '2026-07-02', timeZone: 'America/New_York' };
const row = (nbr, name) => ({ name, addr1: `${nbr} Main St`, city: 'Buford', state: 'GA', zip: '30518', stopNbr: nbr, pallets: '2' });

const ACK = { json: { status: 'Request for LOAD Async import is SUCCESS. Find more info in AppMessageLog with Id- abc-123' } };
const NOT_FOUND = { status: 404, json: {} };
const createdLoad = (loadNbr, loadId, nbrs) => ({ json: { Load: {
  loadHeader: { loadId, loadNbr },
  versionId: 'v1',
  loadExecutionInfo: { loadStatus: 'Draft' },
  stops: nbrs.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: n, stopType: 'DO', to: { seq: i + 2 } } })),
} } });

const urlsOf = (calls, frag) => calls.filter((c) => c.url.includes(frag));

test('CREATE MODE: brand-new loadNbr + all-inline stops = 1 import + 1 read, ZERO pre-creates/echo reads', async () => {
  const { requester, calls } = stub([
    NOT_FOUND,                                           // load/info miss → create mode
    ACK,                                                 // the ONE import
    createdLoad('SQTLOADI', 'li1', ['1001', '1002', '1003']),  // confirm read: created, in order
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', routeName: 'SUW 3', createNew: true, orderedStopNbrs: ['1001', '1002', '1003'], newStops: [row('1001', 'A'), row('1002', 'B'), row('1003', 'C')] }],
    settings: SETTINGS,
  }, CREDS, PACING);

  assert.equal(urlsOf(calls, '/stop/sync/update').length, 0, 'NO per-stop pre-creates');
  assert.equal(urlsOf(calls, '/stop/info').length, 0, 'NO per-add echo reads for inline rows');
  const updates = urlsOf(calls, '/load/update/');
  assert.equal(updates.length, 1, 'exactly ONE import');
  assert.equal(urlsOf(calls, '/load/info/').length, 2, 'one pre-read miss + one confirm read');

  const body = updates[0].body.loads[0];
  assert.equal(body.loadHeader.loadNbr, 'SQTLOADI');
  assert.equal(body.loadHeader.routeName, 'SUW 3');
  // The silent-failure trap fields, derived from the batch settings (create mode has no header to echo).
  assert.equal(body.loadHeader.earliestStartDttm, '2026-07-02T06:00:00');
  assert.equal(body.loadHeader.latestStartDttm, '2026-07-02T18:00:00');
  assert.equal(body.loadHeader.originName, 'ULINE BUFORD');
  assert.equal(body.loadHeader.originZip, '30518');
  // FULL payloads, in exact array order — this is what creates the stops inline.
  assert.deepEqual(body.stops.map((s) => s.stopNbr), ['1001', '1002', '1003']);
  for (const s of body.stops) {
    assert.ok(s.from?.address?.addr1, 'full payload carries the warehouse "from" block');
    assert.ok(s.to?.address?.addr1, 'full payload carries the delivery "to" block');
    assert.equal(s.totalPallets, 2, 'freight fields ride the inline payload');
  }

  assert.equal(r.ok, true);
  assert.equal(r.loads[0].ok, true);
  // stopIds harvested from the SAME confirming read — zero extra calls.
  assert.deepEqual(r.loads[0].stopIds, { 1001: 'id-1001', 1002: 'id-1002', 1003: 'id-1003' });
});

test('CREATE MODE refused when the load number already carries stops (would declaratively rebuild it)', async () => {
  const { requester, calls } = stub([
    createdLoad('SQTLOADI', 'li1', ['9001']),   // load EXISTS with a delivery
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1001'], newStops: [row('1001', 'A')] }],
    settings: SETTINGS,
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/update/').length, 0, 'no import fires');
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /already carries 1 stop/);
});

test('CREATE onto an EXISTING EMPTY Draft load: header echoed from the load, stops inline, 1 import', async () => {
  const emptyDraft = { json: { Load: {
    loadHeader: { loadId: 'ld1', loadNbr: 'DAVIS000198071', routeName: 'SUW 2', earliestStartDttm: '2026-07-02T12:00:00', latestStartDttm: '2026-07-02T23:59:00', originName: 'ULINE', originAddr1: '943 Gainesville Hwy', originCity: 'Buford', originState: 'GA', originZip: '30518', origin: 'WHSE' },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'Draft' }, stops: [],
  } } };
  const { requester, calls } = stub([
    emptyDraft,
    ACK,
    createdLoad('DAVIS000198071', 'ld1', ['1001', '1002']),
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'DAVIS000198071', createNew: true, orderedStopNbrs: ['1001', '1002'], newStops: [row('1001', 'A'), row('1002', 'B')] }],
    settings: SETTINGS,
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/stop/sync/update').length, 0);
  assert.equal(urlsOf(calls, '/stop/info').length, 0);
  const updates = urlsOf(calls, '/load/update/');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.loads[0].loadHeader.loadNbr, 'DAVIS000198071', 'echoed from the Draft load');
  assert.equal(r.loads[0].ok, true);
});

test('MIXED adds: on-load stop echoed, inline row FULL payload, only the genuinely-existing add reads stop/info', async () => {
  const loadJ = { json: { Load: {
    loadHeader: { loadId: 'lj1', loadNbr: 'SQTLOADJ', earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00', originName: 'ULINE', originAddr1: '943 Gainesville Hwy', originCity: 'Buford', originState: 'GA', originZip: '30518', origin: 'WHSE' },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'Draft' },
    stops: [{ stop: { stopId: 'a1', stopNbr: '2001', stopType: 'DO', to: { seq: 2, address: { name: 'A', addr1: '1 A St', city: 'Buford', state: 'GA', zip: '30518', country: 'USA' }, schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' } } } }],
  } } };
  const stopC = { json: { Stop: { stop: { stopId: 'c1', stopNbr: '2003', stopType: 'DO', to: { address: { name: 'C', addr1: '3 C St', city: 'Buford', state: 'GA', zip: '30518', country: 'USA' }, schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' } } }, load: {} } } };
  const { requester, calls } = stub([
    loadJ,                                   // load/info pre-read
    stopC,                                   // stop/info — ONLY for the existing-elsewhere add
    ACK,
    createdLoad('SQTLOADJ', 'lj1', ['2001', '7777', '2003']),
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADJ', orderedStopNbrs: ['2001', '7777', '2003'], newStops: [row('7777', 'NEW GUY')] }],
    settings: SETTINGS,
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/stop/sync/update').length, 0);
  assert.equal(urlsOf(calls, '/stop/info').length, 1, 'stop/info ONLY for the pre-existing add, never the inline row');
  const body = urlsOf(calls, '/load/update/')[0].body.loads[0];
  assert.deepEqual(body.stops.map((s) => s.stopNbr), ['2001', '7777', '2003'], 'array order = grid order');
  assert.ok(!body.stops[0].from, 'on-load stop stays a to-only REFERENCE');
  assert.ok(body.stops[1].from?.address, 'inline row is a FULL payload (creates the stop)');
  assert.ok(!body.stops[2].from, 'getStop-built add stays a to-only reference');
  assert.equal(r.loads[0].ok, true);
});

test('newStops without payload.settings → refused before ANY NuVizz call', async () => {
  const { requester, calls } = stub([ACK]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1001'], newStops: [row('1001', 'A')] }],
  }, CREDS, PACING);
  assert.equal(calls.length, 0, 'zero NuVizz calls');
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /settings/);
});

test('idempotency ledger semantics (convergence directive): only a prior SUCCESS short-circuits', () => {
  assert.equal(priorShortCircuits(null), false, 'no record → fire');
  assert.equal(priorShortCircuits({ status: 'failed' }), false, 'failed prior → the re-send MUST reach the wire');
  assert.equal(priorShortCircuits({ status: 'pending' }), false, 'pending prior (client-verifier Save) → re-send reaches the wire');
  assert.equal(priorShortCircuits({ status: 'succeeded' }), true, 'succeeded prior → deduped (the intended protection)');
});
