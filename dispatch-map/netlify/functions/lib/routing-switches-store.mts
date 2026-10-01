// netlify/functions/lib/routing-switches-store.mts
//
// READ AND WRITE THE ROUTING-SWITCHES DOCUMENT (src/lib/routing-switches.js), and keep the
// server's copy (lib/routing-switch-cache.mts) fresh.
//
// hydrateRoutingSwitches() is awaited at the top of every request path that reaches a server
// switch — the road-box matrix (Google mode only), the build, the pipeline and cleanup — so a
// switch flipped on the page is honoured within HYDRATE_TTL_MS (30 s) of the flip: a warm instance
// re-reads at most that often.
//
// WHAT A FAILED READ DOES, exactly (it is not free, and the page says so):
//   • an instance that has read the document before KEEPS that copy and tries again after
//     HYDRATE_RETRY_MS — a blip delays a flip, it does not undo one;
//   • an instance that has NEVER read it has nothing to keep: that request runs on the Netlify
//     value or default, IGNORING a switch set on the page, and the next request tries again (no
//     retry wait — the wait only protects a copy, and there is none).
// routingSwitchesTrail() says which of those happened, and the build and the road box carry it in
// their answer, so a request that ran without the page's settings says so instead of looking normal.
import { getDoc, updateDocFields, isFirestoreEnabled } from './firestore.mts';
import { setRoutingSwitchCache, routingSwitchCache } from './routing-switch-cache.mts';
import { ROUTING_SWITCHES, ROUTING_SWITCHES_PATH } from '../../../src/lib/routing-switches.js';

export const HYDRATE_TTL_MS = 30_000;
export const HYDRATE_RETRY_MS = 5_000;

/**
 * 'fresh'       read the document on this request
 * 'cached'      a copy read within HYDRATE_TTL_MS
 * 'failed-kept' the read failed; the last good copy is in use
 * 'failed-none' the read failed and there is no copy: Netlify values and defaults, page ignored
 * 'off'         no Firestore on this deploy: Netlify values and defaults
 * 'not-read'    nothing has asked yet
 */
export type HydrateStatus = 'fresh' | 'cached' | 'failed-kept' | 'failed-none' | 'off' | 'not-read';

let loadedAt = 0;
let failedAt = 0;
let lastStatus: HydrateStatus = 'not-read';
// The last failed read, kept past a later success: a build whose FIRST read failed (so part of it
// ran on Netlify values) and whose second succeeded must not report a clean 'fresh'.
let lastFailedAt = 0;
let lastError = '';

const note = (s: HydrateStatus): HydrateStatus => { lastStatus = s; return s; };

/** Load the document into the cache, at most once per HYDRATE_TTL_MS. Never throws. */
export async function hydrateRoutingSwitches(now: number = Date.now()): Promise<HydrateStatus> {
  if (!isFirestoreEnabled()) return note('off');
  if (loadedAt && now - loadedAt < HYDRATE_TTL_MS) return note('cached');
  // The retry wait protects a copy we HAVE; with none, every request tries.
  if (loadedAt && failedAt && now - failedAt < HYDRATE_RETRY_MS) return note('failed-kept');
  try {
    const doc = await getDoc(ROUTING_SWITCHES_PATH);
    setRoutingSwitchCache(doc || {});
    loadedAt = now;
    failedAt = 0;
    return note('fresh');
  } catch (e: any) {
    failedAt = now;
    lastFailedAt = now;
    lastError = String(e?.message || e).slice(0, 200);
    const s = loadedAt ? 'failed-kept' : 'failed-none';
    console.warn(`routing-switches: read failed (${s === 'failed-kept' ? 'keeping the last copy' : 'no copy — this request uses the Netlify values and defaults'}) —`, lastError);
    return note(s);
  }
}

/**
 * What the last hydrate on this instance found, and the server switches set on the page that this
 * request honoured — the build puts it in plan.meta.routingSwitches, the road box in its reply.
 */
export function routingSwitchesTrail(now: number = Date.now()): { read: HydrateStatus; copyFrom: string | null; failed?: { at: string; error: string }; set: Record<string, boolean> } {
  const cache = routingSwitchCache();
  const set: Record<string, boolean> = {};
  for (const s of ROUTING_SWITCHES) {
    if (s.side !== 'server') continue;
    const v = cache?.[s.name];
    if (v && typeof v === 'object' && typeof v.on === 'boolean') set[s.name] = v.on;
  }
  // copyFrom: when the copy in use was read — 'cached' on a request is a copy at most 30 s old.
  // failed: a read that failed within the last HYDRATE_TTL_MS, even if a later one succeeded.
  const failed = lastFailedAt && now - lastFailedAt < HYDRATE_TTL_MS ? { failed: { at: new Date(lastFailedAt).toISOString(), error: lastError } } : {};
  return { read: lastStatus, copyFrom: loadedAt ? new Date(loadedAt).toISOString() : null, ...failed, set };
}

/** The whole document, read now (the endpoint's GET and its read-back). Throws on failure. */
export async function readRoutingSwitches(): Promise<Record<string, any>> {
  const doc = await getDoc(ROUTING_SWITCHES_PATH);
  return doc || {};
}

/**
 * Set one switch, or hand it back to its Netlify setting (`on: null`). FIELD-MASKED: only `name` is
 * written, so two people flipping two switches both keep their flip (CLAUDE.md: never blind-write a
 * document). A hand-back is stored as { on: null, at, by } — it resolves exactly like a switch never
 * set, and the page can still say who handed it back and when.
 *
 * It does NOT refresh this instance's cache: the endpoint that calls it is its own Netlify function,
 * and no switch reader runs in it. Every reader's instance picks the flip up within HYDRATE_TTL_MS.
 */
export async function writeRoutingSwitch(name: string, on: boolean | null, by: string, now: Date = new Date()): Promise<void> {
  await updateDocFields(ROUTING_SWITCHES_PATH, { [name]: { on, at: now.toISOString(), by } }, [name]);
}

export function _resetRoutingSwitchesStoreForTests(): void {
  loadedAt = 0;
  failedAt = 0;
  lastStatus = 'not-read';
  lastFailedAt = 0;
  lastError = '';
  setRoutingSwitchCache({});
}
