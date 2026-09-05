#!/usr/bin/env node
// scripts/verify-loads-tab.mjs — DOES THE LOADS TAB ACTUALLY SHOW THE EMPTY LOADS?
//
// Chad, on the Routing rail reading Routes (3) beside Loads (3) with the same three loads
// under both: "Where are all my empty loads. Routes are loads that have stops on them and
// loads should just be all the empty loads."
//
// test/day-loads.test.mjs proves splitDayLoads sorts a row into the right bucket. It cannot
// prove the RAIL is fed the right bucket, that the two tabs stopped repeating each other on a
// real board, or that the phone got the same change as the desktop — and this app has shipped
// a screen into one navigation and not the other twice. A tab that shows the wrong list is
// exactly what Chad reported, and it was a wiring fact, not a logic one. So this drives the
// real bundle against a fixture board with all four kinds of load on it.
//
//   node scripts/verify-loads-tab.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8809)
//     SHOT=path.png  also write a screenshot of the desktop rail
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8809;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { fails.push(m); console.error(`  \x1b[31m✗\x1b[0m ${m}`); };

// A FIXTURE BOARD WITH ALL FOUR KINDS OF LOAD ON IT, which is the only way to tell the buckets
// apart: two loads built on the board, three empty trailers, and one the roster says carries
// twelve orders whose stops have not arrived. That last one is the reason the split is by
// onBoard — it belongs to neither tab under the obvious rule, and vanishing is the failure.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const stopsFor = (routeName, loadId, loadNbr, n, base) => Array.from({ length: n }, (_, i) => ({
  stopNbr: `${base}${i}`, pro: `${base}${i}`, businessName: `${routeName} CO ${i + 1}`,
  addr1: `${100 + i} Fixture Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + (10 + i) * DEG, lng: DEPOT.lng,
  cartons: 2, volume: 0, weight: 500,
  status: '10', normalizedStatus: 'PLANNED', stopType: 'DL',
  loadNbr, routeName, loadId, routeSeq: i + 1,
  driverName: 'TEST DRIVER', driverUserName: 'tdriver',
  matchKey: `${loadId}_${i}`,
}));
const STOPS = [
  ...stopsFor('CHAD', 'ld-one', 'DAVIS000200601', 3, '9010'),
  ...stopsFor('ESTES', 'ld-two', 'DAVIS000200602', 2, '9020'),
];
const BUILT = [
  { loadId: 'ld-one', name: 'CHAD', loadNbr: 'DAVIS000200601', status: 'Dispatched', trips: 3 },
  { loadId: 'ld-two', name: 'ESTES', loadNbr: 'DAVIS000200602', status: 'Planned', trips: 2 },
];
const EMPTIES = ['1 SATL', '1 WATL', 'ALPHA'].map((name, i) => ({
  loadId: `ld-empty-${i}`, name, loadNbr: `DAVIS00020070${i}`, status: 'Draft', trips: 0,
}));
const OFF_BOARD = { loadId: 'ld-t9', name: 'TRAILER 9', loadNbr: 'DAVIS000200609', status: 'Planned', trips: 12 };

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

/** Open Routing with the rail on Routes/Loads, Loads selected, and this roster in the vendor. */
async function openLoadsTab({ mobile, roster }) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The rail mode and sub-tab are persisted choices, and Chad's are Routes/Loads + Loads.
  await page.addInitScript(() => {
    try { localStorage.setItem('routing.rightPanel', 'routesLoads'); localStorage.setItem('routing.routesLoadsTab', 'loads'); } catch { /* ignore */ }
  });
  await page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('nuvizz-loads-roster')) return json({ ok: true, loads: roster });
    if (u.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: STOPS, count: STOPS.length, source: 'fixture' });
    if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
    if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
    return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
  });
  for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  if (mobile) {
    await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1800);
  return { page, ctx, errors };
}

// The panel's own text, isolated from the rest of the screen: the bottom grid ALSO lists loads
// (deliberately — Chad keeps that view in full), so asserting on document.innerText would let
// a grid row stand in for a rail row and pass a broken tab.
async function panelText(page) {
  return page.evaluate(() => {
    // The panel names itself (data-day-loads-panel). The placeholder fallback below is
    // deliberately LOOSE — it matches the pre-fix wording too — so that running this guard
    // against an older build fails on WHAT THE TAB SHOWS rather than on "the panel was not
    // found", which is the same red for a different reason and proves nothing about the bug.
    const named = document.querySelector('[data-day-loads-panel]');
    if (named) return named.innerText || '';
    const anchor = Array.from(document.querySelectorAll('input'))
      .find((i) => /^Search .*loads/i.test(i.getAttribute('placeholder') || ''));
    if (!anchor) return null;
    let el = anchor;
    for (let i = 0; i < 6 && el.parentElement; i += 1) el = el.parentElement;
    return el.innerText || '';
  });
}

async function run(label, { mobile, roster }, check) {
  console.log(`\n${label}`);
  const { page, ctx, errors } = await openLoadsTab({ mobile, roster });
  // ON A PHONE THE RAIL IS TWO TAPS, NOT ONE, and they are not the taps the desktop takes —
  // which is the whole reason this guard walks both views. The bottom sheet's middle tab is
  // labelled with the MODE ("Routes (1)"), not with the sub-tab; the Routes/Loads toggle only
  // exists once that sheet panel is open, and the persisted sub-tab decides which half shows.
  if (mobile) {
    await page.getByRole('button', { name: /^Routes/ }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    // Belt and braces: if the persisted sub-tab did not survive, take the toggle by hand.
    const seen = await page.evaluate(() => !!document.querySelector('[data-day-loads-panel]')
      || Array.from(document.querySelectorAll('input'))
        .some((i) => /^Search .*loads/i.test(i.getAttribute('placeholder') || '')));
    if (!seen) {
      await page.getByRole('button', { name: /^Loads/ }).first().click().catch(() => {});
      await page.waitForTimeout(700);
    }
  }
  const text = await panelText(page);
  if (text == null) bad(`${label}: the Loads panel never rendered (no search field found)`);
  else await check(text, page);
  if (errors.length) bad(`${label}: page errors — ${errors.join(' | ')}`);
  if (!mobile && process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false }).catch(() => {});
  await ctx.close();
}

const FULL = [...BUILT, ...EMPTIES, OFF_BOARD];

for (const mobile of [false, true]) {
  const view = mobile ? 'phone 390px' : 'desktop 1600px';

  await run(`A full board — ${view}`, { mobile, roster: FULL }, (text) => {
    for (const e of EMPTIES) {
      if (text.includes(e.name)) ok(`${e.name} — the empty trailer is on the Loads tab`);
      else bad(`${e.name} is missing from the Loads tab (${view})`);
    }
    for (const b of BUILT) {
      if (text.includes(b.name)) bad(`${b.name} is repeated on the Loads tab — that IS the bug (${view})`);
      else ok(`${b.name} stays in Routes and is not repeated here`);
    }
    if (/Has orders, not on the board \(1\)/i.test(text)) ok('the load whose stops never arrived has its own section, not a hiding place');
    else bad(`no "Has orders, not on the board (1)" section (${view})`);
    if (text.includes('TRAILER 9')) ok('…and TRAILER 9 is listed in it');
    else bad(`TRAILER 9 vanished from both tabs (${view})`);
    if (/3 empty/.test(text) && /2 built in Routes/.test(text) && /1 not on the board/.test(text)) ok('the header counts this panel’s own rows: 3 empty · 2 built in Routes · 1 not on the board');
    else bad(`header line wrong (${view}): ${JSON.stringify((text.split('\n').find((l) => /empty/.test(l)) || '').slice(0, 120))}`);
  });

  await run(`A day whose roster was never pulled — ${view}`, { mobile, roster: [] }, (text) => {
    // ABSENT IS NOT ZERO. Sep 8 sat in exactly this state and the tab said the other thing.
    if (/roster hasn’t been pulled yet|roster hasn't been pulled yet/i.test(text)) ok('it says the roster was never pulled, and points at ↻');
    else bad(`an unpulled day does not say so (${view}): ${JSON.stringify(text.slice(0, 200))}`);
    if (/Nothing empty left to fill/i.test(text)) bad(`an unpulled day claims the day is fully built (${view})`);
    else ok('…and does not claim the day is fully built');
  });

  await run(`A day with no empty loads left — ${view}`, { mobile, roster: BUILT }, (text) => {
    if (/Nothing empty left to fill/i.test(text)) ok('it says every load is already built and sends the reader to Routes');
    else bad(`a fully-built day does not say so (${view}): ${JSON.stringify(text.slice(0, 200))}`);
    if (/roster hasn’t been pulled yet|roster hasn't been pulled yet/i.test(text)) bad(`a fully-built day claims the roster is missing (${view})`);
    else ok('…and does not claim the roster is missing');
  });
}

await browser.close();
server.close();
if (fails.length) { console.error(`\n\x1b[31m${fails.length} problem(s) with the Loads tab\x1b[0m`); process.exit(1); }
console.log('\n\x1b[32m✓ the Loads tab shows the empty loads, on both views\x1b[0m');
