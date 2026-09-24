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

/** Throws unless `path` is a well-formed document path inside a claude_shadow_* collection. */
export function assertShadowPath(path: string): string {
  if (typeof path !== 'string' || path === '') throw new ShadowPathError('shadow write refused: empty path');
  if (path.startsWith('/')) throw new ShadowPathError(`shadow write refused: absolute path ${JSON.stringify(path)}`);
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

/** Replace a whole shadow document. Only for documents the shadow planner owns outright. */
export async function shadowSet(path: string, data: Record<string, any>): Promise<boolean> {
  return setDoc(assertShadowPath(path), data);
}

/** Field-masked write: only the named fields change. */
export async function shadowPatch(path: string, fields: Record<string, any>): Promise<boolean> {
  return updateDocFields(assertShadowPath(path), fields);
}

/** Create only if absent — the claim pattern ("this night's snapshot was taken once"). */
export async function shadowCreate(path: string, data: Record<string, any>): Promise<boolean> {
  return createDocIfAbsent(assertShadowPath(path), data);
}

export async function shadowDelete(path: string): Promise<void> {
  return deleteDoc(assertShadowPath(path));
}
