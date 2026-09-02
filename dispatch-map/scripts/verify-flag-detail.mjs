#!/usr/bin/env node
// scripts/verify-flag-detail.mjs — DOES CLICKING A FLAG ROW ACTUALLY OPEN ITS DETAIL?
//
// Chad: "I want to be able to click on these rows and get details." A unit test proves the
// SENTENCES are right; it cannot prove a row is clickable, that the panel mounts, or that it
// is reachable on a phone — and a panel nobody can open is the same as no panel. This drives
// the real bundle with the REAL stored rows (test/fixtures/flag-detail-rows.json, read back
// from the live history endpoint) and reads the text off the screen.
//
//   node scripts/verify-flag-detail.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8804)
//     MOBILE=1       the phone layout (full-screen sheet) instead of the desktop dialog
//     SHOT=path.png  also write a screenshot
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8804;
const MOBILE = process.env.MOBILE === '1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

const FX = JSON.parse(await readFile(new URL('../test/fixtures/flag-detail-rows.json', import.meta.url), 'utf8'));
const DATE = '2026-09-02';
const ROWS = Object.values(FX.screenshot).map((x) => x.row);
const SUMMARY = { flags: ROWS.length, made: 7, missed: 0, rolled: 0, deliveredLate: 0, undelivered: 0, unknown: 6, emailed: 1, actedOn: 1, warned: ROWS.length, tooLateToAct: 0, medianLeadMin: 660, missedAfterWarning: 0, gradable: 7 };

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
const page = await (await browser.newContext(MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1440, height: 1000 } })).newPage();

await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('eta-flag-history')) {
    // The one-day read the accordion makes, and the range read the screen opens with.
    if (/[?&]date=/.test(url)) return json({ ok: true, date: DATE, found: true, rows: ROWS, summary: SUMMARY });
    return json({
      ok: true, daysWithData: 1, total: SUMMARY,
      results: [{ date: DATE, found: true, scored: false, liveScored: true, nextDayCaptured: null, summary: SUMMARY }],
    });
  }
  return json({ ok: true, stops: [], entries: [], items: [], rows: [], results: [], count: 0 });
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);

// Reach Flag history: desktop through the More menu, phone through the menu chip.
const more = MOBILE
  ? page.locator('[data-phone-menu-trigger], header button').first()
  : page.getByRole('button', { name: /more/i }).first();
await more.click().catch(() => {});
await page.waitForTimeout(400);
const entry = page.getByText(/flag history/i).first();
if (await entry.isVisible().catch(() => false)) ok('Flag history is reachable from the navigation');
else bad('Flag history is not reachable from the navigation');
await entry.click().catch(() => {});
await page.waitForTimeout(900);

// Open the day, which loads the rows.
const day = page.getByText(DATE).first();
if (await day.isVisible().catch(() => false)) ok(`the ${DATE} day row is on the screen`);
else bad(`no ${DATE} day row`);
await day.click().catch(() => {});
await page.waitForTimeout(700);

const row = page.getByRole('button', { name: /Details for WALKER SCHOOL/i }).first();
if (await row.isVisible().catch(() => false)) ok('the flag row exposes itself as an activatable Details control');
else bad('the flag row is not activatable — nothing to click');

// THE TAP TARGET. The phone guard's floor is 40px; a row a thumb cannot hit is not clickable.
const box = await row.boundingBox().catch(() => null);
if (box && box.height >= 40) ok(`the row is ${Math.round(box.height)}px tall`);
else bad(`the row is only ${box ? Math.round(box.height) : '?'}px tall — under the 40px floor`);

await row.click().catch(() => {});
await page.waitForTimeout(500);

const dialog = page.getByRole('dialog', { name: /Flag detail for WALKER SCHOOL/i }).first();
if (await dialog.isVisible().catch(() => false)) ok(`the ${MOBILE ? 'phone sheet' : 'desktop dialog'} opened`);
else bad('clicking the row opened nothing');

const text = (await dialog.innerText().catch(() => '')) || '';
// The sentences that make this panel worth opening — each is the ANSWER to a question the
// table cannot answer, so each is checked by its meaning rather than by a class name.
const must = [
  [/PRO SHP30935/, 'the PRO'],
  [/Delivered\s+8:18a/, 'when it actually delivered'],
  [/1h 42m before the close/, 'how far inside the window it landed'],
  [/4h 30m past the close/, 'what we projected at the time'],
  [/read automatically from the customer’s note/, 'where the receiving close came from'],
  [/assumed departure/, 'that the clock was not anchored on a real arrival'],
  [/seen in 11 sweeps/, 'how persistent the flag was'],
  [/urgent email went to customer service/, 'what a person did about it'],
  [/the projection was out by 6h 12m/, 'the projection error — the reason to open this at all'],
];
for (const [re, what] of must) {
  if (re.test(text)) ok(`it says ${what}`);
  else bad(`it does not say ${what} (${re})`);
}
// It must not invent a wall-clock time for a projection (see flag-detail.js rule 2).
if (/projected to arrive \d+:\d\d[ap]/.test(text)) bad('a projection is rendered as a clock time');
else ok('projections are durations past the close, never a clock time');

if (process.env.SHOT) { await page.screenshot({ path: process.env.SHOT, fullPage: !MOBILE }); ok(`screenshot ${process.env.SHOT}`); }

// And it closes — by Escape, and by the button. A panel that only closes one way is a trap.
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
if (await dialog.isVisible().catch(() => false)) bad('Escape did not close the panel');
else ok('Escape closes it');
await row.click().catch(() => {});
await page.waitForTimeout(400);
await page.getByRole('button', { name: /^done$/i }).first().click().catch(() => {});
await page.waitForTimeout(400);
if (await dialog.isVisible().catch(() => false)) bad('Done did not close the panel');
else ok('Done closes it');

await browser.close();
server.close();
console.log(fails.length ? `\n✗ ${fails.length} check(s) failed` : `\n✓ flag detail verified in a real browser (${MOBILE ? 'phone' : 'desktop'})`);
process.exit(fails.length ? 1 : 0);
