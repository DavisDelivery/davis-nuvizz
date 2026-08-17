// nuvizz-write-log.mts
//
// ── Read-only forensics for live writes ──────────────────────────────────────
//
//   GET /.netlify/functions/nuvizz-write-log?limit=5
//     &op=setStopDate      only this op        (case-insensitive)
//     &status=failed       only this outcome   (case-insensitive)
//     &since=2026-08-01    only rows at/after this instant
//   → { ok, count, matched, truncated, ops: [{ clientOpId, op, status, at, result }...] }
//     newest first. `matched` is how many rows matched BEFORE the limit cut, so a
//     caller can tell "5 of 5" from "5 of 60" and know to widen.
//
// Returns rows of the write op ledger (nuvizz_write_ops — one row per Save,
// including each import's sentHeader/sentStopNbrs, NuVizz's verbatim ack, and every
// convergence read-back). This is how a "Save said SUCCESS but nothing landed" gets
// diagnosed without guessing.
//
// FILTERING EARNED ITS PLACE ON 2026-08-17. A setStopDate bug rewrote two orders'
// delivery addresses to our own terminal, and the ledger could not size the damage:
// it returned the last 25 rows of EVERYTHING, and 23 of those were an unrelated
// bulk createStop push from the same afternoon. Filtering now happens before the
// cut, so "every failed setStopDate this month" is one call.
//
// STRICTLY FIRESTORE-ONLY: this function makes ZERO NuVizz calls — it reads our own
// journal. Safe to hit any time; costs nothing against the NuVizz ceiling. The
// limit only trims the RESPONSE (listDocs pages the collection either way), so a
// larger limit costs no extra reads.

import { listDocs, isFirestoreEnabled } from './lib/firestore.mts';
import { selectWriteOps, countWriteOps } from './lib/write-log-select.mts';

const MAX_LIMIT = 200;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no write journal available' }, 200);

  const url = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || 5));
  const q = {
    op: url.searchParams.get('op'),
    status: url.searchParams.get('status'),
    since: url.searchParams.get('since'),
  };
  try {
    const all = ((await listDocs('nuvizz_write_ops')) as any[]) || [];
    const ops = selectWriteOps(all, { ...q, limit });
    const matched = countWriteOps(all, q);
    return J({ ok: true, count: ops.length, matched, truncated: matched > ops.length, ops });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'journal read failed' }, 500);
  }
};
