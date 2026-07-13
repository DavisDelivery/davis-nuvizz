// lib/history-seal.mts
//
// The SEAL — the one code path that turns a set of captured stop records into a
// verified history_days manifest, shared by the nightly capture (history-core)
// and the manifest-heal function so a healed seal is byte-for-byte the same
// operation as a fresh one. Also owns the LOUD failure record.
//
// Why this module exists: a capture used to end its life in one of three ways —
// a sealed manifest, a SILENT early return when verify-by-readback came back
// false, or an uncaught throw that the scheduled (background) wrapper swallowed
// as an invisible 500. The last two look identical from the outside: a full set
// of stop docs with NO manifest, so every date-lister (reference miner, replay,
// nightly engine) skips the day forever. That is exactly how six fully-captured
// nights (2026-06-24, -06-25, -07-01, -07-02, -07-07, -07-10) went missing.
//
// The fix, enforced here: every capture terminates in EXACTLY ONE of
//   • a sealed manifest              (verify passed → sealManifestFromRecords)
//   • a tombstone                    (no board — history-core writeTombstone)
//   • a durable failure record       (recordCaptureFailure, stage + reason)
// never silence. The verify-by-readback is also RETRIED before it gives up,
// because the dominant trigger is a transient/eventually-consistent under-read
// of the readback list — the stops are all on disk, the verifier just blinked.
//
// Firestore-only. Zero NuVizz calls.

import { getDoc, setDoc, deleteDoc, listDocs } from './firestore.mts';
import {
  computeStopChecksum, manifestCountsFromReadback, type CaptureMeta,
} from './history-derive.mts';
import {
  dayPath, setManifest, listStops, listRoutes, listDrivers, histDocId,
} from './history-store.mts';

export const CAPTURE_FAILURES_COLLECTION = 'history_capture_failures';

export function captureFailureId(tenant: string, date: string): string {
  return `${tenant}__${date}`;
}
export function captureFailurePath(tenant: string, date: string): string {
  return `${CAPTURE_FAILURES_COLLECTION}/${captureFailureId(tenant, date)}`;
}

export type CaptureStage = 'scan' | 'derive' | 'upsert' | 'verify' | 'seal' | 'exception';

// LOUD, durable record that a capture could not seal. One doc per date (latest
// failure wins); cleared the moment the date successfully seals.
export async function recordCaptureFailure(
  tenant: string, date: string, stage: CaptureStage, error: string, countsSoFar: any = null,
): Promise<void> {
  try {
    await setDoc(captureFailurePath(tenant, date), {
      tenant, date, stage,
      error: String(error || '').slice(0, 500),
      counts_so_far: countsSoFar,
      at: new Date().toISOString(),
    });
    console.error(`[history-seal] FAILURE recorded ${date} stage=${stage}: ${error}`);
  } catch (e: any) {
    // A failure while recording the failure must still be loud, but must never
    // mask the original error.
    console.error(`[history-seal] could not write failure record for ${date}:`, e?.message);
  }
}

export async function clearCaptureFailure(tenant: string, date: string): Promise<void> {
  try { await deleteDoc(captureFailurePath(tenant, date)); } catch { /* best-effort */ }
}

export async function getCaptureFailure(tenant: string, date: string): Promise<any | null> {
  return getDoc(captureFailurePath(tenant, date));
}

export async function listCaptureFailures(tenant: string): Promise<any[]> {
  const rows = await listDocs(CAPTURE_FAILURES_COLLECTION);
  return rows.filter((r) => r && r.tenant === tenant);
}

// PURE: is every intended id present in the readback? Exported for tests.
export function allPresent(docs: any[], ids: Set<string>): boolean {
  const have = new Set(docs.map((d) => String(d._id)));
  for (const id of ids) if (!have.has(id)) return false;
  return true;
}

// Injectable I/O so the seal flow is unit-testable without Firestore. Production
// callers use the defaults (the real warehouse store); tests pass fakes.
export interface SealIO {
  listStops: (tenant: string, date: string) => Promise<any[]>;
  listRoutes: (tenant: string, date: string) => Promise<any[]>;
  listDrivers: (tenant: string, date: string) => Promise<any[]>;
  setManifest: (tenant: string, date: string, manifest: any) => Promise<void>;
  recordFailure: (tenant: string, date: string, stage: CaptureStage, error: string, counts: any) => Promise<void>;
  clearFailure: (tenant: string, date: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_IO: SealIO = {
  listStops, listRoutes, listDrivers, setManifest,
  recordFailure: recordCaptureFailure,
  clearFailure: clearCaptureFailure,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

export interface FinalizeInput {
  tenant: string;
  date: string;
  stopsForChecksum: any[];       // normalized stops OR stored stop docs — same 4 checksum fields
  stopRecords: any[];            // records written to /stops (have .stopNbr)
  routeRecords: any[];           // records written to /routes (have .loadNbr)
  driverRecords: any[];          // records written to /drivers (have .driverKey)
  capture: CaptureMeta;
  absentKeptCount: number;
  healed?: boolean;
  verifyRetries?: number;        // extra readback attempts before giving up
}

export interface FinalizeResult {
  verified: boolean;
  sealed: boolean;               // manifest actually written (verified AND the seal write landed)
  counts: any;
  checksum: string;
  detail: { stopsOk: boolean; routesOk: boolean; driversOk: boolean; attempts: number };
}

// The shared terminal step: readback-verify (with retry), then either seal the
// manifest + clear any failure record, or write a failure record. Returns the
// outcome; NEVER leaves the date in a silent no-manifest/no-failure limbo.
// `io` is injectable for tests; production uses the real warehouse store.
export async function finalizeCaptureSeal(input: FinalizeInput, io: Partial<SealIO> = {}): Promise<FinalizeResult> {
  const {
    tenant, date, stopsForChecksum, stopRecords, routeRecords, driverRecords,
    capture, absentKeptCount, healed = false, verifyRetries = 3,
  } = input;
  const $ = { ...DEFAULT_IO, ...io };

  // IDs must equal the readback doc _ids (the sanitized path segments). routes/drivers
  // go through histDocId on write, so the verify set uses it too — otherwise a slashed
  // route ("COLIN/DJ 1" → "COLIN_DJ 1") would never "match" its own doc and the seal
  // would be withheld. Stops are keyed by numeric stopNbr (already path-safe).
  const stopIds = new Set(stopRecords.map((r) => String(r.stopNbr)));
  const routeIds = new Set(routeRecords.map((r) => histDocId(String(r.loadNbr))));
  const driverIds = new Set(driverRecords.map((r) => histDocId(String(r.driverKey))));
  const checksum = computeStopChecksum(stopsForChecksum);

  let stopsOk = false, routesOk = false, driversOk = false, attempts = 0;
  let rbStops: any[] = [], rbRoutes: any[] = [], rbDrivers: any[] = [];
  // Retry the readback: the seal's historical failure mode is a transient
  // under-read here, not a genuinely incomplete write. Back off between tries.
  for (let attempt = 1; attempt <= 1 + Math.max(0, verifyRetries); attempt++) {
    attempts = attempt;
    [rbStops, rbRoutes, rbDrivers] = await Promise.all([
      $.listStops(tenant, date), $.listRoutes(tenant, date), $.listDrivers(tenant, date),
    ]);
    stopsOk = allPresent(rbStops, stopIds);
    routesOk = allPresent(rbRoutes, routeIds);
    driversOk = allPresent(rbDrivers, driverIds);
    if (stopsOk && routesOk && driversOk) break;
    if (attempt <= verifyRetries) await $.sleep(400 * attempt);
  }
  const verified = stopsOk && routesOk && driversOk;
  const counts = manifestCountsFromReadback(rbStops, rbRoutes, rbDrivers);
  const detail = { stopsOk, routesOk, driversOk, attempts };

  if (!verified) {
    await $.recordFailure(tenant, date, 'verify',
      `verify-by-readback did not converge after ${attempts} attempt(s): ` +
      `stopsOk=${stopsOk} routesOk=${routesOk} driversOk=${driversOk}`,
      { intended: { stops: stopIds.size, routes: routeIds.size, drivers: driverIds.size }, persisted: counts });
    return { verified: false, sealed: false, counts, checksum, detail };
  }

  // SEAL. If the manifest write itself fails, that is a loud failure record too
  // (stage 'seal') — never a silent throw the background wrapper would swallow.
  const manifest: any = {
    tenant, date,
    captured_at: capture.captured_at,
    capture_version: capture.capture_version,
    source_scanned_at: capture.source_scanned_at,
    app_version: capture.app_version,
    counts,
    checksum,
    verified: true,
    complete: true,
    absent_kept_count: absentKeptCount,
  };
  if (healed) { manifest.healed = true; manifest.healed_at = new Date().toISOString(); }
  try {
    await $.setManifest(tenant, date, manifest);
  } catch (e: any) {
    await $.recordFailure(tenant, date, 'seal', e?.message || 'setManifest failed', counts);
    return { verified: true, sealed: false, counts, checksum, detail };
  }
  await $.clearFailure(tenant, date);
  return { verified: true, sealed: true, counts, checksum, detail };
}

// PURE: how the heal function decides what to do with a candidate date. Exported
// so the refusal/idempotency contract is unit-testable without Firestore.
export function classifyHealTarget(existingManifest: any | null, storedStopCount: number):
  { action: 'refuse_sealed' | 'refuse_tombstone' | 'refuse_no_stops' | 'heal' } {
  if (existingManifest && existingManifest.no_board) return { action: 'refuse_tombstone' };
  if (existingManifest && (existingManifest.verified || existingManifest.complete)) return { action: 'refuse_sealed' };
  if (!storedStopCount) return { action: 'refuse_no_stops' };
  return { action: 'heal' };
}

// PURE: capture-health state for one date from cheap inputs (its manifest, its
// failure record, and whether it's a weekend). Exported for tests + reused shape.
export function classifyCaptureDay(manifest: any | null, failure: any | null, weekend: boolean):
  { state: 'sealed' | 'healed' | 'tombstone' | 'failed' | 'missing' | 'idle_weekend' } {
  if (manifest && manifest.no_board) return { state: 'tombstone' };
  if (manifest && manifest.healed) return { state: 'healed' };
  if (manifest && (manifest.verified || manifest.complete)) return { state: 'sealed' };
  if (failure) return { state: 'failed' };
  if (manifest) return { state: 'failed' }; // manifest present but unsealed — still a hole
  if (weekend) return { state: 'idle_weekend' };
  return { state: 'missing' };
}

// Tombstone: a date that genuinely has no board (typically a weekend / holiday
// Davis didn't run). Marks the hole as intentionally empty so date-listers stop
// treating it as missing. Never overwrites a real sealed manifest.
export async function writeTombstone(tenant: string, date: string, reason: string): Promise<void> {
  await setManifest(tenant, date, {
    tenant, date,
    no_board: true,
    complete: true,
    verified: true,
    counts: { stops: 0, planned: 0, unplanned: 0, routes: 0, drivers: 0 },
    tombstone_reason: String(reason || '').slice(0, 200),
    tombstoned_at: new Date().toISOString(),
  });
  await clearCaptureFailure(tenant, date);
}
