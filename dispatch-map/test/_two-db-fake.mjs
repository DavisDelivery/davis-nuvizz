// test/_two-db-fake.mjs — an in-memory Firestore REST fake that knows WHICH DATABASE a request is
// for. Not a test file (no .test. suffix, so the runner's glob skips it).
//
// The UAT mirror's rules are about two databases — production's (default), which a mirror may only
// read, and the mirror's own — so a test has to be able to say which side was read and which was
// written. This keys every document on the database in the URL. Anything that is not Firestore or
// the OAuth token endpoint is logged in `log.vendor` and REFUSED, which is how a test proves a code
// path made no NuVizz call.
//
// Store values are { data, updateTime }. GET of a document path answers the document; GET of a
// collection path answers its direct children (a list, honouring no mask — the readers here do not
// depend on it); PATCH replaces the document; DELETE removes it. runQuery and the like are not
// modelled and answer 404, which the readers here treat as "nothing".
import { installServiceAccountEnv } from './_firestore-fake.mjs';

export const encVal = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encVal(x)])) } };
};
export const decVal = (v) => {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decVal(x)]));
  return null;
};

export function installTwoDatabases({ prod = {}, mirror = {} } = {}) {
  installServiceAccountEnv();
  const dbs = { '(default)': new Map(Object.entries(prod)), 'uat-mirror': new Map(Object.entries(mirror)) };
  const log = { vendor: [], writes: [], reads: [], deletes: [] };
  const realFetch = globalThis.fetch;
  const docJson = (db, p, hit) => ({
    name: `projects/testproj/databases/${db}/documents/${p}`, updateTime: hit.updateTime,
    fields: Object.fromEntries(Object.entries(hit.data || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encVal(v)])),
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init.method || 'GET').toUpperCase();
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    const m = /firestore\.googleapis\.com\/v1\/projects\/[^/]+\/databases\/([^/]+)\/documents\/([^?]+)/.exec(url);
    if (!m) { log.vendor.push(url); throw new Error(`vendor call refused by the test: ${url}`); }
    const db = decodeURIComponent(m[1]);
    const p = decodeURIComponent(m[2]);
    const store = dbs[db];
    if (!store) throw new Error(`unknown database ${db}`);
    if (method === 'PATCH') {
      log.writes.push(`${db}:${p}`);
      const fields = JSON.parse(String(init.body)).fields || {};
      store.set(p, { data: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decVal(v)])), updateTime: new Date().toISOString() });
      return new Response('{}', { status: 200 });
    }
    if (method === 'DELETE') {
      log.deletes.push(`${db}:${p}`);
      store.delete(p);
      return new Response('{}', { status: 200 });
    }
    if (method !== 'GET') return new Response('{"error":{"code":404}}', { status: 404 });
    log.reads.push(`${db}:${p}`);
    const hit = store.get(p);
    if (hit) return new Response(JSON.stringify(docJson(db, p, hit)), { status: 200 });
    const kids = [...store.keys()].filter((k) => k.startsWith(`${p}/`) && k.slice(p.length + 1).split('/').length === 1);
    if (kids.length) return new Response(JSON.stringify({ documents: kids.map((k) => docJson(db, k, store.get(k))) }), { status: 200 });
    return new Response('{"error":{"code":404}}', { status: 404 });
  };
  return { dbs, log, restore: () => { globalThis.fetch = realFetch; } };
}

export async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
