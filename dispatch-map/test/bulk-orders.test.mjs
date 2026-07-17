// test/bulk-orders.test.mjs — pure bulk-import parsing + column mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDelimited, detectDelimiter, looksLikeHeader, autoMapColumns,
  mappedRowsToOrders, bulkRowMissing, bulkRowIsBlank, headerSignature, BULK_FIELDS,
} from '../src/lib/bulk-orders.js';

test('detectDelimiter: tab for Excel/Sheets copy, comma for CSV', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
});

test('looksLikeHeader: needs a REQUIRED-field hit — generic phone/notes tokens in a data row cannot fake a header', () => {
  // Real headers name a required column (consignee/address/city/state/zip):
  assert.equal(looksLikeHeader(['Consignee', 'Phone', 'Notes']), true);
  // A DATA row whose cells happen to contain optional-field tokens must NOT sniff as a header
  // (it would silently drop that order from the import):
  assert.equal(looksLikeHeader(['MOBILE HOME SUPPLY', '500 Main St', 'CALL: SEE NOTES']), false);
  // A header of purely optional columns maps by position — the safe failure mode:
  assert.equal(looksLikeHeader(['Phone', 'Notes', 'Weight']), false);
});

test('detectDelimiter: robust — semicolon, pipe, and a comma CSV with a stray tab', () => {
  // European CSV / pipe exports must split, not collapse to one column.
  assert.equal(detectDelimiter('name;city;zip\nACME;Buford;30518'), ';');
  assert.equal(detectDelimiter('name|city|zip\nACME|Buford|30518'), '|');
  // The old rule picked tab the moment ANY tab appeared, mis-splitting a comma CSV that had one
  // stray tab in a cell → whole line became a single cell ("Column 1" only). Comma must win now.
  assert.equal(detectDelimiter('name,addr,city\nACME,"500 Main\tSt",Buford\nBeta,10 Oak Rd,Atlanta'), ',');
  // Truly single-column input has no delimiter to find → comma default (honestly one column).
  assert.equal(detectDelimiter('ACME\nBeta\nGamma'), ',');
});

test('_push UI flag is invisible to order semantics (blank/missing ignore it)', () => {
  // The Bulk Add grid stores a per-row "push now vs queue for later" flag as _push —
  // it must never make a row read as filled, nor count as an order field.
  assert.equal(bulkRowIsBlank({ _push: false }), true);
  assert.equal(bulkRowIsBlank({ _push: true, name: 'ACME' }), false);
  assert.ok(!BULK_FIELDS.some((f) => f.key === '_push'));
});

test('parseDelimited: TSV paste → rows of cells', () => {
  const rows = parseDelimited('Name\tCity\nACME\tBuford\nBeta\tAtlanta');
  assert.deepEqual(rows, [['Name', 'City'], ['ACME', 'Buford'], ['Beta', 'Atlanta']]);
});

test('parseDelimited: quoted CSV keeps embedded commas + escaped quotes; drops blank trailing lines', () => {
  const rows = parseDelimited('name,addr\n"ACME, Inc.","500 Main St, Ste 200"\n"He said ""hi""",x\n\n', ',');
  assert.deepEqual(rows, [['name', 'addr'], ['ACME, Inc.', '500 Main St, Ste 200'], ['He said "hi"', 'x']]);
});

test('looksLikeHeader: true for a label row, false for data', () => {
  assert.equal(looksLikeHeader(['Consignee', 'Address', 'City', 'State', 'Zip']), true);
  assert.equal(looksLikeHeader(['ACME Distribution', '500 Main St', 'Lawrenceville', 'GA', '30046']), false);
});

test('autoMapColumns: maps common headers to field keys (exact beats substring; no double-assign)', () => {
  const m = autoMapColumns(['Consignee', 'Ship To Address', 'City', 'ST', 'Zip Code', 'Item Description', 'Pallets']);
  assert.equal(m[0], 'name');
  assert.equal(m[1], 'addr1');
  assert.equal(m[2], 'city');
  assert.equal(m[3], 'state');
  assert.equal(m[4], 'zip');
  assert.equal(m[5], 'itemDesc');
  assert.equal(m[6], 'pallets');
  // Each field assigned once.
  assert.equal(new Set(Object.values(m)).size, Object.values(m).length);
});

test('autoMapColumns: unknown columns are left unmapped', () => {
  const m = autoMapColumns(['Consignee', 'Mystery Column', 'City']);
  assert.equal(m[0], 'name');
  assert.equal(m[1], undefined);
  assert.equal(m[2], 'city');
});

test('mappedRowsToOrders: applies mapping, trims cells, ignores unmapped columns', () => {
  const data = [['  ACME  ', '500 Main St', 'ignored', 'Buford', 'GA', '30518']];
  const mapping = { 0: 'name', 1: 'addr1', 3: 'city', 4: 'state', 5: 'zip' };
  assert.deepEqual(mappedRowsToOrders(data, mapping), [{ name: 'ACME', addr1: '500 Main St', city: 'Buford', state: 'GA', zip: '30518' }]);
});

test('bulkRowMissing: flags absent required fields; empty when complete', () => {
  assert.deepEqual(bulkRowMissing({ name: 'A', addr1: '1', city: 'B', state: 'GA', zip: '30518' }), []);
  assert.deepEqual(bulkRowMissing({ name: 'A', addr1: '', city: 'B', state: '', zip: '30518' }), ['addr1', 'state']);
});

test('bulkRowIsBlank: true only when every field is empty', () => {
  assert.equal(bulkRowIsBlank({}), true);
  assert.equal(bulkRowIsBlank({ name: '', city: '   ' }), true);
  assert.equal(bulkRowIsBlank({ name: 'A' }), false);
});

test('headerSignature: stable, normalized; null without a usable header', () => {
  assert.equal(headerSignature(['Consignee', 'City']), 'consignee|city');
  assert.equal(headerSignature(['  Consignee  ', 'CITY']), 'consignee|city');
  assert.equal(headerSignature([]), null);
});

test('end-to-end: pasted TSV with header → mapped, validated orders', () => {
  const text = 'Consignee\tAddress\tCity\tState\tZip\tItem\n'
    + 'ACME\t500 Main St\tLawrenceville\tGA\t30046\tappliances\n'
    + 'Beta Co\t9 Hub Rd\tAtlanta\tGA\t30301\tpallets';
  const rows = parseDelimited(text);
  const header = rows[0];
  assert.equal(looksLikeHeader(header), true);
  const mapping = autoMapColumns(header);
  const orders = mappedRowsToOrders(rows.slice(1), mapping);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders[0], { name: 'ACME', addr1: '500 Main St', city: 'Lawrenceville', state: 'GA', zip: '30046', itemDesc: 'appliances' });
  assert.deepEqual(bulkRowMissing(orders[1]), []);
});

test('autoMapColumns: NuVizz route export — delivery (Ship To) wins over pickup (Ship From), Uom never steals a value', () => {
  const header = [
    'Stop Number', 'Shipment Number', 'Skids', 'Total Pieces', 'Loose',
    'Stop Weight Uom', 'Stop Weight', 'Ship From - Address Line 1',
    'Ship To Name', 'Ship To - Address Line 1', 'Ship To - Address Line 2',
    'Ship To - City', 'Ship To - State', 'Zip Code', 'Product', 'Price',
    'Comments', 'Customer Number', 'Email',
  ];
  const m = autoMapColumns(header);
  // The warehouse side is ignored; the real delivery address maps.
  assert.equal(m[7], undefined, 'Ship From must NOT map to the delivery address');
  assert.equal(m[9], 'addr1', 'Ship To Address Line 1 → addr1');
  assert.equal(m[10], 'addr2', 'Ship To Address Line 2 → addr2');
  assert.equal(m[11], 'city');
  assert.equal(m[12], 'state');
  assert.equal(m[13], 'zip');
  assert.equal(m[8], 'name', 'Ship To Name → name');
  // The unit label is ignored; the numeric weight wins.
  assert.equal(m[5], undefined, 'Stop Weight Uom must NOT map to weight');
  assert.equal(m[6], 'weight', 'Stop Weight (the number) → weight');
  // Davis convention: Shipment Number (SO#) is the Order #, Stop Number (SHP#) is the PRO.
  assert.equal(m[1], 'stopNbr', 'Shipment Number → Order #');
  assert.equal(m[0], 'pro', 'Stop Number → PRO');
  assert.equal(m[2], 'pallets', 'Skids → pallets');
  assert.equal(m[4], 'loose');
  assert.equal(m[14], 'itemDesc');
  assert.equal(m[15], 'price');
  assert.equal(m[16], 'dispatchNotes', 'Comments → dispatch notes');
  assert.equal(m[17], 'phone', 'Customer Number (a phone) → phone');
  assert.equal(m[18], 'email', 'Email → email');
});

test('autoMapColumns: a bare "Shipment" column still maps to PRO (only "Shipment Number"/"Sales Order" route to Order #)', () => {
  const m = autoMapColumns(['Consignee', 'Address', 'City', 'State', 'Zip', 'Shipment']);
  assert.equal(m[5], 'pro');
});
