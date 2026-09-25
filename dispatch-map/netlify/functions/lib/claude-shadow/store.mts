// lib/claude-shadow/store.mts — THE ONE WRITE GATEWAY FOR THE CLAUDE SHADOW PLANNER.
//
// Every Firestore write the shadow planner makes goes through a function in this file, and
// every function here refuses a path whose collection does not start with SHADOW_PREFIX
// BEFORE any network call is made. That is the whole promise: whatever the shadow planner
// gets wrong, it gets wrong inside claude_shadow_*, and the board, the att_plan freeze, the
// routing collections and nuvizz_ops are out of its reach.
//
// scripts/check-shadow-isolation.mjs enforces the other half from the source: no shadow
// file except this one may import a Firestore writer (setDoc, updateDocFields, deleteDoc,
// patch*, write*, …) from anywhere, and none may namespace-import a local module to get
// around that. So "the shadow wrote outside its prefix" needs this file to be wrong AND the
// guard to be wrong, and test/claude-shadow-store.test.mjs pins this file.
//
// Reads are not gated here: the shadow reads the board, the roster and att_plan read-only,
// through the ordinary read helpers.
import { setDoc, updateDocFields, createDocIfAbsent, deleteDoc, assertSafePath } from '../firestore.mts';
import { SHADOW_PREFIX } from './config.mts';

export class ShadowPathError extends Error {
  constructor(message: string) { super(message); this.name = 'ShadowPathError'; }
}

// WHAT A SEGMENT MAY BE MADE OF. firestore.mts's safeSegment refuses '.', '..', '%2e' and
// / \ ? #, but not a TAB, LF or CR — and the URL parser fetch() uses DELETES those three before
// it resolves the path, so 'claude_shadow_runs/.\t./att_plan/davis__D' passed every check and
// then PATCHed att_plan/davis__D (found by the adversarial review, reproduced against Node's own
// fetch). So a shadow path is refused on any control character, and each segment is held to the
// characters the shadow's ids are actually made of: letters, digits, space and _ . : @ + - ' & ( ) ,
// — an ISO timestamp, a stop number, a load name. Anything else is refused, not repaired: a
// caller with a stranger id encodes it before it gets here.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const SEGMENT_RE = /^[\p{L}\p{N} _.:@+\-'&(),]+$/u;

/** Throws unless `path` is a well-formed document path inside a claude_shadow_* collection. */
export function assertShadowPath(path: string): string {
  if (typeof path !== 'string' || path === '') throw new ShadowPathError('shadow write refused: empty path');
  if (CONTROL_RE.test(path)) throw new ShadowPathError(`shadow write refused: control character in ${JSON.stringify(path)}`);
  if (path.startsWith('/')) throw new ShadowPathError(`shadow write refused: absolute path ${JSON.stringify(path)}`);
  for (const seg of path.split('/')) {
    if (!SEGMENT_RE.test(seg) || seg !== seg.trim()) throw new ShadowPathError(`shadow write refused: segment ${JSON.stringify(seg)} in ${JSON.stringify(path)}`);
  }
  let safe: string;
  try { safe = assertSafePath(path); }
  catch (e: any) { throw new ShadowPathError(`shadow write refused: ${e?.message || e}`); }
  const segs = safe.split('/');
  // A DOCUMENT path has an even number of segments (collection/doc[/collection/doc…]). An odd
  // count names a collection, which no writer here should ever be handed.
  if (segs.length % 2 !== 0) throw new ShadowPathError(`shadow write refused: ${JSON.stringify(path)} is not a document path`);
  const coll = segs[0];
  if (!coll.startsWith(SHADOW_PREFIX) || coll.length === SHADOW_PREFIX.length) {
    throw new ShadowPathError(`shadow write refused: ${JSON.stringify(path)} is outside ${SHADOW_PREFIX}*`);
  }
  return safe;
}

// A THROTTLED WRITE IS RETRIED, NOT FATAL. 2026-09-25 15:26 UTC: a paid backtest round finished,
// and the write recording it came back 429 — "This database has exceeded their maximum
// request_rate/bandwidth/document_rate for writes, please retry with exponential backoff" — and
// the job died with $1.52 spent. Firestore's own answer says what to do, so the gateway does it:
// a 429, a 5xx, a dropped connection or the request deadline is tried again after 1, 2, 4 and
// 8 seconds. Anything else — a 400, 403 or 404, a refused path — is not the network's fault and
// throws at once. The helpers stay private: this file exports writers and nothing else.
const TRANSIENT_STATUS_RE = /\bfailed: (?:429|500|502|503|504)\b/;
const TRANSIENT_NET_RE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|no answer within/i;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function transient(e: any): boolean {
  if (e instanceof ShadowPathError) return false;
  const msg = String(e?.message || e);
  // The runtime's own network failure is a TypeError whose message is "<request> failed".
  return TRANSIENT_STATUS_RE.test(msg) || TRANSIENT_NET_RE.test(msg) || e?.name === 'TimeoutError' || (e?.name === 'TypeError' && /\bfailed\b/.test(msg));
}

async function withRetry<T>(write: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await write(); }
    catch (e) {
      if (i >= RETRY_DELAYS_MS.length || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    }
  }
}

/** Replace a whole shadow document. Only for documents the shadow planner owns outright. */
export async function shadowSet(path: string, data: Record<string, any>): Promise<boolean> {
  return withRetry(() => setDoc(assertShadowPath(path), data));
}

/** Field-masked write: only the named fields change. */
export async function shadowPatch(path: string, fields: Record<string, any>): Promise<boolean> {
  return withRetry(() => updateDocFields(assertShadowPath(path), fields));
}

/** Create only if absent — the claim pattern ("this night's snapshot was taken once"). A retry
 *  after a create that landed but whose answer was lost reads as "already taken", and the caller
 *  stands down: the safe side of a claim. */
export async function shadowCreate(path: string, data: Record<string, any>): Promise<boolean> {
  return withRetry(() => createDocIfAbsent(assertShadowPath(path), data));
}

export async function shadowDelete(path: string): Promise<void> {
  return withRetry(() => deleteDoc(assertShadowPath(path)));
}
