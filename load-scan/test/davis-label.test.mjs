import test from 'node:test';
import assert from 'node:assert/strict';

// ── THE DAVIS LABEL ──────────────────────────────────────────────────────────
//
// The dispatch map prints a full-page label for every order created in New
// Order, one page per piece, carrying ONE Code 128 barcode: DD/<stop #>/<piece>.
// One read is one piece — no pairing window — and the stop is matched on its
// EXACT number, never the last-7-digit rule the Uline PRO uses.

const logic = await import('../src/lib/scan-logic.js');
const session = await import('../netlify/functions/scan-session.mts');
const manifest = await import('../netlify/functions/lib/manifest.mts');

const estes = { stopNbr: 'ESTES-0288000001', pros: ['8000001'], primaryPro: '8000001', expectedPieces: 3, businessName: 'PEACHTREE FLOORING SUPPLY' };
// A Uline stop whose 7-digit PRO is the SAME as the Estes number's last seven digits.
const ulineTwin = { stopNbr: '008000001', pros: ['8000001'], primaryPro: '8000001', expectedPieces: 1, businessName: 'ULINE CUSTOMER' };

test('a Davis label parses to its stop # and piece — and only a Davis label does', () => {
  assert.deepEqual(logic.parseDavisLabel('DD/ESTES-0288000001/2'), { stopNbr: 'ESTES-0288000001', seq: 2 });
  assert.deepEqual(logic.parseDavisLabel('  DD/SMP-000245/1 '), { stopNbr: 'SMP-000245', seq: 1 }, 'a gun suffix/space is trimmed');
  assert.deepEqual(logic.parseDavisLabel('DD/A/B/12'), { stopNbr: 'A/B', seq: 12 }, 'split from the right: a stop # may hold "/"');
  for (const bad of ['7152411', 'OG6028479182', '0259185096', 'DD/ESTES-1/0', 'DD//3', 'DD/X/1000', 'dd/x/1', 'DD/X', '']) {
    assert.equal(logic.parseDavisLabel(bad), null, `not a Davis label: ${JSON.stringify(bad)}`);
  }
});

test('classify: a Davis label is its own kind, Uline and Averitt barcodes are untouched', () => {
  const c = logic.classifyBarcode('DD/ESTES-0288000001/1');
  assert.equal(c.kind, 'davis');
  assert.equal(c.stopNbr, 'ESTES-0288000001');
  assert.equal(c.seq, 1);
  assert.equal(logic.classifyBarcode('7152411').kind, 'pro');
  assert.equal(logic.classifyBarcode('OG6028479182').kind, 'og');
  assert.equal(logic.classifyBarcode('0259185096').kind, 'unknown', 'an Averitt 10-digit number is still not a PRO');
  assert.equal(logic.classifyBarcode('https://davisdelivery.com').kind, 'unknown', "the label's QR code is never a piece");
});

test('LOADSCAN_DAVIS_LABELS=off: a Davis label reads exactly as it did before — unknown', () => {
  assert.equal(logic.classifyBarcode('DD/ESTES-0288000001/1', { davisLabels: false }).kind, 'unknown');
  assert.equal(logic.classifyBarcode('7152411', { davisLabels: false }).kind, 'pro', 'the switch touches nothing else');
});

test('the switch has the house shape: default ON, only an explicit off-word turns it off', () => {
  assert.equal(manifest.davisLabelsEnabled({}), true);
  assert.equal(manifest.davisLabelsEnabled({ LOADSCAN_DAVIS_LABELS: '' }), true);
  assert.equal(manifest.davisLabelsEnabled({ LOADSCAN_DAVIS_LABELS: 'of' }), true, 'a typo must never silently switch it off');
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' no ']) {
    assert.equal(manifest.davisLabelsEnabled({ LOADSCAN_DAVIS_LABELS: off }), false, off);
  }
});

test('one printed page is one piece id — a reprint of the same page books nothing twice', () => {
  assert.equal(logic.davisPieceId('ESTES-0288000001', 2), 'DD-ESTES-0288000001-2');
  assert.equal(logic.davisPieceId('estes-0288000001', 2), logic.davisPieceId('ESTES-0288000001', 2), 'case does not make a second piece');
  assert.notEqual(logic.davisPieceId('ESTES-0288000001', 1), logic.davisPieceId('ESTES-0288000001', 2), 'two pages, two pieces');
  assert.equal(logic.davisPieceId('SO 88/213', 1), 'DD-SO-88-213-1', 'anything outside A-Z0-9 folds to one dash');
  assert.equal(logic.davisPieceId('', 1), '');
  assert.equal(logic.davisPieceId('X', 0), '');
});

test('EXACT stop match: an Estes label never lands on the Uline stop that shares its last 7 digits', () => {
  const label = logic.parseDavisLabel('DD/ESTES-0288000001/1');
  assert.equal(logic.findDavisStop(label, [ulineTwin, estes]), estes, 'found by its own number, even listed second');
  assert.equal(logic.findDavisStop(label, [ulineTwin]), null, 'the twin alone is NOT a match — that load reads red');
  assert.equal(logic.findDavisStop({ stopNbr: 'estes-0288000001' }, [estes]), estes, 'case-insensitive');
});

test('pair buffer: a Davis label is a whole piece on its FIRST frame — no window, no partner', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  assert.deepEqual(
    buf.push(['DD/ESTES-0288000001/1'], t0),
    { pro: null, og: null, davis: { stopNbr: 'ESTES-0288000001', seq: 1, raw: 'DD/ESTES-0288000001/1' } },
  );
  assert.deepEqual(buf.state(t0), { pro: null, og: null }, 'nothing is left half-held');
});

test('pair buffer: the same label held under the lens is ONE emission, the next page is the next piece', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  assert.ok(buf.push(['DD/ESTES-0288000001/1'], t0));
  for (let k = 1; k <= 20; k++) assert.equal(buf.push(['DD/ESTES-0288000001/1'], t0 + k * 60), null, `frame ${k} is the same page`);
  assert.equal(buf.push(['DD/ESTES-0288000001/2'], t0 + 1300).davis.seq, 2, 'page 2 books straight away');
});

test('pair buffer: a Uline half left pending is ANNOUNCED when a Davis label arrives, never dropped silently', () => {
  const abandoned = [];
  const buf = logic.createPairBuffer({ windowMs: 2500, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  assert.equal(buf.push(['7152411'], t0), null);
  assert.ok(buf.push(['DD/SMP-000245/1'], t0 + 300).davis);
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].kind, 'pro');
  assert.equal(abandoned[0].reason, 'superseded');
});

test('pair buffer with the switch OFF: a Davis label emits nothing (it is an unknown barcode again)', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500, davisLabels: () => false });
  assert.equal(buf.push(['DD/ESTES-0288000001/1'], 1_000_000), null);
  assert.deepEqual(buf.state(1_000_000), { pro: null, og: null });
});

test('the resolved piece counts on its stop, and a second read of the same page is SILENT', () => {
  const pair = { pro: estes.primaryPro, og: logic.davisPieceId(estes.stopNbr, 1) };
  const first = logic.evaluateScan(pair, [estes], new Set());
  assert.equal(first.outcome, logic.OUTCOME.GREEN);
  assert.equal(first.stop, estes);
  const again = logic.evaluateScan(pair, [estes], new Set([pair.og]));
  assert.equal(again.outcome, logic.OUTCOME.SILENT);

  const scans = [1, 2, 2, 3].map((n) => ({ og: logic.davisPieceId(estes.stopNbr, n), pro: estes.primaryPro, stopNbr: estes.stopNbr }));
  const p = logic.stopProgress(estes, scans);
  assert.equal(p.scanned, 3, 'pages 1-3, page 2 read twice: three pieces');
  assert.equal(p.complete, true);
});

test('server: a Davis piece id is accepted and stays a SCAN (not typed, not an override)', () => {
  const id = logic.davisPieceId('ESTES-0288000001', 2);
  const r = session.normalizeScan({ og: id, pro: '8000001', engine: 'quagga', stopNbr: 'ESTES-0288000001' });
  assert.equal(r.reason, undefined);
  assert.equal(r.row.og, 'DD-ESTES-0288000001-2');
  assert.equal(r.row.engine, 'quagga');
  for (const nbr of ['ESTES-0288000001', 'AVRT-0170416694', '007174272', 'SMP-000245', 'SO 88/213']) {
    assert.ok(session.DD_RE.test(logic.davisPieceId(nbr, 7)), `the id minted for ${nbr} is one the server accepts`);
  }
  for (const bad of ['DD--1', 'DD-X-', 'DD-X-1000', 'DD/ESTES-0288000001/2']) {
    assert.ok(session.normalizeScan({ og: bad, pro: '8000001' }).reason, `refused: ${bad}`);
  }
});

test('a Davis piece counts ONLY on its own stop — not on a Uline stop sharing its last 7 digits', () => {
  const scans = [1, 2, 3].map((n) => ({ og: logic.davisPieceId(estes.stopNbr, n), pro: estes.primaryPro, stopNbr: estes.stopNbr }));
  assert.equal(logic.stopProgress(estes, scans).scanned, 3);
  assert.equal(logic.stopProgress(ulineTwin, scans).scanned, 0, 'the Uline twin does not read 3/1 off Estes freight');
  // and the Uline stop's own piece still counts the old way
  const uline = [{ og: 'OG6028000001', pro: '8000001', stopNbr: ulineTwin.stopNbr }];
  assert.equal(logic.stopProgress(ulineTwin, uline).scanned, 1);
});

test('the scanner gun delivers a Davis label whole — "/" and "-" survive the keyboard wedge', async () => {
  const { createWedgeAccumulator } = await import('../src/lib/wedge.js');
  const got = [];
  const acc = createWedgeAccumulator({ onScan: (v) => got.push(v) });
  for (const k of 'DD/ESTES-0288000001/3') acc.key(k);
  acc.key('Enter');
  assert.deepEqual(got, ['DD/ESTES-0288000001/3']);
  assert.equal(logic.classifyBarcode(got[0]).kind, 'davis');
});

// ── Two pages of one order side by side ──────────────────────────────────────
// Two skids of one order are routinely staged together, so both pages are in view at once.

test('native camera: two pages in ONE frame book one now and the other on the next frame — neither starves', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  const both = ['DD/SO-88213/1', 'DD/SO-88213/2'];
  const got = [];
  for (let k = 0; k < 30; k++) { const r = buf.push(both, t0 + k * 100); if (r) got.push(r.davis.seq); }
  assert.deepEqual(got, [1, 2], 'each page exactly once while both stay in view');
});

test('iPhone engine: two pages ALTERNATING frame by frame book once each, not once per cycle', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  const got = [];
  for (let k = 0; k < 60; k++) {
    const r = buf.push([k % 2 ? 'DD/SO-88213/2' : 'DD/SO-88213/1'], t0 + k * 150);
    if (r) got.push(r.davis.seq);
  }
  assert.deepEqual(got, [1, 2]);
});

test('a page that left view for a full window is a deliberate re-scan again (the Uline rule, per page)', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  assert.ok(buf.push(['DD/SO-88213/1'], t0));
  assert.equal(buf.push(['DD/SO-88213/1'], t0 + 2000), null);
  assert.ok(buf.push(['DD/SO-88213/1'], t0 + 2000 + 2600), 'out of view longer than the window');
});

test('a Davis read never changes how a Uline pair behaves: a held Uline label stays quiet across a Davis read', () => {
  const buf = logic.createPairBuffer({ windowMs: 2500 });
  const t0 = 1_000_000;
  assert.ok(buf.push(['7152411', 'OG6028479182'], t0));
  assert.ok(buf.push(['DD/SO-88213/1'], t0 + 200));
  assert.equal(buf.push(['7152411', 'OG6028479182'], t0 + 400), null, 'same Uline label still under the lens');
});

test('a lone Uline PRO that already outlived its window still books as EXPIRED when a Davis page is the next read', () => {
  const abandoned = [];
  const buf = logic.createPairBuffer({ windowMs: 2500, onAbandon: (h) => abandoned.push(h.reason) });
  const t0 = 1_000_000;
  assert.equal(buf.push(['7152411'], t0), null);
  assert.ok(buf.push(['DD/SO-88213/1'], t0 + 2700).davis);
  assert.deepEqual(abandoned, ['expired'], 'expired books its NOOG piece; superseded would have dropped it');
});

test('server: hand-added and over-the-count pieces on a stop whose key is shorter than 7 digits are ACCEPTED', () => {
  // SHP29379 keys to 29379 and SO-88213 to 88213 (normalizePro keeps the last 7 digits).
  assert.equal(logic.normalizePro('SHP29379'), '29379');
  for (const og of ['NOOG-29379-1', 'TYPED-88213-2', 'NOOG-0416694-1', 'TYPED-7152411-3']) {
    assert.equal(session.normalizeScan({ og, pro: og.split('-')[1] }).reason, undefined, og);
  }
  for (const bad of ['NOOG--1', 'NOOG-12345678-1', 'TYPED-ABC-1', 'NOOG-29379-1000']) {
    assert.ok(session.normalizeScan({ og: bad, pro: '29379' }).reason, `refused: ${bad}`);
  }
});

test('a Davis piece is judged against its OWN stop — a Uline stop sharing its key, listed first, does not set the verdict', () => {
  const twinAppt = { ...ulineTwin, appointmentRequired: true, instructions: 'CALL FOR APPT' };
  const pair = { pro: estes.primaryPro, og: logic.davisPieceId(estes.stopNbr, 1) };
  const r = logic.evaluateScan(pair, [estes], new Set());
  assert.equal(r.stop, estes);
  assert.equal(r.outcome, logic.OUTCOME.GREEN);
  assert.equal(r.instructions || '', '', "the twin's appointment text never lands on Estes freight");
  // and the reason it must be [estes] alone: the whole load, twin first, picks the twin
  assert.equal(logic.evaluateScan(pair, [twinAppt, estes], new Set()).stop, twinAppt);
});
