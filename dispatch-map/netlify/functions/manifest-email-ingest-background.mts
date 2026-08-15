// manifest-email-ingest-background.mts
//
// Scheduled: poll the mailboxes for the nightly Uline freight report and run the
// free manifest check on it automatically (Chad: "This should happen
// automatically from email parse", and later: "write google mail into the app so
// we can parse for these manifests and look for any missing orders every
// night"). Everything interesting lives in lib/manifest-email-ingest.mts
// (unit-tested, dependency-injected); this file only wires the real
// fetch/Firestore, the mailboxes, and the schedule.
//
// TWO MAILBOXES, either or both. Resend receiving turns on with RESEND_API_KEY;
// Gmail turns on with GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.
// Neither configured = quiet no-op. Both configured = both polled, independently,
// so an expired Gmail refresh token can't stop the Resend inbox from being read
// (and vice versa) — the failure shows up as a per-source error in the log line.
//
// Cost per cycle: one list call per mailbox (free), plus attachment downloads
// only for emails never seen before. ZERO NuVizz calls, ever — the probe step is
// not reachable from here.
//
// Every-30-minutes is deliberate: the report lands once a night, but a cheap poll
// all day also catches a re-sent report or a manually forwarded one within half
// an hour, and the per-email markers make every cycle after the first a single
// list call per mailbox.

import { isFirestoreEnabled, getDoc, setDoc } from './lib/firestore.mts';
import { runManifestBoardDiff } from './lib/manifest-run.mts';
import { ingestManifestEmails } from './lib/manifest-email-ingest.mts';
import { buildMailSources, recordGmailRun } from './lib/mail-sources.mts';

export default async (): Promise<Response> => {
  if (!isFirestoreEnabled()) return Response.json({ ok: true, skipped: 'firestore off' });

  // Which mailboxes are on is decided in ONE place, shared with the tab's
  // "Check email now" button, so the button can never test a different set of
  // inboxes than the schedule reads.
  const { sources } = await buildMailSources(fetch);

  const out = await ingestManifestEmails({
    sources,
    fetchImpl: fetch,
    getDoc, setDoc,
    runDiff: (buf) => runManifestBoardDiff(buf),
  });
  // Let the Manifest check tab see that this ran, and whether a tab-connected
  // Gmail grant has lapsed — otherwise a dead token looks exactly like a quiet
  // night, which is the failure this whole feature exists to prevent.
  await recordGmailRun(out);
  if (out.processed || out.error) console.log('[manifest-email-ingest]', JSON.stringify(out));
  return Response.json(out);
};

export const config = {
  schedule: '*/30 * * * *',
};
