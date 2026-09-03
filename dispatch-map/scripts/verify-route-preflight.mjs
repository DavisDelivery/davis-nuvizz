#!/usr/bin/env node
// scripts/verify-route-preflight.mjs — DOES THE ROUTE FLAG ACTUALLY POP WHILE YOU BUILD?
//
// Chad: "can we have flags pop in the routing page if we build a route that system
// immediately thinks won't make it on time."
//
// test/route-preflight.test.mjs proves the JUDGEMENT is right. It cannot prove the badge is
// on the screen, that opening a load in Compare shows it, or that it survives a phone's
// 390px card. A preflight nobody can see is the same as no preflight, and this app has
// shipped a screen to one navigation and not the other twice. So this drives the real bundle.
//
//   node scripts/verify-route-preflight.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8807)
//     MOBILE=1       the phone layout instead of the desktop one
//     SHOT=path.png  also write a screenshot
//
// WHAT THIS GUARD CAN AND CANNOT SET UP, stated plainly. Receiving hours live in Firestore
// (useCustomerNotes subscribes to customer_notes); with no Firebase config the browser gets
// an EMPTY notes map, and page.route cannot stub a Firestore subscription. So the stops here
// carry no recorded hours and are judged against the house 5:00p close — the 'assumed' tier,
// which is the quietest verdict the engine can give and therefore the hardest one to render.
// If the badge shows up for an assumed close it shows up for a typed one.
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
  await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
  await page.waitForTimeout(900);
}
const routingTab = page.getByText('Routing (beta)', { exact: true }).first();
if (await routingTab.isVisible().catch(() => false)) ok('Routing is reachable from the navigation');
else bad('Routing is not reachable from the navigation');
await routingTab.click().catch(() => {});
await page.waitForTimeout(1600);

// Open the load into the Compare workbench — the Loads list, then the load, which is exactly
// how a router pulls a route up to work on it. On a phone that list lives in the bottom sheet.
if (MOBILE) {
  // The board status card is pinned over the Loads tab at 390px and swallows the tap. A
  // router collapses it the same way — it is a toggle — and this is not the guard's subject,
  // so it collapses it rather than forcing a click through another control.
  await page.getByRole('button', { name: /stops$/i }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}
const loadsTab = page.getByRole('button', { name: /^Loads/ }).first();
if (await loadsTab.isVisible().catch(() => false)) { await loadsTab.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(1000); }
const loadRow = page.getByText(/PREFLIGHT 1/).first();
if (await loadRow.isVisible().catch(() => false)) ok('the load is listed on the routing screen');
else bad('the load never appeared on the routing screen');
await loadRow.click().catch(() => {});
await page.waitForTimeout(1600);
// The Compare card is open once the card's own furniture is on the screen.
const compareOpen = await page.getByText(/Expand all stops|Cancel route/i).first().isVisible().catch(() => false);
compareOpen ? ok('the load opened in the Compare workbench') : bad('the load did not open in Compare');

// THE BANNER. Its exact words are the contract with the router — a count of stops, not a
// vague "check this route", because a count is the thing he can act on.
const bodyText = async () => (await page.evaluate(() => document.body.innerText)) || '';
let text = await bodyText();
const wantBanner = /stops? projected past (its|their) close/i;
if (wantBanner.test(text)) ok('the route says how many stops are projected past their close');
else bad(`no preflight banner on the card (looked for ${wantBanner})`);

// THE BASIS. "Late" measured from a departure nobody has observed is a different claim from
// one measured off this truck's habit, and the banner must say which every time.
if (/from an assumed 8:00a departure/i.test(text)) ok('it names the departure it judged from, and that it was assumed');
else bad('the banner does not say which departure it judged from');

// THE PER-STOP VERDICT. A route-level count with no per-stop mark tells a router something is
// wrong and not which row to drag.
if (/\d+h \d+m late|\d+m late|can’t make|can't make/i.test(text)) ok('at least one stop carries its own late badge');
else bad('no per-stop badge rendered');

// AND IT MUST NOT CRY WOLF ON THE WHOLE ROUTE. The near stop makes a 5:00p close comfortably;
// if every row is flagged the badge is decoration and a router stops reading it.
const flaggedRows = await page.evaluate(() => {
  const re = /(late|can’t make|can't make)/i;
  return [...document.querySelectorAll('li')].filter((li) => re.test(li.innerText || '')).length;
});
if (flaggedRows > 0 && flaggedRows < 5) ok(`${flaggedRows} of 5 stops flagged — not the whole route`);
else bad(`${flaggedRows} of 5 stops flagged — the badge is either silent or crying wolf`);

if (process.env.SHOT) { await page.screenshot({ path: process.env.SHOT, fullPage: !MOBILE }); ok(`screenshot ${process.env.SHOT}`); }

if (errors.length) bad(`page errors: ${errors.slice(0, 3).join(' | ')}`);
else ok('no page errors');

await browser.close();
server.close();
console.log(fails.length ? `\n✗ ${fails.length} check(s) failed` : `\n✓ route preflight verified in a real browser (${MOBILE ? 'phone' : 'desktop'})`);
process.exit(fails.length ? 1 : 0);
