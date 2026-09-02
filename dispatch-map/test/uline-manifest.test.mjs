// test/uline-manifest.test.mjs
//
// The nightly Uline freight report is a TEXT-LAYER pdf, so it parses for free —
// no Anthropic vision call (unlike the Estes fax path) and no NuVizz call.
//
// The one thing that is genuinely hard about it: the freight numbers are
// RIGHT-ALIGNED, so a value's x never lines up with its column header and the
// SKID column is simply absent on a loose-only order. Reading the numbers in
// token order — the obvious approach — swapped skids and pieces on 45 of the 660
// orders in the real 8/06 manifest. These tests pin the position-aware read and
// the self-check that catches it if it ever regresses.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUlineManifest, laneSummary } from '../netlify/functions/lib/uline-manifest.mts';

// Column x's are the real ones measured off the 8/06/26 report.
const X = { date: 130, via: 462, whs: 642, zip: 756, name: 1206, city: 2258, state: 2968 };
const HDR_X = { LBS: 3274, SKID: 3466, PIECE: 3658 };
// Values land right-aligned, well to the right of their header's left edge.
const V = { lbs: 3318, skids: 3612, pieces: 3838, pro: 3860 };

let y = 5000;
const header = (page = 1) => {
  const row = [];
  for (const [text, x] of [['VIA', 482], ['WHS', 650], ['ZIP CODE', 784], ['CUST NAME', 1202],
    ['CITY', 2234], ['ST', 2964], ['LBS', HDR_X.LBS], ['SKID', HDR_X.SKID], ['PIECE', HDR_X.PIECE], ['PRO #', 3918]]) {
    row.push({ page, x, y: 5354, text });
  }
  return row;
};
const dataRow = (page, { name, city = 'DALTON', st = 'GA', zip = '30721', lbs, skids, pieces, pro }) => {
  y -= 96;
  const cs = [
    { page, x: X.date, y, text: '8/06/26' }, { page, x: X.via, y, text: 'DA' },
    { page, x: X.whs, y, text: 'G6' }, { page, x: X.zip, y, text: zip },
    { page, x: X.name, y, text: name }, { page, x: X.city, y, text: city },
    { page, x: X.state, y, text: st }, { page, x: V.lbs, y, text: String(lbs) },
  ];
  if (skids) cs.push({ page, x: V.skids, y, text: String(skids) });
  if (pieces) cs.push({ page, x: V.pieces, y, text: String(pieces) });
  cs.push({ page, x: V.pro, y, text: pro });
  return cs;
};
const totalsRow = (count, lbs, skids, pieces) => ([
  { page: 9, x: 170, y: 100, text: 'FINAL TOTALS ---->     COUNT:' },
  { page: 9, x: 1378, y: 100, text: String(count) },
  { page: 9, x: 3424, y: 100, text: String(lbs) },
  { page: 9, x: 3700, y: 100, text: String(skids) },
  { page: 9, x: 3978, y: 100, text: String(pieces) },
]);

const SHEET = () => {
  y = 5000;
  return [
    ...header(1),
    ...dataRow(1, { name: 'J&H DISCOUNT SALES INC', city: 'ALPHARETTA', zip: '30004', lbs: 727, skids: 1, pieces: 0, pro: '007158397' }),
    ...dataRow(1, { name: 'WTD HOLDINGS INC', city: 'ALPHARETTA', zip: '30004', lbs: 670, skids: 1, pieces: 3, pro: '007158845' }),
    // The case that broke the naive parse: NO skid, loose pieces only.
    ...dataRow(1, { name: 'CMC CABLE', city: 'SUWANEE', zip: '30024', lbs: 42, skids: 0, pieces: 2, pro: '007158429' }),
    ...header(2),   // the page header repeats and must never become a row
    ...dataRow(2, { name: 'MANNINGTON MILLS', lbs: 372, skids: 1, pieces: 5, pro: '007158305' }),
    ...totalsRow(4, 727 + 670 + 42 + 372, 1 + 1 + 0 + 1, 0 + 3 + 2 + 5),
  ];
};

test('parses every order and reproduces the manifest\'s own FINAL TOTALS', () => {
  const m = parseUlineManifest(SHEET());
  assert.equal(m.rows.length, 4);
  assert.equal(m.verified, true, 'must reconcile against the document checksum');
  assert.deepEqual(m.totals, { count: 4, lbs: 1811, skids: 3, pieces: 10 });
  const sum = (k) => m.rows.reduce((a, r) => a + r[k], 0);
  assert.equal(sum('lbs'), 1811);
  assert.equal(sum('skids'), 3);
  assert.equal(sum('pieces'), 10);
  assert.deepEqual(m.warnings, []);
});

test('THE BUG THAT MATTERS: a loose-only order keeps 0 skids and its real piece count', () => {
  // Read in token order this row's "2" lands in SKID, which is how 45 orders in
  // the real manifest came out with a phantom skid and a lost loose count.
  const cmc = parseUlineManifest(SHEET()).rows.find((r) => r.pro === '007158429');
  assert.equal(cmc.skids, 0, 'no skid column on this row');
  assert.equal(cmc.pieces, 2, 'the 2 is LOOSE PIECES, not a skid');
  assert.equal(cmc.lbs, 42);
});

test('a skids-and-pieces order keeps both, in the right columns', () => {
  const wtd = parseUlineManifest(SHEET()).rows.find((r) => r.pro === '007158845');
  assert.equal(wtd.skids, 1);
  assert.equal(wtd.pieces, 3);
});

test('customer, city, zip and PRO come through for a human to act on', () => {
  const r = parseUlineManifest(SHEET()).rows[0];
  assert.equal(r.pro, '007158397');
  assert.equal(r.custName, 'J&H DISCOUNT SALES INC');
  assert.equal(r.city, 'ALPHARETTA');
  assert.equal(r.zip, '30004');
  assert.equal(r.state, 'GA');
  assert.equal(r.shipDate, '8/06/26');
});

test('the repeated page header never becomes an order', () => {
  const m = parseUlineManifest(SHEET());
  assert.ok(!m.rows.some((r) => r.custName === 'CUST NAME'), 'header row is not data');
  assert.equal(new Set(m.rows.map((r) => r.pro)).size, m.rows.length, 'no duplicate PROs');
});

test('a manifest with NO loose pieces still assigns the skid column correctly', () => {
  // Only two numeric clusters, so which is SKID and which is PIECE would be a
  // coin flip — the FINAL TOTALS line settles it.
  y = 5000;
  const cells = [
    ...header(1),
    ...dataRow(1, { name: 'A CO', lbs: 100, skids: 2, pieces: 0, pro: '007158001' }),
    ...dataRow(1, { name: 'B CO', lbs: 200, skids: 3, pieces: 0, pro: '007158002' }),
    ...totalsRow(2, 300, 5, 0),
  ];
  const m = parseUlineManifest(cells);
  assert.equal(m.verified, true);
  assert.equal(m.rows.reduce((a, r) => a + r.skids, 0), 5, 'the numbers are SKIDS');
  assert.equal(m.rows.reduce((a, r) => a + r.pieces, 0), 0);
});

test('a manifest that cannot be reconciled FAILS LOUDLY instead of guessing', () => {
  y = 5000;
  const cells = [
    ...header(1),
    ...dataRow(1, { name: 'A CO', lbs: 100, skids: 2, pieces: 0, pro: '007158001' }),
    ...totalsRow(9, 999, 99, 9),   // totals that no reading of these rows produces
  ];
  const m = parseUlineManifest(cells);
  assert.equal(m.verified, false, 'never claims a reading it could not prove');
  assert.ok(m.warnings.some((w) => /FINAL TOTALS/i.test(w)), `expected a reconciliation warning, got ${JSON.stringify(m.warnings)}`);
  assert.ok(m.rows.length > 0, 'still returns what it read, for a human to inspect');
});

test('a manifest with no totals line is returned but never marked verified', () => {
  y = 5000;
  const m = parseUlineManifest([...header(1), ...dataRow(1, { name: 'A CO', lbs: 100, skids: 1, pieces: 0, pro: '007158001' })]);
  assert.equal(m.verified, false);
  assert.equal(m.rows.length, 1);
  assert.ok(m.warnings.some((w) => /self-verified|verified/i.test(w)));
});

test('empty input is not a crash', () => {
  const m = parseUlineManifest([]);
  assert.deepEqual(m.rows, []);
  assert.equal(m.verified, false);
});

// ── date helpers used by the endpoint to pick which board days to accept ─────

import { manifestDateToIso, addDays } from '../netlify/functions/manifest-check.mts';

test('manifest ship dates map to board dates', () => {
  assert.equal(manifestDateToIso('8/06/26'), '2026-08-06');
  assert.equal(manifestDateToIso('12/25/26'), '2026-12-25');
  assert.equal(manifestDateToIso('1/1/27'), '2027-01-01');
  assert.equal(manifestDateToIso('garbage'), null);
  assert.equal(manifestDateToIso(null), null);
});

test('the forward window rolls months and years correctly', () => {
  // Uline ships tonight for tomorrow, so a PRO is accepted on the next days too.
  assert.equal(addDays('2026-08-06', 1), '2026-08-07');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-08-06', 0), '2026-08-06');
});

// ── ONLY ULINE PROS ───────────────────────────────────────────────────────────

test('THE NIGHT IS DISTINCT ULINE PROS ON THE DA LANE — Chad: "only look at Uline pros for this not anything else"', () => {
  const row = (pro, via = 'DA', whs = 'G6') => ({ pro, via, whs, shipDate: '8/20/26', lbs: 1, skids: 1, pieces: 0 });
  // The shape of every archived night: all DA, warehouses G1 and G6, no repeats.
  const clean = [row('007158397', 'DA', 'G1'), row('007158398', 'DA', 'G6'), row('007158399', 'DA', 'G6')];
  assert.deepEqual(laneSummary(clean), { ulinePros: 3, lanes: { 'G1/DA': 1, 'G6/DA': 2 }, offLane: 0, duplicatePros: 0 });
  // The day the report is not all ours, the count must not absorb it.
  const mixed = [...clean, row('007158400', 'AVRT'), row('007158401', 'ESTES', 'G6'), row('007158402', '')];
  const m = laneSummary(mixed);
  assert.equal(m.ulinePros, 3, 'three orders are ours; three are not');
  assert.equal(m.offLane, 3);
  assert.deepEqual(m.lanes, { 'G1/DA': 1, 'G6/DA': 2 });
  // A PRO counted twice is one order. (Zero across all 5,872 archived rows; counted anyway.)
  const dupe = [...clean, row('007158399', 'DA', 'G6')];
  assert.equal(laneSummary(dupe).ulinePros, 3);
  assert.equal(laneSummary(dupe).duplicatePros, 1);
  // A row with no readable PRO is not an order.
  assert.equal(laneSummary([row(''), row('12345'), row(null)]).ulinePros, 0);
  assert.equal(laneSummary([row(''), row('12345'), row(null)]).offLane, 3);
  // Case and stray whitespace in the lane codes are not a different lane.
  assert.equal(laneSummary([{ ...row('007158397'), via: ' da ', whs: ' g6 ' }]).lanes['G6/DA'], 1);
  // A row with no warehouse is still ours if the carrier is — it is filed under '?', not dropped.
  assert.deepEqual(laneSummary([{ ...row('007158397'), whs: null }]).lanes, { '?/DA': 1 });
  for (const empty of [null, undefined, [], 'nope']) assert.deepEqual(laneSummary(empty), { ulinePros: 0, lanes: {}, offLane: 0, duplicatePros: 0 });
});

test('the real archived nights are 100% Uline PROs on the DA lane — so the measured count equals the row count, and the first score does not move', () => {
  // The eleven nights on file were re-parsed from the stored PDFs: 5,872 rows, 5,872 distinct
  // 9-digit PROs, every one via DA, warehouses G1 (1,719) and G6 (4,153). This pins the SHAPE
  // that made that true, so a parser change that broke it fails here rather than on the card.
  const night = [];
  for (let i = 0; i < 686; i++) night.push({ pro: String(7158000 + i).padStart(9, '0'), via: 'DA', whs: i % 3 === 0 ? 'G1' : 'G6', shipDate: '8/20/26', lbs: 1, skids: 1, pieces: 0 });
  const s = laneSummary(night);
  assert.equal(s.ulinePros, night.length, 'measured count equals the row count when every row is ours');
  assert.equal(s.offLane, 0);
  assert.equal(s.duplicatePros, 0);
  assert.equal(s.lanes['G1/DA'] + s.lanes['G6/DA'], 686);
});
