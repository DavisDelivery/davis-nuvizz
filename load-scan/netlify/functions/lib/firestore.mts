// firestore.mts — minimal service-account Firestore REST client for load-scan.
//
// Deliberately a SEPARATE copy from dispatch-map/netlify/functions/lib/firestore.mts
// rather than an import: Netlify builds this site with base = "load-scan", so
// nothing outside load-scan/ exists in the build context. An import of
// ../../dispatch-map/... compiles locally and fails in CI. The stop-index read
// shape below is copied from that file on purpose — see readStops().
//
// Auth: service-account JSON in FIREBASE_SA (the same SA the other sites use).
// Access tokens are cached in module scope across warm invocations.
//
// ZERO NuVizz calls live in this file, or anywhere in load-scan. That is a hard
// design rule for this app, not an implementation detail.

import { createSign } from 'node:crypto';

let __saCache: any = null;
let __token: { value: string; expiresAt: number } | null = null;

function serviceAccount(): any {
  if (__saCache) return __saCache;
  const raw = process.env.FIREBASE_SA;
  if (!raw) throw new Error('FIREBASE_SA env var not set');
  __saCache = JSON.parse(raw);
  return __saCache;
}

export function isFirestoreEnabled(): boolean {
  return !!process.env.FIREBASE_SA;
}

/** Named Firestore database, mirroring dispatch-map: unset = '(default)'. */
export function firestoreDatabase(): string {
  return String(process.env.FIRESTORE_DATABASE || '').trim() || '(default)';
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint (and cache) a Google access token from the service account. */
async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (__token && __token.expiresAt > now + 60) return __token.value;

  const sa = serviceAccount();
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claims}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!resp.ok) throw new Error(`token mint failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const body: any = await resp.json();
  __token = { value: body.access_token, expiresAt: now + Number(body.expires_in || 3600) };
  return __token.value;
}

function docBase(): string {
  const sa = serviceAccount();
  return `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents`;
}

// ── Firestore value <-> JS conversion ────────────────────────────────────────
function toValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') {
    const fields: any = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromValue(v: any): any {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(fromValue);
  if ('mapValue' in v) {
    const out: any = {};
    for (const [k, val] of Object.entries(v.mapValue?.fields || {})) out[k] = fromValue(val);
    return out;
  }
  return null;
}

const encodeFields = (obj: any) => {
  const fields: any = {};
  for (const [k, v] of Object.entries(obj || {})) fields[k] = toValue(v);
  return fields;
};

const decodeDoc = (doc: any) => {
  if (!doc) return null;
  const out: any = {};
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromValue(v);
  out._id = String(doc.name || '').split('/').pop();
  return out;
};

async function req(path: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken();
  return fetch(`${docBase()}/${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

export async function getDoc(path: string): Promise<any | null> {
  const resp = await req(encodePath(path));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getDoc ${path} failed: ${resp.status}`);
  return decodeDoc(await resp.json());
}

/** Full overwrite of the named document (creates parents implicitly). */
export async function setDoc(path: string, data: any): Promise<void> {
  const resp = await req(encodePath(path), { method: 'PATCH', body: JSON.stringify({ fields: encodeFields(data) }) });
  if (!resp.ok) throw new Error(`setDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
}

/**
 * A read that ALSO returns the document's updateTime, so the caller can write
 * back conditionally. Separate from getDoc() on purpose: the updateTime is
 * write-machinery, and a handler that spreads a read document into a write must
 * not carry it into Firestore as a field.
 */
export async function getDocWithMeta(path: string): Promise<{ data: any | null; updateTime: string | null }> {
  const resp = await req(encodePath(path));
  if (resp.status === 404) return { data: null, updateTime: null };
  if (!resp.ok) throw new Error(`getDocWithMeta ${path} failed: ${resp.status}`);
  const raw: any = await resp.json();
  return { data: decodeDoc(raw), updateTime: typeof raw?.updateTime === 'string' ? raw.updateTime : null };
}

/**
 * Firestore says "somebody wrote first" with more than one status depending on
 * which precondition was used and how the request was routed, so all of them are
 * treated as the same answer. Anything else is a real error and is thrown.
 */
function wroteFirst(status: number, body: string): boolean {
  if (status === 409 || status === 412) return true;
  return status === 400 && /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/i.test(body);
}

/**
 * COMPARE AND SWAP. A full overwrite that lands only if the document is still
 * byte-for-byte the version the caller read; pass updateTime: null to mean "and
 * it must still not exist".
 *
 * Returns false — it does not throw — when someone else got there first, because
 * that is not a failure, it is the signal to re-read and merge again. Read-then-
 * setDoc without this is a lost update every time two people work one load at
 * once, which on a dock is the normal case, not the edge case.
 */
export async function setDocIfUnchanged(path: string, data: any, updateTime: string | null): Promise<boolean> {
  const guard = updateTime
    ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}`
    : 'currentDocument.exists=false';
  const resp = await req(`${encodePath(path)}?${guard}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (resp.ok) return true;
  const text = await resp.text();
  if (wroteFirst(resp.status, text)) return false;
  throw new Error(`setDocIfUnchanged ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
}

/**
 * Read-modify-write a whole document without losing a concurrent writer's work.
 *
 * `build` is handed the document as it is RIGHT NOW and returns what should
 * replace it, or null to write nothing. If someone else writes in between, build
 * is called again with THEIR document — so the merge happens against reality
 * rather than against a snapshot that has already gone stale.
 *
 * Returns 'written' when it landed, 'skipped' when build declined, and 'conflict'
 * when every attempt lost. A caller that gets 'conflict' must not report success:
 * on this app the phone is holding the only other copy of that work.
 *
 * scan-session runs this same pattern inline because it needs the merged counts
 * back out of the loop for its reply; everything else should use this.
 */
export async function updateDocSafely(
  path: string,
  build: (prior: any | null) => any | null,
  opts: { attempts?: number } = {},
): Promise<'written' | 'skipped' | 'conflict'> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  for (let i = 1; i <= attempts; i++) {
    const { data, updateTime } = await getDocWithMeta(path);
    const next = build(data);
    if (next == null) return 'skipped';
    if (await setDocIfUnchanged(path, next, updateTime)) return 'written';
    if (i < attempts) await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 30)));
  }
  return 'conflict';
}

/** Merge-patch only the supplied keys, leaving every other field intact. */
export async function patchDoc(path: string, data: any): Promise<void> {
  const keys = Object.keys(data || {});
  if (!keys.length) return;
  const mask = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const resp = await req(`${encodePath(path)}?${mask}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!resp.ok) throw new Error(`patchDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
}

/** List a collection, paging through every page. `mask` limits fields on the wire. */
export async function listDocs(collection: string, opts?: { mask?: string[] }): Promise<any[]> {
  const out: any[] = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    for (const f of opts?.mask || []) qs.append('mask.fieldPaths', f);
    const resp = await req(`${encodePath(collection)}?${qs.toString()}`);
    if (resp.status === 404) return out;
    if (!resp.ok) throw new Error(`listDocs ${collection} failed: ${resp.status}`);
    const body: any = await resp.json();
    for (const d of body.documents || []) out.push(decodeDoc(d));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Refuse a path segment that would not stay inside the collection it was aimed
 * at. encodeURIComponent('..') is '..', so `driver_auth/../customer_notes/X`
 * encoded segment-by-segment is still `driver_auth/../customer_notes/X` on the
 * wire and Firestore resolves it up and out of driver_auth. Every read and write
 * in this file goes through encodePath, so this one check covers all of them —
 * a caller that has already validated its id pays nothing, a caller that has
 * not gets a thrown error instead of a document somewhere else.
 */
export function assertSafeSegment(seg: string): string {
  if (!seg || seg === '.' || seg === '..' || /[\/\\?#]/.test(seg)) {
    throw new Error(`unsafe Firestore path segment: ${JSON.stringify(String(seg).slice(0, 64))}`);
  }
  return seg;
}

// Encode each path segment but keep the slashes that separate them. An empty
// segment (`a//b`, a leading or trailing slash) is refused too: it used to be
// silently dropped, which is one more way for a path to land somewhere other
// than where the caller spelled it.
export function encodePath(path: string): string {
  return String(path)
    .split('/')
    .map((s) => encodeURIComponent(assertSafeSegment(s)))
    .join('/');
}

// ── nuvizz_stop_index (READ ONLY — load-scan never writes the stop index) ────
const STOP_INDEX = 'nuvizz_stop_index';

/**
 * Parent doc id. Tenant is lowercased for the same reason dispatch-map does it:
 * Firestore paths are case-sensitive and callers disagree on 'davis' vs 'DAVIS'.
 */
export function stopIndexParent(tenant: string, dateStr: string): string {
  return `${String(tenant || '').toLowerCase()}__${dateStr}`;
}

/**
 * Read one day of stops.
 *
 * SHAPE (verified against dispatch-map readStops, which does getDoc(base) for
 * the meta doc AND listDocs(`${base}/stops`) for the rows):
 *
 *   nuvizz_stop_index/{tenant}__{date}          <- meta doc
 *   nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}   <- one doc per stop
 *
 * It is NOT a single document per day. This function reads the subcollection.
 */
export async function readStops(tenant: string, dateStr: string, opts?: { mask?: string[] }): Promise<any[]> {
  const base = `${STOP_INDEX}/${stopIndexParent(tenant, dateStr)}`;
  const docs = await listDocs(`${base}/stops`, opts?.mask ? { mask: opts.mask } : undefined);
  // Drop the index's internal bookkeeping before anything downstream sees a stop.
  return docs.map(({ _id, last_scanned_at, ...rest }: any) => rest);
}

// ── Load roster ──────────────────────────────────────────────────────────────
//
// The genuine per-day load identity, which the STOP INDEX DOES NOT CARRY.
//
// A stop's `loadNbr` is a misnomer: nuvizz-list.mts:268 writes the ROUTE NAME
// into it (`loadNbr: hasRoute ? r.routeName : null`), so every stop on Steven's
// truck reads "STEVEN" — the same string every day he works. The stop's `loadId`
// is served by the vendor but arrives empty on every row.
//
// The real numbers live in the roster the background scanner already persists:
//
//   08-10  STEVEN  DAVIS000201342  6a7987c21b7e7eee4b47441f
//   08-11  STEVEN  DAVIS000201345  6a7ac732cc81cf65c8e52bd6
//   08-12  STEVEN  DAVIS000201463  6a7c36733a2a78b090799a4f
//
// Read STRAIGHT FROM THE CACHE, deliberately not through dispatch-map's
// /nuvizz-loads-roster endpoint: that endpoint falls through to a LIVE metered
// vendor pull when the cache is cold. Here a cold cache simply means "cannot
// resolve", which is the correct and free outcome. ZERO NuVizz calls, always.
const LOAD_ROSTER = 'nuvizz_load_roster';

export async function readLoadRoster(
  tenant: string,
  dateStr: string,
): Promise<{ at: string | null; loads: any[] } | null> {
  const doc = await getDoc(`${LOAD_ROSTER}/${stopIndexParent(tenant, dateStr)}`);
  if (!doc) return null;
  let loads: any[] = [];
  try { loads = JSON.parse(doc.loadsJson || '[]'); } catch { loads = []; }
  return { at: doc.at || doc._updatedAt || null, loads };
}
