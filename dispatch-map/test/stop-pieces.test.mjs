// test/stop-pieces.test.mjs
//
// §P — CHANGING AN ORDER'S PIECE COUNTS, IN NUVIZZ AND ON THE BOARD (v1.105.0).
//
// Chad, 2026-10-02: "make it where in dispatch map i can edit an order and change piece counts
// and then send it to nuvizz to change as well".
//
// The rules this file pins, each named for the real-world event it prevents:
//   • only the counts that change go on the wire — a pallets fix never sends `volume`, and the
//     order's line items and files never ride a piece write;
//   • the card and the board may only claim what NuVizz is READ BACK holding;
//   • a delivered / in-flight order, a second order sharing the number, or a record with no id
//     of its own is refused before anything is written;
//   • the board row is patched (freight is not refreshed by the scans), and a scan that
//     snapshotted the row before the patch cannot silently put the old count back;
//   • NUVIZZ_PIECES_WRITE=off puts every side back at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  stopPiecesFrom, parsePieceInput, buildStopPiecesOverride, piecesVerdict, piecesLine,
  freightItemsSummary, boardPiecesFields, piecesBoardDates, boardPiecesWarning, PIECE_WRITE_SENDS,
  buildPartialUpdateStop, WRITE_OPS, MUTATING_OPS,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runSetStopPieces, runOp } from '../netlify/functions/lib/nuvizz-write.mts';
import { normalizeStop as scanNormalizeStop } from '../netlify/functions/lib/nuvizz-scan.mts';
import { applyPieceWriteHold, piecesWriteEnabled, PIECE_HOLD_MIN } from '../netlify/functions/lib/pieces-hold.mts';
import {
  boardPiecesOf, parsePieceDraft, piecesChanged, piecesLine as clientPiecesLine,
  piecesBoardDatesOf, piecesFoldFrom, piecesOutcome, piecesEditable,
} from '../src/lib/stop-pieces.js';
import handler from '../netlify/functions/nuvizz-write.mts';

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };
const ID = '6a63c5844524f7f7b8ab5410';

// A Davis order the way NuVizz serves it: 10 pallets, no loose, 10 pieces, one line item and a BOL.
const rawStop = (over = {}) => ({
  stopId: ID, stopNbr: '007174789', stopType: 'DO',
  weight: 4200, weightUOM: 'LBS', totalPallets: 10, totalCartons: 10, sealNbr: '185.00', proNumber: '007174789',
  to: {
    address: { addressType: 'ANY', name: 'ACME DIST', addr1: '500 MAIN ST', city: 'LAWRENCEVILLE', state: 'GA', zip: '30046' },
    schedule: { timeFrom: '2026-10-02T12:00:00', timeTo: '2026-10-02T17:00:00', timeZone: 'America/New_York' },
    documents: [{ documentName: 'BOL', documentType: '03', documentExtType: 'pdf', reference: 'guid-1' }],
  },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HWY', city: 'BUFORD' }, schedule: { timeFrom: '2026-10-02T08:00:00', timeTo: '2026-10-02T12:00:00' } },
  stopDetails: [{ product: 'APPLIANCES', productIdentifier: '007174789', quantity: 10, quantityUOM: 'PCS', stopDetailSeq: 1 }],
  ...over,
});

// ── pure: reading and validating counts ─────────────────────────────────────

test('stopPiecesFrom: Davis terms off NuVizz\'s mislabelled fields, nulls kept as nulls', () => {
  assert.deepEqual(stopPiecesFrom(rawStop()), { pallets: 10, loose: null, total: 10 });
  assert.deepEqual(stopPiecesFrom(rawStop({ volume: 3, totalPallets: 13 })), { pallets: 10, loose: 3, total: 13 });
  assert.deepEqual(stopPiecesFrom({}), { pallets: null, loose: null, total: null }, 'no value is not a zero');
});

test('parsePieceInput: pallets required, loose blank = none, total is pallets + loose', () => {
  assert.deepEqual(parsePieceInput({ pallets: 6, loose: 2 }), { pallets: 6, loose: 2, total: 8 });
  assert.deepEqual(parsePieceInput({ pallets: '6', loose: '' }), { pallets: 6, loose: 0, total: 6 });
  assert.deepEqual(parsePieceInput({ pallets: ' 0 ', loose: '4' }), { pallets: 0, loose: 4, total: 4 }, 'an order of loose pieces only');
  assert.match(parsePieceInput({ pallets: '', loose: 2 }).error, /pallets must be a whole number/);
  assert.match(parsePieceInput({ pallets: -1 }).error, /pallets must be/);
  assert.match(parsePieceInput({ pallets: 2.5 }).error, /pallets must be/, 'half a pallet is not a count');
  assert.match(parsePieceInput({ pallets: 2, loose: 'x' }).error, /loose must be/);
  assert.match(parsePieceInput({ pallets: 0, loose: 0 }).error, /cancel the order/, 'zero pieces is a cancel, not an edit');
  assert.match(parsePieceInput({ pallets: 99999, loose: 1 }).error, /over NuVizz's limit/);
  assert.match(parsePieceInput({ pallets: 100000 }).error, /pallets must be/);
});

test('buildStopPiecesOverride: ONLY the fields that change, null and 0 both meaning none', () => {
  const r = rawStop();   // 10 pallets, volume null, 10 total
  assert.deepEqual(buildStopPiecesOverride(r, { pallets: 6, loose: 0, total: 6 }), { totalCartons: 6, totalPallets: 6 },
    'a pallets fix does not send volume — 0 over null is not a change');
  assert.deepEqual(buildStopPiecesOverride(r, { pallets: 10, loose: 2, total: 12 }), { volume: 2, totalPallets: 12 });
  assert.deepEqual(buildStopPiecesOverride(r, { pallets: 10, loose: 0, total: 10 }), {}, 'nothing to send');
  // A total NuVizz holds that is not pallets + loose is corrected by the same rule every create writes.
  assert.deepEqual(buildStopPiecesOverride(rawStop({ totalPallets: 12 }), { pallets: 10, loose: 0, total: 10 }), { totalPallets: 10 });
  assert.deepEqual(buildStopPiecesOverride(rawStop({ totalPallets: null }), { pallets: 10, loose: 0, total: 10 }), { totalPallets: 10 },
    'a missing total is written');
});

test('piecesVerdict: names the one count NuVizz did not take, and checks loose even when unsent', () => {
  assert.deepEqual(piecesVerdict({ pallets: 6, loose: null, total: 6 }, { pallets: 6, loose: 0, total: 6 }), { landed: true, misses: [] });
  const v = piecesVerdict({ pallets: 10, loose: 3, total: 6 }, { pallets: 6, loose: 0, total: 6 });
  assert.equal(v.landed, false);
  assert.deepEqual(v.misses, ['pallets reads 10 (expected 6)', 'loose reads 3 (expected 0)']);
});

test('piecesLine reads the way a dispatcher says it', () => {
  assert.equal(piecesLine({ pallets: 6, loose: 2, total: 8 }), '6 pallets · 2 loose · 8 pieces');
  assert.equal(piecesLine({ pallets: 1, loose: 0, total: 1 }), '1 pallet · 1 piece');
  assert.equal(piecesLine({ pallets: null, loose: null, total: null }), '0 pallets · no total on file');
  assert.equal(clientPiecesLine({ pallets: 6, loose: 2, total: 8 }), piecesLine({ pallets: 6, loose: 2, total: 8 }), 'screen and server say it the same way');
});

test('freightItemsSummary is byte-for-byte the scan\'s itemsSummary (the board row must read like a fresh enrichment)', () => {
  const cases = [
    rawStop(),
    rawStop({ totalCartons: 1, totalPallets: 1, weight: 90 }),
    rawStop({ totalCartons: 0, volume: 4, totalPallets: 4, weightUOM: undefined }),
    rawStop({ totalCartons: 6, volume: 2, totalPallets: 8, weight: null }),
    rawStop({ totalCartons: null, volume: null, totalPallets: null, weight: null }),
  ];
  for (const s of cases) {
    const scan = scanNormalizeStop({ stop: s, stopExecutionInfo: {}, load: {} });
    assert.equal(freightItemsSummary(s), scan.itemsSummary, JSON.stringify({ c: s.totalCartons, v: s.volume, p: s.totalPallets, w: s.weight }));
    const f = boardPiecesFields(s, '2026-10-02T13:00:00.000Z');
    assert.equal(f.cartons, scan.cartons, 'cartons shape matches the scan');
    assert.equal(f.pallets, scan.pallets, 'pallets shape matches the scan');
    assert.equal(f.volume, scan.volume, 'volume through the scan\'s own number rule');
  }
});

test('boardPiecesFields: from the read-back, stamped for the scan hold', () => {
  const f = boardPiecesFields(rawStop({ totalCartons: 6, totalPallets: 6 }), '2026-10-02T13:00:00.000Z');
  assert.deepEqual(f, { cartons: 6, pallets: 6, volume: null, itemsSummary: '6 pallets · 6 pieces · 4200 LBS', pieces_set_at: '2026-10-02T13:00:00.000Z' });
});

test('piecesBoardDates: real dates only, de-duplicated, at most three', () => {
  assert.deepEqual(piecesBoardDates(['2026-10-01', '2026-10-02', '2026-10-01']), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(piecesBoardDates(['../x', 'yesterday', null, '2026-10-02T09:00:00']), ['2026-10-02']);
  assert.deepEqual(piecesBoardDates(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']).length, 3);
  assert.deepEqual(piecesBoardDates(undefined), []);
});

test('boardPiecesWarning: silent when the board took it, loud when it did not', () => {
  assert.equal(boardPiecesWarning({ days: { '2026-10-02': 'patched' }, registry: 'patched' }), null);
  assert.equal(boardPiecesWarning({ days: { '2026-10-01': 'absent', '2026-10-02': 'patched' }, registry: 'absent' }), null,
    'absent on one named day is not a failure — an order is stored under one day');
  assert.equal(boardPiecesWarning({ skipped: 'firestore-disabled' }), null);
  assert.match(boardPiecesWarning({ days: { '2026-10-02': 'error' }, dayErrors: { '2026-10-02': '503' }, registry: 'patched' }), /could not be updated \(503\).*old count/);
  assert.match(boardPiecesWarning({ days: { '2026-10-02': 'absent' }, registry: 'patched' }), /no board row for this order was found/);
  assert.match(boardPiecesWarning({ days: { '2026-10-02': 'other-record' }, registry: 'patched' }), /different NuVizz order/);
  assert.match(boardPiecesWarning({ days: {}, registry: 'error', registryError: 'quota' }), /later days start from could not be updated \(quota\)/);
});

// ── pure: the echo ──────────────────────────────────────────────────────────

test('buildPartialUpdateStop: volume rides ONLY when the piece write is changing it', () => {
  const r = rawStop({ volume: 3 });
  const withLoose = buildPartialUpdateStop(r, { volume: 5, totalPallets: 15 }, { send: PIECE_WRITE_SENDS });
  assert.equal(withLoose.volume, 5);
  assert.equal(withLoose.stopDetails, undefined, 'never the line items');
  assert.equal(withLoose.to.documents, undefined, 'never the order\'s files');
  const palletsOnly = buildPartialUpdateStop(r, { totalCartons: 6, totalPallets: 9 }, { send: PIECE_WRITE_SENDS });
  assert.equal('volume' in palletsOnly, false, 'a pallets fix stays the shape of every other partialUpdate');
  // Every other caller is exactly as before.
  assert.equal('volume' in buildPartialUpdateStop(r, { comments: [] }), false);
  // A dotted path can never be let through: it cannot match a top-level override.
  const sneaky = buildPartialUpdateStop(r, { to: r.to }, { send: ['to.documents', 'stopDetails'] });
  assert.equal(sneaky.to.documents, undefined);
  assert.equal(sneaky.stopDetails, undefined);
});

test('setStopPieces is registered as a mutating write (behind NUVIZZ_WRITE_ENABLED)', () => {
  assert.ok(WRITE_OPS.includes('setStopPieces'));
  assert.ok(MUTATING_OPS.has('setStopPieces'));
});

// ── end to end through the op runner, against a fake NuVizz ──────────────────

// Applies what partialUpdate sent to the stored order (the honest vendor), unless onWrite says
// otherwise. Counts every call so the 3-call contract is pinned.
function makeRequester({ state, onWrite, readStatus = 200, writeStatus = { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } } } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
        if (url.includes('/stop/info/')) {
          if (readStatus !== 200) return J({}, readStatus);
          return J({ Stop: { stop: state.stop, stopExecutionInfo: { stopStatus: state.status ?? 'PLANNED' }, load: state.load || {} } });
        }
        if (url.includes('/stop/partialUpdate/')) {
          const sent = JSON.parse(opts.body).stops[0];
          if (onWrite) onWrite(sent, state);
          else {
            const next = { ...state.stop };
            for (const k of ['totalCartons', 'totalPallets', 'volume']) if (k in sent) next[k] = sent[k];
            state.stop = next;
          }
          return J(writeStatus);
        }
        return J({}, 404);
      },
    },
  };
}
const sentOf = (calls) => JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
const P = (over = {}) => ({ stopNbr: '007174789', stopId: ID, pallets: 6, loose: '', ...over });

test('runSetStopPieces: a pallets fix lands — 3 calls, only the changed totals on the wire, read-back on the result', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls.length, 3, 'read → write → read-back');
  assert.deepEqual(r.calls, { reads: 2, writes: 1 });
  const sent = sentOf(calls);
  assert.equal(sent.stopId, ID, 'aimed at the record by id');
  assert.equal(sent.totalCartons, 6);
  assert.equal(sent.totalPallets, 6);
  assert.equal('volume' in sent, false, 'loose did not change, so it was not sent');
  assert.equal(sent.stopDetails, undefined, 'the line items never ride a piece write');
  assert.equal(sent.to.documents, undefined, 'nor the order\'s files');
  assert.equal(sent.weight, 4200, 'everything else is echoed as read');
  assert.deepEqual(r.was, { pallets: 10, loose: null, total: 10 });
  assert.deepEqual(r.now, { pallets: 6, loose: null, total: 6 });
  assert.deepEqual(r.wrote, { totalCartons: 6, totalPallets: 6 });
  assert.equal(r.boardFields.cartons, 6, 'the board gets the READ-BACK');
  assert.equal(r.boardFields.itemsSummary, '6 pallets · 6 pieces · 4200 LBS');
  assert.equal(r.board.skipped, 'firestore-disabled', 'no store in tests — and no warning for it');
  assert.equal(r.boardWarning, undefined);
});

test('runSetStopPieces: a loose change sends volume, and only then', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopPieces(requester, P({ pallets: 10, loose: 2 }), CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  const sent = sentOf(calls);
  assert.equal(sent.volume, 2);
  assert.equal(sent.totalPallets, 12);
  assert.equal(sent.totalCartons, 10, 'echoed unchanged, not overridden');
  assert.deepEqual(r.now, { pallets: 10, loose: 2, total: 12 });
});

test('runSetStopPieces: an order already holding the counts costs ONE call and writes nothing to NuVizz', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopPieces(requester, P({ pallets: 10 }), CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(calls.length, 1);
  assert.match(r.message, /already reads 10 pallets · 10 pieces in NuVizz — nothing was sent/);
  assert.equal(r.boardFields.cartons, 10, 'the board half still runs, from NuVizz\'s record — the board may be the stale one');
});

test('runSetStopPieces: refuses an order the driver already has, before any write', async () => {
  for (const status of ['DELIVERED', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED']) {
    const state = { stop: rawStop(), status };
    const { requester, calls } = makeRequester({ state });
    const r = await runSetStopPieces(requester, P(), CREDS);
    assert.equal(r.ok, false, status);
    assert.match(r.error, new RegExp(`already ${status}`));
    assert.equal(calls.length, 1, `${status}: one read, no write`);
  }
});

test('runSetStopPieces: refuses the OTHER order sharing the number (the Estes twin), before any write', async () => {
  const state = { stop: rawStop({ stopId: '6a63c5844524f7f7b8ab9999' }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstance, true);
  assert.equal(calls.length, 1);
});

test('runSetStopPieces: a record with no stopId of its own is refused — never aimed by the caller\'s id', async () => {
  const state = { stop: rawStop({ stopId: undefined }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /no stopId of its own/);
  assert.equal(calls.length, 1, 'nothing written');
});

test('runSetStopPieces: NuVizz accepting the write but ignoring the totals is a failure that names them', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: () => { /* 200, applies nothing */ } });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /reads back differently — pallets reads 10 \(expected 6\); total pieces reads 10 \(expected 6\)/);
  assert.equal(r.boardFields, undefined, 'the board is never told about counts NuVizz did not take');
});

test('runSetStopPieces: a loose count that moves on its own is caught, though it was never sent', async () => {
  // The code has long said NuVizz may recompute `volume` from the line items. If it ever does on
  // a piece write, the dispatcher hears about it instead of a quietly changed loose count.
  const state = { stop: rawStop({ volume: 3, totalPallets: 13 }) };
  const { requester, calls } = makeRequester({ state, onWrite: (sent, s) => { s.stop = { ...s.stop, totalCartons: sent.totalCartons, totalPallets: sent.totalPallets, volume: 0 }; } });
  const r = await runSetStopPieces(requester, P({ pallets: 6, loose: 3 }), CREDS);
  assert.equal('volume' in sentOf(calls), false);
  assert.equal(r.ok, false);
  assert.match(r.error, /loose reads 0 \(expected 3\)/);
});

test('runSetStopPieces: another field moving is reported as drift, with its values', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, s) => { s.stop = { ...s.stop, totalCartons: sent.totalCartons, totalPallets: sent.totalPallets, weight: 0 }; } });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.piecesLanded, true);
  assert.ok(r.drift.includes('weight'), JSON.stringify(r.drift));
  assert.match(r.error, /the piece counts landed BUT partialUpdate changed/);
  assert.match(r.error, /weight: 4200 → 0/);
});

test('runSetStopPieces: losing the line items or the BOL is reported, though neither is sent', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, s) => { s.stop = { ...s.stop, totalCartons: sent.totalCartons, totalPallets: sent.totalPallets, stopDetails: [] }; } });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.ok(r.drift.includes('stopDetails'));
});

test('runSetStopPieces: a read-back answered by the twin is unverified, never diffed', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, s) => { s.stop = { ...rawStop(), stopId: '6a63c5844524f7f7b8ab9999' }; } });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.unverified, true);
  assert.equal(r.wrongInstanceReadback, true);
});

test('runSetStopPieces: a failed first read writes nothing', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state, readStatus: 500 });
  const r = await runSetStopPieces(requester, P(), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not read stop .* nothing was written/);
  assert.equal(calls.some((c) => c.url.includes('partialUpdate')), false);
});

test('runSetStopPieces: bad counts are refused with ZERO NuVizz calls', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopPieces(requester, P({ pallets: 0, loose: 0 }), CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /cancel the order/);
  assert.equal(calls.length, 0);
});

test('NUVIZZ_PIECES_WRITE=off refuses with ZERO NuVizz calls; anything malformed leaves it on', async () => {
  const saved = process.env.NUVIZZ_PIECES_WRITE;
  try {
    for (const off of ['off', 'OFF', '0', 'false', 'no', ' off ']) {
      process.env.NUVIZZ_PIECES_WRITE = off;
      const state = { stop: rawStop() };
      const { requester, calls } = makeRequester({ state });
      const r = await runOp(requester, 'setStopPieces', P(), CREDS);
      assert.equal(r.ok, false, off);
      assert.equal(r.blocked, true);
      assert.match(r.error, /NUVIZZ_PIECES_WRITE/);
      assert.equal(calls.length, 0, `${off}: nothing spent`);
    }
    for (const on of ['on', 'true', 'oof', '', 'yes']) assert.equal(piecesWriteEnabled({ NUVIZZ_PIECES_WRITE: on }), true, `"${on}" leaves it on`);
    assert.equal(piecesWriteEnabled({}), true, 'unset is on');
  } finally {
    if (saved === undefined) delete process.env.NUVIZZ_PIECES_WRITE; else process.env.NUVIZZ_PIECES_WRITE = saved;
  }
});

test('the dry run describes the piece write without a NuVizz call', async () => {
  const res = await handler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', body: JSON.stringify({ op: 'setStopPieces', dryRun: true, payload: { stopNbr: '007174789', pallets: 6, loose: 2, boardDates: ['2026-10-02'] } }),
  }));
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.ok(j.plan.some((s) => /6 pallet\(s\) \+ 2 loose = 8 piece\(s\)/.test(s)), JSON.stringify(j.plan));
  assert.ok(j.plan.some((s) => /line items are never sent/.test(s)));
  assert.ok(j.plan.some((s) => /BOARD: .*2026-10-02.*no NuVizz call/.test(s)));
  const bad = await (await handler(new Request('http://localhost/.netlify/functions/nuvizz-write', {
    method: 'POST', body: JSON.stringify({ op: 'setStopPieces', dryRun: true, payload: { stopNbr: '1', pallets: 0 } }),
  }))).json();
  assert.match(bad.plan[0], /REFUSE before any call: .*cancel the order/);
});

// ── the scan hold: a snapshot older than the patch cannot put the old count back ──

const NOW = Date.parse('2026-10-02T13:10:00.000Z');
const patchedRow = (over = {}) => ({ stopNbr: '007174789', stopId: ID, cartons: 6, pallets: 6, volume: null, itemsSummary: '6 pallets · 6 pieces · 4200 LBS', pieces_set_at: '2026-10-02T13:00:00.000Z', ...over });
const staleScanRow = (over = {}) => ({ stopNbr: '007174789', stopId: ID, cartons: 10, pallets: 10, volume: null, itemsSummary: '10 pallets · 10 pieces · 4200 LBS', status: '20', ...over });

test('applyPieceWriteHold: the row written by a scan that snapshotted before the patch keeps the patched counts', () => {
  const fresh = staleScanRow();
  assert.equal(applyPieceWriteHold(fresh, patchedRow(), NOW, true), true);
  assert.equal(fresh.cartons, 6);
  assert.equal(fresh.pallets, 6);
  assert.equal(fresh.itemsSummary, '6 pallets · 6 pieces · 4200 LBS');
  assert.equal(fresh.pieces_set_at, '2026-10-02T13:00:00.000Z', 'the stamp survives the whole-row rewrite');
  assert.equal(fresh.status, '20', 'nothing but freight is touched');
});

test('applyPieceWriteHold: inert after the hour, when switched off, on another record, or with no stamp', () => {
  const late = staleScanRow();
  assert.equal(applyPieceWriteHold(late, patchedRow(), NOW + (PIECE_HOLD_MIN * 60000) + 1, true), false);
  assert.equal(late.cartons, 10);
  const off = staleScanRow();
  assert.equal(applyPieceWriteHold(off, patchedRow(), NOW, false), false);
  assert.equal(off.cartons, 10, 'NUVIZZ_PIECES_WRITE=off turns the hold off with the write');
  const twin = staleScanRow({ stopId: '6a63c5844524f7f7b8ab9999' });
  assert.equal(applyPieceWriteHold(twin, patchedRow(), NOW, true), false, 'a stamp on one order is never painted onto another sharing its number');
  const never = staleScanRow();
  assert.equal(applyPieceWriteHold(never, { ...patchedRow(), pieces_set_at: undefined }, NOW, true), false, 'a row that never had a piece edit is untouched');
  const skewed = staleScanRow();
  assert.equal(applyPieceWriteHold(skewed, patchedRow({ pieces_set_at: '2026-10-02T14:00:00.000Z' }), NOW, true), false, 'a stamp an hour in the future is not evidence');
  assert.equal(applyPieceWriteHold(staleScanRow(), null, NOW, true), false);
});

test('the scan applies the piece hold at BOTH of its write sites, beside the plan grace', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/refresh-stops-core.mts', import.meta.url), 'utf8');
  const sites = src.match(/graceFn: \(fresh, ex\) => \{[^}]*\}/g) || [];
  assert.equal(sites.length, 2, 'the cold path and the list path');
  for (const s of sites) {
    assert.match(s, /applyBoardWriteGrace\(fresh, ex, Date\.now\(\)\)/, 'the plan grace is unchanged');
    assert.match(s, /applyPieceWriteHold\(fresh, ex, Date\.now\(\)\)/);
  }
});

// ── the screen's rules ───────────────────────────────────────────────────────

test('parsePieceDraft (screen) and parsePieceInput (server) agree on every case', () => {
  const table = [
    ['6', '2'], ['6', ''], ['0', '4'], ['', '2'], ['-1', ''], ['2.5', ''], ['2', 'x'], ['0', '0'],
    ['99999', '1'], ['100000', ''], [' 7 ', ' '], ['3', null], [4, 1],
  ];
  for (const [p, l] of table) {
    const a = parsePieceDraft(p, l);
    const b = parsePieceInput({ pallets: p, loose: l });
    assert.deepEqual(a, b, `pallets=${JSON.stringify(p)} loose=${JSON.stringify(l)}`);
  }
});

test('boardPiecesOf / piecesChanged: the board\'s names, translated; the server\'s change rule', () => {
  const stop = { cartons: 10, volume: null, pallets: 10 };
  assert.deepEqual(boardPiecesOf(stop), { pallets: 10, loose: null, total: 10 });
  assert.equal(piecesChanged(boardPiecesOf(stop), { pallets: 10, loose: 0, total: 10 }), false);
  assert.equal(piecesChanged(boardPiecesOf(stop), { pallets: 6, loose: 0, total: 6 }), true);
  assert.equal(piecesChanged(boardPiecesOf(stop), { error: 'x' }), false);
});

test('piecesBoardDatesOf: a carried-over row names the day it is STORED under first', () => {
  assert.deepEqual(piecesBoardDatesOf({ boardDate: '2026-10-02', scheduledDate: '2026-10-02' }), ['2026-10-02']);
  assert.deepEqual(piecesBoardDatesOf({ carryover: true, boardDate: '2026-10-02', scheduledDate: '2026-09-30' }), ['2026-09-30', '2026-10-02']);
  assert.deepEqual(piecesBoardDatesOf({}), []);
});

test('piecesFoldFrom: the card takes NuVizz\'s read-back, and a loose count gone to none folds as 0', () => {
  const fold = piecesFoldFrom({ stopId: ID, boardFields: { cartons: 6, pallets: 6, volume: null, itemsSummary: '6 pallets · 6 pieces' } });
  assert.deepEqual(fold, { cartons: 6, volume: 0, itemsSummary: '6 pallets · 6 pieces', pallets: 6, stopId: ID });
  assert.equal(piecesFoldFrom({}), null, 'no read-back, nothing to show');
});

test('piecesOutcome: says what NuVizz holds now, and keeps the board warning in view', () => {
  assert.deepEqual(piecesOutcome({ ok: true, result: { was: { pallets: 10, loose: null, total: 10 }, now: { pallets: 6, loose: null, total: 6 } } }),
    { kind: 'ok', text: 'Saved in NuVizz — it now reads 6 pallets · 6 pieces (was 10 pallets · 10 pieces).' });
  const warn = piecesOutcome({ ok: true, result: { was: { pallets: 10, total: 10 }, now: { pallets: 6, total: 6 }, boardWarning: 'NuVizz has the new counts, but X.' } });
  assert.equal(warn.kind, 'warn');
  assert.match(warn.text, /NuVizz has the new counts, but X\./);
  assert.equal(piecesOutcome({ ok: true, result: { unchanged: true, message: 'Order 1 already reads 6 pallets · 6 pieces in NuVizz — nothing was sent there.' } }).kind, 'ok');
  assert.deepEqual(piecesOutcome({ ok: false, error: 'setStopPieces: order 1 is already DELIVERED' }), { kind: 'err', text: 'setStopPieces: order 1 is already DELIVERED' });
  assert.equal(piecesOutcome({ ok: false, result: { error: 'from the result' } }).text, 'from the result', 'the reason can arrive on either key');
});

test('piecesEditable: no editor on freight that is finished or already with the driver', () => {
  for (const s of ['DELIVERED', 'EXCEPTION', 'CANCELLED', 'OUT_FOR_DEL', 'ARRIVED']) assert.equal(piecesEditable({ normalizedStatus: s }), false, s);
  for (const s of ['UNPLANNED', 'SCHEDULED', '', undefined]) assert.equal(piecesEditable({ normalizedStatus: s }), true, String(s));
});

test('the stop card mounts the editor under Items, on the shared body both views render', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /<OrderItemsSection stop=\{live\} \/>\s*\n\s*<StopPiecesEditor key=\{stopKey\} stop=\{live\} onRefreshed=\{onRefreshed\} \/>/);
  // StopDataSections is the body of the desktop sidebar AND the phone drawer.
  const body = src.slice(src.indexOf('function StopDataSections('));
  assert.ok(body.length > 0);
  assert.match(src, /function StopSidebar\([\s\S]*?<StopDataSections /);
  assert.match(src, /function MobileStopDetailDrawer\([\s\S]*?<StopDataSections /);
  assert.match(src, /setStopPieces\(pro, \{ pallets: want\.pallets, loose: want\.loose \}, \{\s*\n\s*stopId: stop\?\.stopId \|\| undefined,/);
});
