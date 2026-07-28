// test/manifest-extract.test.mjs — pure manifest-OCR JSON parsing + row normalization,
// plus the client-side aoa bridge into the Bulk Add importer. Fixture values mirror the
// real Estes manifest 047-52228 this feature was built against (scanned fax, no text).
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJsonBlock, extractManifestJson, repairInnerQuotes, normalizeManifestRows, MANIFEST_PROMPT } from '../netlify/functions/lib/manifest-extract.mts';
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

// ── Malformed-response recovery ───────────────────────────────────────────────
// Regression suite for the 7/28 double-manifest drop. Real manifest 047-54026's first
// consignee (DELMAR GARDENS OF GWINNETT) carries an INCH MARK in its Description —
// `TEM130BKWY 20" WIDE ELECTRIC COIL R`. Emitted unescaped, that one character ended the
// JSON string early, JSON.parse died, and all 24 orders were thrown away with the message
// "The reader returned no usable JSON — try the drop again" — advice that could never work,
// because the same PDF fails identically every time.

test('repairInnerQuotes: escapes an inch mark inside a value, leaves clean JSON untouched', () => {
  const clean = '{"description":"6 PC FLOORING (75X45X14)","units":2}';
  assert.equal(repairInnerQuotes(clean).text, clean);
  assert.equal(repairInnerQuotes(clean).escaped, 0);
  const broken = '{"description":"TEM130BKWY 20" WIDE ELECTRIC COIL R","units":1}';
  const { text, escaped } = repairInnerQuotes(broken);
  assert.equal(escaped, 1);
  assert.equal(JSON.parse(text).description, 'TEM130BKWY 20" WIDE ELECTRIC COIL R');
  // An already-escaped quote must not be double-escaped.
  const ok = '{"description":"20\\" WIDE"}';
  assert.equal(repairInnerQuotes(ok).escaped, 0);
  assert.equal(JSON.parse(repairInnerQuotes(ok).text).description, '20" WIDE');
});

test('extractManifestJson: the REAL 047-54026 inch-mark row no longer costs the manifest', () => {
  // Exactly what a reader emits for that page: row 1's inch mark unescaped.
  const bad = '{"carrier":"Estes Express Lines","manifestNumber":"047-54026","totalPros":2,"rows":['
    + '{"name":"DELMAR GARDENS OF GWINNETT","addr1":"3100 CLUB DR","addr2":"RUDY HOZIC","city":"LAWRENCEVILLE","state":"GA","zip":"30044","units":1,"weight":324,"description":"TEM130BKWY 20" WIDE ELECTRIC COIL R; Pcs = 2","proPrinted":"006-8370862","proDigits":"0068370862"},'
    + '{"name":"ZACH WHIGHAM","addr1":"670 SCALES ROAD","addr2":null,"city":"SUWANEE","state":"GA","zip":"30024","units":1,"weight":600,"description":"KD BED KIT 560850 079/34/16 1 PC","proPrinted":"024-8968735","proDigits":"0248968735"}]}';
  assert.equal(extractJsonBlock(bad), null, 'strict parse still fails — this is the bug');
  const { parsed, repairs } = extractManifestJson(bad);
  assert.ok(parsed, 'recovered');
  assert.equal(parsed.rows.length, 2, 'BOTH orders survive, not zero');
  assert.equal(parsed.rows[0].description, 'TEM130BKWY 20" WIDE ELECTRIC COIL R; Pcs = 2');
  assert.equal(parsed.manifestNumber, '047-54026');
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /quote mark/);
  const { rows, integrity } = normalizeManifestRows(parsed);
  assert.equal(rows.length, 2);
  assert.equal(integrity.shortBy, 0);
});

test('extractManifestJson: a response cut off mid-row keeps the complete rows', () => {
  const cut = '{"carrier":"Estes Express Lines","manifestNumber":"047-54019","totalPros":37,"rows":['
    + '{"name":"SAUNASPLUS","addr1":"5623 LAUREL LANE NW","city":"LILBURN","state":"GA","zip":"30047","units":1,"weight":225,"proDigits":"0080902781"},'
    + '{"name":"772 LESLIES","addr1":"7754 SPALDING DR","city":"PEACHTREE CORNERS","state":"GA","zip":"30092","units":1,"weight":95,"proDigits":"0100077237"},'
    + '{"name":"DENTAL EQUIPMENT & REP';   // ← cut here
  assert.equal(extractJsonBlock(cut), null);
  const { parsed, repairs } = extractManifestJson(cut);
  assert.ok(parsed, 'recovered the complete rows');
  assert.equal(parsed.rows.length, 2, 'the severed row is dropped, the good ones kept');
  assert.ok(repairs.some((r) => /CUT OFF/.test(r)), 'and it says so');
  // The header checksum then reports the shortfall loudly — 2 read vs 37 expected.
  const { integrity } = normalizeManifestRows(parsed);
  assert.equal(integrity.expectedPros, 37);
  assert.equal(integrity.readPros, 2);
  assert.equal(integrity.shortBy, 35);
});

test('extractManifestJson: clean JSON takes the strict path with no repairs claimed', () => {
  const good = '{"manifestNumber":"047-54019","totalPros":1,"rows":[' + JSON.stringify(ROW()) + ']}';
  const { parsed, repairs } = extractManifestJson(good);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(repairs, []);
  assert.equal(extractManifestJson('not json at all').parsed, null);
  assert.equal(extractManifestJson('').parsed, null);
});

test('normalizeManifestRows: a header echoed from the prompt shape is dropped, not trusted', () => {
  const { manifest, warnings } = normalizeManifestRows({
    manifestNumber: 'NNN-NNNNN', manifestDate: 'MM/DD/YY', manifestTime: 'HH:MM:SS', trailer: 'TTTTTT',
    totalPros: 1, rows: [ROW()],
  });
  assert.equal(manifest.manifestNumber, null, 'a placeholder never lands as a real manifest number');
  assert.equal(manifest.manifestDate, null);
  assert.equal(manifest.manifestTime, null);
  assert.equal(manifest.trailer, null);
  assert.equal(warnings.filter((w) => /echoed the example/.test(w)).length, 4);
});

test('normalizeManifestRows: integrity reports a shortfall separately from row warnings', () => {
  // 37 expected (real 047-54019), 2 read.
  const short = normalizeManifestRows({ totalPros: 37, totalUnits: 45, totalWeight: 15578, rows: [ROW(), ROW({ proDigits: '0100077237', proPrinted: '010-0077237' })] });
  assert.equal(short.integrity.shortBy, 35);
  assert.equal(short.integrity.unitsOk, false);
  assert.equal(short.integrity.weightOk, false);
  // A complete read reports no shortfall and clean checksums.
  const okRead = normalizeManifestRows({ totalPros: 1, totalUnits: 1, totalWeight: 566, rows: [ROW()] });
  assert.equal(okRead.integrity.shortBy, 0);
  assert.equal(okRead.integrity.unitsOk, true);
  assert.equal(okRead.integrity.weightOk, true);
  assert.deepEqual(okRead.warnings, []);
});

test('MANIFEST_PROMPT: asks for compact JSON and names the inch-mark trap', () => {
  assert.match(MANIFEST_PROMPT, /COMPACT JSON/);
  assert.match(MANIFEST_PROMPT, /ESCAPE every double-quote/);
  assert.match(MANIFEST_PROMPT, /inch mark/i);
  // The real 047-52228 values must never come back as examples a reader can launder.
  for (const leaked of ['047-52228', '521104', '028-8347656', '9:14:26']) {
    assert.equal(MANIFEST_PROMPT.includes(leaked), false, `prompt still leaks the real value ${leaked}`);
  }
});
