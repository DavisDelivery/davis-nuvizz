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

test('PRO then OG, one trigger pull after the other, pair into one piece scan', () => {
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS });
  const t0 = 1_000_000;
  assert.equal(buf.push(['7152411'], t0), null, 'half a label is not a piece');
  const pair = buf.push(['OG6028479182'], t0 + 1200);
  assert.deepEqual(pair, { pro: '7152411', og: 'OG6028479182' }, 're-aiming on ONE label is inside the window');
});

test('the gun window is not long enough to reach the next skid', () => {
  // It was 8000ms, on the theory that a human re-aiming is slow. A working
  // operator crosses to the next pallet well inside that, so a half-read label
  // married the NEXT label's barcode: the piece counted against the wrong stop
  // and the right stop went short. Seen on Alfred Morgan's load, Aug 7.
  assert.ok(WEDGE_PAIR_WINDOW_MS <= 2500, 'a pair must be one label, not a rolling window');
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

// ── Half-pairs must not bleed onto the next label ────────────────────────────
//
// ALFRED MORGAN, Aug 7: 25 scanned against 24 expected, five stops at 2/1 while
// FRSTEAM read 5/8 and COREFIVE never started. No surplus freight existed — a
// survivor half-pair had married the next label's barcode, every time one
// barcode failed to read. These are the rules that make that impossible.

test('ACCEPTANCE: PRO A, wait 3s, OG B — no pair, and both are reported unpaired', () => {
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;

  buf.push(['7152411'], t0);                              // PRO A
  const pair = buf.push(['OG6028474461'], t0 + 3000);     // OG from a LATER label
  assert.equal(pair, null, 'A stale PRO must never marry the next label’s OG');

  assert.deepEqual(
    abandoned.map((h) => [h.kind, h.value, h.reason]),
    [['pro', '7152411', 'expired']],
    'the stranded PRO is reported, not silently dropped',
  );

  // B is still pending; it is reported once its own window lapses.
  buf.tick(t0 + 3000 + WEDGE_PAIR_WINDOW_MS + 1);
  assert.deepEqual(
    abandoned.map((h) => [h.kind, h.value]),
    [['pro', '7152411'], ['og', 'OG6028474461']],
    'both halves end up reported unpaired',
  );
});

test('ACCEPTANCE: PRO A, PRO B, OG B — counts once, against B only', () => {
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;

  assert.equal(buf.push(['7152411'], t0), null, 'PRO A waits');
  assert.equal(buf.push(['7158269'], t0 + 400), null, 'PRO B supersedes it — A was abandoned mid-label');
  const pair = buf.push(['OG6028580332'], t0 + 800);

  assert.deepEqual(pair, { pro: '7158269', og: 'OG6028580332' }, 'the OG pairs with B, the label actually in hand');
  assert.deepEqual(
    abandoned.map((h) => [h.kind, h.value, h.reason]),
    [['pro', '7152411', 'superseded']],
    'A is discarded and announced, never silently overwritten',
  );
});

test('two OGs in a row discard the first, same as two PROs', () => {
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['OG6028479182'], t0);
  buf.push(['OG6028580332'], t0 + 300);
  const pair = buf.push(['7158269'], t0 + 600);
  assert.deepEqual(pair, { pro: '7158269', og: 'OG6028580332' }, 'the surviving OG is the most recent one');
  assert.deepEqual(abandoned.map((h) => h.value), ['OG6028479182']);
});

test('a half-pair expires on the clock, with nobody scanning anything else', () => {
  // push() only runs when another barcode arrives. Without tick(), an operator
  // who scans one barcode and walks away hears nothing until the NEXT label —
  // which is the exact moment the stale half does its damage.
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['7152411'], t0);
  assert.equal(buf.tick(t0 + 100), null, 'still inside the window — nothing to say');
  assert.equal(abandoned.length, 0);
  const dropped = buf.tick(t0 + WEDGE_PAIR_WINDOW_MS + 1);
  assert.deepEqual([dropped.kind, dropped.value], ['pro', '7152411']);
  assert.deepEqual(abandoned.map((h) => h.reason), ['expired']);
});

test('a complete one-read label abandons whatever was pending', () => {
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['7152411'], t0);
  const pair = buf.push(['7158269', 'OG6028580332'], t0 + 300);
  assert.deepEqual(pair, { pro: '7158269', og: 'OG6028580332' });
  assert.deepEqual(abandoned.map((h) => h.value), ['7152411'], 'the earlier half belonged to a different label');
});

test('a clean pair reports nothing abandoned', () => {
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['7152411'], t0);
  buf.push(['OG6028479182'], t0 + 500);
  assert.equal(abandoned.length, 0, 'no false alarms on the happy path');
});
