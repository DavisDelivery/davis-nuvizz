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
// reserved __…__ pattern. Route names are human strings — a co-driver load is named
// with a slash ("COLIN/DJ 1", two drivers on one truck), which made the routes doc
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
export async function listStops(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/stops`);
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
async function upsertAll<T>(items: T[], pathFn: (item: T) => string, conc = 12): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      await setDoc(pathFn(item), item as any);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker));
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
