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
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runAddStopNote } from '../netlify/functions/lib/nuvizz-write.mts';

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

test('buildNoteWriteStop: never sends freight lines or other derived keys', () => {
  // stopDetails is maintained by a DIFFERENT endpoint (stop/stopdetail/update). A note
  // must not put the freight lines in its blast radius.
  const raw = rawStop({
    stopDetails: [{ product: 'STEEL RECEPTACLE', quantity: 1, weight: 44 }],
    trackingInfo: { trackingEnabled: false },
    visibility: [{ header: 'CUSTOMER', values: [] }],
    customAttributes: [{ keyField: 'stopOrigPrice', keyValue: '65' }],
    shipForBP: 'ULINE',
    volume: 0,
  });
  const out = buildNoteWriteStop(raw, []);
  for (const k of PARTIAL_UPDATE_DERIVED_KEYS) assert.ok(!(k in out), `${k} must NOT be echoed`);
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
  const withDoc = rawStop({ to: { ...rawStop().to, documents: [{ documentGuid: 'g1', documentName: 'BOL' }] } });
  const a = buildNoteWriteStop(withDoc, CARRIER);
  const b = JSON.parse(JSON.stringify(a));
  b.to.documents = [{ documentGuid: 'g2', documentName: 'BOL' }];
  b.to.address.addr1 = 'x'.repeat(400);
  const d = driftDetail(a, b, ['to.documents', 'to.address.addr1']);
  assert.ok(d[0].includes('g1') && d[0].includes('g2'), d[0]);
  assert.ok(d[1].endsWith('…'), 'long values truncated');
});

test('driftDetail: caps how many paths it prints', () => {
  const a = buildNoteWriteStop(rawStop(), CARRIER);
  assert.equal(driftDetail(a, a, ['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, 5);
});

test('runAddStopNote: the drift error names the VALUES, so it can be acted on', async () => {
  const withDoc = rawStop({ to: { ...rawStop().to, documents: [{ documentGuid: 'old-guid', documentName: 'BOL' }] } });
  const state = { stop: withDoc };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, comments: sent.comments, to: { ...st.stop.to, documents: [{ documentGuid: 'new-guid', documentName: 'BOL' }] } };
  } });
  const r = await runAddStopNote(requester, { stopNbr: '007152089', text: 'Test' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.note_landed, true, 'the note itself still landed');
  assert.deepEqual(r.drift, ['to.documents']);
  assert.equal(r.driftDetails.length, 1);
  assert.match(r.error, /old-guid/, 'the error shows what it WAS');
  assert.match(r.error, /new-guid/, 'and what it BECAME');
});
