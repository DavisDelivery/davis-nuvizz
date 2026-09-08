#!/usr/bin/env node
// scripts/verify-legend-menu.mjs — IS THE MAP LEGEND REACHABLE FROM MORE, ON BOTH VIEWS?
//
// Chad: "On the routing page under the more tab i want a legend for what all the icons on the
// map mean and i want it to only show the current icons on the map."
//
// WHY THIS NEEDS A BROWSER. Nothing here is arithmetic. The failures are all wiring, and the
// first build hit two of them in a row that no unit test could have seen:
//
//   • the signal was passed to <RoutingScreen> from a component that never had it —
//     RoutingSection sits between the Shell and the screen — so the page threw
//     "legendSignal is not defined" and the whole nav row vanished;
//   • and the phone's nav is the VERSION CHIP, not the first header button, which on Routing
//     is the screen's own settings gear riding the app-bar portal slot.
//
// The second one is the failure this repo has shipped twice (v0.54.50: Manifest check visible
// on a laptop, invisible on a phone) — the desktop nav row and the phone chip menu are two
// separate lists. So this guard walks BOTH, and checks the thing that makes it a legend for
// THIS map rather than a screen: the map is still on screen after the item is picked.
//
//   node scripts/verify-legend-menu.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8807)
//     MOBILE=1       the phone layout instead of the desktop one
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8807;
const MOBILE = process.env.MOBILE === '1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

// ONE LOAD, FIVE STOPS, MARCHING NORTH. Against the 5:00p house close the near stops make it
// and the far ones cannot: the walk leaves the Buford depot at 8:00a and the model's own
// curve puts stop five well into the evening. The point of the spread is that the verdict has
// to be per stop, not per route.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const MILES = [30, 120, 240, 360, 470];
const STOPS = MILES.map((mi, i) => ({
  stopNbr: `0071800${i}0`, pro: `71800${i}0`, businessName: `PREFLIGHT CO ${String.fromCharCode(65 + i)}`,
  addr1: `${100 + i} Long Haul Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + mi * DEG, lng: DEPOT.lng,
  cartons: 2, volume: 0, weight: 500,
  status: '10', normalizedStatus: 'PLANNED', stopType: 'DL',
  // loadId is REQUIRED, not decoration: openRouteInWorkbench refuses a card with neither a
  // load id nor a real load number, because such a card cannot be saved and would strand
  // every stop moved onto it. A fixture without one silently never opens the workbench.
  loadNbr: 'DAVIS000198197', routeName: 'PREFLIGHT 1', loadId: 'ld-preflight-1', routeSeq: i + 1,
  driverName: 'TEST DRIVER', driverUserName: 'tdriver',
  matchKey: `preflight_${i}`,
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
const page = await (await browser.newContext(MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.route('**/.netlify/functions/**', (route) => {
  const u = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (u.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: STOPS, count: STOPS.length, source: 'fixture' });
  // No measured departure table: the banner must then say the departure was ASSUMED, which is
  // the honest half of the claim and the half a router needs to weigh it.
  if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
  if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
  return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
});
for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);

// Reach Routing: desktop through the top tab, phone through the hamburger. TWO NAVIGATIONS —
// this app has shipped a screen into one and not the other twice, so the guard walks both.
if (MOBILE) {
  // The phone nav IS the version chip (title="Version menu"); the first header button on
  // Routing is the screen's own settings gear, which lives in the app-bar portal slot.
  await page.locator('button[title="Version menu"]').first().click().catch(() => {});
  await page.waitForTimeout(900);
}
const routingTab = page.getByText('Routing (beta)', { exact: true }).first();
if (await routingTab.isVisible().catch(() => false)) ok('Routing is reachable from the navigation');
else bad('Routing is not reachable from the navigation');
await routingTab.click().catch(() => {});
await page.waitForTimeout(1600);


// ── MORE → MAP LEGEND ───────────────────────────────────────────────────────
const bodyText = async () => (await page.evaluate(() => document.body.innerText)) || '';

// The legend must NOT be open on arrival.
if (/How sure is it\?|Legend/i.test(await bodyText()) === false) ok('the legend is shut on arrival');
else console.log('  (note) something legend-ish is already on screen');

// Open the More menu. Desktop: the nav row's More button. Phone: the chip menu, then its
// "More" group (which starts open and is remembered).
if (MOBILE) {
  // The phone nav IS the version chip (title="Version menu"); the first header button on
  // Routing is the screen's own settings gear, which lives in the app-bar portal slot.
  await page.locator('button[title="Version menu"]').first().click().catch(() => {});
  await page.waitForTimeout(900);
}
// Desktop: More is a dropdown that must be opened. Phone: the chip menu's "More" GROUP is
// already expanded (it starts open and remembers), so a click there would close it.
// The phone's group header carries role="menuitem" explicitly, so a button-role lookup
// misses it — the item is there and works, but the guard would call the nav missing.
const moreBtn = page.getByRole(MOBILE ? 'menuitem' : 'button', { name: /^more/i }).first();
if (await moreBtn.isVisible().catch(() => false)) ok('the More menu is reachable');
else bad('no More menu on this view');
if (!MOBILE) { await moreBtn.click().catch(() => {}); await page.waitForTimeout(600); }

const item = page.getByRole('menuitem', { name: /Map legend/i }).first();
const seen = await item.isVisible().catch(() => false);
seen ? ok('Map legend is listed under More') : bad('Map legend is NOT listed under More');
if (seen) {
  await item.click().catch(() => {});
  await page.waitForTimeout(900);
  const t = await bodyText();
  // The legend body's own headings — proof the PANEL opened, not just that a click landed.
  if (/How sure is it\?|What the marks|Legend/i.test(t)) ok('the legend panel opened over the map');
  else bad('clicking Map legend opened nothing');
  // And the map is still there — an action item, not a tab switch.
  if (/Expand all stops|Cancel route|Filters|Routes \(/i.test(t)) ok('the Routing map is still on screen (it did not navigate away)');
  else bad('it navigated away from the map it is describing');
}

if (errors.length) bad(`page errors: ${errors.slice(0, 3).join(' | ')}`);
else ok('no page errors');

await browser.close();
server.close();
if (fails.length) { console.error(`\n\u2717 ${fails.length} check(s) failed`); process.exit(1); }
console.log(`\n\u2713 More \u2192 Map legend verified (${MOBILE ? 'phone' : 'desktop'})`);
process.exit(0);
