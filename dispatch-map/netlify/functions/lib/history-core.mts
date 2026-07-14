// lib/history-core.mts
//
// Shared core for the immutable daily history capture (Phase 1). Mirrors
// refresh-stops-core.mts: one exported handler that the scheduled wrapper
// delegates to, with manual HTTP overrides for backfill. The ONLY NuVizz read is
// scanDate(targetDate) — routes and drivers are DERIVED by grouping that one
// scan (lib/history-derive.mts). NuVizz is read-only; the live nuvizz_stop_index
// cache is never touched.
//
// Per-date capture flow (captureDate):
//   1. scanDate(date) — one NuVizz read.
//   2. Derive stop / route / driver records + a content checksum (pure).
//   3. Allocate capture_version = max(existing) + 1 for that date.
//   4. UPSERT stops, routes, drivers (NEVER prune — immutability of the past).
//   5. Upsert cross-day driver-day pointers.
//   6. VERIFY-BY-READBACK: list each subcollection and assert every intended doc
//      landed. Manifest counts come from the readback, never an in-memory counter.
//   7. Append the captures/v{n} audit doc (lineage — written even on mismatch).
//   8. Write the MANIFEST LAST, only when verified — so a reader never sees a
//      fresh manifest over a half-written set. On mismatch: log loudly, no clean
//      manifest, non-200 for manual runs.

import { scanDate } from './nuvizz-scan.mts';
import { setCallTrigger } from './nuvizz-request.mts';
import { isFirestoreEnabled, readStops } from './firestore.mts';
import {
  buildStopRecord, deriveRoutes, deriveDrivers, type CaptureMeta, type DeriveCtx,
} from './history-derive.mts';
import {
  listCaptures, appendCapture, listStops,
  upsertStops, upsertRoutes, upsertDrivers, upsertDriverDayPointer,
} from './history-store.mts';
import { finalizeCaptureSeal, recordCaptureFailure, type CaptureStage } from './history-seal.mts';
import { runPostSealHooks } from './history-postseal.mts';

const TENANT = 'davis';
// Keep in sync with src/App.jsx APP_VERSION. Stamped onto every manifest/capture
// so we can tell which code version captured a given day.
const APP_VERSION = '0.12.0';
const MAX_BACKFILL_DAYS = 31;

// ── ET scheduling ────────────────────────────────────────────────────────────
// Target date for a scheduled run = the America/New_York calendar day that just
// ended ("yesterday" in ET), computed off the ET clock so DST never shifts it.
function etDateString(d: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
export function etYesterday(now: Date = new Date()): string {
  const todayET = etDateString(now);
  const d = new Date(todayET + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A YYYY-MM-DD calendar date's weekday is timezone-independent (noon UTC avoids
// any DST edge). 0 = Sun, 6 = Sat. Exported for tests.
export function isWeekendDate(dateStr: string): boolean {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

// Parse manual overrides (mirrors refresh-stops-core): ?date=YYYY-MM-DD (single)
// or ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, ≤31 days). No query → ET-yesterday.
export function resolveDates(req: Request): string[] {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (date && DATE_RE.test(date)) return [date];
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
      let lo = from, hi = to;
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      const dates: string[] = [];
      for (let d = lo; d <= hi && dates.length < MAX_BACKFILL_DAYS; d = addDaysUTC(d, 1)) dates.push(d);
      return dates;
    }
  } catch { /* fall through to scheduled default */ }
  // Scheduled default: archive ET-yesterday — but SKIP weekend target days. Davis
  // doesn't work weekends, so a Sat/Sun capture archives an empty day at full scan
  // cost (~1,200 NuVizz calls) — and it can't even reuse the live index, since the
  // live scan is itself blacked out on weekends. Friday is still captured (Sat run)
  // and Monday is still captured (Tue run). Manual ?date=/?from&to backfills are
  // unaffected (they return above), so a weekend day can still be archived on demand.
  const y = etYesterday();
  return isWeekendDate(y) ? [] : [y];
}

// ── per-date capture ─────────────────────────────────────────────────────────
// Phase 4: when lean discovery is on, build the just-closed day's snapshot from
// the already-accumulated Firestore stop-index (final by ~02:00) instead of a
// fresh full scanDate() against NuVizz — the daily history job goes from ~690
// NuVizz calls to ~0. The index is the source of truth the scans maintain (with
// four-layer preservation), so the snapshot is "as of the last scan"; Phase 5's
// 7-day straggler watch reconciles any late (post-snapshot) deliveries.
const LEAN_HISTORY = (process.env.NUVIZZ_LEAN_DISCOVERY || '').toLowerCase() === 'on';

export async function captureDate(date: string): Promise<any> {
  // Track how far we got so an unexpected throw lands a LOUD, correctly-staged
  // failure record instead of a silent swallow by the background wrapper.
  let stage: CaptureStage = 'scan';
  let countsSoFar: any = null;
  try {
  let stops: any[];
  let sourceScannedAt: string;
  let source: 'firestore-index' | 'scan' = 'scan';
  // Phase 4: prefer the accumulated index, but fall back to a fresh scan if the
  // index is empty / never written (don't capture an empty snapshot for the day).
  if (LEAN_HISTORY && isFirestoreEnabled()) {
    const idx = await readStops(TENANT, date);
    // Trust the index only if it's non-empty AND the day's last scan wasn't SUPPRESSED
    // (ceiling/kill switch). A halted day's index is known-incomplete, so capturing it
    // verbatim would mint a complete:true manifest over a partial snapshot — fall back
    // to a fresh scan to fill the gap instead.
    if (idx.stops.length && idx.meta?.last_scanned_at && !idx.meta?.scanState?.halted) {
      stops = idx.stops;
      sourceScannedAt = idx.meta.last_scanned_at;
      source = 'firestore-index';
    } else {
      if (idx.meta?.scanState?.halted) {
        console.warn(`[history] date=${date} index is HALTED (${idx.meta.scanState.reason}) — falling back to fresh scan`);
      }
      const scan = await scanDate(date);
      stops = scan.stops; sourceScannedAt = scan.scannedAt;
    }
  } else {
    const scan = await scanDate(date);
    stops = scan.stops; sourceScannedAt = scan.scannedAt;
  }
  // Counts available on BOTH paths (the lean path has no scanDate result).
  const unplannedCount = stops.filter((s) => s && s.isPlanned === false).length;
  const plannedCount = stops.length - unplannedCount;
  const nonTerminal = stops.filter((s) => s && s.isPlanned && s.normalizedStatus !== 'DELIVERED').length;
  console.log(`[history] date=${date} source=${source} stops=${stops.length} planned=${plannedCount} nonTerminal=${nonTerminal} sourceScannedAt=${sourceScannedAt}`);

  stage = 'derive';
  // capture_version increments per date.
  const existingCaptures = await listCaptures(TENANT, date);
  const version = existingCaptures.reduce((m, c) => Math.max(m, Number(c.capture_version) || 0), 0) + 1;

  const capture: CaptureMeta = {
    capture_version: version,
    captured_at: new Date().toISOString(),
    source_scanned_at: sourceScannedAt,
    app_version: APP_VERSION,
  };
  const ctx: DeriveCtx = { tenant: TENANT, date, capture };

  const stopRecords = stops.filter((s) => s && s.stopNbr).map((s) => buildStopRecord(s, ctx));
  const routeRecords = deriveRoutes(stops, ctx);
  const driverRecords = deriveDrivers(stops, ctx);

  // Immutability: detect stops captured on a prior run that are absent now. We
  // KEEP them (no delete) and record the discrepancy in the audit.
  const existingStops = await listStops(TENANT, date);
  const newIds = new Set(stopRecords.map((r) => String(r.stopNbr)));
  const absentFromThisCapture = existingStops
    .map((d) => String(d._id))
    .filter((id) => !newIds.has(id));

  // UPSERT — never prune.
  stage = 'upsert';
  await upsertStops(TENANT, date, stopRecords);
  await upsertRoutes(TENANT, date, routeRecords);
  await upsertDrivers(TENANT, date, driverRecords);
  await Promise.all(driverRecords.map((d) =>
    upsertDriverDayPointer(TENANT, d.driverKey, date, {
      tenant: TENANT, driverKey: d.driverKey, driverUserName: d.driverUserName ?? null,
      driverName: d.driverName ?? null, date, loadNbrs: d.loadNbrs, stopCount: d.stopCount,
      capture_version: version, captured_at: capture.captured_at,
    })));

  const intended = {
    stops: stopRecords.length, planned: plannedCount, unplanned: unplannedCount,
    routes: routeRecords.length, drivers: driverRecords.length,
  };
  countsSoFar = { intended };

  // VERIFY-BY-READBACK + SEAL — the ONE shared terminal step (history-seal). It
  // retries the readback (the historical orphan cause was a transient under-read,
  // not a lost write), then EITHER seals the manifest + clears any prior failure
  // record, OR writes a LOUD failure record. Never a silent no-manifest limbo.
  stage = 'verify';
  const sealRes = await finalizeCaptureSeal({
    tenant: TENANT, date,
    stopsForChecksum: stops,
    stopRecords, routeRecords, driverRecords,
    capture, absentKeptCount: absentFromThisCapture.length,
  });
  const { verified, sealed, counts, checksum } = sealRes;

  // Append-only lineage — recorded for EVERY run, including failures. Written
  // after the seal step so it carries the verified/sealed outcome + attempt count.
  // GUARDED: this is audit lineage, not the source of truth. If it throws it must
  // NOT fall through to the outer catch, which would recordCaptureFailure and mark
  // an already-SEALED night as failed (and skip the paint/miner hooks below).
  try {
    await appendCapture(TENANT, date, version, {
      tenant: TENANT, date, capture_version: version,
      captured_at: capture.captured_at, app_version: APP_VERSION, source_scanned_at: sourceScannedAt,
      checksum, intended, persisted: counts, verified, sealed,
      verify_detail: sealRes.detail,
      absent_from_this_capture: absentFromThisCapture,
      absent_kept_count: absentFromThisCapture.length,
    });
  } catch (e: any) {
    console.error(`appendCapture (lineage) failed for ${date} v${version}:`, e?.message);
  }

  if (!verified || !sealed) {
    // The failure record was already written by finalizeCaptureSeal (stage
    // 'verify' or 'seal'); surface it in the run result too.
    console.error(`history capture DID NOT SEAL ${date} v${version}: ` +
      JSON.stringify({ verified, sealed, detail: sealRes.detail, persisted: counts }));
    return { date, ok: false, verified, sealed, capture_version: version, intended, persisted: counts };
  }

  // Post-seal derivations: per-customer rollup, tractor PAINT, and the routing
  // miners. Shared with the heal path (history-postseal.runPostSealHooks) so a
  // healed day is painted/mined identically to a cleanly-captured one. Each hook
  // is independently guarded and re-derivable from the warehouse; a hook failure
  // never fails the (already-sealed) capture. Zero NuVizz calls.
  const postSeal = await runPostSealHooks(TENANT, date, stopRecords);

  return { date, ok: true, verified: true, sealed: true, capture_version: version, counts, absent_kept: absentFromThisCapture.length, post_seal: postSeal.hooks };
  } catch (e: any) {
    // Any unexpected throw (scan/derive/upsert/append) — the day did NOT seal, so
    // leave a LOUD, correctly-staged failure record before propagating. The seal
    // step (stage 'verify'/'seal') records its own; this covers everything before it.
    await recordCaptureFailure(TENANT, date, stage, e?.message || 'capture threw', countsSoFar);
    throw e;
  }
}

// ── HTTP / scheduled entrypoint ──────────────────────────────────────────────
export async function runHistorySnapshot(req: Request): Promise<Response> {
  const startedAt = Date.now();
  setCallTrigger('history-snapshot'); // attribute the nightly history capture's NuVizz calls

  if (!isFirestoreEnabled()) {
    console.error('history-snapshot: FIREBASE_SA not set on this site — cannot write warehouse');
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const dates = resolveDates(req);
  if (dates.length === 0) {
    // Scheduled weekend run — target day is Sat/Sun, which we don't archive.
    console.log('history-snapshot: weekend target day — skipped (no NuVizz calls).');
    return new Response(JSON.stringify({ ok: true, skipped: 'weekend', days: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  const results: any[] = [];
  // Sequential per date — keeps NuVizz load light and bounds memory (same as refresh).
  for (const date of dates) {
    const t0 = Date.now();
    try {
      const r = await captureDate(date);
      results.push({ ...r, ms: Date.now() - t0 });
    } catch (e: any) {
      console.error(`history capture ERROR ${date}:`, e?.message);
      results.push({ date, ok: false, error: e?.message, ms: Date.now() - t0 });
    }
  }

  const allOk = results.every((r) => r.ok && r.verified);
  const summary = { ok: allOk, tenant: TENANT, totalMs: Date.now() - startedAt, dates: results };
  console.log('history-snapshot results:', JSON.stringify(summary));
  // Non-200 on any verify failure so a manual (synchronous) invocation fails loudly.
  // NOTE: the scheduled wrapper is a background function (returns 202); the true
  // status lives in the function log + the captures audit (verified:false) + the
  // ABSENCE of a fresh manifest.
  return new Response(JSON.stringify(summary), {
    status: allOk ? 200 : 500, headers: { 'Content-Type': 'application/json' },
  });
}
