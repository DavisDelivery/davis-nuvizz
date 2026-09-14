// lib/order-arrivals-store.mts
//
// ── WHERE THE ARRIVAL CURVES LIVE ────────────────────────────────────────────
//
// The rules are all in src/lib/order-arrivals.js (pure). This file is the only place that
// knows a collection name, reads the stop index, or writes a sealed night.
//
// ZERO NuVizz. Every import here is Firestore or pure. The curve is built from `enriched_at`,
// which the scan already stamped on every stop the first time it saw it — so a sealed night
// costs Firestore reads and nothing else, and the whole history can be BACKFILLED from days
// that were indexed long before this feature existed.
//
// WHY THE NIGHT IS SEALED INTO ITS OWN DOCUMENT instead of recomputed on read. The baseline is
// six same-weekday nights; recomputing it would list ~700 stop documents per night on every
// card load — four thousand reads to draw one line. A sealed night is ~200 numbers. The live
// day is the only one ever built from stops.

import { isFirestoreEnabled, getDoc, setDoc, readStops, listDocs } from './firestore.mts';
import { buildCurve, buildBaseline, sealedDoc, sameWeekdayDates } from '../../../src/lib/order-arrivals.js';

export const ARRIVALS_COLLECTION = 'order_arrival_days';
export const TENANT = 'davis';

/** The Uline discriminator this repo already uses: a distinct 9-digit PRO on the Davis lane
 *  (uline-manifest.mts PRO_RE). NOT `source` — on the list path that field is the literal
 *  'nuvizz-list' provenance tag, and it is LIVE, so the list value overwrites any origin
 *  company every scan. A count filtered on `source === 'ULINE'` would read zero for ever. */
export const ULINE_PRO_RE = /^\d{9}$/;

/**
 * Only the fields a curve needs — plus `stopNbr`, WHICH IS LOAD-BEARING AND NOT FURNITURE.
 *
 * A Firestore masked read returns a document with NO `fields` key when the document carries
 * none of the masked paths, and docToObject returns null for that, so listDocs SKIPS it. Mask
 * on `enriched_at` alone and every stop WITHOUT an arrival stamp silently disappears from the
 * list: `total` counts only the stamped ones, `unstamped` is zero, and coverage reads 100% on
 * a board where a third of the freight has no stamp at all. That would disarm the one guard
 * this whole feature's honesty rests on — the screen would project confidently off a third of
 * the night and look exactly like a good reading.
 *
 * `stopNbr` is on EVERY indexed stop by construction (writeStops keys the document on it and
 * LIVE_LIST_FIELDS pins it to the list value), so including it guarantees no real stop is ever
 * fields-less, and the unstamped ones are counted as what they are.
 */
export const ARRIVAL_MASK = ['stopNbr', 'enriched_at', 'primaryPro', 'pro'];

export const sealedPath = (tenant: string, date: string): string =>
  `${ARRIVALS_COLLECTION}/${String(tenant || '').toLowerCase()}__${date}`;

/** Default ON; an explicit off-word turns it off; anything malformed leaves it ON. A typo in
 *  an env var must never silently stop the sealing — a feature that quietly stopped recording
 *  looks exactly like a working one until the day somebody needs the history. */
export function arrivalsEnabled(env: any = process.env): boolean {
  const v = String(env?.ORDER_ARRIVALS_ENABLED ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

function isUlineStop(s: any): boolean {
  const pro = String(s?.primaryPro ?? s?.pro ?? '').trim();
  return ULINE_PRO_RE.test(pro);
}

/**
 * Build both curves for one delivery date straight from the stop index.
 *
 * `all` is every order on that board; `uline` is the 9-digit-PRO subset. Both are kept because
 * they answer different questions and the difference between them is itself worth seeing — a
 * night where the Uline share moves is a night somebody changed what we are hauling.
 */
export async function curvesForDate(tenant: string, date: string): Promise<{
  all: any; uline: any; meta: any;
} | null> {
  if (!isFirestoreEnabled()) return null;
  const { meta, stops } = await readStops(tenant, date, { mask: ARRIVAL_MASK });
  const list = Array.isArray(stops) ? stops : [];
  return {
    all: buildCurve({ stops: list, deliveryDate: date }),
    uline: buildCurve({ stops: list.filter(isUlineStop), deliveryDate: date }),
    meta: meta ?? null,
  };
}

export async function readSealed(tenant: string, date: string): Promise<any | null> {
  if (!isFirestoreEnabled()) return null;
  return getDoc(sealedPath(tenant, date)).catch(() => null);
}

/** Seal one night. Returns the document written, or a reason it was not. */
export async function sealDate(tenant: string, date: string, atISO: string): Promise<any> {
  const curves = await curvesForDate(tenant, date);
  if (!curves) return { date, ok: false, reason: 'Firestore off' };
  // A day with NO stops indexed is not a quiet night — it is a day nothing was captured for,
  // and sealing it as zero would drag every baseline it later joins. Refused, and said so.
  if (!curves.all.total) return { date, ok: false, reason: 'no stops indexed for this date' };
  const doc = {
    tenant, date, dow: curves.all.dow, sealedAt: atISO,
    all: sealedDoc(curves.all, { sealedAt: atISO }),
    uline: sealedDoc(curves.uline, { sealedAt: atISO }),
  };
  await setDoc(sealedPath(tenant, date), doc);
  return { date, ok: true, total: curves.all.total, stamped: curves.all.stamped, uline: curves.uline.total };
}

/**
 * The same-weekday baseline for a date, from sealed nights only.
 *
 * Reads are issued for every candidate date and the misses are simply absent — a Tuesday that
 * was never sealed (a holiday, a capture failure) narrows the baseline rather than breaking
 * it, and `n` on the way out says how narrow it got.
 */
export async function baselineFor(tenant: string, date: string, weeks = 6, which: 'all' | 'uline' = 'all'): Promise<any> {
  if (!isFirestoreEnabled()) return buildBaseline([]);
  const dates = sameWeekdayDates(date, weeks);
  const docs = await Promise.all(dates.map((d) => readSealed(tenant, d)));
  const curves = docs.map((d) => (d ? d[which] : null)).filter(Boolean);
  return buildBaseline(curves);
}

/** Every sealed night on file, newest first — the coverage answer for the diagnostics strip. */
export async function listSealed(tenant: string, limit = 60): Promise<any[]> {
  if (!isFirestoreEnabled()) return [];
  const docs = await listDocs(ARRIVALS_COLLECTION, { mask: ['date', 'dow', 'sealedAt', 'all.total', 'all.stamped', 'all.coverage', 'uline.total'] }).catch(() => []);
  return (Array.isArray(docs) ? docs : [])
    .filter((d: any) => String(d?.date || '').startsWith('20') && String(d?._id || '').startsWith(`${String(tenant).toLowerCase()}__`))
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit);
}
