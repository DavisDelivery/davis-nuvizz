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
//
// Every write retried here is a whole-document PATCH of the same bytes to the same path, so a
// retry of a write that DID land (its answer was lost) writes the same document again — safe.
export const WRITE_RETRIES = 5;
export const WRITE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
/** Writers still at work once Firestore has pushed back in this run. */
export const PUSHED_BACK_WRITERS = 4;

// THE WAY BACK: HISTORY_WRITE_RETRY. House shape — on unless it says off/0/false/no, and anything
// malformed leaves it ON (a typo must never quietly put the Sep 24 failure back). Off puts back
// the capture's writes exactly as they were before #1030: one attempt per document, twelve writers
// the whole way, every driver-day pointer fired at once, one attempt at the manifest and one at the
// failure record, and no retry counts on the manifest, the lineage or the failure text. It covers
// EVERY side of the retry at once — upsertAll, the pointers, the seal, the lineage and the failure
// record all read the same budget, and the budget reads the switch.
export function historyWriteRetryEnabled(env: any = process.env): boolean {
  const v = String(env?.HISTORY_WRITE_RETRY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

// ONE CLASSIFIER for every retried history write: upsertAll's writers, the seal and the lineage
// (withWriteRetry below) and the failure record all ask this one function, and nothing else in
// the app calls it. (The post-seal derivations, their outcome field and the failure-record clear
// are not retried at all — see history-core.) The stall rule (a request that hit fsFetch's 20 s
// deadline) is #1043's (firestore-history-address-5, v1.81.2), kept exactly as it landed. It only
// ever acts through the retry loop that asks it, so HISTORY_WRITE_RETRY=off (one attempt, no
// loop) turns it off with the rest of the retry.
export function transientWriteError(e: any): boolean {
  const msg = String(e?.message || e || '');
  const m = msg.match(/failed: (\d{3})\b/);
  if (m) { const code = Number(m[1]); return code === 429 || (code >= 500 && code <= 599); }
  // firestore-history-address-5: fsFetch's own 20s deadline rejects with a TimeoutError
  // ("no answer within Nms") — a stall, not a refusal, so it is retried like a dropped socket.
  if (e?.name === 'TimeoutError') return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted|no answer within/i.test(msg);
}
export function backoffMs(attempt: number, rnd = Math.random()): number {
  const base = WRITE_BACKOFF_MS[Math.min(attempt, WRITE_BACKOFF_MS.length - 1)];
  return Math.round(base * (0.75 + rnd * 0.5));
}

// A RUN-WIDE DEADLINE ON RETRYING. Each document gets up to five retries and the backoff starts
// again for every document, so on a night Firestore keeps pushing back the sleeps add up with no
// ceiling: in the audit's simulator (900 stops, 80 ms per answer) every stop refused three times
// is ~14 minutes of waiting across four writers, four times ~29. The function's own header
// (nuvizz-history-snapshot-background.mts) says Netlify gives a -background function 15 minutes;
// the site's real limit cannot be read from this code. A process the platform kills never
// reaches the catch that writes the failure record — the day would show "missing" with no
// reason, a quieter version of the Sep 10/11/24 loss. So retrying stops at TEN minutes from the
// start of the run, the capture throws an error that says how many retries it spent, and
// whatever time the function has left goes to the failure record (which retries on its own,
// bounded, past this line). A first attempt is never refused by the deadline — only a retry is.
export const WRITE_RETRY_DEADLINE_MS = 10 * 60 * 1000;

/** One run's retry state, shared by every write the run retries: the stops, routes, drivers and
 *  driver-day pointers, the seal and the capture lineage (the failure record keeps a budget of its
 *  own; the post-seal derivations are not retried). */
export interface WriteBudget {
  enabled: boolean;      // HISTORY_WRITE_RETRY, read once for the run
  deadlineAt: number;    // epoch ms; a retry whose wait would cross it is not taken
  retries: number;       // retries taken so far this run, across every writer
  pushedBack: boolean;   // Firestore pushed back at least once this run
}
export function newWriteBudget(opts: { deadlineAt?: number; startedAt?: number; deadlineMs?: number; env?: any } = {}): WriteBudget {
  const ms = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : WRITE_RETRY_DEADLINE_MS;
  const start = typeof opts.startedAt === 'number' && Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  const deadlineAt = typeof opts.deadlineAt === 'number' && Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : start + ms;
  return { enabled: historyWriteRetryEnabled(opts.env ?? process.env), deadlineAt, retries: 0, pushedBack: false };
}
/** The sentence that goes at the FRONT of a failure text, so the 500-character cap on the
 *  failure record can never cut it off. */
export function retryNote(b: WriteBudget): string {
  return `write retries this run: ${b.retries}${b.pushedBack ? ' (Firestore pushed back)' : ''}`;
}

export interface RetryDeps { sleep: (ms: number) => Promise<void>; now: () => number }
const LIVE_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One write, retried on push-back inside the run's budget. With HISTORY_WRITE_RETRY off it is
 * exactly one attempt. `ignoreDeadline` is for the failure record alone: it must still land
 * after the run's retry deadline has passed, and it is bounded by WRITE_RETRIES regardless.
 * The error thrown on giving up leads with the retry count and keeps the original text after it
 * (so "…/stops/2 failed: 429" is still in the message), with the original as `cause`.
 */
export async function withWriteRetry<T>(
  write: () => Promise<T>, budget: WriteBudget, deps: Partial<RetryDeps> = {},
  opts: { ignoreDeadline?: boolean } = {},
): Promise<T> {
  if (!budget.enabled) return write();
  const sleep = deps.sleep ?? LIVE_SLEEP;
  const now = deps.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    try { return await write(); }
    catch (e: any) {
      if (!transientWriteError(e)) throw e;
      const original = String(e?.message || e || 'write failed');
      if (attempt >= WRITE_RETRIES) {
        throw gaveUp(`gave up after ${attempt} retries on this document; ${retryNote(budget)} — ${original}`, e);
      }
      const wait = backoffMs(attempt);
      if (!opts.ignoreDeadline && now() + wait > budget.deadlineAt) {
        throw gaveUp(`stopped retrying at the run's ${Math.round(WRITE_RETRY_DEADLINE_MS / 60000)}-minute retry deadline; ${retryNote(budget)} — ${original}`, e);
      }
      budget.retries++; budget.pushedBack = true;
      await sleep(wait);
    }
  }
}
function gaveUp(message: string, cause: any): Error {
  const err: any = new Error(message);
  err.cause = cause;
  err.historyWriteGaveUp = true;
  return err;
}

export interface UpsertDeps { setDoc: (path: string, data: any) => Promise<any>; sleep: (ms: number) => Promise<void>; now?: () => number }
const LIVE_DEPS: UpsertDeps = { setDoc, sleep: LIVE_SLEEP, now: () => Date.now() };

// HISTORY_WRITE_RETRY=off — the writer exactly as it was before #1030: twelve at a time, one
// attempt each; the first error reaches the caller and the other writers write on.
async function legacyUpsertAll<T>(items: T[], pathFn: (item: T) => string, conc: number, deps: UpsertDeps) {
  let i = 0, written = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      await deps.setDoc(pathFn(item), item as any);
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker));
  return { written, retries: 0, pushedBack: false };
}

/**
 * Write every item, `conc` at a time, retrying push-back inside `budget`. The budget is the
 * run's: pass the same one to every call in a capture so the retry deadline and the drop to
 * four writers carry from the stops to the routes, drivers and pointers (a database that pushed
 * back on the stops is not asked for twelve at once again a second later). `retries` and
 * `pushedBack` in the result are THIS call's; the run's totals are on the budget.
 */
export async function upsertAll<T>(
  items: T[], pathFn: (item: T) => string, conc = 12, deps: UpsertDeps = LIVE_DEPS,
  budget: WriteBudget = newWriteBudget(),
): Promise<{ written: number; retries: number; pushedBack: boolean }> {
  if (!budget.enabled) return legacyUpsertAll(items, pathFn, conc, deps);
  const before = budget.retries;
  let i = 0, written = 0;
  // FOUR IN FLIGHT MEANS FOUR IN FLIGHT. Retiring the writers above slot four (below) is not
  // enough on its own: a writer in slot five that was the one pushed back keeps retrying its own
  // document beside the four that stay, so five or more were in flight after the push-back — it
  // was measured. Once the budget says pushed back, every attempt (first or retry) waits for one
  // of four places, and the ones still in flight from before count against them.
  let active = 0;
  const waiting: Array<() => void> = [];
  const gatedSetDoc = async (path: string, item: T) => {
    while (budget.pushedBack && active >= PUSHED_BACK_WRITERS) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await deps.setDoc(path, item as any); }
    finally { active--; const next = waiting.shift(); if (next) next(); }
  };
  const writeOne = async (item: T) => {
    const path = pathFn(item);
    await withWriteRetry(() => gatedSetDoc(path, item), budget, deps);
    written++;
  };
  // ONE DOCUMENT FAILING FOR GOOD DOES NOT CALL THE OTHER WRITERS OFF. The first error still
  // reaches the caller at once (Promise.all), and the capture records the failure. Promise.all
  // cancels nothing, so the writers already at work go on with their documents, exactly as #1030
  // and the loop before it did — but nothing awaits them any more, so they keep writing only while
  // the function is still running. Whether Netlify keeps the process alive after the handler
  // returns cannot be told from this code. Any stop they do save at nightly time is one a later
  // re-capture does not have to fill in (lib/history-recapture.mts). The retrying stays bounded
  // without an early stop: past the run's deadline each writer ends at its own first push-back.
  const worker = async (slot: number) => {
    while (i < items.length) {
      // After a push-back, only the first four workers keep going; the rest step out at the next item.
      if (budget.pushedBack && slot >= PUSHED_BACK_WRITERS) return;
      const item = items[i++];
      await writeOne(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, (_, slot) => worker(slot)));
  // Anything the retired workers left behind is finished by the four that stayed.
  while (i < items.length) { const item = items[i++]; await writeOne(item); }
  const retries = budget.retries - before;
  return { written, retries, pushedBack: retries > 0 };
}

export type UpsertResult = { written: number; retries: number; pushedBack: boolean };

export async function upsertStops(tenant: string, date: string, records: any[], budget?: WriteBudget): Promise<UpsertResult> {
  const base = dayPath(tenant, date);
  // stopNbr is normally numeric (path-safe), but it flows straight from the vendor
  // payload — a non-numeric/slashed value would throw here and abort the WHOLE
  // night before the seal (the last pre-seal id #450 left raw). histDocId is a
  // no-op for numeric ids, so existing stop docs keep their exact key.
  return upsertAll(records, (r) => `${base}/stops/${histDocId(String(r.stopNbr))}`, 12, LIVE_DEPS, budget ?? newWriteBudget());
}
export async function upsertRoutes(tenant: string, date: string, records: any[], budget?: WriteBudget): Promise<UpsertResult> {
  const base = dayPath(tenant, date);
  return upsertAll(records, (r) => `${base}/routes/${histDocId(r.loadNbr)}`, 12, LIVE_DEPS, budget ?? newWriteBudget());
}
export async function upsertDrivers(tenant: string, date: string, records: any[], budget?: WriteBudget): Promise<UpsertResult> {
  const base = dayPath(tenant, date);
  return upsertAll(records, (r) => `${base}/drivers/${histDocId(r.driverKey)}`, 12, LIVE_DEPS, budget ?? newWriteBudget());
}

// Cross-day driver index — listing history_driver_days/{tenant}__{driverKey}/days
// yields a driver's whole history cheaply (loads-by-driver without scanning days).
// driverKey rides a PATH SEGMENT here, so it gets the same sanitization (a userName
// with a '/' would break this doc path exactly like the route ids). Write + read use
// histDocId so they stay consistent.
export function driverDayPointerPath(tenant: string, driverKey: string, date: string): string {
  return `${DRIVER_DAYS_COLLECTION}/${tenant}__${histDocId(driverKey)}/days/${date}`;
}
export async function upsertDriverDayPointer(tenant: string, driverKey: string, date: string, ptr: any): Promise<void> {
  await setDoc(driverDayPointerPath(tenant, driverKey, date), ptr);
}
/**
 * Every driver-day pointer for one captured day. These used to go out all at once — ~52 bare
 * PATCHes with no retry, fired a moment after the database had been pushing back on the stops —
 * so a 429 here failed the night at stage 'upsert' one step after the retried writes. They now
 * go through the same bounded, retried writer as the stops. Each pointer doc carries its own
 * driverKey, which names its path. HISTORY_WRITE_RETRY=off: all at once, one attempt, as before.
 */
export async function upsertDriverDayPointers(
  tenant: string, date: string, ptrs: any[], budget: WriteBudget = newWriteBudget(), deps: UpsertDeps = LIVE_DEPS,
): Promise<UpsertResult> {
  const pathOf = (p: any) => driverDayPointerPath(tenant, p?.driverKey, date);
  if (!budget.enabled) {
    await Promise.all(ptrs.map((p) => deps.setDoc(pathOf(p), p)));
    return { written: ptrs.length, retries: 0, pushedBack: false };
  }
  return upsertAll(ptrs, pathOf, 12, deps, budget);
}
export async function listDriverDays(tenant: string, driverKey: string): Promise<any[]> {
  return listDocs(`${DRIVER_DAYS_COLLECTION}/${tenant}__${histDocId(driverKey)}/days`);
}
