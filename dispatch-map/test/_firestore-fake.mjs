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
  const log = { gets: [], lists: [], listMasks: [], sets: [], deletes: [], commits: [], queries: [], other: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('firestore.googleapis.com')) {
      // ── runQuery, natively — ONLY when the caller supplied no onOther ──────────
      //
      // runQuery IS a Firestore call, but this fake used to hand it to onOther, which means
      // it landed in `log.other` — the list a dozen tests assert is EMPTY to prove no vendor
      // call was made. So any endpoint that reads the customer rollup could not make that
      // proof, and the zero-NuVizz-calls claim it prints on screen was untestable.
      //
      // Guarded on `!onOther` so every existing test keeps its exact behaviour: the ones that
      // pass their own query handler (pro-search-covers-all-history) still get it, and the
      // ones that pass nothing now get a working query instead of a throw.
      //
      // Deliberately only the two filter shapes this repo actually issues (history-customers
      // .mts): ARRAY_CONTAINS on a single field, and the AND'd name_lower range the 1-char
      // prefix fallback uses. Anything else returns nothing rather than pretending.
      if (url.includes(':runQuery') && !onOther) {
        const q = JSON.parse(String(init.body || '{}')).structuredQuery || {};
        log.queries.push(q);
        const coll = q.from?.[0]?.collectionId || '';
        const rows = [...store.entries()]
          .filter(([k]) => k.startsWith(`${coll}/`) && k.slice(coll.length + 1).split('/').length === 1)
          .filter(([, v]) => {
            const f = q.where?.fieldFilter;
            if (f) {
              const field = v?.[f.field.fieldPath];
              if (f.op === 'ARRAY_CONTAINS') return Array.isArray(field) && field.includes(f.value.stringValue);
              if (f.op === 'EQUAL') return field === decVal(f.value);
              return false;
            }
            const c = q.where?.compositeFilter;
            if (c) {
              return (c.filters || []).every((sub) => {
                const ff = sub.fieldFilter;
                if (!ff) return false;
                const field = v?.[ff.field.fieldPath];
                const val = decVal(ff.value);
                if (ff.op === 'GREATER_THAN_OR_EQUAL') return String(field ?? '') >= String(val);
                if (ff.op === 'LESS_THAN') return String(field ?? '') < String(val);
                if (ff.op === 'EQUAL') return field === val;
                return false;
              });
            }
            return true;
          })
          .slice(0, Number(q.limit) || 1000)
          .map(([k, v]) => ({ document: encDoc(k, v) }));
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      if (url.includes('/documents:commit')) {
        const body = JSON.parse(String(init.body));
        log.commits.push(body);
        // APPLY plain document writes to the store. The fake used to only LOG them, so a
        // createDocIfAbsent landed a document that no later getDoc could see — which makes
        // an atomic-create write path (history-pro-index's one-op common case) untestable
        // and, worse, testable-looking: the write "succeeded" and the read came back empty,
        // exactly the silent half-write these tests exist to catch.
        // Only writes that carry `update.fields` and no transform are applied; the
        // increment/transform commits (call counters) keep their log-only behaviour.
        for (const w of body.writes || []) {
          const name = w?.update?.name;
          if (!name || !w.update.fields || w.updateTransforms || w.transform) continue;
          const wPath = String(name).split('/documents/')[1];
          if (!wPath) continue;
          // currentDocument: { exists: false } is a real compare-and-swap — the caller
          // relies on losing it to mean "someone already has this", so the fake must
          // refuse rather than overwrite.
          if (w.currentDocument && w.currentDocument.exists === false && store.has(wPath)) {
            return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: 'document already exists' } }), { status: 400 });
          }
          store.set(wPath, decDoc(w.update.fields));
        }
        return new Response(JSON.stringify({ writeResults: (body.writes || []).map(() => ({})) }), { status: 200 });
      }
      const m = url.match(/\/documents\/(.+?)(\?|$)/);
      const path = m ? decodeURIComponent(m[1]) : '';
      const segs = path.split('/');
      if (method === 'GET') {
        if (segs.length % 2 === 1) { // collection → list
          log.lists.push(path);
          // WHICH FIELDS THE READER ASKED FOR. Recorded for the same reason the write mask is
          // (see the PATCH branch): a masked read and a whole-document read return the identical
          // object from this fake, so a caller that quietly stops masking — and starts pulling
          // the raw NuVizz blob for every stop in a fourteen-day window — would pass every test.
          // `lists` keeps its plain-path shape; existing assertions on it are untouched.
          log.listMasks.push({ path, mask: new URL(url).searchParams.getAll('mask.fieldPaths') });
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
        // updateMask.fieldPaths → merge ONLY the masked fields into the existing document (Firestore
        // semantics: updateDocFields). No mask → whole-document replace (setDoc). Without this the
        // fake made a field-masked heal and a blind setDoc indistinguishable — a regression from
        // patchStopFields to setDoc would have passed every test while wiping the row in production.
        const mask = new URL(url).searchParams.getAll('updateMask.fieldPaths');
        if (mask.length) {
          const next = { ...(store.get(path) || {}) };
          for (const k of mask) { if (k in doc) next[k] = doc[k]; else delete next[k]; }
          (log.patches ||= []).push({ path, mask, fields: doc });
          store.set(path, next);
        } else {
          log.sets.push({ path, doc });
          store.set(path, doc);
        }
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
