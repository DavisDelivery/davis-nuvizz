// lib/manifest-archive-store.mts
//
// The wiring between the PURE fold (manifest-archive) and the two places bytes and records
// actually live. Kept apart from the pure module on purpose: every decision worth arguing
// about — which day, which revision, is this the same paper — is testable without a network,
// and this file only carries the plumbing that cannot be.
import { getDoc, setDoc } from './firestore.mts';
import {
  manifestDayPath, manifestBlobKey, manifestDeliveryDate, pdfDigest, foldRevision,
} from './manifest-archive.mts';
import { putManifestPdf } from './manifest-blobs.mts';
import { readUlineManifest } from './uline-manifest.mts';

/**
 * File one accepted report: store the PDF, fold the day's record, return WHAT HAPPENED.
 *
 * Never throws. The nightly diff is the job; this is the paperwork behind it, and paperwork
 * failing must not cost a night's check. Every return says plainly whether the bytes landed,
 * because a record pointing at a PDF that was never written is the failure that only shows up
 * on the day somebody needs the document.
 */
export async function archiveManifest(args: {
  tenant: string; buf: Buffer; diff: any; email?: any; fileName?: string | null;
  at: string; mailbox?: string | null;
}): Promise<any> {
  const { tenant, buf, diff, email, fileName, at, mailbox } = args;
  try {
    // The rows carry the ship dates that decide the day. The diff summary does not keep them,
    // so re-read the (already-in-memory) PDF rather than widen the diff's contract.
    let rows: any[] = [];
    try { rows = readUlineManifest(buf).rows || []; } catch { rows = []; }
    const day = manifestDeliveryDate(rows, at);
    const digest = pdfDigest(buf);

    const path = manifestDayPath(tenant, day.date);
    const existing = await getDoc(path).catch(() => null);

    // Compute the fold FIRST, so a resend costs no blob write at all.
    const probe = foldRevision(existing, {
      at, digest, bytes: buf.length,
      emailId: email?.id ?? null, mailbox: mailbox ?? null,
      from: email?.from ?? null, subject: email?.subject ?? null, fileName: fileName ?? null,
      orders: Number(diff?.manifest?.orders) || rows.length,
      totals: diff?.manifest?.totals ?? null,
      verified: !!diff?.manifest?.verified,
      onBoard: diff?.onBoard, boardOnly: diff?.boardOnly,
      missing: diff?.suspects || [],
      checkedAgainst: diff?.checkedAgainst || [],
    }, tenant, day.date);

    if (probe.duplicate) {
      await setDoc(path, probe.doc);
      return { ok: true, date: day.date, dayFrom: day.from, revision: probe.revision, duplicate: true, pdfStored: true, note: 'same PDF already on file' };
    }

    const blobKey = manifestBlobKey(tenant, day.date, probe.revision);
    const put = await putManifestPdf(blobKey, buf, {
      date: day.date, revision: String(probe.revision), digest, fileName: fileName || '', mailbox: mailbox || '',
    });

    // Re-fold with the REAL storage outcome on the revision, so the record can never claim a
    // PDF it does not have.
    const final = foldRevision(existing, {
      at, digest, bytes: buf.length,
      emailId: email?.id ?? null, mailbox: mailbox ?? null,
      from: email?.from ?? null, subject: email?.subject ?? null, fileName: fileName ?? null,
      orders: Number(diff?.manifest?.orders) || rows.length,
      totals: diff?.manifest?.totals ?? null,
      verified: !!diff?.manifest?.verified,
      onBoard: diff?.onBoard, boardOnly: diff?.boardOnly,
      missing: diff?.suspects || [],
      checkedAgainst: diff?.checkedAgainst || [],
      blobKey: put.ok ? blobKey : null,
      pdfStored: put.ok, pdfError: put.error,
    }, tenant, day.date);

    await setDoc(path, final.doc);
    return {
      ok: true, date: day.date, dayFrom: day.from, shipDates: day.shipDates,
      revision: final.revision, duplicate: false,
      supersededRevision: final.supersededRevision,
      missingCount: final.doc.latest.missingCount,
      pdfStored: put.ok, pdfError: put.error, blobKey: put.ok ? blobKey : null, bytes: buf.length,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
