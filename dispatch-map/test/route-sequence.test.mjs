import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStop } from '../netlify/functions/lib/nuvizz-scan.mts';

// A delivery (DO) stop as it arrives from /load/info: NuVizz's authoritative route
// sequence lives in stop.to.seq (the Route Workbench order). loadStopSeq is only the
// raw array index and must NOT be used for ordering.
function doStop({ stopNbr, toSeq, loadStopSeq, eta }) {
  return {
    stop: {
      stopNbr,
      stopType: 'DO',
      to: { seq: toSeq, address: { name: 'ACME', addr1: '1 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518' } },
      from: { seq: toSeq != null ? toSeq - 1 : null },
    },
    load: { loadNbr: 'DAVIS000197116', stopSeq: loadStopSeq, driverUserName: 'DENIS', driverName: 'DENIS S' },
    stopExecutionInfo: { stopStatus: '20', to: eta ? { plannedEtaDTTM: eta } : {} },
  };
}

test('normalizeStop surfaces NuVizz route sequence as routeSeq (stop.to.seq)', () => {
  const n = normalizeStop(doStop({ stopNbr: '007135631', toSeq: 7, loadStopSeq: 12, eta: '2026-06-19T12:22:36' }));
  assert.equal(n.routeSeq, 7);          // the Workbench order
  assert.equal(n.loadStopSeq, 12);      // raw array order — preserved but not used for sequencing
});

test('routeSeq is present even when no ETA has been computed (not-yet-started route)', () => {
  const n = normalizeStop(doStop({ stopNbr: '007135631', toSeq: 3, loadStopSeq: 0, eta: null }));
  assert.equal(n.routeSeq, 3);
  assert.equal(n.plannedEtaDTTM, null);
});

test('routeSeq is null when NuVizz provides no sequence', () => {
  const raw = doStop({ stopNbr: '007135631', toSeq: null, loadStopSeq: 4, eta: null });
  raw.stop.to.seq = undefined;
  raw.stop.from.seq = undefined;
  const n = normalizeStop(raw);
  assert.equal(n.routeSeq, null);
});

// Sorting check: ordering by routeSeq must match the Route Workbench, even when the
// raw loadStopSeq array order is scrambled relative to the true sequence.
test('ordering by routeSeq matches NuVizz, not the scrambled array order', () => {
  const stops = [
    normalizeStop(doStop({ stopNbr: 'C', toSeq: 3, loadStopSeq: 0, eta: '2026-06-19T11:00:00' })),
    normalizeStop(doStop({ stopNbr: 'A', toSeq: 1, loadStopSeq: 2, eta: '2026-06-19T09:00:00' })),
    normalizeStop(doStop({ stopNbr: 'B', toSeq: 2, loadStopSeq: 1, eta: '2026-06-19T10:00:00' })),
  ];
  const byRouteSeq = [...stops].sort((a, b) => a.routeSeq - b.routeSeq).map((s) => s.stopNbr);
  assert.deepEqual(byRouteSeq, ['A', 'B', 'C']);
  // The raw array order (loadStopSeq) would have produced C, B, A — i.e. wrong.
  const byArray = [...stops].sort((a, b) => a.loadStopSeq - b.loadStopSeq).map((s) => s.stopNbr);
  assert.deepEqual(byArray, ['C', 'B', 'A']);
});
