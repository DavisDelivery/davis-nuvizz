// lib/history-store.mts
//
// Thin Firestore access layer for the immutable history warehouse. It reuses the
// proven SA-JWT auth + value codecs from firestore.mts (getDoc/setDoc/listDocs are
// now exported there) so NONE of the service-account / token-cache logic is
// duplicated. This module only knows warehouse PATHS and bounded-concurrency
// upserts — it never prunes, mirroring the immutability invariant.
//
// Layout (date-partitioned, list-friendly — the same pattern nuvizz_stop_index uses):
//   history_days/{tenant}__{YYYY-MM-DD}                       ← manifest (written LAST)
//   history_days/{tenant}__{YYYY-MM-DD}/stops/{stopNbr}
//   history_days/{tenant}__{YYYY-MM-DD}/routes/{loadNbr}
//   history_days/{tenant}__{YYYY-MM-DD}/drivers/{driverKey}
//   history_days/{tenant}__{YYYY-MM-DD}/captures/v{n}         ← append-only audit
//   history_driver_days/{tenant}__{driverKey}/days/{YYYY-MM-DD} ← cross-day pointer

import { getDoc, setDoc, listDocs } from './firestore.mts';

export const HISTORY_COLLECTION = 'history_days';
export const DRIVER_DAYS_COLLECTION = 'history_driver_days';

export function dayId(tenant: string, date: string): string {
  return `${tenant}__${date}`;
}

// PURE: make a human string safe as a Firestore document id. Firestore ids cannot
// contain '/' or '\', cannot be '.' or '..', cannot be empty, and cannot match the
// A SLASH IN A LOAD NAME IS NOT A CO-DRIVER. Four comments in this repo used to say it was
// ("two drivers on one truck"). Chad, asked directly: "Colin/dj1 is Colin's second load
// usually but always Colin never dj." It is one man's second load, and the second name is
// not a person — reading it as one splits a driver in two everywhere identity is keyed on
// the name. See canonicalDriver in src/lib/driver-territory.js for the rule that follows.
// reserved __…__ pattern. Route names are human strings — and some are named with a
// slash ("COLIN/DJ 1"), which made the routes doc
// path an INVALID reference, so upsertRoutes threw and the whole day's capture aborted
// AFTER the stops were written but BEFORE routes/rollup/seal — silently orphaning every
// day that load ran (the COLIN/DJ 1 missing-day family: 2026-06-24/25, 07-01/02/07/10).
// The raw name is preserved as a field ON the doc; only the KEY is sanitized. Idempotent
// for already-safe ids, so existing clean route/driver docs keep their exact key.
// Exported + unit-tested.
export function histDocId(raw: string): string {
  let s = String(raw ?? '').replace(/[/\\]/g, '_');   // path separators → underscore
  if (s === '' || s === '.' || s === '..') return `id_${s.length}`; // → id_0 / id_1 / id_2
  if (/^__.*__$/.test(s)) s = `x${s}`;                // dodge Firestore's reserved __…__ ids
  return s.length > 1400 ? s.slice(0, 1400) : s;      // stay well under the 1500-byte cap
}

const MANIFEST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// PURE: the captured dates a manifest listing exposes — the exact set every
// date-lister (reference miner, replay, nightly engine) keys off. A day is
// "captured" iff its manifest doc exists at history_days/{tenant}__{date}; a
// healed manifest is an ordinary manifest doc, so healing a day makes it appear
// here automatically. Exported so that contract is unit-testable.
export function capturedDatesFromManifests(manifestDocs: any[], tenant: string): string[] {
  return (manifestDocs || [])
    .map((m) => String(m?._id || ''))
    .filter((id) => id.startsWith(`${tenant}__`))
    .map((id) => id.slice(tenant.length + 2))
    .filter((d) => MANIFEST_DATE_RE.test(d))
    .sort();
}
export function dayPath(tenant: string, date: string): string {
  return `${HISTORY_COLLECTION}/${dayId(tenant, date)}`;
}

// ── manifest ─────────────────────────────────────────────────────────────────
export async function getManifest(tenant: string, date: string): Promise<any | null> {
  return getDoc(dayPath(tenant, date));
}
export async function setManifest(tenant: string, date: string, manifest: any): Promise<void> {
  await setDoc(dayPath(tenant, date), manifest);
}

// ── captures (append-only lineage) ───────────────────────────────────────────
export async function listCaptures(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/captures`);
}
export async function appendCapture(tenant: string, date: string, version: number, audit: any): Promise<void> {
  await setDoc(`${dayPath(tenant, date)}/captures/v${version}`, audit);
}

// ── subcollection reads (used for verify-by-readback) ────────────────────────
/** A sealed day's stops. `mask` is ADDITIVE and optional — existing callers (verify-by-
 *  readback, the reference miner) still get the whole record. The customer day view passes
 *  one because it sweeps a whole day to keep six rows, and the unmasked record carries the
 *  raw NuVizz object: ~5KB × 700 stops × every day in the window, to read a driver name. */
export async function listStops(tenant: string, date: string, opts?: { mask?: string[] }): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/stops`, opts?.mask?.length ? { mask: opts.mask } : undefined);
}
// PURE: the ordered doc-id candidates to try for a stop/pro number. The stop doc id is
// histDocId(stopNbr); numeric ids are stored as-is, but a padded/unpadded mismatch is
// possible across captures, so we try the raw id first and then the zero-padded-to-9
// form NuVizz uses for numeric PROs (skipped when it equals the raw id, e.g. an already
// 9-digit PRO). Empty/whitespace → no candidates. Exported + unit-tested.
export function stopDocIdCandidates(stopNbr: string): string[] {
  const raw = String(stopNbr ?? '').trim();
  if (!raw) return [];
  const ids = [histDocId(raw)];
  if (/^[0-9]+$/.test(raw)) { const padded = histDocId(raw.padStart(9, '0')); if (padded !== ids[0]) ids.push(padded); }
  return ids;
}

// Single archived stop by pro/stop number — the full immutable NormalizedStop the
// customer-history lookup renders (route, driver, delivery ticket, line items). getDoc
// returns null on 404, so a miss (uncaptured / older-than-retention day / id drift) is a
// clean null the caller falls back on — never a throw. Firestore only: ZERO NuVizz calls.
// getDoc is injectable so the raw-then-padded fallback is unit-testable without Firestore.
export async function getStop(
  tenant: string, date: string, stopNbr: string,
  io: { getDoc: (path: string) => Promise<any | null> } = { getDoc },
): Promise<any | null> {
  const base = dayPath(tenant, date);
  for (const id of stopDocIdCandidates(stopNbr)) {
    const doc = await io.getDoc(`${base}/stops/${id}`);
    if (doc) return doc;
  }
  return null;
}
export async function listRoutes(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/routes`);
}
export async function listDrivers(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/drivers`);
}

// ── bounded-concurrency upserts (UPSERT only — never delete) ──────────────────
// A WRITE THAT FIRESTORE PUSHED BACK IS RETRIED, NOT DROPPED. Three days of history — Sep 10, Sep 11
// and Sep 24, 2026 — were lost the same way: the nightly capture fired ~900 stop writes twelve at a
// time at 02:01 ET, Firestore answered "429 This database has exceeded their maximum bandwidth for
// writes, please retry with exponential backoff", and the loop threw on the first one. Half a day's
// stops were on disk, no manifest was sealed, and the backtest list simply skipped the day. Firestore
// SAYS what to do in the message. So: a 429, a 5xx or a network failure waits and tries again
// (0.5 s, 1 s, 2 s, 4 s, 8 s, ±25%), and after the first push-back the writers drop from twelve to
// four so the retry is not the same storm. A 4xx that is not 429 (a bad path, no permission) is
// still thrown at once: retrying a refusal is not persistence, it is noise.
export const WRITE_RETRIES = 5;
export const WRITE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
export function transientWriteError(e: any): boolean {
  const msg = String(e?.message || e || '');
  const m = msg.match(/failed: (\d{3})\b/);
  if (m) { const code = Number(m[1]); return code === 429 || (code >= 500 && code <= 599); }
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted/i.test(msg);
}
export function backoffMs(attempt: number, rnd = Math.random()): number {
  const base = WRITE_BACKOFF_MS[Math.min(attempt, WRITE_BACKOFF_MS.length - 1)];
  return Math.round(base * (0.75 + rnd * 0.5));
}
export interface UpsertDeps { setDoc: (path: string, data: any) => Promise<any>; sleep: (ms: number) => Promise<void> }
const LIVE_DEPS: UpsertDeps = { setDoc, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function upsertAll<T>(items: T[], pathFn: (item: T) => string, conc = 12, deps: UpsertDeps = LIVE_DEPS): Promise<{ written: number; retries: number; pushedBack: boolean }> {
  let i = 0, retries = 0, pushedBack = false, written = 0;
  const writeOne = async (path: string, item: T) => {
    for (let attempt = 0; ; attempt++) {
      try { await deps.setDoc(path, item as any); written++; return; }
      catch (e: any) {
        if (!transientWriteError(e) || attempt >= WRITE_RETRIES) throw e;
        pushedBack = true; retries++;
        await deps.sleep(backoffMs(attempt));
      }
    }
  };
  const worker = async (slot: number) => {
    while (i < items.length) {
      // After a push-back, only the first four workers keep going; the rest step out at the next item.
      if (pushedBack && slot >= 4) return;
      const item = items[i++];
      await writeOne(pathFn(item), item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, (_, slot) => worker(slot)));
  // Anything the retired workers left behind is finished by the four that stayed.
  while (i < items.length) { const item = items[i++]; await writeOne(pathFn(item), item); }
  return { written, retries, pushedBack };
}

export async function upsertStops(tenant: string, date: string, records: any[]): Promise<void> {
  const base = dayPath(tenant, date);
  // stopNbr is normally numeric (path-safe), but it flows straight from the vendor
  // payload — a non-numeric/slashed value would throw here and abort the WHOLE
  // night before the seal (the last pre-seal id #450 left raw). histDocId is a
  // no-op for numeric ids, so existing stop docs keep their exact key.
  await upsertAll(records, (r) => `${base}/stops/${histDocId(String(r.stopNbr))}`);
}
export async function upsertRoutes(tenant: string, date: string, records: any[]): Promise<void> {
  const base = dayPath(tenant, date);
  await upsertAll(records, (r) => `${base}/routes/${histDocId(r.loadNbr)}`);
}
export async function upsertDrivers(tenant: string, date: string, records: any[]): Promise<void> {
  const base = dayPath(tenant, date);
  await upsertAll(records, (r) => `${base}/drivers/${histDocId(r.driverKey)}`);
}

// Cross-day driver index — listing history_driver_days/{tenant}__{driverKey}/days
// yields a driver's whole history cheaply (loads-by-driver without scanning days).
// driverKey rides a PATH SEGMENT here, so it gets the same sanitization (a userName
// with a '/' would break this doc path exactly like the route ids). Write + read use
// histDocId so they stay consistent.
export async function upsertDriverDayPointer(tenant: string, driverKey: string, date: string, ptr: any): Promise<void> {
  await setDoc(`${DRIVER_DAYS_COLLECTION}/${tenant}__${histDocId(driverKey)}/days/${date}`, ptr);
}
export async function listDriverDays(tenant: string, driverKey: string): Promise<any[]> {
  return listDocs(`${DRIVER_DAYS_COLLECTION}/${tenant}__${histDocId(driverKey)}/days`);
}
