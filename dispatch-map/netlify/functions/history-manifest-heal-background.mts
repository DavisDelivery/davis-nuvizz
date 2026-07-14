// history-manifest-heal-background.mts
//
// Recover ORPHANED history days — days whose stops were fully captured but whose
// manifest seal never landed (see lib/history-seal.mts for how that used to
// happen silently). Reseals FROM THE STORED STOPS through the exact same
// terminal step the nightly capture now uses (finalizeCaptureSeal), so a healed
// manifest is verified by the same real checks — nothing is fabricated. The only
// distinguishing marks are healed:true + healed_at.
//
// Firestore-only. ZERO NuVizz calls (the stops are already on disk; this never
// re-scans — truly-missing days go through the rescan path instead).
//
//   POST /.netlify/functions/history-manifest-heal-background
//     ?date=YYYY-MM-DD   → heal one day
//     ?all=1             → heal the six known orphans
//
// Idempotent and SAFE: refuses to overwrite a day that already carries a real
// sealed manifest (verified/complete) or a tombstone; a day with no stored stops
// is reported as un-healable (it needs a rescan, not a heal).
import { isFirestoreEnabled } from './lib/firestore.mts';
import {
  getManifest, listStops, listCaptures, appendCapture,
  upsertRoutes, upsertDrivers, upsertDriverDayPointer,
} from './lib/history-store.mts';
import { deriveRoutes, deriveDrivers, type CaptureMeta, type DeriveCtx } from './lib/history-derive.mts';
import { finalizeCaptureSeal, getCaptureFailure, classifyHealTarget, recordCaptureFailure } from './lib/history-seal.mts';
import { runPostSealHooks } from './lib/history-postseal.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The six fully-captured-but-unsealed days (stops present, manifest missing).
const KNOWN_ORPHANS = [
  '2026-06-24', '2026-06-25', '2026-07-01', '2026-07-02', '2026-07-07', '2026-07-10',
];

async function healDate(date: string): Promise<any> {
  const existing = await getManifest(TENANT, date);
  // Read stops up front — the source of truth, and the heal decision needs the count.
  const storedStops = await listStops(TENANT, date);
  const decision = classifyHealTarget(existing, storedStops.length);
  if (decision.action === 'refuse_tombstone') return { date, healed: false, skipped: 'tombstoned', counts: existing?.counts ?? null };
  if (decision.action === 'refuse_sealed') return { date, healed: false, skipped: 'already_sealed', counts: existing?.counts ?? null };
  if (decision.action === 'refuse_no_stops') return { date, healed: false, skipped: 'no_stored_stops', hint: 'truly missing — use the rescan path' };

  // Diagnostic: what did the ORIGINAL capture record? verified:false in the last
  // audit → the seal was withheld on a verify miss; no such flag / verified:true
  // with no manifest → the seal write itself failed. Surface it in the result.
  const captures = await listCaptures(TENANT, date);
  const lastAudit = captures
    .slice()
    .sort((a, b) => (Number(a.capture_version) || 0) - (Number(b.capture_version) || 0))
    .pop() || null;
  const priorFailure = await getCaptureFailure(TENANT, date);
  const priorVerified = lastAudit ? lastAudit.verified : null;
  const sourceScannedAt = lastAudit?.source_scanned_at ?? storedStops[0]?.source_scanned_at ?? null;
  const appVersion = lastAudit?.app_version ?? storedStops[0]?.app_version ?? 'heal';

  // Fresh capture version for the heal's lineage.
  const version = captures.reduce((m, c) => Math.max(m, Number(c.capture_version) || 0), 0) + 1;
  const capture: CaptureMeta = {
    capture_version: version,
    captured_at: new Date().toISOString(),
    source_scanned_at: sourceScannedAt,
    app_version: appVersion,
  };
  const ctx: DeriveCtx = { tenant: TENANT, date, capture };

  // Re-derive routes/drivers FROM the stored stops (stored stop docs are a
  // superset of the normalized stop, so the derivations read the same fields),
  // and repair the subcollections idempotently in case a partial write is what
  // blocked the original seal. The stops themselves are immutable — never rewritten.
  const routeRecords = deriveRoutes(storedStops, ctx);
  const driverRecords = deriveDrivers(storedStops, ctx);
  await upsertRoutes(TENANT, date, routeRecords);
  await upsertDrivers(TENANT, date, driverRecords);
  await Promise.all(driverRecords.map((d) =>
    upsertDriverDayPointer(TENANT, d.driverKey, date, {
      tenant: TENANT, driverKey: d.driverKey, driverUserName: d.driverUserName ?? null,
      driverName: d.driverName ?? null, date, loadNbrs: d.loadNbrs, stopCount: d.stopCount,
      capture_version: version, captured_at: capture.captured_at,
    })));

  // SAME terminal step as the nightly seal — verify-by-readback (retried) then
  // seal, marked healed. verified only if the real checks pass.
  const sealRes = await finalizeCaptureSeal({
    tenant: TENANT, date,
    stopsForChecksum: storedStops,
    stopRecords: storedStops,
    routeRecords, driverRecords,
    capture, absentKeptCount: 0,
    healed: true,
  });

  try {
    await appendCapture(TENANT, date, version, {
      tenant: TENANT, date, capture_version: version, healed: true,
      captured_at: capture.captured_at, app_version: appVersion, source_scanned_at: sourceScannedAt,
      checksum: sealRes.checksum, persisted: sealRes.counts,
      verified: sealRes.verified, sealed: sealRes.sealed, verify_detail: sealRes.detail,
    });
  } catch (e: any) {
    console.error(`[manifest-heal] appendCapture (lineage) failed for ${date}:`, e?.message);
  }

  // A healed day must be PAINTED + MINED like a fresh capture — the original bug
  // was that heal resealed the manifest but never re-ran these, so recovered days
  // got a manifest yet their tractor_locations / routing_* were never written.
  // Same shared hook block the nightly capture uses; only after a real seal.
  let postSeal: any = null;
  if (sealRes.sealed) {
    postSeal = (await runPostSealHooks(TENANT, date, storedStops)).hooks;
  }

  return {
    date,
    healed: sealRes.sealed,
    verified: sealRes.verified,
    counts: sealRes.counts,
    checksum: sealRes.checksum,
    post_seal: postSeal,
    original_diagnosis: {
      prior_audit_verified: priorVerified,
      had_failure_record: !!priorFailure,
      failure_stage: priorFailure?.stage ?? null,
    },
  };
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  const t0 = Date.now();
  const url = new URL(req.url);
  const one = url.searchParams.get('date');
  const all = url.searchParams.get('all');

  let dates: string[];
  if (one && DATE_RE.test(one)) dates = [one];
  else if (all === '1') dates = KNOWN_ORPHANS;
  else return new Response(JSON.stringify({ ok: false, error: 'pass ?date=YYYY-MM-DD or ?all=1' }), { status: 400, headers });

  const results: any[] = [];
  for (const date of dates) {
    try {
      results.push(await healDate(date));
    } catch (e: any) {
      console.error(`[manifest-heal] ${date} threw:`, e?.message);
      // NEVER a silent throw (the same principle the seal step follows): a heal that
      // dies in derive/upsert (e.g. the old slashed-route-id break) must leave a LOUD
      // failure record so the day reads 'failed', not 'missing'. Best-effort.
      try { await recordCaptureFailure(TENANT, date, 'derive', e?.message || 'heal threw', null); } catch { /* ignore */ }
      results.push({ date, healed: false, error: e?.message || 'heal threw' });
    }
  }

  const summary = {
    ok: results.every((r) => r.healed || r.skipped),
    tenant: TENANT,
    healed: results.filter((r) => r.healed).map((r) => r.date),
    skipped: results.filter((r) => r.skipped).map((r) => ({ date: r.date, reason: r.skipped })),
    failed: results.filter((r) => !r.healed && !r.skipped).map((r) => ({ date: r.date, error: r.error })),
    results,
    ms: Date.now() - t0,
  };
  console.log('[manifest-heal] done:', JSON.stringify({ ...summary, results: undefined }));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
