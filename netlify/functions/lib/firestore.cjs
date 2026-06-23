// netlify/functions/lib/firestore.cjs
//
// Firestore client for the davismarginiq project. Used as the persistence layer for
// fleet caching: scheduled function writes load docs, user-facing functions read them.
//
// Auth: service account JSON in env var FIREBASE_SA. Tokens are cached in-memory
// across warm invocations for ~50 minutes.
//
// Schema:
//   nuvizzFleet/{tenant}__{date}/loads/{loadNbr}      ← one doc per load
//   nuvizzFleet/{tenant}__{date}/meta/summary         ← aggregate stats
//   nuvizzFleet/{tenant}__{date}/meta/driverIndex     ← userName → [loadNbr]
//
// We use {tenant}__{date} as the parent doc id (e.g. "davis__2026-04-25") because
// Firestore doesn't allow nested paths with arbitrary depth in the REST API without
// each level being an actual document. The double-underscore is unambiguous since
// tenant codes don't contain underscores.

const crypto = require('crypto');

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
let __token = null;        // { access_token, expires_at_ms }
let __saCache = null;      // parsed service account

function loadServiceAccount() {
  if (__saCache) return __saCache;
  const raw = process.env.FIREBASE_SA;
  if (!raw) throw new Error('FIREBASE_SA env var not set');
  __saCache = JSON.parse(raw);
  return __saCache;
}

function isFirestoreEnabled() {
  return !!process.env.FIREBASE_SA;
}

// --- JWT signing for the token-exchange flow ---
function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (__token && Date.now() < __token.expires_at_ms - 60_000) {
    return __token.access_token;
  }

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

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimB64 = base64UrlEncode(JSON.stringify(claim));
  const unsigned = `${headerB64}.${claimB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sigBuf = signer.sign(sa.private_key);
  const sigB64 = sigBuf.toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${unsigned}.${sigB64}`;

  // Exchange for access token
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const tok = await resp.json();
  __token = {
    access_token: tok.access_token,
    expires_at_ms: Date.now() + (tok.expires_in - 60) * 1000,
  };
  return __token.access_token;
}

// --- Firestore value encoding/decoding ---
// Firestore REST API requires every value to be tagged with its type. We provide
// helpers that recursively convert plain JS objects to/from this format.
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) fields[k] = toFirestoreValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) {
    return (v.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const [k, val] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(val);
    }
    return out;
  }
  return null;
}

function docToObject(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = fromFirestoreValue(v);
  }
  return out;
}

function objectToFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  return fields;
}

// --- Core Firestore operations ---
async function getDoc(path) {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`getDoc ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const doc = await resp.json();
  return docToObject(doc);
}

async function setDoc(path, data) {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${path}`;
  const body = JSON.stringify({ fields: objectToFields(data) });
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`setDoc ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return true;
}

async function listDocs(collectionPath) {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const allDocs = [];
  let pageToken = null;
  // pageSize cap is 300; for fleets of ~100 loads this is one page
  do {
    const url = new URL(`${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents/${collectionPath}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 404) return [];
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`listDocs ${collectionPath} failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const body = await resp.json();
    for (const d of body.documents || []) {
      const parts = (d.name || '').split('/');
      const id = parts[parts.length - 1];
      const obj = docToObject(d);
      if (obj) allDocs.push({ id, ...obj });
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return allDocs;
}

// --- Convenience helpers for the fleet schema ---
function fleetParentId(tenant, dateStr) {
  return `${tenant}__${dateStr}`;
}

async function readLoad(tenant, dateStr, loadNbr) {
  return await getDoc(`nuvizzFleet/${fleetParentId(tenant, dateStr)}/loads/${loadNbr}`);
}

async function writeLoad(tenant, dateStr, load) {
  if (!load.loadNbr) throw new Error('writeLoad: load.loadNbr required');
  // Firestore doc IDs can't have slashes. Load numbers like DAVIS000192640 are safe.
  return await setDoc(
    `nuvizzFleet/${fleetParentId(tenant, dateStr)}/loads/${load.loadNbr}`,
    { ...load, _updatedAt: new Date().toISOString() }
  );
}

async function listLoads(tenant, dateStr) {
  return await listDocs(`nuvizzFleet/${fleetParentId(tenant, dateStr)}/loads`);
}

async function readSummary(tenant, dateStr) {
  return await getDoc(`nuvizzFleet/${fleetParentId(tenant, dateStr)}/meta/summary`);
}

async function writeSummary(tenant, dateStr, summary) {
  // Ensure parent doc exists so the meta subcollection is reachable
  await setDoc(`nuvizzFleet/${fleetParentId(tenant, dateStr)}`, { tenant, date: dateStr });
  return await setDoc(
    `nuvizzFleet/${fleetParentId(tenant, dateStr)}/meta/summary`,
    { ...summary, _updatedAt: new Date().toISOString() }
  );
}

async function readDriverIndex(tenant, dateStr) {
  return await getDoc(`nuvizzFleet/${fleetParentId(tenant, dateStr)}/meta/driverIndex`);
}

// ── nuvizz_stop_index readers (Phase 4 consolidation) ───────────────────────
// The sole scanner (SITE B / dispatch-map) writes every normalized stop to
// nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}. SITE A reads these instead
// of live-scanning NuVizz for the Map / Stops / Driver-day views. The stored stop
// is dispatch-map's normalized shape (lat/lng, businessName, normalizedStatus,
// plannedEtaDTTM, isPlanned, …); the caller translates to SITE A's slim shape.
async function listStopIndex(tenant, dateStr) {
  return await listDocs(`nuvizz_stop_index/${fleetParentId(tenant, dateStr)}/stops`);
}

async function readStopIndexMeta(tenant, dateStr) {
  return await getDoc(`nuvizz_stop_index/${fleetParentId(tenant, dateStr)}`);
}

async function writeDriverIndex(tenant, dateStr, indexMap) {
  await setDoc(`nuvizzFleet/${fleetParentId(tenant, dateStr)}`, { tenant, date: dateStr });
  return await setDoc(
    `nuvizzFleet/${fleetParentId(tenant, dateStr)}/meta/driverIndex`,
    { map: indexMap, _updatedAt: new Date().toISOString() }
  );
}

// ── Phase 4: shared call counter + circuit breaker (mirrors firestore.mts) ───
const OPS_COLLECTION = 'nuvizz_ops';

async function incrementCallCounter(dateStr, n) {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const docName = `projects/${sa.project_id}/databases/(default)/documents/${OPS_COLLECTION}/calls__${dateStr}`;
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/(default)/documents:commit`;
  // Per-ET-hour bucket (hour__HH) rides in the SAME commit as `count`, mirroring
  // dispatch-map (firestore.mts) so the shared doc's hour buckets always sum to the
  // total no matter which app made the call. en-GB yields 00–23; %24 guards midnight.
  const etHour = String(parseInt(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).format(new Date()), 10) % 24).padStart(2, '0');
  const body = {
    writes: [{
      update: { name: docName, fields: { date: { stringValue: dateStr } } },
      // CRITICAL: without updateMask, this `update` REPLACES the whole doc with just
      // {date} on every call — wiping the accumulated `count` (and the dispatch-map
      // count__* breakdown) before the transform re-creates count=n. That makes the
      // SHARED counter swing up/down as the two apps write the same doc. The mask
      // scopes the update to MERGE `date`, so count survives and the transform
      // accumulates. Mirrors dispatch-map buildCounterCommitBody (firestore.mts).
      updateMask: { fieldPaths: ['date'] },
      updateTransforms: [
        { fieldPath: 'count', increment: { integerValue: String(n) } }, // transform[0] = authoritative total
        { fieldPath: `hour__${etHour}`, increment: { integerValue: String(n) } },
      ],
    }],
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`incrementCallCounter failed: ${resp.status}`);
  const out = await resp.json();
  const tr = out.writeResults?.[0]?.transformResults?.[0];
  return tr ? parseInt(tr.integerValue, 10) : NaN;
}

async function readCallCounter(dateStr) {
  const doc = await getDoc(`${OPS_COLLECTION}/calls__${dateStr}`);
  return doc && typeof doc.count === 'number' ? doc.count : 0;
}

async function readCircuit() {
  const doc = await getDoc(`${OPS_COLLECTION}/circuit`);
  if (!doc) return { open: false };
  return { open: !!doc.open, reason: doc.reason, at: doc.at };
}

async function setCircuit(open, reason, atISO) {
  await setDoc(`${OPS_COLLECTION}/circuit`, { open, reason, at: atISO });
}

module.exports = {
  isFirestoreEnabled,
  getAccessToken,
  getDoc,
  setDoc,
  listDocs,
  readLoad,
  writeLoad,
  listLoads,
  readSummary,
  writeSummary,
  readDriverIndex,
  writeDriverIndex,
  listStopIndex,
  readStopIndexMeta,
  incrementCallCounter,
  readCallCounter,
  readCircuit,
  setCircuit,
};
