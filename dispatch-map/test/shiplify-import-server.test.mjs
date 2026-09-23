// The Shiplify trial import, SERVER half: the endpoints, the four layers, the verification.
//
// SYNTHETIC FIXTURES ONLY. This repo is public and Davis is under NDA with Shiplify: no row,
// name or address from the real DavisfileResults.xls is ever committed. Every place below is
// invented; the shapes (a Shipper and a Consignee row per PRO, Excel serial dates, the NBSP in
// an SHP PRO, pipe lists) are the file's.
//
// Every test runs the REAL handlers against the in-memory Firestore fake, whose fetch THROWS
// on anything that is not Firestore — so "no NuVizz call, no network" is proven by the test
// reaching its end, and asserted once more on log.other.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { issueSessionToken } from '../netlify/functions/lib/auth-core.mts';
import { _resetUserCacheForTests, _resetThrottleForTests } from '../netlify/functions/lib/require-user.mts';
import {
  buildAggregationQueryBody, parseAggregationResponse, buildBatchWriteBodies, batchWriteDocs, COMMIT_MAX_WRITES,
} from '../netlify/functions/lib/firestore.mts';
import { histDocId } from '../netlify/functions/lib/history-store.mts';
import {
  validateBegin, validateRaw, assembleRawChunks, buildRawDoc, buildIndexDocs, beginImport, chunkLinesByBytes, check,
  logPath, rawPath, locationPath, indexHeadPath, indexChunkPath, MAX_ROWS_PER_CHUNK, SAMPLE_CAP,
} from '../netlify/functions/lib/shiplify-store.mts';
import importFn from '../netlify/functions/shiplify-import.mts';
import backgroundFn from '../netlify/functions/shiplify-import-background.mts';
import {
  shiplifyBatchId, shiplifyContentHash, summarizeShiplify, chunk, decodeIndexLine, INDEX_LINES_PER_DOC,
} from '../src/lib/shiplify-import.js';
import { normalizeMatchKey } from '../src/lib/matchKey.js';

const NBSP = '\u00a0';
const BASE = 'https://x.netlify.app/.netlify/functions';

// ── synthetic file ───────────────────────────────────────────────────────────

function row(o = {}) {
  return {
    shipment_location_id: 1, pro_number: '1000001', pickup_date: 46251, entity: 'Consignee',
    name: 'Example Widget Co', street_address: '100 Sample Pkwy', city: 'Testville', state: 'GA',
    postal_code: '30000', provider_exemption_count: 0, visible_location_types: 'Commercial',
    all_location_types: 'Distribution Center', tariff_items: '', dock_access: 'no', forklift: '',
    lumper: 'no', gated_access: 'no', security_hut: 'no', call_box: 'no', appointment_required: '',
    ...o,
  };
}
const shipper = (pro) => row({
  pro_number: pro, entity: 'Shipper', name: 'Invented Origin Terminal', street_address: '1 Depot Rd',
  city: 'Origintown', postal_code: '39999', all_location_types: 'Warehouse', dock_access: 'yes',
});

const KEY_A = normalizeMatchKey('Example Widget Co', '100 Sample Pkwy', 'Testville', '30000');
const KEY_B = normalizeMatchKey('Second Invented Place', '5 Fake St', 'Testville', '30001');
const KEY_C = normalizeMatchKey('Third Made Up Home', '9 Pretend Ln', 'Faketon', '30002');
// A nameless (all-suffix), zip-less key: normalizeMatchKey yields "__…__", Firestore's
// reserved id shape. histDocId must dodge it.
const KEY_RESERVED = normalizeMatchKey('Inc.', '7 Nowhere Way', '', '-');
const SHIPPER_KEY = normalizeMatchKey('Invented Origin Terminal', '1 Depot Rd', 'Origintown', '39999');

function sampleFile() {
  return [
    shipper('1000001'), row({ pro_number: '1000001', dock_access: 'no', forklift: '', pickup_date: 46253 }),
    // Same place, another spelling, another PRO: dock yes beats no, forklift yes beats blank.
    shipper('1000002'), row({ pro_number: '1000002', name: 'EXAMPLE WIDGET CO.', dock_access: 'yes', forklift: 'yes', pickup_date: 46251 }),
    // The NBSP PRO, dated by Excel serial.
    shipper(`SHP${NBSP}00000.00`), row({
      pro_number: `SHP${NBSP}00000.00`, name: 'Second Invented Place', street_address: '5 Fake St', postal_code: '30001',
      pickup_date: 46255, dock_access: '', forklift: 'no',
    }),
    shipper('1000004'), row({
      pro_number: '1000004', name: 'Third Made Up Home', street_address: '9 Pretend Ln', city: 'Faketon', postal_code: '30002',
      all_location_types: 'Residential|Apartment Complex', tariff_items: 'RES|LIM', pickup_date: '46252',
    }),
    shipper('1000005'), row({ pro_number: '1000005', name: 'Inc.', street_address: '7 Nowhere Way', city: '', postal_code: '-' }),
    // A consignee nobody can key: rejected, with its reason.
    shipper('1000006'), row({ pro_number: '1000006', name: '' }),
  ];
}

// ── harness ──────────────────────────────────────────────────────────────────

function withFake(seed, fn, opts = {}) {
  _resetUserCacheForTests();
  _resetThrottleForTests();
  const fake = installFirestoreFake(seed, undefined, { commitSemantics: true, ...opts });
  return Promise.resolve().then(() => fn(fake)).finally(() => fake.restore());
}

async function post(handler, name, body, headers = {}) {
  const r = await handler(new Request(`${BASE}/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  return { status: r.status, body: await r.json() };
}
async function get(query, headers = {}) {
  const r = await importFn(new Request(`${BASE}/shiplify-import?${query}`, { headers }));
  return { status: r.status, body: await r.json() };
}
const callImport = (body, headers) => post(importFn, 'shiplify-import', body, headers);
const callBackground = (body, headers) => post(backgroundFn, 'shiplify-import-background', body, headers);

async function sendFile(rows, { chunkSize = 3, skip = [] } = {}) {
  const batch_id = shiplifyBatchId(rows);
  const parts = chunk(rows, chunkSize);
  const begin = await callImport({
    action: 'begin', batch_id, file_name: 'DavisfileResults.xls', sheet: 'DavisfileResults',
    row_count: rows.length, raw_chunk_count: parts.length, summary: summarizeShiplify(rows),
  });
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  let start = 0;
  for (const [i, part] of parts.entries()) {
    if (!skip.includes(i)) {
      const r = await callImport({ action: 'raw', batch_id, chunk_index: i, row_start: start, rows: part });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    start += part.length;
  }
  return { batch_id, begin: begin.body, chunks: parts.length };
}

const docsUnder = (fake, coll) => [...fake.store.entries()]
  .filter(([k]) => k.startsWith(`${coll}/`) && k.split('/').length === 2)
  .sort(([a], [b]) => a.localeCompare(b));

/** Read the compact index back the way the map must: head → chunks 0..n-1, generation-checked. */
function readIndex(fake) {
  const head = fake.store.get(indexHeadPath('davis'));
  assert.ok(head, 'the index head exists');
  const lines = [];
  for (let i = 0; i < head.chunks; i++) {
    const c = fake.store.get(indexChunkPath('davis', i));
    assert.ok(c, `chunk ${i} the head points at exists`);
    assert.equal(c.generation, head.generation, `chunk ${i} is of the head's generation`);
    assert.equal(c.chunk_index, i);
    lines.push(...c.lines);
  }
  return { head, records: lines.map(decodeIndexLine) };
}

// ── pure: the new firestore.mts body builders ───────────────────────────────

test('aggregation body: one equality is a fieldFilter, two are an AND, count is n_docs and each sum has its own alias', () => {
  const one = buildAggregationQueryBody('shiplify_raw', { batch_id: 'shp_0123456789abcdef' }, ['row_count']);
  const sq = one.structuredAggregationQuery;
  assert.deepEqual(sq.structuredQuery.from, [{ collectionId: 'shiplify_raw' }]);
  assert.deepEqual(sq.structuredQuery.where, {
    fieldFilter: { field: { fieldPath: 'batch_id' }, op: 'EQUAL', value: { stringValue: 'shp_0123456789abcdef' } },
  });
  assert.deepEqual(sq.aggregations, [
    { alias: 'n_docs', count: {} },
    { alias: 'sum_0', sum: { field: { fieldPath: 'row_count' } } },
  ]);
  const two = buildAggregationQueryBody('shiplify_locations', { batch_id: 'b', tenant: 'davis' });
  assert.equal(two.structuredAggregationQuery.structuredQuery.where.compositeFilter.op, 'AND');
  assert.equal(two.structuredAggregationQuery.structuredQuery.where.compositeFilter.filters.length, 2);
  const none = buildAggregationQueryBody('c', {});
  assert.equal(none.structuredAggregationQuery.structuredQuery.where, undefined, 'no filter → count the collection');
  // A dotted path is a NESTED field to Firestore: counting a different field than the one named
  // would be a verification that silently verifies something else.
  assert.throws(() => buildAggregationQueryBody('c', { 'a.b': 1 }), /plain identifier/);
  assert.throws(() => buildAggregationQueryBody('c', {}, ['x y']), /plain identifier/);
  assert.throws(() => buildAggregationQueryBody('a/b', {}), /bad collection/);
  assert.throws(() => buildAggregationQueryBody('c', { x: { nested: 1 } }), /scalar/);
});

test('aggregation response: integers and doubles read back, and NO ANSWER is NaN — never a zero that could pass a check', () => {
  const ok = parseAggregationResponse([{ result: { aggregateFields: { n_docs: { integerValue: '30' }, sum_0: { integerValue: '29672' } } }, readTime: 't' }], ['row_count']);
  assert.deepEqual(ok, { count: 30, sums: { row_count: 29672 } });
  const dbl = parseAggregationResponse([{ result: { aggregateFields: { n_docs: { integerValue: '1' }, sum_0: { doubleValue: 2.5 } } } }], ['x']);
  assert.equal(dbl.sums.x, 2.5);
  const missing = parseAggregationResponse([{ result: { aggregateFields: { n_docs: { nullValue: null } } } }], ['x']);
  assert.ok(Number.isNaN(missing.count), 'nullValue is not 0');
  assert.ok(Number.isNaN(missing.sums.x), 'an absent sum is not 0');
  assert.throws(() => parseAggregationResponse([{ readTime: 't' }]), /no aggregateFields/);
});

test('batch write bodies: at most 500 writes a commit, whole-document writes (no mask, no precondition), bad paths refused before any network', () => {
  const items = Array.from({ length: 1201 }, (_, i) => ({ path: `shiplify_locations/davis__k${i}`, data: { i, tenant: 'davis' } }));
  const bodies = buildBatchWriteBodies('projects/p/databases/(default)', items);
  assert.deepEqual(bodies.map((b) => b.writes.length), [500, 500, 201]);
  assert.equal(COMMIT_MAX_WRITES, 500);
  const w = bodies[0].writes[0];
  assert.equal(w.update.name, 'projects/p/databases/(default)/documents/shiplify_locations/davis__k0');
  assert.deepEqual(w.update.fields.i, { integerValue: '0' });
  assert.equal(w.updateMask, undefined, 'a whole-document write — the importer owns these docs outright');
  assert.equal(w.currentDocument, undefined);
  assert.deepEqual(bodies.flatMap((b) => b.writes).map((x) => x.update.fields.i.integerValue), items.map((it) => String(it.data.i)), 'order kept');
  // The byte budget splits too, and a single oversized item still goes (alone) rather than vanishing.
  const fat = [{ path: 'c/a', data: { s: 'x'.repeat(600) } }, { path: 'c/b', data: { s: 'y'.repeat(600) } }, { path: 'c/c', data: { s: 'z' } }];
  assert.deepEqual(buildBatchWriteBodies('db', fat, { maxBytes: 800 }).map((b) => b.writes.length), [1, 2]);
  assert.deepEqual(buildBatchWriteBodies('db', fat, { maxBytes: 10 }).map((b) => b.writes.length), [1, 1, 1]);
  assert.throws(() => buildBatchWriteBodies('db', [{ path: 'c/../nuvizz_ops/circuit', data: {} }]), /dot segment/);
  assert.deepEqual(buildBatchWriteBodies('db', []), []);
});

test('a check whose aggregate never came back fails, and stores null rather than a NaN Firestore cannot hold', () => {
  const c = check('locations', 4, NaN);
  assert.equal(c.ok, false);
  assert.equal(c.actual, null);
  assert.equal(check('locations', 4, 4).ok, true);
  assert.equal(check('locations', 0, null).ok, false, 'no answer is not zero');
});

// ── pure: the import rules ───────────────────────────────────────────────────

test('a chunk\'s content hash is the batch id\'s rule over that chunk — one hash, not two', () => {
  const rows = sampleFile();
  assert.match(shiplifyContentHash(rows), /^[0-9a-f]{16}$/);
  assert.equal(shiplifyBatchId(rows), `shp_${shiplifyContentHash(rows)}`);
  assert.equal(shiplifyContentHash(JSON.parse(JSON.stringify(rows))), shiplifyContentHash(rows), 'a JSON round trip (the wire) does not move it');
  assert.equal(buildRawDoc({ batch_id: 'shp_0123456789abcdef', chunk_index: 0, row_start: 0, rows }).content_hash, shiplifyContentHash(rows));
});

test('begin is refused when its counts cannot describe a real split of the file', () => {
  const ok = { batch_id: 'shp_0123456789abcdef', row_count: 2001, raw_chunk_count: 3, file_name: 'f.xls', sheet: 's', summary: {} };
  assert.equal(validateBegin(ok).ok, true);
  assert.match(validateBegin({ ...ok, batch_id: 'shp_XYZ' }).error, /16 hex/);
  assert.match(validateBegin({ ...ok, raw_chunk_count: 2 }).error, /cannot carry 2001 rows/);
  assert.match(validateBegin({ ...ok, raw_chunk_count: 3000 }).error, /cannot exceed row_count/);
  assert.match(validateBegin({ ...ok, row_count: 0 }).error, /row_count/);
  assert.match(validateBegin({ ...ok, row_count: '2001' }).error, /row_count/, 'a string is not a count');
  assert.match(validateBegin({ ...ok, summary: [] }).error, /summary must be an object/);
  assert.match(validateBegin({ ...ok, summary: { skippedByReason: { __name__: 1 } } }).error, /reserves/);
});

test('raw is refused for the things Firestore would refuse or change, and the cap is named in the error', () => {
  const base = { batch_id: 'shp_0123456789abcdef', chunk_index: 0, row_start: 0 };
  assert.equal(validateRaw({ ...base, rows: [row()] }).ok, true);
  const tooMany = validateRaw({ ...base, rows: Array.from({ length: MAX_ROWS_PER_CHUNK + 1 }, () => row()) });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.error, /at most 1000 rows per raw request/);
  assert.match(validateRaw({ ...base, rows: [row({ __name__: 'x' })] }).error, /cannot store/);
  assert.match(validateRaw({ ...base, rows: [row({ name: { nested: true } })] }).error, /plain cell value/);
  assert.match(validateRaw({ ...base, rows: [[1, 2]] }).error, /not a row object/);
  assert.match(validateRaw({ ...base, rows: [] }).error, /non-empty/);
  assert.match(validateRaw({ ...base, chunk_index: -1, rows: [row()] }).error, /chunk_index/);
  const fat = validateRaw({ ...base, rows: Array.from({ length: 1000 }, (_, i) => row({ pro_number: String(i), name: 'n'.repeat(1000) })) });
  assert.equal(fat.status, 413, 'a chunk over one Firestore document is refused BEFORE the write fails');
  assert.match(fat.error, /smaller chunks/);
});

test('reassembly: a gap, an overlap and a tampered chunk are each named, not averaged away', () => {
  const rows = sampleFile();
  const parts = chunk(rows, 4);
  const log = { batch_id: 'shp_0123456789abcdef', raw_chunk_count: parts.length, row_count: rows.length };
  let start = 0;
  const docs = parts.map((p, i) => { const d = buildRawDoc({ batch_id: log.batch_id, chunk_index: i, row_start: start, rows: p }); start += p.length; return d; });
  const good = assembleRawChunks(log, docs);
  assert.equal(good.ok, true);
  assert.deepEqual(good.rows, rows, 'file order, every row');
  const missing = assembleRawChunks(log, [docs[0], null, docs[2]]);
  assert.deepEqual(missing.missing, [1]);
  assert.match(missing.reason, /missing raw chunk 1 of 0\.\.2/);
  const shifted = assembleRawChunks(log, [docs[0], { ...docs[1], row_start: 3 }, docs[2]]);
  assert.match(shifted.reason, /chunk 1 starts at row 3, expected 4/);
  const tampered = assembleRawChunks(log, [docs[0], { ...docs[1], rows: docs[1].rows.map((r) => ({ ...r, dock_access: 'yes' })) }, docs[2]]);
  assert.match(tampered.reason, /no longer hash/);
});

// ── begin ────────────────────────────────────────────────────────────────────

test('begin creates the log; the same file begun again only bumps attempts — first_imported_at never moves', async () => {
  await withFake({}, async (fake) => {
    const v = validateBegin({ batch_id: 'shp_00000000000000aa', row_count: 12, raw_chunk_count: 4, file_name: 'DavisfileResults.xls', sheet: 'DavisfileResults', summary: { rows: 12 } }).value;
    const first = await beginImport(v, '2026-09-01T14:00:00.000Z');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, batch_id: v.batch_id, first_imported_at: '2026-09-01T14:00:00.000Z', attempts: 1, previous_status: null, created: true });
    const log = fake.store.get(logPath(v.batch_id));
    assert.equal(log.tenant, 'davis');
    assert.equal(log.status, 'receiving');
    assert.equal(log.row_count, 12);
    assert.equal(log.raw_chunk_count, 4);
    assert.deepEqual(log.client_summary, { rows: 12 });
    // Somebody else's field on the log must survive a re-begin: that is what field-masked means.
    fake.store.set(logPath(v.batch_id), { ...log, status: 'complete', finished_at: '2026-09-01T14:05:00.000Z', verified: { raw_rows: 12 }, somebody_else: 'kept' });

    const again = await beginImport(v, '2026-09-02T09:00:00.000Z');
    assert.equal(again.status, 200);
    assert.equal(again.body.attempts, 2);
    assert.equal(again.body.previous_status, 'complete');
    assert.equal(again.body.first_imported_at, '2026-09-01T14:00:00.000Z');
    const after = fake.store.get(logPath(v.batch_id));
    assert.equal(after.first_imported_at, '2026-09-01T14:00:00.000Z', 'every location doc is stamped with this — it must not move');
    assert.equal(after.last_attempt_at, '2026-09-02T09:00:00.000Z');
    assert.equal(after.status, 'receiving');
    assert.equal(after.attempts, 2);
    assert.equal(after.somebody_else, 'kept', 'the rest of the log is untouched');
    assert.deepEqual(after.client_summary, { rows: 12 });
    // The finished verdict is the EARLIER attempt's: kept aside and labelled, not left in place.
    assert.equal(after.verified, null);
    assert.deepEqual(after.previous_verdict, { status: 'complete', verified: { raw_rows: 12 }, index: null, finished_at: '2026-09-01T14:05:00.000Z', error: null, failed_at: null });
    assert.equal(fake.log.sets.filter((s) => s.path.startsWith('shiplify_imports/')).length, 0, 'never a whole-document replace of the log');
  });
});

test('begin: the same batch id with a different shape is refused 409, and the log is untouched', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows);
    const before = JSON.stringify(fake.store.get(logPath(batch_id)));
    const r = await callImport({ action: 'begin', batch_id, row_count: rows.length + 1, raw_chunk_count: 5, file_name: 'x', sheet: 's' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /hash of the rows/);
    assert.equal(JSON.stringify(fake.store.get(logPath(batch_id))), before);
  });
});

// ── raw ──────────────────────────────────────────────────────────────────────

test('raw: stored once; a replay says same:true; DIFFERENT rows under that chunk are refused 409 and the stored chunk is untouched', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows, { chunkSize: 4 });
    const stored = fake.store.get(rawPath(batch_id, 1));
    assert.equal(stored.row_start, 4);
    assert.equal(stored.row_count, 4);
    assert.equal(stored.chunk_index, 1);
    assert.equal(stored.tenant, 'davis');
    assert.equal(stored.content_hash, shiplifyContentHash(rows.slice(4, 8)));
    assert.deepEqual(stored.rows, rows.slice(4, 8), 'VERBATIM — numbers stay numbers, the NBSP stays an NBSP');
    assert.equal(stored.rows[0].pro_number, `SHP${NBSP}00000.00`);
    assert.equal(rawPath(batch_id, 1), `shiplify_raw/${batch_id}__0001`);
    const snapshot = JSON.stringify(stored);

    const replay = await callImport({ action: 'raw', batch_id, chunk_index: 1, row_start: 4, rows: rows.slice(4, 8) });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.written, false);
    assert.equal(replay.body.same, true);

    const other = rows.slice(4, 8).map((r) => ({ ...r, dock_access: 'yes' }));
    const clash = await callImport({ action: 'raw', batch_id, chunk_index: 1, row_start: 4, rows: other });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /refusing to overwrite a stored batch/);
    assert.equal(JSON.stringify(fake.store.get(rawPath(batch_id, 1))), snapshot, 'the stored chunk is byte-for-byte what it was');
    assert.equal(fake.log.deletes.length, 0, 'nothing in the raw layer is ever deleted');
  });
});

test('raw: refused before begin, outside the declared chunks, and past the declared rows', async () => {
  await withFake({}, async () => {
    const rows = sampleFile();
    const batch_id = shiplifyBatchId(rows);
    const early = await callImport({ action: 'raw', batch_id, chunk_index: 0, row_start: 0, rows: rows.slice(0, 3) });
    assert.equal(early.status, 404);
    assert.match(early.body.error, /send begin first/);
    await sendFile(rows, { chunkSize: 4 });
    const outside = await callImport({ action: 'raw', batch_id, chunk_index: 3, row_start: 12, rows: [row()] });
    assert.equal(outside.status, 400);
    assert.match(outside.body.error, /outside this batch's 3 chunks/);
    const past = await callImport({ action: 'raw', batch_id, chunk_index: 2, row_start: 10, rows: rows.slice(0, 4) });
    assert.equal(past.status, 400);
    assert.match(past.body.error, /run past/);
    const big = await callImport({ action: 'raw', batch_id, chunk_index: 0, row_start: 0, rows: Array.from({ length: 1001 }, () => row()) });
    assert.equal(big.status, 400);
    assert.equal(big.body.max_rows, 1000);
  });
});

// ── the processor ────────────────────────────────────────────────────────────

test('process: Shipper rows stay raw-only; consignees merge into location docs at davis__{histDocId(key)}; the log says complete', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows);
    const r = await callBackground({ batch_id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'complete');

    const locs = docsUnder(fake, 'shiplify_locations');
    const keys = locs.map(([, d]) => d.match_key).sort();
    assert.deepEqual(keys, [KEY_RESERVED, KEY_A, KEY_B, KEY_C].sort());
    assert.ok(!keys.includes(SHIPPER_KEY), 'Davis\'s own dock is never a delivery location');
    assert.equal(fake.store.get(locationPath('davis', SHIPPER_KEY)), undefined);
    // The Shipper rows are still in the raw layer, verbatim.
    const rawRows = docsUnder(fake, 'shiplify_raw').flatMap(([, d]) => d.rows);
    assert.equal(rawRows.filter((x) => x.entity === 'Shipper').length, 6);
    assert.deepEqual(rawRows, rows);

    // Path: davis__{histDocId(key)} — including the reserved "__…__" shape, which histDocId dodges.
    assert.match(KEY_RESERVED, /^__.*__$/, 'the fixture really does reach the reserved shape');
    assert.equal(histDocId(KEY_RESERVED), `x${KEY_RESERVED}`);
    const reserved = fake.store.get(`shiplify_locations/davis__x${KEY_RESERVED}`);
    assert.ok(reserved, 'written at the histDocId-safe id');
    assert.equal(reserved.match_key, KEY_RESERVED, 'the raw key rides as a field');
    for (const [path, d] of locs) assert.equal(path, `shiplify_locations/davis__${histDocId(d.match_key)}`);

    // Merge across the two PROs of one key.
    const a = fake.store.get(locationPath('davis', KEY_A));
    assert.equal(a.dock_access, 'yes', 'dock yes beats no');
    assert.equal(a.forklift, 'yes', 'forklift yes beats blank');
    assert.deepEqual(a.conflicts, { dock_access: ['no', 'yes'] }, 'the disagreement is on the record');
    assert.deepEqual(a.pros, ['1000001', '1000002']);
    assert.equal(a.stop_count, 2);
    assert.equal(a.first_date, '2026-08-17', 'Excel serial 46251');
    assert.equal(a.last_date, '2026-08-19');
    assert.equal(a.spellings.length, 2);
    assert.equal(a.batch_id, batch_id);
    assert.equal(a.tenant, 'davis');
    assert.equal(a.imported_at, fake.store.get(logPath(batch_id)).first_imported_at);
    assert.deepEqual(Object.keys(a).sort(), [
      'appointment_required', 'batch_id', 'call_box', 'city', 'conflicts', 'dock_access', 'first_date', 'forklift',
      'gated_access', 'imported_at', 'last_date', 'location_types', 'lumper', 'match_key', 'name', 'place_key', 'pros',
      'residential', 'residential_kind', 'security_hut', 'spellings', 'state', 'stop_count', 'street', 'tariff_items',
      'tenant', 'visible_location_types', 'zip',
    ]);

    // The NBSP PRO is read as the office would type it; its Excel date is a real date.
    const b = fake.store.get(locationPath('davis', KEY_B));
    assert.deepEqual(b.pros, ['SHP 00000.00']);
    assert.equal(b.first_date, '2026-08-21');
    const c = fake.store.get(locationPath('davis', KEY_C));
    assert.equal(c.residential, true);
    assert.equal(c.residential_kind, 'apartment');
    assert.equal(c.first_date, '2026-08-18', 'a serial that arrived as a string');

    // The log: verified by aggregation, derived summary, rejected rows with a labelled sample.
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'complete');
    assert.equal(log.verified.raw_chunks, 4);
    assert.equal(log.verified.raw_rows, 12);
    assert.equal(log.verified.locations_written, 4);
    assert.equal(log.verified.expected_locations, 4);
    assert.deepEqual(log.verified.failed, []);
    assert.ok(fake.log.aggregations.length >= 2, 'the counts came from Firestore aggregation reads');
    assert.equal(log.derived.rows, 12);
    assert.equal(log.derived.shipper, 6);
    assert.equal(log.derived.consignee, 6);
    assert.equal(log.derived.locationsByMatchKey, 4);
    assert.deepEqual(log.rejected.by_reason, { shipper_row: 6, no_name: 1 });
    assert.equal(log.rejected.total, 7);
    assert.deepEqual(log.rejected.sample, [{ index: 11, reason: 'no_name', pro: '1000006', name: '' }]);
    assert.equal(log.rejected.is_sample, false);
    assert.match(log.rejected.sample_note, /excluding shipper_row/);
    assert.equal(log.collisions.total, 1);
    assert.equal(log.collisions.sample[0].match_key, KEY_A);
    assert.equal(log.collisions.sample[0].spellings_total, 2);
    assert.equal(log.conflicts.total, 1);
    assert.deepEqual(log.conflicts.sample[0], { match_key: KEY_A, conflicts: { dock_access: ['no', 'yes'] } });
    assert.equal(log.index.locations, 4);
    assert.ok(log.finished_at);
    assert.equal(log.error, null);
    assert.equal(fake.log.other.length, 0, 'no call left Firestore');
  });
});

test('process: a missing raw chunk FAILS the import, names the chunk, and writes no location', async () => {
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile(), { chunkSize: 3, skip: [2] });
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'failed');
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'failed');
    assert.deepEqual(log.missing_chunks, [2]);
    assert.match(log.error, /missing raw chunk 2 of 0\.\.3/);
    assert.equal(docsUnder(fake, 'shiplify_locations').length, 0);
    assert.equal(fake.store.get(indexHeadPath('davis')), undefined);
  });
});

test('process: when Firestore counts FEWER locations than were derived, the verdict is mismatch — never complete', async () => {
  // A lost write: every commit returned 200 and one document is not there. Only a count read
  // back from the database can tell; the writer's own tally would say everything landed.
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'mismatch');
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'mismatch');
    assert.deepEqual(log.verified.failed, ['locations']);
    assert.equal(log.verified.expected_locations, 4);
    assert.equal(log.verified.locations_written, 3);
  }, { aggregate: (q, res) => (q.collection === 'shiplify_locations' ? { count: res.count - 1 } : null) });
});

test('process: a stray raw chunk under the batch makes the RAW count disagree — mismatch, and nothing derived is written', async () => {
  const rows = sampleFile();
  const batch_id = shiplifyBatchId(rows);
  const stray = { [`shiplify_raw/${batch_id}__0099`]: { tenant: 'davis', batch_id, chunk_index: 99, row_start: 99, row_count: 1, rows: [row()], content_hash: 'x' } };
  await withFake(stray, async (fake) => {
    await sendFile(rows);
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'mismatch');
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'mismatch');
    assert.deepEqual(log.verified.failed, ['raw_chunks', 'raw_rows']);
    assert.match(log.error, /nothing was written to shiplify_locations/);
    assert.equal(docsUnder(fake, 'shiplify_locations').length, 0, 'no location derived from a raw layer Firestore will not vouch for');
  });
});

test('process: if Firestore refuses the SUM aggregation, the rows check says it fell back to the direct read, and why', async () => {
  // Whether sum(row_count) under a batch_id equality needs a composite index cannot be shown
  // from this repo. If it does, the import must neither die nor pretend: the log names the
  // source that answered and carries Firestore's own refusal (which links to the index).
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'complete');
    const rowsCheck = fake.store.get(logPath(batch_id)).verified.checks.find((c) => c.name === 'raw_rows');
    assert.equal(rowsCheck.source, 'direct_read');
    assert.equal(rowsCheck.actual, 12);
    assert.match(rowsCheck.aggregation_error, /index required/);
    const countCheck = fake.store.get(logPath(batch_id)).verified.checks.find((c) => c.name === 'raw_chunks');
    assert.equal(countCheck.source, 'aggregation_count', 'the count still came from Firestore');
  }, { aggregate: (q, res) => { if ('row_count' in res.sums) throw new Error('FAILED_PRECONDITION: index required'); return null; } });
});

test('process: a second run while the first is still inside its budget is refused, and so is a re-begin — the index would interleave two generations', async () => {
  const rows = sampleFile();
  const batch_id = shiplifyBatchId(rows);
  const live = new Date(Date.now() - 60_000).toISOString();
  await withFake({}, async (fake) => {
    await sendFile(rows);
    const log = fake.store.get(logPath(batch_id));
    fake.store.set(logPath(batch_id), { ...log, status: 'processing', processing_started_at: live });
    const r = await callBackground({ batch_id });
    assert.equal(r.status, 409);
    assert.equal(fake.store.get(logPath(batch_id)).status, 'processing', 'the running job\'s status is left alone');
    assert.equal(docsUnder(fake, 'shiplify_locations').length, 0);
    const b = await callImport({ action: 'begin', batch_id, row_count: 12, raw_chunk_count: 4, file_name: 'f', sheet: 's' });
    assert.equal(b.status, 409);
    assert.match(b.body.error, /being processed right now/);
    // A 'processing' older than the fifteen-minute budget is a run the platform killed.
    fake.store.set(logPath(batch_id), { ...fake.store.get(logPath(batch_id)), processing_started_at: '2026-01-01T00:00:00.000Z' });
    const again = await callBackground({ batch_id });
    assert.equal(again.body.status, 'complete');
  });
});

test('re-importing the identical file writes byte-identical location documents', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows);
    await callBackground({ batch_id });
    const locWrites = () => fake.log.commits.flatMap((c) => c.writes || [])
      .filter((w) => /\/shiplify_locations\//.test(w.update?.name || ''))
      .map((w) => JSON.stringify(w));
    const firstDocs = JSON.stringify(docsUnder(fake, 'shiplify_locations'));
    const firstWrites = locWrites();
    const firstGen = fake.store.get(indexHeadPath('davis')).generation;
    fake.log.commits.length = 0;

    const again = await sendFile(JSON.parse(JSON.stringify(rows)));
    assert.equal(again.batch_id, batch_id, 'the same file is the same batch');
    assert.equal(again.begin.attempts, 2);
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'complete');
    assert.equal(JSON.stringify(docsUnder(fake, 'shiplify_locations')), firstDocs, 'stored docs identical');
    assert.deepEqual(locWrites(), firstWrites, 'and the bytes sent to Firestore identical');
    assert.equal(docsUnder(fake, 'shiplify_raw').length, 4, 'the replayed chunks did not add raw docs');
    const { head } = readIndex(fake);
    assert.notEqual(head.generation, firstGen, 'the index is a new build (so a reader can tell), of the same lines');
  });
});

test('the index: every chunk is written IN THE SAME COMMIT as the head, the head\'s generation matches, and it decodes back to every location', async () => {
  // Enough locations for two index chunks and several 500-write commits.
  const n = INDEX_LINES_PER_DOC + 150;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(shipper(String(2000000 + i)));
    rows.push(row({
      pro_number: String(2000000 + i), name: `Invented Customer ${i}`, street_address: `${i} Sample Pkwy`,
      postal_code: '30000', dock_access: i % 3 === 0 ? 'yes' : i % 3 === 1 ? 'no' : '', gated_access: i % 5 === 0 ? 'partial' : 'no',
      tariff_items: i % 7 === 0 ? 'RES' : '',
    }));
  }
  // A stale chunk from an imagined earlier, larger build: left in place, never read.
  const seed = { [indexChunkPath('davis', 7)]: { tenant: 'davis', generation: 'old', chunk_index: 7, lines: ['stale\tline\t-------\t\t'] } };
  await withFake(seed, async (fake) => {
    const { batch_id } = await sendFile(rows, { chunkSize: 1000 });
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'complete', JSON.stringify(r.body));
    assert.equal(docsUnder(fake, 'shiplify_locations').length, n);

    // ORDER: find the commit that carried each index doc.
    const commitOf = (path) => fake.log.commits.findIndex((c) => (c.writes || []).some((w) => (w.update?.name || '').endsWith(`/documents/${path}`)));
    const headAt = commitOf(indexHeadPath('davis'));
    const { head, records } = readIndex(fake);
    assert.equal(head.chunks, 2);
    // ONE commit: a head can never be published over chunks of another build, nor chunks under an old head.
    for (let i = 0; i < head.chunks; i++) assert.equal(commitOf(indexChunkPath('davis', i)), headAt, `chunk ${i} rides in the head's commit`);
    assert.equal(fake.log.commits[headAt].writes.length, head.chunks + 1, 'that commit is the whole index and nothing else');
    const locCommits = fake.log.commits.filter((c) => (c.writes || []).some((w) => /shiplify_locations/.test(w.update?.name || '')));
    assert.ok(locCommits.every((c) => c.writes.length <= 500), 'no commit over 500 writes');

    // Decodes back to every stored location, and nothing else.
    assert.equal(head.locations, n);
    assert.deepEqual(head.batch_ids, [batch_id]);
    assert.ok(records.every(Boolean), 'every line decodes');
    const stored = new Map(docsUnder(fake, 'shiplify_locations').map(([, d]) => [d.match_key, d]));
    assert.deepEqual(records.map((x) => x.match_key).sort(), [...stored.keys()].sort());
    for (const rec of records.slice(0, 50)) {
      const d = stored.get(rec.match_key);
      for (const f of ['place_key', 'dock_access', 'forklift', 'gated_access', 'batch_id', 'last_date']) assert.deepEqual(rec[f], d[f], f);
      assert.deepEqual(rec.tariff_items, d.tariff_items);
    }
    const stale = fake.store.get(indexChunkPath('davis', 7));
    assert.equal(stale.generation, 'old', 'a stale chunk is not deleted — the head\'s count and generation make it unreadable');
    assert.notEqual(stale.generation, head.generation);
    const log = fake.store.get(logPath(batch_id));
    assert.deepEqual(log.index, { chunks: 2, locations: n, generation: head.generation });
  });
});

test('buildIndexDocs: another tenant\'s docs and a doc with no match key are left out, and the head says how many locations it holds', () => {
  const listing = [
    { _id: 'davis__b', match_key: 'b', batch_id: 'shp_2' },
    { _id: 'davis__a', match_key: 'a', batch_id: 'shp_1' },
    { _id: 'uline__z', match_key: 'z', batch_id: 'shp_9' },
    { _id: 'davis__broken' },
  ];
  const idx = buildIndexDocs(listing, { generation: 'g1', built_at: '2026-09-01T00:00:00Z' });
  assert.deepEqual(idx.lines.map((l) => l.split('\t')[0]), ['a', 'b'], 'sorted by match key');
  assert.equal(idx.skippedMalformed, 1);
  assert.deepEqual(idx.head.data, { tenant: 'davis', generation: 'g1', chunks: 1, locations: 2, batch_ids: ['shp_1', 'shp_2'], built_at: '2026-09-01T00:00:00Z' });
  assert.equal(idx.chunks[0].path, 'shiplify_index/davis__0');
  assert.equal(idx.head.path, 'shiplify_index/davis');
  const empty = buildIndexDocs([], { generation: 'g', built_at: 't' });
  assert.equal(empty.chunks.length, 0);
  assert.equal(empty.head.data.chunks, 0);
});

test('index chunks close on bytes as well as lines, so a long-typed location cannot push one past Firestore\'s 1 MiB', () => {
  assert.deepEqual(chunkLinesByBytes(['a', 'b', 'c'], 2, 1000).map((c) => c.length), [2, 1]);
  assert.deepEqual(chunkLinesByBytes(['aaaa', 'bbbb', 'cccc'], 100, 10).map((c) => c.length), [1, 1, 1]);
  assert.deepEqual(chunkLinesByBytes(['x'.repeat(50)], 100, 10).map((c) => c.length), [1], 'one line always fits');
  assert.deepEqual(chunkLinesByBytes([], 10, 10), []);
  const types = Array.from({ length: 40 }, (_, i) => `Invented Location Type Number ${i}`);
  const listing = Array.from({ length: 2400 }, (_, i) => ({ _id: `davis__k${String(i).padStart(5, '0')}`, match_key: `k${String(i).padStart(5, '0')}`, location_types: types, batch_id: 'shp_1' }));
  const idx = buildIndexDocs(listing, { generation: 'g', built_at: 't' });
  assert.ok(idx.chunks.length > 1, 'fewer than INDEX_LINES_PER_DOC lines, still split by size');
  for (const c of idx.chunks) assert.ok(Buffer.byteLength(JSON.stringify(c.data.lines)) < 1024 * 1024);
  assert.equal(idx.chunks.reduce((n, c) => n + c.data.lines.length, 0), 2400);
  assert.equal(idx.head.data.chunks, idx.chunks.length);
});

test('a rejected-row sample is capped at 200 and SAYS it is a sample', async () => {
  const rows = [];
  for (let i = 0; i < SAMPLE_CAP + 25; i++) rows.push(row({ pro_number: String(3000000 + i), name: '' }));
  rows.push(row());
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(rows, { chunkSize: 100 });
    await callBackground({ batch_id });
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.rejected.by_reason.no_name, SAMPLE_CAP + 25, 'the COUNT is complete');
    assert.equal(log.rejected.sample.length, SAMPLE_CAP);
    assert.equal(log.rejected.is_sample, true);
    assert.equal(log.rejected.sample_of, SAMPLE_CAP + 25);
  });
});

test('dry run: reads and verifies, derives the locations, writes NOTHING but log.dry_run — status untouched', async () => {
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const r = await callBackground({ batch_id, dry: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.dry, true);
    assert.equal(r.body.would_write, 4);
    assert.equal(r.body.raw_rows, 12);
    assert.equal(r.body.ok, true);
    assert.equal(docsUnder(fake, 'shiplify_locations').length, 0);
    assert.equal(fake.store.get(indexHeadPath('davis')), undefined);
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'receiving', 'a dry run is not a run');
    assert.equal(log.dry_run.would_write, 4);
    assert.deepEqual(log.dry_run.skipped_by_reason, { shipper_row: 6, no_name: 1 });
    const explain = await get(`batch_id=${batch_id}&explain=1`);
    assert.equal(explain.status, 200);
    assert.equal(explain.body.dry_run.would_write, 4);
    assert.match(explain.body.plan.locations, /davis__\{histDocId\(match_key\)\}/);
    assert.equal(explain.body.nuvizzCalls, 0);
    assert.equal(explain.body.lease, null, 'nobody holds the run lease — and explain can say who does');
  });
});

// ── GET ──────────────────────────────────────────────────────────────────────

test('GET returns the log for a batch, 404 for an unknown one, and ?latest=1 the most recently started import', async () => {
  await withFake({}, async () => {
    const none = await get('latest=1');
    assert.deepEqual(none.body, { ok: true, none: true });
    const { batch_id } = await sendFile(sampleFile());
    await callBackground({ batch_id });
    const one = await get(`batch_id=${batch_id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.ok, true);
    assert.equal(one.body.batch_id, batch_id);
    assert.equal(one.body.status, 'complete');
    assert.equal(one.body.verified.locations_written, 4);
    const unknown = await get('batch_id=shp_ffffffffffffffff');
    assert.equal(unknown.status, 404);
    const bad = await get('batch_id=../x');
    assert.equal(bad.status, 400);

    await new Promise((res) => setTimeout(res, 5));
    const second = await sendFile([row({ pro_number: '4000001', name: 'Later Invented Co', street_address: '3 Fake St' })], { chunkSize: 1 });
    const latest = await get('latest=1');
    assert.equal(latest.body.batch_id, second.batch_id);
    assert.equal(latest.body.status, 'receiving');
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

const VIEWER = { username: 'ro', displayName: 'Ro', role: 'viewer', active: true, tokenVersion: 0 };
const bearer = (u) => ({ authorization: `Bearer ${issueSessionToken(u).token}` });

test('with login REQUIRED: an anonymous POST is refused before anything is stored, and a viewer may read but not write', async () => {
  process.env.AUTH_REQUIRED = 'true';
  try {
    await withFake({ 'app_users/ro': VIEWER }, async (fake) => {
      const rows = sampleFile();
      const batch_id = shiplifyBatchId(rows);
      const anon = await callImport({ action: 'begin', batch_id, row_count: 12, raw_chunk_count: 4 });
      assert.equal(anon.status, 401);
      const anonRaw = await callImport({ action: 'raw', batch_id, chunk_index: 0, row_start: 0, rows });
      assert.equal(anonRaw.status, 401);
      assert.equal(fake.store.get(logPath(batch_id)), undefined);
      assert.equal(docsUnder(fake, 'shiplify_raw').length, 0);

      const viewerPost = await callImport({ action: 'begin', batch_id, row_count: 12, raw_chunk_count: 4 }, bearer(VIEWER));
      assert.equal(viewerPost.status, 403, 'a viewer cannot load a file into Firestore');
      const anonGet = await get(`batch_id=${batch_id}`);
      assert.equal(anonGet.status, 401);
      const viewerGet = await get(`batch_id=${batch_id}`, bearer(VIEWER));
      assert.equal(viewerGet.status, 404, 'past the gate: a viewer may read the log (there is none yet)');
    });
  } finally { delete process.env.AUTH_REQUIRED; }
});

test('with login REQUIRED: an anonymous background run is refused, and the refusal lands on the log the screen polls — never on a finished one', async () => {
  const rows = sampleFile();
  const batch_id = shiplifyBatchId(rows);
  const other = 'shp_00000000000000bb';
  const seed = {
    [logPath(batch_id)]: { tenant: 'davis', batch_id, status: 'receiving', row_count: 12, raw_chunk_count: 4, first_imported_at: '2026-09-01T00:00:00.000Z', attempts: 1 },
    [logPath(other)]: { tenant: 'davis', batch_id: other, status: 'complete', row_count: 2, raw_chunk_count: 1, first_imported_at: '2026-08-01T00:00:00.000Z', attempts: 1 },
  };
  process.env.AUTH_REQUIRED = 'true';
  try {
    await withFake(seed, async (fake) => {
      const r = await callBackground({ batch_id });
      assert.equal(r.status, 401);
      const log = fake.store.get(logPath(batch_id));
      assert.equal(log.status, 'failed', 'terminal, so the screen stops polling');
      assert.match(log.error, /Refused/);
      assert.equal(log.first_imported_at, '2026-09-01T00:00:00.000Z', 'field-masked: the rest of the log survives');
      assert.equal(docsUnder(fake, 'shiplify_locations').length, 0);

      const done = await callBackground({ batch_id: other });
      assert.equal(done.status, 401);
      assert.equal(fake.store.get(logPath(other)).status, 'complete', 'an anonymous POST cannot turn a finished import into a failed one');

      const ghost = await callBackground({ batch_id: 'shp_00000000000000cc' });
      assert.equal(ghost.status, 401);
      assert.equal(fake.store.get(logPath('shp_00000000000000cc')), undefined, 'a refusal never creates a log at a caller-chosen id');
      const ledger = [...fake.store.keys()].filter((k) => k.startsWith('nuvizz_ops/background_refusals/rows/'));
      assert.ok(ledger.length >= 1, 'and the shared refusal ledger has it');
    });
  } finally { delete process.env.AUTH_REQUIRED; }
});

test('with login OFF (today): the gates are inert and the legacy principal runs the import', async () => {
  delete process.env.AUTH_REQUIRED;
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'complete');
    assert.equal([...fake.store.keys()].filter((k) => k.startsWith('nuvizz_ops/background_refusals/')).length, 0);
  });
});

// ── review findings (Sep 2026) — each test below failed against the code before its fix ──────

/** Stand in front of the fake's fetch: `fn(url, init, next)` answers, or passes on with next(init). */
function intercept(fn) {
  const inner = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => fn(String(input?.url ?? input), init, (i2 = init) => inner(input, i2));
}
const commitWrites = (url, init) => (url.includes('/documents:commit') ? (JSON.parse(String(init.body || '{}')).writes || []) : []);
const writesTo = (url, init, coll) => commitWrites(url, init).some((w) => (w.update?.name || '').includes(`/documents/${coll}/`));
const unavailable = () => Promise.resolve(new Response('{"error":{"status":"UNAVAILABLE","message":"try again"}}', { status: 503 }));
const LOCK = 'shiplify_imports/davis__lock';
const VERDICT = ['verified', 'index', 'derived', 'rejected', 'collisions', 'conflicts', 'finished_at'];

test('a FAILED re-run carries only what that run observed — the earlier verdict moves to previous_verdict, never under "Failed:"', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows);
    assert.equal((await callBackground({ batch_id })).body.status, 'complete');
    await sendFile(rows);
    intercept((url, init, next) => (writesTo(url, init, 'shiplify_locations') ? unavailable() : next()));
    const r = await callBackground({ batch_id });
    assert.equal(r.status, 500);
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'failed');
    assert.match(log.error, /batchWriteDocs commit 1\/1 failed/);
    for (const f of VERDICT) assert.equal(log[f], null, `${f} is this run's, and this run observed none`);
    assert.equal(log.previous_verdict.status, 'complete', 'the earlier verdict is kept, labelled as earlier');
    assert.equal(log.previous_verdict.verified.locations_written, 4);
  });
});

test('an abandoned re-begin does not leave the old counts beside "receiving", and a later complete run clears an old refusal', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows);
    await callBackground({ batch_id });
    await sendFile(rows);
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'receiving');
    for (const f of VERDICT) assert.equal(log[f], null, f);
    assert.equal(log.previous_verdict.status, 'complete');
    fake.store.set(logPath(batch_id), { ...log, refused: { reason: 'no-token', at: '2026-09-01T00:00:00.000Z' } });
    assert.equal((await callBackground({ batch_id })).body.status, 'complete');
    assert.equal(fake.store.get(logPath(batch_id)).refused, null);
  });
});

test('two DIFFERENT files at once: the second is refused on ITS OWN log (terminal, names the one running); the first completes and the lease is released', async () => {
  await withFake({}, async (fake) => {
    const a = await sendFile(sampleFile());
    const bRows = [row({ pro_number: '5000001', name: 'Other Invented Co', street_address: '8 Fake St' })];
    const b = await sendFile(bRows, { chunkSize: 1 });
    let release;
    const gate = new Promise((res) => { release = res; });
    let held = false;
    intercept(async (url, init, next) => {
      if (!held && writesTo(url, init, 'shiplify_locations')) { held = true; await gate; }
      return next();
    });
    const runA = callBackground({ batch_id: a.batch_id });
    while (!held) await new Promise((res) => setTimeout(res, 1));
    const rb = await callBackground({ batch_id: b.batch_id });
    assert.equal(rb.status, 409, JSON.stringify(rb.body));
    const logB = fake.store.get(logPath(b.batch_id));
    assert.equal(logB.status, 'failed', 'terminal, so the screen polling B stops and says why');
    assert.match(logB.error, /another Shiplify import/);
    assert.equal(logB.blocked_by.batch_id, a.batch_id);
    release();
    assert.equal((await runA).body.status, 'complete');
    assert.equal(fake.store.get(LOCK), undefined, 'released when the verdict is written');
    await sendFile(bRows, { chunkSize: 1 });
    assert.equal((await callBackground({ batch_id: b.batch_id })).body.status, 'complete');
    const { head } = readIndex(fake);
    assert.deepEqual(head.batch_ids, [a.batch_id, b.batch_id].sort(), 'the index holds both files');
  });
});

test('two kicks of the SAME batch at once: exactly one runs; the other is refused and leaves the log to the one running', async () => {
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const both = await Promise.all([callBackground({ batch_id }), callBackground({ batch_id })]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
    assert.equal(fake.store.get(logPath(batch_id)).status, 'complete');
    const claims = (fake.log.patches || []).filter((p) => p.path === logPath(batch_id) && p.fields.status === 'processing');
    assert.equal(claims.length, 1, 'one processing claim');
  });
});

test('a lease left by a run the platform killed is taken over once stale — once only — and ?latest=1 is not confused by it', async () => {
  const stale = { tenant: 'davis', batch_id: 'shp_00000000000000dd', token: 'tok_killed', at: '2026-01-01T00:00:00.000Z' };
  await withFake({ [LOCK]: stale }, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    assert.equal((await callBackground({ batch_id })).body.status, 'complete');
    assert.equal(fake.store.get(LOCK), undefined);
    const latest = await get('latest=1');
    assert.equal(latest.body.batch_id, batch_id);
  });
  // Another contender already claimed the takeover of THAT stale lease: this one must not.
  await withFake({ [LOCK]: stale, [`${LOCK}_takeover_tok_killed`]: { at: '2026-09-01T00:00:00.000Z' } }, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const r = await callBackground({ batch_id });
    assert.equal(r.status, 409);
    assert.equal(docsUnder(fake, 'shiplify_locations').length, 0);
  });
});

test('the index is published in ONE commit: a re-run whose head write fails leaves the PREVIOUS index whole', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const { batch_id } = await sendFile(rows);
    await callBackground({ batch_id });
    const first = readIndex(fake).head.generation;
    await sendFile(rows);
    intercept((url, init, next) => (commitWrites(url, init).some((w) => (w.update?.name || '').endsWith(`/documents/${indexHeadPath('davis')}`)) ? unavailable() : next()));
    const r = await callBackground({ batch_id });
    assert.equal(r.status, 500);
    const { head } = readIndex(fake);
    assert.equal(head.generation, first, 'no chunk of the failed build sits under the old head');
    assert.equal(fake.store.get(logPath(batch_id)).status, 'failed');
  });
});

test('the index is verified by READING IT BACK: a chunk that did not land is a mismatch, and "locations the maps will read" is what a reader gets', async () => {
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    intercept((url, init, next) => {
      if (!writesTo(url, init, 'shiplify_index')) return next();
      const body = JSON.parse(String(init.body));
      body.writes = body.writes.filter((w) => !w.update.name.endsWith(`/documents/${indexChunkPath('davis', 0)}`));
      return next({ ...init, body: JSON.stringify(body) });
    });
    const r = await callBackground({ batch_id });
    assert.equal(r.body.status, 'mismatch');
    const log = fake.store.get(logPath(batch_id));
    assert.ok(log.verified.failed.includes('index_chunks'), JSON.stringify(log.verified.failed));
    assert.equal(log.index.locations, 0, 'the map reads nothing from a head whose chunk is missing');
  });
});

test('a failure on the FIRST read of the log still ends that log at failed — and never creates one', async () => {
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    const ghost = 'shp_00000000000000ee';
    const failed = new Set();
    intercept((url, init, next) => {
      const m = url.match(/\/documents\/(shiplify_imports\/shp_[0-9a-f]{16})$/);
      if (m && (init.method || 'GET') === 'GET' && !failed.has(m[1])) { failed.add(m[1]); return unavailable(); }
      return next();
    });
    const r = await callBackground({ batch_id }).catch((e) => ({ threw: String(e) }));
    assert.equal(r.status, 500, JSON.stringify(r));
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.status, 'failed');
    assert.match(log.error, /getDoc/);
    await callBackground({ batch_id: ghost }).catch(() => null);
    assert.equal(fake.store.get(logPath(ghost)), undefined, 'a failure write never mints a log');
  });
});

test('integers outside int64 are written as doubles, not as integerValue strings Firestore cannot hold — and the file still imports', async () => {
  const fields = buildBatchWriteBodies('db', [{ path: 'c/a', data: { big: 1e19, huge: 1e21, neg: -1e19, ok: 12, edge: 2 ** 62 } }])[0].writes[0].update.fields;
  assert.deepEqual(fields.big, { doubleValue: 1e19 });
  assert.deepEqual(fields.huge, { doubleValue: 1e21 });
  assert.deepEqual(fields.neg, { doubleValue: -1e19 });
  assert.deepEqual(fields.ok, { integerValue: '12' }, 'an ordinary integer is unchanged');
  assert.deepEqual(fields.edge, { integerValue: String(2 ** 62) }, 'inside int64 is unchanged');
  await withFake({}, async (fake) => {
    const rows = [shipper('1000001'), row({ shipment_location_id: 1e19 }), shipper('1000002'), row({ pro_number: '1000002', shipment_location_id: 1e21 })];
    const { batch_id } = await sendFile(rows, { chunkSize: 4 });
    assert.equal((await callBackground({ batch_id })).body.status, 'complete');
    assert.deepEqual(fake.store.get(rawPath(batch_id, 0)).rows, rows, 'verbatim, the big numbers too');
  });
});

test('begin may change the split while NOTHING of the batch is stored (the way out of a 413), and not once a chunk is', async () => {
  await withFake({}, async (fake) => {
    const rows = sampleFile();
    const batch_id = shiplifyBatchId(rows);
    const b = (raw_chunk_count, row_count = 12) => callImport({ action: 'begin', batch_id, row_count, raw_chunk_count, file_name: 'f.xls', sheet: 's' });
    assert.equal((await b(1)).status, 200);
    const re = await b(3);
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal(fake.store.get(logPath(batch_id)).raw_chunk_count, 3);
    assert.equal((await callImport({ action: 'raw', batch_id, chunk_index: 0, row_start: 0, rows: rows.slice(0, 4) })).status, 200);
    const late = await b(4);
    assert.equal(late.status, 409);
    assert.match(late.body.error, /already stored/);
    assert.match((await b(3, 13)).body.error, /hash of the rows/, 'a different ROW count is still a bug, stored or not');
    const fat = validateRaw({ batch_id, chunk_index: 0, row_start: 0, rows: Array.from({ length: 1000 }, (_, i) => row({ pro_number: String(i), name: 'n'.repeat(1000) })) });
    assert.match(fat.error, /before any chunk of this batch is stored/, 'the 413 no longer tells the client to do what begin then refuses');
  });
});

test('a dry run that FAILS says so in dry_run — the last good dry run is not left standing as the answer', async () => {
  let broken = false;
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    assert.equal((await callBackground({ batch_id, dry: true })).body.ok, true);
    broken = true;
    const r = await callBackground({ batch_id, dry: true });
    assert.equal(r.status, 500);
    const log = fake.store.get(logPath(batch_id));
    assert.equal(log.dry_run.ok, false);
    assert.match(log.dry_run.error, /boom/, 'the aggregation failure itself');
    assert.equal(log.status, 'receiving', 'still not a run');
  }, { aggregate: () => { if (broken) throw new Error('boom'); return null; } });
});

test('with login REQUIRED: a refused DRY run lands in dry_run and never fails the import it was looking at', async () => {
  const rows = sampleFile();
  const batch_id = shiplifyBatchId(rows);
  const seed = { [logPath(batch_id)]: { tenant: 'davis', batch_id, status: 'receiving', row_count: 12, raw_chunk_count: 4, first_imported_at: '2026-09-01T00:00:00.000Z', attempts: 1 } };
  process.env.AUTH_REQUIRED = 'true';
  try {
    await withFake(seed, async (fake) => {
      const r = await callBackground({ batch_id, dry: true });
      assert.equal(r.status, 401);
      const log = fake.store.get(logPath(batch_id));
      assert.equal(log.status, 'receiving', 'the upload in progress is untouched');
      assert.equal(log.error, undefined);
      assert.equal(log.dry_run.ok, false);
      assert.match(log.dry_run.error, /Refused/);
    });
  } finally { delete process.env.AUTH_REQUIRED; }
});

test('the rejected-row sample says plainly that its index is NOT the spreadsheet row', async () => {
  await withFake({}, async (fake) => {
    const { batch_id } = await sendFile(sampleFile());
    await callBackground({ batch_id });
    assert.match(fake.store.get(logPath(batch_id)).rejected.sample_note, /not the spreadsheet row/i);
  });
});

test('batchWriteDocs {single:true} refuses BEFORE sending anything when the items need more than one commit', async () => {
  await withFake({}, async (fake) => {
    const items = [{ path: 'c/a', data: { i: 1 } }, { path: 'c/b', data: { i: 2 } }, { path: 'c/c', data: { i: 3 } }];
    await assert.rejects(batchWriteDocs(items, { single: true, maxWrites: 2 }), /ONE atomic commit — nothing was written/);
    assert.equal(fake.log.commits.length, 0);
    assert.deepEqual(await batchWriteDocs(items, { single: true }), { commits: 1, acknowledged: 3 });
  });
});
