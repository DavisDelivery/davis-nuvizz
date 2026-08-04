import test from 'node:test';
import assert from 'node:assert/strict';

// ── Client-side loading order ────────────────────────────────────────────────

test('loadOrder puts the nose first and the doors last', async () => {
  const { loadOrder } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'A', loadSeq: 3, routeSeq: 1 },
    { stopNbr: 'B', loadSeq: 1, routeSeq: 3 },
    { stopNbr: 'C', loadSeq: 2, routeSeq: 2 },
  ];
  assert.deepEqual(loadOrder(stops).map((s) => s.stopNbr), ['B', 'C', 'A']);
  assert.equal(loadOrder(stops)[0].routeSeq, 3, 'first loaded is the last delivered');
});

test('co-located stops stay adjacent and in a stable order between refreshes', async () => {
  const { loadOrder } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'S9', loadSeq: 2 },
    { stopNbr: 'S1', loadSeq: 1 },
    { stopNbr: 'S3', loadSeq: 2 },
    { stopNbr: 'S7', loadSeq: 3 },
  ];
  const once = loadOrder(stops).map((s) => s.stopNbr);
  const again = loadOrder(stops.slice().reverse()).map((s) => s.stopNbr);
  assert.deepEqual(once, ['S1', 'S3', 'S9', 'S7'], 'the shared position sits together');
  assert.deepEqual(once, again, 'the order does not shuffle when the input order changes');
});

test('a stop with no loadSeq sorts last instead of jumping to the nose', async () => {
  const { loadOrder } = await import('../src/lib/scan-logic.js');
  const out = loadOrder([{ stopNbr: 'X', loadSeq: null }, { stopNbr: 'Y', loadSeq: 5 }]);
  assert.deepEqual(out.map((s) => s.stopNbr), ['Y', 'X']);
});

test('the client fingerprint matches the server fingerprint exactly', async () => {
  const client = await import('../src/lib/scan-logic.js');
  const server = await import('../netlify/functions/lib/manifest.mts');
  const stops = [
    { stopNbr: 'A', routeSeq: 2, loadStopSeq: null },
    { stopNbr: 'B', routeSeq: 1, loadStopSeq: null },
  ];
  assert.equal(
    client.sequenceFingerprint(stops),
    server.sequenceFingerprint(stops),
    'a mismatch here would make the resequence guard fire constantly or never',
  );
});

// ── Hand-confirmed completeness ──────────────────────────────────────────────
// A stop the scanner cannot read still has to close the load, without ever
// being mistaken for a scanned piece.

const averittStop = { stopNbr: '9185096', pros: ['9185096'], expectedPieces: 2, scannable: false };
const ulineStop = { stopNbr: '7152411', pros: ['7152411'], expectedPieces: 3, scannable: true };

test('a hand-confirmed stop completes without a single scan', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const p = stopProgress(averittStop, [], [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.complete, true);
  assert.equal(p.scanned, 2);
  assert.equal(p.scannedPieces, 0, 'nothing was scanned');
  assert.equal(p.confirmedPieces, 2, 'a person vouched for both');
  assert.equal(p.handConfirmed, true);
  assert.equal(p.short, 0);
});

test('a hand-confirm covers only the REMAINDER, so a partly scanned stop cannot double count', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const scans = [{ og: 'OG6028479182', pro: '9185096' }];
  const p = stopProgress(averittStop, scans, [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.scannedPieces, 1);
  assert.equal(p.confirmedPieces, 1, 'one scanned + one confirmed, not one + two');
  assert.equal(p.scanned, 2);
  assert.equal(p.over, 0, 'the count never inflates past expected');
});

test('a hand-confirm on one stop does not touch another', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const p = loadProgress([averittStop, ulineStop], [], [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.expected, 5);
  assert.equal(p.scanned, 2, 'only the confirmed stop counts');
  assert.equal(p.clean, false, 'the Uline stop still has to be scanned');
  assert.deepEqual(p.stopsWithGap.map((s) => s.stopNbr), ['7152411']);
});

test('the load separates scanned pieces from hand-confirmed ones', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const scans = [
    { og: 'OG6028479182', pro: '7152411' },
    { og: 'OG6028479183', pro: '7152411' },
    { og: 'OG6028479184', pro: '7152411' },
  ];
  const p = loadProgress([averittStop, ulineStop], scans, [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.clean, true, 'both stops reconcile, so the load may close');
  assert.equal(p.scannedPieces, 3);
  assert.equal(p.confirmedPieces, 2);
  assert.equal(p.scanned, 5);
  assert.deepEqual(p.handConfirmedStops, ['9185096'], 'the session record names which stops were vouched for');
});

test('with no hand-confirms the progress shape is unchanged', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const p = loadProgress([ulineStop], [{ og: 'OG6028479182', pro: '7152411' }]);
  assert.equal(p.scanned, 1);
  assert.equal(p.confirmedPieces, 0);
  assert.deepEqual(p.handConfirmedStops, []);
  assert.equal(p.short, 2);
});

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
