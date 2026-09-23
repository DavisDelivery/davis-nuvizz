// shiplify-import.mts — RECEIVE A SHIPLIFY TRIAL FILE, AND SAY WHAT HAPPENED TO IT.
//
// The browser parses DavisfileResults.xls, shows Chad the counts, and then sends the sheet here
// in chunks. This function only RECEIVES: it opens the import log and stores the raw rows, once
// each. Deriving the locations is shiplify-import-background (it has fifteen minutes; this has
// ten seconds). The rules live in lib/shiplify-store.mts, which runs src/lib/shiplify-import.js
// — the same module the import screen runs.
//
//   POST { action:'begin', batch_id, file_name, sheet, row_count, raw_chunk_count, summary }
//        → { ok, batch_id, first_imported_at, attempts, previous_status, created }
//          409 when this batch id was begun with a different row/chunk count, or is being
//          processed right now.
//   POST { action:'raw', batch_id, chunk_index, row_start, rows:[…] }        ≤ 1000 rows
//        → { ok, written:true } first time; { ok, written:false, same:true } on a replay;
//          409 when a DIFFERENT chunk is already stored under that id (stored one untouched);
//          413 when the rows encode past what one Firestore document holds.
//   GET  ?batch_id=X          → the import log itself (+ ok:true); 404 when there is none
//   GET  ?latest=1            → the most recently started import log; { ok:true, none:true } if
//                               nothing has ever been imported
//   GET  ?explain=1&batch_id=X → what the processor will do and where, the log's status, and
//                               the last dry run (POST shiplify-import-background
//                               { batch_id, dry:true } computes one without writing).
//
// ZERO NuVizz calls. Firestore only.
//
// GATED LIKE THE OTHER FILE-INTO-FIRESTORE UPLOAD. The POST mirrors manifest-upload.mts —
// dispatcher, checked BEFORE the body is read, because each request is up to ~1 MB written into
// Firestore under a caller-chosen id. The GET mirrors address-queue.mts's read — viewer: the log
// names consignees and PROs (the rejected-row sample), the same facts a stop card shows anyone
// allowed to look at the board. Both are INERT until AUTH_REQUIRED=true (requireUser lets a
// token-less caller through as the legacy principal until then).

import { isFirestoreEnabled, getDoc } from './lib/firestore.mts';
import { requireUser, readJsonBody } from './lib/require-user.mts';
import {
  validateBegin, validateRaw, beginImport, storeRawChunk, readImportLog, readLatestImportLog,
  isBatchId, logPath, rawPath, indexHeadPath, lockPath, LOCATIONS_COLLECTION, SHIPLIFY_TENANT, MAX_ROWS_PER_CHUNK,
} from './lib/shiplify-store.mts';

// A 1,000-row chunk is a few hundred KB of JSON; the rows themselves are refused past 900 KB
// with a precise message, so the body cap sits above that — a body refused here would get the
// vaguer "body too large" instead. Netlify's synchronous request cap is ~6 MB.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });

  if (req.method === 'GET') {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);
    const url = new URL(req.url);
    const batchId = String(url.searchParams.get('batch_id') || '').trim();
    try {
      if (url.searchParams.get('latest') === '1') {
        const latest = await readLatestImportLog();
        return latest ? J({ ok: true, ...latest }) : J({ ok: true, none: true });
      }
      if (!isBatchId(batchId)) return J({ ok: false, error: 'batch_id (shp_ + 16 hex) or latest=1 is required' }, 400);
      const log = await readImportLog(batchId);
      if (!log) return J({ ok: false, error: `no import log for ${batchId}` }, 404);
      if (url.searchParams.get('explain') === '1') {
        return J({
          ok: true,
          batch_id: batchId,
          status: log.status ?? null,
          dry_run: log.dry_run ?? null,
          // Who holds the one-run-at-a-time lease right now (null = nobody): the answer to "why
          // was my import refused 409 / is something stuck". Stale after fifteen minutes.
          lease: await getDoc(lockPath(SHIPLIFY_TENANT)),
          plan: {
            log: logPath(batchId),
            raw: `${rawPath(batchId, 0)} … ${rawPath(batchId, Math.max(0, Number(log.raw_chunk_count) - 1))} (${log.raw_chunk_count} chunks, ${log.row_count} rows)`,
            locations: `${LOCATIONS_COLLECTION}/${SHIPLIFY_TENANT}__{histDocId(match_key)} — one per Consignee match key, whole-document writes, latest batch wins per key`,
            index: `${indexHeadPath(SHIPLIFY_TENANT)} (head) + ${indexHeadPath(SHIPLIFY_TENANT)}__{i} (chunks), all in ONE commit, then read back as the map reads it`,
            lease: `${lockPath(SHIPLIFY_TENANT)} — one import run at a time; a second is refused 409 and, if it is another file, says so on that file's log`,
            verify: 'aggregation count/sum of shiplify_raw and shiplify_locations where batch_id == this batch; the index read back',
          },
          dry_run_how: 'POST /.netlify/functions/shiplify-import-background { batch_id, dry: true } — reads and verifies the raw layer, derives the locations, writes only log.dry_run',
          nuvizzCalls: 0,
        });
      }
      return J({ ok: true, ...log });
    } catch (e: any) {
      return J({ ok: false, error: `shiplify-import read failed: ${e?.message || e}` }, 500);
    }
  }

  if (req.method !== 'POST') return J({ ok: false, error: 'GET or POST only' }, 405);
  // Dispatcher, before the body is read — see the header.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  try {
    if (body.action === 'begin') {
      const v = validateBegin(body);
      if (!v.ok) return J({ ok: false, error: v.error }, v.status);
      const out = await beginImport(v.value, new Date().toISOString());
      return J(out.body, out.status);
    }
    if (body.action === 'raw') {
      const v = validateRaw(body);
      if (!v.ok) return J({ ok: false, error: v.error, max_rows: MAX_ROWS_PER_CHUNK }, v.status);
      const out = await storeRawChunk(v.value);
      return J(out.body, out.status);
    }
    return J({ ok: false, error: "action must be 'begin' or 'raw'" }, 400);
  } catch (e: any) {
    return J({ ok: false, error: `shiplify-import ${body.action} failed: ${e?.message || e}` }, 500);
  }
};
