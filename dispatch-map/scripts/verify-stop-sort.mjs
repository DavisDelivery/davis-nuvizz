#!/usr/bin/env node
// scripts/verify-stop-sort.mjs — does the phone's Skids sort actually reorder the board?
//
// Chad: "also want to be able to sort this screen by skids." Unit tests pin the comparator
// (test/stop-sort.test.mjs); they cannot prove the chip is on the screen, that tapping it
// reorders the rows, or that the choice survives a reload. This drives the real bundle.
//
//   node scripts/verify-stop-sort.mjs [distDir]
//     CHROMIUM_PATH  browser binary      SHOTS_PORT  port (default 8831)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SHOTS_PORT) || 8831;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

// A board with deliberately jumbled skid counts, including a stop with NONE — the case that
// must sort to the "fewest" end rather than vanish. `cartons` is NuVizz's field for skids.
const SKIDS = [3, 14, 1, 0, 7, 22, 5];
const STOPS = SKIDS.map((cartons, i) => ({
  stopNbr: `007${161700 + i}`, pro: `${7161700 + i}`, businessName: `CUSTOMER ${String.fromCharCode(65 + i)}`,
  addr1: `${100 + i} Main St`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: 34.12 + i * 0.01, lng: -83.98 - i * 0.01,
  cartons, volume: 0, status: 'SCHEDULED', matchKey: `k${i}`,
}));

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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/.netlify/functions/**', (route) => {
  const u = route.request().url();
  const body = u.includes('nuvizz-pull-today-stops')
    ? { ok: true, stops: STOPS, count: STOPS.length, source: 'fixture' }
    : { ok: true };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());

// The visible skid counts, top to bottom, read off the rendered rows.
const order = () => page.evaluate(() => [...document.querySelectorAll('button')]
  .map((b) => b.innerText)
  .filter((t) => /\bskids?\b/.test(t))
  .map((t) => Number((t.match(/(\d+)\s+skids?/) || [])[1]))
  .filter((n) => Number.isFinite(n)));

const openStops = async () => {
  await page.locator('nav button', { hasText: /^Stops$/i }).first().click();
  await page.waitForTimeout(700);
};

console.log('\nPhone Stops — sort by skids');
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await openStops();

const board = await order();
// A stop with 0 skids prints no freight line at all, so it contributes no number — the
// board here shows the six non-zero rows in feed order.
const expectBoard = SKIDS.filter((n) => n > 0);
JSON.stringify(board) === JSON.stringify(expectBoard)
  ? ok(`board order is the default (${board.join(', ')})`)
  : bad(`board order was ${JSON.stringify(board)}, expected ${JSON.stringify(expectBoard)}`);

const skidsChip = page.getByRole('button', { name: /^Skids/ }).first();
(await skidsChip.isVisible().catch(() => false)) ? ok('the Skids chip is on the screen') : bad('no Skids chip on the Stops tab');

await skidsChip.click();
await page.waitForTimeout(500);
const desc = await order();
const wantDesc = [...expectBoard].sort((a, b) => b - a);
JSON.stringify(desc) === JSON.stringify(wantDesc)
  ? ok(`one tap → most skids first (${desc.join(', ')})`)
  : bad(`one tap gave ${JSON.stringify(desc)}, expected ${JSON.stringify(wantDesc)}`);

await skidsChip.click();
await page.waitForTimeout(500);
const asc = await order();
const wantAsc = [...expectBoard].sort((a, b) => a - b);
JSON.stringify(asc) === JSON.stringify(wantAsc)
  ? ok(`tapping again → fewest first (${asc.join(', ')})`)
  : bad(`second tap gave ${JSON.stringify(asc)}, expected ${JSON.stringify(wantAsc)}`);

// The zero-skid stop must still be in the list — sorting must never drop freight-less work.
const rows = await page.evaluate(() => document.body.innerText.match(/CUSTOMER [A-G]/g)?.length || 0);
rows === SKIDS.length ? ok(`all ${rows} stops still listed, including the one with no skids`) : bad(`only ${rows} of ${SKIDS.length} stops rendered while sorted`);

// The choice must survive a reload — Chad sorts the morning board once.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await openStops();
const afterReload = await order();
JSON.stringify(afterReload) === JSON.stringify(wantAsc)
  ? ok('the sort survives a reload')
  : bad(`after reload the order was ${JSON.stringify(afterReload)}, expected ${JSON.stringify(wantAsc)}`);

// And "Board order" must put it back.
await page.getByRole('button', { name: /^Board order$/ }).first().click();
await page.waitForTimeout(400);
const restored = await order();
JSON.stringify(restored) === JSON.stringify(expectBoard)
  ? ok('Board order puts the feed order back')
  : bad(`Board order gave ${JSON.stringify(restored)}, expected ${JSON.stringify(expectBoard)}`);

if (errors.length) bad(`uncaught page errors: ${errors.slice(0, 3).join(' | ')}`);

await browser.close();
server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ skids sort verified\n');
