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
// ONE READ PER REQUEST. Each entry point runs inside inRoutingSwitchRequest(): the request's first
// hydrate decides, and every later one in the same request is a no-op. So a build that runs for
// minutes, or reaches a load at three points, never uses one position of a switch in one place and
// another in the next — and its trail can say exactly what it used.
//
// WHAT A FAILED READ DOES, exactly (it is not free, and the page says so):
//   • an instance that has read the document before KEEPS that copy and tries again after
//     HYDRATE_RETRY_MS — a blip delays a flip, it does not undo one;
//   • an instance that has NEVER read it has nothing to keep: that whole request runs on the
//     Netlify value or default, IGNORING a switch set on the page, and the next request tries again
//     (no retry wait — the wait only protects a copy, and there is none).
// routingSwitchesTrail() says which of those happened and which switches the request read from the
// page; the build, the Fill-my-loads plan and the Google road box carry it in their answer.
import { getDoc, updateDocFields, isFirestoreEnabled } from './firestore.mts';
import { setRoutingSwitchCache, routingSwitchConsults, clearRoutingSwitchConsults } from './routing-switch-cache.mts';
import { ROUTING_SWITCHES_PATH } from '../../../src/lib/routing-switches.js';

export const HYDRATE_TTL_MS = 30_000;
export const HYDRATE_RETRY_MS = 5_000;

/**
 * 'fresh'       read the document
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
let lastError = '';
// The open request, if any, and its one read's status (null until it has read).
let inRequest = false;
let requestStatus: HydrateStatus | null = null;

/**
 * Run one request's work with ONE read of the switches. A nested call (runPipeline inside the
 * build) joins the outer request. Netlify runs one request per instance at a time, so a
 * module-level request is the request.
 */
export async function inRoutingSwitchRequest<T>(fn: () => Promise<T>): Promise<T> {
  if (inRequest) return fn();
  inRequest = true;
  requestStatus = null;
  clearRoutingSwitchConsults();
  try {
    return await fn();
  } finally {
    inRequest = false;
    requestStatus = null;
  }
}

const note = (s: HydrateStatus): HydrateStatus => {
  lastStatus = s;
  if (inRequest) requestStatus = s;
  return s;
};

/** Load the document into the cache, at most once per HYDRATE_TTL_MS and once per request. Never throws. */
export async function hydrateRoutingSwitches(now: number = Date.now()): Promise<HydrateStatus> {
  if (inRequest && requestStatus) return requestStatus;
  if (!isFirestoreEnabled()) return note('off');
  if (loadedAt && now - loadedAt < HYDRATE_TTL_MS) return note('cached');
  // The retry wait protects a copy we HAVE; with none, every request tries.
  if (loadedAt && failedAt && now - failedAt < HYDRATE_RETRY_MS) return note('failed-kept');
  try {
    const doc = await getDoc(ROUTING_SWITCHES_PATH);
    setRoutingSwitchCache(doc || {});
    loadedAt = now;
    failedAt = 0;
    lastError = '';
    return note('fresh');
  } catch (e: any) {
    failedAt = now;
    lastError = String(e?.message || e).slice(0, 200);
    const s = loadedAt ? 'failed-kept' : 'failed-none';
    console.warn(`routing-switches: read failed (${s === 'failed-kept' ? 'keeping the last copy' : 'no copy — this request uses the Netlify values and defaults'}) —`, lastError);
    return note(s);
  }
}

export interface RoutingSwitchesTrail {
  read: HydrateStatus;
  copyFrom: string | null;
  error?: string;
  /** Switches this request read whose position CAME FROM THE PAGE. */
  fromPage: Record<string, boolean>;
  /** Switches this request read with nothing from the page: its Netlify value or default. */
  notFromPage: string[];
}

/**
 * What this request's read found, and — switch by switch — whether each switch it actually READ
 * took its position from the page. Only switches the request read are listed: a road-box answer
 * never names a Build switch.
 */
export function routingSwitchesTrail(): RoutingSwitchesTrail {
  const read = (inRequest && requestStatus) || lastStatus;
  const fromPage: Record<string, boolean> = {};
  const notFromPage: string[] = [];
  for (const [name, v] of routingSwitchConsults()) {
    if (typeof v === 'boolean') fromPage[name] = v; else notFromPage.push(name);
  }
  return {
    read,
    // When the copy in use was read: 'cached' is a copy at most 30 s old, 'failed-kept' an older one.
    copyFrom: loadedAt ? new Date(loadedAt).toISOString() : null,
    ...(read === 'failed-kept' || read === 'failed-none' ? { error: lastError } : {}),
    fromPage,
    notFromPage: notFromPage.sort(),
  };
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
  lastError = '';
  inRequest = false;
  requestStatus = null;
  clearRoutingSwitchConsults();
  setRoutingSwitchCache({});
}
