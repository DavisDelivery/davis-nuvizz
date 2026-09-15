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

console.log('\nBoard-status cards — Routing\u2019s bar dropdown must not cover Filters or the flags; the Map\u2019s flag panel must PUSH them down\n');

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

  // ── THE DISPATCH MAP, WHERE THE CARD CAME BACK OFF THE BAR (v1.32.0) ───────────────
  //
  // v1.23.1 had put this card on the app bar — Chad: "move ... this to the right of more on
  // this page" — and its flag list hung down from there, across the middle of the map. He
  // asked for the other half of it a fortnight later: "i want to take the stops and flag card
  // and move to edge of map so when the flags drop down they come down the right side of map
  // and the buttons that are underneath drop down below the flags drop down."
  //
  // THE LAST CLAUSE IS WHAT THIS BLOCK MEASURES, and it is a claim about FLOW rather than
  // about pixels: Filters, Routes and the launchers move because the panel is their flow
  // sibling in the map's right-hand column. A panel mounted anywhere else — back on the bar,
  // or absolutely positioned over that column — can be made to LOOK right at one width and
  // will bury Filters at another, which is the measured-offset bug this repo has paid for
  // four times on the phone map. So the assertion is not "they do not overlap" (two boxes
  // 300px apart also do not overlap); it is that Filters STARTS BELOW where the panel ENDS,
  // and that it MOVED DOWN when the panel opened.
  //
  // Filters is opened FIRST and deliberately: collapsed it is ~75px wide and clears
  // everything, so a guard that checked the resting state would pass the very layout it
  // exists to reject.
  await page.getByText('Map', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1200);

  // OFF THE BAR, and this half is the regression check: a card that turns up inside <header>
  // again cannot push anything on the map, whatever it looks like in a screenshot.
  if (await page.locator('header [data-testid="routing-bar-status"]').count()) {
    bad('Map: the board-status card is back on the app bar — a panel hanging from there cannot move the map controls');
  } else ok('Map: the board-status card is off the app bar');

  const mapCard = page.locator('[data-testid="map-status-card"]').first();
  if (!(await mapCard.count())) {
    bad('Map: the board-status card was not found on the map (data-testid="map-status-card" missing)');
  } else {
    // AT THE MAP'S RIGHT EDGE — "move to edge of map". The column is right-3 inside the map
    // container, so the card's right edge lands a small gutter short of the window's.
    const mapCardBox = await mapCard.boundingBox();
    const gutter = vp.width - (mapCardBox.x + mapCardBox.width);
    console.log(`    Map card     ${fmt(mapCardBox)}`);
    if (gutter > 60) bad(`Map: the status card is not at the map's right edge — ${Math.round(gutter)}px of clear map to its right`);
    else ok(`Map: the status card sits at the map's right edge (${Math.round(gutter)}px gutter)`);

    const mapFilt = page.locator('button[aria-expanded]').filter({ hasText: 'Filters' }).first();
    await mapFilt.click().catch(() => {});
    await page.waitForTimeout(400);
    // The whole Filters CARD, not its header button: the card is what grows to 240px when
    // open, and the card is what a panel laid over this column would land on.
    const filtBefore = await mapFilt.locator('xpath=..').boundingBox().catch(() => null);

    await page.locator('button[aria-label^="Board flags"]').first().click().catch(() => {});
    await page.waitForTimeout(500);
    const panelBox = await page.locator('[data-testid="map-flags-panel"]').first().boundingBox().catch(() => null);
    const filtAfter = await mapFilt.locator('xpath=..').boundingBox().catch(() => null);
    const routesBox = await page.getByRole('button', { name: /^Routes$/ }).first().boundingBox().catch(() => null);
    console.log(`    flags panel  ${fmt(panelBox)}`);
    console.log(`    Filters was  ${fmt(filtBefore)}`);
    console.log(`    Filters now  ${fmt(filtAfter)}`);

    if (!panelBox) bad('Map: the flags panel never opened, so nothing about its position was checked');
    else if (!filtBefore || !filtAfter) bad('Map: the Filters card was not found — the flow check proved nothing');
    else {
      // DOWN THE RIGHT SIDE OF THE MAP, not across the middle of it: the panel's right edge
      // sits on the same gutter as the card that opened it.
      const panelGutter = vp.width - (panelBox.x + panelBox.width);
      if (panelGutter > 60) bad(`Map: the flags panel is not down the right side — ${Math.round(panelGutter)}px of clear map to its right`);
      else ok(`Map: the flags panel comes down the right side of the map (${Math.round(panelGutter)}px gutter)`);

      if (intersects(panelBox, filtAfter)) bad(`Map: the flags panel covers the open Filters card (${fmt(panelBox)} over ${fmt(filtAfter)})`);
      else ok('Map: the flags panel clears the open Filters card');

      // THE FLOW CLAIM. Two boxes that merely miss each other would pass the check above;
      // these two say Filters is BELOW the panel and that it got there by MOVING.
      if (filtAfter.y + 1 < panelBox.y + panelBox.height) bad(`Map: Filters does not sit below the flags panel (Filters top ${Math.round(filtAfter.y)}, panel bottom ${Math.round(panelBox.y + panelBox.height)})`);
      else ok('Map: Filters sits below the flags panel');
      if (filtAfter.y <= filtBefore.y) bad(`Map: opening the flags panel did not push Filters down (y ${Math.round(filtBefore.y)} → ${Math.round(filtAfter.y)}) — the panel is not this column's flow sibling`);
      else ok(`Map: opening the flags panel pushed Filters down (y ${Math.round(filtBefore.y)} → ${Math.round(filtAfter.y)})`);

      // Routes rides the same stack; if it did not move, something below Filters is pinned.
      if (!routesBox) bad('Map: the Routes button was not found — the stack check proved nothing');
      else if (routesBox.y < panelBox.y + panelBox.height) bad(`Map: the Routes button is not below the flags panel (top ${Math.round(routesBox.y)}, panel bottom ${Math.round(panelBox.y + panelBox.height)})`);
      else ok('Map: the Routes button moved down with Filters');

      // AND NOTHING IN THE COLUMN BECOMES UNREACHABLE. This is the half the first cut got
      // wrong and this guard caught: at 1440x900 with Filters open, the panel put Filters at
      // y 599..962 and the launchers at 1057 — every control on this side of the map pushed
      // off the bottom of the screen. "Below the flags" is the ask; "off the screen" is a new
      // bug wearing the new feature's name.
      //
      // The property is REACHABILITY, not a resting position: the column is capped at the
      // map's height and scrolls past it, so the check is that its own box ends on screen and
      // that scrolling it brings the last launcher into view. Asserting a resting y would
      // forbid the scroll that makes the worst case work at all.
      const col = page.locator('[data-testid="map-right-column"]').first();
      const colBox = await col.boundingBox().catch(() => null);
      if (!colBox) bad('Map: the right-hand control column was not found — the reachability check proved nothing');
      else if (colBox.y + colBox.height > vp.height + 1) bad(`Map: the control column runs off the bottom of the screen (bottom ${Math.round(colBox.y + colBox.height)} > ${vp.height})`);
      else ok(`Map: the control column stays within the map (bottom ${Math.round(colBox.y + colBox.height)})`);

      const launcher = page.locator('button[aria-label="Open messages"], button[aria-label="Ask AI about the board"]').last();
      if (!(await launcher.count())) console.log('  \x1b[33m•\x1b[0m the launchers are not mounted in this fixture — the reachability check was skipped');
      else {
        await col.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
        await page.waitForTimeout(250);
        const lastBox = await launcher.boundingBox().catch(() => null);
        if (!lastBox) bad('Map: the bottom launcher has no box after scrolling the column — it is unreachable');
        else if (lastBox.y + lastBox.height > vp.height + 1) bad(`Map: the bottom launcher cannot be scrolled into view (bottom ${Math.round(lastBox.y + lastBox.height)} > ${vp.height})`);
        else ok(`Map: every control in the column is reachable with the panel open (last launcher bottom ${Math.round(lastBox.y + lastBox.height)})`);
        await col.evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
      }
    }

    // ── THE COLLISION WITH AN ORDER OPEN IS *NOT* CHECKED HERE, DELIBERATELY ───────
    //
    // v1.24.1 shipped a real one: the board-status detail was open by DEFAULT, hanging off
    // the bar over the map, and opening a stop card narrows the map and slides the whole
    // right-hand control column left — at 1440, Filters goes from x 1324..1427 to x 944..1047,
    // straight under a dropdown at x 784..1024. Clicking Filters then did nothing at all,
    // because the click landed on the dropdown. The card is back IN that column as of
    // v1.32.0, so it slides with Filters instead of over it and this particular collision
    // cannot recur; the note stays because the reasoning is what keeps it from being rebuilt.
    //
    // I TRIED TO PIN IT HERE AND COULD NOT, and the failed attempt is worth more written down
    // than deleted. This script's fixture opens the right panel via the Routes roster, which
    // is narrower than a stop card: Filters lands at x 1004..1107, its centre clear of the
    // dropdown, so the click succeeds and the check passes WITH THE BUG REINSTATED. A guard
    // that cannot fail on its own bug is not evidence — it is a green tick that teaches
    // people the case is covered when it is not, which is worse than no check at all.
    //
    // IT IS ALREADY COVERED, by the guard that actually caught this: verify-hide-place-labels
    // opens a real stop card and clicks Filters, and it went red on exactly this collision
    // ("subtree intercepts pointer events"). That is the right home for it — it is the script
    // that already knows how to get a stop card open.
  }

  await ctx.close();
}

await browser.close();
srv.close();
clearTimeout(watchdog);
if (fails.length) {
  console.error(`\n\x1b[31m✗ ${fails.length} problem${fails.length === 1 ? '' : 's'} with the routing top bar\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ Routing\u2019s bar card clears Filters and the flags chip, and the Map\u2019s flag panel pushes its column down, at both desktop sizes\x1b[0m');
