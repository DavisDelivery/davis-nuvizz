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
}

// Write a full day's normalized stops. Each stop doc is keyed by stopNbr and
// carries isPlanned + last_scanned_at + the full normalized shape (incl. raw).
// Stops that vanished since the previous scan are pruned so cancelled/replanned
// orders don't linger. Returns the meta record written.
export async function writeStops(tenant: string, dateStr: string, stops: any[], scannedAt: string): Promise<StopIndexMeta> {
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const withNbr = stops.filter((s) => s && s.stopNbr);
  const plannedCount = withNbr.filter((s) => s.isPlanned).length;

  const meta: StopIndexMeta = {
    tenant,
    date: dateStr,
    last_scanned_at: scannedAt,
    count: withNbr.length,
    plannedCount,
    unplannedCount: withNbr.length - plannedCount,
  };

  // Prune stops no longer present in this scan.
  const existing = await listDocs(`${base}/stops`);
  const nextNbrs = new Set(withNbr.map((s) => String(s.stopNbr)));
  await Promise.all(
    existing
      .filter((d) => !nextNbrs.has(String(d._id)))
      .map((d) => deleteDoc(`${base}/stops/${d._id}`)),
  );

  // Upsert each stop (bounded concurrency to stay polite to Firestore).
  const conc = 12;
  let i = 0;
  const writeOne = async () => {
    while (i < withNbr.length) {
      const s = withNbr[i++];
      await setDoc(`${base}/stops/${s.stopNbr}`, { ...s, last_scanned_at: scannedAt });
    }
  };
  await Promise.all(Array.from({ length: conc }, writeOne));

  // Meta doc last so a reader never sees a fresh timestamp over a half-written set.
  await setDoc(base, meta as any);
  return meta;
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
