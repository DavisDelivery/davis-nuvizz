// lib/stop-search-store.mts — THE SEARCH DIGEST ON DISK.
//
// What the digest is, and why a day of stops is worth one extra document every night:
// src/lib/stop-search.js. This module knows the paths, the switch and the Firestore calls —
// nothing about what an address means.
//
//   history_search/{tenant}__{YYYY-MM-DD}   one per sealed day, written by the post-seal hook
//                                           (history-postseal.mts) and by history-search-rebuild
//
// Firestore only. ZERO NuVizz calls, on every path in this file.

import { setDoc, runQuery } from './firestore.mts';
import { HISTORY_COLLECTION } from './history-store.mts';
import { SEARCH_DIGEST_COLLECTION, SEARCH_DIGEST_MAX_BYTES, encodeSearchDigest } from '../../../src/lib/stop-search.js';
import { addDays, isDateStr } from '../../../src/lib/history-range.js';

/**
 * STOP_SEARCH=off puts every side back at once: the nightly write, the rebuild endpoint and the
 * address/city search on the Stop lookup screen (which then says the search is switched off
 * rather than returning an empty answer that looks like "no stops there"). One switch, so there
 * is no half-reverted state where the screen reads an index nothing writes any more.
 *
 * House shape (proIndexEnabled): default ON, an explicit off-word turns it off, and anything
 * malformed leaves it ON — a typo in an env var must never quietly disable a feature, because a
 * quiet feature looks exactly like a working one.
 */
export function stopSearchEnabled(env: any = process.env): boolean {
  const v = String(env?.STOP_SEARCH ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

export function searchDigestPath(tenant: string, date: string): string {
  return `${SEARCH_DIGEST_COLLECTION}/${tenant}__${date}`;
}

/**
 * Write one day's digest. A WHOLE-DOCUMENT write, on purpose and safely: this document is
 * derived entirely from the day's sealed stops and nothing else ever writes to it, so a
 * replacement is the correct semantics — a re-run after a heal must drop a stop the heal removed,
 * which a merge would keep for ever. (CLAUDE.md's rule is never to blind-write a document you do
 * not own; this is the one collection this module does own, outright.)
 *
 * OVER-SIZE IS A LOUD FAILURE, NEVER A TRUNCATION. A digest that dropped rows to fit would make
 * "no stops at that address" a lie on exactly the busiest day. It throws instead; the post-seal
 * hook records the failure by name on the manifest, and the search reports that day as not
 * searched.
 */
export async function writeSearchDigest(
  tenant: string, date: string, stops: any[],
  io: { setDoc: (path: string, data: any) => Promise<any> } = { setDoc },
  nowIso: string = new Date().toISOString(),
): Promise<{ count: number; skipped: number; bytes: number }> {
  if (!isDateStr(date)) throw new Error(`search digest: not a day id: ${date}`);
  const doc = encodeSearchDigest(stops, { tenant, date, builtAt: nowIso });
  if (doc.bytes > SEARCH_DIGEST_MAX_BYTES) {
    throw new Error(`search digest for ${date} is ${doc.bytes} bytes (${doc.count} stops) — over the ${SEARCH_DIGEST_MAX_BYTES}-byte ceiling under Firestore's 1 MiB document limit; the day is NOT searchable by address until this is split`);
  }
  await io.setDoc(searchDigestPath(tenant, date), doc);
  return { count: doc.count, skipped: doc.skipped, bytes: doc.bytes };
}

/** The post-seal hook. Signature matches history-postseal's HOOKS: (tenant, date, stops). */
export async function updateStopSearchForDay(tenant: string, date: string, stops: any[]): Promise<any> {
  if (!stopSearchEnabled()) return { skipped: 'STOP_SEARCH=off' };
  return writeSearchDigest(tenant, date, stops);
}

// ── reading ───────────────────────────────────────────────────────────────────

/**
 * A date-bounded query on one collection's `date` field: >= from AND < the day after `to`.
 * A RANGE ON ONE FIELD, which Firestore serves from its automatic single-field index — no
 * composite index to deploy, which this repo has no way to do from a pull request. Always a
 * compositeFilter, even for one bound, so the shape is the same whichever ends are given.
 */
export function dateRangeQuery(collectionId: string, from: string | null, to: string | null, fields?: string[]): any {
  const filters: any[] = [];
  if (from) filters.push({ fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } });
  if (to) filters.push({ fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN', value: { stringValue: addDays(to, 1) } } });
  const q: any = { from: [{ collectionId }] };
  if (filters.length) q.where = { compositeFilter: { op: 'AND', filters } };
  if (fields?.length) q.select = { fields: fields.map((fieldPath) => ({ fieldPath })) };
  return q;
}

/**
 * PURE: split [from, to] into calendar months — the unit the digest is read in.
 *
 * WHY NOT ONE QUERY. "All dates" is ~110 digests today at ~100KB each, and a year of them is
 * ~26MB in ONE response. Month by month is ≤23 documents (≤3MB) a response, and the months are
 * read in parallel, which is also faster. The split is by calendar month so the pieces are the
 * same pieces whatever range was asked for.
 */
export function monthWindows(from: string, to: string): Array<{ from: string; to: string }> {
  if (!isDateStr(from) || !isDateStr(to) || from > to) return [];
  const out: Array<{ from: string; to: string }> = [];
  let start = from;
  // Bounded: a hand-typed century is not a loop.
  for (let i = 0; i < 240 && start <= to; i++) {
    const [y, m] = start.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const end = addDays(next, -1);
    out.push({ from: start, to: end < to ? end : to });
    start = next;
  }
  return out;
}

async function inBatches<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/**
 * The days we HOLD in the warehouse, within [from, to] (either end may be null): sealed
 * manifests, tombstones excluded — a tombstone is a day Davis did not run, and reporting it as
 * "not searched" would be a hole that is not a hole. Projected to four fields, so this costs one
 * small read per day rather than a manifest's counts and checksum.
 */
export async function readSealedDays(
  tenant: string, from: string | null, to: string | null,
  io: { runQuery: (q: any) => Promise<any[]> } = { runQuery },
): Promise<string[]> {
  const docs = await io.runQuery(dateRangeQuery(HISTORY_COLLECTION, from, to, ['tenant', 'date', 'no_board', 'complete', 'verified']));
  const out = new Set<string>();
  for (const d of docs || []) {
    const date = String(d?.date ?? '');
    const id = String(d?._id ?? '');
    if (!isDateStr(date) || !id.startsWith(`${tenant}__`)) continue;
    if (d?.no_board) continue;
    if (!(d?.complete || d?.verified)) continue;
    out.add(date);
  }
  return [...out].sort();
}

/**
 * The digests within [from, to], read a calendar month at a time, four months in parallel.
 * `from` null means "from the first day we hold", which the caller knows from readSealedDays;
 * with neither end known it falls back to ONE unbounded query rather than guessing a floor.
 */
export async function readSearchDigests(
  tenant: string, from: string | null, to: string | null,
  io: { runQuery: (q: any) => Promise<any[]> } = { runQuery },
): Promise<any[]> {
  const windows = from && to ? monthWindows(from, to) : [];
  const pages = windows.length
    ? await inBatches(windows, 4, (w) => io.runQuery(dateRangeQuery(SEARCH_DIGEST_COLLECTION, w.from, w.to)))
    : [await io.runQuery(dateRangeQuery(SEARCH_DIGEST_COLLECTION, from, to))];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const d of pages.flat()) {
    const id = String(d?._id ?? '');
    if (!id.startsWith(`${tenant}__`) || seen.has(id)) continue;
    seen.add(id);
    out.push(d);
  }
  return out;
}

/** The dates that HAVE a digest, projected to the date alone — what the rebuild's plan needs. */
export async function readDigestDates(
  tenant: string, from: string | null, to: string | null,
  io: { runQuery: (q: any) => Promise<any[]> } = { runQuery },
): Promise<string[]> {
  const docs = await io.runQuery(dateRangeQuery(SEARCH_DIGEST_COLLECTION, from, to, ['tenant', 'date']));
  return [...new Set((docs || [])
    .filter((d) => String(d?._id ?? '').startsWith(`${tenant}__`) && isDateStr(String(d?.date ?? '')))
    .map((d) => String(d.date)))].sort();
}
