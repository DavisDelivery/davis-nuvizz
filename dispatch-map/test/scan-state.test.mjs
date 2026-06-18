// test/scan-state.test.mjs — incremental-scan shadow helpers (call-reduction Phase 1).
// Pure logic: derive scan_state from a scan's stops + prior state, and compute
// what lean planned-discovery WOULD probe. No network / no Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScanState, shadowWouldProbe } from '../netlify/functions/lib/nuvizz-scan.mts';

const NOW = '2026-07-14T12:00:00.000Z';
// Minimal normalized-stop shape the helpers read.
const stop = (loadNbr, routeName, stopNbr, normalizedStatus, isPlanned = true) =>
  ({ loadNbr, routeName, stopNbr, normalizedStatus, isPlanned });

test('buildScanState: groups planned stops by load; allTerminal only when ALL delivered', () => {
  const stops = [
    stop('196500', 'ATL-NORTH', '007135001', 'DELIVERED'),
    stop('196500', 'ATL-NORTH', '007135002', 'DELIVERED'),        // load 196500 → all delivered
    stop('196501', 'ATL-SOUTH', '007135010', 'DELIVERED'),
    stop('196501', 'ATL-SOUTH', '007135011', 'OUT_FOR_DEL'),      // load 196501 → NOT all terminal
  ];
  const s = buildScanState('2026-07-14', stops, null, NOW);
  const byNbr = Object.fromEntries(s.knownLoads.map((k) => [k.loadNbr, k]));
  assert.equal(s.knownLoads.length, 2);
  assert.equal(byNbr['196500'].allTerminal, true, '196500 all delivered → terminal');
  assert.equal(byNbr['196501'].allTerminal, false, '196501 has an open stop → active');
  assert.equal(s.minLoadNbr, 196500);
  assert.equal(s.maxLoadNbr, 196501);
  assert.equal(s.highWaterStopNbr, 7135011, 'max numeric stopNbr');
  assert.equal(s.routeMap['ATL-NORTH'], '196500');
  assert.equal(s.scanCount, 1);
});

test('buildScanState: an exception/cancelled stop keeps the load active (terminal set is {90,91} only)', () => {
  const s = buildScanState('2026-07-14', [
    stop('196600', 'R1', '1', 'DELIVERED'),
    stop('196600', 'R1', '2', 'EXCEPTION'),
  ], null, NOW);
  assert.equal(s.knownLoads[0].allTerminal, false);
});

test('buildScanState: merges prior roster (unplanned-only cycle never wipes known loads) + bumps scanCount', () => {
  const prev = buildScanState('2026-07-14', [stop('196700', 'R1', '5', 'OUT_FOR_DEL')], null, NOW);
  // next cycle scanned NO planned loads (e.g. unplanned-only) — only an unplanned stop
  const next = buildScanState('2026-07-14', [stop(null, null, '9001', 'UNPLANNED', false)], prev, NOW);
  assert.equal(next.knownLoads.length, 1, 'prior load survives');
  assert.equal(next.knownLoads[0].loadNbr, '196700');
  assert.equal(next.scanCount, 2);
  assert.equal(next.highWaterStopNbr, 9001, 'high-water rises from the unplanned stop');
});

test('buildScanState: a load that flips to all-delivered becomes terminal on the next scan', () => {
  const prev = buildScanState('2026-07-14', [
    stop('196800', 'R1', '1', 'DELIVERED'),
    stop('196800', 'R1', '2', 'ARRIVED'),
  ], null, NOW);
  assert.equal(prev.knownLoads[0].allTerminal, false);
  const next = buildScanState('2026-07-14', [
    stop('196800', 'R1', '1', 'DELIVERED'),
    stop('196800', 'R1', '2', 'DELIVERED'),
  ], prev, NOW);
  assert.equal(next.knownLoads[0].allTerminal, true, 'now frozen-eligible');
});

test('shadowWouldProbe: active loads + forward buffer (larger in routing window)', () => {
  const s = buildScanState('2026-07-14', [
    stop('1', 'A', '1', 'DELIVERED'),       // terminal
    stop('2', 'B', '2', 'OUT_FOR_DEL'),     // active
    stop('3', 'C', '3', 'ARRIVED'),         // active
  ], null, NOW);
  const inW = shadowWouldProbe(s, { inWindow: true, fwdIn: 25, fwdOut: 5 });
  assert.equal(inW.activeLoads, 2);
  assert.equal(inW.terminalLoads, 1);
  assert.equal(inW.wouldProbe, 27, '2 active + 25 in-window buffer');
  const outW = shadowWouldProbe(s, { inWindow: false, fwdIn: 25, fwdOut: 5 });
  assert.equal(outW.wouldProbe, 7, '2 active + 5 out-of-window buffer');
});
