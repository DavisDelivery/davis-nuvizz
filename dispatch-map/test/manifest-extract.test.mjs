// test/manifest-extract.test.mjs — pure manifest-OCR JSON parsing + row normalization,
// plus the client-side aoa bridge into the Bulk Add importer. Fixture values mirror the
// real Estes manifest 047-52228 this feature was built against (scanned fax, no text).
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJsonBlock, normalizeManifestRows } from '../netlify/functions/lib/manifest-extract.mts';
import { manifestRowsToAoa, manifestRowsToIntake, autoMapColumns, mappedRowsToOrders, bulkRowMissing, bulkRowIsBlank, BULK_FIELDS } from '../src/lib/bulk-orders.js';

const ROW = (over = {}) => ({
  name: 'JASMINE LEWIS', addr1: '306 GWINNETT SQUARE CIR', addr2: null,
  city: 'DULUTH', state: 'GA', zip: '30096',
  units: 1, weight: 566, description: '1 BX GNT4632-C (86X30X26); STC 3 BOXES',
  proPrinted: '028-8347656', proDigits: '0288347656',
  ...over,
});

test('extractJsonBlock: bare JSON, fenced JSON, prose-wrapped; null on garbage', () => {
  assert.deepEqual(extractJsonBlock('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonBlock('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonBlock('Here you go:\n{"a":1}\nDone.'), { a: 1 });
  assert.equal(extractJsonBlock('no json here'), null);
  assert.equal(extractJsonBlock(''), null);
});

test('normalizeManifestRows: clean manifest → rows, no warnings', () => {
  const { manifest, rows, warnings } = normalizeManifestRows({
    carrier: 'Estes Express Lines', manifestNumber: '047-52228', manifestDate: '7/14/26', totalPros: 2,
    rows: [ROW(), ROW({ name: 'RAFAEL LIRIANO', addr1: '3355 KATES WAY', zip: '30097', proPrinted: '030-1352477', proDigits: '0301352477', weight: 187 })],
  });
  assert.equal(manifest.manifestNumber, '047-52228');
  assert.equal(manifest.totalPros, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(warnings, []);
  assert.equal(rows[0].proDigits, '0288347656');
});

test('normalizeManifestRows: printed-vs-barcode PRO mismatch keeps barcode + warns', () => {
  const { rows, warnings } = normalizeManifestRows({ totalPros: 1, rows: [ROW({ proPrinted: '028-8347657', proDigits: '0288347656' })] });
  assert.equal(rows[0].proDigits, '0288347656');
  assert.ok(warnings.some((w) => w.includes('PRO mismatch')));
});

test('normalizeManifestRows: barcode missing → falls back to printed digits', () => {
  const { rows, warnings } = normalizeManifestRows({ totalPros: 1, rows: [ROW({ proDigits: null })] });
  assert.equal(rows[0].proDigits, '0288347656');   // digits of '028-8347656'
  assert.deepEqual(warnings, []);
});

test('normalizeManifestRows: count mismatch vs Total Pros header warns; empty rows skipped; dup PROs flagged', () => {
  const { rows, warnings } = normalizeManifestRows({
    totalPros: 3,
    rows: [ROW(), { name: '', addr1: '' }, ROW({ addr1: '999 OTHER RD' })],
  });
  assert.equal(rows.length, 2);                    // empty skipped
  assert.ok(warnings.some((w) => w.includes('header says 3')));
  assert.ok(warnings.some((w) => w.includes('duplicate PRO')));
});

test('normalizeManifestRows: never throws on junk; missing ZIP warns', () => {
  const { rows, warnings } = normalizeManifestRows({ rows: [ROW({ zip: '' }), { name: 'X ONLY' }] });
  assert.equal(rows.length, 2);
  assert.ok(warnings.some((w) => w.includes('ZIP')));
});

test('manifestRowsToIntake: intake rows carry the grid field keys + intake bookkeeping, start unchecked/held, and validate ready', () => {
  const [row] = manifestRowsToIntake([ROW()], { prefix: 'ESTES-' });
  assert.equal(row.stopNbr, 'ESTES-0288347656');       // the board's existing convention
  assert.equal(row.pro, '0288347656');
  assert.equal(row.pallets, '1');                      // manifest Units → Pallets
  assert.equal(row.weight, '566');
  assert.equal(row.itemDesc, '1 BX GNT4632-C (86X30X26); STC 3 BOXES');
  assert.equal(row.phone, '');                         // entered at review time
  assert.equal(row.dispatchNotes, '');
  assert.equal(row._checked, false);                   // mockup: rows start unchecked ("check rows to push")
  assert.equal(row._status, 'held');
  assert.ok(row.id, 'stable row id for tab moves / edits');
  assert.deepEqual(bulkRowMissing(row), [], 'a clean manifest row lands push-ready');
  assert.equal(bulkRowIsBlank(row), false);
});

test('manifestRowsToAoa → autoMap → orders: full round-trip into StopRow shape', () => {
  const aoa = manifestRowsToAoa([ROW()], { prefix: 'ESTES-' });
  assert.equal(aoa.length, 2);
  assert.equal(aoa[0].length, BULK_FIELDS.length);           // header covers every field
  const mapping = autoMapColumns(aoa[0]);
  // every column of the generated header must auto-map (labels are their own aliases)
  assert.equal(Object.keys(mapping).length, BULK_FIELDS.length);
  const [order] = mappedRowsToOrders(aoa.slice(1), mapping);
  assert.equal(order.name, 'JASMINE LEWIS');
  assert.equal(order.addr1, '306 GWINNETT SQUARE CIR');
  assert.equal(order.zip, '30096');
  assert.equal(order.stopNbr, 'ESTES-0288347656');           // the board's existing convention
  assert.equal(order.pro, '0288347656');
  assert.equal(order.pallets, '1');                          // manifest Units → pallets
  assert.equal(order.weight, '566');
  assert.deepEqual(bulkRowMissing(order), []);               // row lands ready-to-create
});
