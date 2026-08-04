import test from 'node:test';
import assert from 'node:assert/strict';

import { createWedgeAccumulator, WEDGE_PAIR_WINDOW_MS, WEDGE_MAX_LENGTH } from '../src/lib/wedge.js';
import { createPairBuffer, classifyBarcode } from '../src/lib/scan-logic.js';

const type = (acc, s) => [...s].forEach((ch) => acc.key(ch));

// ── Keystroke accumulation ───────────────────────────────────────────────────

test('a keystroke burst commits on Enter as one barcode', () => {
  const seen = [];
  const acc = createWedgeAccumulator({ onScan: (v) => seen.push(v) });
  type(acc, '7152411');
  assert.deepEqual(seen, [], 'nothing until the suffix');
  acc.key('Enter');
  assert.deepEqual(seen, ['7152411']);
  assert.equal(acc.value(), '', 'buffer cleared after commit');
});

test('Tab is a commit key too — DataWedge is configurable', () => {
  const seen = [];
  const acc = createWedgeAccumulator({ onScan: (v) => seen.push(v) });
  type(acc, 'OG6028479182');
  acc.key('Tab');
  assert.deepEqual(seen, ['OG6028479182']);
});

test('modifier and navigation keys are ignored, not accumulated', () => {
  const seen = [];
  const acc = createWedgeAccumulator({ onScan: (v) => seen.push(v) });
  assert.equal(acc.key('Shift'), false);
  type(acc, '715');
  assert.equal(acc.key('ArrowLeft'), false);
  type(acc, '2411');
  acc.key('Enter');
  assert.deepEqual(seen, ['7152411'], 'only printable characters made it in');
});

test('an empty or whitespace-only commit emits nothing', () => {
  const seen = [];
  const acc = createWedgeAccumulator({ onScan: (v) => seen.push(v) });
  acc.key('Enter');
  type(acc, '  ');
  acc.key('Enter');
  assert.deepEqual(seen, []);
});

test('a runaway buffer is discarded, never trusted as a barcode', () => {
  const seen = [];
  const acc = createWedgeAccumulator({ onScan: (v) => seen.push(v) });
  type(acc, 'X'.repeat(WEDGE_MAX_LENGTH + 1));
  acc.key('Enter');
  assert.deepEqual(seen, [], 'overflow drops the buffer');
});

test('consumed keys report true so the caller can preventDefault', () => {
  const acc = createWedgeAccumulator({ onScan: () => {} });
  assert.equal(acc.key('7'), true, 'printable');
  assert.equal(acc.key('Enter'), true, 'commit');
  assert.equal(acc.key('F5'), false, 'function keys pass through');
});

// ── Two trigger pulls pair into one piece ────────────────────────────────────

test('PRO then OG, seconds apart, pair into one piece scan', () => {
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS });
  const t0 = 1_000_000;
  assert.equal(buf.push(['7152411'], t0), null, 'half a label is not a piece');
  const pair = buf.push(['OG6028479182'], t0 + 5000);
  assert.deepEqual(pair, { pro: '7152411', og: 'OG6028479182' }, '5s between pulls is normal gun pace');
});

test('a lone half-scan expires before the next pallet, in either order', () => {
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS });
  const t0 = 1_000_000;
  buf.push(['OG6028479182'], t0);
  const pair = buf.push(['7152411'], t0 + WEDGE_PAIR_WINDOW_MS + 1);
  assert.equal(pair, null, 'a stale OG cannot marry the next label’s PRO');
});

test('wedge strings classify identically to camera strings', () => {
  assert.equal(classifyBarcode('7152411').kind, 'pro');
  assert.equal(classifyBarcode('og6028479182').kind, 'og', 'case-normalized like the camera path');
  assert.equal(classifyBarcode('LOT-20260804').kind, 'unknown', 'other dock barcodes fall through silently');
});
