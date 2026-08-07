#!/usr/bin/env node
// scripts/verify-manifest-tab.mjs — does the More menu open, does the manifest
// check run, and does the FLAG actually appear on the nav?
//
// Unit tests prove the flag RULE. They cannot prove the nav renders it, and a
// flag nobody can see is the same as no flag. This drives the real bundle.
//
//   node scripts/verify-manifest-tab.mjs [distDir]
//     CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8801)
//     SUSPECTS=0|N    how many missing orders the stubbed check reports

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8801;
const N = Number(process.env.SUSPECTS ?? 2);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

const suspects = Array.from({ length: N }, (_, i) => ({
  pro: `0071589${String(90 + i).padStart(2, '0')}`, custName: `GHOST CO ${i + 1}`,
  city: 'ALPHARETTA', zip: '30004', lbs: 500 + i, skids: 1, pieces: 0, shipDate: '8/06/26',
}));
const CHECK = {
  ok: true, mode: 'board-diff', nuvizzCalls: 0,
  manifest: { orders: 660, totals: { count: 660, lbs: 359769, skids: 1019, pieces: 310 }, verified: true, warnings: [] },
  checkedAgainst: [{ date: '2026-08-06', stops: 658 }, { date: '2026-08-07', stops: 640 }],
  onBoard: 660 - N, boardOnly: 12, duplicatePros: [], suspects,
  summary: `660 on the manifest · ${660 - N} on the board`,
};

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST}`); process.exit(1); }

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
let checkCalls = 0, probeParam = null;
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('manifest-check')) { checkCalls++; probeParam = new URL(url).searchParams.get('probe'); return json(CHECK); }
  if (url.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: [], count: 0 });
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));

console.log(`\nManifest check tab — live render (${N} missing order(s) stubbed)`);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const more = page.getByRole('button', { name: /more/i }).first();
(await more.isVisible().catch(() => false)) ? ok('the More menu is on the nav') : bad('no More menu on the nav');
await more.click(); await page.waitForTimeout(400);
const item = page.getByRole('menuitem', { name: /manifest check/i }).first();
(await item.isVisible().catch(() => false)) ? ok('Manifest check is listed inside it') : bad('Manifest check missing from the menu');
await item.click(); await page.waitForTimeout(800);

let body = await page.evaluate(() => document.body.innerText);
/Manifest check/i.test(body) ? ok('the tab opened') : bad('the tab did not open');
/Zero NuVizz calls/i.test(body) ? ok('the screen states its cost up front') : bad('no cost statement on the screen');

// Feed it a PDF through the real file input.
await page.setInputFiles('input[type=file]', { name: 'Uline_DA_210252748.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 stub') });
await page.waitForTimeout(1200);
checkCalls === 1 ? ok('dropping the PDF ran the check exactly once') : bad(`expected 1 check call, got ${checkCalls}`);
probeParam === null ? ok('and NEVER asked for the NuVizz probe') : bad(`the UI requested probe=${probeParam} — it must never spend NuVizz calls`);

body = await page.evaluate(() => document.body.innerText);
if (N > 0) {
  new RegExp(`${N} orders? on the manifest`, 'i').test(body)
    ? ok('the headline names the missing orders') : bad(`no headline about ${N} missing order(s)`);
  /GHOST CO 1/.test(body) ? ok('the missing order is listed with its customer') : bad('the suspect table did not render');
  /007158990/.test(body) ? ok('...and its PRO') : bad('no PRO in the suspect table');
} else {
  /All 660 manifest orders found/i.test(body) ? ok('a clean run says so plainly') : bad('a clean run did not report clean');
  !/GHOST CO/.test(body) ? ok('and lists no suspects') : bad('a clean run listed suspects');
}
/359,769/.test(body) ? ok('the manifest totals render') : bad('totals missing');
/match the ones printed on the manifest/i.test(body) ? ok('and are marked as reconciled') : bad('no reconciliation statement');

// THE FLAG on the nav, and whether it survives a reload.
const badgeOf = async () => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /more/i.test(x.textContent || ''));
  const m = b && (b.textContent || '').match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
});
const live = await badgeOf();
live === N ? ok(`the nav badge reads ${N} without leaving the tab`) : bad(`nav badge is ${live}, expected ${N}`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const after = await badgeOf();
after === N ? ok(`the flag SURVIVES a reload (still ${N})`) : bad(`after reload the badge is ${after}, expected ${N}`);

await browser.close(); server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ manifest check tab verified in a real browser\n');
