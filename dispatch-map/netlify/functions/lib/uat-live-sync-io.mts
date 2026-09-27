// lib/uat-live-sync-io.mts — THE REAL READS AND WRITES BEHIND lib/uat-live-sync.mts, in one place.
//
// The core takes its I/O as deps so it can be tested against fakes; this is the only file that
// wires the real thing, shared by the scheduled tick (uat-mirror-sync-background.mts) and the
// dry run (uat-mirror-refresh.mts ?sync=explain) so the two cannot disagree about what they read.
//
// PRODUCTION is reached only through lib/prod-mirror-read.mts — GET only, databases/(default)
// only, refused off a mirror. THE MIRROR is written through lib/firestore.mts, which addresses the
// database named by FIRESTORE_DATABASE; the callers refuse before building these unless
// isMirrorDeploy(), so on production nothing here is ever constructed.

import { getDoc, setDoc, deleteDoc, listDocs } from './firestore.mts';
import { listProdDocs, listProdDocStamps, getProdDocStamped } from './prod-mirror-read.mts';
import type { SyncDeps } from './uat-live-sync.mts';

export function realSyncDeps(): SyncDeps {
  return {
    listProdStamps: (p) => listProdDocStamps(p),
    getProdStamped: (p) => getProdDocStamped(p),
    listProd: (p) => listProdDocs(p),
    getMirror: (p) => getDoc(p),
    setMirror: (p, d) => setDoc(p, d),
    deleteMirror: (p) => deleteDoc(p),
    // Only the board's stops units ask (their first-tick prune). Masked to stopNbr so a day of
    // stops carrying the vendor's raw payload lists in a few kilobytes. listDocs drops a document
    // whose masked fields are all absent — so a stop with no stopNbr is never seen, and a stop
    // that is never seen is never deleted. That is the safe direction to fail in.
    listMirrorIds: async (p) => (await listDocs(p, { mask: ['stopNbr'] })).map((r: any) => String(r._id)),
    log: (line) => console.log(line),
  };
}
