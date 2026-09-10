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
import { archiveManifest } from './lib/manifest-archive-store.mts';

const TENANT = 'davis';
import { buildMailSources, recordGmailRun } from './lib/mail-sources.mts';

export default async (): Promise<Response> => {
  if (!isFirestoreEnabled()) return Response.json({ ok: true, skipped: 'firestore off' });

  // Which mailboxes are on is decided in ONE place, shared with the tab's
  // "Check email now" button, so the button can never test a different set of
  // inboxes than the schedule reads.
  // THE ET GATE. Four UTC firings, three real passes — see the note beside `config` below.
  // A stood-down firing says so rather than returning a silent empty result, because "nothing
  // to do" and "wrong hour" are different answers and only one of them is worth investigating.
  const etHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).find((x) => x.type === 'hour')?.value ?? -1) % 24;
  if (!isParseHour(etHour)) {
    return Response.json({ ok: true, skipped: 'not a parse hour', etHour, parseHoursEt: PARSE_HOURS_ET });
  }

  const { sources } = await buildMailSources(fetch);

  const out = await ingestManifestEmails({
    sources,
    fetchImpl: fetch,
    getDoc, setDoc,
    runDiff: (buf) => runManifestBoardDiff(buf),
    // The SCHEDULED path is the one that actually files most nights — the click-driven
    // endpoint is the exception. Same archiver, so a manifest caught by either route lands
    // in the same day record with the same revision numbering.
    archive: (buf, diff, email, fileName, at, mailbox) =>
      archiveManifest({ tenant: TENANT, buf, diff, email, fileName, at, mailbox }),
  });
  // Let the Manifest check tab see that this ran, and whether a tab-connected
  // Gmail grant has lapsed — otherwise a dead token looks exactly like a quiet
  // night, which is the failure this whole feature exists to prevent.
  await recordGmailRun(out);
  if (out.processed || out.error) console.log('[manifest-email-ingest]', JSON.stringify(out));
  return Response.json(out);
};

// ── WHEN THE PARSE RUNS: 8:10p, 9:10p and 10:10p ET ─────────────────────────
//
// Chad: "We need to do our first parse at 8:10 pm 9:10 10:10".
//
// It used to poll every 30 minutes around the clock — 48 passes a day at hours when Uline has
// not sent anything, which is how a 3:00pm check on a report that had not arrived yet ends up
// on screen saying it could not reconcile against its own printed totals. Three passes in the
// window the report actually lands in is the whole ask.
//
// THE CRON IS UTC AND ET IS NOT, so a fixed UTC time is the wrong ET time for 133 days a year.
// This is the same trap day-completion-report-background documents at length, and the same
// answer: fire at the UNION of the UTC slots that could be one of these ET hours in either
// season, and let the ET clock decide which firings are real.
//
//   EDT (UTC-4)   8:10p 9:10p 10:10p ET  ->  00:10 01:10 02:10 UTC
//   EST (UTC-5)   8:10p 9:10p 10:10p ET  ->  01:10 02:10 03:10 UTC
//   union                                ->  00:10 01:10 02:10 03:10 UTC
//
// Four firings, of which exactly three pass in either season: in EDT the 03:10 slot is 11:10p
// ET and stands down; in EST the 00:10 slot is 7:10p ET and stands down. A test sweeps the
// calendar rather than trusting this comment.
export const PARSE_HOURS_ET = [20, 21, 22];

/** PURE. Is this ET hour one of the three passes? The minute is not tested: the cron fires
 *  once an hour at :10, so the hour alone identifies the firing, and testing the minute would
 *  make the job miss its slot on a platform that runs it a minute late. */
export function isParseHour(hour: number): boolean {
  return PARSE_HOURS_ET.includes(hour);
}

export const config = {
  schedule: '10 0,1,2,3 * * *',
};
