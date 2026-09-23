// lib/shiplify-store.mts — THE SERVER HALF OF THE SHIPLIFY TRIAL IMPORT.
//
// Chad is deciding whether to buy Shiplify. Their trial came back as one spreadsheet
// (DavisfileResults.xls, ~29,700 rows: a Shipper row and a Consignee row per PRO). The
// browser parses it and shows Chad the counts BEFORE anything is written; this module stores
// it and derives the locations the map will paint. The parsing, keying and merging rules are
// NOT here — they live in src/lib/shiplify-import.js and both halves run that one copy, so
// the numbers on the import screen and the documents in Firestore cannot drift apart.
//
// FOUR LAYERS (ORCHESTRATION.md: "raw is always kept"):
//
//   1  RAW         shiplify_raw/{batch_id}__{chunk 0000}   the sheet's rows VERBATIM, append-only.
//                  Written once (createDocIfAbsent) and never overwritten or deleted — a later
//                  import of a different file is a different batch id with its own raw docs.
//   2  NORMALIZED  shiplify_locations/davis__{histDocId(match_key)}   one per delivery location,
//                  merged from every Consignee row of that key. Owned outright by this importer,
//                  so whole-document writes are correct. LATEST BATCH WINS per key: a later,
//                  different file that carries the same key replaces the doc (its raw rows are
//                  still kept, so nothing is lost); a key the later file does not carry keeps
//                  the older batch's doc and batch_id.
//   3  REJECTED    on the import log: every skipped row counted per reason, plus a SAMPLE (and
//                  the log says it is a sample — no silent caps).
//   4  LOG         shiplify_imports/{batch_id}: status, what was verified, the derived summary.
//
// And the COMPACT INDEX the map reads (shiplify_index/davis + davis__{i}): 8,680 full location
// docs are ~6 MB per page load on a phone, the index is a few documents of tab-separated lines.
// The chunk ids are FIXED (the map reads davis__0..n-1), so a rebuild overwrites them in place —
// which is why the head and every chunk go in ONE commit: Firestore applies a commit whole or
// not at all, so a failure can never leave a head over chunks of another build. After it lands
// the index is READ BACK the way the map reads it, and that read is what the log reports.
//
// ONE IMPORT RUN AT A TIME, per tenant: the index is rebuilt from EVERY stored location, and two
// runs interleaving their location writes would each verify and publish over the other's. A run
// holds a lease (shiplify_imports/{tenant}__lock, taken with an atomic create) from its claim to
// its verdict; a second run is refused 409 and, when it is another file's, says so on that
// file's log. A lease older than the fifteen-minute background budget is a killed run's.
//
// VERIFIED BY AGGREGATION READS, NEVER BY COUNTERS (ORCHESTRATION.md). After the raw layer is
// read back and after the locations are written, Firestore itself is asked how many documents
// carry this batch id. Any disagreement ends the import at status 'mismatch', never 'complete'.
//
// ZERO NuVizz calls. Nothing in this file, or anything it imports, can reach a vendor.

import { randomUUID } from 'node:crypto';
import {
  groupShiplifyRows, mergeLocationRows, summarizeShiplify, shiplifyBatchId, shiplifyContentHash,
  encodeIndexLine, decodeIndexLine, cleanPro, cleanText, INDEX_LINES_PER_DOC,
} from '../../../src/lib/shiplify-import.js';
import { histDocId } from './history-store.mts';
import {
  getDoc, getDocMasked, setDoc, deleteDoc, createDocIfAbsent, updateDocFields, incrementDocFields, listDocs,
  aggregateByEquals, batchWriteDocs,
} from './firestore.mts';

export const SHIPLIFY_TENANT = 'davis';
export const IMPORTS_COLLECTION = 'shiplify_imports';
export const RAW_COLLECTION = 'shiplify_raw';
export const LOCATIONS_COLLECTION = 'shiplify_locations';
export const INDEX_COLLECTION = 'shiplify_index';

export const BATCH_ID_RE = /^shp_[0-9a-f]{16}$/;
/** Rows per raw request. The client splits the sheet into chunks of at most this many. */
export const MAX_ROWS_PER_CHUNK = 1000;
/** Encoded JSON of one chunk's rows. Firestore's document cap is 1 MiB; this leaves room for
 *  the field names and the per-value overhead Firestore counts that JSON does not. */
export const MAX_ROWS_JSON_BYTES = 900 * 1024;
export const MAX_ROW_COUNT = 200_000;
/** The chunk id is zero-padded to four digits, so this is the most chunks a batch can have. */
export const MAX_RAW_CHUNKS = 9999;
/** How many rejected rows / collisions / conflicts the log carries by example. */
export const SAMPLE_CAP = 200;
/** A 'processing' status older than this is a run the platform killed (the background budget
 *  is fifteen minutes), not one still going — so it no longer blocks a new run. */
export const PROCESSING_STALE_MS = 15 * 60 * 1000;
const MAX_CLIENT_SUMMARY_BYTES = 32 * 1024;

// The fields encodeIndexLine reads — the listing for the index build asks for these only.
export const INDEX_FIELDS = [
  'match_key', 'place_key', 'dock_access', 'forklift', 'lumper', 'gated_access', 'security_hut',
  'call_box', 'appointment_required', 'location_types', 'tariff_items', 'batch_id', 'last_date',
];

// ── paths ────────────────────────────────────────────────────────────────────

export const logPath = (batchId: string) => `${IMPORTS_COLLECTION}/${batchId}`;
export const rawDocId = (batchId: string, chunkIndex: number) => `${batchId}__${String(chunkIndex).padStart(4, '0')}`;
export const rawPath = (batchId: string, chunkIndex: number) => `${RAW_COLLECTION}/${rawDocId(batchId, chunkIndex)}`;
// histDocId — the same path-safety tractor_locations uses (tractorLocId): a slash in a key
// took the history warehouse down in v0.50.8. normalizeMatchKey already strips slashes; this
// also dodges the reserved __…__ id shape, which a nameless, zip-less key can reach.
export const locationDocId = (tenant: string, matchKey: string) => `${tenant}__${histDocId(String(matchKey))}`;
export const locationPath = (tenant: string, matchKey: string) => `${LOCATIONS_COLLECTION}/${locationDocId(tenant, matchKey)}`;
export const indexHeadPath = (tenant: string) => `${INDEX_COLLECTION}/${tenant}`;
export const indexChunkPath = (tenant: string, i: number) => `${INDEX_COLLECTION}/${tenant}__${i}`;
// The run lease, and the tombstone that lets exactly one run take over ONE stale lease. Both
// live beside the logs; readLatestImportLog skips them. SAID PLAINLY: under today's open live
// ruleset a browser can read and write shiplify_imports (it becomes server-only only when the
// cutover block in firestore.rules goes live), so while login is off the lease is a convention
// between import runs, not a lock a browser cannot touch.
export const lockPath = (tenant: string) => `${IMPORTS_COLLECTION}/${tenant}__lock`;
export const lockTakeoverPath = (tenant: string, staleToken: string) => `${IMPORTS_COLLECTION}/${tenant}__lock_takeover_${histDocId(staleToken)}`;

export const isBatchId = (v: any) => typeof v === 'string' && BATCH_ID_RE.test(v);

// ── PURE: request validation ─────────────────────────────────────────────────

type Refusal = { ok: false; status: number; error: string };
const refuse = (status: number, error: string): Refusal => ({ ok: false, status, error });
const isPosInt = (v: any) => Number.isInteger(v) && v > 0;
const RESERVED_KEY_RE = /^__.*__$/;

// A key Firestore will refuse ("__name__"-shaped), found anywhere in a client-supplied object.
function reservedKeyIn(v: any, depth = 0): string | null {
  if (depth > 8 || v == null || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v)) {
    if (!Array.isArray(v) && (RESERVED_KEY_RE.test(k) || k === '')) return k || '(empty)';
    const inner = reservedKeyIn(x, depth + 1);
    if (inner) return inner;
  }
  return null;
}

export interface BeginRequest {
  batch_id: string; file_name: string; sheet: string; row_count: number; raw_chunk_count: number; summary: any;
}

/** PURE. The `begin` body → a clean request, or the refusal with its status and reason. */
export function validateBegin(body: any): { ok: true; value: BeginRequest } | Refusal {
  const b = body || {};
  if (!isBatchId(b.batch_id)) return refuse(400, 'batch_id must look like shp_ followed by 16 hex digits (shiplifyBatchId of the rows)');
  if (!isPosInt(b.row_count) || b.row_count > MAX_ROW_COUNT) return refuse(400, `row_count must be a whole number from 1 to ${MAX_ROW_COUNT}`);
  if (!isPosInt(b.raw_chunk_count) || b.raw_chunk_count > MAX_RAW_CHUNKS) return refuse(400, `raw_chunk_count must be a whole number from 1 to ${MAX_RAW_CHUNKS}`);
  // Every chunk carries at least one row and at most MAX_ROWS_PER_CHUNK, so a count outside
  // these bounds is a client that split the file wrong — say so now, not at chunk 29.
  if (b.raw_chunk_count > b.row_count) return refuse(400, `raw_chunk_count (${b.raw_chunk_count}) cannot exceed row_count (${b.row_count}) — every chunk carries at least one row`);
  if (b.raw_chunk_count * MAX_ROWS_PER_CHUNK < b.row_count) {
    return refuse(400, `${b.raw_chunk_count} chunks of at most ${MAX_ROWS_PER_CHUNK} rows cannot carry ${b.row_count} rows`);
  }
  if (b.file_name != null && typeof b.file_name !== 'string') return refuse(400, 'file_name must be a string');
  if (b.sheet != null && typeof b.sheet !== 'string') return refuse(400, 'sheet must be a string');
  let summary: any = null;
  if (b.summary != null) {
    if (typeof b.summary !== 'object' || Array.isArray(b.summary)) return refuse(400, 'summary must be an object (summarizeShiplify output)');
    const size = Buffer.byteLength(JSON.stringify(b.summary), 'utf8');
    if (size > MAX_CLIENT_SUMMARY_BYTES) return refuse(413, `summary is ${size} bytes; at most ${MAX_CLIENT_SUMMARY_BYTES}`);
    const bad = reservedKeyIn(b.summary);
    if (bad) return refuse(400, `summary carries a key Firestore reserves: ${JSON.stringify(bad)}`);
    summary = b.summary;
  }
  return {
    ok: true,
    value: {
      batch_id: b.batch_id,
      file_name: String(b.file_name || '').slice(0, 255),
      sheet: String(b.sheet || '').slice(0, 100),
      row_count: b.row_count,
      raw_chunk_count: b.raw_chunk_count,
      summary,
    },
  };
}

export interface RawRequest { batch_id: string; chunk_index: number; row_start: number; rows: any[] }

/**
 * PURE. The `raw` body → a clean request, or the refusal. The rows are checked for the only
 * things that would make Firestore refuse them or change them: each is a plain object, its keys
 * are storable, its cells are scalars. The VALUES are not touched — this is the raw layer.
 */
export function validateRaw(body: any): { ok: true; value: RawRequest } | Refusal {
  const b = body || {};
  if (!isBatchId(b.batch_id)) return refuse(400, 'batch_id must look like shp_ followed by 16 hex digits');
  if (!Number.isInteger(b.chunk_index) || b.chunk_index < 0 || b.chunk_index >= MAX_RAW_CHUNKS) {
    return refuse(400, `chunk_index must be a whole number from 0 to ${MAX_RAW_CHUNKS - 1}`);
  }
  if (!Number.isInteger(b.row_start) || b.row_start < 0) return refuse(400, 'row_start must be a whole number, 0 or more');
  if (!Array.isArray(b.rows) || !b.rows.length) return refuse(400, 'rows must be a non-empty array of the sheet\'s row objects');
  if (b.rows.length > MAX_ROWS_PER_CHUNK) {
    return refuse(400, `at most ${MAX_ROWS_PER_CHUNK} rows per raw request (this one has ${b.rows.length}) — send smaller chunks`);
  }
  for (let i = 0; i < b.rows.length; i++) {
    const r = b.rows[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return refuse(400, `rows[${i}] is not a row object`);
    for (const [k, v] of Object.entries(r)) {
      if (k === '' || RESERVED_KEY_RE.test(k)) return refuse(400, `rows[${i}] has a column name Firestore cannot store: ${JSON.stringify(k)}`);
      const scalar = v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
      if (!scalar) return refuse(400, `rows[${i}].${k} is not a plain cell value (string, number, true/false or null)`);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(b.rows), 'utf8');
  if (bytes > MAX_ROWS_JSON_BYTES) {
    // Says what the protocol actually allows: begin accepts a new raw_chunk_count only while no
    // chunk of the batch is stored (beginImport), so "send smaller chunks" alone would point at
    // a door that is shut once chunk 0 has landed.
    return refuse(413, `these ${b.rows.length} rows encode to ${bytes} bytes; one stored chunk holds at most ${MAX_ROWS_JSON_BYTES} (Firestore's document cap is 1 MiB). `
      + 'Split the file into smaller chunks and send begin again with the new raw_chunk_count — begin accepts a new split only before any chunk of this batch is stored');
  }
  return { ok: true, value: { batch_id: b.batch_id, chunk_index: b.chunk_index, row_start: b.row_start, rows: b.rows } };
}

/** PURE. A raw request checked against the shape `begin` declared for its batch. */
export function rawFitsLog(log: any, v: RawRequest): string | null {
  const chunks = Number(log?.raw_chunk_count);
  const rows = Number(log?.row_count);
  if (!(v.chunk_index < chunks)) return `chunk_index ${v.chunk_index} is outside this batch's ${chunks} chunks (0..${chunks - 1})`;
  if (v.row_start + v.rows.length > rows) {
    return `rows ${v.row_start}..${v.row_start + v.rows.length - 1} run past this batch's ${rows} rows`;
  }
  return null;
}

/** PURE. The raw-layer document for one chunk. */
export function buildRawDoc(v: RawRequest, tenant = SHIPLIFY_TENANT) {
  return {
    tenant,
    batch_id: v.batch_id,
    chunk_index: v.chunk_index,
    row_start: v.row_start,
    row_count: v.rows.length,
    rows: v.rows,
    content_hash: shiplifyContentHash(v.rows),
  };
}

// ── PURE: reassembling the raw layer ─────────────────────────────────────────

export type Assembled =
  | { ok: true; rows: any[]; chunks: number }
  | { ok: false; reason: string; missing: number[]; problems: string[] };

/**
 * PURE. The raw chunk documents read back for a batch (index i → the doc at chunk i, or null)
 * → the sheet's rows in file order, or exactly what is wrong with them. Nothing here trusts a
 * stored field it can re-derive: each chunk's rows are re-hashed against its content_hash, and
 * the chunks must tile 0..row_count-1 with no gap and no overlap.
 */
export function assembleRawChunks(log: any, docs: Array<any | null>): Assembled {
  const n = Number(log?.raw_chunk_count);
  const expectRows = Number(log?.row_count);
  const batch = String(log?.batch_id || '');
  const missing: number[] = [];
  const problems: string[] = [];
  const rows: any[] = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const d = docs[i];
    if (!d) { missing.push(i); continue; }
    if (d.batch_id !== batch) problems.push(`chunk ${i} belongs to batch ${d.batch_id}`);
    if (d.chunk_index !== i) problems.push(`chunk ${i} says it is chunk ${d.chunk_index}`);
    if (!Array.isArray(d.rows)) { problems.push(`chunk ${i} carries no rows array`); continue; }
    if (d.rows.length !== d.row_count) problems.push(`chunk ${i} says ${d.row_count} rows and carries ${d.rows.length}`);
    if (shiplifyContentHash(d.rows) !== d.content_hash) problems.push(`chunk ${i}'s rows no longer hash to its content_hash`);
    if (!missing.length && d.row_start !== next) problems.push(`chunk ${i} starts at row ${d.row_start}, expected ${next} (a gap or an overlap)`);
    next = Number(d.row_start) + d.rows.length;
    for (const r of d.rows) rows.push(r);
  }
  if (missing.length) {
    return {
      ok: false, missing, problems,
      reason: `missing raw chunk${missing.length > 1 ? 's' : ''} ${missing.join(', ')} of 0..${n - 1} — the upload did not finish; import the file again`,
    };
  }
  if (rows.length !== expectRows) problems.push(`the chunks carry ${rows.length} rows; begin declared ${expectRows}`);
  if (problems.length) return { ok: false, missing, problems, reason: problems.join('; ') };
  return { ok: true, rows, chunks: n };
}

// ── PURE: the normalized layer ───────────────────────────────────────────────

/**
 * PURE. The sheet's rows → every location document this batch writes, in match-key order.
 *
 * imported_at is the log's FIRST import time, not "now": re-importing the same file then
 * produces byte-identical documents, which is what makes a re-import safe to run and easy to
 * verify. idCollisions lists any two keys that land on one document id (histDocId only
 * rewrites a key in the reserved __…__ or >1400-char cases, so this should be empty; when it
 * is not, the location count check below will disagree and the log will say why).
 */
export function buildLocationDocs(rawRows: any[], meta: { tenant?: string; batch_id: string; imported_at: string }) {
  const tenant = meta.tenant || SHIPLIFY_TENANT;
  const g = groupShiplifyRows(rawRows);
  const keys = [...g.groups.keys()].sort();
  const docs: Array<{ path: string; data: any }> = [];
  const merged: any[] = [];
  const byId = new Map<string, string[]>();
  for (const key of keys) {
    const loc = mergeLocationRows(g.groups.get(key));
    if (!loc) continue;
    merged.push(loc);
    const id = locationDocId(tenant, key);
    byId.set(id, [...(byId.get(id) || []), key]);
    docs.push({
      path: `${LOCATIONS_COLLECTION}/${id}`,
      data: { tenant, ...loc, batch_id: meta.batch_id, imported_at: meta.imported_at },
    });
  }
  const idCollisions = [...byId.entries()].filter(([, ks]) => ks.length > 1).map(([doc_id, match_keys]) => ({ doc_id, match_keys }));
  return { g, docs, merged, idCollisions };
}

// ── PURE: the compact index ──────────────────────────────────────────────────

// INDEX_LINES_PER_DOC assumes ~120-byte lines. A location with a long list of types makes a
// longer line, and a chunk over Firestore's 1 MiB cap would fail the whole import at the last
// step — so a chunk also closes at this many bytes. The reader never assumes a chunk size: it
// reads the head's `chunks` count, so a byte-closed chunk costs it nothing.
export const INDEX_CHUNK_MAX_BYTES = 900 * 1024;

/** PURE. Lines → chunks of at most `maxLines` lines and `maxBytes` UTF-8 bytes (one line always fits). */
export function chunkLinesByBytes(lines: string[], maxLines: number, maxBytes: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const line of lines || []) {
    const size = Buffer.byteLength(line, 'utf8') + 4;
    if (cur.length && (cur.length >= maxLines || bytes + size > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(line);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * PURE. Every stored location (a masked listing of shiplify_locations) → the index documents.
 *
 * Only this tenant's docs (id prefix `{tenant}__`), sorted by match key, one encodeIndexLine
 * per location, INDEX_LINES_PER_DOC lines per chunk. The HEAD carries the generation and the
 * chunk count; each chunk carries the same generation.
 *
 * STALE CHUNKS: a previous, larger build may have left chunk docs past this build's last one.
 * They are not deleted — the head's `chunks` is authoritative, a reader reads 0..chunks-1
 * only, and it checks every chunk's `generation` against the head's, so a stale or
 * half-written chunk is detected rather than painted.
 */
export function buildIndexDocs(listing: any[], meta: { tenant?: string; generation: string; built_at: string }) {
  const tenant = meta.tenant || SHIPLIFY_TENANT;
  const prefix = `${tenant}__`;
  const mine = (listing || []).filter((d) => String(d?._id || '').startsWith(prefix));
  const usable = mine.filter((d) => typeof d?.match_key === 'string' && d.match_key);
  usable.sort((a, b) => (a.match_key < b.match_key ? -1 : a.match_key > b.match_key ? 1 : String(a._id).localeCompare(String(b._id))));
  const lines = usable.map((d) => encodeIndexLine(d));
  const parts = chunkLinesByBytes(lines, INDEX_LINES_PER_DOC, INDEX_CHUNK_MAX_BYTES);
  const chunks = parts.map((part, i) => ({
    path: indexChunkPath(tenant, i),
    data: { tenant, generation: meta.generation, chunk_index: i, lines: part },
  }));
  const batchIds = [...new Set(usable.map((d) => String(d.batch_id || '')).filter(Boolean))].sort();
  const head = {
    path: indexHeadPath(tenant),
    data: {
      tenant, generation: meta.generation, chunks: chunks.length, locations: lines.length,
      batch_ids: batchIds, built_at: meta.built_at,
    },
  };
  return { chunks, head, lines, skippedMalformed: mine.length - usable.length };
}

// ── PURE: the log's verdict ──────────────────────────────────────────────────

export interface Check { name: string; expected: any; actual: any; ok: boolean; source?: string; aggregation_error?: string }
// A NaN (an aggregate that did not come back) is stored as null — Firestore cannot hold NaN,
// and a verdict write that fails on its own evidence would bury the mismatch it was reporting.
// `ok` is decided on the real value first, so NaN is never equal to anything.
export const check = (name: string, expected: any, actual: any): Check => ({
  name, expected, actual: typeof actual === 'number' && !Number.isFinite(actual) ? null : actual, ok: expected === actual,
});

function sample<T>(all: T[], cap = SAMPLE_CAP) {
  return { total: all.length, sample: all.slice(0, cap), sample_size: Math.min(all.length, cap), is_sample: all.length > cap };
}

/**
 * PURE. Layers 3 and 4 — what the log says about a finished (or stopped) run. `status` is
 * 'complete' ONLY when every check agreed; any disagreement is 'mismatch', whatever else went
 * right, because the whole point of the check is that "the writes returned 200" is not the
 * same claim as "the documents are there".
 */
export function buildImportReport(args: {
  rows: any[]; built: ReturnType<typeof buildLocationDocs> | null; checks: Check[];
  index: { chunks: number; locations: number; generation: string } | null;
  finished_at: string; stoppedBeforeWrites?: string | null;
}) {
  const { rows, built, checks, index, finished_at } = args;
  const g = built ? built.g : groupShiplifyRows(rows);
  const failed = checks.filter((c) => !c.ok);
  const status = failed.length ? 'mismatch' : 'complete';

  // LAYER 3. Every skipped row is counted by reason. The sample leaves out shipper_row: every
  // PRO has one (Davis's own dock), so a sample that included them would be two hundred copies
  // of the one row nobody needs to look at, and the rows worth reading would be pushed out.
  const nonShipper = g.skipped.filter((s: any) => s.reason !== 'shipper_row');
  const rej = sample(nonShipper.map((s: any) => ({
    index: s.index, reason: s.reason, pro: cleanPro(rows[s.index]?.pro_number), name: cleanText(rows[s.index]?.name),
  })));
  const merged = built ? built.merged : [...g.groups.values()].map(mergeLocationRows);
  // Spellings per entry are capped too: one key spelled a hundred ways must not be able to push
  // the log past Firestore's 1 MiB. The full list is on that location's own document.
  const col = sample(merged.filter((l: any) => l.spellings.length).map((l: any) => ({
    match_key: l.match_key, spellings: l.spellings.slice(0, 20), spellings_total: l.spellings.length,
  })));
  const con = sample(merged.filter((l: any) => Object.keys(l.conflicts).length).map((l: any) => ({ match_key: l.match_key, conflicts: l.conflicts })));
  const get = (name: string) => checks.find((c) => c.name === name);

  return {
    status,
    verified: {
      raw_chunks: get('raw_chunks')?.actual ?? null,
      raw_rows: get('raw_rows')?.actual ?? null,
      locations_written: get('locations')?.actual ?? null,
      expected_locations: get('locations')?.expected ?? (built ? built.docs.length : null),
      checks,
      failed: failed.map((c) => c.name),
      doc_id_collisions: built ? built.idCollisions.slice(0, SAMPLE_CAP) : [],
      doc_id_collisions_total: built ? built.idCollisions.length : 0,
    },
    derived: summarizeShiplify(rows),
    rejected: {
      total: g.skipped.length,
      by_reason: { ...g.skippedByReason },
      sample: rej.sample,
      sample_size: rej.sample_size,
      sample_of: rej.total,
      is_sample: rej.is_sample,
      // `index` is the row's position in the rows the import screen sent: 0 = the first
      // non-blank row under the header. It is NOT the spreadsheet row — the header (and any
      // title row above it) sits above index 0 and blank rows are not counted — so the PRO is
      // the reliable way to find a row in the file.
      sample_note: `First ${SAMPLE_CAP} skipped rows in file order, excluding shipper_row (Davis's own dock on every PRO — counted in by_reason, never a location). ${rej.total} rows were eligible for the sample. `
        + '`index` counts the non-blank rows below the header from 0; it is NOT the spreadsheet row number (the header and any title row sit above it, and blank rows are not counted) — find a row in the file by its PRO.',
    },
    collisions: { ...col, sample_note: `Locations where more than one spelling landed on one match key; first ${SAMPLE_CAP} by match key, at most 20 spellings each (spellings_total has the count).` },
    conflicts: { ...con, sample_note: `Locations whose PROs disagreed on a yes/no field (the stronger answer was kept); first ${SAMPLE_CAP} by match key.` },
    index: index || null,
    finished_at,
    // A terminal verdict clears what an EARLIER failed attempt of the same file left behind,
    // so a 'complete' log never still carries last week's "missing chunk 17".
    error: args.stoppedBeforeWrites || null,
    missing_chunks: null,
    problems: null,
    failed_at: null,
  };
}

// ── the edges: Firestore reads and writes ────────────────────────────────────

export type Outcome = { status: number; body: any };

const processingIsLive = (log: any, nowMs: number) => {
  if (log?.status !== 'processing') return false;
  const t = Date.parse(String(log?.processing_started_at || ''));
  return Number.isFinite(t) && nowMs - t < PROCESSING_STALE_MS;
};

// ── one attempt's verdict, and clearing it for the next ─────────────────────
//
// Every field a run's outcome writes. A new attempt (a re-begin, or the processing claim) sets
// them all to null in the same masked write, so a log that later says 'failed' carries only
// what THAT run observed — never an earlier run's "8,680 locations verified" under "Failed:".
export const VERDICT_FIELDS = [
  'verified', 'index', 'derived', 'rejected', 'collisions', 'conflicts', 'finished_at',
  'error', 'missing_chunks', 'problems', 'failed_at', 'refused', 'blocked_by',
] as const;
const TERMINAL_STATUSES = new Set(['complete', 'mismatch', 'failed']);
/** The log fields beginImport reads so it can keep the earlier verdict aside (previous_verdict). */
const PREVIOUS_VERDICT_FIELDS = ['status', 'verified', 'index', 'finished_at', 'error', 'failed_at'];

/**
 * PURE. The masked fields that start a new attempt on `log`: every verdict field null, and —
 * when the log holds a FINISHED verdict — that verdict kept as `previous_verdict`, labelled as
 * the earlier attempt's. A log still 'receiving'/'processing' has no verdict to keep, so an
 * earlier previous_verdict is left where it is.
 */
export function resetVerdictFields(log: any): Record<string, any> {
  const out: Record<string, any> = Object.fromEntries(VERDICT_FIELDS.map((f) => [f, null]));
  if (log && TERMINAL_STATUSES.has(log.status)) {
    out.previous_verdict = Object.fromEntries(PREVIOUS_VERDICT_FIELDS.map((f) => [f, log[f] ?? null]));
  }
  return out;
}

// ── the run lease: one import run per tenant ─────────────────────────────────

export type Lease = { ok: true; token: string } | { ok: false; holder: any };

/**
 * Take the tenant's run lease, atomically. createDocIfAbsent is Firestore's compare-and-swap,
 * so of two runs racing for a free lease exactly one gets it. A lease older than the
 * background budget belongs to a run the platform killed: it is taken over by the ONE run that
 * wins the create of a tombstone keyed on that lease's token — two runs that both read the same
 * stale lease cannot both take it. `holder` on a refusal is the lease as it stands now.
 */
export async function acquireImportLease(tenant: string, who: { batch_id: string; file_name?: string }, nowISO: string): Promise<Lease> {
  const path = lockPath(tenant);
  const token = randomUUID();
  const lease = { tenant, batch_id: who.batch_id, file_name: who.file_name || '', token, at: nowISO };
  if (await createDocIfAbsent(path, lease)) return { ok: true, token };
  const cur = await getDoc(path);
  if (!cur) {
    // Released between the create and the read: one more try, still a compare-and-swap.
    if (await createDocIfAbsent(path, lease)) return { ok: true, token };
    return { ok: false, holder: await getDoc(path) };
  }
  const t = Date.parse(String(cur.at || ''));
  if (Number.isFinite(t) && Date.parse(nowISO) - t < PROCESSING_STALE_MS) return { ok: false, holder: cur };
  const staleToken = String(cur.token || `at_${cur.at || 'none'}`);
  if (!(await createDocIfAbsent(lockTakeoverPath(tenant, staleToken), { tenant, stale: cur, by: lease, at: nowISO }))) {
    return { ok: false, holder: (await getDoc(path)) || cur };
  }
  await setDoc(path, lease);
  return { ok: true, token };
}

/** Give the lease back — only if it is still ours (a run past its budget may have lost it). */
export async function releaseImportLease(tenant: string, token: string): Promise<void> {
  const cur = await getDocMasked(lockPath(tenant), ['token']);
  if (cur && cur.token === token) await deleteDoc(lockPath(tenant));
}

/**
 * `begin`: create the import log, or — the same file again — bump its attempt, field-masked.
 * Never replaces the log and never moves first_imported_at, which every location doc of this
 * batch is stamped with. A re-begin clears the previous attempt's verdict (keeping a finished
 * one as previous_verdict), so an upload abandoned half-way does not sit at 'receiving' beside
 * counts some earlier run observed.
 *
 * THE SPLIT (raw_chunk_count) may change on a re-begin only while NO chunk of the batch is
 * stored — that is the way out of a 413 on an early chunk. Once one is stored its chunk ids are
 * fixed (the raw layer is append-only), so a new split would mix two tilings: refused. The ROW
 * count never changes: the batch id is a hash of the rows.
 */
export async function beginImport(v: BeginRequest, nowISO: string, tenant = SHIPLIFY_TENANT): Promise<Outcome> {
  const path = logPath(v.batch_id);
  const fresh = {
    tenant, batch_id: v.batch_id, file_name: v.file_name, sheet: v.sheet, row_count: v.row_count,
    raw_chunk_count: v.raw_chunk_count, client_summary: v.summary, status: 'receiving',
    first_imported_at: nowISO, last_attempt_at: nowISO, attempts: 1,
  };
  if (await createDocIfAbsent(path, fresh)) {
    return { status: 200, body: { ok: true, batch_id: v.batch_id, first_imported_at: nowISO, attempts: 1, previous_status: null, created: true } };
  }
  const prev = await getDocMasked(path, [
    'row_count', 'raw_chunk_count', 'processing_started_at', 'first_imported_at', 'attempts', ...PREVIOUS_VERDICT_FIELDS,
  ]);
  if (!prev) return { status: 409, body: { ok: false, error: 'the import log vanished between create and read — send begin again' } };
  const shapeClash = (why: string) => ({
    status: 409,
    body: {
      ok: false,
      error: `batch ${v.batch_id} was begun with ${prev.row_count} rows in ${prev.raw_chunk_count} chunks; this begin says ${v.row_count} rows in ${v.raw_chunk_count}. ${why}`,
    },
  });
  if (prev.row_count !== v.row_count) {
    return shapeClash('A batch id is a hash of the rows, so the same id with a different shape is a bug — refusing rather than mixing the two.');
  }
  if (processingIsLive(prev, Date.parse(nowISO))) {
    return {
      status: 409,
      body: { ok: false, error: `this file is being processed right now (since ${prev.processing_started_at}); wait for it to finish, then import again`, status_now: 'processing' },
    };
  }
  const resplit = prev.raw_chunk_count !== v.raw_chunk_count;
  if (resplit) {
    // Firestore counts what is stored. NaN (no answer) is not zero, so it refuses too.
    const stored = await aggregateByEquals(RAW_COLLECTION, { batch_id: v.batch_id });
    if (stored.count !== 0) {
      return shapeClash(`${Number.isFinite(stored.count) ? stored.count : 'An unknown number of'} chunk(s) of this batch are already stored under the first split, and the raw layer is never rewritten — refusing rather than mixing two splits.`);
    }
  }
  await incrementDocFields(path, { attempts: 1 }, {
    last_attempt_at: nowISO, status: 'receiving', ...resetVerdictFields(prev),
    ...(resplit ? { raw_chunk_count: v.raw_chunk_count } : {}),
  });
  // Report what the log SAYS now, not what this call meant to make it say.
  const after = await getDocMasked(path, ['first_imported_at', 'attempts']);
  return {
    status: 200,
    body: {
      ok: true, batch_id: v.batch_id, first_imported_at: after?.first_imported_at ?? prev.first_imported_at,
      attempts: after?.attempts ?? null, previous_status: prev.status ?? null, created: false,
    },
  };
}

/**
 * `raw`: store one chunk, once. A replay of the same chunk is a no-op that says so; a
 * DIFFERENT chunk under the same id is refused and the stored one is left exactly as it was.
 */
export async function storeRawChunk(v: RawRequest, tenant = SHIPLIFY_TENANT): Promise<Outcome> {
  const log = await getDocMasked(logPath(v.batch_id), ['row_count', 'raw_chunk_count', 'status']);
  if (!log) return { status: 404, body: { ok: false, error: `no import log for ${v.batch_id} — send begin first` } };
  const misfit = rawFitsLog(log, v);
  if (misfit) return { status: 400, body: { ok: false, error: misfit } };
  const doc = buildRawDoc(v, tenant);
  const path = rawPath(v.batch_id, v.chunk_index);
  if (await createDocIfAbsent(path, doc)) {
    return { status: 200, body: { ok: true, batch_id: v.batch_id, chunk_index: v.chunk_index, written: true, same: false, content_hash: doc.content_hash } };
  }
  const stored = await getDocMasked(path, ['content_hash', 'row_start', 'row_count']);
  if (stored && stored.content_hash === doc.content_hash && stored.row_start === doc.row_start && stored.row_count === doc.row_count) {
    return { status: 200, body: { ok: true, batch_id: v.batch_id, chunk_index: v.chunk_index, written: false, same: true, content_hash: doc.content_hash } };
  }
  return {
    status: 409,
    body: {
      ok: false,
      error: `chunk ${v.chunk_index} of ${v.batch_id} is already stored with different content — refusing to overwrite a stored batch (the stored chunk is untouched). `
        + 'A batch id is a hash of the rows, so this is a client bug, not a second file.',
      stored_hash: stored?.content_hash ?? null, sent_hash: doc.content_hash,
    },
  };
}

async function mapPool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function readRawChunks(batchId: string, n: number): Promise<Array<any | null>> {
  const idx = Array.from({ length: n }, (_, i) => i);
  return mapPool(idx, 4, (i) => getDoc(rawPath(batchId, i)));
}

/**
 * The index read back the way the map reads it (App.jsx fetchShiplifyIndexOnce): the head, then
 * chunks 0..head.chunks-1, each required to exist, to be chunk i and to carry the head's
 * generation — one that does not makes the map load NOTHING. `locations` is therefore what a
 * reader gets: every decodable line when all chunks pass, 0 when any fails.
 */
async function readBackIndex(tenant: string): Promise<{ generation: string | null; chunks: number; chunks_ok: number; locations: number }> {
  const head = await getDocMasked(indexHeadPath(tenant), ['generation', 'chunks']);
  const n = Math.max(0, Math.floor(Number(head?.chunks) || 0));
  const docs = await mapPool(Array.from({ length: n }, (_, i) => i), 4, (i) => getDocMasked(indexChunkPath(tenant, i), ['generation', 'chunk_index', 'lines']));
  let ok = 0;
  let lines = 0;
  docs.forEach((d, i) => {
    if (!d || d.generation !== head?.generation || d.chunk_index !== i) return;
    ok += 1;
    for (const line of Array.isArray(d.lines) ? d.lines : []) if (decodeIndexLine(line)) lines += 1;
  });
  return { generation: head?.generation ?? null, chunks: n, chunks_ok: ok, locations: head && ok === n ? lines : 0 };
}

/**
 * THE PROCESSOR. Reads the raw layer back, verifies it, derives and writes the locations,
 * verifies those, rebuilds the index (one commit), reads it back and writes the verdict.
 *
 * `dry: true` is the inspectable version (a dry run is part of the feature): it
 * reads and verifies the raw layer and derives the location documents, WRITES NOTHING but a
 * `dry_run` field on the log — a failed dry run included — and returns the same numbers. The
 * status is not touched, and a dry run takes no lease.
 *
 * Every non-dry path that gets past "is there a log" ends the log at complete, mismatch or
 * failed — including a failure of the very first read (the import screen is polling it).
 */
export async function processImport(batchId: string, opts: { dry?: boolean; now?: () => string; tenant?: string } = {}): Promise<Outcome> {
  const now = opts.now || (() => new Date().toISOString());
  const tenant = opts.tenant || SHIPLIFY_TENANT;
  const dry = opts.dry === true;
  const path = logPath(batchId);
  let log: any = null;
  let lease: string | null = null;
  let claimed = false;

  try {
    log = await getDoc(path);
    if (!log) return { status: 404, body: { ok: false, error: `no import log for ${batchId}` } };
    const startedAt = now();
    if (!dry && processingIsLive(log, Date.parse(startedAt))) {
      // Two runs of one batch would interleave their index chunks under two generations. The
      // first run is still inside its fifteen-minute budget; leave its status alone.
      return { status: 409, body: { ok: false, error: `already processing since ${log.processing_started_at}` } };
    }
    if (!dry) {
      const got = await acquireImportLease(tenant, { batch_id: batchId, file_name: log.file_name }, startedAt);
      if (!got.ok) {
        const h = got.holder || {};
        if (h.batch_id === batchId) {
          // The same file, already running: that run writes this log's verdict. Touch nothing.
          return { status: 409, body: { ok: false, error: `already processing since ${h.at}`, blocked_by: { batch_id: h.batch_id, since: h.at ?? null } } };
        }
        const error = `another Shiplify import (${h.file_name || h.batch_id || 'unknown'}, started ${h.at || 'at an unknown time'}) is being processed — `
          + 'only one runs at a time. Import this file again when it has finished; nothing of this file was lost.';
        const blocked_by = { batch_id: h.batch_id ?? null, since: h.at ?? null };
        // Onto THIS file's log only while it waits for this job (the screen is polling it); a
        // finished verdict is left alone — this run never happened.
        if (log.status === 'receiving') await updateDocFields(path, { status: 'failed', error, failed_at: now(), blocked_by });
        return { status: 409, body: { ok: false, error, blocked_by } };
      }
      lease = got.token;
      // THE CLAIM. It clears the previous attempt's verdict in the same masked write (keeping a
      // finished one as previous_verdict), so whatever this run ends at is only what it saw.
      await updateDocFields(path, { status: 'processing', processing_started_at: startedAt, ...resetVerdictFields(log) });
      claimed = true;
    }
    // (b) the raw layer, read back and tiled.
    const docs = await readRawChunks(batchId, Number(log.raw_chunk_count));
    const asm = assembleRawChunks({ ...log, batch_id: batchId }, docs);
    if (!asm.ok) {
      const fail = { ok: false, error: asm.reason, missing_chunks: asm.missing, problems: asm.problems };
      if (dry) {
        await updateDocFields(path, { dry_run: { at: now(), ...fail } });
      } else {
        await updateDocFields(path, { status: 'failed', error: asm.reason, missing_chunks: asm.missing, problems: asm.problems, failed_at: now() });
      }
      return { status: 200, body: { ...fail, status: dry ? log.status : 'failed', dry } };
    }
    const rows = asm.rows;

    // (c) VERIFY BY AGGREGATION: Firestore counts what is stored under this batch.
    //
    // The COUNT is one equality filter on batch_id, which Firestore's automatic single-field
    // index serves. The SUM runs as its own request, and on purpose: whether Firestore serves
    // sum(row_count) under an equality on a DIFFERENT field without a composite index is not
    // something this repo can show (there is no index config in it and no emulator), and a
    // single request carrying both would lose the count along with the sum if it cannot. If
    // the sum is refused, the rows check falls back to the direct read above — every chunk
    // was read, re-hashed and tiled against row_count — and the log records WHICH source
    // answered and Firestore's own error (an index refusal carries the link that creates it).
    const rawAgg = await aggregateByEquals(RAW_COLLECTION, { batch_id: batchId });
    let rawRowsCheck: Check;
    try {
      const summed = await aggregateByEquals(RAW_COLLECTION, { batch_id: batchId }, ['row_count']);
      rawRowsCheck = { ...check('raw_rows', Number(log.row_count), summed.sums.row_count), source: 'aggregation_sum' };
    } catch (e: any) {
      rawRowsCheck = {
        ...check('raw_rows', Number(log.row_count), rows.length),
        source: 'direct_read', aggregation_error: String(e?.message || e).slice(0, 500),
      };
    }
    const recomputed = shiplifyBatchId(rows);
    const checks: Check[] = [
      { ...check('raw_chunks', Number(log.raw_chunk_count), rawAgg.count), source: 'aggregation_count' },
      rawRowsCheck,
      // The batch id IS a hash of the rows. If the rows read back do not hash to it, what is
      // stored is not what the browser hashed, and "the same file gives the same documents"
      // no longer holds.
      check('batch_id_matches_rows', batchId, recomputed),
    ];

    // (d) the normalized layer, derived.
    const built = buildLocationDocs(rows, { tenant, batch_id: batchId, imported_at: log.first_imported_at });
    if (built.idCollisions.length) checks.push(check('location_doc_ids_unique', 0, built.idCollisions.length));

    if (dry) {
      const dryRun = {
        at: now(), ok: checks.every((c) => c.ok), raw_chunks: asm.chunks, raw_rows: rows.length,
        groups: built.g.groups.size, would_write: built.docs.length, skipped_by_reason: { ...built.g.skippedByReason },
        checks, doc_id_collisions: built.idCollisions.slice(0, SAMPLE_CAP), doc_id_collisions_total: built.idCollisions.length,
        writes: 'none — POST without dry to write the locations and rebuild the index',
      };
      await updateDocFields(path, { dry_run: dryRun });
      return { status: 200, body: { ok: true, dry: true, batch_id: batchId, ...dryRun } };
    }

    const rawFailed = checks.filter((c) => c.name !== 'location_doc_ids_unique' && !c.ok);
    if (rawFailed.length) {
      // STOP BEFORE THE NORMALIZED LAYER. Everything past here is derived from the raw rows;
      // deriving from a raw layer Firestore will not vouch for would publish unverified
      // locations to the map under a log that then has to explain them.
      const report = buildImportReport({
        rows, built, checks, index: null, finished_at: now(),
        stoppedBeforeWrites: `raw layer verification disagreed (${rawFailed.map((c) => c.name).join(', ')}); nothing was written to shiplify_locations or the index`,
      });
      await updateDocFields(path, report);
      return { status: 200, body: { ok: false, batch_id: batchId, status: report.status, verified: report.verified, error: report.error } };
    }

    await batchWriteDocs(built.docs);

    // (e) VERIFY: every location this batch derived now carries this batch id. A key an older
    // batch wrote first is overwritten above and so is counted here too.
    const locAgg = await aggregateByEquals(LOCATIONS_COLLECTION, { batch_id: batchId });
    checks.push({ ...check('locations', built.g.groups.size, locAgg.count), source: 'aggregation_count' });

    // (f) the compact index: every chunk AND the head in ONE commit. The chunk ids are the ones
    // the map reads (davis__0..n-1), so they are overwritten in place; only an atomic commit
    // keeps a failure from leaving a head over chunks of another build. `single` refuses
    // before writing anything if the index ever outgrows one commit (500 writes / 8 MiB — the
    // 8,680-location trial is ~1 MB in a handful of chunks).
    const builtAt = now();
    const generation = `${batchId}_${builtAt}`;
    const listing = await listDocs(LOCATIONS_COLLECTION, { mask: INDEX_FIELDS });
    const idx = buildIndexDocs(listing, { tenant, generation, built_at: builtAt });
    await batchWriteDocs([...idx.chunks, idx.head], { single: true });

    // (g) VERIFY the index by reading it back as the map does — the writer's own line count
    // is what it meant to publish, not what a reader will get.
    const back = await readBackIndex(tenant);
    checks.push(
      { ...check('index_generation', generation, back.generation), source: 'read_back' },
      { ...check('index_chunks', idx.chunks.length, back.chunks_ok), source: 'read_back' },
      { ...check('index_locations', idx.lines.length, back.locations), source: 'read_back' },
    );

    // (h) the verdict.
    const report = buildImportReport({
      rows, built, checks, finished_at: now(),
      index: { chunks: back.chunks_ok, locations: back.locations, generation: back.generation },
    });
    await updateDocFields(path, report);
    return {
      status: 200,
      body: { ok: report.status === 'complete', batch_id: batchId, status: report.status, verified: report.verified, index: report.index },
    };
  } catch (e: any) {
    const msg = String(e?.message || e);
    // incrementDocFields carries currentDocument.exists:true: a failure write lands on the log
    // being polled and can never mint one at a caller-chosen id.
    const land = (fields: Record<string, any>) => incrementDocFields(path, {}, fields).catch(() => {});
    if (dry) {
      // Where dry runs report — so the last GOOD dry run is not left standing as the answer.
      await land({ dry_run: { at: now(), ok: false, error: msg } });
    } else if (claimed) {
      await land({ status: 'failed', error: msg, failed_at: now() });   // the claim already cleared the verdict
    } else {
      // Stopped before the claim (the first read, the lease). The log may hold an earlier
      // verdict: keep it aside when it could be read, clear it either way — 'failed' must not
      // sit beside counts this run never observed.
      await land({ ...resetVerdictFields(log), status: 'failed', error: msg, failed_at: now() });
    }
    return { status: 500, body: { ok: false, batch_id: batchId, error: msg, dry } };
  } finally {
    if (lease) await releaseImportLease(tenant, lease).catch(() => {});
  }
}

/** The log for one batch, or null. */
export async function readImportLog(batchId: string): Promise<any | null> {
  return getDoc(logPath(batchId));
}

/**
 * The most recently STARTED import (latest last_attempt_at; first_imported_at breaks a tie).
 * The collection is one document per distinct file imported — a handful during a trial — so
 * a masked list and a sort is cheaper than keeping an index for an ordered query.
 */
export async function readLatestImportLog(): Promise<any | null> {
  // Logs only: the run lease and its takeover tombstones live in this collection too.
  const rows = (await listDocs(IMPORTS_COLLECTION, { mask: ['last_attempt_at', 'first_imported_at'] })).filter((r: any) => isBatchId(String(r?._id || '')));
  if (!rows.length) return null;
  rows.sort((a: any, b: any) => String(b.last_attempt_at || '').localeCompare(String(a.last_attempt_at || ''))
    || String(b.first_imported_at || '').localeCompare(String(a.first_imported_at || '')));
  const id = String(rows[0]._id || '');
  return isBatchId(id) ? getDoc(logPath(id)) : null;
}
