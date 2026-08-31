// manifest-history.mts — the manifest archive, read back.
//
// Chad: "have a history of those, as well as any that we're missing on that manifest for that
// particular day… I just want to keep an actual copy of it, but I don't want 4 copies a night
// kept." This is the reading half: which nights we hold a manifest for, what it said, who was
// missing off the board, and the one PDF that night's reports settled on.
//
//   GET ?days=30                 the last N nights, newest first (default 30, max 180)
//   GET ?date=YYYY-MM-DD         one night in full — the manifest, the arrivals, the missing
//   GET ?date=…&pdf=1            that night's stored PDF, streamed back
//   GET ?selftest=1              round-trip a tiny object through the blob store
//
// The self-test is not a nicety. This writes to an object store that no unit test can reach,
// and an archive that silently stopped storing is discovered months later by the person who
// needed the document — so "is it actually writing?" has to be one click, not an excavation.
//
// Firestore + blob reads only. ZERO NuVizz calls, writes nothing, sends nothing.
//
// NO SCHEDULE ON PURPOSE: a function carrying a cron is not reachable over plain HTTP in this
// app, and this one must answer a browser.
import { isFirestoreEnabled, getDoc, etDayString } from './lib/firestore.mts';
import { manifestDayPath, describeDay } from './lib/manifest-archive.mts';
import { getManifestPdf, blobSelfTest, blobsAvailable } from './lib/manifest-blobs.mts';
import { boardCoverage, gradeSuspects, gradeText } from '../../src/lib/manifest-window.js';
import { readUlineManifest } from './lib/uline-manifest.mts';
import { proKeys } from './lib/manifest-reconcile.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 180;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The verdict for a stored night: what the count is worth, not just what it is.
 *
 * A night filed before the grade was stored carries only `checkedAgainst`, so the coverage is
 * re-derived from it — with the run's own day as `asOf`, because a required delivery day later
 * than the day we asked on had not come round yet and its board was still being built. That is
 * the whole reason every Friday manifest read as though orders had gone astray.
 */
function gradeForRow(l: any): { verdict: string; verdictText: string; expectedDelivery: string | null } {
  const suspects = Array.isArray(l?.missing) ? l.missing : new Array(Number(l?.missingCount) || 0).fill({});
  const asOf = String(l?.at || '').slice(0, 10) || null;
  const required = l?.expectedDelivery ? [String(l.expectedDelivery)] : null;
  const coverage = l?.coverage || boardCoverage(l?.checkedAgainst, required, asOf);
  const grade = l?.grade?.verdict ? l.grade : gradeSuspects(suspects, coverage);
  return {
    verdict: String(grade?.verdict || 'none'),
    verdictText: gradeText(grade, coverage),
    expectedDelivery: l?.expectedDelivery ?? null,
  };
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);

    if (url.searchParams.get('selftest') === '1') {
      const r = await blobSelfTest();
      return J({ ok: r.ok, selftest: r, note: r.ok ? 'the blob store accepted and returned the same bytes' : 'PDFs are NOT being stored — day records will read pdfStored:false' });
    }

    const one = url.searchParams.get('date');

    // ── the PDF itself ────────────────────────────────────────────────────────
    if (one && DATE_RE.test(one) && url.searchParams.get('pdf') === '1') {
      const doc = await getDoc(manifestDayPath(TENANT, one));
      if (!doc?.latest) return J({ ok: false, error: `no manifest on file for ${one}` }, 404);
      const rev = doc.latest;
      if (!rev?.blobKey || !rev.pdfStored) {
        return J({ ok: false, error: `the manifest for ${one} was recorded but its PDF was not stored`, pdfError: rev?.pdfError ?? null }, 404);
      }
      const buf = await getManifestPdf(rev.blobKey);
      if (!buf) return J({ ok: false, error: 'the PDF is recorded as stored but the blob store did not return it', blobKey: rev.blobKey }, 404);
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          // inline, not attachment: a dispatcher checking a disputed order wants to LOOK at
          // it, not collect a downloads folder full of near-identical files.
          'Content-Disposition': `inline; filename="uline-manifest-${one}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // ── THE MANIFEST AS ROWS, WITH THE OFF-BOARD ONES MARKED ──────────────────
    //
    // Chad: "I'm not able to view the entire manifest ... I want a way to see the ones not on
    // there also. On the manifest I want you to highlight the rows missing."
    //
    // The PDF answers none of that on a phone: it is a fixed-width 13-page document in a
    // viewer that cannot scroll sideways to the columns that matter, and nothing in it knows
    // which orders are off the board. The rows do — so they are served as DATA and the screen
    // renders them, highlights the off-board ones and can filter to just those.
    //
    // Parsed from the PDF we already stored rather than kept as a second copy at write time:
    // one source of truth, and a night filed before this existed reads back just the same.
    // Firestore + blob store only, ZERO NuVizz calls.
    if (one && DATE_RE.test(one) && url.searchParams.get('rows') === '1') {
      const doc = await getDoc(manifestDayPath(TENANT, one));
      if (!doc?.latest) return J({ ok: true, date: one, found: false, rows: [] });
      const l = doc.latest;
      if (!l.blobKey || !l.pdfStored) {
        return J({ ok: true, date: one, found: true, rows: [], note: 'the PDF for this night was not stored, so its rows cannot be read back' });
      }
      const buf = await getManifestPdf(l.blobKey);
      if (!buf) return J({ ok: true, date: one, found: true, rows: [], note: 'the blob store did not return the PDF' });
      let parsed: any;
      try { parsed = readUlineManifest(buf); } catch (e: any) {
        return J({ ok: false, date: one, error: `could not read the stored PDF: ${String(e?.message || e).slice(0, 160)}` }, 500);
      }
      // Which PROs the run found off the board. Matched on every form proKeys produces, the
      // same way the diff matched them — a row must never be marked missing here for a reason
      // the reconciler would not have used.
      const offIdx = new Set<string>();
      for (const m of (Array.isArray(l.missing) ? l.missing : [])) {
        for (const k of proKeys((m as any)?.pro)) offIdx.add(k);
      }
      const rows = (parsed.rows || []).map((r: any) => ({
        ...r, offBoard: proKeys(r?.pro).some((k) => offIdx.has(k)),
      }));
      return J({
        ok: true, date: one, found: true,
        rows,
        totals: parsed.totals ?? null,
        verified: !!parsed.verified,
        orders: rows.length,
        offBoardCount: rows.filter((r: any) => r.offBoard).length,
        // The count the run recorded, so a disagreement between the stored figure and what the
        // rows say is visible rather than quietly reconciled — the run graded a manifest, and
        // if this parse produces a different number, one of them is wrong.
        recordedMissing: Number(l.missingCount) || 0,
        ...gradeForRow(l),
        reportNo: l.reportNo ?? null,
        fileName: l.fileName ?? null,
      });
    }

    // ── one night, in full ────────────────────────────────────────────────────
    if (one && DATE_RE.test(one)) {
      const doc = await getDoc(manifestDayPath(TENANT, one));
      if (!doc) return J({ ok: true, date: one, found: false, summary: 'no manifest on file' });
      return J({ ok: true, date: one, found: true, summary: describeDay(doc), ...doc });
    }

    // ── the window ────────────────────────────────────────────────────────────
    const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days') || 30) || 30));
    const today = etDayString();
    const wanted = Array.from({ length: days }, (_, i) => addDays(today, -i));
    const docs = await Promise.all(wanted.map((d) => getDoc(manifestDayPath(TENANT, d)).catch(() => null)));

    const rows = docs.map((doc, i) => {
      const date = wanted[i];
      if (!doc?.latest) return null;
      const l = doc.latest;
      return {
        date,
        summary: describeDay(doc),
        reports: Number(doc.reportCount) || 1,
        sawOrderCountFall: !!doc.sawOrderCountFall,
        at: l.at,
        orders: l.orders,
        onBoard: l.onBoard,
        missingCount: l.missingCount,
        // THE COUNT'S STANDING TRAVELS WITH THE COUNT. Without this the row printed
        // missingCount flat red — "83 not on the board" off a Monday board that had not been
        // built yet. Re-derived for nights filed before the grade was stored, so an old row
        // is graded rather than assumed conclusive.
        ...gradeForRow(l),
        verified: !!l.verified,
        pdfStored: !!l.pdfStored,
        mailbox: l.mailbox ?? null,
        fileName: l.fileName ?? null,
      };
    }).filter(Boolean);

    return J({
      ok: true, days, from: wanted[wanted.length - 1], to: today,
      nightsOnFile: rows.length,
      blobsAvailable: await blobsAvailable(),
      // Say it plainly when nothing is filed yet rather than returning a bare empty list —
      // "no history" and "the archive is broken" must not look the same.
      note: rows.length ? null : 'no manifests archived in this window (the archive starts filing from its first nightly run after deploy)',
      rows,
    });
  } catch (err: any) {
    return J({ ok: false, error: String(err?.message || err).slice(0, 200) }, 500);
  }
};
