// The capture SEAL — the fix that guarantees every run ends in exactly one of
// sealed | tombstone | loud failure record, never a silent no-manifest limbo.
// Also the heal-refusal contract, the capture-health classification, and the
// proof that a healed manifest re-enters the date listers the miner keys off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allPresent, finalizeCaptureSeal, classifyHealTarget, classifyCaptureDay,
} from '../netlify/functions/lib/history-seal.mts';
import { capturedDatesFromManifests } from '../netlify/functions/lib/history-store.mts';

const CAP = { capture_version: 1, captured_at: '2026-07-08T06:00:00Z', source_scanned_at: '2026-07-08T05:00:00Z', app_version: '0.12.0' };

// Build a fake, in-memory warehouse for one date. `pages` optionally simulates a
// transient under-read: the first N readback calls return a truncated stop list.
function fakeIO({ stops, routes, drivers, underReadTimes = 0, sealThrows = false } = {}) {
  const state = { manifest: null, failures: [], cleared: 0, sealCalls: 0, listCalls: 0 };
  let underLeft = underReadTimes;
  const io = {
    listStops: async () => {
      state.listCalls++;
      if (underLeft > 0) { underLeft--; return stops.slice(0, Math.max(0, stops.length - 1)); } // drop one
      return stops;
    },
    listRoutes: async () => routes,
    listDrivers: async () => drivers,
    setManifest: async (_t, _d, manifest) => {
      state.sealCalls++;
      if (sealThrows) throw new Error('setManifest 503');
      state.manifest = manifest;
    },
    recordFailure: async (_t, _d, stage, error, counts) => { state.failures.push({ stage, error, counts }); },
    clearFailure: async () => { state.cleared++; },
    sleep: async () => {}, // no real delay in tests
  };
  return { io, state };
}

const stopDocs = (ids) => ids.map((n) => ({ _id: String(n), stopNbr: String(n), isPlanned: true }));
const recs = (ids, key) => ids.map((n) => ({ [key]: String(n) }));

test('allPresent: every intended id must appear in the readback', () => {
  assert.equal(allPresent(stopDocs([1, 2, 3]), new Set(['1', '2', '3'])), true);
  assert.equal(allPresent(stopDocs([1, 2]), new Set(['1', '2', '3'])), false);
  assert.equal(allPresent(stopDocs([]), new Set()), true);
});

test('seal: clean verify → manifest sealed, failure cleared, nothing recorded', async () => {
  const stops = stopDocs([1, 2, 3, 4, 5]);
  const { io, state } = fakeIO({ stops, routes: [{ _id: 'L1', loadNbr: 'L1' }], drivers: [{ _id: 'D1', driverKey: 'D1' }] });
  const res = await finalizeCaptureSeal({
    tenant: 'davis', date: '2026-07-08', stopsForChecksum: stops,
    stopRecords: stops, routeRecords: recs(['L1'], 'loadNbr'), driverRecords: recs(['D1'], 'driverKey'),
    capture: CAP, absentKeptCount: 0,
  }, io);
  assert.equal(res.verified, true);
  assert.equal(res.sealed, true);
  assert.equal(res.detail.attempts, 1);
  assert.equal(state.failures.length, 0);
  assert.equal(state.cleared, 1);
  assert.equal(state.manifest.verified, true);
  assert.equal(state.manifest.complete, true);
  assert.equal(state.manifest.counts.stops, 5);
  assert.ok(!state.manifest.healed);
});

test('seal: transient under-read on attempt 1 → RETRY converges, seals, no failure', async () => {
  const stops = stopDocs([1, 2, 3, 4, 5]);
  const { io, state } = fakeIO({ stops, routes: [{ _id: 'L1', loadNbr: 'L1' }], drivers: [{ _id: 'D1', driverKey: 'D1' }], underReadTimes: 1 });
  const res = await finalizeCaptureSeal({
    tenant: 'davis', date: '2026-07-08', stopsForChecksum: stops,
    stopRecords: stops, routeRecords: recs(['L1'], 'loadNbr'), driverRecords: recs(['D1'], 'driverKey'),
    capture: CAP, absentKeptCount: 0, verifyRetries: 3,
  }, io);
  assert.equal(res.sealed, true);
  assert.equal(res.detail.attempts, 2, 'converged on the second readback');
  assert.equal(state.failures.length, 0);
  assert.equal(state.manifest.verified, true);
});

test('seal: verify never converges → NO manifest, LOUD failure record (stage verify)', async () => {
  const stops = stopDocs([1, 2, 3]);
  // readback perpetually drops a stop → never verifies
  const { io, state } = fakeIO({ stops, routes: [], drivers: [], underReadTimes: 999 });
  const res = await finalizeCaptureSeal({
    tenant: 'davis', date: '2026-07-08', stopsForChecksum: stops,
    stopRecords: stops, routeRecords: [], driverRecords: [],
    capture: CAP, absentKeptCount: 0, verifyRetries: 2,
  }, io);
  assert.equal(res.verified, false);
  assert.equal(res.sealed, false);
  assert.equal(res.detail.attempts, 3, '1 + 2 retries');
  assert.equal(state.sealCalls, 0, 'never wrote a manifest');
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].stage, 'verify');
  assert.equal(state.cleared, 0);
});

test('seal: manifest write fails → verified but NOT sealed, LOUD failure record (stage seal)', async () => {
  const stops = stopDocs([1, 2, 3]);
  const { io, state } = fakeIO({ stops, routes: [], drivers: [], sealThrows: true });
  const res = await finalizeCaptureSeal({
    tenant: 'davis', date: '2026-07-08', stopsForChecksum: stops,
    stopRecords: stops, routeRecords: [], driverRecords: [],
    capture: CAP, absentKeptCount: 0,
  }, io);
  assert.equal(res.verified, true);
  assert.equal(res.sealed, false);
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].stage, 'seal');
  assert.equal(state.cleared, 0);
});

test('seal: healed run stamps healed:true + healed_at', async () => {
  const stops = stopDocs([1, 2, 3]);
  const { io, state } = fakeIO({ stops, routes: [], drivers: [] });
  const res = await finalizeCaptureSeal({
    tenant: 'davis', date: '2026-06-24', stopsForChecksum: stops,
    stopRecords: stops, routeRecords: [], driverRecords: [],
    capture: CAP, absentKeptCount: 0, healed: true,
  }, io);
  assert.equal(res.sealed, true);
  assert.equal(state.manifest.healed, true);
  assert.ok(typeof state.manifest.healed_at === 'string');
  assert.equal(state.manifest.verified, true); // healed only when the real checks pass
});

test('seal: checksum is stable across runs on the same stops (heal reproduces the original)', async () => {
  const stops = stopDocs([3, 1, 2]); // order-independent
  const mk = () => fakeIO({ stops, routes: [], drivers: [] });
  const a = mk(), b = fakeIO({ stops: stopDocs([2, 3, 1]), routes: [], drivers: [] });
  const ra = await finalizeCaptureSeal({ tenant: 'davis', date: '2026-07-08', stopsForChecksum: stops, stopRecords: stops, routeRecords: [], driverRecords: [], capture: CAP, absentKeptCount: 0 }, a.io);
  const rb = await finalizeCaptureSeal({ tenant: 'davis', date: '2026-07-08', stopsForChecksum: stopDocs([2, 3, 1]), stopRecords: stopDocs([2, 3, 1]), routeRecords: [], driverRecords: [], capture: CAP, absentKeptCount: 0 }, b.io);
  assert.equal(ra.checksum, rb.checksum);
});

// ── heal refusal / idempotency ───────────────────────────────────────────────

test('classifyHealTarget: refuses a sealed day, refuses a tombstone, refuses no-stops, else heals', () => {
  assert.equal(classifyHealTarget({ verified: true }, 700).action, 'refuse_sealed');
  assert.equal(classifyHealTarget({ complete: true }, 700).action, 'refuse_sealed');
  assert.equal(classifyHealTarget({ no_board: true, complete: true }, 0).action, 'refuse_tombstone');
  assert.equal(classifyHealTarget(null, 0).action, 'refuse_no_stops');
  assert.equal(classifyHealTarget(null, 725).action, 'heal');
  // idempotency: after a heal seals the day, a second run sees the sealed manifest and refuses
  assert.equal(classifyHealTarget({ verified: true, healed: true }, 725).action, 'refuse_sealed');
});

// ── capture-health classification ────────────────────────────────────────────

test('classifyCaptureDay: every state', () => {
  assert.equal(classifyCaptureDay({ no_board: true }, null, true).state, 'tombstone');
  assert.equal(classifyCaptureDay({ healed: true, verified: true }, null, false).state, 'healed');
  assert.equal(classifyCaptureDay({ verified: true }, null, false).state, 'sealed');
  assert.equal(classifyCaptureDay({ complete: true }, null, false).state, 'sealed');
  assert.equal(classifyCaptureDay(null, { stage: 'verify' }, false).state, 'failed');
  assert.equal(classifyCaptureDay({ /* present but unsealed */ }, null, false).state, 'failed');
  assert.equal(classifyCaptureDay(null, null, true).state, 'idle_weekend');
  assert.equal(classifyCaptureDay(null, null, false).state, 'missing');
});

// ── the orphan becomes visible to the miner after healing ────────────────────

test('healed manifest re-enters the captured-date listing the miner keys off', () => {
  const before = [
    { _id: 'davis__2026-06-23' }, { _id: 'davis__2026-06-25' }, // 06-24 orphaned (no manifest)
    { _id: 'other__2026-06-24' }, // different tenant — excluded
  ];
  const beforeDates = capturedDatesFromManifests(before, 'davis');
  assert.ok(!beforeDates.includes('2026-06-24'), 'orphan absent before heal');

  // heal writes history_days/davis__2026-06-24 (an ordinary manifest doc, healed:true)
  const after = [...before, { _id: 'davis__2026-06-24', healed: true, verified: true }];
  const afterDates = capturedDatesFromManifests(after, 'davis');
  assert.ok(afterDates.includes('2026-06-24'), 'healed day now listed → miner sees it');
  assert.deepEqual(afterDates, ['2026-06-23', '2026-06-24', '2026-06-25']);
});
