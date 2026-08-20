// manifest-email-check.mts
//
// ON DEMAND: the "Check email now" button on the Manifest check tab.
//
//   POST /.netlify/functions/manifest-email-check
//
// The scheduled poll runs every 30 minutes, which is right for a report that
// lands once a night and wrong for the moment you have just connected a mailbox
// and want to know it works. This runs ONE cycle over exactly the same mailboxes
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
import { ingestManifestEmails, LATEST_DOC } from './lib/manifest-email-ingest.mts';
import { archiveManifest } from './lib/manifest-archive-store.mts';

const TENANT = 'davis';
import { buildMailSources, recordGmailRun, summarizeCycle } from './lib/mail-sources.mts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const J = (o: any, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: CORS });

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  // POST only: this reads mailboxes and rewrites the run every browser shows, so
  // it must not be reachable by anything that speculatively GETs a URL.
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);

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
