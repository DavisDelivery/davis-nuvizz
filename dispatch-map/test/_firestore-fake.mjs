// test/_firestore-fake.mjs — an in-memory Firestore REST fake for the lib/firestore.mts
// helpers (getDoc / setDoc / listDocs / deleteDoc / documents:commit). Not a test file
// (no .test. suffix, so the runner's glob skips it). Installs a throwaway service account
// so the real SA-JWT path in firestore.mts runs unmodified, then swaps globalThis.fetch.
//
// Everything that is NOT the OAuth token endpoint or firestore.googleapis.com is handed to
// `onOther(url, init)`; when that is absent the fake THROWS, which is the point — a test
// here proves that no vendor/network call was made.
import crypto from 'node:crypto';

export function installServiceAccountEnv() {
  if (!process.env.FIREBASE_SA) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FIREBASE_SA = JSON.stringify({
      project_id: 'testproj',
      client_email: 'sa@testproj.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
  }
  process.env.NUVIZZ_BASE_URL = '';        // never uat → isFirestoreEnabled() true
  delete process.env.FIRESTORE_DATABASE;   // '(default)'
}

const encVal = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encVal(x)])) } };
  return { stringValue: String(v) };
};
const decVal = (v) => {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decVal(x)]));
  return null;
};
const encDoc = (path, obj) => ({ name: `projects/testproj/databases/(default)/documents/${path}`, fields: Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encVal(v)])) });
const decDoc = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decVal(v)]));

// seed: { 'nuvizz_stop_index/davis__2026-09-01/stops/A': { stopNbr:'A' }, … }
export function installFirestoreFake(seed = {}, onOther) {
  installServiceAccountEnv();
  const store = new Map(Object.entries(seed));
  const log = { gets: [], lists: [], sets: [], deletes: [], commits: [], other: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('firestore.googleapis.com')) {
      if (url.includes('/documents:commit')) {
        const body = JSON.parse(String(init.body));
        log.commits.push(body);
        return new Response(JSON.stringify({ writeResults: body.writes.map(() => ({})) }), { status: 200 });
      }
      const m = url.match(/\/documents\/(.+?)(\?|$)/);
      const path = m ? decodeURIComponent(m[1]) : '';
      const segs = path.split('/');
      if (method === 'GET') {
        if (segs.length % 2 === 1) { // collection → list
          log.lists.push(path);
          const docs = [...store.entries()]
            .filter(([k]) => k.startsWith(path + '/') && k.slice(path.length + 1).split('/').length === 1)
            .map(([k, v]) => encDoc(k, v));
          return new Response(JSON.stringify(docs.length ? { documents: docs } : {}), { status: 200 });
        }
        log.gets.push(path);
        const d = store.get(path);
        return d ? new Response(JSON.stringify(encDoc(path, d)), { status: 200 }) : new Response('{}', { status: 404 });
      }
      if (method === 'PATCH') {
        const doc = decDoc(JSON.parse(String(init.body)).fields);
        log.sets.push({ path, doc });
        store.set(path, doc);
        return new Response('{}', { status: 200 });
      }
      if (method === 'DELETE') {
        log.deletes.push(path);
        store.delete(path);
        return new Response('{}', { status: 200 });
      }
    }
    log.other.push({ url, method });
    if (onOther) return onOther(url, init);
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  };
  return { store, log, restore: () => { globalThis.fetch = realFetch; } };
}
