// lib/manifest-archive-store.mts
//
// The wiring between the PURE fold (manifest-archive) and the two places bytes and records
// actually live. Kept apart from the pure module on purpose: every decision worth arguing
// about — which night, is this the same paper, did the report come back short — is testable
// without a network, and this file only carries the plumbing that cannot be.
import { getDoc, setDoc } from './firestore.mts';
import {
  manifestDayPath, manifestBlobKey, manifestDeliveryDate, pdfDigest, foldManifestDay,
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

    const base = {
      at, digest, bytes: buf.length,
      emailId: email?.id ?? null, mailbox: mailbox ?? null,
      from: email?.from ?? null, subject: email?.subject ?? null, fileName: fileName ?? null,
      orders: Number(diff?.manifest?.orders) || rows.length,
      totals: diff?.manifest?.totals ?? null,
      verified: !!diff?.manifest?.verified,
      onBoard: diff?.onBoard, boardOnly: diff?.boardOnly,
      // When ULINE sent it. `at` is when we filed it — identical for every report in one
      // batch, so it cannot order them. This is what decides which revision stands.
      receivedAt: Number(email?.receivedAt) || null,
      missing: diff?.suspects || [],
      checkedAgainst: diff?.checkedAgainst || [],
    };

    // Fold FIRST, so the same paper arriving twice costs no upload at all.
    const probe = foldManifestDay(existing, base, tenant, day.date);
    if (probe.duplicate) {
      await setDoc(path, probe.doc);
      return { ok: true, date: day.date, dayFrom: day.from, reportNo: probe.reportNo, duplicate: true, pdfStored: true, note: 'same PDF already on file' };
    }

    // AN OLDER REPORT MAY NOT OVERWRITE A NEWER ONE'S BYTES. The fold decides this on Uline's
    // send time (see the supersedes rule), and the decision has to be taken BEFORE the upload,
    // because the upload is the overwrite — refusing afterwards would leave the good record
    // pointing at the fragment's bytes. Chad: "you should be saving the last one pulled in.
    // You're instead saving the first one."
    if (!probe.supersedes) {
      const kept = foldManifestDay(existing, base, tenant, day.date);
      await setDoc(path, kept.doc);
      return {
        ok: true, date: day.date, dayFrom: day.from, reportNo: kept.reportNo,
        duplicate: false, superseded: true,
        note: 'an earlier report than the one on file — recorded, but the night keeps the later manifest',
        pdfStored: !!existing?.latest?.pdfStored, blobKey: existing?.latest?.blobKey ?? null, bytes: buf.length,
      };
    }

    // ONE COPY A NIGHT: the same key every time, so tonight's fifth report REPLACES the
    // fourth's bytes rather than sitting beside them (Chad: "I don't want 4 copies a night
    // kept"). The manifest is append-only, so the survivor is the complete one.
    const blobKey = manifestBlobKey(tenant, day.date);
    const put = await putManifestPdf(blobKey, buf, {
      date: day.date, reportNo: String(probe.reportNo), digest, fileName: fileName || '', mailbox: mailbox || '',
    });

    // Re-fold with the REAL storage outcome, so the record can never claim a PDF it lacks.
    const final = foldManifestDay(existing, {
      ...base, blobKey: put.ok ? blobKey : null, pdfStored: put.ok, pdfError: put.error,
    }, tenant, day.date);

    await setDoc(path, final.doc);
    return {
      ok: true, date: day.date, dayFrom: day.from, shipDates: day.shipDates,
      reportNo: final.reportNo, duplicate: false,
      missingCount: final.doc.latest.missingCount,
      orders: final.doc.latest.orders,
      // Surfaced on the run outcome, not just buried in the day doc: a manifest that came back
      // SHORTER than the last one broke the invariant this whole design rests on.
      ...(final.orderCountFell ? { orderCountFell: true, priorOrders: final.priorOrders } : {}),
      pdfStored: put.ok, pdfError: put.error, blobKey: put.ok ? blobKey : null, bytes: buf.length,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
