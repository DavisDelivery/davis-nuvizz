// fake-firestore.mjs — an in-memory stand-in for the Firestore REST API.
//
// lib/firestore.mts talks to Google over plain fetch: one POST to mint a token,
// then GET / PATCH against .../documents/<path>. This replaces globalThis.fetch
// with a Map-backed version of exactly those two surfaces, so a handler can be
// driven end to end — request in, document out — with nothing mocked INSIDE the
// code under test. The real client still signs a real JWT (with a throwaway RSA
// key generated here), encodes real Firestore field values and decodes them
// back, which is how a test finds out that a doc written by one handler is not
// the shape another handler reads.
//
// Not a test file — the `**/*.test.mjs` glob does not pick it up.

import { generateKeyPairSync } from 'node:crypto';

const PROJECT = 'test-project';
const DOC_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DOC_ROOT}/`;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Install the fake. Call BEFORE importing anything that reads FIREBASE_SA.
 * Returns the store plus `calls`, a running count of Firestore requests, so a
 * test can prove a refusal happened before any round trip.
 */
export function installFakeFirestore() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.FIREBASE_SA = JSON.stringify({ project_id: PROJECT, client_email: 'sa@test', private_key: privateKey });
  delete process.env.FIRESTORE_DATABASE;

  /** path -> wire-shape `fields` object, exactly as the client sent it. */
  const docs = new Map();
  const state = { docs, calls: 0 };
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'fake-token', expires_in: 3600 });
    }
    if (!url.startsWith(BASE)) throw new Error(`fake-firestore: unexpected fetch ${url}`);
    state.calls += 1;

    const u = new URL(url);
    const rel = u.pathname.slice(new URL(BASE).pathname.length);
    const segs = rel.split('/').filter(Boolean).map(decodeURIComponent);
    const path = segs.join('/');
    const method = String(init.method || 'GET').toUpperCase();
    const name = (p) => `${DOC_ROOT}/${p}`;

    // Odd segment count = a collection (driver_auth, a/b/stops); even = a document.
    if (segs.length % 2 === 1) {
      if (method !== 'GET') return jsonResponse({ error: 'collection is read-only here' }, 405);
      const prefix = `${path}/`;
      const documents = [...docs.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, fields]) => ({ name: name(p), fields }));
      return jsonResponse({ documents });
    }

    if (method === 'GET') {
      const fields = docs.get(path);
      return fields ? jsonResponse({ name: name(path), fields }) : jsonResponse({ error: 'not found' }, 404);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body || '{}');
      const incoming = body.fields || {};
      const mask = u.searchParams.getAll('updateMask.fieldPaths');
      if (mask.length) {
        // Field-masked merge: only the named keys change, everything else stays.
        const cur = { ...(docs.get(path) || {}) };
        for (const k of mask) {
          if (k in incoming) cur[k] = incoming[k];
          else delete cur[k];
        }
        docs.set(path, cur);
      } else {
        docs.set(path, incoming); // full replace, like setDoc
      }
      return jsonResponse({ name: name(path), fields: docs.get(path) });
    }
    if (method === 'DELETE') {
      docs.delete(path);
      return jsonResponse({});
    }
    return jsonResponse({ error: `unsupported ${method}` }, 405);
  };

  state.restore = () => {
    globalThis.fetch = realFetch;
  };
  return state;
}
