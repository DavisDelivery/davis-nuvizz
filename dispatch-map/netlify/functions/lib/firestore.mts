// lib/firestore.mts
//
// Firestore REST client for the davismarginiq project. Ported from the parent
// app's netlify/functions/lib/firestore.cjs (the proven pattern: the scheduled
// background scan WRITES stop docs, the user-facing read function READS them).
//
// Auth: service-account JSON in env var FIREBASE_SA (same SA the parent uses).
// Access tokens are cached in-memory across warm invocations.
//
// REQUIRED: FIREBASE_SA must be set in THIS Netlify site's environment
// (dd-dispatch-map) for the index to work — it is separate from the parent
// site. When absent, isFirestoreEnabled() is false and callers degrade safely.
//
// Schema (nuvizz_stop_index):
//   nuvizz_stop_index/{tenant}__{date}              ← meta doc: last_scanned_at, counts
//   nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr} ← one doc per normalized stop
// {tenant}__{date} as the parent id mirrors the parent app's nuvizzFleet layout
// (REST API needs each path level to be a real doc; double-underscore is
// unambiguous since tenant codes have no underscore).

import crypto from 'node:crypto';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

let __token: { access_token: string; expires_at_ms: number } | null = null;
let __saCache: any = null;

function loadServiceAccount(): any {
  if (__saCache) return __saCache;
  const raw = process.env.FIREBASE_SA;
  if (!raw) throw new Error('FIREBASE_SA env var not set');
  __saCache = JSON.parse(raw);
  return __saCache;
}

export function isFirestoreEnabled(): boolean {
  return !!process.env.FIREBASE_SA;
}

function base64UrlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(): Promise<string> {
  if (__token && Date.now() < __token.expires_at_ms - 60_000) return __token.access_token;

  const sa = loadServiceAccount();
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sigB64 = signer.sign(sa.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${unsigned}.${sigB64}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const tok: any = await resp.json();
  __token = { access_token: tok.access_token, expires_at_ms: Date.now() + (tok.expires_in - 60) * 1000 };
  return __token.access_token;
}

function toFirestoreValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    const fields: any = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) fields[k] = toFirestoreValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFirestoreValue(v: any): any {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const out: any = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFirestoreValue(val);
    return out;
  }
  return null;
}

function docToObject(doc: any): any {
  if (!doc || !doc.fields) return null;
  const out: any = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fromFirestoreValue(v);
  return out;
}

function objectToFields(obj: any): any {
  const fields: any = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = toFirestoreValue(v);
  return fields;
}

// Exported (export-only, behavior-preserving) so the immutable history warehouse
// (lib/history-store.mts) can reuse the same SA-JWT auth + value codecs instead
// of duplicating the token/cache logic. The live-cache helpers below are unchanged.
export async function getDoc(path: string): Promise<any | null> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return docToObject(await resp.json());
}

export async function setDoc(path: string, data: any): Promise<boolean> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objectToFields(data) }),
  });
  if (!resp.ok) throw new Error(`setDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return true;
}

export async function listDocs(collectionPath: string): Promise<any[]> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const all: any[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${collectionPath}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`listDocs ${collectionPath} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const body: any = await resp.json();
    for (const d of body.documents || []) {
      const parts = (d.name || '').split('/');
      const obj = docToObject(d);
      if (obj) all.push({ _id: parts[parts.length - 1], ...obj });
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return all;
}

// Delete a single document (used to prune stops that disappeared between scans).
async function deleteDoc(path: string): Promise<void> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`deleteDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
}

// ── nuvizz_stop_index helpers ────────────────────────────────────────────────
const COLLECTION = 'nuvizz_stop_index';
function parentId(tenant: string, dateStr: string): string {
  return `${tenant}__${dateStr}`;
}

export interface StopIndexMeta {
  tenant: string;
  date: string;
  last_scanned_at: string;
  count: number;
  plannedCount: number;
  unplannedCount: number;
  // Per-feed scan times — loads and orders run on different cadences now, so a
  // single stamp would mislead. UTC instants; the UI shows them split.
  lastLoadScanAt?: string | null;
  lastUnplannedScanAt?: string | null;
  // Set when a scan cycle is SUPPRESSED (daily ceiling reached or kill switch),
  // so the UI can show an honest banner instead of silent staleness. Cleared on
  // the next successful scan.
  scanState?: { halted: boolean; reason: 'ceiling' | 'killswitch'; since: string } | null;
}

// Decide whether an EXISTING stop (not re-scanned this run) should be PRESERVED
// rather than pruned. Pure + exported for tests. Preserve when:
//  • the unplanned feed was skipped and this is an unplanned (status-10) stop, or
//  • the load feed was skipped and this is a planned stop, or
//  • partialLoads (Phase 2 lean): only a SUBSET of loads was re-pulled this cycle
//    (terminal loads deliberately skipped) → keep planned stops we didn't re-scan
//    so terminal-skip never deletes already-delivered stops.
export function preserveStopOnWrite(
  stop: { isPlanned?: boolean },
  opts: { includeUnplanned: boolean; includeLoads: boolean; partialLoads?: boolean; partialUnplanned?: boolean },
): boolean {
  if (!opts.includeUnplanned && stop.isPlanned === false) return true;
  if (!opts.includeLoads && stop.isPlanned === true) return true;
  if (opts.partialLoads && stop.isPlanned === true) return true;
  // Phase 3 lean: the unplanned descent only re-probed NEW stop numbers above the
  // last high-water, so older still-unplanned orders weren't re-scanned → preserve
  // them instead of pruning (mirrors partialLoads for the planned side).
  if (opts.partialUnplanned && stop.isPlanned === false) return true;
  return false;
}

// Write a full day's normalized stops. Each stop doc is keyed by stopNbr and
// carries isPlanned + last_scanned_at + the full normalized shape (incl. raw).
// Stops that vanished since the previous scan are pruned so cancelled/replanned
// orders don't linger. Returns the meta record written.
export async function writeStops(
  tenant: string,
  dateStr: string,
  stops: any[],
  scannedAt: string,
  opts: { includeUnplanned?: boolean; includeLoads?: boolean; partialLoads?: boolean; partialUnplanned?: boolean } = {},
): Promise<StopIndexMeta> {
  const includeUnplanned = opts.includeUnplanned !== false; // default true (full scan)
  const includeLoads = opts.includeLoads !== false;         // default true
  const partialLoads = opts.partialLoads === true;          // Phase 2 lean: only a SUBSET of loads re-pulled
  const partialUnplanned = opts.partialUnplanned === true;  // Phase 3 lean: only NEW stop numbers re-probed
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const withNbr = stops.filter((s) => s && s.stopNbr);
  const nextNbrs = new Set(withNbr.map((s) => String(s.stopNbr)));

  const [existing, prevMeta] = await Promise.all([
    listDocs(`${base}/stops`),
    getDoc(base) as Promise<StopIndexMeta | null>,
  ]);

  // PRESERVE-ON-SKIP: a partial run must NOT wipe the feed it didn't scan. A
  // load-only run keeps existing status-10 orders; an unplanned-only run keeps
  // existing planned/routed stops. Docs re-scanned this run are upserted below.
  const preserved = existing.filter((d) =>
    !nextNbrs.has(String(d._id)) && preserveStopOnWrite(d, { includeUnplanned, includeLoads, partialLoads, partialUnplanned }));
  const preservedNbrs = new Set(preserved.map((d) => String(d._id)));
  await Promise.all(
    existing
      .filter((d) => !nextNbrs.has(String(d._id)) && !preservedNbrs.has(String(d._id)))
      .map((d) => deleteDoc(`${base}/stops/${d._id}`)),
  );

  // Upsert each freshly-scanned stop (bounded concurrency to stay polite).
  const conc = 12;
  let i = 0;
  const writeOne = async () => {
    while (i < withNbr.length) {
      const s = withNbr[i++];
      await setDoc(`${base}/stops/${s.stopNbr}`, { ...s, last_scanned_at: scannedAt });
    }
  };
  await Promise.all(Array.from({ length: conc }, writeOne));

  // Counts reflect the FULL index = freshly scanned + preserved (the feed we
  // didn't re-scan this run), split by planned vs unplanned.
  const freshPlanned = withNbr.filter((s) => s.isPlanned).length;
  const preservedPlanned = preserved.filter((d) => d.isPlanned === true).length;
  const count = withNbr.length + preserved.length;
  const plannedCount = freshPlanned + preservedPlanned;
  const unplannedCount = count - plannedCount;
  const meta: StopIndexMeta = {
    tenant,
    date: dateStr,
    last_scanned_at: scannedAt,
    count,
    plannedCount,
    unplannedCount,
    // Each per-feed stamp advances only when that feed actually ran; otherwise it
    // carries forward, so "Loads/Orders updated …" reflects the real last scan.
    lastLoadScanAt: includeLoads ? scannedAt : (prevMeta?.lastLoadScanAt ?? null),
    lastUnplannedScanAt: includeUnplanned ? scannedAt : (prevMeta?.lastUnplannedScanAt ?? null),
    // A successful scan clears any prior halted state (ceiling/kill switch).
    scanState: null,
  };

  // Meta doc last so a reader never sees a fresh timestamp over a half-written set.
  await setDoc(base, meta as any);
  return meta;
}

// Fix 5 — record that a scan cycle was SUPPRESSED (ceiling/kill switch) so the UI
// can banner it. Read-modify-write so we never clobber the existing counts/stamps
// (setDoc replaces the whole doc). A no-op-safe upsert when the meta is absent.
export async function markScanState(
  tenant: string,
  dateStr: string,
  state: { halted: boolean; reason: 'ceiling' | 'killswitch'; since: string } | null,
): Promise<void> {
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const prev = (await getDoc(base)) as StopIndexMeta | null;
  // Don't churn a write if nothing changed (avoids rewriting the meta every cron
  // tick while halted).
  if (prev && JSON.stringify(prev.scanState ?? null) === JSON.stringify(state ?? null)) return;
  const next = { ...(prev || { tenant, date: dateStr }), scanState: state };
  await setDoc(base, next as any);
}

export interface StopIndexRead {
  meta: StopIndexMeta | null;
  stops: any[];
}

export async function readStops(tenant: string, dateStr: string): Promise<StopIndexRead> {
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const [meta, docs] = await Promise.all([getDoc(base), listDocs(`${base}/stops`)]);
  // Strip the internal _id and last_scanned_at off each stop before returning.
  const stops = docs.map(({ _id, last_scanned_at, ...rest }) => rest);
  return { meta: (meta as StopIndexMeta) || null, stops };
}

// ── Phase 4: shared call counter + circuit breaker ───────────────────────────
// One fleet-wide accountant. nuvizz-request.mts increments calls__{date} on every
// NuVizz round-trip (both apps share this davismarginiq doc) and, when the day's
// total crosses the ceiling, trips nuvizz_ops/circuit. scanGuardOpen() honours the
// flag so a regression is throttled in minutes instead of by a vendor email.
const OPS_COLLECTION = 'nuvizz_ops';

// Route label → field-safe per-route counter key, e.g. '/load/info' → 'count__load_info'.
function routeFieldKey(route?: string | null): string | null {
  if (!route) return null;
  const k = String(route).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k ? `count__${k}` : null;
}

/**
 * Atomically add n to today's shared counter; returns the NEW total.
 *
 * The update MUST carry an updateMask scoped to the non-transform fields. Without
 * it, a commit `update` REPLACES the whole doc with just {date} on every call,
 * wiping `count` — the transform then re-creates count=1 each time and the total
 * never climbs (verified broken 2026-06-17). The mask makes the update MERGE so
 * `count` (and per-route counters) survive and accumulate.
 *
 * When `route` is given, a per-route counter (count__<route>) is incremented in
 * the SAME commit so we can see where the calls go. Total `count` stays
 * authoritative for the ceiling. Returns the new total `count`.
 */
export async function incrementCallCounter(dateStr: string, n: number, route?: string): Promise<number> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const docName = `projects/${sa.project_id}/databases/(default)/documents/${OPS_COLLECTION}/calls__${dateStr}`;
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents:commit`;
  // count is always transform[0] so transformResults[0] is the authoritative total.
  const transforms: any[] = [{ fieldPath: 'count', increment: { integerValue: String(n) } }];
  const rk = routeFieldKey(route);
  if (rk) transforms.push({ fieldPath: rk, increment: { integerValue: String(n) } });
  const body = {
    writes: [{
      update: { name: docName, fields: { date: { stringValue: dateStr } } },
      updateMask: { fieldPaths: ['date'] }, // merge `date`; preserve + increment count/count__*
      updateTransforms: transforms,
    }],
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`incrementCallCounter failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const out: any = await resp.json();
  const tr = out.writeResults?.[0]?.transformResults?.[0];
  return tr ? parseInt(tr.integerValue, 10) : NaN;
}

export async function readCallCounter(dateStr: string): Promise<number> {
  const doc = await getDoc(`${OPS_COLLECTION}/calls__${dateStr}`);
  return doc && typeof doc.count === 'number' ? doc.count : 0;
}

/** Today's total + per-route breakdown (count__* fields, route prefix stripped). */
export async function readCallStats(dateStr: string): Promise<{ count: number; byRoute: Record<string, number> }> {
  const doc = await getDoc(`${OPS_COLLECTION}/calls__${dateStr}`);
  const byRoute: Record<string, number> = {};
  if (doc) {
    for (const [k, v] of Object.entries(doc)) {
      if (k.startsWith('count__') && typeof v === 'number') byRoute[k.slice('count__'.length)] = v;
    }
  }
  return { count: doc && typeof doc.count === 'number' ? doc.count : 0, byRoute };
}

export interface CircuitState { open: boolean; reason?: string; at?: string; day?: string }

export async function readCircuit(): Promise<CircuitState> {
  const doc = await getDoc(`${OPS_COLLECTION}/circuit`);
  if (!doc) return { open: false };
  // Day-scoped (Fix 3): a flag tripped on a prior UTC day is stale — treat as
  // CLOSED so a yesterday-tripped breaker can't halt today's scans at count 0.
  const today = new Date().toISOString().slice(0, 10);
  const open = !!doc.open && doc.day === today;
  return { open, reason: doc.reason, at: doc.at, day: doc.day };
}

export async function setCircuit(open: boolean, reason: string, atISO: string): Promise<void> {
  // Stamp the UTC day of the trip so readCircuit can auto-expire it at midnight.
  await setDoc(`${OPS_COLLECTION}/circuit`, { open, reason, at: atISO, day: atISO.slice(0, 10) });
}

// ── Incremental-scan state (call-reduction work) ─────────────────────────────
// Per-date roster written after every scan, read at the start of the next: which
// loads we already know (+ whether each is fully delivered), the load-number span,
// route→load map, and the highest stop number seen. Phase 1 only POPULATES this
// (shadow mode); later phases use it to probe only known-active loads + a buffer
// instead of a wide window.
const SCAN_STATE_COLLECTION = 'scan_state';

export interface KnownLoad { loadNbr: string; routeName: string | null; allTerminal: boolean; lastSeenAt: string }
export interface ScanState {
  date: string;
  knownLoads: KnownLoad[];
  minLoadNbr: number | null;
  maxLoadNbr: number | null;
  highWaterStopNbr: number | null;          // max over ALL stops (planned + unplanned)
  highWaterUnplannedStopNbr: number | null; // max over UNPLANNED stops only — bounds the lean order descent
  routeMap: Record<string, string>;
  lastScanAt: string;
  scanCount: number;
}

export async function readScanState(dateStr: string): Promise<ScanState | null> {
  const doc = await getDoc(`${SCAN_STATE_COLLECTION}/${dateStr}`);
  return (doc as any) || null;
}

export async function writeScanState(dateStr: string, state: ScanState): Promise<void> {
  await setDoc(`${SCAN_STATE_COLLECTION}/${dateStr}`, state as any);
}

// ── Phase 4: canonical fleet index (the shape SITE A already reads) ───────────
// The sole scanner (this app) writes load summaries + aggregate + driver index to
// nuvizzFleet/{tenant}__{date} — byte-compatible with the parent app's existing
// reader (lib/firestore.cjs readSummary/listLoads/readDriverIndex) so SITE A can
// render its dashboard straight from Firestore and STOP scanning NuVizz itself.
const FLEET_COLLECTION = 'nuvizzFleet';

export interface FleetSummary {
  totalLoads: number; assignedLoads: number; unassignedLoads: number;
  totalStops: number; totalDelivered: number; totalInProgress: number;
  totalExceptions: number; uniqueDrivers: number; pctComplete: number;
}

export async function writeFleetIndex(
  tenant: string, dateStr: string,
  loads: any[], summary: FleetSummary, driverIndex: Record<string, string[]>, scannedAt: string,
): Promise<void> {
  const base = `${FLEET_COLLECTION}/${parentId(tenant, dateStr)}`;
  const withNbr = loads.filter((l) => l && l.loadNbr);

  // Prune loads that vanished since the previous scan.
  const existing = await listDocs(`${base}/loads`);
  const nextNbrs = new Set(withNbr.map((l) => String(l.loadNbr)));
  await Promise.all(existing.filter((d) => !nextNbrs.has(String(d._id))).map((d) => deleteDoc(`${base}/loads/${d._id}`)));

  const conc = 12; let i = 0;
  const writeOne = async () => {
    while (i < withNbr.length) {
      const l = withNbr[i++];
      await setDoc(`${base}/loads/${l.loadNbr}`, { ...l, _updatedAt: scannedAt });
    }
  };
  await Promise.all(Array.from({ length: conc }, writeOne));
  await setDoc(`${base}/meta/summary`, { ...summary, _updatedAt: scannedAt } as any);
  await setDoc(`${base}/meta/driverIndex`, { map: driverIndex, _updatedAt: scannedAt } as any);
  // Parent doc last, carrying freshness for SITE A's staleness check.
  await setDoc(base, { tenant, date: dateStr, last_scanned_at: scannedAt } as any);
}
