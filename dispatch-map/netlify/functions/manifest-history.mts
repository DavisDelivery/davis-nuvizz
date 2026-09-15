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
// Firestore + blob reads only. ZERO NuVizz calls, sends nothing.
//
// IT DOES WRITE ONE THING, and the header said otherwise for a release. The ?days=N branch
// re-asks stale manifest nights against the board as it stands now and files the answer back
// under the day document's own `heal` key (lib/manifest-heal.mts) — a field-masked PATCH per
// healed night, on a GET, so the Refresh button issues writes. Nothing else here writes, and
// ?heal=0 serves the filed verdicts without any.
//
// NO SCHEDULE ON PURPOSE: a function carrying a cron is not reachable over plain HTTP in this
// app, and this one must answer a browser.
import { isFirestoreEnabled, getDoc, listDocs, updateDocFields, etDayString } from './lib/firestore.mts';
import { manifestDayPath, describeDay } from './lib/manifest-archive.mts';
import { healEnabled, needsHeal, healDates, healPass, validHeal } from './lib/manifest-heal.mts';
import { getManifestPdf, blobSelfTest, blobsAvailable } from './lib/manifest-blobs.mts';
import { boardCoverage, gradeSuspects, gradeText } from '../../src/lib/manifest-window.js';
import { readUlineManifest } from './lib/uline-manifest.mts';
import { proKeys } from './lib/manifest-reconcile.mts';
import { requireUser } from './lib/require-user.mts';

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
  // COMPACT, not pretty. This body carries ~660 manifest rows and is served no-store, so it
  // is re-fetched in full every time the Rows viewer is opened — on a phone, on cellular, in a
  // yard. One space of indentation per line across that structure is 43% of the payload and
  // nothing reads it by eye.
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);

    // HEADERLESS EXCEPTION — ?pdf=1 IS NOT GATED, and this is checked, not assumed.
    // The JSON paths below are all reached by fetch() and can carry a bearer token. The PDF
    // URL cannot: App.jsx hands the SAME string to three consumers, and two of them have no
    // way to set a header — the "Open in browser" escape hatch is a plain
    // <a data-escape-hatch href={src} target="_blank"> (App.jsx DocumentViewerModal), and the
    // iOS share sheet gets it as navigator.share({ url: src }). Gating this branch would put
    // a 401 behind both the moment AUTH_REQUIRED flips — a dispatcher tapping "open" on a
    // disputed Uline manifest gets a JSON error, and a shared link is dead on arrival.
    // Closing it needs a signed, time-limited URL (or the viewer fetching bytes only, which
    // it already does for pdf.js) — a client change, and a separate decision.
    const wantsPdf = url.searchParams.get('pdf') === '1';
    if (!wantsPdf) {
      // Gate at viewer: the manifest archive lists every night's Uline document and the
      // orders that were missing off it. Inert until AUTH_REQUIRED=true.
      const gate = await requireUser(req, { role: 'viewer' });
      if (!gate.ok) return gate.response;
    }

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
        // `orders: 0` MATTERS. The header renders `${d.orders} orders`, so an absent field puts
        // the literal word "undefined" on the screen — which reads as a broken app rather than
        // as the honest "we did not keep this night's PDF" the note underneath is saying.
        return J({ ok: true, date: one, found: true, rows: [], orders: 0, offBoardCount: 0, note: 'the PDF for this night was not stored, so its rows cannot be read back' });
      }
      const buf = await getManifestPdf(l.blobKey);
      if (!buf) return J({ ok: true, date: one, found: true, rows: [], orders: 0, offBoardCount: 0, note: 'the blob store did not return the PDF' });
      let parsed: any;
      try { parsed = readUlineManifest(buf); } catch (e: any) {
        return J({ ok: false, date: one, error: `could not read the stored PDF: ${String(e?.message || e).slice(0, 160)}` }, 500);
      }
      // Which PROs are off the board. Matched on every form proKeys produces, the same way the
      // diff matched them — a row must never be marked missing here for a reason the reconciler
      // would not have used.
      //
      // THE HEALED SET WHEN THERE IS ONE (v1.30.2). v1.30.0 wired the self-heal into the list
      // branch only, so the collapsed row read "2 not on the board" while this viewer, one tap
      // below it, still highlighted all 136 off the filed record and its header still said "136
      // not routed yet". Two answers for one night, with nothing saying which was current — and
      // a contradiction reads as a broken screen, not as a stale number. Where a valid heal
      // exists it is the live answer here too, and `healedAt` tells the screen to say so.
      const healed = validHeal(doc);
      const offSource: any[] = healed
        ? (healed.stillOffPros || []).map((pro: any) => ({ pro }))
        : (Array.isArray(l.missing) ? l.missing : []);
      const offIdx = new Set<string>();
      for (const m of offSource) {
        for (const k of proKeys((m as any)?.pro)) offIdx.add(k);
      }
      // ONLY WHAT THE SCREEN DRAWS. `via`, `whs` and `shipDate` are parsed and have never been
      // rendered in the Rows viewer; carrying them multiplies a 660-row body for nothing.
      const rows = (parsed.rows || []).map((r: any) => ({
        pro: r?.pro ?? null, custName: r?.custName ?? null,
        city: r?.city ?? null, state: r?.state ?? null, zip: r?.zip ?? null,
        lbs: r?.lbs ?? null, skids: r?.skids ?? null, pieces: r?.pieces ?? null,
        offBoard: proKeys(r?.pro).some((k) => offIdx.has(k)),
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
        // WHY THE TWO NUMBERS CAN DISAGREE HONESTLY. archiveManifest stores at most
        // MAX_MISSING_ROWS suspects but records the true count beside them, so on a capped
        // night `recordedMissing` is right and `offBoardCount` is a floor. The flag has been
        // written since the cap existed and read by nothing, which left the screen accusing one
        // of the two numbers of being wrong when both were correct and only one was complete.
        missingTruncated: !!l.missingTruncated,
        // Said, not implied: this viewer is showing the re-checked set, what it was filed as,
        // and how many of that night's suspects the heal could not speak for.
        ...(healed ? { healedAt: healed.at, healedAsOf: healed.asOf, filedMissingCount: healed.filed?.missingCount ?? (Number(l.missingCount) || 0), healUnreadable: healed.unreadable || 0 } : {}),
        // The parser's own complaints — a column layout it could not reconcile, a duplicate
        // PRO. Computed on every read and thrown away here until now.
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 20) : [],
        ...gradeForRow(l),
        // AFTER gradeForRow, never before — the order is load-bearing, the same way it is in the
        // list branch. Only where a heal was actually computed; otherwise this reads as it did.
        ...(healed ? { verdict: healed.verdict, verdictText: healed.verdictText } : {}),
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

    // ── THE ROWS ASK THE BOARD AGAIN (v1.30.0 — lib/manifest-heal.mts) ────────
    //
    // Chad: "why do these show not routed yet i think that is stale and it needs to be dynamic
    // and self heal." A Friday manifest is graded overnight against a MONDAY board that does
    // not exist yet, so it is filed 'unrouted' — honestly — and nothing ever re-asked. See the
    // module header for why re-grading with a fresh `asOf` alone makes the row lie instead of
    // healing it: the BOARD has to be re-read, not just the clock.
    //
    // ZERO NuVizz calls. The suspects are already on the archive document, so this is one
    // masked stop-index read per DISTINCT delivery day across every stale night — and nothing
    // at all on the ordinary day when no row is stale, which is most days.
    const heal = { enabled: healEnabled() && url.searchParams.get('heal') !== '0', asked: 0, healed: 0, boardsRead: 0, skipped: [] as Array<{ date: string; why: string }> };
    const healByDate = new Map<string, any>();
    if (heal.enabled) {
      const candidates: Array<{ date: string; l: any }> = [];
      for (let i = 0; i < wanted.length; i++) {
        const l = docs[i]?.latest;
        if (!l) continue;
        const prior = validHeal(docs[i]);
        if (prior) healByDate.set(wanted[i], prior);          // a heal already on file, still valid
        const v = needsHeal(l, today, prior);
        if (v.heal) candidates.push({ date: wanted[i], l });
        else if (Number(l.missingCount) > 0 && !prior) heal.skipped.push({ date: wanted[i], why: v.why });
      }
      heal.asked = candidates.length;
      if (candidates.length) {
        // One read per distinct day, shared across every night whose window covers it.
        const dates = [...new Set(candidates.flatMap((c) => healDates(c.l)))];
        const stops = new Map<string, number>();
        // THE PROs ARE KEPT PER DAY, NOT POOLED. The read is shared — one listDocs per distinct
        // day, however many nights want it — but the LOOKUP must not be, and pooling them was a
        // real bug caught by review before this shipped: with one flat index across every
        // night's days, a 09-04 manifest's missing order was found on the 09-15 board (which
        // belongs only to a LATER night's window) and healed CLEAN. Same night, same board,
        // a different answer purely because another night happened to share the request — and
        // clean is terminal, so that false clean would never have been re-asked. A false clean
        // is the expensive mistake here: genuinely missing freight, marked resolved, for good.
        const prosByDate = new Map<string, string[]>();
        await Promise.all(dates.map(async (d) => {
          // A READ THAT FAILED IS NOT AN EMPTY BOARD. listDocs throwing and a day with no stops
          // on it are the same `[]` to a careless caller, and treating the first as the second
          // would grade a night against a board we never actually opened.
          const rowsOnDay = await listDocs(`nuvizz_stop_index/${TENANT}__${d}/stops`, { mask: ['stopNbr'] }).then((r) => r || []).catch(() => null);
          if (rowsOnDay === null) return;                     // absent from `stops` ⇒ unreadable
          stops.set(d, rowsOnDay.length);
          const ids: string[] = [];
          for (const r of rowsOnDay) { const id = String((r as any)?._id ?? (r as any)?.stopNbr ?? ''); if (id) ids.push(id); }
          prosByDate.set(d, ids);
        }));
        heal.boardsRead = stops.size;
        // THE DECISION IS THE PURE MODULE'S, NOT THIS HANDLER'S. It graded each night against
        // its OWN window — the invariant healPass exists to hold, after a pooled index healed a
        // night clean off another night's board day and review caught it here.
        const pass = healPass(candidates, { prosByDate, stopsByDate: stops, asOf: today, at: new Date().toISOString() });
        heal.skipped.push(...pass.skipped);
        for (const { date, heal: h } of pass.healed) {
          healByDate.set(date, h);
          heal.healed += 1;
          // FIELD-MASKED, ITS OWN TOP-LEVEL KEY, and never over latest.grade/coverage/
          // missingCount — those are the filed record of what that night's run concluded and
          // the design exists to keep them. A later report for this night rebuilds the document
          // from a literal and drops this key; that is CORRECT rather than a loss, because such
          // a report supersedes the manifest the heal was computed from and validHeal would
          // discard it anyway. Best-effort: a failed write costs one re-read, never the answer.
          await updateDocFields(manifestDayPath(TENANT, date), { heal: h }).catch(() => { heal.skipped.push({ date, why: 'recomputed, but could not be filed — it will be recomputed next read' }); });
        }
      }
    }

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
        // ONLY ULINE PROS: the measured count and its warehouse split, so the history card can
        // show what a night consists of rather than asserting it. Null on nights filed before
        // v0.85.0 — the card prints the row count for those and says which it is.
        ulinePros: l.ulinePros ?? null,
        lanes: l.lanes ?? null,
        offLane: l.offLane ?? null,
        duplicatePros: l.duplicatePros ?? null,
        onBoard: l.onBoard,
        missingCount: l.missingCount,
        // THE COUNT'S STANDING TRAVELS WITH THE COUNT. Without this the row printed
        // missingCount flat red — "83 not on the board" off a Monday board that had not been
        // built yet. Re-derived for nights filed before the grade was stored, so an old row
        // is graded rather than assumed conclusive.
        ...gradeForRow(l),
        // WHAT THE ROW SHOWS IS THE LIVE ANSWER; WHAT IT WAS FILED AS IS KEPT BESIDE IT.
        // `...gradeForRow(l)` ABOVE produced the filed verdict; this overrides it, and the order
        // is load-bearing. It applies only where a heal was actually computed, so a night that
        // could not be re-asked reads exactly as it did before rather than claiming freshness.
        ...(healByDate.get(date)
          ? (() => {
              const h = healByDate.get(date);
              return {
                verdict: h.verdict, verdictText: h.verdictText,
                expectedDelivery: l.expectedDelivery ?? null,
                liveMissingCount: h.stillOff,
                healedAt: h.at, healedAsOf: h.asOf,
                // Stated, not implied: the count that was filed, and how many of that night's
                // suspects this read could not speak for (the archive's 500-row cap).
                filedMissingCount: h.filed?.missingCount ?? (Number(l.missingCount) || 0),
                healUnreadable: h.unreadable || 0,
              };
            })()
          : {}),
        verified: !!l.verified,
        pdfStored: !!l.pdfStored,
        mailbox: l.mailbox ?? null,
        fileName: l.fileName ?? null,
      };
    }).filter(Boolean);

    return J({
      ok: true, days, from: wanted[wanted.length - 1], to: today,
      nightsOnFile: rows.length,
      // MAKE IT INSPECTABLE. How many nights were re-asked, how many boards that cost, and —
      // named, not just counted — every night left as filed and why. A heal that quietly does
      // nothing looks exactly like a heal that worked, which is the failure this repo keeps
      // paying for. `?heal=0` serves the filed verdicts untouched without changing any setting.
      heal,
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
