import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePro, isProBarcode, isOgBarcode, classifyBarcode,
  pairFrame, createPairBuffer, evaluateScan, OUTCOME,
  stopProgress, loadProgress, ogGapHint,
} from '../src/lib/scan-logic.js';

// ── Barcode classification ───────────────────────────────────────────────────

test('a PRO barcode is exactly 7 digits', () => {
  assert.equal(isProBarcode('7152411'), true);
  assert.equal(isProBarcode('715241'), false, '6 digits is not a PRO');
  assert.equal(isProBarcode('71524110'), false, '8 digits is not a PRO');
  assert.equal(isProBarcode('OG6028479182'), false);
  assert.equal(isProBarcode(''), false);
});

test('an OG piece ID is OG plus exactly 10 digits', () => {
  assert.equal(isOgBarcode('OG6028479182'), true);
  assert.equal(isOgBarcode('og6028479182'), true, 'case tolerated on input');
  assert.equal(isOgBarcode('OG602847918'), false, '9 digits');
  assert.equal(isOgBarcode('OG60284791821'), false, '11 digits');
  assert.equal(isOgBarcode('XY6028479182'), false);
});

test('normalizePro takes the last 7 digits and ignores punctuation', () => {
  assert.equal(normalizePro('7152411'), '7152411');
  assert.equal(normalizePro('007152411'), '7152411', '9-digit form normalizes to the 7-digit key');
  assert.equal(normalizePro('PRO 715-2411'), '7152411');
  assert.equal(normalizePro(''), '');
  assert.equal(normalizePro(null), '');
});

test('classifyBarcode separates the two symbologies', () => {
  assert.equal(classifyBarcode('7152411').kind, 'pro');
  assert.equal(classifyBarcode('OG6028479182').kind, 'og');
  assert.equal(classifyBarcode('12345678901234').kind, 'unknown');
});

// ── Frame pairing ────────────────────────────────────────────────────────────

test('a frame holding both barcodes is one complete piece scan', () => {
  const r = pairFrame(['7152411', 'OG6028479182']);
  assert.deepEqual({ pro: r.pro, og: r.og, complete: r.complete }, { pro: '7152411', og: 'OG6028479182', complete: true });
});

test('a frame with only one barcode is not complete', () => {
  assert.equal(pairFrame(['7152411']).complete, false);
  assert.equal(pairFrame(['OG6028479182']).complete, false);
});

test('pair buffer joins a PRO and an OG seen in separate frames', () => {
  const buf = createPairBuffer({ windowMs: 2500 });
  assert.equal(buf.push(['7152411'], 1000), null, 'PRO alone waits');
  const pair = buf.push(['OG6028479182'], 1200);
  assert.deepEqual(pair, { pro: '7152411', og: 'OG6028479182' });
});

test('pair buffer will NOT marry a PRO to the next label OG after the window', () => {
  const buf = createPairBuffer({ windowMs: 2500 });
  buf.push(['7152411'], 1000);
  // Driver moved on; this OG belongs to a different label.
  const pair = buf.push(['OG6028474461'], 1000 + 2501);
  assert.equal(pair, null, 'stale half-scan must expire rather than mis-pair');
});

test('pair buffer resets after emitting, so one label cannot emit twice', () => {
  const buf = createPairBuffer();
  assert.ok(buf.push(['7152411', 'OG6028479182'], 1000));
  assert.equal(buf.push(['7152411'], 1100), null);
  assert.deepEqual(buf.state(1100), { pro: '7152411', og: null });
});

// ── Match outcomes ───────────────────────────────────────────────────────────

const stopA = { stopNbr: '7152411', pros: ['7152411'], expectedPieces: 3, businessName: 'ACME', appointmentRequired: false };
const stopAppt = { stopNbr: '7152149', pros: ['7152149'], expectedPieces: 2, businessName: 'BUCK JONES', appointmentRequired: true, instructions: 'APPT REQUIRED call ahead' };

test('a PRO on this load with a new OG is GREEN', () => {
  const r = evaluateScan({ pro: '7152411', og: 'OG6028479182' }, [stopA], new Set());
  assert.equal(r.outcome, OUTCOME.GREEN);
  assert.equal(r.stop.stopNbr, '7152411');
});

test('an appointment stop is AMBER and never green', () => {
  const r = evaluateScan({ pro: '7152149', og: 'OG6028474461' }, [stopAppt], new Set());
  assert.equal(r.outcome, OUTCOME.AMBER);
  assert.match(r.instructions, /APPT/);
});

test('a PRO not on this load is RED and names the owning load', () => {
  const others = [{ loadNbr: 'DAVIS000197999', driverName: 'BRAD', stops: [{ pros: ['9998887'], businessName: 'OTHER CO' }] }];
  const r = evaluateScan({ pro: '9998887', og: 'OG6028400000' }, [stopA], new Set(), others);
  assert.equal(r.outcome, OUTCOME.RED);
  assert.equal(r.owner.loadNbr, 'DAVIS000197999');
  assert.equal(r.owner.driverName, 'BRAD');
});

test('a RED with no resolvable owner still reports red', () => {
  const r = evaluateScan({ pro: '5554443', og: 'OG6028400001' }, [stopA], new Set(), []);
  assert.equal(r.outcome, OUTCOME.RED);
  assert.equal(r.owner, null);
});

test('rescanning the same physical piece is SILENT', () => {
  const seen = new Set(['OG6028479182']);
  const r = evaluateScan({ pro: '7152411', og: 'OG6028479182' }, [stopA], seen);
  assert.equal(r.outcome, OUTCOME.SILENT);
});

test('a different piece of an already-started PRO is still GREEN', () => {
  const seen = new Set(['OG6028479182']);
  const r = evaluateScan({ pro: '7152411', og: 'OG6028479183' }, [stopA], seen);
  assert.equal(r.outcome, OUTCOME.GREEN, 'per-piece, not per-PRO');
});

// ── Completeness ─────────────────────────────────────────────────────────────

test('stop progress counts DISTINCT OGs against expectedPieces', () => {
  const scans = [
    { pro: '7152411', og: 'OG6028479182' },
    { pro: '7152411', og: 'OG6028479183' },
    { pro: '7152411', og: 'OG6028479183' }, // replay
  ];
  const p = stopProgress(stopA, scans);
  assert.equal(p.scanned, 2, 'the replay must not inflate the count');
  assert.equal(p.short, 1);
  assert.equal(p.complete, false);
});

test('a stop reconciles only when distinct OGs equal expectedPieces', () => {
  const scans = ['OG6028479182', 'OG6028479183', 'OG6028479184'].map((og) => ({ pro: '7152411', og }));
  assert.equal(stopProgress(stopA, scans).complete, true);
});

test('scans for another PRO do not count toward this stop', () => {
  const scans = [{ pro: '9998887', og: 'OG6028400000' }];
  assert.equal(stopProgress(stopA, scans).scanned, 0);
});

test('load is not clean while any stop has a gap', () => {
  const scans = [{ pro: '7152411', og: 'OG6028479182' }];
  const lp = loadProgress([stopA, stopAppt], scans);
  assert.equal(lp.clean, false);
  assert.equal(lp.expected, 5);
  assert.equal(lp.scanned, 1);
  assert.equal(lp.stopsWithGap.length, 2);
});

test('an over-count is reported, not silently swallowed', () => {
  const scans = ['OG6028479182', 'OG6028479183', 'OG6028479184', 'OG6028479185'].map((og) => ({ pro: '7152411', og }));
  const p = stopProgress(stopA, scans);
  assert.equal(p.over, 1);
  assert.equal(p.complete, false, 'over is a mismatch and must be resolved too');
});

// ── Contiguity is a hint only ────────────────────────────────────────────────

test('a numeric gap is surfaced as a hint', () => {
  const hint = ogGapHint(['OG6028479182', 'OG6028479184']);
  assert.deepEqual(hint, ['OG6028479183']);
});

test('a contiguous run has no hint', () => {
  assert.equal(ogGapHint(['OG6028479182', 'OG6028479183']), null);
});

test('a gap NEVER changes completeness', () => {
  // Split shipment: two pieces with non-adjacent OGs, expected count of 2.
  const stop = { stopNbr: '1', pros: ['7152411'], expectedPieces: 2, appointmentRequired: false };
  const scans = [
    { pro: '7152411', og: 'OG6028479182' },
    { pro: '7152411', og: 'OG6028479188' },
  ];
  const p = stopProgress(stop, scans);
  assert.equal(p.complete, true, 'counting distinct OGs decides completeness');
  assert.ok(ogGapHint(p.ogs), 'and the gap is still surfaced for the human');
});
