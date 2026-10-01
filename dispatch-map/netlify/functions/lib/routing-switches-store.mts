// netlify/functions/lib/routing-switches-store.mts
//
// READ AND WRITE THE ROUTING-SWITCHES DOCUMENT (src/lib/routing-switches.js), and keep the
// server's copy (lib/routing-switch-cache.mts) fresh.
//
// hydrateRoutingSwitches() is awaited at the top of every request path that reaches a server
// switch — the road-box matrix, the build, the pipeline and cleanup — so a switch flipped on the
// page is honoured on the next request, within HYDRATE_TTL_MS. A read that fails keeps the last
// copy (or none), and a reader with nothing cached falls back to its environment variable: a
// database blip can never move a switch, only delay a flip.
import { getDoc, updateDocFields, isFirestoreEnabled } from './firestore.mts';
import { setRoutingSwitchCache } from './routing-switch-cache.mts';
import { ROUTING_SWITCHES_PATH } from '../../../src/lib/routing-switches.js';

export const HYDRATE_TTL_MS = 30_000;
export const HYDRATE_RETRY_MS = 5_000;

let loadedAt = 0;
let failedAt = 0;

/** Load the document into the cache, at most once per HYDRATE_TTL_MS. Never throws. */
export async function hydrateRoutingSwitches(now: number = Date.now()): Promise<void> {
  if (!isFirestoreEnabled()) return;
  if (loadedAt && now - loadedAt < HYDRATE_TTL_MS) return;
  if (failedAt && now - failedAt < HYDRATE_RETRY_MS) return;
  try {
    const doc = await getDoc(ROUTING_SWITCHES_PATH);
    setRoutingSwitchCache(doc || {});
    loadedAt = now;
    failedAt = 0;
  } catch (e: any) {
    failedAt = now;
    console.warn('routing-switches: read failed, keeping the last copy —', e?.message || e);
  }
}

/** The whole document, read now (the endpoint's GET and its read-back). Throws on failure. */
export async function readRoutingSwitches(): Promise<Record<string, any>> {
  const doc = await getDoc(ROUTING_SWITCHES_PATH);
  return doc || {};
}

/**
 * Set one switch. FIELD-MASKED: only `name` is written, so two people flipping two switches both
 * keep their flip (CLAUDE.md: never blind-write a document). The cache is refreshed from what was
 * written so this instance honours the flip at once.
 */
export async function writeRoutingSwitch(name: string, on: boolean, by: string, now: Date = new Date()): Promise<void> {
  await updateDocFields(ROUTING_SWITCHES_PATH, { [name]: { on, at: now.toISOString(), by } }, [name]);
  loadedAt = 0;
  await hydrateRoutingSwitches();
}

export function _resetRoutingSwitchesStoreForTests(): void {
  loadedAt = 0;
  failedAt = 0;
  setRoutingSwitchCache({});
}
