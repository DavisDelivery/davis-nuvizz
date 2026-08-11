// manifest-email-ingest-background.mts
//
// Scheduled: poll the Resend inbox for the nightly Uline freight report and run
// the free manifest check on it automatically (Chad: "This should happen
// automatically from email parse"). Everything interesting lives in
// lib/manifest-email-ingest.mts (unit-tested, dependency-injected); this file
// only wires the real fetch/Firestore and the schedule.
//
// Cost per cycle: one Resend list call (free), plus attachment downloads only
// for emails never seen before. ZERO NuVizz calls, ever — the probe step is not
// reachable from here. No-ops quietly when RESEND_API_KEY or Firestore is absent.
//
// Every-30-minutes is deliberate: the report lands once a night, but a cheap
// poll all day also catches a re-sent report or a manually forwarded one within
// half an hour, and the per-email markers make every cycle after the first a
// single list call.

import { isFirestoreEnabled, getDoc, setDoc } from './lib/firestore.mts';
import { runManifestBoardDiff } from './lib/manifest-run.mts';
import { ingestManifestEmails } from './lib/manifest-email-ingest.mts';

export default async (): Promise<Response> => {
  if (!isFirestoreEnabled()) return Response.json({ ok: true, skipped: 'firestore off' });
  const out = await ingestManifestEmails({
    apiKey: process.env.RESEND_API_KEY,
    fetchImpl: fetch,
    getDoc, setDoc,
    runDiff: (buf) => runManifestBoardDiff(buf),
  });
  if (out.processed || out.error) console.log('[manifest-email-ingest]', JSON.stringify(out));
  return Response.json(out);
};

export const config = {
  schedule: '*/30 * * * *',
};
