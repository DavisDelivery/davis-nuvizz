// lib/stop-pace-store.mts — THE PACE DIGEST ON DISK.
//
// What the digest is and why a day is worth one extra document every night: lib/stop-pace.mts.
// This module knows the paths, the switch and the Firestore calls — nothing about what a
// delivery means.
//
//   pace_days/{tenant}__{YYYY-MM-DD}   one per sealed day, written by the post-seal hook
//                                      (history-postseal.mts) and by stop-pace-rebuild
//
// Firestore only. ZERO NuVizz calls, on every path in this file.

import { setDoc, getDoc, runQuery } from './firestore.mts';
import { dateRangeQuery, monthWindows } from './stop-search-store.mts';
import { buildPaceDigest, PACE_SUMMARY_FIELDS } from './stop-pace.mts';
import { isDateStr } from '../../../src/lib/history-range.js';

export const PACE_COLLECTION = 'pace_days';

/** A day's digest is about 1 KB plus ~160 bytes a route, as JSON (measured on the layout guards'
 *  fixture: 24 routes, 5 KB). Anything near Firestore's 1 MiB document limit is not a digest, it
 *  is a bug — refused loudly, never truncated. */
export const PACE_DIGEST_MAX_BYTES = 200_000;

/**
 * STOP_PACE=off puts every side back at once: the nightly write, the rebuild endpoint and the
 * Performance screen (which then says the feature is switched off, rather than drawing an empty
 * chart that looks like a day nobody delivered anything). One switch, so there is no
 * half-reverted state where the screen reads documents nothing writes any more.
 *
 * House shape (stopSearchEnabled, proIndexEnabled): default ON, an explicit off-word turns it
 * off, and anything malformed leaves it ON — a typo in an env var must never quietly disable a
 * feature, because a quiet feature looks exactly like a working one.
 */
export function stopPaceEnabled(env: any = process.env): boolean {
  const v = String(env?.STOP_PACE ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

export function paceDigestPath(tenant: string, date: string): string {
  return `${PACE_COLLECTION}/${tenant}__${date}`;
}

/**
 * Write one day's digest. A WHOLE-DOCUMENT write, on purpose and safely, for the reason
 * stop-search-store gives for its own: this document is derived entirely from the day's sealed
 * stops and nothing else writes to it, so a replacement is the right semantics — a re-run after
 * a heal must drop a delivery the heal removed, which a merge would keep for ever. (CLAUDE.md:
 * never blind-write a document you do not own. This collection is owned outright, here.)
 */
export async function writePaceDigest(
  tenant: string, date: string, stops: any[],
  io: { setDoc: (path: string, data: any) => Promise<any> } = { setDoc },
  nowIso: string = new Date().toISOString(),
): Promise<{ delivered: number; timed: number; untimed: number; routes: number; bytes: number }> {
  if (!isDateStr(date)) throw new Error(`pace digest: not a day id: ${date}`);
  const doc = buildPaceDigest(stops, { tenant, date, source: 'sealed', builtAt: nowIso });
  const bytes = JSON.stringify(doc).length;
  if (bytes > PACE_DIGEST_MAX_BYTES) {
    throw new Error(`pace digest for ${date} is ${bytes} bytes — over the ${PACE_DIGEST_MAX_BYTES}-byte ceiling; not written`);
  }
  await io.setDoc(paceDigestPath(tenant, date), doc);
  return { delivered: doc.delivered, timed: doc.timed, untimed: doc.untimed, routes: doc.routes.length, bytes };
}

/** The post-seal hook. Signature matches history-postseal's HOOKS: (tenant, date, stops). */
export async function updateStopPaceForDay(tenant: string, date: string, stops: any[]): Promise<any> {
  if (!stopPaceEnabled()) return { skipped: 'STOP_PACE=off' };
  return writePaceDigest(tenant, date, stops);
}

// ── reading ───────────────────────────────────────────────────────────────────

async function inBatches<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/**
 * The digests within [from, to], read a calendar month at a time (four months in parallel) and
 * projected to `fields`. A range query on one field — Firestore's automatic single-field index
 * serves it, so there is no composite index to deploy (this repo cannot deploy one from a pull
 * request). Only this tenant's documents, each once, oldest first.
 */
export async function readPaceDays(
  tenant: string, from: string, to: string, fields: string[] = PACE_SUMMARY_FIELDS,
  io: { runQuery: (q: any) => Promise<any[]> } = { runQuery },
): Promise<any[]> {
  if (!isDateStr(from) || !isDateStr(to) || from > to) return [];
  const pages = await inBatches(monthWindows(from, to), 4, (w) => io.runQuery(dateRangeQuery(PACE_COLLECTION, w.from, w.to, fields)));
  const seen = new Set<string>();
  const out: any[] = [];
  for (const d of pages.flat()) {
    const id = String(d?._id ?? '');
    if (!id.startsWith(`${tenant}__`) || seen.has(id)) continue;
    const date = String(d?.date ?? '');
    if (!isDateStr(date) || date < from || date > to) continue;
    seen.add(id);
    const { _id, ...rest } = d;
    out.push(rest);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** One day's whole digest (curve and route rows included), or null when none was written. */
export async function readPaceDigest(
  tenant: string, date: string,
  io: { getDoc: (path: string) => Promise<any> } = { getDoc },
): Promise<any | null> {
  if (!isDateStr(date)) return null;
  const d = await io.getDoc(paceDigestPath(tenant, date));
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
}

/** The dates that HAVE a digest within [from, to] — what the rebuild's plan needs. */
export async function readPaceDates(
  tenant: string, from: string | null, to: string | null,
  io: { runQuery: (q: any) => Promise<any[]> } = { runQuery },
): Promise<string[]> {
  const docs = await io.runQuery(dateRangeQuery(PACE_COLLECTION, from, to, ['tenant', 'date']));
  return [...new Set((docs || [])
    .filter((d) => String(d?._id ?? '').startsWith(`${tenant}__`) && isDateStr(String(d?.date ?? '')))
    .map((d) => String(d.date)))].sort();
}
