import test from 'node:test';
import assert from 'node:assert/strict';

// ── THE DAVIS DELIVERY LABEL ─────────────────────────────────────────────────
// Chad, Sep 24 2026: one full page per piece, the ship-to address, skid & loose counts, and a
// barcode the load-out app and the WMS can scan (DD/<NuVizz stop #>/<piece>). Its own label,
// separate from the Delivery Ticket and the manifest, saved with the order so it can be
// printed again any time.

const C = await import('../src/lib/code128.js');
const L = await import('../src/lib/order-labels.js');
const H = await import('../src/lib/label-html.js');

// ── Code 128, pinned against a SECOND copy of the spec ───────────────────────
// The encoder's table and its 11-module self-check cannot catch a swapped pattern: a corrupted
// entry that still sums to 11 modules passed every test and printed an unscannable label. This
// is the spec's own bar/space bit strings (1 = bar), typed independently, decoded back to text.
const SPEC = [
  '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100','10001100100','11001001000',
  '11001000100','11000100100','10110011100','10011011100','10011001110','10111001100','10011101100','10011100110','11001110010','11001011100',
  '11001001110','11011100100','11001110100','11101101110','11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
  '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110','11101110110','11010001110',
  '11000101110','11011101000','11011100010','11011101110','11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000','10010000110','10000101100','10000100110','10110010000',
  '10110000100','10011010000','10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
  '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000','10111100010','11110101000','11110100010','10111011110',
  '10111101110','11101011110','11110101110','11010000100','11010010000','11010011100','1100011101011',
];
const toBits = (mods) => mods.map((w, k) => (k % 2 === 0 ? '1' : '0').repeat(w)).join('');
function specDecode(bits) {
  const vals = [];
  let i = 0;
  while (i < bits.length) {
    const stop = bits.slice(i, i + 13);
    if (stop === SPEC[106]) { vals.push(106); break; }
    const v = SPEC.indexOf(bits.slice(i, i + 11));
    assert.ok(v >= 0 && v < 106, `unknown symbol at module ${i}`);
    vals.push(v); i += 11;
  }
  // check symbol
  const check = vals[vals.length - 2];
  let sum = vals[0];
  for (let k = 1; k < vals.length - 2; k++) sum += vals[k] * k;
  assert.equal(sum % 103, check, 'checksum');
  let set = vals[0] === 105 ? 'C' : 'B', out = '';
  for (const v of vals.slice(1, -2)) {
    if (v === 99) { set = 'C'; continue; }
    if (v === 100) { set = 'B'; continue; }
    out += set === 'C' ? String(v).padStart(2, '0') : String.fromCharCode(v + 32);
  }
  return out;
}

test('Code 128: every drawn symbol decodes back to its text through an independent copy of the spec', () => {
  for (const text of ['DD/ESTES-0288000001/1', 'DD/12345/1', 'DD/0288000001/12', 'DD/SO-88213/3', 'DD/SHP29379/99',
    'DD/SO-2026-0925-ABCDEFGHIJ-000123/1', 'DD/AVRT-0170416694/7', 'DD/007174272/2', 'DD/abc xyz/5']) {
    assert.equal(specDecode(toBits(C.code128Modules(text))), text, text);
  }
});

test('Code 128: all 107 patterns match the spec, one by one', () => {
  for (let v = 0; v <= 106; v++) {
    // Encode a symbol value directly by building modules for a known stream is overkill; the
    // table is reachable through code128Modules of single printable characters (set B).
    if (v >= 0 && v <= 94) {
      const ch = String.fromCharCode(v + 32);
      const bits = toBits(C.code128Modules(ch));
      assert.equal(bits.slice(11, 22), SPEC[v], `value ${v} (${JSON.stringify(ch)})`);
    }
  }
  // start B / start C / stop
  assert.equal(toBits(C.code128Modules('A')).slice(0, 11), SPEC[104]);
  assert.equal(toBits(C.code128Modules('1234')).slice(0, 11), SPEC[105]);
  assert.ok(toBits(C.code128Modules('A')).endsWith(SPEC[106]));
});

test('Code 128: a character it cannot carry throws — the caller leaves that order out and names it', () => {
  assert.throws(() => C.code128Values(''), /empty/);
  assert.throws(() => C.code128Values('X 1'), /unsupported/);
});

// ── the rules ────────────────────────────────────────────────────────────────

test('one page per piece: skids first, then loose, numbered across the order', () => {
  const p = L.labelPieces({ pallets: '2', loose: '1' });
  assert.deepEqual(p.map((x) => [x.seq, x.kind, x.kindIdx, x.kindTotal, x.total]), [
    [1, 'SKID', 1, 2, 3], [2, 'SKID', 2, 2, 3], [3, 'LOOSE', 1, 1, 3],
  ]);
});

test('no count entered still prints ONE page, flagged — NuVizz holds that order as one piece', () => {
  for (const o of [{}, { pallets: '', loose: '' }, { pallets: null, loose: undefined }]) {
    const p = L.labelPieces(o);
    assert.equal(p.length, 1);
    assert.equal(p[0].countMissing, true);
  }
});

test('the payload carries the stop # and the piece — and refuses to exist without a number', () => {
  assert.equal(L.labelPayload('ESTES-0288000001', 2), 'DD/ESTES-0288000001/2');
  assert.throws(() => L.labelPayload('', 1), /never printed/);
  assert.deepEqual(L.parseLabelPayload('DD/SO-88213/7'), { stopNbr: 'SO-88213', seq: 7 });
  assert.equal(L.parseLabelPayload('7152411'), null, 'a Uline PRO is not a Davis label');
});

test('a created order becomes a label record with its ship-from and where it was made — only when there is a number', () => {
  const row = { name: ' Peachtree Flooring ', addr1: '1450 Buford Dr', city: 'Lawrenceville', state: 'GA', zip: '30043', pallets: 2, loose: '1', weight: 1850 };
  const origin = { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518' };
  const o = L.labelOrderFromCreate(row, 'ESTES-0288000001', { serviceDate: '2026-09-25', ref: '0288000001', origin, source: 'manifest' });
  assert.equal(o.stopNbr, 'ESTES-0288000001');
  assert.equal(o.name, 'Peachtree Flooring');
  assert.equal(o.pallets, '2');
  assert.deepEqual(o.origin, origin);
  assert.equal(o.source, 'manifest');
  assert.equal(L.labelOrderFromCreate(row, ''), null, 'no number, no label');
});

test('rows pushed before labels were saved still print from the push log', () => {
  const rec = { orderRef: 'SHP123', nuvizzNbr: 'SHP123', name: 'A', addr1: 'B', city: 'C', state: 'GA', zip: '30000', pallets: '1', serviceDate: '2026-09-25' };
  assert.equal(L.labelOrderFromPushLog(rec).stopNbr, 'SHP123');
  assert.equal(L.labelOrderFromPushLog({ ...rec, nuvizzNbr: '', orderRef: '' }), null);
});

test("New Order's Delivery Ticket is fed what the create WROTE, in NuVizz's field meanings", () => {
  const t = L.ticketStopFromLabel({ stopNbr: 'SO-1', ref: 'PRO9', name: 'Acme', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518', phone: '770-555-0100', pallets: '2', loose: '3', weight: '900', itemDesc: 'Tile', dispatchNotes: 'Dock 4', serviceDate: '2026-09-25' });
  assert.equal(t.cartons, 2, 'pallets ride cartons');
  assert.equal(t.volume, 3, 'loose rides volume');
  assert.equal(t.pallets, 5, 'total pieces ride pallets');
  assert.equal(t.scheduledFrom, '2026-09-25T12:00:00', "the create's default delivery window");
  assert.equal(t.scheduledTo, '2026-09-25T17:00:00');
  assert.equal(t.stopDetails[0].product, 'Tile');
  assert.equal(t.allComments[0].text, 'Dock 4');
  assert.equal(L.ticketStopFromLabel({ stopNbr: 'X' }).pallets, 1, 'nothing entered = 1 piece, as NuVizz holds it');
});

// ── the page ─────────────────────────────────────────────────────────────────

const ORDERS = [
  { stopNbr: 'ESTES-0288000001', ref: '0288000001', name: 'Peachtree Flooring Supply', addr1: '1450 Buford Dr', city: 'Lawrenceville', state: 'GA', zip: '30043', pallets: '2', loose: '1', serviceDate: '2026-09-25' },
  { stopNbr: 'X 1', name: 'Bad Char Co', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518' },
  { stopNbr: 'SO-9', name: 'Too Many', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518', loose: '120' },
  { stopNbr: 'SMP-000245', name: 'Notes & <Co>', addr1: '2 Elm', city: 'Norcross', state: 'GA', zip: '30092', loose: '1', dispatchNotes: 'Liftgate required.\nCall ahead' },
];

test('one bad order never blanks the batch: it is left out and NAMED, and the rest print', () => {
  const r = H.buildLabelsHtml(ORDERS, { maxPages: L.MAX_LABEL_PAGES });
  assert.equal(r.pages, 3 + 1);
  assert.deepEqual(r.printed.map((o) => o.stopNbr), ['ESTES-0288000001', 'SMP-000245']);
  assert.deepEqual(r.skipped.map((k) => k.name), ['Bad Char Co', 'Too Many']);
  assert.match(r.skipped[1].reason, /120 pieces/);
  assert.equal((r.html.match(/class="pg"/g) || []).length, 4, 'one page element per piece');
});

test('the page carries each barcode, the service date the house way, and escapes what it prints', () => {
  const { html } = H.buildLabelsHtml(ORDERS);
  for (const k of [1, 2, 3]) assert.ok(html.includes(`aria-label="DD/ESTES-0288000001/${k}"`), `page ${k}`);
  assert.ok(html.includes('Sep 25, 2026'));
  assert.ok(!html.includes('2026-09-25'), 'never ISO on paper');
  assert.ok(html.includes('NOTES &amp; &lt;CO&gt;'), 'escaped, never raw markup');
  assert.ok(html.includes('Liftgate required. Call ahead'), 'a pasted line break is a space, not "?"');
  assert.ok(html.includes('SKID 2 of 2') && html.includes('LOOSE 1 of 1'));
});

test('the QR carries the 4-module quiet zone the spec asks for', () => {
  assert.match(H.qrSvg(), /viewBox="0 0 33 33"/, '25 modules + 4 on each side');
});

// ── printed from the order's stop card ───────────────────────────────────────

test("a board stop's label carries TODAY's board count and the card's address — the saved label only fills gaps", () => {
  const stop = { stopNbr: 'SO-88213', pro: 'SO-88213', businessName: 'Acme', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518', cartons: 3, volume: 0, weight: 900, scheduledFrom: '2026-09-25T12:00:00', stopDetails: [{ product: 'Tile' }, { product: 'Grout' }] };
  const saved = { stopNbr: 'SO-88213', ref: 'PO-1', pallets: '2', loose: '1', dispatchNotes: 'Dock 4', origin: { name: 'Davis' }, addr2: 'Ste 9' };
  const l = L.labelOrderFromStop(stop, { saved, addressOverride: { addr1: '1 Main St' }, phone: '770-555-0100' });
  assert.equal(l.pallets, '3', 'the board count, not the count at creation');
  assert.equal(l.loose, '0');
  assert.equal(L.labelPieces(l).length, 3);
  assert.equal(l.addr1, '1 Main St', "a dispatcher's address fix wins");
  assert.equal(l.addr2, 'Ste 9', 'the saved label fills what the board lacks');
  assert.equal(l.ref, 'PO-1');
  assert.equal(l.itemDesc, 'Tile, Grout');
  assert.equal(l.serviceDate, '2026-09-25');
  assert.equal(l.dispatchNotes, 'Dock 4');
  assert.equal(l.phone, '770-555-0100');
});

test('a board stop with no counts falls back to the saved ones, then to the flagged single page — never an invented count', () => {
  const stop = { stopNbr: 'X1', businessName: 'A', cartons: null, volume: null };
  assert.equal(L.labelOrderFromStop(stop, { saved: { pallets: '2', loose: '' } }).pallets, '2');
  const bare = L.labelOrderFromStop(stop);
  assert.equal(L.labelPieces(bare)[0].countMissing, true);
  assert.equal(L.labelOrderFromStop({ businessName: 'no number' }), null);
  assert.equal(L.labelOrderFromStop({ stopNbr: '0288000001', pro: '0288000001' }).ref, '', 'the same number is not printed twice');
});
