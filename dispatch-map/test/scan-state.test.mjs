// test/scan-state.test.mjs — incremental-scan shadow helpers (call-reduction Phase 1).
// Pure logic: derive scan_state from a scan's stops + prior state, and compute
// what lean planned-discovery WOULD probe. No network / no Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScanState, shadowWouldProbe, loadNbrToInt, selectLoadProbeTargets, unplannedFloor } from '../netlify/functions/lib/nuvizz-scan.mts';

test('unplannedFloor: null sinceStopNbr → full estimated floor; set → just below high-water', () => {
  assert.equal(unplannedFloor(7_120_000, null), 7_120_000, 'no high-water → full descent floor');
  assert.equal(unplannedFloor(7_120_000, undefined), 7_120_000);
  // sinceStopNbr well above the estimated floor → raise the floor to highWater-50.
  assert.equal(unplannedFloor(7_120_000, 7_135_000), 7_134_950, 'descend only new numbers + 50 buffer');
  // never go BELOW the estimated floor (a low high-water shouldn't widen the scan).
  assert.equal(unplannedFloor(7_120_000, 7_119_000), 7_120_000, 'floor never drops below the estimate');
});

// Hand-built scan_state for the planner tests.
const mkLoad = (n, allTerminal) => ({ loadNbr: `DAVIS${String(n).padStart(9, '0')}`, routeName: `R${n}`, allTerminal, lastSeenAt: NOW });
const mkState = (loads, scanCount = 1) => {
  const nums = loads.map((l) => loadNbrToInt(l.loadNbr));
  return { date: '2026-07-14', knownLoads: loads, minLoadNbr: Math.min(...nums), maxLoadNbr: Math.max(...nums), highWaterStopNbr: 1, routeMap: {}, lastScanAt: NOW, scanCount };
};

test('selectLoadProbeTargets: WARM = non-terminal loads + forward buffer; terminal-skipped', () => {
  const st = mkState([mkLoad(196998, true), mkLoad(196999, false), mkLoad(197000, false)], 1);
  const plan = selectLoadProbeTargets(st, { inWindow: true, scanCount: 1, fwdIn: 50, fwdOut: 10, gapSweepEvery: 3 });
  assert.equal(plan.mode, 'lean-warm');
  assert.equal(plan.activeLoads, 2, 'two non-terminal loads re-pulled');
  assert.equal(plan.gapSweep, false, 'scanCount 1 → no gap sweep');
  assert.ok(plan.numbers.includes(196999) && plan.numbers.includes(197000), 'active loads probed');
  assert.ok(!plan.numbers.includes(196998), 'terminal load skipped');
  assert.ok(plan.numbers.includes(197050) && !plan.numbers.includes(197051), 'forward buffer of 50 above max');
  assert.equal(plan.numbers.length, 2 + 50);
});

test('selectLoadProbeTargets: gap sweep every 3rd cycle in-window fills missing numbers', () => {
  const st = mkState([mkLoad(196998, false), mkLoad(197000, false)], 3); // 196999 is a gap
  const plan = selectLoadProbeTargets(st, { inWindow: true, scanCount: 3, gapSweepEvery: 3 });
  assert.equal(plan.gapSweep, true);
  assert.ok(plan.numbers.includes(196999), 'gap 196999 swept');
});

test('selectLoadProbeTargets: out-of-window = small buffer, never gap-sweeps', () => {
  const st = mkState([mkLoad(196998, false), mkLoad(197000, false)], 3);
  const plan = selectLoadProbeTargets(st, { inWindow: false, scanCount: 3, fwdIn: 50, fwdOut: 10, gapSweepEvery: 3 });
  assert.equal(plan.forwardBuffer, 10);
  assert.equal(plan.gapSweep, false, 'no gap sweep outside the routing window');
});

test('selectLoadProbeTargets: COLD START (no roster yet) → null so caller uses the wide-window probe', () => {
  // Even with a prior day available, cold start must NOT seed a one-directional span
  // (could miss a non-contiguous day's loads); it falls back to the proven wide window.
  assert.equal(selectLoadProbeTargets(null, { inWindow: true, scanCount: 0, fwdIn: 50 }), null);
});

test('loadNbrToInt: extracts the embedded integer from the prefixed/padded loadNbr', () => {
  assert.equal(loadNbrToInt('DAVIS000196999'), 196999);
  assert.equal(loadNbrToInt('196500'), 196500);
  assert.equal(loadNbrToInt(''), null);
  assert.equal(loadNbrToInt(null), null);
});

test('buildScanState: min/max use the embedded integer for real prefixed loadNbrs', () => {
  const s = buildScanState('2026-07-14', [
    { loadNbr: 'DAVIS000196999', routeName: 'BEN 1', stopNbr: '007133547', normalizedStatus: 'DELIVERED', isPlanned: true },
    { loadNbr: 'DAVIS000197048', routeName: 'MITCHELL', stopNbr: '007133675', normalizedStatus: 'SCHEDULED', isPlanned: true },
  ], null, NOW);
  assert.equal(s.minLoadNbr, 196999);
  assert.equal(s.maxLoadNbr, 197048);
});

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
  const inW = shadowWouldProbe(s, { inWindow: true });   // overnight defaults: +50
  assert.equal(inW.activeLoads, 2);
  assert.equal(inW.terminalLoads, 1);
  assert.equal(inW.wouldProbe, 52, '2 active + 50 in-window (overnight) buffer');
  const outW = shadowWouldProbe(s, { inWindow: false });  // daytime default: +10
  assert.equal(outW.wouldProbe, 12, '2 active + 10 out-of-window (daytime) buffer');
});
