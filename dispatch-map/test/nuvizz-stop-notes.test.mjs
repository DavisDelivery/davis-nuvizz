// test/nuvizz-stop-notes.test.mjs
//
// §N — writing a dispatcher/driver note onto a live NuVizz order.
//
// Every shape here is portal-verified from Chad's HAR capture (Jul 24, adding a note
// through the NuVizz UI): POST /v7/stop/partialUpdate/{CC} with {stops:[{…,comments}]},
// answering {"status":"SUCESS","apiResult":{"updated":1,…}}.
//
// The load-bearing fact these tests exist to protect: `comments` is a FULL REPLACE.
// The portal re-sent the new note PLUS every pre-existing ULINE instruction. A writer
// that posts only the new note ERASES "DO NOT BREAKDOWN SKID" / "INSIDE DELIVERY" off
// live freight — so the merge, and the read-back tripwire, are the whole safety story.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStopNoteComment, mergeStopComments, rawStopFrom, stopCommentsFrom,
  stopNoteFingerprint, fingerprintDrift, summarize, buildOpRequest, STOP_NOTE_CMT_TYPE,
  buildNoteWriteStop, echoDrift, driftDetail, PARTIAL_UPDATE_DERIVED_KEYS,
  documentIdentities, documentHandles, documentHandlesMoved, stopDetailIdentities, unsentLosses,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runAddStopNote } from '../netlify/functions/lib/nuvizz-write.mts';

const atPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// The BOL row exactly as order 007150559 returns it (Jul 27) — metadata only, no bytes:
// `documentData` comes back EMPTY because the file itself lives behind the document API.
const BOL = (reference) => ({
  description: '', dispositionType: '01', documentData: '', documentExtType: 'pdf',
  documentName: 'BOL', documentType: '03', documentCategory: '', reference,
});

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };

// The three ULINE comments exactly as NuVizz returns them (full metadata).
const ULINE = (desc) => ({
  commentType: '01', cmtType: 'ORD_IN', accessLevels: ['DRIVER', 'DISPATCHER', 'CUSTOMER'],
  commentDescription: desc, commentTypeDescription: 'Order Instructions',
  addedByName: 'INTG ULINE', addedOn: '2026-07-24T20:05:24', source: 'Order - Order Instructions',
  key: `${desc}|ORD_IN|INTG ULINE|2026-07-24T20:05:24`,
});
const CARRIER = [ULINE('SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID'), ULINE('SPL-INSTR-TEXT: INSIDE DELIVERY'), ULINE('TOTAL-AMOUNT : 55.86')];

const rawStop = (over = {}) => ({
  stopId: '6a63c5844524f7f7b8ab5410', stopNbr: '007152286', stopSeq: 1, stopType: 'DO',
  weight: 58, totalPallets: 1, totalCartons: 1, sealNbr: '$55.86', proNumber: 'G6',
  bol: '1026001700001', reference1: '6103444210', reference2: '1255749', shipmentNbr: '007152286',
  to: { address: { addr1: '200 FANNIE RUSSELL RD', city: 'DAWSONVILLE', state: 'GA', zip: '30534' },
        contact: { phone: '6788787161', email: 'BOBK@SATELLITEINDUSTRIES.COM' },
        schedule: { timeFrom: '2026-07-27T08:00:00:00', timeTo: '2026-07-27T20:00:00:00' } },
  from: { address: { addr1: '943 GAINESVILLE HWY', city: 'BUFORD' } },
  comments: [...CARRIER],
  ...over,
});

// ── pure shape ───────────────────────────────────────────────────────────────

test('buildStopNoteComment: matches the portal payload byte-for-byte (PVST_IN + key)', () => {
  assert.deepEqual(buildStopNoteComment('Test Notes', 'driver'), {
    commentDescription: 'Test Notes', accessLevels: ['DRIVER'],
    cmtType: 'PVST_IN', key: 'Test Notes|DRIVER|PVST_IN',
  });
  assert.deepEqual(buildStopNoteComment('Call on arrival', 'dispatcher').accessLevels, ['DISPATCHER']);
  assert.deepEqual(buildStopNoteComment('Call on arrival').accessLevels, ['DRIVER', 'DISPATCHER'], 'default reaches both panels');
  assert.equal(buildStopNoteComment('  padded  ', 'both').commentDescription, 'padded', 'trimmed');
  assert.equal(buildStopNoteComment('x'.repeat(900), 'both').commentDescription.length, 500, 'clamped');
  for (const bad of ['', '   ', null, undefined]) assert.throws(() => buildStopNoteComment(bad, 'both'), /empty/i);
});

test('rawStopFrom: unwraps every v7 envelope shape (a miss would read comments as EMPTY)', () => {
  const s = rawStop();
  for (const env of [{ Stop: { stop: s } }, { stop: { stop: s } }, { Stop: s }, { stop: s }, s]) {
    assert.equal(rawStopFrom(env).stopNbr, '007152286');
    assert.equal(stopCommentsFrom(rawStopFrom(env)).length, 3);
  }
  assert.deepEqual(stopCommentsFrom(rawStopFrom({ junk: true })), [], 'unknown shape → empty, never throws');
});

test('mergeStopComments: KEEPS every carrier instruction and appends the note', () => {
  const note = buildStopNoteComment('Gate code 4417', 'both');
  const { comments, duplicate } = mergeStopComments(CARRIER, note);
  assert.equal(duplicate, false);
  assert.equal(comments.length, 4, 'three carrier + one new');
  assert.deepEqual(comments.slice(0, 3), CARRIER, 'carrier comments echoed VERBATIM (metadata intact)');
  assert.deepEqual(comments[3], note);
});

test('mergeStopComments: an identical note is a no-op, not a duplicate', () => {
  const note = buildStopNoteComment('Gate code 4417', 'both');
  const once = mergeStopComments(CARRIER, note).comments;
  const twice = mergeStopComments(once, buildStopNoteComment('Gate code 4417', 'both'));
  assert.equal(twice.duplicate, true);
  assert.equal(twice.comments.length, 4, 'no second copy');
  // …but the SAME text aimed at a different audience is a genuinely new note.
  assert.equal(mergeStopComments(once, buildStopNoteComment('Gate code 4417', 'driver')).duplicate, false);
});

test('fingerprint: catches a blanked field, ignores an added comment', () => {
  const before = stopNoteFingerprint(rawStop());
  assert.deepEqual(fingerprintDrift(before, stopNoteFingerprint(rawStop({ comments: [...CARRIER, { commentDescription: 'x' }] }))), [], 'comments are not guarded fields');
  const wiped = rawStop(); wiped.to.contact.phone = ''; wiped.sealNbr = '';
  assert.deepEqual(fingerprintDrift(before, stopNoteFingerprint(wiped)).sort(), ['sealNbr', 'to.contact.phone']);
});

test("summarize accepts NuVizz's own 'SUCESS' misspelling (else a real save reads as failed)", () => {
  assert.equal(summarize(true, { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } }).ok, true);
  assert.equal(summarize(true, { status: 'SUCCESS', apiResult: { updated: 1 } }).ok, true);
  assert.equal(summarize(true, { status: 'PARTIALSUCESS', apiResult: { updated: 1 } }).ok, false, 'partial is still a failure');
  assert.equal(summarize(true, { status: 'FAILURE' }).ok, false);
});

test('buildOpRequest: partialUpdateStop targets /stop/partialUpdate/{CC}', () => {
  const br = buildOpRequest('partialUpdateStop', { stops: [{ stopId: 'a', stopNbr: 'b', comments: [] }] }, CREDS);
  assert.equal(br.url, 'https://portal.example.com/deliverit/openapi/v7/stop/partialUpdate/DAVIS');
  assert.equal(br.method, 'POST');
  assert.deepEqual(JSON.parse(br.body).stops[0].stopNbr, 'b');
  assert.throws(() => buildOpRequest('partialUpdateStop', { stops: [] }, CREDS), /missing stops/);
});

// ── end-to-end through the op runner ─────────────────────────────────────────

function makeRequester({ state, writeStatus = { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } }, onWrite, readFails = false } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
        if (url.includes('/stop/info/')) {
          if (readFails) return J({ error: 'boom' }, 500);
          return J({ Stop: { stop: state.stop } });
        }
        if (url.includes('/stop/partialUpdate/')) {
          const sent = JSON.parse(opts.body).stops[0];
          if (onWrite) onWrite(sent, state);
          else state.stop = { ...state.stop, comments: sent.comments };
          return J(writeStatus);
        }
        return J({}, 404);
      },
    },
  };
}

test('runAddStopNote: appends the note and PRESERVES the carrier instructions', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'Gate code 4417', audience: 'both' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.comments_total, 4);
  const sent = JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
  // partialUpdate is NOT partial (portal HAR): a minimal {stopId,stopNbr,comments} body is
  // rejected with 'SOMETHING WENT WRONG!!, PLEASE TRY AGAIN'. The whole stop goes back.
  for (const k of ['stopId', 'stopNbr', 'comments', 'to', 'from', 'weight', 'sealNbr', 'proNumber']) {
    assert.ok(k in sent, `echo must carry ${k} — NuVizz rejects a partial body`);
  }
  assert.equal(sent.to.address.addr1, rawStop().to.address.addr1, 'echoed values are the ones we READ, unchanged');
  assert.equal(sent.comments.length, 4);
  assert.ok(sent.comments.some((c) => c.commentDescription === 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID'), 'carrier instruction re-sent, not erased');
  // read → write → verify-read
  assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 2);
  assert.equal(calls.filter((c) => c.url.includes('partialUpdate')).length, 1);
});

test('runAddStopNote: a duplicate note never fires a write', async () => {
  const state = { stop: rawStop({ comments: [...CARRIER, buildStopNoteComment('Gate code 4417', 'both')] }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'Gate code 4417', audience: 'both' }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no write fired');
});

test('runAddStopNote: FAILS LOUDLY if partialUpdate blanks any other field', async () => {
  const state = { stop: rawStop() };
  // Simulate the feared behavior: the endpoint applies comments but wipes unsent fields.
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, sealNbr: '', to: { ...st.stop.to, contact: { phone: '', email: '' } } };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'Gate code 4417' }, CREDS);
  assert.equal(r.ok, false, 'must NOT report a clean save when other fields moved');
  assert.ok(r.drift.includes('sealNbr') && r.drift.includes('to.contact.phone'));
  assert.match(String(r.error), /changed 3 other field\(s\)|changed \d+ other field/i);
  assert.match(String(r.error), /do not use notes again/i, 'tells the dispatcher to stop');
});

test('runAddStopNote: a rejected write reports the failure and never claims success', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, writeStatus: { status: 'FAILURE', errors: [{ message: 'nope' }] } });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'x' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /rejected the note/i);
});

test('runAddStopNote: a failed FIRST read writes nothing at all', async () => {
  const { requester, calls } = makeRequester({ state: { stop: rawStop() }, readFails: true });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'x' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /nothing was written/i);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('runAddStopNote: empty text throws before any call', async () => {
  const { requester, calls } = makeRequester({ state: { stop: rawStop() } });
  await assert.rejects(() => runAddStopNote(requester, { stopNbr: '007152286', text: '  ' }, CREDS), /empty/i);
  assert.equal(calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// partialUpdate is NOT partial (Jul 26). The minimal {stopId,stopNbr,comments}
// body we shipped first is rejected outright:
//   status='SOMETHING WENT WRONG!!, PLEASE TRY AGAIN'
// The portal echoes the WHOLE stop with comments swapped, so we do too — which
// widens the blast radius from 3 fields to the whole record, and makes the
// read-back diff the thing standing between a note and a corrupted order.
// ─────────────────────────────────────────────────────────────────────────────

test('buildNoteWriteStop: echoes the stop and swaps ONLY comments', () => {
  const raw = rawStop();
  const next = [...CARRIER, buildStopNoteComment('hi', 'both')];
  const out = buildNoteWriteStop(raw, next);
  assert.equal(out.comments, next);
  for (const k of Object.keys(raw)) {
    if (k === 'comments' || PARTIAL_UPDATE_DERIVED_KEYS.includes(k)) continue;
    assert.deepEqual(out[k], raw[k], `${k} must round-trip byte-identical`);
  }
});

test('buildNoteWriteStop: never sends freight lines, attachments, or other derived keys', () => {
  // stopDetails is maintained by a DIFFERENT endpoint (stop/stopdetail/update). A note
  // must not put the freight lines in its blast radius — nor the order's FILES.
  const raw = rawStop({
    stopDetails: [{ product: 'STEEL RECEPTACLE', quantity: 1, weight: 44 }],
    trackingInfo: { trackingEnabled: false },
    visibility: [{ header: 'CUSTOMER', values: [] }],
    customAttributes: [{ keyField: 'stopOrigPrice', keyValue: '65' }],
    shipForBP: 'ULINE',
    volume: 0,
    to: { ...rawStop().to, documents: [BOL('0bb95e56-7ffc-497b-a434-57618533ad72')] },
    from: { ...rawStop().from, documents: [BOL('aaaa1111-0000-0000-0000-000000000000')] },
  });
  const out = buildNoteWriteStop(raw, []);
  for (const p of PARTIAL_UPDATE_DERIVED_KEYS) assert.equal(atPath(out, p), undefined, `${p} must NOT be echoed`);
});

test('buildNoteWriteStop: stripping a nested key does not mutate the read it was given', () => {
  // rawBefore is the before-image the data-loss check compares against — a shallow delete
  // through the shared `to` object would erase the evidence and make every loss invisible.
  const raw = rawStop({ to: { ...rawStop().to, documents: [BOL('keep-me')] } });
  buildNoteWriteStop(raw, []);
  assert.equal(raw.to.documents.length, 1, 'the caller keeps its documents');
  assert.equal(raw.to.documents[0].reference, 'keep-me');
});

test('buildNoteWriteStop: invents nothing the read did not provide', () => {
  // The portal also sends empty scaffolding (estimationInfo:null, hubId:"", invoiceRef:{},
  // serviceType:"", vehicleTypes:[], volumeUOM:"cu ft"). We send none of it: volumeUOM is a
  // real unit we have no read value for, and writing a made-up value is the one thing a
  // note must never do.
  const out = buildNoteWriteStop(rawStop(), []);
  for (const k of ['estimationInfo', 'hubId', 'invoiceRef', 'serviceType', 'vehicleTypes', 'volumeUOM']) {
    assert.ok(!(k in out), `${k} was not read — must not be invented`);
  }
});

test('buildNoteWriteStop: refuses when there is no stop to echo', () => {
  assert.throws(() => buildNoteWriteStop(null, []), /no stop to echo/);
});

test('echoDrift: a clean round-trip reports nothing', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  assert.deepEqual(echoDrift(a, JSON.parse(JSON.stringify(a))), []);
});

test('echoDrift: catches a moved field at ANY depth, not just the guard list', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  b.to.address.zip = '30000';                       // deep
  b.weight = 999;                                   // shallow
  const d = echoDrift(a, b);
  assert.ok(d.includes('to.address.zip'), d.join(','));
  assert.ok(d.includes('weight'), d.join(','));
});

test('echoDrift: ignores comments and the write\'s own modified-by stamp', () => {
  // Flagging either would make EVERY note report drift and cry wolf on a clean save.
  const a = buildNoteWriteStop(rawStop({ createUpdateInfo: { updatedBy: 'A', updatedOn: '1' } }), CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  b.comments = [];
  b.createUpdateInfo = { updatedBy: 'DAVIS', updatedOn: '2' };
  assert.deepEqual(echoDrift(a, b), []);
});

test('echoDrift: a field DROPPED by the round-trip is drift, not silence', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  delete b.sealNbr;
  assert.ok(echoDrift(a, b).includes('sealNbr'));
});

test('runAddStopNote: the echo carries the read values, and derived keys stay out of the wire', async () => {
  const state = { stop: rawStop({ stopDetails: [{ product: 'X', quantity: 1 }], shipForBP: 'ULINE' }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'Gate code 4417' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  const sent = JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
  assert.ok(!('stopDetails' in sent), 'freight lines never ride along with a note');
  assert.ok(!('shipForBP' in sent));
  assert.equal(sent.weight, rawStop().weight);
  assert.equal(sent.to.contact.phone, rawStop().to.contact.phone);
});

test('runAddStopNote: a full echo that comes back altered ANYWHERE still fails loudly', async () => {
  // The widened check earns its place here: totalPallets is in the guard list, but
  // to.address.latitude is not — under the old fingerprint this would have passed clean.
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, to: { ...st.stop.to, address: { ...st.stop.to.address, latitude: 0 } } };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'x' }, CREDS);
  assert.equal(r.ok, false, 'a silently moved coordinate must not report a clean save');
  assert.ok(r.drift.includes('to.address.latitude'), JSON.stringify(r.drift));
  assert.match(String(r.error), /do not use notes again/i);
});

// ── drift must carry VALUES, not just field names ────────────────────────────
// First real note write (order 007152089, Jul 26): landed fine, but reported
// "changed 1 other field(s) (to.documents)" with no way to tell whether NuVizz
// had restamped a GUID or dropped the BOL off the order. Same words, opposite
// severities — so the report carries the before/after now.

test('driftDetail: reports before → after for each drifted path', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  b.sealNbr = '';
  assert.deepEqual(driftDetail(a, b, ['sealNbr']), ['sealNbr: "$55.86" → ""']);
});

test('driftDetail: an absent field reads as (absent), never as undefined', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  delete b.sealNbr;
  assert.match(driftDetail(a, b, ['sealNbr'])[0], /→ \(absent\)/);
});

test('driftDetail: reaches nested paths and truncates huge values', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  b.to.contact.phone = '5551234567';
  b.to.address.addr1 = 'x'.repeat(400);
  const d = driftDetail(a, b, ['to.contact.phone', 'to.address.addr1']);
  assert.ok(d[0].includes('6788787161') && d[0].includes('5551234567'), d[0]);
  assert.ok(d[1].endsWith('…'), 'long values truncated');
});

test('driftDetail: caps how many paths it prints', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  assert.equal(driftDetail(a, a, ['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, 5);
});

test('runAddStopNote: the drift error names the VALUES, so it can be acted on', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, sealNbr: '' };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007152089', text: 'Test' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.note_landed, true, 'the note itself still landed');
  assert.deepEqual(r.drift, ['sealNbr']);
  assert.equal(r.driftDetails.length, 1);
  assert.match(r.error, /\$55\.86/, 'the error shows what it WAS');
  assert.match(r.error, /→ ""/, 'and what it BECAME');
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACHMENTS (Jul 27). Two real note writes, two orders (007152089, 007150559),
// same report: "the note landed BUT partialUpdate changed 1 other field(s) —
// to.documents", with the SAME BOL coming back under a fresh `reference` GUID.
// The note is unusable while a clean save reads as a disaster, so:
//   • documents leave the wire entirely (the read gives metadata with no bytes;
//     echoing it can only be ignored or re-create the row from nothing), and
//   • they are proven surviving by comparing the two READS, on identity — a
//     vendor GUID moving is not a BOL falling off an order.
// ─────────────────────────────────────────────────────────────────────────────

test('documentIdentities: identity ignores the vendor handles; handles are tracked apart', () => {
  const a = rawStop({ to: { ...rawStop().to, documents: [BOL('guid-1')] } });
  const b = rawStop({ to: { ...rawStop().to, documents: [BOL('guid-2')] } });
  assert.deepEqual(documentIdentities(a), documentIdentities(b), 'same BOL, restamped reference');
  assert.notDeepEqual(documentHandles(a), documentHandles(b));
  assert.equal(documentHandlesMoved(a, b), true);
  assert.deepEqual(documentIdentities(a), ['to|BOL|03||pdf||01'], 'name/type/category/ext/description/disposition');
  // A renamed/retyped document is NOT the same document.
  const c = rawStop({ to: { ...rawStop().to, documents: [{ ...BOL('guid-1'), documentName: 'POD' }] } });
  assert.notDeepEqual(documentIdentities(a), documentIdentities(c));
  assert.deepEqual(documentIdentities(rawStop()), [], 'a stop with no files has no identities');
});

test('unsentLosses: a restamp is clean; a DROPPED document is a loss', () => {
  const before = rawStop({ to: { ...rawStop().to, documents: [BOL('old')] } });
  const restamped = rawStop({ to: { ...rawStop().to, documents: [BOL('new')] } });
  assert.deepEqual(unsentLosses(before, restamped), [], 'a moved GUID is not data loss');
  const dropped = rawStop({ to: { ...rawStop().to, documents: [] } });
  const loss = unsentLosses(before, dropped);
  assert.equal(loss.length, 1);
  assert.equal(loss[0].path, 'documents');
  assert.match(loss[0].lost[0], /BOL/);
  // Two copies before, one after → still a loss (multiset, not a set).
  const two = rawStop({ to: { ...rawStop().to, documents: [BOL('a'), BOL('b')] } });
  assert.equal(unsentLosses(two, restamped).length, 1);
  // A document ARRIVING between the reads (a driver capture mid-write) is not our doing.
  assert.deepEqual(unsentLosses(dropped, before), []);
});

test('unsentLosses: freight lines we never echo are still proven surviving', () => {
  const before = rawStop({ stopDetails: [{ product: 'STEEL RECEPTACLE', productIdentifier: 'G6', quantity: 1, quantityUOM: 'PCS', weight: 44 }] });
  assert.deepEqual(stopDetailIdentities(before), ['STEEL RECEPTACLE|G6|1|PCS|44|']);
  assert.deepEqual(unsentLosses(before, before), []);
  const wiped = rawStop({ stopDetails: [] });
  assert.deepEqual(unsentLosses(before, wiped).map((l) => l.path), ['stopDetails']);
});

test('runAddStopNote: a restamped document GUID is a CLEAN save, not a red banner', async () => {
  // The exact shape of both real writes: NuVizz answers with the same BOL under a new
  // reference. The note landed and nothing was lost — it must read as success.
  const state = { stop: rawStop({ to: { ...rawStop().to, documents: [BOL('0bb95e56-7ffc-497b-a434-57618533ad72')] } }) };
  const { requester, calls } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, to: { ...st.stop.to, documents: [BOL('6780c4c3-eb4a-4904-a672-d95f8eb1fd3e')] } };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007150559', text: 'Test.' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.comments_total, 4);
  assert.equal(r.documentRestamp, true, 'still reported on the result (and so in the write log)');
  const sent = JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
  assert.equal(sent.to.documents, undefined, 'the order\'s files never ride along with a note');
});

test('runAddStopNote: a note that COSTS the order its BOL still fails loudly', async () => {
  const state = { stop: rawStop({ to: { ...rawStop().to, documents: [BOL('old')] } }) };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, to: { ...st.stop.to, documents: [] } };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007150559', text: 'Test.' }, CREDS);
  assert.equal(r.ok, false, 'a lost attachment must never read as a clean save');
  assert.equal(r.note_landed, true);
  assert.deepEqual(r.drift, ['documents']);
  assert.match(r.error, /LOST/);
  assert.match(r.error, /BOL/);
  assert.match(r.error, /do not use notes again/i);
});

test('runAddStopNote: freight lines wiped by the write are caught even though we never sent them', async () => {
  const state = { stop: rawStop({ stopDetails: [{ product: 'STEEL RECEPTACLE', quantity: 1 }] }) };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, stopDetails: [] };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'x' }, CREDS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.drift, ['stopDetails']);
  assert.match(r.error, /LOST .*STEEL RECEPTACLE/);
});

// ── the wrong-twin guard (the Estes-0828068215 lesson, Aug 4) ────────────────
//
// Two NuVizz records can share one stop number, and the by-number read answers with
// either. A note pinned to the record on the dispatcher's screen must refuse — before
// the merge is even built — when NuVizz offers the OTHER record, or the instruction
// lands on an order nobody is looking at.

test('runAddStopNote: refuses when NuVizz answers with the OTHER record sharing the number', async () => {
  const state = { stop: rawStop({ stopId: 'ffffffffffffffffffffffff' }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runAddStopNote(requester, { stopNbr: '007152286', text: 'Gate code 4417', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstance, true);
  assert.match(r.error, /TWO NuVizz orders/i);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing written');
});

test('runAddStopNote: a MATCHING id proceeds; no id at all keeps the old behavior', async () => {
  const s1 = { stop: rawStop() };
  const a = await runAddStopNote(makeRequester({ state: s1 }).requester, { stopNbr: '007152286', text: 'Gate code 4417', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(a.ok, true, JSON.stringify(a));
  const s2 = { stop: rawStop({ stopId: 'ffffffffffffffffffffffff' }) };
  const b = await runAddStopNote(makeRequester({ state: s2 }).requester, { stopNbr: '007152286', text: 'Gate code 4417' }, CREDS);
  assert.equal(b.ok, true, 'a caller with no id cannot be judged — old behavior stands');
});

// ── the read-back twin (ESTES-2938079387, Aug 14) — same rule as setStopDate ──
// The pre-read guard (v0.54.36) checks the record BEFORE writing; nothing checked the
// record the VERIFY read answered with. A twin there made the echo diff compare two
// different orders and report the differences as damage this write had done.

test('addStopNote: a twin answering the read-back is a twin verdict, never a drift list', async () => {
  const mine = rawStop();
  const state = { stop: mine };
  const twin = {
    ...rawStop(),
    stopId: '7b8c99aa11223344556677ff',
    to: { ...rawStop().to, address: { name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  };
  const { requester } = makeRequester({ state, onWrite: () => { state.stop = twin; } });
  const r = await runAddStopNote(requester, { stopNbr: mine.stopNbr, text: 'Test', audience: 'both', stopId: mine.stopId }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstanceReadback, true);
  assert.equal(r.unverified, true);
  assert.equal(r.drift, undefined, 'no cross-record diff presented as changes');
  assert.match(r.error, /DIFFERENT record/i);
  assert.match(r.error, /TWO orders appear to carry this number/i);
  assert.ok(!/partialUpdate changed/.test(r.error));
});
