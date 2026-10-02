// test/stop-pieces-board.test.mjs
//
// §P — THE BOARD HALF of a piece-count edit (v1.105.0), through the real Firestore helpers
// against the in-memory fake (commit semantics on: masked merges and exists:true preconditions
// behave the way Firestore does).
//
// Why this half exists at all: freight is not a live list field — the scan carries a row's
// cartons/pallets/volume forward from its stored copy — so a count NuVizz holds differently never
// reaches the board by itself. And why the hold exists: the scan rewrites whole rows from a
// snapshot taken minutes earlier, so a patch landing in that window was silently put back.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installFirestoreFake } from './_firestore-fake.mjs';
import { runSetStopPieces } from '../netlify/functions/lib/nuvizz-write.mts';
import { writeStops } from '../netlify/functions/lib/firestore.mts';
import { applyBoardWriteGrace } from '../netlify/functions/lib/nuvizz-list.mts';
import { applyPieceWriteHold } from '../netlify/functions/lib/pieces-hold.mts';

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };
const ID = '6a63c5844524f7f7b8ab5410';
const NBR = '007174789';
const DAY = (d) => `nuvizz_stop_index/davis__${d}/stops/${NBR}`;
const REG = `nuvizz_enriched/davis/pros/${NBR}`;

const rawStop = (over = {}) => ({
  stopId: ID, stopNbr: NBR, stopType: 'DO', weight: 4200, weightUOM: 'LBS', totalPallets: 10, totalCartons: 10,
  to: { address: { addressType: 'ANY', name: 'ACME DIST', addr1: '500 MAIN ST', city: 'LAWRENCEVILLE', state: 'GA', zip: '30046' }, schedule: { timeFrom: '2026-10-02T12:00:00', timeTo: '2026-10-02T17:00:00' } },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HWY', city: 'BUFORD' } },
  ...over,
});
// The board row the scan wrote for this order: address, plan, enrichment — and the OLD freight.
const boardRow = (over = {}) => ({
  stopNbr: NBR, stopId: ID, businessName: 'ACME DIST', addr1: '500 MAIN ST', city: 'LAWRENCEVILLE', zip: '30046',
  status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, routeName: 'GAINESVILLE', loadNbr: 'GAINESVILLE',
  cartons: 10, pallets: 10, volume: null, weight: 4200, itemsSummary: '10 pallets · 10 pieces · 4200 LBS',
  enriched: true, lat: 33.95, lng: -83.98,
  ...over,
});

function nuvizz(state) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: opts.method || 'GET' });
        const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
        if (url.includes('/stop/info/')) return J({ Stop: { stop: state.stop, stopExecutionInfo: { stopStatus: 'PLANNED' }, load: { loadNbr: 'DAVIS000204645' } } });
        if (url.includes('/stop/partialUpdate/')) {
          const sent = JSON.parse(opts.body).stops[0];
          const next = { ...state.stop };
          for (const k of ['totalCartons', 'totalPallets', 'volume']) if (k in sent) next[k] = sent[k];
          state.stop = next;
          return J({ status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } });
        }
        return J({}, 404);
      },
    },
  };
}

test('a confirmed write patches the day\'s row and the registry — freight only, nothing else moves', async () => {
  const fs = installFirestoreFake({ [DAY('2026-10-02')]: boardRow(), [REG]: { ...boardRow(), enriched_at: '2026-10-01T10:00:00Z' } }, undefined, { commitSemantics: true });
  try {
    const { requester } = nuvizz({ stop: rawStop() });
    const r = await runSetStopPieces(requester, { stopNbr: NBR, stopId: ID, pallets: 6, loose: 2, boardDates: ['2026-10-02'] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.board.days['2026-10-02'], 'patched');
    assert.equal(r.board.registry, 'patched');
    assert.equal(r.boardWarning, undefined);
    const row = fs.store.get(DAY('2026-10-02'));
    assert.equal(row.cartons, 6);
    assert.equal(row.volume, 2);
    assert.equal(row.pallets, 8);
    assert.equal(row.itemsSummary, '6 pallets · 2 loose · 8 pieces · 4200 LBS');
    assert.ok(row.pieces_set_at, 'stamped for the scan hold');
    // Field-masked: the row the scan built is otherwise exactly as it was.
    for (const k of ['businessName', 'addr1', 'status', 'routeName', 'loadNbr', 'weight', 'enriched', 'lat', 'lng']) {
      assert.deepEqual(row[k], boardRow()[k], `${k} untouched`);
    }
    const reg = fs.store.get(REG);
    assert.equal(reg.cartons, 6);
    assert.equal(reg.enriched_at, '2026-10-01T10:00:00Z', 'the registry record keeps everything else too');
    assert.equal(fs.log.other.length, 0, 'no network beyond Firestore — NuVizz went through the injected requester');
  } finally { fs.restore(); }
});

test('a carried-over row is patched under the day it is STORED, and the served day is not invented', async () => {
  const fs = installFirestoreFake({ [DAY('2026-09-30')]: boardRow(), [REG]: boardRow() }, undefined, { commitSemantics: true });
  try {
    const { requester } = nuvizz({ stop: rawStop() });
    const r = await runSetStopPieces(requester, { stopNbr: NBR, stopId: ID, pallets: 6, boardDates: ['2026-09-30', '2026-10-02'] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.board.days['2026-09-30'], 'patched');
    assert.equal(r.board.days['2026-10-02'], 'absent');
    assert.equal(fs.store.has(DAY('2026-10-02')), false, 'NO phantom row minted on the served day');
    assert.equal(r.boardWarning, undefined, 'absent on one named day is not a failure');
  } finally { fs.restore(); }
});

test('no row anywhere: nothing is created, and the dispatcher is told the board was not updated', async () => {
  const fs = installFirestoreFake({}, undefined, { commitSemantics: true });
  try {
    const { requester } = nuvizz({ stop: rawStop() });
    const r = await runSetStopPieces(requester, { stopNbr: NBR, stopId: ID, pallets: 6, boardDates: ['2026-10-02'] }, CREDS);
    assert.equal(r.ok, true, 'NuVizz took it — the write is still a success');
    assert.equal(r.board.days['2026-10-02'], 'absent');
    assert.equal(r.board.registry, 'absent');
    assert.equal(fs.store.size, 0, 'not one document created');
    assert.match(r.boardWarning, /NuVizz has the new counts, but no board row for this order was found/);
  } finally { fs.restore(); }
});

test('a board row belonging to the OTHER order sharing the number is left alone, and said', async () => {
  const fs = installFirestoreFake({ [DAY('2026-10-02')]: boardRow({ stopId: '6a63c5844524f7f7b8ab9999' }) }, undefined, { commitSemantics: true });
  try {
    const { requester } = nuvizz({ stop: rawStop() });
    const r = await runSetStopPieces(requester, { stopNbr: NBR, stopId: ID, pallets: 6, boardDates: ['2026-10-02'] }, CREDS);
    assert.equal(r.ok, true);
    assert.equal(r.board.days['2026-10-02'], 'other-record');
    assert.equal(fs.store.get(DAY('2026-10-02')).cartons, 10, 'the other order\'s freight untouched');
    assert.match(r.boardWarning, /different NuVizz order carrying the same number/);
  } finally { fs.restore(); }
});

test('THE RACE: a scan that snapshotted the row BEFORE the patch writes it back with the patched counts', async () => {
  const fs = installFirestoreFake({ [DAY('2026-10-02')]: boardRow() }, undefined, { commitSemantics: true });
  try {
    // The scan snapshots the board (old freight) …
    const snapshot = { ...fs.store.get(DAY('2026-10-02')) };
    // … the dispatcher's edit lands while the scan is still pulling and enriching …
    const { requester } = nuvizz({ stop: rawStop() });
    const r = await runSetStopPieces(requester, { stopNbr: NBR, stopId: ID, pallets: 6, boardDates: ['2026-10-02'] }, CREDS);
    assert.equal(r.board.days['2026-10-02'], 'patched');
    // … and the scan writes its whole row, built from the old snapshot, through the real writeStops
    // with the same graceFn the scan passes.
    const fresh = { ...snapshot, status: '20', last_scanned_at: undefined };
    await writeStops('davis', '2026-10-02', [fresh], new Date().toISOString(), {
      includeUnplanned: true, includeLoads: true,
      graceFn: (f, ex) => { applyBoardWriteGrace(f, ex, Date.now()); applyPieceWriteHold(f, ex, Date.now(), true); },
    });
    const row = fs.store.get(DAY('2026-10-02'));
    assert.equal(row.cartons, 6, 'the edit survived the scan');
    assert.equal(row.pallets, 6);
    assert.equal(row.itemsSummary, '6 pallets · 6 pieces · 4200 LBS');
    assert.ok(row.pieces_set_at, 'and so did its stamp');
    assert.equal(row.businessName, 'ACME DIST');
  } finally { fs.restore(); }
});

test('THE RACE, switch off: the same scan puts the old count back — which is exactly what the hold prevents', async () => {
  const fs = installFirestoreFake({ [DAY('2026-10-02')]: boardRow() }, undefined, { commitSemantics: true });
  try {
    const snapshot = { ...fs.store.get(DAY('2026-10-02')) };
    const { requester } = nuvizz({ stop: rawStop() });
    await runSetStopPieces(requester, { stopNbr: NBR, stopId: ID, pallets: 6, boardDates: ['2026-10-02'] }, CREDS);
    await writeStops('davis', '2026-10-02', [{ ...snapshot }], new Date().toISOString(), {
      includeUnplanned: true, includeLoads: true,
      graceFn: (f, ex) => { applyBoardWriteGrace(f, ex, Date.now()); applyPieceWriteHold(f, ex, Date.now(), false); },
    });
    assert.equal(fs.store.get(DAY('2026-10-02')).cartons, 10, 'without the hold the snapshot wins — the bug this closes');
  } finally { fs.restore(); }
});
