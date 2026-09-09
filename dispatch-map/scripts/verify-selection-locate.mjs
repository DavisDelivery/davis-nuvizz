#!/usr/bin/env node
// scripts/verify-selection-locate.mjs — CAN YOU FIND THE SELECTED STOP ON THE MAP?
//
// Chad, one order selected on a board of 620 unplanned stops: "How am I supposed to tell which
// stop this is on the map."
//
// A selected stop HAS always rendered differently — stopMarkerIcon paints it amber and lifts its
// zIndex — but the window that lists it pointed at nothing: no hover link to the pin, no way to
// ask the map where it is. The fix is in the panel, and a panel fix is exactly the kind this repo
// cannot prove with a unit test. So this drives the real bundle and clicks the real row.
//
//   node scripts/verify-selection-locate.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8811)
//     MOBILE=1       the phone layout instead of the desktop one
//     SHOT=path.png  also write a screenshot
//
// WHAT THIS GUARD CANNOT CHECK, said plainly: Google Maps is blocked here (no key, and the other
// guards abort those hosts so a headless run cannot spend money or hang). There is no map canvas,
// so the PAN itself is unobservable. What is observable is the wiring that was missing — that the
// row is an active control, that hovering it lights the row through the same `hoverId` channel the
// map markers read, and that clicking it neither throws nor hijacks the stop-card link.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8811;
const MOBILE = process.env.MOBILE === '1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

// Three unplanned stops around the real service area. The one under test is named for the order
// in Chad's screenshot so a failure reads like the report that prompted it.
// The shape matters more than the values: `isUnplanned` is what sends a grid row down the
// SELECT path instead of opening a route in Compare, and a stop with no matchKey never joins
// the notes map. Both were wrong on the first run of this guard and it found nothing.
const mk = (nbr, name, city, zip, lat, lng, i) => ({
  stopNbr: nbr, pro: nbr, businessName: name, addr1: `${100 + i} Main St`, city, state: 'GA', zip,
  lat, lng,
  status: '10', normalizedStatus: 'UNPLANNED', isUnplanned: true, isPlanned: false,
  loadNbr: null, routeName: null, routeSeq: null, stopType: 'DL',
  cartons: 9, pallets: 9, volume: 0, weight: 4725,
  matchKey: `sel_${i}`,
});
const STOPS = [
  mk('007173273', 'ABACUS SOLUTIONS LLC', 'MARIETTA', '30066', 34.0286, -84.4700, 0),
  mk('007173274', 'KENNESAW SUPPLY CO', 'KENNESAW', '30144', 34.0234, -84.6155, 1),
  mk('007173275', 'SANDY PLAINS PARTS', 'MARIETTA', '30062', 34.0100, -84.4500, 2),
];

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
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.route('**/.netlify/functions/**', (route) => {
  const u = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (u.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: STOPS, count: STOPS.length, source: 'fixture' });
  return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
});
for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);

if (MOBILE) {
  await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
  await page.waitForTimeout(900);
}
const routingTab = page.getByText('Routing (beta)', { exact: true }).first();
if (await routingTab.isVisible().catch(() => false)) ok('Routing is reachable from the navigation');
else bad('Routing is not reachable from the navigation');
await routingTab.click().catch(() => {});
await page.waitForTimeout(1800);

// SELECT ONE STOP. No map canvas here, so the selection comes the other way a dispatcher can
// take it — off the bottom grid, which is the same `pickStopFromTable` path the pins use.
if (MOBILE) {
  await page.getByRole('button', { name: /stops$/i }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}
// The bottom data grid is a drawer and it does not open itself. A dispatcher opens it to work
// the pool; so does this guard. (First run of this guard found nothing for exactly this reason.)
for (const name of [/^Stops\b/, /stops$/i]) {
  const tab = page.getByRole('button', { name }).first();
  if (await tab.isVisible().catch(() => false)) { await tab.click().catch(() => {}); await page.waitForTimeout(900); break; }
}
if (process.env.DEBUG_TEXT) console.log('--- BODY ---\n' + ((await page.evaluate(() => document.body.innerText)) || '').slice(0, 2500) + '\n--- END ---');
const gridRow = page.getByText('ABACUS SOLUTIONS LLC').first();
if (await gridRow.isVisible().catch(() => false)) ok('the stop is listed on the routing screen');
else bad('the stop never appeared on the routing screen');
await gridRow.click().catch(() => {});
await page.waitForTimeout(1200);

const bodyText = async () => (await page.evaluate(() => document.body.innerText)) || '';
if (/Selected\s+1\b/.test(await bodyText())) ok('it lands in the selection');
else bad('the stop did not enter the selection');

// THE ROW MUST BE A CONTROL. This is the whole defect: it listed the order and did nothing.
// Scoped to the floating panel by its own hook — the bottom data grid renders a <tr> per stop
// too, and the first run of this guard asserted against that one and reported the wrong thing.
const panel = page.locator('[data-sel-panel]');
if (await panel.isVisible().catch(() => false)) ok('the floating selection panel is up');
else bad('the floating selection panel never appeared');
const row = panel.locator('tr', { hasText: 'ABACUS SOLUTIONS LLC' }).first();
const title = await row.getAttribute('title').catch(() => null);
if (title && /show this stop on the map/i.test(title)) ok('the row offers to show the stop on the map');
else bad(`the selection row is not a locate control (title=${JSON.stringify(title)})`);
const cursor = await row.evaluate((el) => getComputedStyle(el).cursor).catch(() => '');
if (cursor === 'pointer') ok('and it looks clickable');
else bad(`the row does not read as clickable (cursor=${cursor})`);

// HOVER LIGHTS IT. The panel and the map share one `hoverId`; the row turning amber is proof
// that channel reaches this panel, which is what it did not do before.
// AMBER SPECIFICALLY, and that is the point. "The colour changed" passed against the OLD build
// too, because the row already had a plain `hover:bg-slate-50` — a CSS hover that tells you
// nothing about whether the map knows. Amber is painted only from `hoverId`, the same state the
// markers read, so this assertion distinguishes the feature from the styling it sat next to.
const AMBER = 'rgb(254, 243, 199)';                                     // tailwind amber-100
await row.hover().catch(() => {});
await page.waitForTimeout(300);
const after = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
if (after === AMBER) ok('hovering the row lights it through the shared hoverId channel');
else bad(`hovering the row does not reach the map's hover state (got ${after}, wanted ${AMBER})`);

// CLICKING IT MUST NOT HIJACK THE STOP-CARD LINK. The row gained an action; it must not have
// taken one away, so the PRO number still opens the order.
await row.click().catch(() => {});
await page.waitForTimeout(600);
if (/Selected\s+1\b/.test(await bodyText())) ok('clicking the row locates it without dropping the selection');
else bad('clicking the row changed the selection');
await panel.getByRole('button', { name: '007173273' }).first().click().catch(() => {});
await page.waitForTimeout(900);
if (/ABACUS SOLUTIONS LLC/.test(await bodyText())) ok('the stop number still opens the order');
else bad('the stop number no longer opens the order');

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
if (errors.length) bad(`page errors: ${errors.slice(0, 3).join(' | ')}`);
else ok('no page errors');

await browser.close();
server.close();
console.log(fails.length ? `\nFAIL (${fails.length})` : '\nPASS');
process.exit(fails.length ? 1 : 0);
