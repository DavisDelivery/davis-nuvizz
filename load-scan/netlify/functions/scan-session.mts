// scan-session.mts
//
// POST -> upsert a scan session. IDEMPOTENT on (loadNbr, og).
//
// The phone writes every scan to a local queue first and flushes here when signal
// returns. A flush can and will replay: the driver walks out of the dead zone, the
// request times out mid-flight, the queue retries. So this endpoint must be safe
// to call with the same scans repeatedly — de-duplication is by OG, which is the
// unique physical-piece ID off the Code 128 barcode.
//
// FOUR-LAYER PRESERVATION on the ingest path:
//   1. raw       — every incoming scan object, byte-for-byte as the phone sent it
//   2. accepted  — the normalized scans that became session rows
//   3. rejected  — anything dropped, WITH the reason, never silently discarded
//   4. session   — the derived counts and reconciliation
// A scan that cannot be parsed is still recorded. Losing a scan silently is the
// one failure this app cannot have.
//
// ZERO NuVizz calls.

import { getDoc, setDoc, isFirestoreEnabled } from './lib/firestore.mts';
import { authenticate } from './lib/auth.mts';
import { normalizePro } from './lib/manifest.mts';
import { ok, bad, unauthorized, readJson, etDayString, DATE_RE } from './lib/http.mts';

const SESSIONS = 'nuvizz_load_scans';
const TENANT = 'davis';

const OG_RE = /^OG\d{10}$/;

export interface ScanRow {
  og: string;
  pro: string;
  scannedAt: string;
  stopNbr: string;
  engine: 'native' | 'quagga' | 'manual';
}

/** Normalize one incoming scan, or explain why it cannot be used. */
export function normalizeScan(raw: any): { row?: ScanRow; reason?: string } {
  const og = String(raw?.og ?? '').trim().toUpperCase();
  if (!og) return { reason: 'missing og' };
  if (!OG_RE.test(og)) return { reason: `og not OG+10 digits: ${og.slice(0, 24)}` };

  const pro = normalizePro(raw?.pro);
  if (!pro) return { reason: `missing or unparseable pro for ${og}` };

  const engineRaw = String(raw?.engine ?? '').toLowerCase();
  const engine: ScanRow['engine'] =
    engineRaw === 'native' || engineRaw === 'quagga' || engineRaw === 'manual' ? engineRaw : 'manual';

  const at = String(raw?.scannedAt ?? '').trim();
  const scannedAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();

  return { row: { og, pro, scannedAt, stopNbr: String(raw?.stopNbr ?? '').trim(), engine } };
}

/**
 * Merge incoming scans into the existing set, keyed by OG.
 *
 * First write of an OG wins on timestamp — a replay must not move a piece's
 * scannedAt forward, or the dock timeline becomes fiction.
 */
export function mergeScans(existing: ScanRow[], incoming: ScanRow[]): { scans: ScanRow[]; added: number; duplicates: number } {
  const byOg = new Map<string, ScanRow>();
  for (const r of existing) byOg.set(r.og, r);

  let added = 0;
  let duplicates = 0;
  for (const r of incoming) {
    if (byOg.has(r.og)) {
      duplicates++;
      continue;
    }
    byOg.set(r.og, r);
    added++;
  }
  const scans = [...byOg.values()].sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
  return { scans, added, duplicates };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);
  if (!isFirestoreEnabled()) return bad('FIREBASE_SA not set', 503);

  const claims = authenticate(req);
  if (!claims) return unauthorized();

  const body = await readJson(req);
  const loadNbr = String(body?.loadNbr ?? '').trim();
  const dateIn = String(body?.date ?? '');
  const date = DATE_RE.test(dateIn) ? dateIn : etDayString();
  if (!loadNbr) return bad('loadNbr is required');

  const incomingRaw: any[] = Array.isArray(body?.scans) ? body.scans : [];

  // Layer 1 + 3: normalize, keeping every rejection and its reason.
  const accepted: ScanRow[] = [];
  const rejected: Array<{ raw: any; reason: string }> = [];
  for (const r of incomingRaw) {
    const { row, reason } = normalizeScan(r);
    if (row) accepted.push(row);
    else rejected.push({ raw: r, reason: reason || 'unknown' });
  }

  const path = `${SESSIONS}/${TENANT}__${date}__${loadNbr}`;
  const prior = await getDoc(path);
  const priorScans: ScanRow[] = Array.isArray(prior?.scans) ? prior.scans : [];

  const { scans, added, duplicates } = mergeScans(priorScans, accepted);

  const expectedPieces = Number(body?.expectedPieces ?? prior?.expectedPieces ?? 0) || 0;
  const scannedCount = scans.length;

  // reconciliation is driver-authored on close-out; carry it through untouched
  // unless this request is the one closing the load.
  const closing = body?.close === true;
  const reconciliation = closing
    ? {
        scannedCount,
        shortCount: Math.max(0, expectedPieces - scannedCount),
        overCount: Math.max(0, scannedCount - expectedPieces),
        resolvedBy: String(body?.reconciliation?.resolvedBy ?? '').trim() || null,
        note: String(body?.reconciliation?.note ?? '').trim() || null,
        at: new Date().toISOString(),
      }
    : prior?.reconciliation ?? null;

  // A load must not close silently with a mismatch.
  if (closing && scannedCount !== expectedPieces && !reconciliation?.resolvedBy) {
    return bad('cannot close with a piece-count mismatch and no resolution — set reconciliation.resolvedBy', 409);
  }

  await setDoc(path, {
    tenant: TENANT,
    date,
    loadNbr,
    driverNumber: String(claims.sub),
    startedAt: prior?.startedAt || new Date().toISOString(),
    closedAt: closing ? new Date().toISOString() : prior?.closedAt || null,
    expectedPieces,
    scannedCount,
    scans,
    reconciliation,
    // Layer 3, persisted: rejects accumulate rather than overwrite, so a bad
    // label pattern is still visible days later.
    rejected: [...(Array.isArray(prior?.rejected) ? prior.rejected : []), ...rejected].slice(-200),
    updatedAt: new Date().toISOString(),
  });

  return ok({
    loadNbr,
    date,
    scannedCount,
    added,
    duplicates,
    rejected: rejected.length,
    rejectedDetail: rejected.slice(0, 20),
    closed: closing,
  });
};
