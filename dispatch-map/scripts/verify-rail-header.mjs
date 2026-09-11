#!/usr/bin/env node
// scripts/verify-rail-header.mjs — CAN YOU STILL COLLAPSE THE RIGHT RAIL AFTER SQUEEZING IT?
//
// Chad, with the Routing rail dragged to its narrowest: "When i squeeze the right panel down
// to the minimum i lose my collapse button, the other 2 buttons don't shrink like they should."
//
// THE TRAP, IN DISPATCH TERMS. A router squeezes this rail because he wants map — on a
// 700-stop board the map is the work surface and the rail is reference. The control that
// UNDOES the squeeze is the one the squeeze destroyed: at minimum width the chevron was
// pushed out past the panel edge, so the only way to get the rail out of the way was to drag
// it wide again first. The collapsed rail (a 28px strip) became unreachable from the one
// width a dispatcher is most likely to be at when he wants it.
//
// WHY THIS IS MEASURED AND NOT REASONED. The overflow is font metrics against a pixel budget:
// "Routes (15)" + "Loads (87)" + "＋ New route" + gaps against 280px minus padding. Every
// term there is a real text measurement in a real browser, and CLAUDE.md is explicit about
// what happens when this repo argues about geometry instead of measuring it — the phone map's
// overlays were collision-patched four times and still shipped broken.
//
// WRITTEN AGAINST THE BROKEN BUILD FIRST: on the pre-fix bundle this fails at 280px and 300px
// with the chevron overflowing the panel's right edge, and passes at the 380px default. A
// layout guard that has never seen the bug it claims to catch is not evidence of anything.
//
//   node scripts/verify-rail-header.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8814)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8814;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { fails.push(m); console.error(`  \x1b[31m✗\x1b[0m ${m}`); };

const GUARD_MS = Number(process.env.RAIL_TIMEOUT_MS) || 5 * 60 * 1000;
const watchdog = setTimeout(() => {
  console.error(`\n\x1b[31m✗ verify-rail-header exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build\x1b[0m`);
  process.exit(1);
}, GUARD_MS);

// The counts are what make the tabs wide, so the fixture carries enough routes and loads to
// render two-digit tallies — "Routes (15)" and "Loads (87)" are Chad's own screenshot. An
// empty board draws "Routes"/"Loads" bare, fits everything, and proves nothing.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const STOPS = Array.from({ length: 90 }, (_, i) => ({
  stopNbr: `RH${1000 + i}`, pro: `RH${1000 + i}`, businessName: `RAIL FIXTURE ${i + 1}`,
  addr1: `${100 + i} Fixture Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + (i % 12) * DEG, lng: DEPOT.lng + Math.floor(i / 12) * DEG,
  cartons: 3, volume: 0, weight: 500,
  status: i % 6 === 0 ? '10' : '20',
  normalizedStatus: i % 6 === 0 ? 'UNPLANNED' : 'PLANNED',
  isUnplanned: i % 6 === 0, isPlanned: i % 6 !== 0,
  stopType: 'DL', matchKey: `rail_${i}`,
  ...(i % 6 === 0 ? {} : { loadNbr: `RH${i % 15}`, routeName: `RH${i % 15}`, routeSeq: i, driverName: 'TEST DRIVER', driverUserName: 'tdriver' }),
}));
const at = new Date('2026-09-11T11:00:00Z').toISOString();
const PULL = {
  ok: true, stops: STOPS, count: STOPS.length, source: 'fixture',
  lastScannedAt: at, lastLoadScanAt: at, lastUnplannedScanAt: at, lastCompletedScanAt: at,
  scanUnplannedCount: STOPS.filter((s) => s.isUnplanned).length,
};
// 87 empty loads, so the Loads tab reads "Loads (87)" exactly as in the report.
const ROSTER = {
  ok: true, count: 87, capturedAt: at,
  loads: Array.from({ length: 87 }, (_, i) => ({ loadNbr: `EMPTY${i}`, name: `EMPTY ${i}`, key: `EMPTY${i}`, stops: 0, dispatched: false })),
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

const fmt = (b) => (b ? `x ${Math.round(b.x)}..${Math.round(b.x + b.width)} (w ${Math.round(b.width)})` : 'absent');

console.log('\nRouting right rail — the collapse button survives the squeeze\n');

// 280 is the hook's floor (useSidePanelWidth min); 300 is one drag-notch off it; 380 is the
// default a dispatcher opens the screen to and must be unchanged by any shrink rule.
const WIDTHS = [280, 300, 340, 380];

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
await page.route('**/.netlify/functions/**', (route) => {
  const u = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (u.includes('nuvizz-pull-today-stops')) return json(PULL);
  if (u.includes('nuvizz-loads-roster')) return json(ROSTER);
  if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
  if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
  return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
});
for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());

for (const w of WIDTHS) {
  console.log(`\x1b[1mrail at ${w}px${w === 280 ? ' (the minimum)' : w === 380 ? ' (the default)' : ''}\x1b[0m`);
  // Routes/Loads mode + live write is the configuration in the report: it is the only one
  // that draws all three controls, so it is the only one that can overflow.
  await page.addInitScript((width) => {
    try {
      localStorage.setItem('routing.rightW', String(width));
      localStorage.setItem('routing.rightPanel', 'routesLoads');
      localStorage.setItem('routing.liveWrite', 'on');
      localStorage.setItem('routing.rightCollapsed', 'false');
    } catch { /* ignore */ }
  }, w);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1800);

  const nrProbe = page.locator('[data-testid="rail-new-route"]').first();
  const header = page.locator('[data-testid="rail-routes-header"]').first();
  if (!(await header.count())) { bad(`${w}px: the rail header was not found (data-testid="rail-routes-header")`); continue; }
  const collapse = header.locator('button[title="Collapse panel"]').first();
  if (!(await collapse.count())) { bad(`${w}px: there is no collapse button in the rail header at all`); continue; }

  const hBox = await header.boundingBox();
  const cBox = await collapse.boundingBox();
  console.log(`    header   ${fmt(hBox)}`);
  console.log(`    collapse ${fmt(cBox)}`);

  // THE CLAIM: the chevron is inside the panel, not pushed past its right edge. 0.5px of
  // slack for sub-pixel layout; anything more is a control a dispatcher cannot reach.
  if (!cBox || !hBox) { bad(`${w}px: could not measure the collapse button`); continue; }
  const overflow = (cBox.x + cBox.width) - (hBox.x + hBox.width);
  if (overflow > 0.5) bad(`${w}px: the collapse button overflows the rail by ${Math.round(overflow)}px — it is off the edge of the panel`);
  else ok(`${w}px: the collapse button sits inside the rail`);

  // AND IT IS ACTUALLY CLICKABLE THERE. A box inside the panel that another control is
  // painted over is the same lost button with better coordinates.
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return !!el && !!el.closest('button[title="Collapse panel"]');
  }, { x: cBox.x + cBox.width / 2, y: cBox.y + cBox.height / 2 });
  if (hit) ok(`${w}px: a click at its centre reaches the collapse button`);
  else bad(`${w}px: something else is on top of the collapse button — a click there does not reach it`);

  // The tabs are the mode switch a dispatcher uses all day; shrinking must not push THEM out
  // either, and must not shrink them to nothing.
  const tabs = header.locator('button[aria-pressed]');
  const nTabs = await tabs.count();
  if (nTabs < 2) { bad(`${w}px: expected the Routes/Loads tabs in the header, found ${nTabs}`); continue; }
  let tabsOk = true;
  for (let i = 0; i < nTabs; i++) {
    const b = await tabs.nth(i).boundingBox();
    const label = (await tabs.nth(i).textContent() || '').trim();
    if (!b || b.width < 24) { bad(`${w}px: tab "${label}" collapsed to ${b ? Math.round(b.width) : 0}px — too small to hit`); tabsOk = false; }
    else if ((b.x + b.width) - (hBox.x + hBox.width) > 0.5) { bad(`${w}px: tab "${label}" overflows the rail`); tabsOk = false; }
  }
  if (tabsOk) ok(`${w}px: both tabs stay inside the rail and stay hittable`);

  // AND ＋ New route IS NOT MERELY CLIPPED. The group that shrinks carries overflow-hidden,
  // which is what stops it shoving the chevron — but a half-cut button hanging off the edge
  // of that group is the same lost control with tidier neighbours. It must be WHOLE.
  if (await nrProbe.count()) {
    const nb = await nrProbe.boundingBox();
    const grp = await nrProbe.evaluate((el) => {
      const g = el.parentElement; const r = g.getBoundingClientRect();
      return { x: r.x, width: r.width, scrollW: g.scrollWidth, clientW: g.clientWidth };
    });
    const cut = (nb.x + nb.width) - (grp.x + grp.width);
    if (cut > 0.5) bad(`${w}px: ＋ New route is cut off by ${Math.round(cut)}px at the edge of the shrink group`);
    else if (grp.scrollW - grp.clientW > 1) bad(`${w}px: the header's shrink group is overflowing by ${Math.round(grp.scrollW - grp.clientW)}px — something in it is hidden`);
    else ok(`${w}px: ＋ New route is drawn whole (${Math.round(nb.width)}px) with nothing hidden`);
  }

  // Nothing in the header may sit on top of anything else in it.
  const boxes = [];
  for (let i = 0; i < nTabs; i++) boxes.push({ label: (await tabs.nth(i).textContent() || '').trim() || `tab ${i}`, b: await tabs.nth(i).boundingBox() });
  const nr = header.locator('[data-testid="rail-new-route"]').first();
  if (await nr.count()) boxes.push({ label: 'New route', b: await nr.boundingBox() });
  boxes.push({ label: 'collapse', b: cBox });
  let clash = null;
  for (let i = 0; i < boxes.length && !clash; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].b, b = boxes[j].b;
      if (a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) { clash = `${boxes[i].label} over ${boxes[j].label}`; break; }
    }
  }
  if (clash) bad(`${w}px: two header controls occupy the same pixels — ${clash}`);
  else ok(`${w}px: no two header controls overlap`);

  // At the DEFAULT width nothing may have been taken away to buy the narrow case.
  if (w === 380) {
    const nrText = (await nr.count()) ? ((await nr.textContent()) || '').trim() : '';
    if (/new route/i.test(nrText)) ok('380px: ＋ New route still carries its full label at the default width');
    else bad(`380px: the New route button lost its label at the default width (reads "${nrText}") — the shrink rule is firing too early`);
    const labels = boxes.filter((x) => x.label !== 'collapse' && x.label !== 'New route').map((x) => x.label).join(' / ');
    if (/\(\d+\)/.test(labels)) ok(`380px: the tabs still show their counts — ${labels}`);
    else bad(`380px: the tab counts are gone at the default width — ${labels}`);
  }
}

await ctx.close();
await browser.close();
srv.close();
clearTimeout(watchdog);
if (fails.length) {
  console.error(`\n\x1b[31m✗ ${fails.length} problem${fails.length === 1 ? '' : 's'} with the rail header\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ the collapse button survives every rail width, and the default loses nothing\x1b[0m');
