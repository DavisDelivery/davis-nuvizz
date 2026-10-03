// test/order-duplicate.test.mjs
//
// §DUP — DUPLICATING AN ORDER AS {original}-N (v1.107.0).
//
// Chad, 2026-10-02: "make it where i can duplicate an order essentially we can do it as creating a
// new order and way we make the pro number is its original pro-1 then if we duplicate the same
// order twice it would be original pro-2 so on an so forth."
//
// The rules this file pins, each named for the real-world event it prevents:
//   • the number is the ORIGINAL's plus the next free -N; a carrier id is never cut to its prefix;
//   • a number NuVizz already holds is NEVER written — stop/sync/update would replace that order —
//     and "could not tell" is never read as "free";
//   • a create that landed is never repeated by a retry, even when its read-back failed;
//   • the copy carries the original's consignee, window, references and instructions, and never the
//     price unless asked, nor the original's ATT failed-delivery marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  copyBaseNbr, copyNbr, parseCopyWeight, buildDuplicateStop, opLedgerStatus, STOP_NBR_MAX,
  WRITE_OPS, MUTATING_OPS, parseDuplicateEdits, parseCopyNumber, DUPLICATE_EDIT_FIELDS,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runDuplicateOrder, runOp, DUP_PROBE_MAX, siteWriteFeatures as serverWriteFeatures } from '../netlify/functions/lib/nuvizz-write.mts';
import writeHandler from '../netlify/functions/nuvizz-write.mts';
import { siteWriteFeatures as clientWriteFeatures, siteWriteFeaturesNow } from '../src/lib/nuvizzWrite.js';
import { etDayString } from '../netlify/functions/lib/firestore.mts';
import {
  copyBaseNbr as clientCopyBaseNbr, duplicateEligible, defaultCopyDate, duplicateDraft, duplicateOutcome,
  parseCopyWeight as clientParseCopyWeight, DUPLICATE_FIELDS, duplicateBaseline, duplicateFormFrom, duplicateEdits,
  duplicateEditLabels, duplicateFormError, copyNbrDraft, duplicateCountChanges, duplicateChangeLabels,
} from '../src/lib/order-duplicate.js';
import { installFirestoreFake } from './_firestore-fake.mjs';

// The fake installs a throwaway service account into process.env and never takes it out, so every
// test after it would see Firestore as ENABLED with the real fetch back in place — a registry read
// or a copy claim would then go to the real network. Restore the env with the fetch.
async function withFirestoreFake(seed, fn) {
  const saved = { FIREBASE_SA: process.env.FIREBASE_SA, NUVIZZ_BASE_URL: process.env.NUVIZZ_BASE_URL, FIRESTORE_DATABASE: process.env.FIRESTORE_DATABASE };
  const fs = installFirestoreFake(seed, undefined, { commitSemantics: true });
  try { return await fn(fs); } finally {
    fs.restore();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
import handler from '../netlify/functions/nuvizz-write.mts';

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };
const ID = '6a63c5844524f7f7b8ab5410';
const TODAY = etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const TOMORROW = addDays(TODAY, 1);

// A Davis order as NuVizz holds it, on TOMORROW's board, with the extras a copy must handle.
const original = (over = {}) => ({
  stopId: ID, stopNbr: '007174789', stopType: 'DO', shipmentNbr: 'ATT007174789', proNumber: '007174789',
  reference1: 'PRO 007174789', reference2: 'ACME CUST 55', sealNbr: '185.00',
  weight: 4200, weightUOM: 'LBS', totalCartons: 10, totalPallets: 10,
  to: {
    address: { addressType: 'ANY', name: 'ACME DIST', addr1: '500 MAIN ST', addr2: 'DOCK 4', city: 'LAWRENCEVILLE', state: 'GEORGIA', zip: '30046', country: 'UNITED STATES' },
    contact: { contactName: 'RECEIVING', phone: '7705551212', email: 'dock@acme.example' },
    schedule: { timeFrom: `${TOMORROW}T08:00:00`, timeTo: `${TOMORROW}T14:00:00`, timeZone: 'America/New_York', timeConstraint: 'STRICT' },
    documents: [{ documentName: 'BOL', documentType: '03', documentExtType: 'pdf', reference: 'guid-1' }],
  },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY SERVICE', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  stopDetails: [{ product: 'APPLIANCES', productIdentifier: '007174789', quantity: 10, quantityUOM: 'PCS', stopDetailSeq: 1 }],
  comments: [
    { cmtType: 'ORD_IN', commentType: '01', accessLevels: ['DISPATCHER', 'DRIVER'], commentDescription: 'CALL 30 MIN AHEAD' },
    { cmtType: 'PVST_IN', commentType: '01', accessLevels: ['DISPATCHER'], commentDescription: 'internal only' },
  ],
  ...over,
});
const OPTS = (over = {}) => ({ pallets: 4, loose: 0, weight: 1680, date: TOMORROW, copyPrice: false, ...over });

// ── pure: the number ─────────────────────────────────────────────────────────

test('copyBaseNbr: duplicates are numbered from the ORIGINAL, and a carrier id stays whole', () => {
  const table = [
    ['007174789', '007174789'], ['007174789-1', '007174789'], ['007174789-12', '007174789'],
    ['ESTES-0538243875', 'ESTES-0538243875'], ['ESTES-0538243875-2', 'ESTES-0538243875'],
    ['AVRT-0028093763', 'AVRT-0028093763'], ['RA60109098', 'RA60109098'], ['UPS-12', 'UPS-12'],
    [' 007174789-3 ', '007174789'], ['', ''], [null, ''],
  ];
  for (const [nbr, want] of table) {
    assert.equal(copyBaseNbr(nbr), want, `server: ${nbr}`);
    assert.equal(clientCopyBaseNbr(nbr), want, `screen agrees: ${nbr}`);
  }
});

test('copyNbr: never cut to fit NuVizz\'s 20 characters — a shortened number could be another order', () => {
  assert.equal(copyNbr('007174789', 1), '007174789-1');
  assert.equal(copyNbr('ESTES-0538243875', 2), 'ESTES-0538243875-2');
  assert.equal(copyNbr('ABCDEFGHIJKLMNOPQR', 1), 'ABCDEFGHIJKLMNOPQR-1', '18 + "-1" is exactly 20 — fits');
  assert.equal(copyNbr('ABCDEFGHIJKLMNOPQRS', 1), null, '19 + "-1" is 21 — refused, never cut');
  assert.equal(copyNbr('ABCDEFGHIJKLMNOPQR', 10), null, 'a two-digit suffix that no longer fits');
  assert.equal(copyNbr('007174789', 0), null);
  assert.equal(copyNbr('007174789', 100), null);
  assert.equal(STOP_NBR_MAX, 20);
});

test('parseCopyWeight: blank keeps the original\'s, otherwise pounds from 0 up — screen and server agree', () => {
  for (const [v, want] of [['', { weight: null }], [null, { weight: null }], ['1680', { weight: 1680 }], ['12.5', { weight: 12.5 }]]) {
    assert.deepEqual(parseCopyWeight(v), want);
    assert.deepEqual(clientParseCopyWeight(v), want);
  }
  for (const bad of ['-1', 'heavy', '1e5']) {
    assert.match(parseCopyWeight(bad).error, /weight must be/);
    assert.deepEqual(clientParseCopyWeight(bad), parseCopyWeight(bad));
  }
});

// ── pure: the copy ───────────────────────────────────────────────────────────

test('buildDuplicateStop: the copy is the original\'s delivery, with its own number, counts and day', () => {
  const b = buildDuplicateStop(original(), '007174789-1', OPTS());
  assert.ok(!b.error, b.error);
  const s = b.stop;
  assert.equal(s.stopNbr, '007174789-1');
  assert.equal(s.stopType, 'DO');
  assert.equal(s.to.address.name, 'ACME DIST');
  assert.equal(s.to.address.addr1, '500 MAIN ST');
  assert.equal(s.to.address.addr2, 'DOCK 4');
  assert.equal(s.to.address.state, 'GA', 'the 2-letter state the create contract proved, not NuVizz\'s long echo');
  assert.equal(s.to.address.addressType, 'ANY', 'literal, so NuVizz cannot resolve it away');
  assert.equal(s.to.contact.phone, '7705551212');
  assert.equal(s.to.contact.email, 'dock@acme.example');
  assert.deepEqual([s.to.schedule.timeFrom, s.to.schedule.timeTo, s.to.schedule.timeConstraint], [`${TOMORROW}T08:00:00`, `${TOMORROW}T14:00:00`, 'STRICT'],
    'the original\'s window — a STRICT 8–2 copied as a 12–5 PREFERRED would be a different delivery');
  assert.equal(s.from.address.addr1, '943 GAINESVILLE HWY');
  assert.equal(s.from.address.state, 'GA');
  assert.equal(s.totalCartons, 4);
  assert.equal(s.totalPallets, 4);
  assert.equal(s.weight, 1680);
  assert.equal(s.stopDetails[0].product, 'APPLIANCES', 'the commodity line comes from the original\'s line item');
  assert.equal(s.stopDetails[0].quantity, 4, '… with the copy\'s own count');
  assert.equal(s.comments[0].commentDescription, 'CALL 30 MIN AHEAD', 'the driver instructions ride along');
  assert.equal(s.comments.length, 1, 'a dispatcher-only note is not turned into a driver instruction');
  assert.equal(s.to.documents, undefined, 'never the original\'s files');
  assert.deepEqual(b.warnings, []);
});

test('buildDuplicateStop: numbers, references and the ATT marker', () => {
  const s = buildDuplicateStop(original(), '007174789-1', OPTS()).stop;
  assert.equal(s.shipmentNbr, '007174789-1', 'the ORIGINAL\'s "ATT" failed-delivery marker is not carried onto a new order');
  assert.equal(s.proNumber, '007174789', 'the PRO digits field keeps the original\'s PRO — not 0071747891, nobody\'s PRO');
  assert.equal(s.reference1, 'PRO 007174789-1', 'New Order\'s own "PRO <number>" follows the copy\'s number');
  assert.equal(s.reference2, 'ACME CUST 55', 'the customer ref belongs to the shipment and rides across');
  const carrier = buildDuplicateStop(original({ stopNbr: 'ESTES-0538243875', proNumber: '0538243875', reference1: 'PO 99812', reference2: 'CUST 7' }), 'ESTES-0538243875-1', OPTS()).stop;
  assert.equal(carrier.reference1, 'PO 99812', 'a carrier\'s PO is echoed verbatim');
  assert.equal(carrier.proNumber, '0538243875');
});

test('buildDuplicateStop: the price is copied only when asked — a duplicate is not a second sale', () => {
  assert.equal(buildDuplicateStop(original(), '007174789-1', OPTS()).stop.sealNbr, undefined);
  assert.equal(buildDuplicateStop(original(), '007174789-1', OPTS({ copyPrice: true })).stop.sealNbr, '185.00');
  const none = buildDuplicateStop(original({ sealNbr: undefined }), '007174789-1', OPTS({ copyPrice: true }));
  assert.ok(none.warnings.some((w) => /no price/.test(w)));
});

test('buildDuplicateStop: a copy for another day keeps the appointment TIMES on that day', () => {
  const later = addDays(TODAY, 5);
  const s = buildDuplicateStop(original(), '007174789-1', OPTS({ date: later })).stop;
  assert.equal(s.to.schedule.timeFrom, `${later}T08:00:00`);
  assert.equal(s.to.schedule.timeTo, `${later}T14:00:00`);
  assert.equal(s.from.schedule.timeFrom.slice(0, 10), later);
});

test('buildDuplicateStop: half a window is refused, said, and replaced by the standard one', () => {
  const b = buildDuplicateStop(original({ to: { ...original().to, schedule: { timeFrom: `${TOMORROW}T18:30:00` } } }), '007174789-1', OPTS());
  assert.equal(b.stop.to.schedule.timeFrom, `${TOMORROW}T12:00:00`);
  assert.equal(b.stop.to.schedule.timeTo, `${TOMORROW}T17:00:00`);
  assert.ok(b.warnings.some((w) => /no whole delivery window/.test(w)));
});

test('buildDuplicateStop: refuses what it cannot copy honestly', () => {
  assert.match(buildDuplicateStop(original({ stopType: 'PU' }), 'X-1', OPTS()).error, /PICKUP/);
  assert.match(buildDuplicateStop(original({ to: { address: { name: 'ACME', addr1: '' } } }), 'X-1', OPTS()).error, /no complete delivery address/);
  assert.match(buildDuplicateStop(original({ from: {} }), 'X-1', OPTS()).error, /no complete pickup/);
  assert.match(buildDuplicateStop(original(), 'X-1', OPTS({ date: 'friday' })).error, /not a YYYY-MM-DD/);
  assert.match(buildDuplicateStop(original(), '123456789012345678901', OPTS()).error, /does not fit/);
});

test('duplicateOrder is a mutating write op (behind NUVIZZ_WRITE_ENABLED)', () => {
  assert.ok(WRITE_OPS.includes('duplicateOrder'));
  assert.ok(MUTATING_OPS.has('duplicateOrder'));
});

test('opLedgerStatus: a duplicate that LANDED is done, so a retry replays it instead of making a second copy', () => {
  assert.equal(opLedgerStatus('duplicateOrder', { ok: false, created: true, unverified: true }), 'succeeded');
  assert.equal(opLedgerStatus('duplicateOrder', { ok: false, created: false }), 'failed');
  assert.equal(opLedgerStatus('duplicateOrder', { ok: true, created: true }), 'succeeded');
  assert.equal(opLedgerStatus('setStopPieces', { ok: false, created: true }), 'failed', 'only the duplicate has this rule');
  assert.equal(opLedgerStatus('commitBoard', { ok: true }), 'succeeded');
});

// ── end to end, against a fake NuVizz that holds orders by number ─────────────

function fakeNuvizz({ held = {}, probeAnswer = null, createAnswer = null, onCreate = null, readBackFails = false } = {}) {
  const stops = new Map(Object.entries(held));
  const calls = [];
  let seq = 0;
  const requester = {
    async request(url, opts) {
      const method = opts.method || 'GET';
      calls.push({ url, method, body: opts.body });
      const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
      const m = url.match(/\/stop\/info\/([^/]+)\//);
      if (m) {
        const nbr = decodeURIComponent(m[1]);
        if (readBackFails && stops.has(nbr) && stops.get(nbr).__created) return J({}, 500);
        if (stops.has(nbr)) return J({ Stop: { stop: stops.get(nbr), stopExecutionInfo: { stopStatus: 'DELIVERED' }, load: {} } });
        if (probeAnswer) return probeAnswer(nbr, J);
        return J({ errors: [{ message: 'Stop not found' }] }, 404);
      }
      if (url.includes('/stop/sync/update/')) {
        const { stop } = JSON.parse(opts.body);
        if (createAnswer) return createAnswer(stop, J);
        const id = `6a63c5844524f7f7b8ac${String(++seq).padStart(4, '0')}`;
        const storedStop = onCreate ? onCreate(stop) : stop;
        stops.set(stop.stopNbr, { ...storedStop, stopId: id, __created: true });
        return J({ status: 'SUCESS', apiResult: { created: 1, updated: 0, failed: 0 }, entityInfoList: [{ entityId: id, entityNbr: stop.stopNbr }] });
      }
      return J({}, 404);
    },
  };
  return { requester, calls, stops };
}
const P = (over = {}) => ({ stopNbr: '007174789', stopId: ID, pallets: 4, loose: '', weight: '1680', date: TOMORROW, ...over });
const created = (calls) => calls.filter((c) => c.url.includes('/stop/sync/update/'));

test('runDuplicateOrder: -1 free → read, prove -1 absent, create, read back: 4 calls', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  const r = await runDuplicateOrder(nv.requester, P(), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.stopNbr, '007174789-1');
  assert.equal(r.copyOf, '007174789');
  assert.deepEqual(r.now, { pallets: 4, loose: 0, total: 4 }, 'read back from the created order');
  assert.equal(r.deliveryDate, TOMORROW);
  assert.deepEqual(nv.calls.map((c) => `${c.method} ${c.url.split('/v7')[1].split('/DAVIS')[0]}`), [
    'GET /stop/info/007174789', 'GET /stop/info/007174789-1', 'POST /stop/sync/update', 'GET /stop/info/007174789-1',
  ]);
  assert.deepEqual(r.calls, { reads: 3, writes: 1 });
});

test('runDuplicateOrder: the original duplicated twice is -1 then -2 — Chad\'s own example', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  const a = await runDuplicateOrder(nv.requester, P(), CREDS);
  const b = await runDuplicateOrder(nv.requester, P(), CREDS);
  assert.equal(a.stopNbr, '007174789-1');
  assert.equal(b.stopNbr, '007174789-2');
  assert.deepEqual(b.skipped, [{ nbr: '007174789-1', why: 'already in NuVizz' }], 'the -1 that exists was SKIPPED, never written');
  assert.equal(created(nv.calls).length, 2);
  assert.ok(created(nv.calls).every((c) => JSON.parse(c.body).stop.stopNbr !== '007174789'), 'the original is never the create target');
});

test('runDuplicateOrder: duplicating a COPY numbers from the original', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original(), '007174789-1': original({ stopNbr: '007174789-1', stopId: '6a63c5844524f7f7b8ab7777' }) } });
  const r = await runDuplicateOrder(nv.requester, P({ stopNbr: '007174789-1', stopId: '6a63c5844524f7f7b8ab7777' }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stopNbr, '007174789-2', 'never 007174789-1-1');
});

test('runDuplicateOrder: a carrier order keeps its whole id', async () => {
  const nv = fakeNuvizz({ held: { 'ESTES-0538243875': original({ stopNbr: 'ESTES-0538243875', proNumber: '0538243875' }) } });
  const r = await runDuplicateOrder(nv.requester, P({ stopNbr: 'ESTES-0538243875' }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stopNbr, 'ESTES-0538243875-1');
});

test('runDuplicateOrder: "could not tell" is never "free" — a 5xx or an empty 200 on the probe refuses the create', async () => {
  for (const [label, answer] of [
    ['500', (nbr, J) => J({ error: 'boom' }, 500)],
    ['empty 200', (nbr, J) => J({})],
    ['400', (nbr, J) => J({ errors: [{ message: 'bad request' }] }, 400)],
  ]) {
    const nv = fakeNuvizz({ held: { '007174789': original() }, probeAnswer: answer });
    const r = await runDuplicateOrder(nv.requester, P(), CREDS);
    assert.equal(r.ok, false, label);
    assert.match(r.error, /could not prove 007174789-1 is free/, label);
    assert.equal(created(nv.calls).length, 0, `${label}: nothing created`);
  }
});

test(`runDuplicateOrder: the hunt stops after ${DUP_PROBE_MAX} NuVizz reads, creating nothing`, async () => {
  const held = { '007174789': original() };
  for (let n = 1; n <= 5; n++) held[`007174789-${n}`] = original({ stopNbr: `007174789-${n}`, stopId: `6a63c5844524f7f7b8ab000${n}` });
  const nv = fakeNuvizz({ held });
  const r = await runDuplicateOrder(nv.requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /007174789-1, 007174789-2, 007174789-3 are already taken/);
  assert.equal(r.calls.reads, 1 + DUP_PROBE_MAX, 'the original plus the capped probes — no more');
  assert.equal(created(nv.calls).length, 0);
});

test('runDuplicateOrder: NuVizz answering UPDATED instead of created is an alarm, never a success', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() }, createAnswer: (stop, J) => J({ status: 'SUCESS', apiResult: { created: 0, updated: 1 }, entityInfoList: [{ entityId: 'x', entityNbr: stop.stopNbr }] }) });
  const r = await runDuplicateOrder(nv.requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.alarm, true);
  assert.equal(r.created, true, 'something was written, so a retry must not run again');
  assert.match(r.error, /UPDATED an existing order 007174789-1/);
});

test('runDuplicateOrder: a create whose read-back fails is reported as created-unverified, with "do not press again"', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() }, readBackFails: true });
  const r = await runDuplicateOrder(nv.requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.created, true);
  assert.equal(r.unverified, true);
  assert.match(r.error, /Do not press Duplicate again first — it would make another copy/);
  assert.equal(opLedgerStatus('duplicateOrder', r), 'succeeded', 'and the ledger replays this answer to a retry');
});

test('runDuplicateOrder: a copy that reads back with other counts is reported, not claimed', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() }, onCreate: (stop) => ({ ...stop, totalCartons: 10, totalPallets: 10 }) });
  const r = await runDuplicateOrder(nv.requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.created, true);
  assert.match(r.error, /reads back differently — pallets reads 10 \(expected 4\)/);
});

test('runDuplicateOrder: refuses before the hunt — the other order sharing the number, a pickup, a record with no id', async () => {
  const twin = fakeNuvizz({ held: { '007174789': original({ stopId: '6a63c5844524f7f7b8ab9999' }) } });
  const t = await runDuplicateOrder(twin.requester, P(), CREDS);
  assert.equal(t.wrongInstance, true);
  assert.equal(twin.calls.length, 1);
  const pu = fakeNuvizz({ held: { RA60109098: original({ stopNbr: 'RA60109098', stopType: 'PU' }) } });
  const p = await runDuplicateOrder(pu.requester, P({ stopNbr: 'RA60109098', stopId: undefined }), CREDS);
  assert.match(p.error, /PICKUP/);
  assert.equal(pu.calls.length, 1, 'refused after the one read, before any probe');
  const noId = fakeNuvizz({ held: { '007174789': original({ stopId: undefined }) } });
  const n = await runDuplicateOrder(noId.requester, P({ stopId: undefined }), CREDS);
  assert.match(n.error, /no stopId of its own/);
  assert.equal(noId.calls.length, 1);
});

test('runDuplicateOrder: an order number with no room for "-1" is refused before any probe', async () => {
  const long = 'ABCDEFGHIJKLMNOPQRS';   // 19 characters
  const nv = fakeNuvizz({ held: { [long]: original({ stopNbr: long }) } });
  const r = await runDuplicateOrder(nv.requester, P({ stopNbr: long }), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /longer than NuVizz's 20-character order number/);
  assert.equal(nv.calls.length, 1);
});

test('runDuplicateOrder: bad input, a day already gone, or the switch off — ZERO NuVizz calls', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  assert.match((await runDuplicateOrder(nv.requester, P({ pallets: 0, loose: 0 }), CREDS)).error, /cancel the order/);
  assert.match((await runDuplicateOrder(nv.requester, P({ weight: 'heavy' }), CREDS)).error, /weight must be/);
  assert.match((await runDuplicateOrder(nv.requester, P({ date: addDays(TODAY, -1) }), CREDS)).error, /has already gone/);
  const saved = process.env.NUVIZZ_DUPLICATE_ORDER;
  try {
    process.env.NUVIZZ_DUPLICATE_ORDER = 'off';
    const r = await runOp(nv.requester, 'duplicateOrder', P(), CREDS);
    assert.equal(r.blocked, true);
    assert.match(r.error, /NUVIZZ_DUPLICATE_ORDER/);
    process.env.NUVIZZ_DUPLICATE_ORDER = 'oof';
    assert.equal((await runOp(nv.requester, 'duplicateOrder', P(), CREDS)).blocked, undefined, 'a typo leaves it on');
  } finally {
    if (saved === undefined) delete process.env.NUVIZZ_DUPLICATE_ORDER; else process.env.NUVIZZ_DUPLICATE_ORDER = saved;
  }
  assert.equal(nv.calls.filter((c) => c.url.includes('/stop/info/007174789/')).length, 1, 'only the last run (switch typo) reached NuVizz');
});

test('runDuplicateOrder: a number our own records already know is skipped for FREE', async () => {
  await withFirestoreFake({ 'nuvizz_enriched/davis/pros/007174789-1': { stopNbr: '007174789-1', enriched: true } }, async (fs) => {
    const nv = fakeNuvizz({ held: { '007174789': original() } });
    const r = await runDuplicateOrder(nv.requester, P(), CREDS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stopNbr, '007174789-2');
    assert.deepEqual(r.skipped, [{ nbr: '007174789-1', why: 'already in our records' }]);
    assert.equal(nv.calls.some((c) => c.url.includes('/stop/info/007174789-1/')), false, 'no NuVizz read spent on -1');
    assert.equal(fs.log.other.length, 0);
  });
});

test('THE RACE: a number another duplicate has just claimed is skipped, never written twice', async () => {
  // Two dispatchers duplicate the same order at once. Both read -1 as not found; only the claim
  // tells them apart. Here the other one already holds -1.
  await withFirestoreFake({ 'nuvizz_copy_claims/davis__007174789-1': { stopNbr: '007174789-1', copyOf: '007174789' } }, async (fs) => {
    const nv = fakeNuvizz({ held: { '007174789': original() } });
    const r = await runDuplicateOrder(nv.requester, P(), CREDS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stopNbr, '007174789-2');
    assert.deepEqual(r.skipped, [{ nbr: '007174789-1', why: 'being created by another duplicate right now' }]);
    assert.equal(created(nv.calls).length, 1);
    assert.equal(JSON.parse(created(nv.calls)[0].body).stop.stopNbr, '007174789-2');
    assert.ok(fs.store.has('nuvizz_copy_claims/davis__007174789-2'), 'and this one holds -2');
  });
});

test('a create NuVizz refuses gives its claimed number back', async () => {
  await withFirestoreFake({}, async (fs) => {
    const nv = fakeNuvizz({ held: { '007174789': original() }, createAnswer: (stop, J) => J({ status: 'FAILURE', errors: [{ message: 'zip invalid' }] }, 400) });
    const r = await runDuplicateOrder(nv.requester, P(), CREDS);
    assert.equal(r.ok, false);
    assert.equal(r.created, undefined, 'nothing was created');
    assert.match(r.error, /NuVizz refused to create 007174789-1/);
    assert.equal(fs.store.has('nuvizz_copy_claims/davis__007174789-1'), false, 'the claim was released');
  });
});

test('after the Firestore tests, the env is back: Firestore reads as off again', async () => {
  const { isFirestoreEnabled } = await import('../netlify/functions/lib/firestore.mts');
  assert.equal(isFirestoreEnabled(), false, 'no later test can reach a real Firestore through a leftover service account');
});

test('the dry run describes the duplicate — number hunt first — without a NuVizz call', async () => {
  const res = await handler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', body: JSON.stringify({ op: 'duplicateOrder', dryRun: true, payload: { stopNbr: '007174789-1', pallets: 4, loose: 0, date: TOMORROW } }),
  }));
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.ok(j.plan.some((s) => /FIND the first free number from 007174789-1: .*explicit 404.*never written/.test(s)), JSON.stringify(j.plan));
  assert.ok(j.plan.some((s) => /price NOT copied; lands UNPLANNED/.test(s)));
});

test('the endpoint journals a duplicate and records it in the ledger by opLedgerStatus', () => {
  const src = readFileSync(new URL('../netlify/functions/nuvizz-write.mts', import.meta.url), 'utf8');
  assert.match(src, /op === 'duplicateOrder' && result\?\.created === true/);
  assert.match(src, /status: opLedgerStatus\(op, result\)/);
});

// ── the screen's rules ───────────────────────────────────────────────────────

test('duplicateEligible: deliveries only — a pickup is copied in the portal', () => {
  assert.equal(duplicateEligible({ stopNbr: '007174789', stopType: 'DO' }), true);
  assert.equal(duplicateEligible({ stopNbr: '007174789' }), true);
  assert.equal(duplicateEligible({ stopNbr: 'RA60109098', stopType: 'PU' }), false);
  assert.equal(duplicateEligible({}), false);
});

test('defaultCopyDate: the original\'s day, or today when that day has gone', () => {
  assert.equal(defaultCopyDate({ scheduledFrom: `${TOMORROW}T08:00:00` }, TODAY), TOMORROW);
  assert.equal(defaultCopyDate({ boardDate: addDays(TODAY, -3) }, TODAY), TODAY);
  assert.equal(defaultCopyDate({}, TODAY), TODAY);
});

test('duplicateDraft: what the panel can say before a call is spent', () => {
  assert.deepEqual(duplicateDraft({ pallets: '4', loose: '', weight: '', date: TOMORROW }, TODAY), { pallets: 4, loose: 0, total: 4, weight: null, date: TOMORROW });
  assert.match(duplicateDraft({ pallets: '', loose: '', weight: '', date: TOMORROW }, TODAY).error, /pallets must be/);
  assert.match(duplicateDraft({ pallets: '4', weight: 'x', date: TOMORROW }, TODAY).error, /weight must be/);
  assert.match(duplicateDraft({ pallets: '4', date: '' }, TODAY).error, /pick the delivery day/);
  assert.match(duplicateDraft({ pallets: '4', date: addDays(TODAY, -1) }, TODAY).error, /has already gone/);
});

test('duplicateOutcome: names the number it made, and never invites a second copy after an unverified one', () => {
  const ok = duplicateOutcome({ ok: true, result: { ok: true, created: true, stopNbr: '007174789-1', now: { pallets: 4, loose: null, total: 4 }, deliveryDate: TOMORROW, warnings: [] } });
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.created, true);
  assert.match(ok.text, new RegExp(`^Created 007174789-1 in NuVizz — 4 pallets · 4 pieces for ${TOMORROW}, unplanned`));
  const replay = duplicateOutcome({ ok: true, idempotent: true, result: { ok: true, created: true, stopNbr: '007174789-1', now: { pallets: 4, total: 4 } } });
  assert.match(replay.text, /earlier try of this same request had already made it/);
  const unverified = duplicateOutcome({ ok: false, error: 'duplicateOrder: NuVizz answered that 007174789-1 was created, but reading it back failed — Do not press Duplicate again first', result: { ok: false, created: true, stopNbr: '007174789-1' } });
  assert.equal(unverified.kind, 'warn');
  assert.equal(unverified.created, true);
  // A replayed unverified answer arrives with ok:true at the top and ok:false inside it.
  const replayedUnverified = duplicateOutcome({ ok: true, idempotent: true, result: { ok: false, created: true, stopNbr: '007174789-1', error: 'reading it back failed' } });
  assert.equal(replayedUnverified.kind, 'warn');
  const refused = duplicateOutcome({ ok: false, error: 'duplicateOrder: could not prove 007174789-1 is free', result: { ok: false } });
  assert.deepEqual(refused, { kind: 'err', created: false, nbr: null, text: 'duplicateOrder: could not prove 007174789-1 is free' });
});

test('the stop card mounts the Duplicate panel, and it sends ONE key per request', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /<StopPiecesEditor key=\{stopKey\} stop=\{live\} onRefreshed=\{onRefreshed\} \/>\s*\n\s*<DuplicateOrderPanel key=\{`dup-\$\{stopKey\}`\} stop=\{live\} note=\{note\} \/>/);
  const panel = src.slice(src.indexOf('function DuplicateOrderPanel('), src.indexOf('function StopLiveDetail('));
  assert.match(panel, /opRef\.current = singleOrderOpId\(opRef\.current, request, newClientOpId\);/);
  assert.match(panel, /clientOpId: opRef\.current\.id/);
  assert.match(panel, /if \(outcome\.created\) opRef\.current = \{ id: newClientOpId\(\), sent: null \};/);
  // Offered only when the server would run it — the same switch, read off the dry run.
  assert.match(panel, /siteWriteFeatures\(\)\.then\(\(f\) => \{ if \(live\) setEnabled\(f\?\.duplicateOrder === true\); \}\);/);
  assert.match(panel, /if \(!enabled\) return null;/);
  // A viewer behind the login is never asked (the 403 would raise the role bar over a card they only
  // opened): the ask waits on the role gate, and the button shows greyed out with the reason.
  assert.match(panel, /const gate = useRoleGate\('dispatcher'\);/);
  assert.match(panel, /if \(enabled \|\| !gate\.allowed\) return undefined;/);
  assert.match(panel, /\}, \[enabled, gate\.allowed\]\);/);
  assert.match(panel, /if \(!gate\.allowed\) \{[\s\S]*?<button type="button" disabled title=\{gate\.reason\}[\s\S]*?\{gate\.reason\}/);
  // Order matters: a pickup is never offered; a viewer is told why before the switch is consulted.
  const iElig = panel.indexOf('if (!duplicateEligible(stop)) return null;');
  const iGate = panel.indexOf('if (!gate.allowed) {');
  const iOn = panel.indexOf('if (!enabled) return null;');
  assert.ok(iElig > 0 && iElig < iGate && iGate < iOn, 'eligible → role gate → switch');
});

test('NUVIZZ_DUPLICATE_ORDER=off takes the button away WITH the refusal: the dry run carries the switch the executor checks', async () => {
  // House shape: default ON, an explicit off-word turns it off, anything malformed leaves it ON.
  assert.deepEqual(serverWriteFeatures({}), { duplicateOrder: true });
  assert.deepEqual(serverWriteFeatures({ NUVIZZ_DUPLICATE_ORDER: 'off' }), { duplicateOrder: false });
  assert.deepEqual(serverWriteFeatures({ NUVIZZ_DUPLICATE_ORDER: ' No ' }), { duplicateOrder: false });
  assert.deepEqual(serverWriteFeatures({ NUVIZZ_DUPLICATE_ORDER: 'of' }), { duplicateOrder: true });
  const saved = process.env.NUVIZZ_DUPLICATE_ORDER;
  try {
    for (const [v, want] of [[undefined, true], ['off', false]]) {
      if (v === undefined) delete process.env.NUVIZZ_DUPLICATE_ORDER; else process.env.NUVIZZ_DUPLICATE_ORDER = v;
      const res = await writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
        method: 'POST', body: JSON.stringify({ op: 'duplicateOrder', payload: {}, dryRun: true }),
      }));
      const j = await res.json();
      assert.equal(res.status, 200);
      assert.equal(j.dryRun, true);
      assert.deepEqual(j.features, { duplicateOrder: want }, `NUVIZZ_DUPLICATE_ORDER=${v}`);
      // And the executor refuses exactly when the card hides — before any NuVizz call.
      if (!want) {
        const r = await runDuplicateOrder({ request: async () => { throw new Error('no NuVizz call may be made'); } }, { stopNbr: '007174789', pallets: 4 }, { base: 'x', companyCode: 'X', auth: 'a' });
        assert.equal(r.ok, false);
        assert.match(r.error, /switched off/);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.NUVIZZ_DUPLICATE_ORDER; else process.env.NUVIZZ_DUPLICATE_ORDER = saved;
  }
});

test('the stop card asks once per page load, shows Duplicate only on a clear yes, and asks again after an unclear answer', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  let answer = { status: 502, body: { ok: false, error: 'bad gateway' } };
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal(siteWriteFeaturesNow(), null);
    // A failed ask reads as OFF — a button that creates an order is never shown on a guess…
    assert.deepEqual(await clientWriteFeatures(), {});
    assert.equal(siteWriteFeaturesNow(), null, '…and is not remembered');
    // An answer from a server that does not carry the switches (a deploy mid-rollout) is not a yes.
    answer = { status: 200, body: { ok: true, dryRun: true, plan: [] } };
    assert.deepEqual(await clientWriteFeatures(), {});
    assert.equal(siteWriteFeaturesNow(), null);
    answer = { status: 200, body: { ok: true, dryRun: true, plan: [], features: { duplicateOrder: true } } };
    assert.deepEqual(await clientWriteFeatures(), { duplicateOrder: true });
    assert.deepEqual(siteWriteFeaturesNow(), { duplicateOrder: true });
    await clientWriteFeatures();
    assert.equal(asked.length, 3, 'a clear answer is remembered for the page — no ask per card');
    for (const a of asked) {
      assert.match(a.url, /nuvizz-write$/);
      assert.equal(a.body.op, 'duplicateOrder');
      assert.equal(a.body.dryRun, true, 'the ask is a dry run — zero NuVizz calls');
    }
  } finally { globalThis.fetch = realFetch; }
});


// ── §DUP-E — EDIT THE COPY BEFORE IT IS CREATED (v1.109.0) ──────────────────────
// Chad, 10/03: "when I duplicate I want to have the option to edit the order. Addresses numbers piece
// counts items pretty much anything."

test('the copy\'s edits are checked before any call: a whole address, a real ZIP, state, phone and email', () => {
  assert.deepEqual(parseDuplicateEdits(undefined), { edits: {} });
  assert.deepEqual(parseDuplicateEdits({ addr1: ' 2 DOCK RD ', state: 'georgia', zip: '30519', bogus: 'x' }).edits, { addr1: '2 DOCK RD', state: 'GA', zip: '30519' });
  assert.deepEqual(parseDuplicateEdits({ addr2: '', phone: '', email: '', itemDesc: '', dispatchNotes: '' }).edits, { addr2: '', phone: '', email: '', itemDesc: '', dispatchNotes: '' }, "'' clears an optional field");
  for (const k of ['name', 'addr1', 'city', 'state', 'zip']) assert.match(parseDuplicateEdits({ [k]: '  ' }).error, /cannot be left blank/, k);
  assert.match(parseDuplicateEdits({ zip: '3051' }).error, /not a ZIP/);
  assert.match(parseDuplicateEdits({ state: 'Georgiaa' }).error, /not a US state/);
  assert.match(parseDuplicateEdits({ phone: '12' }).error, /not a phone number/);
  assert.match(parseDuplicateEdits({ email: 'dock at acme' }).error, /not an email/);
  assert.match(parseDuplicateEdits({ price: '$1234567890123456789012' }).error, /longer than NuVizz takes/);
  assert.match(parseDuplicateEdits([1]).error, /list of fields/);
  // The screen and the server name the same fields.
  assert.deepEqual(DUPLICATE_FIELDS.map((f) => f.key), DUPLICATE_EDIT_FIELDS.map((f) => f.key));
  assert.deepEqual(DUPLICATE_FIELDS.filter((f) => f.required).map((f) => f.key), DUPLICATE_EDIT_FIELDS.filter((f) => f.required).map((f) => f.key));
});

test('a typed order number is checked the same on the screen and the server; blank keeps the next free -N', () => {
  for (const [v, want] of [['', null], ['  ', null], [null, null], ['007174789-7', '007174789-7'], ['ESTES-0538243875-B', 'ESTES-0538243875-B']]) {
    assert.equal(parseCopyNumber(v).nbr, want, String(v));
    assert.equal(copyNbrDraft(v).nbr, want, String(v));
  }
  for (const v of ['X'.repeat(21), '-007', 'AB#12', 'PRO\n1']) {
    assert.ok('error' in parseCopyNumber(v), v);
    assert.ok('error' in copyNbrDraft(v), v);
  }
});

test('the copy carries what was changed and copies the rest; cleared fields go out empty, never the original\'s', () => {
  const r = buildDuplicateStop(original(), '007174789-1', OPTS({ edits: {
    name: 'ACME WEST', addr1: '2 DOCK RD', addr2: '', city: 'DULUTH', state: 'GA', zip: '30096',
    phone: '6785550100', email: '', itemDesc: 'FILTERS', dispatchNotes: 'LIFTGATE', price: '$95.00',
  } }));
  const st = r.stop;
  assert.deepEqual([st.to.address.name, st.to.address.addr1, st.to.address.addr2, st.to.address.city, st.to.address.state, st.to.address.zip],
    ['ACME WEST', '2 DOCK RD', undefined, 'DULUTH', 'GA', '30096']);
  assert.equal(st.to.contact.phone, '6785550100');
  assert.equal('email' in st.to.contact, false, 'email cleared, not copied');
  assert.equal(st.stopDetails[0].product, 'FILTERS');
  assert.equal(st.comments[0].commentDescription, 'LIFTGATE');
  assert.equal(st.sealNbr, '$95.00', 'a typed price is sent');
  // Untouched: copied from the original exactly as before.
  assert.equal(st.reference2, 'ACME CUST 55');
  assert.equal(st.from.address.addr1, '943 GAINESVILLE HWY');
  assert.match(st.to.schedule.timeFrom, /T08:00:00$/);
  // No edits at all → byte-identical to the copy this feature always made.
  assert.deepEqual(buildDuplicateStop(original(), '007174789-1', OPTS({ edits: {} })), buildDuplicateStop(original(), '007174789-1', OPTS()));
});

test('a typed price wins over "copy the original\'s"; clearing the items sends no freight line', () => {
  assert.equal(buildDuplicateStop(original(), 'X-1', OPTS({ copyPrice: true, edits: { price: '$10' } })).stop.sealNbr, '$10');
  assert.equal(buildDuplicateStop(original(), 'X-1', OPTS({ copyPrice: true })).stop.sealNbr, '185.00');
  assert.equal(buildDuplicateStop(original(), 'X-1', OPTS({ edits: { itemDesc: '' } })).stop.stopDetails, undefined);
});

test('an original with half an address can still be copied once the dispatcher types the whole one — and never with half', () => {
  const half = original({ to: { ...original().to, address: { addressType: 'ANY', name: 'ACME', addr1: '', city: 'X', state: 'GA', zip: '' } } });
  assert.match(buildDuplicateStop(half, 'X-1', OPTS()).error, /the original has no complete delivery address/);
  const fixed = buildDuplicateStop(half, 'X-1', OPTS({ edits: { addr1: '9 OAK ST', zip: '30518' } }));
  assert.equal(fixed.stop.to.address.addr1, '9 OAK ST');
});

test('runDuplicateOrder with changes: the create carries them, the read-back checks the street that was sent', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  const r = await runDuplicateOrder(nv.requester, P({ edits: { addr1: '2 DOCK RD', city: 'DULUTH', zip: '30096', phone: '6785550100' } }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.edited, ['addr1', 'city', 'zip', 'phone']);
  assert.equal(r.numberTyped, false);
  const sent = JSON.parse(created(nv.calls)[0].body).stop;
  assert.equal(sent.to.address.addr1, '2 DOCK RD');
  assert.equal(sent.to.address.name, 'ACME DIST', 'the untouched consignee is copied');
  // NuVizz storing a different street than the one sent is caught, not reported as done.
  const nv2 = fakeNuvizz({ held: { '007174789': original() }, onCreate: (stop) => ({ ...stop, to: { ...stop.to, address: { ...stop.to.address, addr1: '500 MAIN ST' } } }) });
  const r2 = await runDuplicateOrder(nv2.requester, P({ edits: { addr1: '2 DOCK RD' } }), CREDS);
  assert.equal(r2.ok, false);
  assert.equal(r2.created, true);
  assert.match(r2.error, /its street reads 500 MAIN ST/);
});

test('a bad change is refused before ANY NuVizz call', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  const r = await runDuplicateOrder(nv.requester, P({ edits: { zip: 'ABCDE' } }), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /not a ZIP — 5 digits, or ZIP\+4 — nothing was sent to NuVizz/);
  assert.equal(nv.calls.length, 0);
  const r2 = await runDuplicateOrder(nv.requester, P({ copyNbr: 'AB#1' }), CREDS);
  assert.match(r2.error, /characters NuVizz does not take/);
  assert.equal(nv.calls.length, 0);
});

test('a TYPED number free in NuVizz is used exactly: read, prove it absent, create, read back — 4 calls', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  const r = await runDuplicateOrder(nv.requester, P({ copyNbr: '007174789-SPLIT' }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stopNbr, '007174789-SPLIT');
  assert.equal(r.numberTyped, true);
  assert.deepEqual(nv.calls.map((c) => `${c.method} ${c.url.split('/v7')[1].split('/DAVIS')[0]}`), [
    'GET /stop/info/007174789', 'GET /stop/info/007174789-SPLIT', 'POST /stop/sync/update', 'GET /stop/info/007174789-SPLIT',
  ]);
});

test('a TYPED number NuVizz already holds is refused — never written over, never swapped for another number', async () => {
  const nv = fakeNuvizz({ held: { '007174789': original(), '007185553': original({ stopNbr: '007185553', stopId: '6a63c5844524f7f7b8ab9999' }) } });
  const r = await runDuplicateOrder(nv.requester, P({ copyNbr: '007185553' }), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /order 007185553 is already in NuVizz — a create there would REPLACE that order, so nothing was created/);
  assert.equal(created(nv.calls).length, 0);
  // A read that proves nothing refuses too.
  const nv2 = fakeNuvizz({ held: { '007174789': original() }, probeAnswer: (nbr, J) => J({}, 503) });
  const r2 = await runDuplicateOrder(nv2.requester, P({ copyNbr: '007174789-SPLIT' }), CREDS);
  assert.match(r2.error, /could not prove 007174789-SPLIT is free — NuVizz answered 503/);
  assert.equal(created(nv2.calls).length, 0);
});

test('a TYPED number our records know, or another duplicate is claiming, is refused for free', async () => {
  await withFirestoreFake({ 'nuvizz_enriched/davis/pros/007174789-SPLIT': { stopNbr: '007174789-SPLIT', enriched: true } }, async () => {
    const nv = fakeNuvizz({ held: { '007174789': original() } });
    const r = await runDuplicateOrder(nv.requester, P({ copyNbr: '007174789-SPLIT' }), CREDS);
    assert.match(r.error, /already in our records — nothing was created/);
    assert.equal(nv.calls.some((c) => c.url.includes('/stop/info/007174789-SPLIT/')), false, 'no NuVizz read spent');
  });
  await withFirestoreFake({ 'nuvizz_copy_claims/davis__007174789-SPLIT': { stopNbr: '007174789-SPLIT', copyOf: '007174789' } }, async () => {
    const nv = fakeNuvizz({ held: { '007174789': original() } });
    const r = await runDuplicateOrder(nv.requester, P({ copyNbr: '007174789-SPLIT' }), CREDS);
    assert.match(r.error, /being created by another duplicate right now/);
    assert.equal(created(nv.calls).length, 0);
  });
});

test('the form opens on what the CARD shows, and only what differs from the original is sent', () => {
  const stop = {
    stopNbr: '007174789', businessName: 'ACME DIST', addr1: '500 MAIN ST', addr2: 'DOCK 4', city: 'LAWRENCEVILLE', state: 'GA', zip: '30046',
    contact: { phone: '770-555-1212', email: 'Dock@Acme.example' }, stopDetails: [{ product: 'APPLIANCES' }],
    signalSources: { orderInstructions: 'CALL 30 MIN AHEAD' },
  };
  const base = duplicateBaseline(stop);
  const plain = duplicateFormFrom(stop, null);
  assert.deepEqual(duplicateEdits(plain, base), {}, 'opened and left alone → a straight copy');
  // A corrected address on our board and a saved number are what the card shows — so the copy gets them.
  const note = { address_override: { addr1: '2 DOCK RD', addr2: '', city: 'LAWRENCEVILLE', state: 'GA', zip: '30046' }, contacts: [{ name: 'SAM', phone: '678-555-0100' }] };
  const shown = duplicateFormFrom(stop, note);
  assert.equal(shown.addr1, '2 DOCK RD');
  assert.equal(shown.phone, '678-555-0100');
  assert.deepEqual(duplicateEdits(shown, base), { addr1: '2 DOCK RD', addr2: '', phone: '678-555-0100' });
  // Formatting is not a change: state case, phone punctuation, email case.
  assert.deepEqual(duplicateEdits({ ...plain, state: 'ga', phone: '(770) 555-1212', email: 'dock@acme.example' }, base), {});
  // A price is sent only when typed.
  assert.deepEqual(duplicateEdits({ ...plain, price: '$40' }, base), { price: '$40' });
  assert.deepEqual(duplicateEditLabels({ addr1: 'x', phone: 'y' }), ['street address', 'phone']);
});

test('the line that says what the copy changes names the pallets, weight and day typed too, in form order', () => {
  // Measured in the built app before this: pallets 8 → 4 and the line read "Changed from the
  // original: street address, city, ZIP, items. Everything else is copied." — the 4 left out.
  const stop = { stopNbr: '007185553', cartons: 8, volume: 0, pallets: 8, weight: 4200, scheduledDate: TOMORROW };
  const as = (pallets, loose, weight, date) => duplicateDraft({ pallets, loose, weight, date }, TODAY);
  assert.deepEqual(duplicateCountChanges(stop, as('8', '', '4200', TOMORROW)), [], 'opened and left alone');
  assert.deepEqual(duplicateCountChanges(stop, as('4', '', '4200', TOMORROW)), ['pallets']);
  assert.deepEqual(duplicateCountChanges(stop, as('8', '0', '', TOMORROW)), [], 'loose 0 and none are the same; a blank weight keeps the original\'s');
  assert.deepEqual(duplicateCountChanges(stop, as('8', '3', '4200.0', TOMORROW)), ['loose'], '4200.0 lb is the 4200 already on it');
  assert.deepEqual(duplicateCountChanges(stop, as('8', '', '2100', TOMORROW)), ['weight']);
  const later = addDays(TODAY, 5);
  assert.deepEqual(duplicateCountChanges(stop, as('8', '', '', later)), ['date']);
  // An original with no day on file: the day is not claimed either way.
  assert.deepEqual(duplicateCountChanges({ ...stop, scheduledDate: undefined }, as('8', '', '', later)), []);
  // A count the board does not hold is "none", as the editor reads it — 0 typed is not a change.
  assert.deepEqual(duplicateCountChanges({ ...stop, volume: null }, as('8', '0', '', TOMORROW)), []);
  // A draft that cannot be sent claims nothing: the error is what the panel shows.
  assert.deepEqual(duplicateCountChanges(stop, as('x', '', '', TOMORROW)), []);
  assert.deepEqual(duplicateChangeLabels({ addr1: 'x', city: 'y', zip: 'z', itemDesc: 'i', dispatchNotes: 'n' }, ['date', 'pallets']),
    ['street address', 'city', 'ZIP', 'items', 'pallets', 'delivery day', 'driver instructions']);
  assert.deepEqual(duplicateChangeLabels({}, ['weight']), ['weight']);
  assert.deepEqual(duplicateChangeLabels({}, []), []);
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const editLabels = duplicateChangeLabels\(edits, duplicateCountChanges\(stop, draft\)\);/, 'the panel\'s line is built from both');
});

test('the form refuses before a call what the server would: a missing address part, a bad ZIP or number', () => {
  const ok = { name: 'A', addr1: '1 MAIN', city: 'B', state: 'GA', zip: '30518', copyNbr: '', price: '' };
  assert.equal(duplicateFormError(ok), null);
  assert.match(duplicateFormError({ ...ok, city: ' ' }), /needs a city/);
  assert.match(duplicateFormError({ ...ok, zip: '305' }), /not a ZIP/);
  assert.match(duplicateFormError({ ...ok, copyNbr: 'AB#1' }), /characters NuVizz does not take/);
});

test('the answer names the changes, and the panel sends them with the typed number under ONE key', () => {
  const o = duplicateOutcome({ ok: true, result: { ok: true, created: true, stopNbr: '007174789-1', now: { pallets: 4, total: 4 }, deliveryDate: TOMORROW, edited: ['addr1', 'phone'], warnings: [] } });
  assert.match(o.text, /, with your changes to its street address, phone\./);
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const panel = src.slice(src.indexOf('function DuplicateOrderPanel('), src.indexOf('\nfunction ', src.indexOf('function DuplicateOrderPanel(') + 10));
  for (const k of ['copyNbr', 'name', 'addr1', 'addr2', 'city', 'state', 'zip', 'phone', 'email', 'itemDesc', 'price']) {
    assert.match(panel, new RegExp(`field\\('${k}', `), `${k} is on the form`);
  }
  assert.match(panel, /value=\{form\?\.dispatchNotes \?\? ''\}/);
  assert.match(panel, /const request = \{ pro, stopId: stop\?\.stopId \|\| null, pallets: draft\.pallets, loose: draft\.loose, weight: draft\.weight, date: draft\.date, copyPrice, copyNbr, edits \};/);
  assert.match(panel, /setForm\(duplicateFormFrom\(stop, note\)\);/);
  assert.match(panel, /baselineRef\.current = duplicateBaseline\(stop\);/);
});

test('the dry run names the typed number and the changes; the ledger records them', async () => {
  const res = await writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', body: JSON.stringify({ op: 'duplicateOrder', dryRun: true, payload: { stopNbr: '007174789', pallets: 4, copyNbr: '007174789-SPLIT', edits: { addr1: '2 DOCK RD' } } }),
  }));
  const plan = (await res.json()).plan;
  assert.ok(plan.some((l) => /^USE the number typed for the copy, 007174789-SPLIT: /.test(l)), JSON.stringify(plan));
  assert.ok(plan.some((l) => l === 'CHANGED on the copy (the rest is copied from the original): addr1'));
  const EP = readFileSync(new URL('../netlify/functions/nuvizz-write.mts', import.meta.url), 'utf8');
  assert.match(EP, /edited: Array\.isArray\(result\.edited\) \? result\.edited : \[\], numberTyped: result\.numberTyped === true/);
});
