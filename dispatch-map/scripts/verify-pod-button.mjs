#!/usr/bin/env node
// scripts/verify-pod-button.mjs — does the POD photo button ACTUALLY render?
//
// The unit tests prove the RULE (podPhotoFetchOffer). They cannot prove the card
// renders what the rule returns — and twice now the button has been present in
// the rule and absent on the screen. So this drives the real built bundle in a
// real browser, feeds it the exact stop from the report (PRO 007157687-1, route
// VINCENT, a single BOL PDF, board status SCHEDULED), opens the card, and fails
// unless "View delivery photos" is in the DOM.
//
// Usage: node scripts/verify-pod-button.mjs [distDir]
//   CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8793)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8793;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

// The board loads TODAY by default, so the fixture rides today's board.
const TODAY = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

// The reported stop, as the BOARD sees it: delivered in NuVizz, but carrying the
// cheap list's SCHEDULED status (deliveredDTTM is not a live list field) and one
// BOL PDF. This is the exact shape that hid the button under both old gates.
const BOARD_STOP = {
  _id: 'davis__007157687-1',
  stopNbr: '007157687-1', pro: '007157687-1', primaryPro: '007157687-1', pros: ['007157687-1'],
  businessName: 'CURANT HEALTH OF GA',
  addr1: '1 Curant Way', city: 'Suwanee', state: 'GA', zip: '30024',
  lat: 34.0515, lng: -84.0713,
  status: '10', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: 'VINCENT', routeName: 'VINCENT', driverName: 'Vincent Bonzo', driverUserName: 'VINCENT',
  routeSeq: 4, stopType: 'DO',
  boardDate: TODAY, scheduledDate: TODAY,
  pallets: 1, cartons: 0, volume: 1, weight: 149,
  enriched: true,
  podDocs: [{ documentName: 'BOL', documentGuid: 'bol-guid-1', documentPath: '/x/bol.pdf', extension: 'PDF', createdTime: '2026-08-06T18:01:00' }],
};

try { if (!(await stat(DIST)).isDirectory()) throw new Error('not a dir'); }
catch { console.error(`no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const candidate of [join(DIST, path), join(DIST, 'index.html')]) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream' });
      return res.end(body);
    } catch { /* fall through */ }
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();

let lookupCalls = 0;
// Every backend call is stubbed — this test never touches NuVizz or Firestore.
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('nuvizz-pull-today-stops')) {
    return json({ ok: true, stops: [BOARD_STOP], count: 1, date: TODAY });
  }
  if (url.includes('nuvizz-pro-lookup')) {
    lookupCalls++;
    // EMPTY_PULL simulates NuVizz genuinely having nothing — the case that used to
    // erase the BOL already on screen (a raw spread let podDocs:[] shadow it).
    if (process.env.EMPTY_PULL === '1') return json({ ok: true, stop: { ...BOARD_STOP, podDocs: [] } });
    return json({ ok: true, stop: { ...BOARD_STOP, podDocs: [
      ...BOARD_STOP.podDocs,
      { documentName: 'delivery', documentGuid: 'photo-1', documentPath: '/x/p1.jpg', extension: 'JPG', createdTime: '2026-08-06T18:02:00' },
    ] } });
  }
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));

console.log('\nPOD photo button — live render check');
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Open the order the way a dispatcher does: click its row in the bottom grid.
const row = await page.$('tbody tr');
if (!row) bad('the stop never reached the grid — the fixture does not match the board shape');
else { await row.click(); await page.waitForTimeout(1500); }

const body = await page.evaluate(() => document.body.innerText);
const cardOpen = /CURANT HEALTH OF GA/i.test(body);
cardOpen ? ok('the stop card opened') : bad('could not open the stop card — cannot verify the button');

if (cardOpen) {
  /PROOF OF DELIVERY/i.test(body)
    ? ok('the PROOF OF DELIVERY section renders')
    : bad('no PROOF OF DELIVERY section on a stop that has a BOL');

  /\bBOL\b/.test(body) ? ok('the BOL is still listed') : bad('the BOL vanished from the section');

  // Same card proves the other fix. Scope to the card's ROUTE block (between the
  // ROUTE heading and the PROS heading) — the page also lists VINCENT in the
  // Routes side panel and the header chip, which are not what this is about.
  const block = (body.split(/^ROUTE$/m)[1] || '').split(/^PROS\b/m)[0] || '';
  const vincents = (block.match(/^VINCENT$/gim) || []).length;
  vincents === 1
    ? ok('inside the ROUTE block the identifier prints ONCE (load number deduped)')
    : bad(`route name printed ${vincents}\u00d7 in the ROUTE block — expected 1\n--- block ---\n${block}`);

  const btn = page.getByRole('button', { name: /view delivery photos/i }).first();
  const visible = await btn.isVisible().catch(() => false);
  if (visible) {
    ok('"View delivery photos" IS on the card — on a SCHEDULED stop that already has a BOL');
    await btn.click();
    await page.waitForTimeout(1200);
    lookupCalls === 1
      ? ok(`tapping it made exactly ${lookupCalls} lookup call`)
      : bad(`expected 1 lookup call, got ${lookupCalls}`);
    const after = await page.evaluate(() => document.body.innerText);
    if (process.env.EMPTY_PULL === '1') {
      // Nothing came back. The card must say so, and must NOT have lost the BOL.
      /no delivery photos on file/i.test(after)
        ? ok('an empty pull reports "no delivery photos on file"')
        : bad('an empty pull said nothing at all');
      /\bBOL\b/.test(after)
        ? ok('an EMPTY pull did not erase the BOL already on screen')
        : bad('the empty pull ERASED the BOL — you asked for more and got less');
    } else {
      const gone = !(await page.getByRole('button', { name: /view delivery photos/i }).first().isVisible().catch(() => false));
      const img = await page.locator('img[alt*="delivery" i], img[alt*="POD" i]').count();
      (gone || img > 0)
        ? ok('after the pull the photo arrived and the button stood down')
        : bad('the pull returned a photo but the card did not fold it in');
      /\bBOL\b/.test(after) ? ok('the BOL survived the refresh') : bad('the refresh erased the BOL');
    }
  } else {
    bad('"View delivery photos" is NOT on the card — this is the reported bug, unfixed');
    console.error('\n--- card text ---\n' + body.slice(0, 1800));
  }
}

await page.screenshot({ path: 'pod-button-check.png', fullPage: true }).catch(() => {});
await browser.close();
server.close();

if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ POD photo button verified in a real browser\n');
