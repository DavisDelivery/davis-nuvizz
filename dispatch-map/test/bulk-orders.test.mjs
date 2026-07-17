// test/bulk-orders.test.mjs — pure bulk-import parsing + column mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDelimited, detectDelimiter, looksLikeHeader, autoMapColumns,
  mappedRowsToOrders, bulkRowMissing, bulkRowIsBlank, bulkRowIsGhost, mappingCoversRequired, headerSignature, BULK_FIELDS, normalizePhone, bulkRowNuvizzRefs,
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

test('bulkRowIsGhost: template residue (no name/addr/order#/PRO) is a ghost even with itemDesc/qty/state', () => {
  // The Davis 7/20 xlsx: 8 trailing rows carried only "AIR FILTERS", a qty, and (on some) a
  // dragged-down "GA" — no consignee, street, or ids. Those must be ghosts.
  assert.equal(bulkRowIsGhost({ itemDesc: 'AIR FILTERS', loose: '1' }), true);
  assert.equal(bulkRowIsGhost({ itemDesc: 'AIR FILTERS', state: 'GA', loose: '1' }), true, 'state alone is not identity');
  assert.equal(bulkRowIsGhost({ city: 'Atlanta', state: 'GA', zip: '30326' }), true, 'city/state/zip alone are not identity');
  // Identity keeps the row (a partial real order the dispatcher can finish in the grid):
  assert.equal(bulkRowIsGhost({ name: 'ACME' }), false);
  assert.equal(bulkRowIsGhost({ addr1: '500 Main St' }), false);
  assert.equal(bulkRowIsGhost({ stopNbr: 'SO45630' }), false);
  assert.equal(bulkRowIsGhost({ pro: 'SHP29555' }), false);
  // Blank is trivially ghost (blank rows are filtered separately anyway).
  assert.equal(bulkRowIsGhost({}), true);
});

test('end-to-end: NuVizz 33-column template (Davis 7/20 shape) → real orders import, residue rows drop', () => {
  // Synthetic replica of the real Davis_Deliveries_720.xlsx shape (customer data not committed):
  // the NuVizz bulk template header + 2 real orders + 3 residue rows (dragged-down item/qty/state).
  const header = ['Stop Number', 'Stop Sequence', 'Stop Signature Required', 'Stop Type', 'Shipment Number',
    'Skids', 'Total Pieces', 'Loose', 'Stop Volume Uom', 'Stop Weight Uom', 'Stop Weight',
    'Pickup EarliestStartDTTM', 'Pickup LatestStartDTTM', 'Ship From - Address Line 1',
    'EarliestStartDTTM', 'LatestStartDTTM', 'Ship To Name', 'Ship To - Address Line 1',
    'Ship To - Address Line 2', 'Ship To - City', 'Ship To - State', 'Zip Code',
    'Stop Detail Sequence', 'Product', 'ProductID', 'Product Quantity', 'Quantity UOM',
    'PuConfirmation', 'DoConfirmation', 'Price', 'Comments', 'Customer Number', 'Email'];
  const real = (shp, so, skids, wt, name, addr, city, zip, phone, notes) =>
    [shp, '1', 'true', '02', so, skids, skids, '0', 'cubic feet', 'pounds', wt, '45671.3', '45671.35',
      '943 GAINESVILLE HWY, BUFORD, GA 30518', '45671.37', '45671.39', name, addr, '', city, 'GA', zip,
      '1', 'AIR FILTERS', '1', '1', '1', 'SKIP', 'SCAN-VER-ALL', '', notes, phone, ''];
  const ghost = (withState) =>
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', withState ? 'GA' : '', '',
      '1', 'AIR FILTERS', '1', '1', '1', '', '', '', '', '', ''];
  const rows = [header,
    real('SHP1', 'SO1', '5', '1008', 'PINNACLE BLDG', '3455 Peachtree Rd NE', 'Atlanta', '30326', '4045550101', 'call on arrival'),
    real('SHP2', 'SO2', '1', '132', 'WHITEFIELD ACADEMY', '1 Whitefield Dr SE', 'Mableton', '30126', '4045550102', ''),
    ghost(true), ghost(true), ghost(false)];

  assert.equal(looksLikeHeader(rows[0]), true);
  const mapping = autoMapColumns(rows[0]);
  // Lock the template's critical mappings:
  assert.equal(mapping[0], 'pro');          // Stop Number → PRO
  assert.equal(mapping[4], 'stopNbr');      // Shipment Number → Order #
  assert.equal(mapping[5], 'pallets');      // Skids → Pallets
  assert.equal(mapping[10], 'weight');      // Stop Weight → Weight
  assert.equal(mapping[16], 'name');        // Ship To Name → Consignee
  assert.equal(mapping[17], 'addr1');
  assert.equal(mapping[21], 'zip');         // Zip Code → ZIP
  assert.equal(mapping[23], 'itemDesc');    // Product → Item description
  assert.equal(mapping[30], 'dispatchNotes'); // Comments → Dispatch notes
  assert.equal(mapping[31], 'phone');       // Customer Number → Phone

  const mapped = mappedRowsToOrders(rows.slice(1), mapping).filter((o) => !bulkRowIsBlank(o));
  const orders = mapped.filter((o) => !bulkRowIsGhost(o));
  assert.equal(mapped.length, 5, 'ghost rows are NOT blank (they carry itemDesc), so the blank filter alone keeps them');
  assert.equal(orders.length, 2, 'ghost filter drops the 3 residue rows');
  assert.deepEqual(bulkRowMissing(orders[0]), [], 'real order 1 imports complete');
  assert.deepEqual(bulkRowMissing(orders[1]), [], 'real order 2 imports complete');
  assert.equal(orders[0].name, 'PINNACLE BLDG');
  assert.equal(orders[0].pallets, '5');
  assert.equal(orders[0].stopNbr, 'SO1');
  assert.equal(orders[0].pro, 'SHP1');
});

test('mappingCoversRequired: complete required coverage → auto-import; anything less opens the mapper', () => {
  // The NuVizz template auto-map (name/addr1/city/state/zip all present) qualifies:
  assert.equal(mappingCoversRequired({ 0: 'pro', 4: 'stopNbr', 16: 'name', 17: 'addr1', 19: 'city', 20: 'state', 21: 'zip' }), true);
  // Missing any required field → NOT confident (mapper must open):
  assert.equal(mappingCoversRequired({ 16: 'name', 17: 'addr1', 19: 'city', 20: 'state' }), false, 'no zip');
  assert.equal(mappingCoversRequired({ 17: 'addr1', 19: 'city', 20: 'state', 21: 'zip' }), false, 'no name');
  assert.equal(mappingCoversRequired({}), false);
  assert.equal(mappingCoversRequired(null), false);
});

test('normalizePhone: masks plain US numbers to xxx-xxx-xxxx, passes anything unusual through untouched', () => {
  // Plain 10-digit runs (however delimited) → the dash mask, so a dropped/pasted spreadsheet
  // lands formatted the same as typing.
  assert.equal(normalizePhone('4048148100'), '404-814-8100', 'raw digit run');
  assert.equal(normalizePhone(4048148100), '404-814-8100', 'numeric cell from xlsx');
  assert.equal(normalizePhone('(404) 814-8100'), '404-814-8100', 're-masks a pre-formatted number');
  assert.equal(normalizePhone('404.814.8100'), '404-814-8100', 'dot-separated');
  assert.equal(normalizePhone('1-404-814-8100'), '404-814-8100', 'leading US country code dropped');
  // Partial input formats progressively (matches the typed mask).
  assert.equal(normalizePhone('404'), '404');
  assert.equal(normalizePhone('4048'), '404-8');
  assert.equal(normalizePhone('404814'), '404-814');
  // Never truncate a real number the field used to accept: extensions, "+" intl, >11 digits pass through.
  assert.equal(normalizePhone('404-814-8100 x45'), '404-814-8100 x45', 'extension preserved');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+44 20 7946 0958', 'international passes through');
  assert.equal(normalizePhone('123456789012'), '123456789012', '12 digits → left as-is, not mis-grouped');
  // Empty / nullish → empty string (no crash, no "undefined").
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone(null), '');
  assert.equal(normalizePhone(undefined), '');
});

test('bulkRowNuvizzRefs: PRO (SHP) → NuVizz Stop Number, Order # (SO) → NuVizz Shipment Number', () => {
  // Grid row as imported from the NuVizz route export: "Stop Number" col (SHP) landed in the PRO
  // field, "Shipment Number" col (SO) landed in the Order # field. On push, they must cross so
  // NuVizz's Stop Number = the SHP and its Shipment Number = the SO.
  assert.deepEqual(bulkRowNuvizzRefs({ stopNbr: 'SO45630', pro: 'SHP29555' }), { stopNbr: 'SHP29555', pro: 'SO45630' });
  assert.deepEqual(bulkRowNuvizzRefs({ stopNbr: 'SO45386', pro: 'SHP29544' }), { stopNbr: 'SHP29544', pro: 'SO45386' });
  // Trims and nulls empties (buildStopPayload treats null/undefined as "omit the field").
  assert.deepEqual(bulkRowNuvizzRefs({ stopNbr: '  SO1  ', pro: '  SHP1 ' }), { stopNbr: 'SHP1', pro: 'SO1' });
  assert.deepEqual(bulkRowNuvizzRefs({ stopNbr: 'SO1', pro: '' }), { stopNbr: null, pro: 'SO1' });
  assert.deepEqual(bulkRowNuvizzRefs({ stopNbr: '', pro: 'SHP1' }), { stopNbr: 'SHP1', pro: null });
  assert.deepEqual(bulkRowNuvizzRefs({}), { stopNbr: null, pro: null });
  assert.deepEqual(bulkRowNuvizzRefs(null), { stopNbr: null, pro: null });
});
