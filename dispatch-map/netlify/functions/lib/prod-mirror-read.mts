// lib/prod-mirror-read.mts — READ PRODUCTION'S FIRESTORE FROM THE UAT MIRROR. Nothing else.
//
// Chad, 2026-09-20: "I want to use firestore to load up all our stops so I can test there
// without doing anything in nuvizz or nuvizz uat … We can do this all without a single
// nuvizz call just using our uat and firestore data."
//
// This generalises lib/prod-catalogue.mts (which reads ONE collection, the day's stop index,
// for the bench's pick list) into a reader any mirror-side job can point at any production
// collection. It keeps the catalogue's three structural constraints exactly, because reaching
// ACROSS a database boundary from the mirror into production is the most dangerous shape in
// this repo and the constraints are what make it safe:
//
//  1. IT HAS NO WRITER. Not a disabled one, not a guarded one — there is no function in this
//     file that issues anything but a GET. A test asserts this against the source text.
//  2. IT ONLY EVER ADDRESSES databases/(default). Hard-coded, deliberately not a parameter,
//     and interpolated in exactly ONE place (prodUrl) so the test can count it.
//  3. IT REFUSES UNLESS isMirrorDeploy(). On production this would be a self-read through a
//     code path nobody exercises. Refuse loudly rather than no-op.
//
// ZERO NuVizz calls: this file imports nothing from any nuvizz-* module and talks to the
// Firestore REST API only. The switch UAT_PROD_MIRROR=off puts a mirror back to reading only
// its own database (default on; only an off-word turns it off; malformed leaves it on).

import { getAccessToken, loadServiceAccount, assertSafePath, docToObject } from './firestore.mts';
import { isMirrorDeploy } from './mirror-guard.mts';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const PROD_DATABASE = '(default)';   // see (2) above — never a parameter

/** PURE. May this deploy read production's database? Only a mirror, and only unless switched off. */
export function prodMirrorReadEnabled(env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env)) return false;
  return !/^(0|false|off|no)$/i.test(String(env.UAT_PROD_MIRROR ?? '').trim());
}

function refuseUnlessMirror(env: Record<string, any>): void {
  if (!prodMirrorReadEnabled(env)) {
    throw new Error('prod-mirror-read: refused — this is not a mirror deploy, or UAT_PROD_MIRROR is off');
  }
}

/** The ONE place a production URL is built. `path` is a documents path (collection or doc). */
function prodUrl(path: string): URL {
  assertSafePath(path);
  const sa = loadServiceAccount();
  return new URL(`${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${PROD_DATABASE}/documents/${path}`);
}

/**
 * One paged, read-only GET of a production collection. Rows come back as plain objects with
 * `_id` (the document id), exactly the shape lib/firestore.mts listDocs returns for the
 * mirror's own database, so a caller can copy a row to the same id on this side.
 */
export async function listProdDocs(
  collectionPath: string,
  opts: { mask?: string[]; env?: Record<string, any> } = {},
): Promise<any[]> {
  refuseUnlessMirror(opts.env || process.env);
  const token = await getAccessToken();
  const out: any[] = [];
  let pageToken: string | null = null;
  do {
    const url = prodUrl(collectionPath);
    url.searchParams.set('pageSize', '300');
    if (opts.mask && opts.mask.length) for (const f of opts.mask) url.searchParams.append('mask.fieldPaths', f);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 404) return out;
    if (!resp.ok) throw new Error(`prod-mirror-read list ${collectionPath} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const body: any = await resp.json();
    for (const d of body.documents || []) {
      const parts = String(d?.name || '').split('/');
      const obj = docToObject(d);
      if (obj) out.push({ _id: parts[parts.length - 1], ...obj });
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return out;
}

/** One read-only GET of a production document. null when it does not exist. */
export async function getProdDoc(
  docPath: string,
  opts: { env?: Record<string, any> } = {},
): Promise<any | null> {
  refuseUnlessMirror(opts.env || process.env);
  const token = await getAccessToken();
  const resp = await fetch(prodUrl(docPath), { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`prod-mirror-read get ${docPath} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return docToObject(await resp.json());
}
