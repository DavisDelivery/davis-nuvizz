// netlify/functions/uline-forecast.mts
//
// ── ULINE'S FORECAST VS THE FREIGHT THAT CAME: THE ENDPOINT ──────────────────
//
// GET is Firestore + blobs only. Nothing a phone reload, a link preview or the layout guard
// can GET ever touches the mailbox — the manifest-email-check rule. Gmail is read ONLY on
// POST, behind the same gate the manifest probe uses (inert until AUTH_REQUIRED, exactly
// like the rest of v0.83.0).
//
//   GET  ?days=60                 the whole card, computed on read (max 180)
//   GET  ?status=1                the job's status doc plus what can be derived from the versions
//   GET  ?explain=YYYY-MM-DD      one night: where its number came from and how it was judged
//   GET  ?version=<id>[&xlsx=1]   one version in full, or the stored spreadsheet inline
//   POST {action:'run', dry?}     one mailbox cycle (dry: reads and parses, writes nothing)   — dispatcher
//   POST {action:'backfill', dry?|confirm}  one quarter-window of the ~50 historical versions  — admin
//   POST {action:'reingest', emailId}       drop one marker so the next cycle re-reads it      — admin
//
// ZERO NuVizz. Every module this file imports is Gmail, Firestore, blobs or pure.

import { isFirestoreEnabled, getDoc, deleteDoc, updateDocFields } from './lib/firestore.mts';
import { requireUser, readJsonBody } from './lib/require-user.mts';
import { buildView, operatingDayET, expectedVersionMissing, versionSummary, ROUTE_DAY_ORDERS_DEFAULT } from '../../src/lib/uline-forecast-score.js';
import {
  readVersionList, readVersionsForWindow, readManifestRows, readActualRows, readXlsx, buildForecastSource, realIngestDeps,
  STATUS_DOC, markerPath, versionPath, capacityFromEnv, routeDayFromEnv, forecastQuery, XLSX_MIME, TENANT,
} from './lib/uline-forecast-store.mts';
import { ingestForecastEmails, backfillForecasts, MAX_PER_RUN_BACKFILL } from './lib/uline-forecast-ingest.mts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 180;

function addDays(iso: string, n: number): string { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function view(days: number, today: string) {
  const from = addDays(today, -days);
  const to = addDays(today, 30);
  const [{ list, full }, manifestRows, actualRows] = await Promise.all([readVersionsForWindow(from, to), readManifestRows(), readActualRows()]);
  const v = buildView({ versions: full, manifestRows, actualRows, today, capacity: capacityFromEnv(), routeDay: routeDayFromEnv() ?? ROUTE_DAY_ORDERS_DEFAULT, windowDays: days });
  // The panel lists EVERY version, not only those in the window — masked, so it stays small.
  v.versions = list.map(versionSummary).sort((a: any, b: any) => Number(b.sentAt) - Number(a.sentAt));
  return v;
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off', note: 'Firestore off', versions: [], outlook: [], scored: [], unscored: [], pending: [], holes: [], closed: [], unforecast: [], changes: [], pattern: [], disagreements: [] });
  const url = new URL(req.url);
  const today = operatingDayET(Date.now()) as string;

  if (req.method === 'GET') {
    try {
      const versionId = url.searchParams.get('version');
      if (versionId) {
        if (!/^[A-Za-z0-9_.-]+$/.test(versionId)) return J({ ok: false, error: 'bad version id' }, 400);
        const doc = await getDoc(versionPath(versionId));
        if (!doc) return J({ ok: false, error: 'no such version' }, 404);
        if (url.searchParams.get('xlsx') === '1') {
          const buf = doc.blobKey ? await readXlsx(String(doc.blobKey)) : null;
          if (!buf) return J({ ok: false, error: doc.xlsxStored ? 'the spreadsheet is recorded as stored but the blob store did not return it' : `the spreadsheet was not stored: ${doc.xlsxError || 'unknown'}` }, 404);
          return new Response(buf, { status: 200, headers: { 'Content-Type': XLSX_MIME, 'Content-Disposition': `inline; filename="${String(doc.fileName || 'ULINE_Forecast.xlsx').replace(/[^\w.-]+/g, '_')}"`, 'Cache-Control': 'no-store' } });
        }
        return J({ ok: true, version: doc });
      }
      if (url.searchParams.get('status') === '1') {
        const [status, list] = await Promise.all([getDoc(STATUS_DOC), readVersionList()]);
        const usable = list.filter((v: any) => v?.ok !== false);
        const sorted = [...list].sort((a: any, b: any) => Number(b.sentAt) - Number(a.sentAt));
        return J({
          ok: true, today, status: status || null, query: forecastQuery(),
          versions: { count: list.length, usable: usable.length, unreadable: list.length - usable.length, earliest: [...list].sort((a: any, b: any) => Number(a.sentAt) - Number(b.sentAt))[0]?.sentDate ?? null, latest: sorted[0]?.sentDate ?? null, latestOk: sorted[0] ? sorted[0].ok !== false : null },
          expectedVersionMissing: expectedVersionMissing(usable, today),
          capacity: capacityFromEnv(), routeDay: routeDayFromEnv() ?? ROUTE_DAY_ORDERS_DEFAULT,
          backfill: status?.backfill ?? null,
        });
      }
      const explain = url.searchParams.get('explain');
      if (explain) {
        if (!DATE_RE.test(explain)) return J({ ok: false, error: 'explain=YYYY-MM-DD' }, 400);
        const v = await view(MAX_DAYS, today);
        const find = (arr: any[]) => (arr || []).find((x) => x.date === explain) || null;
        const night = find(v.scored) || find(v.unscored) || find(v.pending) || find(v.holes) || find(v.closed) || find(v.unforecast) || null;
        return J({ ok: true, date: explain, today, night, floor: v.floor, note: night ? null : 'this date is outside the window or before any forecast' });
      }
      const days = Math.min(MAX_DAYS, Math.max(7, Number(url.searchParams.get('days') || 60) || 60));
      return J(await view(days, today));
    } catch (err: any) {
      return J({ ok: false, error: String(err?.message || err).slice(0, 200), note: 'read failed', versions: [], outlook: [], scored: [], unscored: [], pending: [], holes: [], closed: [], unforecast: [], changes: [], pattern: [], disagreements: [] }, 500);
    }
  }

  if (req.method !== 'POST') return J({ ok: false, error: 'GET or POST' }, 405);
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const action = String(body.body?.action || '');
  const dry = !!body.body?.dry;

  if (action === 'run') {
    const gate = await requireUser(req, { role: 'dispatcher' });
    if (!gate.ok) return gate.response;
    const { source, query, reason } = await buildForecastSource(fetch);
    if (!source) return J({ ok: false, error: reason, query });
    const out = await ingestForecastEmails({ ...realIngestDeps(), source, dry, filedBy: 'manual', maxPerRun: 5, tenant: TENANT });
    console.log('[uline-forecast]', JSON.stringify({ mode: dry ? 'dry' : 'manual', by: gate.user.username, summary: out.summary, listed: out.listed, processed: out.processed, error: out.error }));
    return J({ ...out, query, by: gate.user.username });
  }
  if (action === 'backfill') {
    const gate = await requireUser(req, { role: 'admin' });
    if (!gate.ok) return gate.response;
    const status = await getDoc(STATUS_DOC);
    const deps = realIngestDeps();
    const out = await backfillForecasts({
      ...deps, sourceFor: async (q: string) => (await buildForecastSource(fetch, { query: q, maxResults: 100 })).source,
      cursor: status?.backfill ?? null, today, dry, confirm: !!body.body?.confirm, maxPerRun: MAX_PER_RUN_BACKFILL, maxResults: 100, tenant: TENANT, deadlineMs: 18_000,
    });
    console.log('[uline-forecast]', JSON.stringify({ mode: dry ? 'backfill-dry' : 'backfill', by: gate.user.username, window: out.window, listed: out.listed, advanced: out.advanced, held: out.held, error: out.error }));
    return J({ ...out, by: gate.user.username });
  }
  if (action === 'reingest') {
    const gate = await requireUser(req, { role: 'admin' });
    if (!gate.ok) return gate.response;
    const emailId = String(body.body?.emailId || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(emailId)) return J({ ok: false, error: 'reingest needs an emailId' }, 400);
    const path = markerPath('gmail', emailId);
    const had = await getDoc(path);
    if (!had) return J({ ok: false, error: 'no marker for that message — nothing to drop' }, 404);
    await deleteDoc(path);
    await updateDocFields(STATUS_DOC, { lastReingest: { emailId, at: new Date().toISOString(), by: gate.user.username } }).catch(() => null);
    return J({ ok: true, dropped: path, was: had, note: 'the next cycle re-reads this message' });
  }
  return J({ ok: false, error: `unknown action '${action}' — run | backfill | reingest` }, 400);
};
