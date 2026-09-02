// netlify/functions/uline-forecast-ingest-background.mts
//
// WEEKLY: read the forecast search out of the SAME Gmail grant the manifest ingest uses, file
// anything new. Chad: "we don't need to check for a forecast every hour maybe once a week we
// don't get new ones but every couple of months." Hourly was 720 Gmail list calls a month to
// find something that arrives at most once; weekly is 4, and "Read forecast email now" covers
// the day somebody wants it sooner.
//
// MONDAY 13:00 UTC — 9am ET in summer, 8am in winter. Monday because Uline has sent between the
// 4th and the 7th every month since June 2022, so a Monday run always lands within a week of
// that window; and because a run that fails on a Monday is visible on the card all week rather
// than at a weekend. A weekly cadence means the card must never say "Uline has not sent it"
// when the truth is that nobody has looked — see versionStanding.
//
// The HTTP twin (uline-forecast.mts) carries no schedule so it stays reachable; this one
// carries the schedule and is thin.
//
// ZERO NuVizz.
import { isFirestoreEnabled, updateDocFields } from './lib/firestore.mts';
import { buildForecastSource, realIngestDeps, STATUS_DOC, TENANT } from './lib/uline-forecast-store.mts';
import { ingestForecastEmails } from './lib/uline-forecast-ingest.mts';

export default async (): Promise<Response> => {
  if (!isFirestoreEnabled()) return Response.json({ ok: true, skipped: 'firestore off' });
  const { source, query, reason } = await buildForecastSource(fetch);
  // A MISSING GRANT IS A FAILED RUN, NOT A SKIPPED ONE. This used to return ok:true and write
  // nothing, so a disconnected mailbox left lastRunAt/lastSuccessAt frozen at the last good week
  // and the Job panel read healthy while nothing was being read at all. At one run a week that is
  // ten days of quiet before anything on the screen says so.
  if (!source) {
    await updateDocFields(STATUS_DOC, {
      lastRunAt: new Date().toISOString(), lastOk: false, lastError: reason,
      lastSummary: reason, lastMode: 'schedule', needsReconnect: true,
    }).catch(() => {});
    return Response.json({ ok: false, error: reason, query });
  }
  const out = await ingestForecastEmails({ ...realIngestDeps(), source, filedBy: 'schedule', tenant: TENANT });
  if (out.processed || out.error) console.log('[uline-forecast-ingest]', JSON.stringify({ summary: out.summary, listed: out.listed, processed: out.processed, error: out.error }));
  return Response.json({ ...out, query });
};

export const config = {
  schedule: '0 13 * * 1',
};
