// manifest-email-check.mts
//
// ON DEMAND: the "Check email now" button on the Manifest check tab.
//
//   POST /.netlify/functions/manifest-email-check
//
// The scheduled poll runs at 8:10p, 9:10p and 10:10p ET (src/lib/manifest-schedule.js),
// which is right for a report that lands once a night and wrong for the moment you
// have just connected a mailbox and want to know it works — at 3pm the next pass is
// five hours away. This runs ONE cycle over exactly the same mailboxes
// (lib/mail-sources.mts is shared with the schedule, so this can never test a
// different set of inboxes than runs at night) and answers with what it found.
//
// Cost: mailbox API calls (free) plus the Firestore reads for the board diff.
// ZERO NuVizz calls — the same free diff the drop zone runs. The probe step that
// spends one NuVizz call per suspect stays behind its own human click and is not
// reachable from here.
//
// It also returns the run it stored, so the tab can show the result immediately
// rather than waiting on a Firestore subscription the browser may not have.

import { isFirestoreEnabled, getDoc, setDoc } from './lib/firestore.mts';
import { runManifestBoardDiff } from './lib/manifest-run.mts';
import { ingestManifestEmails, explainManifestEmails, LATEST_DOC } from './lib/manifest-email-ingest.mts';
import { archiveManifest } from './lib/manifest-archive-store.mts';

const TENANT = 'davis';
import { buildMailSources, recordGmailRun, summarizeCycle } from './lib/mail-sources.mts';
import { requireUser } from './lib/require-user.mts';
import { PARSE_SCHEDULE_LABEL } from '../../src/lib/manifest-schedule.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const J = (o: any, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: CORS });

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  // ── ?explain=1 — WHAT WOULD THIS PASS DO, WITHOUT DOING IT ────────────────
  //
  // The one question the Manifest history could not answer on 2026-09-10, when it showed
  // "1 report" against five Uline sends: WHICH email, and WHY. A job that wrote nothing and
  // a panel that got nothing look the same from outside, and guessing between the four
  // possible causes is how an evening gets burned (CLAUDE.md, "ASK FOR THE CALL").
  //
  // GET is safe here precisely because this branch writes NOTHING — no marker, no run doc,
  // no archive — so the POST-only rule below, which exists to stop a speculative GET from
  // rewriting the run every browser shows, has nothing to protect against. It is gated at
  // VIEWER rather than dispatcher for the same reason: reading is not acting.
  //
  //   GET ?explain=1          every candidate email, its marker, and whether this pass reaches it
  //   GET ?explain=1&deep=1   also downloads and diffs the unmarked ones, still writing nothing
  //
  // Cost: one list call per mailbox plus one marker read each; with deep, one download and
  // one board diff per email the pass would open. ZERO NuVizz calls either way.
  if (req.method === 'GET' && new URL(req.url).searchParams.get('explain') === '1') {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no markers to read' });
    const { sources, off } = await buildMailSources(fetch);
    const out = await explainManifestEmails({
      sources,
      fetchImpl: fetch,
      getDoc,
      setDoc: async () => { throw new Error('explain must never write'); },
      runDiff: (buf) => runManifestBoardDiff(buf),
      deep: new URL(req.url).searchParams.get('deep') === '1',
    });
    return J({ ...out, off, parseSchedule: PARSE_SCHEDULE_LABEL });
  }

  // POST only: this reads mailboxes and rewrites the run every browser shows, so
  // it must not be reachable by anything that speculatively GETs a URL.
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);

  // Gate at dispatcher: this READS THE COMPANY MAILBOXES and rewrites the manifest run every
  // browser shows. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  try {
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board to check against' });

    const { sources, off } = await buildMailSources(fetch);
    if (!sources.length) return J({ ok: true, skipped: off.join('; ') || 'no mailbox configured', processed: 0 });

    const out = await ingestManifestEmails({
      sources,
      fetchImpl: fetch,
      getDoc, setDoc,
      runDiff: (buf) => runManifestBoardDiff(buf),
      // File the paper as well as reading it (Chad: "download the PDF and put them in our
      // system… have a history of those"). Best-effort by contract — see archiveManifest.
      archive: (buf, diff, email, fileName, at, mailbox) =>
        archiveManifest({ tenant: TENANT, buf, diff, email, fileName, at, mailbox }),
    });
    await recordGmailRun(out);

    // Hand back the stored run when this cycle produced one. Reading it back
    // (rather than plumbing it out of the shared ingest) keeps this endpoint's
    // needs out of the pipeline the schedule also uses.
    const checked = (out.outcomes || []).some((o: any) => o.outcome === 'checked');
    const stored = checked ? await getDoc(LATEST_DOC).catch(() => null) : null;

    return J({ ...out, mailboxes: sources.map((s) => s.name), off, summary: summarizeCycle(out), stored });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
  }
};
