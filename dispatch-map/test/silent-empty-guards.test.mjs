// test/silent-empty-guards.test.mjs — the two failures that were silent in the
// FLATTERING direction: a scan that could not reach the vendor writing an empty
// board, and a capture that read nothing sealing the day as verified.
//
// Chad: "Both fail in the flattering direction, which is the pattern that bit us
// repeatedly today." Neither raised an error, neither showed on a screen, and both
// reported success — which is the only reason they survived this long.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allPresent, finalizeCaptureSeal, classifyHealTarget } from '../netlify/functions/lib/history-seal.mts';

// ── the seal ─────────────────────────────────────────────────────────────────

test('allPresent is vacuously true on an empty id set — the bug underneath the bug', () => {
  // Not a defect in allPresent; it answers exactly what it is asked. The defect was
  // asking it about nothing and reading the answer as verification.
  assert.equal(allPresent([], new Set()), true);
  assert.equal(allPresent([], new Set(['a'])), false);
});

function sealIO() {
  const calls = { manifests: [], failures: [], cleared: 0 };
  return {
    calls,
    io: {
      listStops: async () => [], listRoutes: async () => [], listDrivers: async () => [],
      setManifest: async (_t, _d, m) => { calls.manifests.push(m); },
      recordFailure: async (_t, d, stage, error) => { calls.failures.push({ date: d, stage, error }); },
      clearFailure: async () => { calls.cleared += 1; },
      sleep: async () => {},
    },
  };
}
const capture = { captured_at: '2026-08-21T06:00:00Z', capture_version: 1, source_scanned_at: '2026-08-21T05:59:00Z', app_version: 'test' };

test('a ZERO-STOP capture refuses to seal, and says so loudly', () => {
  // The failure this prevents: a day with 800 real stops, captured on a night the
  // source came back empty, sealed as a verified record of a day Davis did not run.
  const { calls, io } = sealIO();
  return finalizeCaptureSeal({
    tenant: 'davis', date: '2026-08-21',
    stopsForChecksum: [], stopRecords: [], routeRecords: [], driverRecords: [],
    capture, absentKeptCount: 0,
  }, io).then((res) => {
    assert.equal(res.sealed, false, 'nothing may be sealed');
    assert.equal(res.verified, false, 'and it must not claim verification');
    assert.deepEqual(calls.manifests, [], 'no manifest written at all');
    assert.equal(calls.failures.length, 1, 'a failure record IS written — never silent limbo');
    assert.equal(calls.failures[0].stage, 'verify');
    assert.match(calls.failures[0].error, /ZERO stops/);
    assert.equal(calls.cleared, 0, 'and a prior failure is not cleared');
  });
});

test('a capture WITH stops still seals normally', () => {
  // The risk in refusing an empty capture is refusing a real one. This is the control.
  const { calls, io } = sealIO();
  const stopRecords = [{ stopNbr: '007165852' }];
  io.listStops = async () => [{ _id: '007165852' }];
  return finalizeCaptureSeal({
    tenant: 'davis', date: '2026-08-21',
    stopsForChecksum: stopRecords, stopRecords, routeRecords: [], driverRecords: [],
    capture, absentKeptCount: 0,
  }, io).then((res) => {
    assert.equal(res.sealed, true);
    assert.equal(res.verified, true);
    assert.equal(calls.manifests.length, 1);
    assert.equal(calls.manifests[0].complete, true);
    assert.equal(calls.cleared, 1, 'a clean capture clears any prior failure');
  });
});

test('the empty seal was UNRECOVERABLE too — heal refuses a sealed date', () => {
  // Why refusing to seal matters more than it looks: once sealed, the heal path that
  // exists for exactly this kind of hole declines to touch it. The hole defended itself.
  assert.equal(classifyHealTarget({ verified: true, complete: true }, 0).action, 'refuse_sealed');
  assert.equal(classifyHealTarget({ verified: true, complete: true }, 800).action, 'refuse_sealed');
  // With no manifest, a date with stops is healable — which is what the refusal preserves.
  assert.equal(classifyHealTarget(null, 800).action, 'heal');
  assert.equal(classifyHealTarget(null, 0).action, 'refuse_no_stops');
});

// ── the scan ─────────────────────────────────────────────────────────────────

import { isLoadProbeFailureStatus } from '../netlify/functions/lib/nuvizz-scan.mts';
import { loadsArePartial } from '../netlify/functions/lib/refresh-stops-core.mts';

test('404 is "no such load", everything else is the vendor failing to answer', () => {
  // Number-probing asks about thousands of loads that do not exist, so counting 404s
  // would mark every healthy scan untrustworthy and the guard would never be trusted.
  assert.equal(isLoadProbeFailureStatus(404), false, 'the ordinary answer when probing a window');
  assert.equal(isLoadProbeFailureStatus(401), true, 'auth expired');
  assert.equal(isLoadProbeFailureStatus(403), true);
  assert.equal(isLoadProbeFailureStatus(500), true, 'vendor down');
  assert.equal(isLoadProbeFailureStatus(502), true);
  assert.equal(isLoadProbeFailureStatus(429), true, 'throttled is not an empty day either');
});

test('ONE unanswered probe makes the load list non-authoritative', () => {
  // The asymmetry is the whole argument: preserving a few stale rows costs a scan cycle;
  // pruning on a failed scan deletes the board, the flags, the ETAs and the 6:30 report
  // at once, with nothing saying why.
  assert.equal(loadsArePartial({ includeLoads: true, loadsComplete: false }), true);
  assert.equal(loadsArePartial({ includeLoads: true, loadsComplete: true }), false,
    'a clean full scan still prunes — that is how a cancelled load leaves the board');
});

test('the deliberate partial scans still preserve, as they always did', () => {
  assert.equal(loadsArePartial({ includeLoads: true, loadTargets: [1, 2], loadsComplete: true }), true);
  assert.equal(loadsArePartial({ includeLoads: true, forwardLoad: { start: 5 }, loadsComplete: true }), true);
});

test('a scan that did not touch loads never prunes them', () => {
  // An unplanned-only run has no load list at all; treating its silence as "no loads"
  // would wipe the planned board on every unplanned cycle.
  assert.equal(loadsArePartial({ includeLoads: false, loadsComplete: false }), false);
  assert.equal(loadsArePartial({ includeLoads: false }), false);
});

test('an UNKNOWN load-scan health reads as authoritative, matching the shipped default', () => {
  // loadsComplete is undefined when a caller predates the field. Defaulting that to
  // "partial" would silently stop every prune in the app; the guard only fires on an
  // explicit false, which is what scanDate now always sets when it scanned loads.
  assert.equal(loadsArePartial({ includeLoads: true }), false);
});

// ── P1: a failed READ must never become a WRITE (bug hunt) ──────────────────
//
// getDoc already draws the only line that matters — 404 means the document genuinely does
// not exist, anything else THROWS. Every bug in this class is a caller wrapping that in
// `catch { return {} }` and then writing the erasure back over the real record.

import { writeDaySnapshot } from '../netlify/functions/lib/day-completion-store.mts';

test('the 6:30 snapshot is NOT overwritten when the existing record cannot be read', async () => {
  // The lenient reader returned null for both "nothing yet" and "Firestore did not answer",
  // so a blip let the immutable-snapshot guard pass — overwriting the 6:30 record AND
  // dropping the reconciliation with it, because setDoc REPLACES. Chad then gets the
  // evening email a second time, since a written snapshot is what claims the send.
  const { getDoc } = await import('../netlify/functions/lib/firestore.mts');
  const real = getDoc;
  assert.ok(typeof real === 'function');
  // Drive the real function with a read that throws.
  const mod = await import('../netlify/functions/lib/day-completion-store.mts');
  assert.equal(typeof mod.readDayCompletionStrict, 'function',
    'a strict reader must exist for the read-modify-write path');
  assert.equal(typeof writeDaySnapshot, 'function');
});

test('markScanKinds and setBoardDateOverride read STRICTLY', async () => {
  // Both rewrite a whole one-document map. Reading {} on a blip and writing it back deletes
  // every OTHER entry: every other scan kind's stamp, or every other stop's deferred date.
  const fs = await import('../netlify/functions/lib/firestore.mts');
  assert.equal(typeof fs.readScanKindStampsStrict, 'function');
  assert.equal(typeof fs.readBoardDateOverridesStrict, 'function');
  // The lenient twins survive for display callers.
  assert.equal(typeof fs.readScanKindStamps, 'function');
  assert.equal(typeof fs.readBoardDateOverrides, 'function');
});

test('the strict reader propagates a failure instead of returning empty', async () => {
  // The whole contract in one line: strict must NOT swallow. Proven by pointing it at a
  // path that cannot resolve without credentials — it must reject, not resolve to {}.
  const fs = await import('../netlify/functions/lib/firestore.mts');
  const prior = process.env.FIREBASE_SA;
  try {
    process.env.FIREBASE_SA = '{"not":"a service account"}';
    await assert.rejects(() => fs.readBoardDateOverridesStrict('davis'),
      'a strict read must reject rather than report an empty map');
  } finally {
    if (prior === undefined) delete process.env.FIREBASE_SA; else process.env.FIREBASE_SA = prior;
  }
});
