// manifest-recheck.mts
//
// ── "I SCANNED THE BOARD. IS THE MANIFEST CLEAN NOW?" ────────────────────────
//
//   POST /.netlify/functions/manifest-recheck        re-run the free board diff on the
//                                                    newest archived report, against the
//                                                    board AS IT STANDS NOW
//     ?date=YYYY-MM-DD   re-check that night instead of the newest one on file
//     ?days=N            how far back to look for the newest night (default 7, max 30)
//   GET  ?explain=1      which night it WOULD re-check, and what that night holds.
//                        Writes nothing.
//
// WHY THIS EXISTS. Chad, on a Saturday at 10:42, looking at an amber card reading "136 orders
// not routed yet": "If we ran a scan this morning to complete the board from last week which
// looks like we did. It should have fixed the manifest incompleteness."
//
// It could not have, and no scan ever could. `nuvizz_ops/manifest_check_latest` — the document
// the Manifest check screen subscribes to — has exactly ONE writer
// (manifest-email-ingest.mts), and it is reached only when a NEW, unmarked report email is
// parsed. A NuVizz scan does not touch it. Worse, "Check email now" could not move it either:
// every email carries a per-email marker and `if (await getDoc(marker)) continue` skips one
// already checked, for ever. So the verdict on screen was a photograph taken at the 1:10a
// pass, and the board underneath it had been refilled at 07:00 with nobody able to ask again.
//
// THE LOGISTICS COST OF THAT GAP, which is the reason this is a button and not a nicety: a
// Friday manifest is checked overnight against a Monday board that is still being built, so
// the run is honestly inconclusive. The board fills over the weekend. If freight really IS
// missing, the next thing that can say so is Monday's own overnight pass — which lands the
// morning the freight was already due. The re-check turns a two-day blind spot into a click.
//
// COST: ZERO NuVizz calls, by construction. One Firestore doc read per day looked at, one
// blob read for the PDF, and the stop-index reads the diff already does. The probe step that
// spends a NuVizz call per suspect lives in manifest-check.mts behind its own click and is
// not reachable from here.
//
// NO SCHEDULE ON PURPOSE, for two reasons: a function carrying a cron is not reachable over
// plain HTTP in this app, and re-reading the archive every five minutes to answer a question
// nobody asked is not what the board needs.

import { isFirestoreEnabled, getDoc, setDoc, etDayString } from './lib/firestore.mts';
import { manifestDayPath } from './lib/manifest-archive.mts';
import { getManifestPdf } from './lib/manifest-blobs.mts';
import { runManifestBoardDiff } from './lib/manifest-run.mts';
import { toStoredEmailRun, LATEST_DOC } from './lib/manifest-email-ingest.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LOOKBACK = 7;
const MAX_LOOKBACK = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const J = (o: any, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: CORS });

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseLookback(raw: string | null | undefined): number {
  // `Number(null)` is 0 and 0 is finite — the trap CLAUDE.md names by hand and that shipped a
  // midnight deadline for a stop with no deadline. An absent param means the default, not zero.
  return raw == null ? DEFAULT_LOOKBACK : Math.min(MAX_LOOKBACK, Math.max(1, Number(raw) || DEFAULT_LOOKBACK));
}

/**
 * PURE. WHICH NIGHT TO RE-CHECK, and — when none will do — WHY NOT, in freight language.
 *
 * `candidates` is [{ date, doc }] NEWEST FIRST, exactly as the caller read them. A night is
 * usable only when its PDF is genuinely retrievable: the record must carry a blobKey AND say
 * the bytes landed. `pdfStored: false` is a real state the archive records on purpose (see
 * archiveManifest), and treating a recorded-but-unstored night as usable would produce a
 * re-check that reads nothing and then reports on nothing.
 *
 * Rejections are RETURNED, not swallowed. "There is no manifest on file" and "the manifest is
 * on file but its PDF was never stored" need opposite fixes, and a button that says only
 * "nothing to do" for both is the blank screen this repo has burned an evening on before.
 */
export function pickNight(candidates: Array<{ date: string; doc: any }>): {
  date: string | null; latest: any | null; skipped: Array<{ date: string; why: string }>;
} {
  const skipped: Array<{ date: string; why: string }> = [];
  for (const c of (candidates || [])) {
    const l = c?.doc?.latest;
    if (!l) continue;                       // no manifest that night at all — not worth a line
    if (!l.blobKey || !l.pdfStored) {
      skipped.push({ date: c.date, why: 'the manifest was recorded but its PDF was not stored, so it cannot be read back' });
      continue;
    }
    return { date: c.date, latest: l, skipped };
  }
  return { date: null, latest: null, skipped };
}

/** The nights to consider, newest first. One Firestore read each. */
async function readNights(one: string | null, lookback: number): Promise<Array<{ date: string; doc: any }>> {
  const dates = one ? [one] : Array.from({ length: lookback }, (_, i) => addDays(etDayString(), -i));
  const docs = await Promise.all(dates.map((d) => getDoc(manifestDayPath(TENANT, d)).catch(() => null)));
  return dates.map((date, i) => ({ date, doc: docs[i] }));
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const url = new URL(req.url);
  const one = DATE_RE.test(String(url.searchParams.get('date') || '')) ? String(url.searchParams.get('date')) : null;
  const lookback = parseLookback(url.searchParams.get('days'));
  const explain = url.searchParams.get('explain') === '1';

  // ── ?explain=1 — WHAT WOULD THIS DO, WITHOUT DOING IT ─────────────────────
  //
  // Every job that acts on its own needs a way to ask what it is about to do, without doing
  // it (CLAUDE.md, "make it inspectable"). GET is safe here precisely because this branch
  // writes NOTHING, which is also why it is gated at viewer: reading is not acting.
  if (req.method === 'GET' && explain) {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no archive to read' });
    const nights = await readNights(one, lookback);
    const pick = pickNight(nights);
    return J({
      ok: true, explain: true, wrote: false, nuvizzCalls: 0,
      lookedAt: nights.filter((n) => n?.doc?.latest).map((n) => n.date),
      would: pick.date
        ? {
            date: pick.date,
            fileName: pick.latest?.fileName ?? null,
            orders: pick.latest?.orders ?? null,
            filedAt: pick.latest?.at ?? null,
            verdictWhenFiled: pick.latest?.grade?.verdict ?? null,
            missingWhenFiled: pick.latest?.missingCount ?? null,
          }
        : null,
      skipped: pick.skipped,
      note: pick.date
        ? `would re-read the ${pick.date} report and diff it against the board as it stands now — zero NuVizz calls`
        : 'nothing to re-check: no archived night in this window has a stored PDF',
    });
  }

  // POST only: this REWRITES the run every browser shows, so it must not be reachable by
  // anything that speculatively GETs a URL — the same rule manifest-email-check states.
  if (req.method !== 'POST') return J({ ok: false, error: 'POST to re-check, or GET ?explain=1' }, 405);

  // Gate at dispatcher: it rewrites the verdict on every open board. Inert until
  // AUTH_REQUIRED=true, like every other gate in this app.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  try {
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board to check against' });

    const nights = await readNights(one, lookback);
    const pick = pickNight(nights);
    if (!pick.date) {
      return J({
        ok: false, wrote: false, nuvizzCalls: 0, skipped: pick.skipped,
        error: one
          ? `no manifest with a stored PDF on file for ${one}`
          : `no archived manifest with a stored PDF in the last ${lookback} day(s)`,
      });
    }

    const buf = await getManifestPdf(pick.latest.blobKey);
    if (!buf) {
      return J({
        ok: false, wrote: false, nuvizzCalls: 0, date: pick.date,
        error: 'the PDF is recorded as stored but the blob store did not return it',
        blobKey: pick.latest.blobKey,
      });
    }

    // The SAME free diff the nightly pass runs, with today as `asOf` — so a required delivery
    // day that has since come round now counts, which is the entire point of asking again.
    const diff = await runManifestBoardDiff(buf);
    if (!diff?.ok) return J({ ok: false, wrote: false, nuvizzCalls: 0, date: pick.date, error: diff?.error || 'the diff failed' });

    const at = new Date().toISOString();
    const run = {
      ...toStoredEmailRun(
        diff,
        { id: pick.latest.emailId, from: pick.latest.from, subject: pick.latest.subject },
        pick.latest.fileName ?? null,
        at,
        pick.latest.mailbox || 'email',
      ),
      // SAY THAT THIS IS A RE-READ OF FILED PAPER, not a fresh report off the wire. The
      // screen shows it, because a dispatcher reads "Uline sent this and it is clean" and
      // "we asked the board again and it is clean" differently.
      recheckedAt: at,
      recheckOf: pick.date,
    };
    await setDoc(LATEST_DOC, run);

    return J({
      ok: true, wrote: true, nuvizzCalls: 0,
      date: pick.date, skipped: pick.skipped,
      verdict: diff.grade?.verdict ?? null,
      suspects: run.suspectsTotal,
      checkedAgainst: diff.checkedAgainst,
      expectedDelivery: diff.expectedDelivery ?? null,
      stored: run,
    });
  } catch (e: any) {
    return J({ ok: false, wrote: false, error: String(e?.message || e).slice(0, 200) }, 500);
  }
};
