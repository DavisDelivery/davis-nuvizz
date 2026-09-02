// lib/uline-forecast-ingest.mts
//
// ── READ ULINE'S MONTHLY FORECAST OUT OF THE MAILBOX AND FILE IT ─────────────
//
// Chad: "find in my email the Uline forecasts they present and I want to start comparing
// them to what the manifest actually produce so we can try to forecast what is coming."
//
// One cycle: list the forecast search, walk the messages OLDEST FIRST (so a same-day
// correction supersedes within one batch), and for each one not yet judged: download the
// spreadsheet, read it, keep the Georgia/Davis lane, and file it as a VERSION keyed by its
// content — the same sheet forwarded twice is one version seen twice; a corrected sheet is a
// second version. Every message gets a marker saying what became of it, so the next cycle
// costs a list and nothing else.
//
// ORDER OF WRITES IS blob → version → marker, always. A crash after the version write leaves
// no marker; the retry finds its own version by digest, sees its own email id already on it,
// and writes the marker as 'filed' without touching the version — never "sent again ×2" for
// a file Uline sent once.
//
// A download or parse that THROWS leaves no marker (retry next hour). A file that reads but
// is NOT a forecast is KEPT as a version with ok:false, its headers, its reason and the
// stored xlsx — the evidence of what Uline sent survives — and gets an 'unreadable' marker
// so it is never re-read.
//
// DEPENDENCY-INJECTED, like ingestManifestEmails: every reader and writer comes in through
// `deps`, so the test runs it against a fake mailbox and a Map, and `dry:true` swaps every
// writer for a recorder — the SAME recorder the tests use, so the preview cannot drift from
// the run. Every count reported comes from what was actually written; a Firestore write that
// throws is reported as a throw, never as an intent.
//
// ZERO NuVizz, by construction: nothing here can reach the vendor.

import { createHash } from 'node:crypto';
import type { MailAttachment, MailMessage, MailSource } from './mail-source.mts';
import { orderOldestFirst } from './manifest-email-ingest.mts';
import { gmailNeedsReconnect } from './mail-sources.mts';
import { readUlineForecast, looksLikeUlineForecast } from './uline-forecast.mts';
import { laneRows, canonicalRows, versionIdFor, sentDateET } from '../../../src/lib/uline-forecast-lane.js';
import { markerPath, versionPath, forecastBlobKey, forecastQuery, VERSIONS_COLLECTION, STATUS_DOC, TENANT, FORECAST_QUERY_DEFAULT } from './uline-forecast-store.mts';

export const MAX_PER_RUN_SCHEDULE = 3;
export const MAX_PER_RUN_BACKFILL = 12;
/** A plain HTTP function dies at its timeout mid-batch as an HTML 502; the loop stops itself
 *  first and says how far it got. */
export const DEFAULT_DEADLINE_MS = 18_000;
export const BACKFILL_START = '2022-06-01';
export const BACKFILL_WINDOW_MONTHS = 3;

export interface ForecastIngestDeps {
  source: MailSource | null;
  getDoc: (path: string) => Promise<any | null>;
  setDoc: (path: string, data: any) => Promise<boolean>;
  updateDocFields: (path: string, data: any) => Promise<boolean>;
  createDocIfAbsent: (path: string, data: any) => Promise<boolean>;
  runQuery: (structuredQuery: any) => Promise<any[]>;
  putBlob: (key: string, buf: Buffer, meta?: Record<string, any>) => Promise<{ ok: boolean; error: string | null }>;
  readForecast?: (buf: Buffer) => ReturnType<typeof readUlineForecast>;
  now?: () => string;
  nowMs?: () => number;
  maxPerRun?: number;
  dry?: boolean;
  deadlineMs?: number;
  filedBy?: 'schedule' | 'manual' | 'backfill';
  tenant?: string;
  /** When set, the status doc is not written (the backfill writes its own block). */
  skipStatus?: boolean;
}

export const isSpreadsheetAttachment = (a: any): boolean =>
  /spreadsheetml|ms-excel/i.test(String(a?.contentType ?? '')) || /\.xlsx?$/i.test(String(a?.filename ?? ''));

/** Every writer replaced by one that records the path and returns success. */
export function makeRecorder(deps: ForecastIngestDeps): { deps: ForecastIngestDeps; writes: Array<{ op: string; path: string }> } {
  const writes: Array<{ op: string; path: string }> = [];
  return {
    writes,
    deps: {
      ...deps,
      setDoc: async (path) => { writes.push({ op: 'setDoc', path }); return true; },
      updateDocFields: async (path) => { writes.push({ op: 'updateDocFields', path }); return true; },
      createDocIfAbsent: async (path) => { writes.push({ op: 'createDocIfAbsent', path }); return true; },
      putBlob: async (key) => { writes.push({ op: 'putBlob', path: key }); return { ok: true, error: null }; },
    },
  };
}

export function contentDigest(days: Record<string, [number, number | null]>): string {
  return createHash('sha256').update(canonicalRows(days)).digest('hex');
}

/** The version document, built in ONE place so the list mask can be pinned against it. */
export function buildVersionDoc(args: {
  tenant: string; versionId: string; email: MailMessage; att: MailAttachment; buf: Buffer; read: any; lane: any;
  digest: string; blobKey: string; stored: { ok: boolean; error: string | null }; at: string; filedBy: string;
}): Record<string, any> {
  const { tenant, versionId, email, att, buf, read, lane, digest, blobKey, stored, at, filedBy } = args;
  return {
    version: 1, tenant, versionId,
    sentAt: Number(email.receivedAt) || null, sentDate: sentDateET(email.receivedAt),
    emailIds: [email.id], seen: 1, lastSeenAt: at,
    fromAddress: email.from ?? null, subject: email.subject ?? null, fileName: att.filename ?? null,
    bytes: buf.length, bytesDigest: createHash('sha256').update(buf).digest('hex'), contentDigest: digest,
    sheet: read?.sheet ?? null, headers: lane.headers,
    ok: lane.ok, reason: lane.reason, warnings: lane.warnings.slice(0, 40),
    rowsTotal: lane.rowsTotal, rowsUsed: lane.rowsUsed, rowsDropped: lane.rowsDropped, lanes: lane.seen,
    from: lane.from, to: lane.to, days: lane.days, unreadableDates: lane.unreadableDates,
    weekdayMeans: lane.weekdayMeans, medianBand: lane.medianBand,
    blobKey, xlsxStored: !!stored.ok, xlsxError: stored.ok ? null : stored.error,
    filedAt: at, filedBy,
  };
}

const digestQuery = (digest: string) => ({
  from: [{ collectionId: VERSIONS_COLLECTION }],
  where: { fieldFilter: { field: { fieldPath: 'contentDigest' }, op: 'EQUAL', value: { stringValue: digest } } },
  limit: 1,
});

/**
 * One cycle. Returns what happened, per message, plus the writes made (or, dry, the writes
 * that would have been made).
 */
export async function ingestForecastEmails(input: ForecastIngestDeps): Promise<any> {
  const dry = !!input.dry;
  const rec = dry ? makeRecorder(input) : null;
  const deps = rec ? rec.deps : input;
  const now = deps.now || (() => new Date().toISOString());
  const nowMs = deps.nowMs || (() => Date.now());
  const tenant = deps.tenant || TENANT;
  const filedBy = deps.filedBy || 'schedule';
  const maxPerRun = deps.maxPerRun || MAX_PER_RUN_SCHEDULE;
  const deadline = nowMs() + (deps.deadlineMs || DEFAULT_DEADLINE_MS);
  const readForecast = deps.readForecast || readUlineForecast;
  const src = deps.source;
  const outcomes: any[] = [];
  const result: any = { ok: true, dry, filedBy, listed: 0, processed: 0, alreadyMarked: 0, partial: false, outcomes, wouldWrite: rec ? rec.writes : undefined, error: null, needsReconnect: false, summary: '' };

  if (!src) {
    result.ok = false; result.error = 'no forecast mailbox source';
    result.summary = 'Gmail is not connected — nothing read';
    return finish(result, deps, dry, now);
  }
  let emails: MailMessage[];
  try {
    emails = await src.list();
  } catch (e: any) {
    result.ok = false; result.error = `gmail: ${String(e?.message || e).slice(0, 200)}`;
    result.needsReconnect = gmailNeedsReconnect(result.error);
    result.summary = result.needsReconnect ? 'the forecast mailbox needs reconnecting' : `could not read the mailbox: ${result.error}`;
    return finish(result, deps, dry, now);
  }
  result.listed = emails.length;
  result.sourceName = src.name;

  // A Firestore or blob throw mid-loop must still reach finish(): otherwise the status doc
  // keeps the previous run's lastOk:true and the failure is invisible from the screen.
  try {
    for (const email of orderOldestFirst(emails)) {
      if (result.processed >= maxPerRun) { result.partial = true; result.stoppedBecause = `batch cap ${maxPerRun}`; break; }
      if (nowMs() > deadline) { result.partial = true; result.stoppedBecause = 'time budget'; break; }
      const id = String(email?.id ?? '');
      if (!id) continue;
      const marker = markerPath(src.name, id);
      const existing = await deps.getDoc(marker);
      if (existing) { result.alreadyMarked += 1; continue; }

      const line: any = { id, sentAt: email.receivedAt ?? null, sentDate: sentDateET(email.receivedAt), subject: email.subject ?? null, from: email.from ?? null, attachment: null, parse: null, contentDigest: null, outcome: null, versionId: null, reason: null };
      outcomes.push(line);
      const atts = (email.attachments || []).filter(isSpreadsheetAttachment);
      if (!atts.length) {
        line.outcome = 'ignored'; line.reason = 'no spreadsheet attachment';
        await deps.createDocIfAbsent(marker, { outcome: 'ignored', reason: line.reason, at: now(), source: src.name, from: email.from ?? null, subject: email.subject ?? null, sentAt: email.receivedAt ?? null });
        result.processed += 1;
        continue;
      }
      const att = atts[0];
      line.attachment = att.filename ?? null;
      let buf: Buffer | null = null;
      try { buf = await src.download(email, att); } catch (e: any) { line.outcome = 'retry'; line.reason = `download failed: ${String(e?.message || e).slice(0, 160)}`; continue; }
      if (!buf || !buf.length) { line.outcome = 'retry'; line.reason = 'empty attachment'; continue; }

      let read: any; let lane: any;
      try {
        read = readForecast(buf);
        lane = laneRows(read, line.sentDate);
      } catch (e: any) { line.outcome = 'retry'; line.reason = `parse threw: ${String(e?.message || e).slice(0, 160)}`; continue; }
      if (!looksLikeUlineForecast(read) && lane.ok) lane = { ...lane, ok: false, reason: `not a forecast: ${read.rows.length} rows read` };
      line.parse = { ok: lane.ok, reason: lane.reason, rowsTotal: lane.rowsTotal, rowsUsed: lane.rowsUsed, rowsDropped: lane.rowsDropped, from: lane.from, to: lane.to, warnings: lane.warnings.slice(0, 10), headers: lane.headers };
      if (!line.sentDate) { line.outcome = 'retry'; line.reason = 'message has no receive time — cannot date the version'; continue; }

      const digest = contentDigest(lane.days);
      line.contentDigest = digest;
      const versionId = versionIdFor(tenant, line.sentDate, digest);
      const at = now();

      // The same content already on file? (A forward, a re-send — or our own crash-resume.)
      let hit: any = null;
      if (lane.ok) {
        try { hit = (await deps.runQuery(digestQuery(digest)))[0] || null; } catch (e: any) { line.outcome = 'retry'; line.reason = `digest lookup failed: ${String(e?.message || e).slice(0, 160)}`; continue; }
      }
      if (hit) {
        const hitId = String(hit.versionId || hit._id || '');
        const ids: string[] = Array.isArray(hit.emailIds) ? hit.emailIds.map(String) : [];
        if (ids.includes(id)) {
          // CRASH-RESUME: our own version, written last time before the marker could be. Say so
          // and write only the marker — seen stays 1, the email id stays listed once.
          line.outcome = 'filed'; line.versionId = hitId; line.reason = 'resumed: version already written';
          await deps.createDocIfAbsent(marker, { outcome: 'filed', versionId: hitId, contentDigest: digest, at, source: src.name, from: email.from ?? null, subject: email.subject ?? null, sentAt: email.receivedAt ?? null, resumed: true });
        } else {
          line.outcome = 'duplicate'; line.versionId = hitId; line.reason = `same content as ${hitId}`;
          await deps.updateDocFields(versionPath(hitId), { seen: (Number(hit.seen) || 1) + 1, emailIds: [...ids, id], lastSeenAt: at });
          await deps.createDocIfAbsent(marker, { outcome: 'duplicate', versionId: hitId, contentDigest: digest, at, source: src.name, from: email.from ?? null, subject: email.subject ?? null, sentAt: email.receivedAt ?? null });
        }
        result.processed += 1;
        continue;
      }

      // NEW CONTENT (or an unreadable file, kept as evidence): blob → version → marker.
      const blobKey = forecastBlobKey(tenant, versionId);
      let stored: { ok: boolean; error: string | null };
      try { stored = await deps.putBlob(blobKey, buf, { versionId, emailId: id, fileName: att.filename ?? '' }); }
      catch (e: any) { stored = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
      const doc = buildVersionDoc({ tenant, versionId, email, att, buf, read, lane, digest, blobKey, stored, at, filedBy });
      await deps.setDoc(versionPath(versionId), doc);
      const outcome = lane.ok ? 'filed' : 'unreadable';
      line.outcome = outcome; line.versionId = versionId; line.reason = lane.ok ? null : lane.reason; line.xlsxStored = stored.ok;
      await deps.createDocIfAbsent(marker, { outcome, versionId, contentDigest: digest, reason: lane.reason, at, source: src.name, from: email.from ?? null, subject: email.subject ?? null, sentAt: email.receivedAt ?? null });
      result.processed += 1;
    }
  } catch (e: any) {
    result.ok = false; result.error = `write failed: ${String(e?.message || e).slice(0, 200)}`;
    result.partial = true; result.stoppedBecause = 'error';
  }

  const filed = outcomes.filter((o) => o.outcome === 'filed' && !o.reason).length;
  const dup = outcomes.filter((o) => o.outcome === 'duplicate').length;
  const bad = outcomes.filter((o) => o.outcome === 'unreadable').length;
  const retry = outcomes.filter((o) => o.outcome === 'retry').length;
  const parts: string[] = [];
  if (filed) parts.push(`${filed} new forecast${filed === 1 ? '' : 's'} filed`);
  if (dup) parts.push(`${dup} sent again (identical)`);
  if (bad) parts.push(`${bad} could not be read`);
  if (retry) parts.push(`${retry} to retry`);
  if (!parts.length) parts.push(result.listed ? `nothing new (${result.alreadyMarked} already judged)` : 'no matching email');
  if (result.partial) parts.push(`stopped: ${result.stoppedBecause}`);
  if (!result.ok && result.error) parts.unshift(result.error);
  result.summary = parts.join(' · ');
  return finish(result, deps, dry, now);
}

async function finish(result: any, deps: ForecastIngestDeps, dry: boolean, now: () => string): Promise<any> {
  if (dry || deps.skipStatus) return result;
  const at = now();
  const patch: Record<string, any> = {
    lastRunAt: at, lastOk: !!result.ok, lastError: result.error ?? null, lastSummary: result.summary, lastMode: result.filedBy,
    needsReconnect: !!result.needsReconnect,
  };
  if (result.ok) patch.lastSuccessAt = at;   // untouched on failure, so the screen can say how long it has been
  const filed = (result.outcomes || []).filter((o: any) => o.outcome === 'filed' && o.versionId && !o.reason);
  if (filed.length) { patch.latestVersionId = filed[filed.length - 1].versionId; patch.latestSentDate = filed[filed.length - 1].sentDate; }
  try { await deps.updateDocFields(STATUS_DOC, patch); result.statusWritten = true; }
  catch (e: any) { result.statusWritten = false; result.statusError = String(e?.message || e).slice(0, 160); }
  return result;
}

// ── BACKFILL: THE ~50 HISTORICAL VERSIONS, ONE QUARTER-WINDOW PER PRESS ──────

/** Gmail's list caps at 100 with no paging in our source, so the history is walked in
 *  calendar quarters — ~3 forecasts each, never near the cap. */
export function backfillWindow(startIso: string, baseQuery: string = FORECAST_QUERY_DEFAULT): { start: string; end: string; query: string } {
  const [y, m] = startIso.split('-').map(Number);
  const endM = m + BACKFILL_WINDOW_MONTHS;
  const end = `${y + Math.floor((endM - 1) / 12)}-${String(((endM - 1) % 12) + 1).padStart(2, '0')}-01`;
  const gq = (iso: string) => iso.replace(/-/g, '/');
  // The SAME search the hourly job uses (ULINE_FORECAST_QUERY), with its recency term replaced by
  // the window — so "narrow ULINE_FORECAST_QUERY" on the held line is advice that actually works.
  const base = String(baseQuery || FORECAST_QUERY_DEFAULT).replace(/\b(newer_than|older_than|after|before):\S+/g, ' ').replace(/\s+/g, ' ').trim();
  return { start: startIso, end, query: `${base} after:${gq(startIso)} before:${gq(end)}` };
}

export interface BackfillDeps extends Omit<ForecastIngestDeps, 'source'> {
  sourceFor: (query: string) => Promise<MailSource | null>;
  cursor: { windowStart?: string; done?: boolean; emptySeenFor?: string | null; filed?: number; duplicate?: number; unreadable?: number; ignored?: number } | null;
  today: string;
  confirm?: boolean;
  maxResults?: number;
  /** The search to window (default ULINE_FORECAST_QUERY / FORECAST_QUERY_DEFAULT). */
  baseQuery?: string;
}

/**
 * One window. Advances the cursor only when the window's messages are ALL judged and at
 * least one was returned — a window that returns nothing is held for a second look, because
 * the Gmail source swallows a failed message get and a quarter whose one forecast failed to
 * fetch would otherwise be skipped for good with status reading "done".
 */
export async function backfillForecasts(input: BackfillDeps): Promise<any> {
  const dry = !!input.dry;
  if (!dry && !input.confirm) return { ok: false, error: 'backfill requires confirm:true (run a dry run first)', refused: true };
  const cursor = { windowStart: BACKFILL_START, done: false, emptySeenFor: null as string | null, filed: 0, duplicate: 0, unreadable: 0, ignored: 0, ...(input.cursor || {}) };
  if (cursor.done) return { ok: true, done: true, cursor, summary: 'backfill already complete', dry };
  const win = backfillWindow(cursor.windowStart, input.baseQuery ?? forecastQuery());
  if (win.start > input.today) { cursor.done = true; return { ok: true, done: true, cursor, summary: 'backfill complete — the window is past today', dry, window: win }; }
  const source = await input.sourceFor(win.query);
  const run = await ingestForecastEmails({ ...input, source, dry, filedBy: 'backfill', maxPerRun: input.maxPerRun || MAX_PER_RUN_BACKFILL, skipStatus: true });
  const maxResults = input.maxResults || 100;
  const truncated = run.listed >= maxResults;
  const retrying = (run.outcomes || []).some((o: any) => o.outcome === 'retry');
  const allJudged = !run.partial && !retrying && run.ok;
  let advanced = false; let held: string | null = null;
  const next = { ...cursor };
  if (truncated) held = `window ${win.start}–${win.end} listed ${run.listed} messages — at the cap; narrow ULINE_FORECAST_QUERY (this window reuses its subject/has terms) before advancing`;
  else if (!run.ok) held = run.error;
  else if (!allJudged) held = run.partial ? `batch stopped (${run.stoppedBecause}) — press again to continue this window` : 'some messages must be retried';
  else if (run.listed === 0) {
    if (cursor.emptySeenFor === win.start) { advanced = true; next.emptySeenFor = null; }
    else { next.emptySeenFor = win.start; held = `window ${win.start}–${win.end} listed nothing — held for one more look (a message whose fetch failed is invisible); press again to move past it`; }
  } else advanced = true;
  if (advanced) next.windowStart = win.end;
  for (const o of run.outcomes || []) { if (o.outcome === 'filed' && !o.reason) next.filed += 1; else if (o.outcome === 'duplicate') next.duplicate += 1; else if (o.outcome === 'unreadable') next.unreadable += 1; else if (o.outcome === 'ignored') next.ignored += 1; }
  if (!dry) {
    try { await input.updateDocFields(STATUS_DOC, { backfill: { ...next, lastRunAt: (input.now || (() => new Date().toISOString()))(), lastWindow: `${win.start}–${win.end}`, truncated, held } }); }
    catch (e: any) { run.statusError = String(e?.message || e).slice(0, 160); }
  }
  return { ok: run.ok, dry, window: win, listed: run.listed, truncated, advanced, held, cursor: dry ? cursor : next, wouldAdvanceTo: advanced ? win.end : null, run };
}
