// lib/uline-forecast-store.mts
//
// ── WHERE THE FORECAST LIVES, AND HOW IT IS READ ─────────────────────────────
//
// Paths, field masks, the blob key and the Gmail source for Uline's monthly forecast. The
// ingest (uline-forecast-ingest.mts) writes through injected functions so it can be tested
// against a Map; this file is where the REAL ones are assembled, and the only place that
// knows a Firestore collection name.
//
// Every document here is owned by this feature. manifest_days is READ (masked), never
// written; nuvizz_ops/gmail_status is read through resolveGmailConfig and never patched —
// its `query` is the MANIFEST search and a forecast run must not disturb it.
//
// ZERO NuVizz. This module imports firestore, blobs, the Gmail source and the pure libs, and
// nothing that can reach the vendor. An import-graph test holds that.

import { getDoc, setDoc, updateDocFields, createDocIfAbsent, runQuery, listDocs } from './firestore.mts';
import { putManifestPdf, getManifestPdf } from './manifest-blobs.mts';
import { gmailSource, type GmailConfig } from './gmail-source.mts';
import { resolveGmailConfig } from './mail-sources.mts';
import type { MailSource } from './mail-source.mts';
import { MANIFEST_DAYS_COLLECTION } from './manifest-archive.mts';

export const TENANT = 'davis';
export const VERSIONS_COLLECTION = 'uline_forecast_versions';
export const ACTUAL_DAYS_COLLECTION = 'uline_actual_days';
export const STATUS_DOC = 'nuvizz_ops/uline_forecast_status';
/** Own prefix, so a forecast marker can never collide with a manifest_email__ marker. */
export const MARKER_PREFIX = 'uline_forecast_email__';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** A cheap PREFILTER, not the match rule — the parse decides what is a forecast. No sender
 *  filter: the sender already changed once (Wooldridge → Luo). */
export const FORECAST_QUERY_DEFAULT = 'subject:"Uline Forecast" has:attachment newer_than:45d';
export const FORECAST_MAX_RESULTS_DEFAULT = 20;

export const markerPath = (sourceName: string, emailId: string): string => `nuvizz_ops/${MARKER_PREFIX}${sourceName}__${emailId}`;
export const versionPath = (versionId: string): string => `${VERSIONS_COLLECTION}/${versionId}`;
export const actualDayPath = (tenant: string, date: string): string => `${ACTUAL_DAYS_COLLECTION}/${tenant}__${date}`;
export const forecastBlobKey = (tenant: string, versionId: string): string => `${tenant}/forecasts/${versionId}.xlsx`;

/**
 * EVERY FIELD OF A VERSION DOC EXCEPT `days`. A Firestore mask is an inclusion list: a field
 * not named here silently vanishes from the versions panel, and `ok ?? false` would then
 * paint a healthy version as unreadable with no error anywhere. A test builds a version doc
 * through the ingest's own writer and asserts every key but `days` is in this list.
 */
export const VERSION_LIST_MASK = [
  'version', 'tenant', 'versionId', 'sentAt', 'sentDate', 'emailIds', 'seen', 'fromAddress', 'subject', 'fileName',
  'bytes', 'bytesDigest', 'contentDigest', 'sheet', 'headers', 'ok', 'reason', 'warnings', 'rowsTotal', 'rowsUsed',
  'rowsDropped', 'lanes', 'from', 'to', 'unreadableDates', 'weekdayMeans', 'medianBand', 'blobKey', 'xlsxStored',
  'xlsxError', 'filedAt', 'filedBy', 'lastSeenAt',
];
/** What the scorer reads off a night: never the capped `missing` list, which is the bulk of the doc. */
export const MANIFEST_DAYS_MASK = [
  'latest.orders', 'latest.verified', 'latest.receivedAt', 'latest.reportNo', 'latest.at', 'latest.mailbox', 'latest.totals',
  'reportCount', 'sawOrderCountFall',
];

export function forecastQuery(env: Record<string, string | undefined> = process.env): string {
  const q = String(env.ULINE_FORECAST_QUERY || '').trim();
  return q || FORECAST_QUERY_DEFAULT;
}
export function capacityFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const n = Number(env.ULINE_FORECAST_CAPACITY);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function routeDayFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const n = Number(env.ULINE_ROUTE_DAY_ORDERS);
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** Days Davis does not run a route, beyond the federal holidays Uline also closes on: Chad's
 *  list, ISO dates separated by commas or spaces. Anything that is not a date is ignored. */
export function davisClosedFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return String(env.ULINE_DAVIS_CLOSED || '').split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

/** The forecast mailbox source: the SAME grant the manifest ingest uses, a different search.
 *  cfg.query is spread over and never written back. Null when Gmail is not set up. */
export async function buildForecastSource(fetchImpl: typeof fetch = fetch, opts: { query?: string; maxResults?: number } = {}): Promise<{ source: MailSource | null; query: string; reason: string | null }> {
  const cfg = await resolveGmailConfig();
  const query = opts.query || forecastQuery();
  if (!cfg) return { source: null, query, reason: 'gmail: no mailbox connected — use Connect Gmail on the Manifest check tab' };
  const c: GmailConfig = { ...cfg, query, maxResults: opts.maxResults || FORECAST_MAX_RESULTS_DEFAULT };
  return { source: gmailSource(c, fetchImpl), query, reason: null };
}

/** The versions panel: every version, kilobytes not megabytes. */
export async function readVersionList(): Promise<any[]> {
  return listDocs(VERSIONS_COLLECTION, { mask: VERSION_LIST_MASK });
}

/** Full docs (with `days`) for the versions whose range overlaps [from, to] — ~14 for 90 days. */
export async function readVersionsForWindow(from: string, to: string): Promise<{ list: any[]; full: any[] }> {
  const list = await readVersionList();
  const wanted = list.filter((v) => v?.ok !== false && v?.from && v?.to && String(v.from) <= to && String(v.to) >= from);
  const full: any[] = [];
  for (const v of wanted) {
    const doc = await getDoc(versionPath(String(v.versionId || v._id)));
    if (doc) full.push(doc);
  }
  return { list, full };
}

export async function readManifestRows(): Promise<any[]> {
  return listDocs(MANIFEST_DAYS_COLLECTION, { mask: MANIFEST_DAYS_MASK });
}
export async function readActualRows(): Promise<any[]> {
  return listDocs(ACTUAL_DAYS_COLLECTION);   // 404 → [] until PR 2 fills it
}

/** The stored spreadsheet: the same blob store as the manifest PDFs, with the xlsx type
 *  (putManifestPdf spreads meta AFTER its default contentType, so the override takes). */
export async function storeXlsx(key: string, buf: Buffer, meta: Record<string, any> = {}): Promise<{ ok: boolean; error: string | null }> {
  return putManifestPdf(key, buf, { contentType: XLSX_MIME, ...meta });
}
export async function readXlsx(key: string): Promise<Buffer | null> {
  return getManifestPdf(key);
}

/** The real writers and readers, in the shape the ingest is tested against. */
export function realIngestDeps() {
  return { getDoc, setDoc, updateDocFields, createDocIfAbsent, runQuery, putBlob: storeXlsx };
}
