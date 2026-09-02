// netlify/functions/uline-forecast-ingest-background.mts
//
// Hourly: read the forecast search out of the SAME Gmail grant the manifest ingest uses, file
// anything new. A monthly email does not need an hourly poll; one Gmail list call an hour is
// the price of "Read now" rarely being needed. The HTTP twin (uline-forecast.mts) carries no
// schedule so it stays reachable; this one carries the schedule and is thin.
//
// ZERO NuVizz.
import { isFirestoreEnabled } from './lib/firestore.mts';
import { buildForecastSource, realIngestDeps, TENANT } from './lib/uline-forecast-store.mts';
import { ingestForecastEmails } from './lib/uline-forecast-ingest.mts';

export default async (): Promise<Response> => {
  if (!isFirestoreEnabled()) return Response.json({ ok: true, skipped: 'firestore off' });
  const { source, query, reason } = await buildForecastSource(fetch);
  if (!source) return Response.json({ ok: true, skipped: reason, query });
  const out = await ingestForecastEmails({ ...realIngestDeps(), source, filedBy: 'schedule', tenant: TENANT });
  if (out.processed || out.error) console.log('[uline-forecast-ingest]', JSON.stringify({ summary: out.summary, listed: out.listed, processed: out.processed, error: out.error }));
  return Response.json({ ...out, query });
};

export const config = {
  schedule: '0 * * * *',
};
