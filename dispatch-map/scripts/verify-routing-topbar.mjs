#!/usr/bin/env node
// scripts/verify-routing-topbar.mjs — DOES THE BOARD-STATUS DROPDOWN COVER FILTERS OR THE FLAGS?
//
// Chad, on the "0 of 805 stops" pill floating over the routing map: "I want to move this to
// just above filters on the bar with more, but just far enough left on that bar to where when
// it drops down it doesn't cover up filters or flags. Slide the flags down just enough to
// where it doesn't get covered by the drop down either."
//
// The card now lives on the app bar, left of More, and its detail drops down-and-left. The
// whole request is a GEOMETRY claim, and geometry is the one thing this repo has repeatedly
// got wrong by reasoning about it: the phone map's top overlays were collision-patched FOUR
// separate times (v0.54.80, v0.54.82, the wrap fix, the flags-chip clip) and still shipped
// the draw buttons on top of the status card. So this measures real boxes in the real bundle.
//
// IT WAS WRITTEN AGAINST THE BROKEN DRAFT FIRST. The first cut of this change right-ALIGNED
// the panel to the card (right-0), which at 1440px ends at x 979 and clips the left 8px of a
// Filters button starting at 971 — invisible in a screenshot at a glance, and exactly what
// Chad asked to avoid. This guard fails that draft and passes the shipped one; a layout guard
// that has never seen the bug it claims to catch is not evidence of anything.
//
// WHAT IT DOES NOT COVER, said plainly: the right rail is dispatcher-resizable, and dragging
// it far wider walks the map's Filters button leftward toward the panel. This checks the
// default rail at two desktop sizes, which is what a dispatcher opens the screen to.
//
//   node scripts/verify-routing-topbar.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8810)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8810;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { fails.push(m); console.error(`  \x1b[31m✗\x1b[0m ${m}`); };

const GUARD_MS = Number(process.env.TOPBAR_TIMEOUT_MS) || 5 * 60 * 1000;
const watchdog = setTimeout(() => {
  console.error(`\n\x1b[31m✗ verify-routing-topbar exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build\x1b[0m`);
  process.exit(1);
}, GUARD_MS);

// A BOARD BIG ENOUGH TO BE HONEST. An empty board draws a short dropdown, and a short
// dropdown clears everything by accident — so the fixture carries a real stop count, a feed
// timestamp per saved search and a call meter, which is what makes the panel its full height.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const STOPS = Array.from({ length: 60 }, (_, i) => ({
  stopNbr: `TB${1000 + i}`, pro: `TB${1000 + i}`, businessName: `TOPBAR FIXTURE ${i + 1}`,
  addr1: `${100 + i} Fixture Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + (i % 12) * DEG, lng: DEPOT.lng + Math.floor(i / 12) * DEG,
  cartons: 3, volume: 0, weight: 500,
  status: i % 3 === 0 ? '10' : '20',
  normalizedStatus: i % 3 === 0 ? 'UNPLANNED' : 'PLANNED',
  isUnplanned: i % 3 === 0, isPlanned: i % 3 !== 0,
  stopType: 'DL', matchKey: `topbar_${i}`,
  ...(i % 3 === 0 ? {} : { loadNbr: `TB${i % 4}`, routeName: `TB${i % 4}`, routeSeq: i, driverName: 'TEST DRIVER', driverUserName: 'tdriver' }),
}));
const at = new Date('2026-09-10T11:00:00Z').toISOString();
const PULL = {
  ok: true, stops: STOPS, count: STOPS.length, source: 'fixture',
  lastScannedAt: at, lastLoadScanAt: at, lastUnplannedScanAt: at, lastCompletedScanAt: at,
  scanUnplannedCount: STOPS.filter((s) => s.isUnplanned).length,
  ops: { dayCount: 412, ceiling: 2000, mode: 'normal', breaker: false, byRoute: { list: 380, stop: 32 }, byHour: { 6: 40, 7: 120, 8: 90, 9: 60, 10: 102 } },
};

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try {
      const b = await readFile(c);
      res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
      return res.end(b);
    } catch { /* fall through to the SPA shell */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });

const intersects = (a, b) => !!a && !!b
  && a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;
const fmt = (b) => (b ? `x ${Math.round(b.x)}..${Math.round(b.x + b.width)}, y ${Math.round(b.y)}..${Math.round(b.y + b.height)}` : 'absent');

console.log('\nRouting top bar — the board-status dropdown must not cover Filters or the flags\n');

for (const vp of [{ name: 'laptop', width: 1440, height: 900 }, { name: 'desktop', width: 1920, height: 1080 }]) {
  console.log(`\x1b[1m${vp.name} (${vp.width}x${vp.height})\x1b[0m`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  // The collapse is a persisted per-device choice, and a guard that inherits it would check
  // the closed card half the time and report "clear" because nothing was drawn.
  await page.addInitScript(() => { try { localStorage.setItem('dispatchMap.statusPillCollapsed', 'false'); } catch { /* ignore */ } });
  await page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('nuvizz-pull-today-stops')) return json(PULL);
    if (u.includes('nuvizz-loads-roster')) return json({ ok: true, count: 0, loads: [] });
    if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
    if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
    return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
  });
  for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1800);

  const card = page.locator('[data-testid="routing-bar-status"]').first();
  if (!(await card.count())) {
    bad('the board-status card is not on the app bar (data-testid="routing-bar-status" missing)');
    await ctx.close();
    continue;
  }
  // ON THE BAR, not merely rendered. The point of the change is that this control left the
  // map, so a card that ended up back inside the map container is the regression itself.
  const inHeader = await card.evaluate((el) => !!el.closest('header'));
  if (inHeader) ok('the board-status card sits on the app bar'); else bad('the board-status card is NOT inside <header> — it did not move off the map');

  let drop = page.locator('[data-testid="routing-bar-status-drop"]').first();
  if (!(await drop.count())) {
    await card.getByRole('button', { name: /stops/i }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    drop = page.locator('[data-testid="routing-bar-status-drop"]').first();
  }
  if (!(await drop.count())) { bad('the dropdown never opened, so nothing about its position was checked'); await ctx.close(); continue; }

  const dropBox = await drop.boundingBox();
  const filtBox = await page.locator('button[title="Map filters"]').first().boundingBox().catch(() => null);
  const flagBox = await page.locator('button[aria-label^="Board flags"]').first().boundingBox().catch(() => null);
  console.log(`    dropdown ${fmt(dropBox)}`);
  console.log(`    Filters  ${fmt(filtBox)}`);
  console.log(`    flags    ${fmt(flagBox)}`);

  if (!filtBox) bad('the Filters button was not found — the overlap check proved nothing');
  else if (intersects(dropBox, filtBox)) bad(`the dropdown covers the Filters button (${fmt(dropBox)} over ${fmt(filtBox)})`);
  else ok('the dropdown clears the Filters button');

  if (!flagBox) bad('the board-flags chip was not found — the overlap check proved nothing');
  else if (intersects(dropBox, flagBox)) bad(`the dropdown covers the board-flags chip (${fmt(dropBox)} over ${fmt(flagBox)})`);
  else ok('the dropdown clears the board-flags chip');

  // The flags slid down, and this is the half of that request a horizontal check cannot see.
  if (flagBox && dropBox && flagBox.y < dropBox.y + dropBox.height) {
    console.log(`  \x1b[33m•\x1b[0m the flags chip still sits within the dropdown's vertical band — clearance here is horizontal only`);
  } else if (flagBox) ok('the flags chip sits below the dropdown as well as clear of it');

  await ctx.close();
}

await browser.close();
srv.close();
clearTimeout(watchdog);
if (fails.length) {
  console.error(`\n\x1b[31m✗ ${fails.length} problem${fails.length === 1 ? '' : 's'} with the routing top bar\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ the board-status dropdown clears Filters and the flags chip at both desktop sizes\x1b[0m');
