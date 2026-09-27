// last-skid-top-scan.test.mjs — the last skid of an order, scanned top barcode
// first, is counted ONCE and the loader is never told it was NOT COUNTED.
//
// With an order open, a lone piece id books the instant it decodes (noteRaw ->
// onLoneOgRef). The same frame still goes to the pair buffer, so when the PRO on
// that label decodes inside the window — normal with Quagga holding aim, and
// every time with the gun — the buffer emits {pro, og} for the piece that is
// already aboard. record() asked "is the stop full?" BEFORE "is this piece id
// already aboard?", and on the order's last skid the stop IS full, because of
// that very piece. Result: the full-screen NOT COUNTED, the dup buzz, and an
// "Add OVER the count" button — the reflex behind the 4/2 incident — for a skid
// that was counted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createPairBuffer, stopProgress, evaluateScan, pieceAlreadyAboard, OUTCOME } from '../src/lib/scan-logic.js';

// DIVINELY GUIDED: one order, PRO 7173250, two skids.
const STOP = { stopNbr: '12', businessName: 'DIVINELY GUIDED', pros: ['7173250'], expectedPieces: 2 };
const booked = (og) => ({ og, pro: '7173250', stopNbr: '12', engine: 'quagga', scannedAt: '2026-09-15T01:30:00.000Z' });

test('the PRO of the last skid, read after its top barcode booked, pairs with a piece already aboard', () => {
  const buf = createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  // Skid 1, both barcodes: the pair that opens the order.
  assert.deepEqual(buf.push(['7173250'], t0), null);
  assert.deepEqual(buf.push(['OG6028250001'], t0 + 100), { pro: '7173250', og: 'OG6028250001' });
  // Skid 2: its piece id decodes (and books at once off the raw stream) ...
  assert.equal(buf.push(['OG6028250002'], t0 + 20_000), null);
  // ... and 600ms later the PRO on the same label completes a pair with it.
  const pair = buf.push(['7173250'], t0 + 20_600);
  assert.deepEqual(pair, { pro: '7173250', og: 'OG6028250002' });

  // By then the stop is full BECAUSE of that piece.
  const aboard = [booked('OG6028250001'), booked('OG6028250002')];
  assert.deepEqual(
    (({ scanned, expected }) => ({ scanned, expected }))(stopProgress(STOP, aboard)),
    { scanned: 2, expected: 2 },
  );

  // The only right answer is the silent duplicate: this skid is counted.
  const liveOgs = new Set(aboard.map((s) => s.og));
  assert.equal(pieceAlreadyAboard(pair, liveOgs), true);
  assert.equal(evaluateScan(pair, [STOP], liveOgs).outcome, OUTCOME.SILENT);
});

test('a new piece id, or no piece id at all, is never mistaken for one already aboard', () => {
  const liveOgs = new Set(['OG6028250001', 'OG6028250002']);
  assert.equal(pieceAlreadyAboard({ pro: '7173250', og: 'OG6028250003' }, liveOgs), false, 'a third skid is a real piece');
  assert.equal(pieceAlreadyAboard({ pro: '7173250', og: null }, liveOgs), false, 'the override carries no id');
  assert.equal(pieceAlreadyAboard({ pro: '7173250', og: 'og6028250002' }, liveOgs), true, 'case does not matter');
  assert.equal(pieceAlreadyAboard({ pro: '7173250', og: 'OG6028250002' }, null), false);
});

test('record() asks "is this piece already aboard?" BEFORE "is the stop full?"', async () => {
  // record() is a React callback over IndexedDB and cannot run here, so the order
  // of its two questions is pinned on the source: it is a contract between the
  // top-barcode path and the pair path that neither module can see alone.
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('const record = useCallback('));
  const aboardAt = body.indexOf('pieceAlreadyAboard(pair, liveOgs)');
  const fullAt = body.indexOf('if (!isOverride && countKnown && done.scanned >= done.expected)');
  assert.ok(aboardAt > 0, 'record() checks the piece id against what is aboard');
  assert.ok(fullAt > 0, 'the stop-full refusal is still there');
  assert.ok(aboardAt < fullAt, 'and the piece-id check comes first');
  assert.match(body.slice(aboardAt - 80, aboardAt), /!isOverride &&/, 'a deliberate override is never swallowed');
});
