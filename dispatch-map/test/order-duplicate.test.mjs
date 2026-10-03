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
  parseDuplicateNotes, duplicateNoteComment, duplicateNotesMissing, DUPLICATE_NOTES_MAX,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { LEAN_STOP_FIELDS, CUSTOMER_STOP_FIELDS } from '../netlify/functions/lib/board-fields.mts';
import { runDuplicateOrder, runOp, DUP_PROBE_MAX, siteWriteFeatures as serverWriteFeatures } from '../netlify/functions/lib/nuvizz-write.mts';
import writeHandler from '../netlify/functions/nuvizz-write.mts';
import { siteWriteFeatures as clientWriteFeatures, siteWriteFeaturesNow } from '../src/lib/nuvizzWrite.js';
import { etDayString } from '../netlify/functions/lib/firestore.mts';
import {
  copyBaseNbr as clientCopyBaseNbr, duplicateEligible, defaultCopyDate, duplicateDraft, duplicateOutcome,
  parseCopyWeight as clientParseCopyWeight, DUPLICATE_FIELDS, duplicateBaseline, duplicateFormFrom, duplicateEdits,
  duplicateEditLabels, duplicateFormError, copyNbrDraft, duplicateCountChanges, duplicateChangeLabels,
  clockOf, duplicateCopiedFacts, duplicateNotCopied,
  originalPrice, duplicateCopyPrice, duplicatePriceLine, duplicateNotesDraft, duplicateNotesLine, NOTE_SHOW_TO,
  DUPLICATE_NOTES_MAX as CLIENT_NOTES_MAX,
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

test('a copy of an Estes order keeps the ESTES profile under a TYPED number, and the ledger is told what went', async () => {
  const estes = original({ stopNbr: 'ESTES-0538243875', shipmentNbr: '0538243875', proNumber: '0538243875', reference1: 'PO 99812' });
  assert.equal(buildDuplicateStop(estes, '0538249999', OPTS()).stop.profile, 'ESTES');
  assert.equal('profile' in buildDuplicateStop(original(), '007174789-1', OPTS()).stop, false, 'a Davis order\'s copy carries no profile key at all');
  const nv = fakeNuvizz({ held: { 'ESTES-0538243875': estes } });
  const r = await runDuplicateOrder(nv.requester, P({ stopNbr: 'ESTES-0538243875', copyNbr: '0538249999' }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stopNbr, '0538249999');
  assert.equal(JSON.parse(created(nv.calls)[0].body).stop.profile, 'ESTES', 'the create NuVizz receives carries it');
  assert.equal(r.profile, 'ESTES', 'the result names it for the created-order ledger');
  const davis = await runDuplicateOrder(fakeNuvizz({ held: { '007174789': original() } }).requester, P(), CREDS);
  assert.equal(davis.profile, null);
  const saved = process.env.NUVIZZ_ESTES_PROFILE;
  try {
    process.env.NUVIZZ_ESTES_PROFILE = 'off';
    assert.equal('profile' in buildDuplicateStop(estes, '0538249999', OPTS()).stop, false, 'the switch takes it off the copy too');
  } finally {
    if (saved === undefined) delete process.env.NUVIZZ_ESTES_PROFILE; else process.env.NUVIZZ_ESTES_PROFILE = saved;
  }
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
  // A price goes on the copy only when the tick is set (v1.110.0) — typed or not.
  assert.deepEqual(duplicateEdits({ ...plain, price: '$40' }, base), {}, 'a price in the box with the tick off sends nothing');
  assert.deepEqual(duplicateEdits({ ...plain, price: '$40', priceOn: true }, base), { price: '$40' });
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
  assert.match(src, /const editLabels = duplicateChangeLabels\(edits, duplicateCountChanges\(stop, draft\), baselineRef\.current\);/, 'the panel\'s line is built from both');
});

test('the form refuses before a call what the server would: a missing address part, a bad ZIP or number', () => {
  const ok = { name: 'A', addr1: '1 MAIN', city: 'B', state: 'GA', zip: '30518', copyNbr: '', price: '' };
  assert.equal(duplicateFormError(ok), null);
  assert.match(duplicateFormError({ ...ok, city: ' ' }), /needs a city/);
  assert.match(duplicateFormError({ ...ok, zip: '305' }), /not a ZIP/);
  assert.match(duplicateFormError({ ...ok, copyNbr: 'AB#1' }), /characters NuVizz does not take/);
});

test('a field left as it opened never blocks the copy: a board row with no state, or an odd ZIP, is copied from NuVizz', () => {
  // The list carries no state column (nuvizz-list toBoardStop pins state to null); only the
  // enrichment fills it. v1.108.0 duplicated such an order — the server copies NuVizz's state.
  const stop = { stopNbr: '007185553', businessName: 'ACME', addr1: '1 MAIN', city: 'BUFORD', state: null, zip: '30518' };
  const base = duplicateBaseline(stop);
  const form = duplicateFormFrom(stop, null);
  assert.equal(duplicateFormError(form, base), null, 'the server copies the original\'s state');
  assert.deepEqual(duplicateEdits(form, base), {}, '… because nothing is sent for it');
  assert.equal(duplicateFormError({ ...form, zip: '30518 1234' }, { ...base, zip: '30518 1234' }), null, 'an odd ZIP left alone');
  // What the dispatcher changes is still checked before a call.
  assert.match(duplicateFormError({ ...form, city: '' }, base), /needs a city/, 'a field cleared');
  assert.match(duplicateFormError({ ...form, zip: '305' }, base), /not a ZIP/);
  assert.match(duplicateFormError({ ...form, state: 'GA' }, base) ?? 'ok', /^ok$/, 'a state typed in is fine');
  assert.match(duplicateFormError(form), /needs a state/, 'with no baseline every field counts as changed');
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const formError = form \? duplicateFormError\(form, baselineRef\.current\) : null;/);
  assert.match(src, /const asOriginal = \(k\) => \(String\(baselineRef\.current\?\.\[k\] \?\? ''\)\.trim\(\) \? undefined : 'as the original'\);/, 'a blank box says the copy takes the original\'s');
  assert.match(src, /field\('state', 'State', \{ maxLength: 30, placeholder: asOriginal\('state'\) && 'same' \}\)/, 'the narrow State box says it in a word that fits');
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
  assert.match(panel, /const request = \{ pro, stopId: stop\?\.stopId \|\| null, pallets: draft\.pallets, loose: draft\.loose, weight: draft\.weight, date: draft\.date, copyPrice, copyNbr, edits, notes \};/);
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

// ── THE FLOATING WINDOW (v1.109.1) ──────────────────────────────────────────
// Chad, 10/03: "if i click duplicate order i want a large floating window to come up not a fullscreen
// and i don't want to leave the page but i want a large full window so i can see the full route
// profile when duplicating with all the fields i can change."

test('the window shows what the copy takes as it is, in the server\'s own terms', () => {
  assert.equal(clockOf('2026-10-03T08:00:00'), '8:00 AM');
  assert.equal(clockOf('2026-10-03T14:05:00'), '2:05 PM');
  assert.equal(clockOf('2026-10-03T00:30:00'), '12:30 AM');
  assert.equal(clockOf('2026-10-03T12:00:00'), '12:00 PM');
  assert.equal(clockOf(null), '');
  assert.equal(clockOf('2026-10-03'), '', 'a day with no clock time is not a time');
  const full = {
    stopNbr: '007174789', scheduledFrom: '2026-10-03T08:00:00', scheduledTo: '2026-10-03T14:00:00', timeConstraint: 'STRICT',
    origin: { name: 'DAVIS DELIVERY SERVICE', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GA' }, poRef: 'PO 99812', custRef: 'CUST 7',
  };
  const by = (facts) => Object.fromEntries(facts.map((f) => [f.key, f.value]));
  assert.deepEqual(by(duplicateCopiedFacts(full, '')), {
    window: '8:00 AM – 2:00 PM, strict, on the day picked',
    pickup: 'DAVIS DELIVERY SERVICE, 943 GAINESVILLE HWY, BUFORD GA',
    po: 'PO 99812', cust: 'CUST 7',
  });
  // A list-only row's scheduledFrom is its estimated ARRIVAL with no end — never shown as a window.
  assert.equal(by(duplicateCopiedFacts({ stopNbr: 'X', scheduledFrom: '2026-10-03T13:05:00', scheduledTo: null }, '')).window, 'the original\'s times, on the day picked');
  // New Order's own "PRO <number>" follows the copy's number, as buildDuplicateStop writes it.
  assert.equal(by(duplicateCopiedFacts({ ...full, poRef: 'PRO 007174789' }, '')).po, 'PRO + the copy\'s number');
  assert.equal(by(duplicateCopiedFacts({ ...full, poRef: 'PRO 007174789' }, '007174789-SPLIT')).po, 'PRO 007174789-SPLIT');
  // An empty reference on the board row is not "none": the list carries none and mergeEnrich skips an empty one.
  const bare = by(duplicateCopiedFacts({ stopNbr: '1' }, ''));
  assert.equal(bare.po, 'the original\'s, or PRO + the copy\'s number if it has none');
  assert.equal(bare.cust, 'the original\'s, if any');
  assert.equal(bare.pickup, 'the original\'s');
  assert.equal(duplicateNotCopied({ routeName: 'GEORGE L', driverName: 'GEORGE LEONARD' }), 'Not copied: route GEORGE L, driver GEORGE LEONARD, and attachments. The copy lands unplanned.');
  assert.equal(duplicateNotCopied({}), 'Not copied: the route, the driver, and attachments. The copy lands unplanned.');
});

test('Duplicate opens a large FLOATING window over the page — never full screen, never a page change', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const panel = src.slice(src.indexOf('function DuplicateOrderPanel('), src.indexOf('function StopLiveDetail('));
  // The card keeps its button; the window is rendered on <body> so no drawer or sidebar can trap it.
  assert.match(panel, /<button type="button" onClick=\{begin\}[\s\S]*?Duplicate as a new order\s*<\/button>\s*\{\/\*/);
  assert.match(panel, /\{open && createPortal\([\s\S]*?document\.body,\s*\)\}/);
  // Floating: a margin all round and 90% of the height at most; large: up to 5xl wide.
  assert.match(panel, /className="fixed inset-0 z-\[1350\] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true"/);
  assert.match(panel, /className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-\[90dvh\] flex flex-col overflow-hidden" data-duplicate-form/);
  // Two columns from a tablet up; one on a phone.
  assert.match(panel, /<div className="grid gap-x-6 gap-y-3 md:grid-cols-2">/);
  // Cancel and Create side by side on one row.
  assert.match(panel, /<div className="flex flex-wrap items-center justify-end gap-2">\s*<button type="button" onClick=\{close\} disabled=\{busy\}[\s\S]*?\{msg\?\.created \? 'Close' : 'Cancel'\}<\/button>\s*<button type="button" onClick=\{create\} disabled=\{busy \|\| !!error\}/);
  // A long edit is never lost to Esc or a stray click; Cancel and ✕ always close.
  assert.match(panel, /softCloseRef\.current = \(\) => \{ if \(!touched \|\| msg\?\.created\) close\(\); \};/);
  assert.match(panel, /const onKey = \(e\) => \{ if \(e\.key === 'Escape'\) softCloseRef\.current\?\.\(\); \};/);
  assert.match(panel, /<div className="absolute inset-0 bg-black\/50" onClick=\{\(\) => softCloseRef\.current\?\.\(\)\} \/>/);
  // A portal's events bubble through React to the card's handlers — the window keeps them.
  assert.match(panel, /onClick=\{swallow\} onMouseDown=\{swallow\} onPointerDown=\{swallow\} onTouchStart=\{swallow\}/);
  // The Esc effect runs before the early returns (hooks in a fixed order).
  assert.ok(panel.indexOf("const softCloseRef = useRef(null);") < panel.indexOf('if (!duplicateEligible(stop)) return null;'));
  // What the copy takes as it is, shown in the window.
  assert.match(panel, /const copied = duplicateCopiedFacts\(stop, copyNbrDraft\(form\?\.copyNbr\)\.nbr\);/);
  assert.match(panel, /\{duplicateNotCopied\(stop\)\}/);
});

// ── PRICE AND NOTES ON THE COPY (v1.110.0) ──────────────────────────────────
// Chad, 10/03: "give me a stop to add notes for dispatcher or driver also put the original price in the
// box but leave the copy to duplicate unchecked default and also make it an editable field the price
// incase it's more or know."

test('the price box opens on the original\'s price, editable, and nothing goes on the copy until the tick is set', () => {
  // The original's price is NuVizz's Seal #, kept inside `raw` by every enrichment and served to the Map feed.
  assert.ok(LEAN_STOP_FIELDS.includes('raw.stop.sealNbr'), 'the Map feed serves the original\'s price');
  assert.ok(!CUSTOMER_STOP_FIELDS.includes('raw.stop.sealNbr'), 'the customer feed does not');
  const stop = { stopNbr: '007174789', businessName: 'A', addr1: '1 MAIN', city: 'B', state: 'GA', zip: '30518', raw: { stop: { sealNbr: ' 185.00 ' } } };
  assert.equal(originalPrice(stop), '185.00');
  assert.equal(originalPrice({}), '');
  const base = duplicateBaseline(stop);
  const form = duplicateFormFrom(stop, null);
  assert.equal(form.price, '185.00', 'the box opens on the original\'s price');
  assert.equal(form.priceOn, false, 'the tick is off by default');
  assert.deepEqual(form.notes, []);
  assert.deepEqual(duplicateEdits(form, base), {}, 'tick off: no price on the copy');
  assert.equal(duplicateCopyPrice(form), false);
  assert.equal(duplicatePriceLine(form, base), 'No price on the copy.');
  const on = { ...form, priceOn: true };
  assert.deepEqual(duplicateEdits(on, base), { price: '185.00' }, 'ticked: the box goes on the copy');
  assert.deepEqual(duplicateChangeLabels(duplicateEdits(on, base), [], base), [], 'the original\'s own price is a copy, not a change');
  assert.equal(duplicatePriceLine(on, base), 'Price on the copy: 185.00.');
  const more = { ...on, price: '210.00' };
  assert.deepEqual(duplicateEdits(more, base), { price: '210.00' }, 'more or less: the box as typed');
  assert.deepEqual(duplicateChangeLabels(duplicateEdits(more, base), [], base), ['price']);
  assert.equal(duplicatePriceLine(more, base), 'Price on the copy: 210.00 (the original\'s is 185.00).');
  // A row our board holds no price for: the tick with an empty box copies NuVizz's own, as before.
  const bare = duplicateFormFrom({ ...stop, raw: undefined }, null);
  assert.equal(bare.price, '');
  assert.equal(duplicateCopyPrice({ ...bare, priceOn: true }), true);
  assert.deepEqual(duplicateEdits({ ...bare, priceOn: true }, duplicateBaseline({ ...stop, raw: undefined })), {});
  assert.equal(duplicatePriceLine({ ...bare, priceOn: true }, {}), 'Price on the copy: the original\'s, as NuVizz holds it.');
  // A price too long for NuVizz blocks only when it would be sent.
  assert.equal(duplicateFormError({ ...form, price: 'X'.repeat(21) }, base), null);
  assert.match(duplicateFormError({ ...form, price: 'X'.repeat(21), priceOn: true }, base), /longer than NuVizz takes/);
  // The server side is unchanged: a typed price wins, copyPrice copies the original's own.
  assert.equal(buildDuplicateStop(original(), 'X-1', OPTS({ edits: { price: '210.00' } })).stop.sealNbr, '210.00');
  assert.equal(buildDuplicateStop(original(), 'X-1', OPTS()).stop.sealNbr, undefined, 'no tick, no price');
});

test('notes for the dispatcher or driver: checked the same on both sides, before any call', () => {
  assert.deepEqual(NOTE_SHOW_TO, [['both', 'Both'], ['dispatcher', 'Dispatcher'], ['driver', 'Driver']], 'the stop card\'s own Show to words');
  assert.equal(CLIENT_NOTES_MAX, DUPLICATE_NOTES_MAX);
  const rows = [{ text: ' call Bob on arrival ', audience: 'driver' }, { text: '   ', audience: 'both' }, { text: 'bill the extra pallet', audience: 'dispatcher' }];
  const want = [{ text: 'call Bob on arrival', audience: 'driver' }, { text: 'bill the extra pallet', audience: 'dispatcher' }];
  assert.deepEqual(parseDuplicateNotes(rows), { notes: want }, 'an empty row is not a note');
  assert.deepEqual(duplicateNotesDraft(rows), { notes: want }, 'the screen agrees');
  assert.equal(duplicateNotesLine(rows), 'Adds 2 notes: driver only, dispatcher only.');
  assert.equal(duplicateNotesLine([]), '');
  assert.deepEqual(parseDuplicateNotes(null), { notes: [] });
  assert.match(parseDuplicateNotes([{ text: 'x', audience: 'customer' }]).error, /Both, Dispatcher or Driver/);
  assert.match(parseDuplicateNotes([{ text: 'x'.repeat(501), audience: 'both' }]).error, /500 characters/);
  assert.match(duplicateNotesDraft([{ text: 'x'.repeat(501), audience: 'both' }]).error, /500 characters/);
  const six = Array.from({ length: 6 }, (_, i) => ({ text: `n${i}`, audience: 'both' }));
  assert.match(parseDuplicateNotes(six).error, /up to 5/);
  assert.match(duplicateNotesDraft(six).error, /up to 5/);
  assert.match(parseDuplicateNotes('call bob').error, /did not arrive as a list/);
  // The comment each note becomes: the card's Add note shape (PVST_IN + who sees it), no portal `key`.
  assert.deepEqual(duplicateNoteComment({ text: 'bill the extra pallet', audience: 'dispatcher' }), { cmtType: 'PVST_IN', accessLevels: ['DISPATCHER'], commentDescription: 'bill the extra pallet' });
  assert.deepEqual(duplicateNoteComment({ text: 'x', audience: 'both' }).accessLevels, ['DRIVER', 'DISPATCHER']);
});

test('the copy carries the notes after its driver instructions, and the read-back proves each one landed', async () => {
  const notes = [{ text: 'call Bob on arrival', audience: 'driver' }, { text: 'bill the extra pallet', audience: 'dispatcher' }];
  const s = buildDuplicateStop(original(), '007174789-1', OPTS({ notes })).stop;
  assert.deepEqual(s.comments.map((c) => [c.cmtType, c.commentDescription, c.accessLevels.join('+')]), [
    ['ORD_IN', 'CALL 30 MIN AHEAD', 'DISPATCHER+DRIVER'],
    ['PVST_IN', 'call Bob on arrival', 'DRIVER'],
    ['PVST_IN', 'bill the extra pallet', 'DISPATCHER'],
  ]);
  assert.ok(s.comments.every((c) => !('key' in c)), 'the create\'s Comment schema has no key');
  assert.equal(buildDuplicateStop(original(), '007174789-1', OPTS()).stop.comments.length, 1, 'no notes: the comments are as before');
  // The read-back: text AND audience must match; NuVizz's own metadata and case are ignored.
  const back = { comments: [{ commentDescription: 'call Bob on arrival', accessLevels: ['driver'], addedByName: 'API' }] };
  assert.deepEqual(duplicateNotesMissing(back, notes), [notes[1]]);
  assert.deepEqual(duplicateNotesMissing({ comments: [{ commentDescription: 'bill the extra pallet', accessLevels: ['DRIVER', 'DISPATCHER'] }] }, [notes[1]]), [notes[1]], 'a dispatcher-only note shown to the driver is NOT the note that was sent');
  // End to end: the create carries them, the read-back finds them, the answer counts them.
  const nv = fakeNuvizz({ held: { '007174789': original() } });
  const r = await runDuplicateOrder(nv.requester, P({ notes }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.notesAdded, 2);
  assert.deepEqual(JSON.parse(created(nv.calls)[0].body).stop.comments.filter((c) => c.cmtType === 'PVST_IN').map((c) => c.commentDescription), ['call Bob on arrival', 'bill the extra pallet']);
  // A NuVizz that drops a note: the copy exists, and the answer says what did not come back.
  const lossy = fakeNuvizz({ held: { '007174789': original() }, onCreate: (stop) => ({ ...stop, comments: stop.comments.filter((c) => c.cmtType !== 'PVST_IN') }) });
  const bad = await runDuplicateOrder(lossy.requester, P({ notes }), CREDS);
  assert.equal(bad.created, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /2 new notes did not come back as sent \(“call Bob on arrival”, “bill the extra pallet”\)/);
  // A bad note is refused before ANY NuVizz call.
  const none = fakeNuvizz({ held: { '007174789': original() } });
  const refused = await runDuplicateOrder(none.requester, P({ notes: [{ text: 'x', audience: 'everyone' }] }), CREDS);
  assert.equal(refused.ok, false);
  assert.equal(none.calls.length, 0);
});

test('the dry run names the notes; the window shows the price, the tick and the notes', async () => {
  const res = await writeHandler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', body: JSON.stringify({ op: 'duplicateOrder', dryRun: true, payload: { stopNbr: '007174789', pallets: 4, notes: [{ text: 'call Bob', audience: 'driver' }, { text: 'bill it', audience: 'dispatcher' }] } }),
  }));
  const plan = (await res.json()).plan;
  assert.ok(plan.includes('ADD 2 notes on the copy (PVST_IN): driver only, dispatcher only'), JSON.stringify(plan));
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const panel = src.slice(src.indexOf('function DuplicateOrderPanel('), src.indexOf('function StopLiveDetail('));
  assert.match(panel, /<input type="checkbox" checked=\{!!form\?\.priceOn\} disabled=\{busy\}[\s\S]*?Put this price on the copy/);
  assert.match(panel, /const copyPrice = duplicateCopyPrice\(form\);/);
  assert.match(panel, /\{NOTE_SHOW_TO\.map\(\(\[k, label\]\) => \(/);
  assert.match(panel, /Add a note for the dispatcher or driver/);
  assert.match(panel, /\{duplicatePriceLine\(form, baselineRef\.current\)\} \{duplicateNotesLine\(notesRows\)\}/);
  assert.match(panel, /const notes = duplicateNotesDraft\(form\?\.notes\)\.notes \|\| \[\];/);
});

test('the pickup line reads the original\'s own pickup off the Map feed', () => {
  // The Map feed serves raw.stop.from (board-fields.mts) and never `origin`.
  assert.ok(LEAN_STOP_FIELDS.includes('raw.stop.from') && !LEAN_STOP_FIELDS.includes('origin'));
  const facts = duplicateCopiedFacts({ stopNbr: '1', raw: { stop: { from: { address: { name: 'DAVIS DELIVERY SERVICE', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GA' } } } } }, '');
  assert.equal(facts.find((f) => f.key === 'pickup').value, 'DAVIS DELIVERY SERVICE, 943 GAINESVILLE HWY, BUFORD GA');
});

test('a price left as our board showed it, where NuVizz now holds another: the copy gets what was sent, and the answer says so', async () => {
  // The original in NuVizz holds 185.00 (the fixture's sealNbr); the board had read 150.00 before it changed.
  const stale = await runDuplicateOrder(fakeNuvizz({ held: { '007174789': original() } }).requester, P({ edits: { price: '150.00' }, priceWas: '150.00' }), CREDS);
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stale.price, '150.00', 'what the dispatcher saw and sent');
  assert.ok(stale.warnings.includes('the copy got 150.00, the price our board showed — NuVizz holds 185.00 for the original now'), JSON.stringify(stale.warnings));
  // The board's price matches NuVizz's: no word. A price typed different on purpose: no word either.
  const same = await runDuplicateOrder(fakeNuvizz({ held: { '007174789': original() } }).requester, P({ edits: { price: '185.00' }, priceWas: '185.00' }), CREDS);
  assert.ok(!same.warnings.some((w) => /our board showed/.test(w)));
  const typed = await runDuplicateOrder(fakeNuvizz({ held: { '007174789': original() } }).requester, P({ edits: { price: '210.00' }, priceWas: '185.00' }), CREDS);
  assert.ok(!typed.warnings.some((w) => /our board showed/.test(w)));
  assert.equal(typed.price, '210.00');
  const none = await runDuplicateOrder(fakeNuvizz({ held: { '007174789': original() } }).requester, P(), CREDS);
  assert.equal(none.price, null, 'no tick: no price');
  // The answer names the notes and the price the copy got.
  const o = duplicateOutcome({ ok: true, result: { ok: true, created: true, stopNbr: '007174789-1', now: { pallets: 4, total: 4 }, deliveryDate: TOMORROW, edited: [], notesAdded: 2, price: '210.00', warnings: [] } });
  assert.match(o.text, /unplanned, 2 new notes, price 210\.00\. It reaches the board/);
  assert.match(duplicateOutcome({ ok: true, result: { ok: true, created: true, stopNbr: 'X-1', now: { pallets: 1, total: 1 }, edited: [], price: null, warnings: [] } }).text, /unplanned, no price\./);
  // The panel sends the price the box opened on only when a price is being sent.
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /priceWas: edits\.price !== undefined \? baselineRef\.current\?\.price \|\| '' : ''/);
});
