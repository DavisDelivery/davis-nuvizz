#!/usr/bin/env node
// scripts/verify-card-manifest.mjs — DOES A COMPARE CARD PRINT WHAT IT SHOWS, BEFORE ANY SAVE?
//
// Chad: "I want my manifest to always match what is in dispatch map."
//
// test/card-manifest.test.mjs runs the real manifest builder and proves the RULE. It cannot
// prove the Print manifest button on a real card hands the builder the card's order, or that
// the pages the browser would print come out in it — and the defect it fixes was exactly a
// right-looking call whose result nobody read back. So this drives the real bundle: opens a
// load in Compare, re-sequences it WITHOUT saving (Reverse), presses Print manifest, and reads
// the tickets out of the print bridge — the markup window.print() actually prints.
//
//   node scripts/verify-card-manifest.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8830)
//     MOBILE=1       the phone layout instead of the desktop one
//     EXPECT_NUVIZZ_ORDER=1   for a build made with VITE_MANIFEST_IN_CARD_ORDER=off: the paper
//                    must then come out in NuVizz's order — the switch really puts it back
//     SHOT=path.png  also write a screenshot of the open manifest
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8830;
const MOBILE = process.env.MOBILE === '1';
const EXPECT_OLD = process.env.EXPECT_NUVIZZ_ORDER === '1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
// A HARD CEILING ON THE WHOLE RUN (the verify-loads-tab lesson): a guard that hangs blocks the
// merge and says nothing, which is worse than one that fails. Locally the run is ~15s.
const GUARD_MS = Number(process.env.CARD_MANIFEST_TIMEOUT_MS) || 3 * 60 * 1000;
const watchdog = setTimeout(() => {
  console.error(`\n✗ verify-card-manifest exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build`);
  process.exit(1);
}, GUARD_MS);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

// ONE LOAD, FIVE STOPS, NuVizz's sequence 1..5 running north out of Buford. The card is then
// reversed on screen and never saved — the exact state Chad printed from.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const NAMES = ['MANIFEST CO A', 'MANIFEST CO B', 'MANIFEST CO C', 'MANIFEST CO D', 'MANIFEST CO E'];
const STOPS = NAMES.map((businessName, i) => ({
  stopNbr: `0071900${i}0`, pro: `71900${i}0`, businessName,
  addr1: `${200 + i} Print Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + (8 + i * 6) * DEG, lng: DEPOT.lng + (i % 2 ? 0.02 : -0.02),
  cartons: 1, volume: 0, weight: 300,
  status: '10', normalizedStatus: 'PLANNED', stopType: 'DL',
  // loadId is required: openRouteInWorkbench refuses a card it could never save.
  loadNbr: 'DAVIS000199001', routeName: 'MANIFEST 1', loadId: 'ld-manifest-1', routeSeq: i + 1,
  driverName: 'TEST DRIVER', driverUserName: 'tdriver',
  matchKey: `manifest_${i}`,
}));
const NUVIZZ_ORDER = NAMES.slice();

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const page = await (await browser.newContext(MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1600, height: 1000 } })).newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Every function answers, and none of them is NuVizz: the board comes from the fixture above.
await page.route('**/.netlify/functions/**', (route) => {
  const u = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (u.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: STOPS, count: STOPS.length, source: 'fixture' });
  if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
  if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
  return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
});
for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);

// Reach Routing through the navigation each layout actually has.
if (MOBILE) {
  await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
  await page.waitForTimeout(900);
}
const routingTab = page.getByText('Routing (beta)', { exact: true }).first();
if (await routingTab.isVisible().catch(() => false)) ok('Routing is reachable from the navigation');
else bad('Routing is not reachable from the navigation');
await routingTab.click().catch(() => {});
await page.waitForTimeout(1600);

if (MOBILE) {
  // The board status card sits over the Loads tab at 390px; collapse it the way a router would.
  await page.getByRole('button', { name: /stops$/i }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}
const loadsTab = page.getByRole('button', { name: /^Loads/ }).first();
if (await loadsTab.isVisible().catch(() => false)) { await loadsTab.click().catch(() => {}); await page.waitForTimeout(1000); }
const loadRow = page.getByText(/MANIFEST 1/).first();
if (await loadRow.isVisible().catch(() => false)) ok('the load is listed on the routing screen');
else bad('the load never appeared on the routing screen');
await loadRow.click().catch(() => {});
await page.waitForTimeout(1600);

// The card's own rows, in the order the dispatcher sees them — read off the card that owns the
// Print manifest button, never off some other list that happens to carry the same names.
const cardOrder = () => page.evaluate((names) => {
  const btn = [...document.querySelectorAll('button')].find((b) => /Print manifest/i.test(b.textContent || ''));
  let card = btn;
  while (card && !card.querySelector('ol')) card = card.parentElement;
  if (!card) return null;
  return [...card.querySelectorAll('ol > li')]
    .map((li) => names.find((n) => (li.innerText || '').includes(n)))
    .filter(Boolean);
}, NAMES);

const opened = await cardOrder();
if (opened && opened.length === 5) ok(`the load opened in Compare with its 5 stops (${opened.map((n) => n.slice(-1)).join(' ')})`);
else bad(`the Compare card did not open with 5 readable rows (got ${JSON.stringify(opened)})`);

// RE-SEQUENCE ON SCREEN, SAVE NOTHING. Reverse is a local re-order: no Save, no NuVizz call.
const picked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /Print manifest/i.test(b.textContent || ''));
  let card = btn;
  while (card && !card.querySelector('select')) card = card.parentElement;
  const sel = card?.querySelector('select');
  if (!sel || ![...sel.options].some((o) => o.value === 'reverse')) return false;
  sel.setAttribute('data-verify-reseq', '1');
  return true;
});
if (picked) await page.selectOption('select[data-verify-reseq="1"]', 'reverse').catch(() => {});
await page.waitForTimeout(900);
const onCard = await cardOrder();
if (onCard && onCard.length === 5 && onCard.join() !== NUVIZZ_ORDER.join()) ok(`re-sequenced on the card, unsaved: ${onCard.map((n) => n.slice(-1)).join(' ')}`);
else bad(`the card did not re-sequence (still ${JSON.stringify(onCard)}) — nothing below would mean anything`);

// PRINT.
await page.getByRole('button', { name: /Print manifest/i }).first().click().catch(() => {});
await page.waitForTimeout(1200);

// The print bridge is what window.print() puts on paper (PrintDocModal).
const paper = await page.evaluate((names) => {
  const bridge = document.querySelector('.printdoc-bridge');
  if (!bridge) return null;
  return [...bridge.querySelectorAll('section.tkt')].map((t) => ({
    name: names.find((n) => (t.querySelector('.ship-name')?.textContent || '').includes(n)) || null,
    seq: (t.querySelector('.seq')?.textContent || '').trim(),
  }));
}, NAMES);
if (!paper) bad('no print bridge — the manifest viewer did not open');
else if (paper.length !== 5) bad(`the manifest carries ${paper.length} tickets, not 5`);
else {
  const printedOrder = paper.map((p) => p.name);
  const want = EXPECT_OLD ? NUVIZZ_ORDER : onCard;
  const label = EXPECT_OLD ? "NuVizz's order (switch off)" : 'the card order, unsaved';
  if (printedOrder.join() === (want || []).join()) ok(`the paper prints ${label}: ${printedOrder.map((n) => n.slice(-1)).join(' ')}`);
  else bad(`the paper prints ${printedOrder.map((n) => n?.slice(-1)).join(' ')} — expected ${label}: ${(want || []).map((n) => n.slice(-1)).join(' ')}`);
  const seqs = paper.map((p) => p.seq);
  if (EXPECT_OLD) {
    // Switched off, each circle carries NuVizz's number for its stop, as it always did.
    const nuvizzSeq = paper.map((p) => String(NAMES.indexOf(p.name) + 1));
    if (seqs.join() === nuvizzSeq.join()) ok(`each ticket carries NuVizz's number (${seqs.join(' ')})`);
    else bad(`ticket numbers ${seqs.join(' ')} are not NuVizz's (${nuvizzSeq.join(' ')})`);
  } else if (seqs.join() === '1,2,3,4,5') ok('each ticket carries the number its row wears on the card (1 2 3 4 5)');
  else bad(`ticket numbers read ${seqs.join(' ')} — the card numbers its rows 1 2 3 4 5`);
}

if (process.env.SHOT) { await page.screenshot({ path: process.env.SHOT }); ok(`screenshot ${process.env.SHOT}`); }

if (errors.length) bad(`page errors: ${errors.slice(0, 3).join(' | ')}`);
else ok('no page errors');

clearTimeout(watchdog);
await browser.close();
server.close();
// A keep-alive socket Chromium left open would make server.close() wait for ever; the explicit
// exit below ends the process either way, and this lets the port go at once.
server.closeAllConnections?.();
console.log(fails.length ? `\n✗ ${fails.length} check(s) failed` : `\n✓ Compare-card manifest verified in a real browser (${MOBILE ? 'phone' : 'desktop'}${EXPECT_OLD ? ', switch off' : ''})`);
process.exit(fails.length ? 1 : 0);
